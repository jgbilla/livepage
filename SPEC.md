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
| 3 | How the agent works | **Live, in the page, alongside you**, with presence and a caret. Not a side chat that pastes results. |
| 4 | Which AI | **Any.** Agents connect over MCP or a small HTTP API. No model is built in. |
| 5 | Sharing | Required: share links and per-page permissions. |
| 6 | Collaboration | Multi-user, real-time (CRDT). |
| 7 | Hosting | Anyone can self-host: `docker compose up`. |

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
                Postgres
   documents (Yjs state)   blocks (queryable projection)   users, pages, shares... (M1+)

 HTML blocks:  <iframe sandbox="allow-scripts" src="https://SANDBOX_ORIGIN/runner.html">
               served by the sandbox service, a different origin, with strict CSP
```

| Piece | Tech | Where |
|-------|------|-------|
| Editor | TipTap 3 (ProseMirror) + React 19 + Vite | `apps/web` |
| Live sync | Yjs CRDT, Hocuspocus server/provider | `apps/server`, `apps/web` |
| Storage | Postgres 17 | `apps/server/src/db.ts` |
| HTML block runtime | Static runner on its own origin, strict CSP | `apps/sandbox` |
| Shared document model | Yjs helpers used by every participant | `packages/schema` |
| Agent connectivity | Live WS client, MCP server, HTTP API | `packages/agent`, `apps/server/src/agent-api.ts` |
| Self-hosting | Docker Compose | `docker-compose.yml` |

**Why Yjs + Hocuspocus:** it is the most mature open-source CRDT stack for ProseMirror, it handles offline/reconnect, and the server is small enough to self-host. An agent is just one more Yjs client, which is what makes "the agent edits live with its own cursor" fall out for free.

---

## 4. Document model

Each page is one `Y.Doc`:

| Shared type | Name | Holds |
|-------------|------|-------|
| `XmlFragment` | `default` | The block tree: paragraphs, headings, lists, quotes, code, `htmlBlock` nodes |
| `Map<Y.Text>` | `htmlCode` | `blockId → Y.Text` with each HTML block's source |
| `Map<Y.Map>` | `comments` | Comment threads (M2) |
| `Map` | `meta` | Title, icon, cover (M1) |

An HTML block in the tree stores only `{ blockId, title }`. Its code lives in `htmlCode` as a `Y.Text`, so two people and an agent can edit the same block's code at the same time, character by character, and the merge is automatic. The rendered iframe follows the code with a 400 ms debounce.

`packages/schema` is the single definition of this model. The editor, the server's projection and every agent use it, so "a page" means the same thing to all of them.

---

## 5. Storage

The Yjs state is the **source of truth** for content (it's what makes real-time merging work). Postgres stores it and also keeps **relational projections** so the server can query pages like Notion does.

Implemented now:

```sql
documents (name pk, data bytea, updated_at)          -- Yjs state per page
blocks    (doc_name, id, position, type, text, attrs jsonb)  -- rewritten on every save
```

Planned (M1 to M4):

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
| **MCP server** | Yes (uses the live client) | Claude Desktop/Code, ChatGPT and any MCP client | `packages/agent/src/mcp.ts` |
| **HTTP API** | No caret, edits still appear live | Scripts, webhooks, any language | `apps/server/src/agent-api.ts` |

MCP tools today: `read_page`, `write_paragraph`, `add_heading`, `insert_html_block`, `update_html_block`.

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

## 9. Accounts, permissions and sharing (M1)

- Email + password and OAuth (GitHub, Google) via a small auth module, sessions in an httpOnly cookie on the app origin.
- Hocuspocus `onAuthenticate` checks the session or API token and the page role, and sets the connection read-only for viewers and commenters.
- Roles: owner, editor, commenter, viewer. Per workspace, overridable per page.
- **Share links:** a token URL with a role and optional expiry. A public "publish to web" mode renders a read-only page (HTML blocks still sandboxed).
- **Agent tokens:** created per user or workspace, scoped to pages, revocable. Today the server has one shared `AGENT_TOKEN` and every other connection is a guest.

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
docker compose up --build
```

Brings up Postgres, the collab server, the web app and the sandbox. For production, put a reverse proxy (Caddy) in front with **two hostnames**: `app.example.com` for the web app and server, and a different domain (ideally a different registrable domain, like `example-blocks.net`) for the sandbox. Set `SANDBOX_FRAME_ANCESTORS`, `VITE_SANDBOX_URL` and `VITE_COLLAB_URL` accordingly. Backups are plain `pg_dump`.

Scaling later: Hocuspocus Redis extension for several server instances.

---

## 13. Milestones

| | Milestone | Done when |
|---|-----------|-----------|
| **M0** | **Live demo** (this scaffold) | Two browsers and an agent edit one page live. The agent types with its own caret and inserts an animated HTML block. Pages persist in Postgres. ✅ |
| M1 | Accounts and sharing | Sign up, workspaces, page tree sidebar, roles, share links, agent tokens. |
| M2 | Comments | Comment on a selection, threads, agents can read and reply. |
| M3 | Writing quality | Slash menu, drag handles, CodeMirror block editor, suggestions, version history. |
| M4 | Databases | Collections with properties and views, data bridge for HTML blocks. |
| M5 | Obsidian + integrations | Wikilinks, backlinks, markdown round-trip, Google Drive. |

---

## 14. Open questions

1. **License.** AGPL-3.0 stops someone from hosting a closed fork as a paid service. MIT/Apache gets wider adoption. Pick before the first public push. (No license is set yet.)
2. **Name.** "Livepage" is a placeholder.
3. **Agent permissions.** Should agents edit directly by default, or start in suggestion mode and earn direct edit rights per page?
4. **Built-in AI.** Keep the server model-free forever, or ship an optional "Ask AI" button with bring-your-own-key?
5. **Offline.** Yjs supports offline editing via IndexedDB. Is offline-first a goal for v1?
