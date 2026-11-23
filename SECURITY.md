# Security

## Reporting a problem

Please report security issues privately, not in a public issue: use GitHub's
**Security → Report a vulnerability** on this repository. Include what you did, what happened,
and the page or endpoint involved. You'll get a reply within a few days.

## How Livepage is protected

- **HTML blocks** run in a sandboxed iframe (`sandbox="allow-scripts"`, no `allow-same-origin`)
  served from a separate site (`livepage-sandbox.onrender.com`). Block code gets an opaque
  origin: no cookies, no storage, no access to the page or the app. The sandbox's CSP blocks
  fetch, XHR and WebSockets. Messages from a block are only accepted from that block's own iframe,
  and block actions are validated and rate-limited before they reach agents.
- **The app** sends a strict CSP (`script-src 'self'`, frames only from the sandbox), so injected
  markup cannot run scripts.
- **Accounts**: scrypt password hashes, random 256-bit session cookies (HttpOnly, SameSite=Lax,
  Secure in production) stored only as hashes. Google sign-in goes through Neon Auth; its JWT is
  verified against Neon's JWKS and issuer before a Livepage session starts.
- **Cross-site requests**: every write and every live-sync WebSocket must come from the app's own
  origin (or from a non-browser client with no Origin, such as an agent with a token).
- **Permissions** (owner, editor, commenter, viewer) are checked on the server for every HTTP call
  and when a live connection opens. Viewers and commenters connect read-only, so edits they send
  are dropped. Version history is for editors and owners only.
- **Agent tokens** (`lp_...`) are stored hashed, can't create more tokens, and act with exactly
  their person's access. Webhooks are HMAC-SHA256 signed and can't target private addresses.
- **AI keys** are encrypted with AES-256-GCM (key from `AI_KEY_SECRET`, bound to the user id),
  never returned to the browser (only a hint such as `sk-…a1b2`), never sent to agents or blocks,
  and only sent to the provider endpoint they were saved for.
- **Import** never touches the server's disk: files become pages and folders in the database, so
  path tricks like `../../` can't escape. Links are limited to http(s), mailto and in-site paths.

## Review of 2026-11-23

A full review before sharing Livepage more widely. Severity is for the hosted app at
livepage.onrender.com unless it says self-hosted.

### Fixed

| Severity | Finding | Fix |
| --- | --- | --- |
| High (self-hosted) | The shared development agent token (`dev-agent-token`, opens **every** page) worked on any server not started with `NODE_ENV=production`, for example `pnpm start` on a VPS. The Docker image and Render were not affected. | It now only works when the server is also not on a public address (`PUBLIC_URL`/Render unset or localhost). The server warns at start in development mode. |
| Medium | Someone with edit access could plant HTML in a **published** page through a crafted tab id (footnote anchors weren't escaped), for example a redirect to a phishing site on the app's own address. | Tab ids are escaped. Test added. |
| Medium | Removing someone from a page, or deleting an agent token, didn't disconnect live sessions that were already open, so they could keep reading and editing until they reloaded. | The server now closes those connections at once; the next connection is checked again. |
| Medium | Password guessing: the login limit was per IP, and the IP came from the first `X-Forwarded-For` entry, which a client can set to anything. | Added a per-account limit (10 wrong passwords per 15 minutes) on top of the IP limit, and the limiter can no longer grow without bound. |
| Medium | A custom "OpenAI-compatible" assistant endpoint could redirect the server to an internal address and the error message echoed the reply (SSRF). | Assistant requests refuse redirects. |
| Low | The live-sync WebSocket didn't check the Origin header, so a sibling subdomain of a self-hosted install could open pages with a visitor's cookie. | Cross-site WebSocket connections are rejected. Test added. |
| Low | Links like `//other.site` and `/\other.site` passed the link filter in imported Markdown and published pages. | Rejected. Test added. |
| Low | Anyone with access to a page, including a view-only link, could see every member's email address. | Only the owner sees emails; others see names and roles. |
| Low | API responses had no `X-Content-Type-Options: nosniff`. | Added. |
| High (dependency) | `zod` 3.x (MCP tool schemas) has a memory-exhaustion advisory (GHSA-mrhx-c7xc-m3w5). | Upgraded to zod 4.6.6. `pnpm audit` is clean. |

Tests: `pnpm --filter @livepage/server test`.

### Checked, no change needed

- Secrets: nothing in the repo or its git history (only the placeholder URLs in `.env.example`
  and `docker-compose.yml`). `.env` and `.env.local` are git-ignored.
- SQL: every query is parameterized.
- Share links: 144-bit random tokens, owner-only to create or revoke, can't grant owner.
- Hosted `/mcp`: bearer token only (no cookies), so its open CORS is safe; each session is tied
  to the token that opened it.
- Export and PDF: export is the person's own pages as Markdown; PDF is the browser's print dialog.
- Static files: path traversal is blocked.

### Known limits (accepted for now)

- **Blocks can load images and scripts from the internet** (CDNs for libraries, any https image).
  A block can't read the page, cookies or keys, but it can tell its author's server that someone
  viewed it (like a tracking pixel in an email).
- **Blocks can send actions without a click.** A block written by one editor runs in everyone's
  browser and can send actions to agents under the viewer's name. Agents should treat block
  actions, page text and comments as untrusted input (prompt injection), and the built-in
  assistant is limited to the page it was asked about and the asker's own access.
- **Caret names are self-reported.** A collaborator could show a fake name next to their caret.
  Version history and comments use the server-verified identity.
- **Agent tokens cover the whole account**, not one page. Give an agent its own token and delete
  it when you're done.
- **Revoking a share link** stops new people from joining, but people who already joined keep
  access until you remove them in the Share dialog.
- No general API rate limit beyond logins and sign-ups; a signed-in person could do heavy imports.
- The sign-up form says when an email already has an account.
- Sessions last 30 days and there's no "sign out everywhere" yet. No email verification, password reset or two-factor sign-in yet (Google sign-in covers most of this).

## What the person running the server must do

On Render (livepage.onrender.com):

1. **Set `AI_KEY_SECRET`** on the `livepage` service (a long random string, `openssl rand -base64 32`).
   Keep it: changing it makes saved AI keys unreadable.
2. **Decide who can sign up.** Anyone can create an account today. Set `SIGNUP_OPEN=0` to allow only
   existing accounts (people can still join pages through share links if they already have accounts).
3. **Turn on GitHub's private vulnerability reporting and Dependabot alerts** in the repository
   settings (Settings → Code security).
4. Use your own Google OAuth keys in Neon Auth (the shared development keys are for testing).

Self-hosting anywhere else: run with `NODE_ENV=production` (the Docker image does), serve over
HTTPS, put the sandbox on a **different site** from the app (a different registrable domain, not
just a subdomain), and set `AI_KEY_SECRET`.
