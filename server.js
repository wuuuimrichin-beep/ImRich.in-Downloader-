import express from 'express';
import cors from 'cors';
import path from 'path';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const IG_APP_ID = '936619743392459';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

function igHeaders(extra = {}) {
  const h = {
    'User-Agent': UA,
    'x-ig-app-id': IG_APP_ID,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: 'https://www.instagram.com/',
    ...extra,
  };
  if (process.env.IG_COOKIE) h.Cookie = process.env.IG_COOKIE;
  return h;
}

async function igJson(url) {
  const r = await fetch(url, { headers: igHeaders() });
  const text = await r.text();
  if (!r.ok) throw new Error(`Instagram ${r.status}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Instagram ne invalid JSON diya');
  }
}

const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return v;
}

function shortcodeToId(shortcode) {
  let id = 0n;
  for (const ch of shortcode) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    id = id * 64n + BigInt(v);
  }
  return id.toString();
}

const pickBiggest = (arr = []) =>
  [...arr]
    .filter((x) => x && x.url)
    .sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0))[0] || null;

function clean(u) {
  return u ? u.replace(/\\u0026/g, '&').replace(/\\/g, '') : u;
}

function normalizeItem(item) {
  const isVideo = item.media_type === 2 || !!item.video_versions;
  const vid = pickBiggest(item.video_versions);
  const img = pickBiggest(item.image_versions2?.candidates);

  const node = {
    id: String(item.pk ?? item.id ?? ''),
    isVideo,
    url: isVideo ? clean(vid?.url) : clean(img?.url),
    thumb: clean(img?.url || vid?.url),
    width: (isVideo ? vid?.width : img?.width) ?? null,
    height: (isVideo ? vid?.height : img?.height) ?? null,
    username: item.user?.username || item.owner?.username || null,
    caption: item.caption?.text || null,
    takenAt: item.taken_at || null,
    children: [],
  };

  if (Array.isArray(item.carousel_media)) {
    node.children = item.carousel_media.map(normalizeItem);
  }
  return node;
}

function normalizeGraphql(node) {
  const isVideo = node.is_video || !!node.video_url;
  const out = {
    id: node.id || node.shortcode || '',
    isVideo,
    url: clean(isVideo ? node.video_url : node.display_url),
    thumb: clean(node.display_url),
    width: node.dimensions?.width ?? null,
    height: node.dimensions?.height ?? null,
    username: node.owner?.username || null,
    caption: node.edge_media_to_caption?.edges?.[0]?.node?.text || null,
    takenAt: node.taken_at_timestamp || null,
    children: [],
  };
  const kids = node.edge_sidecar_to_children?.edges || [];
  if (kids.length) out.children = kids.map((e) => normalizeGraphql(e.node));
  return out;
}

function parseInstagramUrl(input) {
  let raw = String(input || '').trim();
  if (!raw) return null;
  if (!/^https?:\\/\\//i.test(raw)) raw = 'https://' + raw;

  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!/(^|\\.)instagram\\.com$/i.test(u.hostname)) return null;

  const p = u.pathname.split('/').filter(Boolean);
  const s = (i) => p[i];

  if (s(0) === 'share' && s(1)) return { kind: 'share', url: u.toString() };

  if (['p', 'reel', 'reels', 'tv'].includes(s(0)) && s(1))
    return { kind: 'post', shortcode: s(1) };

  if (s(0) === 'stories') {
    if (s(1) === 'highlights' && s(2)) return { kind: 'highlight', id: s(2) };
    if (s(1)) return { kind: 'story', username: s(1), storyId: s(2) || null };
  }

  if (s(1) && ['p', 'reel', 'reels', 'tv'].includes(s(1)) && s(2))
    return { kind: 'post', shortcode: s(2) };

  return null;
}

async function expandShare(url) {
  const r = await fetch(url, { headers: igHeaders(), redirect: 'follow' });
  return r.url;
}

async function resolveViaEmbed(shortcode) {
  const r = await fetch(
    `https://www.instagram.com/p/${shortcode}/embed/captioned/`,
    { headers: igHeaders() }
  );
  if (!r.ok) throw new Error(`embed ${r.status}`);
  const html = (await r.text()).replace(/\\\\/g, '');

  const video = html.match(/"video_url":"([^"]+)"/)?.[1];
  const image = html.match(/"display_url":"([^"]+)"/)?.[1];
  const user = html.match(/"username":"([^"]+)"/)?.[1];

  if (!video && !image) throw new Error('embed parse fail');
  return {
    id: shortcode,
    isVideo: !!video,
    url: clean(video || image),
    thumb: clean(image || video),
    width: null,
    height: null,
    username: user || null,
    caption: null,
    takenAt: null,
    children: [],
  };
}

async function resolvePost(shortcode) {
  const errors = [];
  const id = shortcodeToId(shortcode);

  if (id) {
    try {
      const j = await igJson(`https://www.instagram.com/api/v1/media/${id}/info/`);
      const item = j.items?.[0];
      if (item) return [normalizeItem(item)];
    } catch (e) {
      errors.push(e.message);
    }
  }

  try {
    const j = await igJson(
      `https://www.instagram.com/p/${shortcode}/?__a=1&__d=dis`
    );
    if (j.graphql?.shortcode_media)
      return [normalizeGraphql(j.graphql.shortcode_media)];
    if (j.items?.[0]) return [normalizeItem(j.items[0])];
  } catch (e) {
    errors.push(e.message);
  }

  try {
    return [await resolveViaEmbed(shortcode)];
  } catch (e) {
    errors.push(e.message);
  }

  throw new Error(errors.join(' | ') || 'Media fetch nahi hua');
}

async function resolveReels(reelId, storyId) {
  const j = await igJson(
    `https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(
      reelId
    )}`
  );

  let items = [];
  if (j.reels) items = Object.values(j.reels).flatMap((r) => r.items || []);
  else if (j.reels_media) items = j.reels_media.flatMap((r) => r.items || []);

  if (storyId) items = items.filter((i) => String(i.pk) === String(storyId));
  if (!items.length) throw new Error('Koi story nahi mili (expire ho gayi?)');

  return items.map(normalizeItem);
}

async function resolveStory(username, storyId) {
  const prof = await igJson(
    `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(
      username
    )}`
  );
  const userId = prof?.data?.user?.id;
  if (!userId) throw new Error('Username nahi mila');
  return resolveReels(userId, storyId);
}

const resolveHighlight = (id) => resolveReels(`highlight:${id}`, null);

app.post('/api/info', async (req, res) => {
  try {
    let parsed = parseInstagramUrl(req.body?.url);
    if (!parsed)
      return res.status(400).json({
        error: 'Valid Instagram link daalein (Reel / Post / Story / Highlight).',
      });

    if (parsed.kind === 'share') {
      const finalUrl = await expandShare(parsed.url);
      parsed = parseInstagramUrl(finalUrl);
      if (!parsed || parsed.kind === 'share')
        return res.status(400).json({ error: 'Share link resolve nahi hua.' });
    }

    const key = JSON.stringify(parsed);
    const media = await cached(key, 5 * 60 * 1000, async () => {
      switch (parsed.kind) {
        case 'post':
          return resolvePost(parsed.shortcode);
        case 'story':
          return resolveStory(parsed.username, parsed.storyId);
        case 'highlight':
          return resolveHighlight(parsed.id);
        default:
          throw new Error('Unsupported link');
      }
    });

    res.json({ type: parsed.kind, count: media.length, media });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Kuch galat ho gaya' });
  }
});

app.get('/api/download', async (req, res) => {
  try {
    const { url, filename } = req.query;
    if (!url) return res.status(400).send('url required');

    const r = await fetch(String(url), {
      headers: igHeaders({ Referer: 'https://www.instagram.com/' }),
    });
    if (!r.ok || !r.body) return res.status(502).send('Upstream fail');

    const safe = String(filename || 'instagram').replace(/[^\\w.\\-]/g, '_');
    res.setHeader(
      'Content-Type',
      r.headers.get('content-type') || 'application/octet-stream'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${safe}"`);
    const len = r.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);

    Readable.fromWeb(r.body).pipe(res);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`\\n  InstaSave running -> http://localhost:${PORT}\\n`);
});
