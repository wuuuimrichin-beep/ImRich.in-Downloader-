# InstaSave repaired project

## Deploy on Railway
1. Upload these files to the root of your GitHub repository, keeping `public/index.html` in the `public` folder.
2. Railway should use `npm start` as the start command.
3. Generate a public domain in Railway Networking.
4. Test `https://YOUR-DOMAIN/api/health`; expected response: `{"ok":true}`.

## Notes
- This project uses Node.js 18+ and the `fetch` API.
- Instagram endpoints are unofficial and can change or reject requests. A successful deployment does not guarantee every public post/reel/story can be fetched.
- Only download media you own or have permission to save.
