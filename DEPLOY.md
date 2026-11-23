# Put Livepage on the web

About 15 minutes. You need a GitHub account (you have one), and you'll create two free accounts: **Neon** (the database) and **Render** (runs the app).

Render's free plan sleeps after 15 minutes without visitors, so the first visit after a break takes about a minute to wake up. Upgrade the `livepage` service to a paid plan when you want it always on.

## 1. Database (Neon)

1. Sign up at [neon.tech](https://neon.tech) and create a project (any name, pick the region closest to you).
2. On the project dashboard click **Connect** and copy the connection string. It looks like `postgresql://user:password@ep-....neon.tech/neondb?sslmode=require`. Keep it for step 2.

## 2. App (Render)

1. Sign up at [render.com](https://render.com) with your GitHub account.
2. Click **New > Blueprint**, pick the `livepage` repository, and confirm. Render reads `render.yaml` and creates two services: `livepage` (the app) and `livepage-sandbox` (where HTML blocks run, on a separate domain for safety).
3. When Render asks for `DATABASE_URL`, paste the Neon connection string (the pooled one, with `-pooler` in the host). For Google sign-in, also paste `NEON_AUTH_BASE_URL` (from `.env.local` after `neon deploy`, or Neon Console > Auth); leave it empty to skip.
4. Click **Apply** and wait for both services to show **Live** (the first build takes a few minutes).
5. Open the `livepage` service and click its URL (`https://livepage-xxxx.onrender.com`). Sign up. That's your app.

Every push to `main` redeploys automatically.

## 3. Optional

- **Google sign-in (Neon Auth):** add your app's address as a trusted domain, or Neon Auth refuses to redirect back: `neon neon-auth domain add https://livepage-xxxx.onrender.com` (or Neon Console > Auth > Domains). Neon's shared Google credentials are for testing; for real users add your own Google OAuth app in Neon Console > Auth.

- **Your own domain:** in the `livepage` service, **Settings > Custom Domains**, add e.g. `write.yourdomain.com` and create the DNS record Render shows. Give the sandbox a domain that is **not** under the same main domain (or keep its `onrender.com` address), so HTML blocks can never reach the app's cookies. If you change domains, set `SANDBOX_URL` on the app and `SANDBOX_FRAME_ANCESTORS` on the sandbox to the new `https://` addresses.
- **Close sign-ups** once your people have accounts: add `SIGNUP_OPEN=0` to the `livepage` service's environment.
- **Built-in assistant (✦ Ask AI):** needs `AI_KEY_SECRET` on the `livepage` service. New Blueprints generate it; on an existing service add it under **Environment** with a long random value (`openssl rand -base64 32`). Then each person adds their own API key on their home page.
- **Connect an agent:** in the app, **Agents > + Agent token**. It shows the exact command for Claude Code or any MCP client.

## Speed

The app is built to load fast anywhere: the first screen is a small download, the editor loads alongside it on page links, files are compressed and cached for a year, and pages you have opened show from a copy saved in your browser while the live connection catches up. `pnpm check:perf` measures it on a throttled connection.

Two things about free hosting are outside the app's control:

- **Render's free plan sleeps.** After 15 minutes without traffic the service stops, and the next visit waits about a minute while it starts again. Nothing in the code can shorten that. Your options:
  - **Paid instance** (Starter, about $7 a month): never sleeps. Change `plan: free` to `plan: starter` for the `livepage` service in `render.yaml`, or pick it in the dashboard. The sandbox can stay free: it only serves a tiny static runner page, though a sleeping sandbox delays HTML blocks on the first visit.
  - **Keep-alive ping**: a free uptime monitor (UptimeRobot, Better Stack, cron-job.org) that requests `https://<your app>/api/health` every 10 minutes keeps it awake. Free, but it uses the plan's monthly free hours faster (750 hours covers one always-on service, not two), and Render may change how it treats this.
  - **Another host** that doesn't sleep (Fly.io, Railway, a small VPS): see "Other hosts" below.
- **Neon's free plan also pauses** the database after 5 minutes idle; waking it adds about half a second to the first request. A keep-alive ping does not prevent this (`/api/health` doesn't touch the database). Neon's paid plan lets you turn auto-suspend off.

Put the app and the database in the same region (for example Render Oregon and Neon US West). Every request crosses that link, so distance there is paid on every click.

## Other hosts

The app is one Docker image (`Dockerfile`) run in two roles. Anywhere that runs Docker works (Railway, Fly.io, a VPS with `docker compose`):

| Service | Command | Env |
|---|---|---|
| app | `pnpm --filter @livepage/server start` | `DATABASE_URL`, `SANDBOX_URL=https://<sandbox domain>`, `PORT` |
| sandbox | `pnpm --filter @livepage/sandbox start` | `SANDBOX_FRAME_ANCESTORS=https://<app domain>`, `PORT` |

Put both behind HTTPS. The app needs WebSockets (path `/collab`).
