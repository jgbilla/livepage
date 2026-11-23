# Put Livepage on the web

About 15 minutes. You need a GitHub account (you have one), and you'll create two free accounts: **Neon** (the database) and **Render** (runs the app).

Render's free plan sleeps after 15 minutes without visitors, so the first visit after a break takes about a minute to wake up. Upgrade the `livepage` service to a paid plan when you want it always on.

## 1. Database (Neon)

1. Sign up at [neon.tech](https://neon.tech) and create a project (any name, pick the region closest to you).
2. On the project dashboard click **Connect** and copy the connection string. It looks like `postgresql://user:password@ep-....neon.tech/neondb?sslmode=require`. Keep it for step 2.

## 2. App (Render)

1. Sign up at [render.com](https://render.com) with your GitHub account.
2. Click **New > Blueprint**, pick the `livepage` repository, and confirm. Render reads `render.yaml` and creates two services: `livepage` (the app) and `livepage-sandbox` (where HTML blocks run, on a separate domain for safety).
3. When Render asks for `DATABASE_URL`, paste the Neon connection string.
4. Click **Apply** and wait for both services to show **Live** (the first build takes a few minutes).
5. Open the `livepage` service and click its URL (`https://livepage-xxxx.onrender.com`). Sign up. That's your app.

Every push to `main` redeploys automatically.

## 3. Optional

- **Your own domain:** in the `livepage` service, **Settings > Custom Domains**, add e.g. `write.yourdomain.com` and create the DNS record Render shows. Give the sandbox a domain that is **not** under the same main domain (or keep its `onrender.com` address), so HTML blocks can never reach the app's cookies. If you change domains, set `SANDBOX_URL` on the app and `SANDBOX_FRAME_ANCESTORS` on the sandbox to the new `https://` addresses.
- **Close sign-ups** once your people have accounts: add `SIGNUP_OPEN=0` to the `livepage` service's environment.
- **Connect an agent:** in the app, **Agents > + Agent token**. It shows the exact command for Claude Code or any MCP client.

## Other hosts

The app is one Docker image (`Dockerfile`) run in two roles. Anywhere that runs Docker works (Railway, Fly.io, a VPS with `docker compose`):

| Service | Command | Env |
|---|---|---|
| app | `pnpm --filter @livepage/server start` | `DATABASE_URL`, `SANDBOX_URL=https://<sandbox domain>`, `PORT` |
| sandbox | `pnpm --filter @livepage/sandbox start` | `SANDBOX_FRAME_ANCESTORS=https://<app domain>`, `PORT` |

Put both behind HTTPS. The app needs WebSockets (path `/collab`).
