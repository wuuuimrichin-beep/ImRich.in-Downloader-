import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const IG_APP_ID = "936619743392459";
const IG_POST_ROOT_QUERY_DOC_ID = "27852811784380813";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const app = express();

app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));

function igHeaders(extra = {}) {
  const headers = {
    "User-Agent": UA,
    "x-ig-app-id": IG_APP_ID,
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: "https://www.instagram.com/",
    ...extra,
  };

  if (process.env.IG_COOKIE && !headers.Cookie && !headers.cookie) {
    headers.Cookie = process.env.IG_COOKIE;
  }

  return headers;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function igJson(url) {
  const response = await fetchWithTimeout(url, {
    headers: igHeaders(),
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(`Instagram returned HTTP ${response.status}`);
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new Error(
      "Instagram returned HTML instead of JSON. Its legacy endpoint may have changed."
    );
  }
}

// Instagram web session
async function getInstagramWebSession() {
  const response = await fetchWithTimeout(
    "https://www.instagram.com/",
    {
      headers: igHeaders({
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      }),
      redirect: "follow",
    },
    20000
  );

  const html = await response.text();

  if (!response.ok) {
    throw new Error(
      `Instagram homepage returned HTTP ${response.status}`
    );
  }

  let setCookies = [];

  if (typeof response.headers.getSetCookie === "function") {
    setCookies = response.headers.getSetCookie();
  } else {
    const combined = response.headers.get("set-cookie");
    if (combined) setCookies = [combined];
  }

  const cookieMap = new Map();

  for (const cookie of setCookies) {
    const firstPart = cookie.split(";", 1)[0];
    const equalsIndex = firstPart.indexOf("=");

    if (equalsIndex > 0) {
      cookieMap.set(
        firstPart.slice(0, equalsIndex).trim(),
        firstPart.slice(equalsIndex + 1).trim()
      );
    }
  }

  if (process.env.IG_COOKIE) {
    for (const part of process.env.IG_COOKIE.split(";")) {
      const trimmed = part.trim();
      const equalsIndex = trimmed.indexOf("=");

      if (equalsIndex > 0) {
        const name = trimmed.slice(0, equalsIndex).trim();
        const value = trimmed.slice(equalsIndex + 1).trim();

        if (!cookieMap.has(name)) {
          cookieMap.set(name, value);
        }
      }
    }
  }

  let fbDtsg = null;

  for (const pattern of [
    /"DTSGInitialData",\[\],\{"token":"([^"]+)"/,
    /"dtsg":\s*\{\s*"token":"([^"]+)"/,
  ]) {
    const match = html.match(pattern);

    if (match) {
      fbDtsg = match[1];
      break;
    }
  }

  if (!fbDtsg) {
    throw new Error(
      "Instagram web token nahi mila. Instagram request restrict kar raha ho sakta hai."
    );
  }

  return {
    fbDtsg,
    cookies: [...cookieMap.entries()]
      .map(([key, value]) => `${key}=${value}`)
      .join("; "),
    csrfToken: cookieMap.get("csrftoken") || "",
  };
}

// Current Instagram web GraphQL attempt
async function resolveViaGraphQL(shortcode) {
  const session = await getInstagramWebSession();

  const form = new URLSearchParams({
    fb_dtsg: session.fbDtsg,
    fb_api_caller_class: "RelayModern",
    fb_api_req_friendly_name: "PolarisPostRootQuery",
    doc_id: IG_POST_ROOT_QUERY_DOC_ID,
    variables: JSON.stringify({
      shortcode,
      __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: false,
      __relay_internal__pv__PolarisMultiCaptionCarouselEnabledrelayprovider: false,
    }),
    server_timestamps: "true",
  });

  const response = await fetchWithTimeout(
    "https://www.instagram.com/graphql/query",
    {
      method: "POST",
      headers: igHeaders({
        "Content-Type": "application/x-www-form-urlencoded",
        "X-FB-Friendly-Name": "PolarisPostRootQuery",
        "X-Requested-With": "XMLHttpRequest",
        ...(session.csrfToken
          ? { "X-CSRFToken": session.csrfToken }
          : {}),
        ...(session.cookies
          ? { Cookie: session.cookies }
          : {}),
        Origin: "https://www.instagram.com",
      }),
      body: form.toString(),
    },
    20000
  );

  const responseText = await response.text();

  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(
      `Instagram GraphQL returned HTML instead of JSON (HTTP ${response.status}). Endpoint blocked or changed ho sakta hai.`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Instagram GraphQL returned HTTP ${response.status}`
    );
  }

  if (Array.isArray(data.errors) && data.errors.length) {
    throw new Error(
      data.errors[0]?.message || "Instagram GraphQL query failed."
    );
  }

  const items =
    data?.data?.xdt_api__v1__media__shortcode__web_info?.items;

  if (!Array.isArray(items) || !items[0]) {
    throw new Error(
      "Instagram ne media JSON nahi diya. Post private, unavailable, ya temporarily restricted ho sakta hai."
    );
  }

  return [normalizeItem(items[0])];
}

const cache = new Map();

async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);

  if (hit && Date.now() - hit.time < ttlMs) {
    return hit.value;
  }

  const value = await fn();

  cache.set(key, {
    time: Date.now(),
    value,
  });

  if (cache.size > 300) {
    cache.delete(cache.keys().next().value);
  }

  return value;
}

function shortcodeToId(shortcode) {
  let id = 0n;

  for (const char of shortcode) {
    const value = ALPHABET.indexOf(char);

    if (value < 0) return null;

    id = id * 64n + BigInt(value);
  }

  return id.toString();
}

function clean(value) {
  return typeof value === "string"
    ? value.replace(/\\u0026/g, "&").replace(/\\/g, "")
    : value;
}

function pickBiggest(items = []) {
  return (
    [...items]
      .filter((item) => item?.url)
      .sort(
        (a, b) =>
          (b.width || 0) * (b.height || 0) -
          (a.width || 0) * (a.height || 0)
      )[0] || null
  );
}

function normalizeItem(item) {
  const isVideo =
    item.media_type === 2 ||
    Boolean(item.video_versions?.length);

  const video = pickBiggest(item.video_versions);
  const image = pickBiggest(item.image_versions2?.candidates);

  const result = {
    id: String(item.pk ?? item.id ?? ""),
    isVideo,
    url: clean(isVideo ? video?.url : image?.url),
    thumb: clean(image?.url || video?.url),
    width: (isVideo ? video?.width : image?.width) ?? null,
    height: (isVideo ? video?.height : image?.height) ?? null,
    username: item.user?.username || item.owner?.username || null,
    caption: item.caption?.text || null,
    takenAt: item.taken_at || null,
    children: [],
  };

  if (Array.isArray(item.carousel_media)) {
    result.children = item.carousel_media.map(normalizeItem);
  }

  return result;
}

function normalizeGraphql(node) {
  const isVideo = Boolean(node.is_video || node.video_url);

  const result = {
    id: node.id || node.shortcode || "",
    isVideo,
    url: clean(isVideo ? node.video_url : node.display_url),
    thumb: clean(node.display_url),
    width: node.dimensions?.width ?? null,
    height: node.dimensions?.height ?? null,
    username: node.owner?.username || null,
    caption:
      node.edge_media_to_caption?.edges?.[0]?.node?.text || null,
    takenAt: node.taken_at_timestamp || null,
    children: [],
  };

  const children = node.edge_sidecar_to_children?.edges || [];

  if (children.length) {
    result.children = children.map((edge) =>
      normalizeGraphql(edge.node)
    );
  }

  return result;
}

function parseInstagramUrl(input) {
  let raw = String(input || "").trim();

  if (!raw) return null;

  if (!/^https?:\/\//i.test(raw)) {
    raw = `https://${raw}`;
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(raw);
  } catch {
    return null;
  }

  if (!/(^|\.)instagram\.com$/i.test(parsedUrl.hostname)) {
    return null;
  }

  const parts = parsedUrl.pathname.split("/").filter(Boolean);
  const part = (index) => parts[index];

  if (part(0) === "share" && part(1)) {
    return {
      kind: "share",
      url: parsedUrl.toString(),
    };
  }

  if (
    ["p", "reel", "reels", "tv"].includes(part(0)) &&
    part(1)
  ) {
    return {
      kind: "post",
      shortcode: part(1),
    };
  }

  if (part(0) === "stories") {
    if (part(1) === "highlights" && part(2)) {
      return {
        kind: "highlight",
        id: part(2),
      };
    }

    if (part(1)) {
      return {
        kind: "story",
        username: part(1),
        storyId: part(2) || null,
      };
    }
  }

  if (
    part(1) &&
    ["p", "reel", "reels", "tv"].includes(part(1)) &&
    part(2)
  ) {
    return {
      kind: "post",
      shortcode: part(2),
    };
  }

  return null;
}

async function expandShare(url) {
  const response = await fetchWithTimeout(
    url,
    {
      headers: igHeaders(),
      redirect: "follow",
    },
    15000
  );

  return response.url;
}

async function resolveViaEmbed(shortcode) {
  const response = await fetchWithTimeout(
    `https://www.instagram.com/p/${encodeURIComponent(shortcode)}/embed/captioned/`,
    {
      headers: igHeaders(),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Instagram embed returned HTTP ${response.status}`
    );
  }

  const html = (await response.text()).replace(/\\/g, "");

  const video = html.match(/"video_url":"([^"]+)"/)?.[1];
  const image = html.match(/"display_url":"([^"]+)"/)?.[1];
  const username = html.match(/"username":"([^"]+)"/)?.[1];

  if (!video && !image) {
    throw new Error("Embed se media link nahi mila");
  }

  return {
    id: shortcode,
    isVideo: Boolean(video),
    url: clean(video || image),
    thumb: clean(image || video),
    width: null,
    height: null,
    username: username || null,
    caption: null,
    takenAt: null,
    children: [],
  };
}

async function resolvePost(shortcode) {
  const errors = [];

  try {
    return await resolveViaGraphQL(shortcode);
  } catch (error) {
    errors.push(`GraphQL: ${error.message}`);
  }

  const id = shortcodeToId(shortcode);

  if (id) {
    try {
      const data = await igJson(
        `https://www.instagram.com/api/v1/media/${encodeURIComponent(id)}/info/`
      );

      if (data.items?.[0]) {
        return [normalizeItem(data.items[0])];
      }
    } catch (error) {
      errors.push(`Legacy media endpoint: ${error.message}`);
    }
  }

  try {
    const data = await igJson(
      `https://www.instagram.com/p/${encodeURIComponent(shortcode)}/?__a=1&__d=dis`
    );

    if (data.graphql?.shortcode_media) {
      return [normalizeGraphql(data.graphql.shortcode_media)];
    }

    if (data.items?.[0]) {
      return [normalizeItem(data.items[0])];
    }
  } catch (error) {
    errors.push(`Legacy page endpoint: ${error.message}`);
  }

  try {
    return [await resolveViaEmbed(shortcode)];
  } catch (error) {
    errors.push(`Embed: ${error.message}`);
  }

  throw new Error(
    errors.join(" | ") || "Instagram media fetch failed."
  );
}

async function resolveReels(userId, storyId) {
  const data = await igJson(
    `https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(userId)}`
  );

  let items = [];

  if (data.reels) {
    items = Object.values(data.reels).flatMap(
      (reel) => reel.items || []
    );
  } else if (data.reels_media) {
    items = data.reels_media.flatMap(
      (reel) => reel.items || []
    );
  }

  if (storyId) {
    items = items.filter(
      (item) => String(item.pk) === String(storyId)
    );
  }

  if (!items.length) {
    throw new Error(
      "Story nahi mili; expire ya private ho sakti hai."
    );
  }

  return items.map(normalizeItem);
}

async function resolveStory(username, storyId) {
  const data = await igJson(
    `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`
  );

  const userId = data?.data?.user?.id;

  if (!userId) {
    throw new Error(
      "Username nahi mila ya profile accessible nahi hai."
    );
  }

  return resolveReels(userId, storyId);
}

async function resolveHighlight(id) {
  return resolveReels(`highlight:${id}`, null);
}

app.post("/api/info", async (req, res) => {
  try {
    let parsed = parseInstagramUrl(req.body?.url);

    if (!parsed) {
      return res.status(400).json({
        error:
          "Valid Instagram link daalein (Reel / Post / Story / Highlight).",
      });
    }

    if (parsed.kind === "share") {
      const finalUrl = await expandShare(parsed.url);
      parsed = parseInstagramUrl(finalUrl);

      if (!parsed || parsed.kind === "share") {
        return res.status(400).json({
          error: "Share link resolve nahi hua.",
        });
      }
    }

    const key = JSON.stringify(parsed);

    const media = await cached(
      key,
      5 * 60 * 1000,
      async () => {
        switch (parsed.kind) {
          case "post":
            return resolvePost(parsed.shortcode);

          case "story":
            return resolveStory(
              parsed.username,
              parsed.storyId
            );

          case "highlight":
            return resolveHighlight(parsed.id);

          default:
            throw new Error(
              "Is link type ko support nahi kiya gaya."
            );
        }
      }
    );

    return res.json({
      type: parsed.kind,
      count: media.length,
      media,
    });
  } catch (error) {
    console.error("Info endpoint error:", error);

    return res.status(502).json({
      error:
        error.message ||
        "Instagram se media fetch nahi ho paya.",
    });
  }
});

function isAllowedMediaUrl(value) {
  try {
    const url = new URL(value);

    if (url.protocol !== "https:") return false;

    const host = url.hostname.toLowerCase();

    return (
      host === "instagram.com" ||
      host.endsWith(".instagram.com") ||
      host === "cdninstagram.com" ||
      host.endsWith(".cdninstagram.com") ||
      host === "fbcdn.net" ||
      host.endsWith(".fbcdn.net")
    );
  } catch {
    return false;
  }
}

app.get("/api/download", async (req, res) => {
  try {
    const mediaUrl = String(req.query.url || "");

    if (!mediaUrl) {
      return res.status(400).send("url required");
    }

    if (!isAllowedMediaUrl(mediaUrl)) {
      return res.status(400).send("Unsupported media URL");
    }

    const response = await fetchWithTimeout(
      mediaUrl,
      {
        headers: igHeaders({
          Referer: "https://www.instagram.com/",
        }),
      },
      30000
    );

    if (!response.ok || !response.body) {
      return res
        .status(502)
        .send(
          `Media server returned HTTP ${response.status}`
        );
    }

    const filename = String(
      req.query.filename || "instasave-media"
    )
      .replace(/[^\w.-]/g, "_")
      .slice(0, 100);

    res.setHeader(
      "Content-Type",
      response.headers.get("content-type") ||
        "application/octet-stream"
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename || "instasave-media"}"`
    );

    const length = response.headers.get("content-length");

    if (length) {
      res.setHeader("Content-Length", length);
    }

    await pipeline(response.body, res);
  } catch (error) {
    console.error("Download endpoint error:", error);

    if (!res.headersSent) {
      res
        .status(502)
        .send(
          "Download fail hua. Link expire ho sakta hai; dobara try karein."
        );
    } else {
      res.destroy(error);
    }
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("*", (_req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`InstaSave running on port ${PORT}`);
});
