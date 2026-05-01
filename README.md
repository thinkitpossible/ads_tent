# ads_tent

AI Ads demo site with two demos:

- `demo1`: pre-roll video ad analysis
- `demo2`: mid-roll ad style demo

## Local run

```bash
npm install
npm start
```

Open `http://localhost:5173/`.

## Deploy to Render

This repo is ready for Render as a Node Web Service.

### Option 1: Blueprint deploy

1. Push this repo to GitHub.
2. In Render, choose **New +** -> **Blueprint**.
3. Select this repository.
4. Render will read [`render.yaml`](./render.yaml) automatically.
5. Add the secret env var `SILICONFLOW_API_KEY`.
6. Deploy.

### Option 2: Manual Web Service

Use these settings:

- Runtime: `Node`
- Build Command: `npm install`
- Start Command: `npm start`

Set these environment variables:

- `SILICONFLOW_API_KEY`: your SiliconFlow API key
- `SILICONFLOW_TEXT_MODEL`: `MiniMaxAI/MiniMax-M2.5`
- `SILICONFLOW_VISION_MODEL`: `Qwen/Qwen3.6-35B-A3B`

## Notes

- The server listens on `process.env.PORT`, so it works on Render directly.
- `demo1` depends on the backend API routes in `server.js`.
- `demo2` is static, but it is also served by the same Node service here.
