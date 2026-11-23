# Livepage spec

> Working name. Livepage is an open-source, self-hostable writing app where people and AI agents work on the same live page. It feels like Notion and Obsidian, and any block can be live HTML/JS, the way Claude Artifacts and ChatGPT Canvas render code.

Status: draft v0.1 (2026-11-23). The starter code in this repo implements Milestone 0.

---

## 1. What we are building

One scrolling page per document. You write in it like Notion. An AI agent sits in the same page with its own named caret: it writes, edits, comments, and drops in **HTML blocks** (animations, diagrams, interactive widgets) that render right in the flow of the text. Other people can join the same page live. Everything runs in the browser, accounts live on your own server, and anyone can self-host it with one command.

### Decisions so far

| # | Question | Decision |
|---|----------|----------|
| 1 | Infinite canvas or page? | **One scrolling page.** Blocks flow top to bottom. |
| 2 | Storage | **Database (Postgres)**, like Notion. Not a folder of markdown files. Markdown import/export keeps the Obsidian door open. |
| 2b | Where the database lives | **Hosted Postgres by default** (Neon, Supabase, RDS...), so pages survive if the server or its machine dies. A bundled local Postgres is opt-in for development or fully offline installs. |
| 3 | How the agent works | **Live, in the page, alongside you**, with presence and a caret. Not a side chat that pastes results. |
| 4 | Which AI | **Any.** Agents connect over MCP or a small HTTP API. No model is built in. |
| 5 | Sharing | Required: share links and per-page permissions. |
| 6 | Collaboration | Multi-user, real-time (CRDT). |
| 7 | Hosting | Anyone can self-host: `docker compose up`. |
| 8 | What goes on a page | **Anything, mixed freely**: your text, tables, mind maps, drawings and designs, and agent custom UI, all as first-class blocks on the same page, editable by people and agents. |
| 9 | Tabs | **Optional tabs per page**, shown at the top. A page with one tab looks like a normal page. Each tab is its own scrolling page. |
| 11 | License | **MIT.** |
| 10 | Agent UI patterns | Borrowed from CopilotKit's OpenIntelligentUI (MIT): the agent picks text vs native component vs custom UI, custom UI streams in a fixed order, and a validated host bridge sends input back to the agent. Patterns only, no code embedded (it is a chat app). |

---

## 2. How AI chat canvases do it today (and what we borrow)

Both Claude Artifacts and ChatGPT Canvas boil down to the same trick:

1. The model writes **plain HTML/CSS/JS** (or React that gets compiled to it in the browser).
2. The app puts that code into an **`<iframe>`** that is sandboxed and served from a **different domain** from the chat app (Claude, for example, renders artifacts from a separate user-content domain). The code can run any JavaScript it likes, but it can't read your cookies, your session or the parent page.
3. The parent and the iframe talk only through **`postMessage`** (send the code in, get size and errors out).
4. A **Content-Security-Policy** limits what the code can load: usually a short list of CDNs, and often no network calls.

So yes, it is "just" HTML and JavaScript. The hard parts are the isolation and making it feel native. Livepage does exactly the same thing, except the iframe is a **block inside a collaborative document** instead of a pane next to a chat, and its code is a shared, co-editable field.

**Can Notion already do this?** No. Notion's `/embed` block only shows an iframe of an external URL. You can't write raw HTML into a page, and an agent using the Notion API can't create one. That gap is the product.

---

## 3. Architecture

```
 Browser (you)          Browser (friend)          Agent (any model)
 React + TipTap         React + TipTap            MCP server / HTTP / WS client
      │  Yjs over WS           │                        │
      └──────────────┬─────────┴────────────────────────┘
                     ▼
           Collab server (Node, Hocuspocus)
           - auth hook, presence, Yjs sync
           - agent HTTP API (/api/...)
           - persistence + block projection
                     │
                     ▼
        Hosted Postgres (Neon, Supabase, RDS...)
   documents (Yjs state)   blocks (queryable projection)   users, pages, shares... (M1+)

 HTML blocks:  <iframe sandbox="allow-scripts" src="https://SANDBOX_ORIGIN/runner.html">
               served by the sandbox service, a different origin, with strict CSP
```

| Piece | Tech | Where |
|-------|------|-------|
| Editor | TipTap 3 (ProseMirror) + React 19 + Vite | `apps/web` |
| Live sync | Yjs CRDT, Hocuspocus server/provider | `apps/server`, `apps/web` |
| Storage | Hosted Postgres via one `DATABASE_URL` (bundled Postgres 17 optional) | `apps/server/src/db.ts` |
| HTML block runtime | Static runner on its own origin, strict CSP | `apps/sandbox` |
| Shared document model | Yjs helpers used by every participant | `packages/schema` |
| Agent connectivity | Live WS client, MCP server, HTTP API | `packages/agent`, `apps/server/src/agent-api.ts` |
| Self-hosting | Docker Compose | `docker-compose.yml` |

**Why Yjs + Hocuspocus:** it is the most mature open-source CRDT stack for ProseMirror, it handles offline/reconnect, and the server is small enough to self-host. An agent is just one more Yjs client, which is what makes "the agent edits live with its own cursor" fall out for free.

---

## 3b. Blocks: everything on one page

A page is a stack of blocks, and **every block type is first-class**: same drag handle, same live merging, same agent access, and any mix on the same page or tab. There is no "AI area" and "human area".

| Block | Kind | Who edits | Where its data lives | Status |
|-------|------|-----------|----------------------|--------|
| Paragraph, heading, list, quote, code | Native text | People and agents, character by character | Tab's block tree | ✅ |
| Table | Native component | People (cells are normal text) and agents (`insert_table`) | Tab's block tree | ✅ |
| Mind map | Native component | People (click a node, Tab for child, Enter for sibling) and agents (`insert_mind_map`, `add_mind_map_node`) | `mindMaps` map, node by node | ✅ |
| Custom UI / HTML block | Sandboxed code | People ("Edit code") and agents (`insert_custom_ui`, `update_html_block`) | `htmlCode` map, one `Y.Text` per block | ✅ |
| Drawing / whiteboard | Native component | People draw, agents add shapes and arrows | `drawings` map: shapes keyed by id (an Excalidraw- or tldraw-style scene, both MIT, both Yjs-friendly) | Planned (M3) |
| Design frame | Native component | Layout of boxes, text and images for mockups and covers; agents can generate or tweak it | `designs` map | Planned (M4) |
| Image, file, embed | Native | People and agents | `assets` table + block attrs | Planned (M1) |
| Database view | Native | See §10 | `databases` / `rows` | Planned (M4) |

**Rule of thumb for native vs custom UI.** Native blocks are editable, searchable, exportable and accessible like text, so they win whenever they fit. Custom UI is for what native blocks can't do: motion, simulations, interactive explainers, one-off visualizations. A drawing someone wants to keep editing by hand should be a drawing block, not an HTML block.

**Adding a new block type** takes three pieces: a TipTap node holding `{ blockId, ...attrs }`, a data structure in the page's Y.Doc keyed by `blockId`, and helpers in `packages/schema` so the server projection and agents understand it. `mindMap` is the reference example.

---

## 3c. Tabs

Tabs are optional, like Google Docs tabs. They show as a bar at the top of the page. With one tab, only a small "+ Add tab" link shows and the page looks normal.

- **Model:** one Y.Doc per page. A `tabs` map holds `{ id, title, order }`. Each tab has its own block tree (`XmlFragment`): `default` for the main tab (so pages made before tabs keep working) and `tab:<id>` for the rest. Block data maps (`htmlCode`, `mindMaps`, `actions`) are page-wide and keyed by block id, so a block can later move between tabs without copying its data.
- **Why one doc, not one doc per tab:** a single sync connection, one permission check, one history, and agents read the whole page in one call. Sub-docs per tab are the fallback if very large pages make loading slow.
- **UI:** click to switch, double-click to rename, × to delete (not the main tab). The active tab is in the URL (`?tab=<id>`) so links can point at a tab. Dots on each tab show who is on it.
- **Agents:** `read_page` returns every tab as a `<tab id title>` section. Every writing tool takes an optional `tab` (id or title), and `add_tab` creates one. The HTTP API takes `?tab=`.
- **Storage:** the `blocks` projection has a `tab` column.

---

## 4. Document model

Each page is one `Y.Doc`:

| Shared type | Name | Holds |
|-------------|------|-------|
| `Map` | `tabs` | `tabId → { id, title, order }`. Empty means one implicit main tab |
| `XmlFragment` | `default`, `tab:<id>` | One block tree per tab: text, tables, `htmlBlock` and `mindMap` nodes, mixed freely |
| `Map<Y.Text>` | `htmlCode` | `blockId → Y.Text` with each HTML block's source |
| `Map<Y.Map>` | `mindMaps` | `blockId → (nodeId → { text, parent, order })` |
| `Map` | `actions` | Host-bridge actions sent from custom UI controls to agents |
| `Map<Y.Map>` | `comments` | Comment threads (M2) |
| `Map` | `meta` | Title, icon, cover (M1) |

An HTML block in the tree stores only `{ blockId, title, status, initialHeight, placeholders }`. Its code lives in `htmlCode` as a `Y.Text`, so two people and an agent can edit the same block's code at the same time, character by character, and the merge is automatic. The rendered iframe follows the code with a 400 ms debounce.

`packages/schema` is the single definition of this model. The editor, the server's projection and every agent use it, so "a page" means the same thing to all of them.

---

## 5. Storage

The Yjs state is the **source of truth** for content (it's what makes real-time merging work). Postgres stores it and also keeps **relational projections** so the server can query pages like Notion does.

### Where the database runs

The server is **stateless**: all content is in Postgres, reached through a single `DATABASE_URL`. The default and documented setup is a **hosted** Postgres, because a database on the same box as the server dies with it. Any provider works: Neon and Supabase have free tiers, and RDS, Cloud SQL or a managed Postgres from any host are fine for production.

- TLS comes from the connection string (`?sslmode=require`).
- The pool is small (`PG_POOL_MAX`, default 5) because hosted plans cap connections. A provider's pooled endpoint (Neon's `-pooler` host, Supabase's pooler) is supported.
- Hosted databases close idle connections and restart for maintenance. The server logs a dropped connection and reconnects on the next save instead of crashing (tested by killing all connections mid-session).
- The server **refuses to start without `DATABASE_URL`**, so nobody ends up keeping pages in memory by accident. `pnpm dev:memory` is the explicit, throwaway exception.
- Because the server holds no state, it can be restarted, redeployed or moved freely. Running several server instances needs the Hocuspocus Redis extension (later).
- Backups: rely on the provider's point-in-time restore, plus `pg_dump` for a portable copy.

The bundled Postgres container is an opt-in Compose profile (`--profile local-db`) for development or installs that must stay on one machine.

### Tables

Implemented now:

```sql
documents (name pk, data bytea, updated_at)          -- Yjs state per page
blocks    (doc_name, id, position, type, text, attrs jsonb)  -- rewritten on every save
```

Built in M1: `users`, `sessions`, `pages`, `page_members`, `share_links`, `api_tokens` (schema in `apps/server/src/db.ts`). Still planned, roughly:

```sql
users        (id, email, name, avatar, password_hash | oauth_subject)
workspaces   (id, name, owner_id)
members      (workspace_id, user_id, role: owner|editor|commenter|viewer)
pages        (id, workspace_id, parent_id, title, icon, doc_name -> documents, created_by, ...)
share_links  (id, page_id, token, role, expires_at)
api_tokens   (id, user_id | workspace_id, name, hash, scopes, last_used_at)  -- for agents
databases    (id, page_id, schema jsonb)                -- Notion-style collections
rows         (database_id, page_id, props jsonb)
assets       (id, workspace_id, key, mime, size)         -- S3/MinIO or local disk
```

**"How do we keep the iframe in a database?"** The HTML block is a row like any other: `type = 'htmlBlock'`, `text = <its code>`. Nothing special is stored. The iframe is created only at render time, by the browser.

---

## 6. HTML blocks

### Security model (do not weaken without a review)

1. **Separate origin.** The runner is served from `SANDBOX_URL` (default `http://localhost:5174`, in production something like `blocks.yourdomain.com` or better a separate registrable domain). Never the app origin.
2. **`sandbox="allow-scripts"` without `allow-same-origin`.** The frame gets an opaque origin: no cookies, no localStorage, no access to `parent.document`. (Verified in the e2e check: `parent.document` and `document.cookie` both throw `SecurityError`.)
3. **Strict CSP on the runner:** scripts only inline or from an allowlist of CDNs (`cdn.jsdelivr.net`, `unpkg.com`, `cdnjs.cloudflare.com`), `connect-src 'none'` (no fetch/XHR/WebSocket), `form-action 'none'`, `frame-ancestors` limited to the app origin. Configurable via env.
4. **postMessage only.** The parent sends `livepage:render` with the code. The frame sends back `livepage:ready`, `livepage:height` and `livepage:error`. The parent accepts messages only when `event.source` is that exact iframe.
5. **Fresh document per version.** Every code change mounts a new iframe, so old timers and listeners die.

Known gap: `img-src https:` still allows a beacon-style leak of what the block's code itself contains. Pages are shared with collaborators anyway, so this is accepted for M0. A stricter "offline" CSP can be a per-workspace setting.

### Streaming custom UI (from OpenIntelligentUI)

An agent sends a custom UI as separate parts and they arrive **in a fixed order**:

1. `initialHeight` and `placeholders`: the block appears at once with the right size and a rotating status line ("Sketching the orbits…"), so the page doesn't jump.
2. `css`
3. `html`: while the block is `streaming`, the runner shows the markup as it grows, with scripts stripped, in one long-lived iframe.
4. `js`: last, so scripts run once, on complete markup. The block flips to `ready` and a fresh iframe runs the final code.

Anyone can press **Run now** if an agent dies mid-stream. Code from people (Edit code) still renders the old way, debounced.

### Host bridge (from OpenIntelligentUI)

Controls inside a block that only change the view (sliders, toggles, tabs inside the widget) **run locally** in the sandbox, with no agent round trip. When a person's input should reach the agent, the block calls:

```js
livepage.send('add_planet', { current: 3 })
```

The host page **validates** it before anything happens: the message must come from that exact iframe, the action name must match `^[\w.-]{1,64}$`, values must be a JSON object of 8 KB or less, and each block may send at most one action per second. Valid actions are written to the page's `actions` map with the block id and the person's name, which also makes them visible to everyone. Agents pick them up (`get_block_actions` in MCP, `onAction` in the live client, `GET /actions` over HTTP), and answer with `resolve_block_action`. The note shows under the block ("✦ Agent: added Mars"). This replaces the "data bridge" idea for the write direction. The read direction (a block asking the host for page data, such as database rows) is still planned.

### Roadmap for blocks

- CodeMirror 6 with `y-codemirror.next` instead of the textarea (syntax highlighting, remote cursors in code).
- **React/JSX blocks**: compile in the browser with `esbuild-wasm` or Sucrase, like Artifacts do.
- **Data bridge**: a block may ask the parent, via postMessage, for read-only data (for example rows of a database on the page) and gets JSON back. This lets charts update when the database changes, without giving the block network access.
- Block library: save a block as a reusable component, insert it anywhere.
- Thumbnails for export/print (render the block headless to PNG).

---

## 7. Agents (any AI)

An agent is a **participant**, not a feature. Three ways to connect, from richest to simplest:

| Way | Presence and caret | Best for | Where |
|-----|-----|-----|-----|
| **Live client** (Yjs over WebSocket) | Yes, streams edits as it types | Custom agents, demos | `packages/agent/src/client.ts` |
| **Hosted MCP** (`https://<app>/mcp`, Streamable HTTP, `Authorization: Bearer lp_...`) | Yes (each session joins pages over loopback WS with the caller's token) | Any MCP client with just a URL and token: Claude Code, Cursor, Codex, Gemini CLI, VS Code | `apps/server/src/mcp-http.ts`, tools in `packages/agent/src/tools.ts` |
| **Local MCP server** (stdio) | Yes (uses the live client) | Clients that only run local servers | `packages/agent/src/mcp.ts` |
| **HTTP API** | No caret, edits still appear live | Scripts, webhooks, any language | `apps/server/src/agent-api.ts` |

MCP tools today (same on both): `list_pages`, `read_page`, `add_tab`, `write_paragraph`, `add_heading`, `insert_table`, `insert_mind_map`, `add_mind_map_node`, `insert_custom_ui`, `insert_html_block`, `update_html_block`, `get_block_actions`, `resolve_block_action`.

**Choosing the output (from OpenIntelligentUI).** For each request the agent picks the lightest form that works: plain text, then a native component (table, mind map, later drawing or database), and custom UI only for motion or interaction. The MCP server's instructions spell this out for any model that connects.

Planned tools: `insert_after(block_id, ...)`, `replace_text(range)`, `comment(anchor, body)`, `suggest_edit(range, text)` (shown as a suggestion you accept or reject), `list_pages`, `search`, `query_database`.

**No model is built into the server.** That keeps it model-agnostic and means a self-hoster never has to put an AI key on the server. Later, an optional "Ask AI" button in the editor can call any OpenAI-compatible or Anthropic endpoint the user configures, and it would join the page through the same live client.

**Agent edits are attributed.** Every agent connects with its own token and name. The UI marks agents with ✦ in the presence bar. Planned: per-block "last edited by" and an undo that can roll back one participant's changes.

---

## 8. Collaboration and comments

- Real-time editing, presence and carets: done (Yjs + CollaborationCaret).
- **Comments (M2):** a TipTap mark holds `commentId` on a text range. Threads live in the doc's `comments` map (`{ anchor, author, body, createdAt, resolved, replies[] }`) so agents can read and answer them too. Also projected into a `comments` table for notifications.
- Suggestions / track changes (M3): edits from agents can be made as suggestions first.
- Version history (M3): Hocuspocus snapshots every N minutes, browse and restore.

---

## 9. Accounts, permissions and sharing (M1, built)

- **Accounts:** email and password (scrypt). Sessions are random tokens, stored as SHA-256 hashes, sent in an HttpOnly, SameSite=Lax cookie (Secure in production), 30 days. Login and sign-up are rate limited per IP. Mutating requests with a foreign `Origin` are rejected. `SIGNUP_OPEN=0` closes sign-ups.
- **One origin:** in production one server serves the web app, the API (`/api`) and live sync (`/collab`), so the cookie also authenticates the WebSocket. In development Vite proxies `/api` and `/collab` to the server, so the code path is the same.
- **Pages and roles:** `pages` + `page_members (owner | editor | commenter | viewer)`. Hocuspocus `onAuthenticate` resolves the caller (cookie or agent token), looks up the role, rejects non-members, and sets `readOnly` for viewers and commenters, so the server drops any edit they send (tested by forcing edits from a viewer's browser). Commenters become comment-capable in M2.
- **Share links:** the owner creates a link with a role; anyone who opens it and signs in becomes a member with that role (never lowering an existing role). Links can be turned off. The owner can change or remove members.
- **Agent tokens:** a person creates `lp_...` tokens in the app (shown once, stored hashed, revocable, last-used time). An agent using one acts with that person's access, under the token's name. Agents can't mint tokens. The shared `AGENT_TOKEN` is development-only.
- **Later:** OAuth (GitHub, Google), email verification and password reset (needs an email provider), workspaces with default roles, public "publish to web" pages, link expiry, 2FA.

## 9b. Hosting (built)

- **Default:** Render Blueprint (`render.yaml`) with two Docker services from one image: `livepage` (app + API + live sync) and `livepage-sandbox` (HTML block runner), plus a hosted Neon Postgres. Each service learns the other's host from Render (`SANDBOX_HOST`, `APP_HOST`). `*.onrender.com` is on the Public Suffix List, so the two services are different sites. Step-by-step: `DEPLOY.md`.
- **Production server:** serves `apps/web/dist` with a strict CSP (`script-src 'self'`, `frame-src` = sandbox origin, `frame-ancestors 'none'`).
- **Anywhere else:** the same image runs on Railway, Fly.io or a VPS with `docker compose`.

---

## 10. Databases (M4)

Notion-style collections: a database is a page whose rows are pages, with typed properties (text, number, select, date, person, relation). Views: table, board, list, gallery. Stored relationally (`databases`, `rows`), with each row's body being a normal Yjs page, so HTML blocks work inside rows exactly like anywhere else. With the data bridge, an HTML block can chart a database live.

---

## 11. Obsidian side and integrations (M5)

- `[[wikilinks]]` between pages, backlinks panel, quick switcher, graph view as an HTML block.
- Markdown import/export (HTML blocks export as fenced ` ```html ` blocks), so a workspace can round-trip to an Obsidian vault.
- Google Drive: import docs, export pages, attach Drive files. Same pattern for Dropbox and S3.

---

## 12. Self-hosting

```
git clone ... && cd livepage
cp .env.example .env     # DATABASE_URL = your hosted Postgres
docker compose up --build
```

Brings up the collab server, the web app and the sandbox, connected to your hosted database. Add `--profile local-db` (and point `DATABASE_URL` at `db`) to run Postgres in a container on the same machine instead. For production, put a reverse proxy (Caddy) in front with **two hostnames**: `app.example.com` for the web app and server, and a different domain (ideally a different registrable domain, like `example-blocks.net`) for the sandbox. Set `SANDBOX_FRAME_ANCESTORS`, `VITE_SANDBOX_URL` and `VITE_COLLAB_URL` accordingly. Backups: the database provider's point-in-time restore, plus `pg_dump` for a portable copy.

Scaling later: Hocuspocus Redis extension for several server instances.

---

## 13. Milestones

| | Milestone | Done when |
|---|-----------|-----------|
| **M0** | **Live demo** (this scaffold) | Two browsers and an agent edit one page live. The agent types with its own caret, adds a table and a mind map, streams in a custom UI block, answers a button press from it, and writes in a second tab. Pages persist in hosted Postgres. ✅ |
| M1 | Accounts, sharing, hosting | Sign up, page list, roles, share links, agent tokens, one-click deploy (Render + Neon). ✅ (page tree sidebar and workspaces moved to M3) |
| M2 | Comments | Comment on a selection, threads, agents can read and reply. |
| M3 | Writing quality | Slash menu, drag handles, drawing block, CodeMirror block editor, suggestions, version history. |
| M4 | Databases and design | Collections with properties and views, read bridge for custom UI, design frame block. |
| M5 | Obsidian + integrations | Wikilinks, backlinks, markdown round-trip, Google Drive. |

---

## 14. Open questions

1. **Name.** "Livepage" is a placeholder.
2. **Agent permissions.** Should agents edit directly by default, or start in suggestion mode and earn direct edit rights per page?
3. **Built-in AI.** Keep the server model-free forever, or ship an optional "Ask AI" button with bring-your-own-key?
4. **Offline.** Yjs supports offline editing via IndexedDB. Is offline-first a goal for v1?
