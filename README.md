# Livepage

An open-source, self-hostable writing canvas where **people and AI agents edit the same live page**. Write like in Notion, and drop in **live HTML/JS blocks** (animations, diagrams, widgets) that render in a sandbox, the way Claude Artifacts and ChatGPT Canvas do. Any AI can join through MCP or a small HTTP API.

![One page mixing text, a table, a mind map and agent custom UI](docs/mixed-page.png)

> Early but usable: accounts, sharing and hosting are in (Milestone 1). See **[SPEC.md](SPEC.md)** for the design and roadmap.
>
> **Put it on the web:** follow **[DEPLOY.md](DEPLOY.md)** (Neon + Render, about 15 minutes).

## What works today

- Accounts (email and password), your own page list, live page titles
- Obsidian-style sidebar: your own nested folders of pages (create, rename, drag to move, collapse), a **Today** button that opens `YYYY/MM/DD/daily` (created if missing, using your local date)
- Links between pages and tabs: type `[[` to search, add `#` for a tab, or paste a page link. Links point at ids, so they survive renames and moves, and every page lists its backlinks ("Linked from")
- Tags on pages, and saved **views** in the sidebar that list the pages with any or all of some tags
- **Templates**: mark any page as a template (⋯ menu), start new pages from it in the sidebar, and pick one for your daily pages. `{{date}}`, `{{title}}`, `{{yesterday}}`, `{{date:MMMM D, YYYY}}` and similar fill in automatically; any other `{{Field}}` stays highlighted for you or an agent to fill in (`fill_template_fields`)
- **Import** Markdown files, a folder or an Obsidian vault (or a .zip): folders, frontmatter, `#tags`, `[[links]]` and `[^1]` footnotes come across. **Export** a page as Markdown or PDF, or everything as a zip you can open in Obsidian
- **Publish to the web**: a clean, public, read-only page at `/pub/<slug>` that anyone can read without an account; live HTML blocks keep running in the sandbox
- Sharing: invite links that grant edit, comment or view access; view-only people can't change anything (enforced on the server); the owner manages who has access
- Personal agent tokens, so any AI joins your pages with your access
- Real-time collaborative editor (TipTap + Yjs + Hocuspocus) with live carets and a presence bar
- Any mix of blocks on one page: text, tables, mind maps and custom UI, all editable by people and agents
- Optional tabs at the top of a page, each its own live document
- Custom UI (HTML) blocks rendered in a sandboxed iframe on a separate origin with a strict CSP; they stream in progressively (CSS, HTML, then JS) and their code is co-editable live
- Host bridge: controls inside a block can send validated input back to the agent
- Agents as live participants with their own named caret (`packages/agent`)
- Hosted MCP endpoint (`/mcp`) so Claude, Cursor, Codex, Gemini CLI or any MCP client can read and write pages with just a URL and a token
- HTTP API for scripts in any language
- Postgres persistence (hosted by default) plus a queryable `blocks` table
- Docker Compose for self-hosting

## Run it locally

Needs Node 22+ and pnpm 10 (`corepack enable`).

Livepage stores pages in **a hosted Postgres by default**, so nothing is lost if your machine or a container dies. A free [Neon](https://neon.tech) or [Supabase](https://supabase.com) database is enough.

```bash
pnpm install
cp .env.example .env        # paste your hosted DATABASE_URL (keep ?sslmode=require)
pnpm dev                    # open http://localhost:5173 (server :1234 and sandbox :5174 run behind it)
```

Just want to look around? `pnpm dev:memory` runs with an in-memory Postgres, and everything is lost when the server stops.

Sign up at http://localhost:5173, create a page, click **Share** and open the link in a second (private) window as another user. Then, with the page id from the URL:

```bash
pnpm agent:demo p_xxxxxxxxxxxx
```

Locally the demo uses the shared development token. On a hosted server, create an agent token in the app and run `LIVEPAGE_URL=wss://<your app>/collab AGENT_TOKEN=lp_... pnpm agent:demo <page id>`.

The agent joins the page, types with its own caret, adds a table and a mind map, streams in an orbit explorer, and writes its sources in a second tab. The slider in the block runs locally. **Ask the agent to add a planet** goes back to the agent, which updates the block. Edit the mind map, the table or the block's code in either window and both update live.

![The agent typing with its own caret](docs/agent-typing.png)

## Self-host with Docker

```bash
cp .env.example .env        # set DATABASE_URL to your hosted Postgres
docker compose up --build
```

Then open http://localhost:1234. The server refuses to start without `DATABASE_URL`. For a public deployment see [DEPLOY.md](DEPLOY.md).

Prefer a database on the same machine? The bundled Postgres is an opt-in profile. Its data lives in a Docker volume, so back it up yourself:

```bash
DATABASE_URL=postgres://livepage:livepage@db:5432/livepage docker compose --profile local-db up --build
```
 For a real deployment, serve the sandbox from a **different domain** from the app (see SPEC.md §12).

## Connect an AI

Every Livepage app serves a **hosted MCP endpoint** at `https://<your app>/mcp` (Streamable HTTP). Any MCP client can connect with that URL and an agent token, with nothing to install. Create the token on your home page with **+ Agent token**, and send it as `Authorization: Bearer lp_...`. The agent joins pages live, with its own caret, and can only open pages its owner can.

**Claude Code**

```bash
claude mcp add --transport http livepage https://<your app>/mcp --header "Authorization: Bearer lp_..."
```

**Cursor** (`~/.cursor/mcp.json`) and **Gemini CLI** (`~/.gemini/settings.json`; use `"httpUrl"` in place of `"url"`)

```json
{ "mcpServers": { "livepage": { "url": "https://<your app>/mcp", "headers": { "Authorization": "Bearer lp_..." } } } }
```

**VS Code** (`.vscode/mcp.json`)

```json
{ "servers": { "livepage": { "type": "http", "url": "https://<your app>/mcp", "headers": { "Authorization": "Bearer lp_..." } } } }
```

**Codex** (`~/.codex/config.toml`, with the token in the `LIVEPAGE_TOKEN` environment variable)

```toml
[mcp_servers.livepage]
url = "https://<your app>/mcp"
bearer_token_env_var = "LIVEPAGE_TOKEN"
```

**Clients that only run local (stdio) servers:** bridge with `npx -y mcp-remote https://<your app>/mcp --header "Authorization: Bearer lp_..."`, or run the bundled stdio server from a checkout:

```bash
claude mcp add livepage -e LIVEPAGE_URL=wss://<your app>/collab -e AGENT_TOKEN=lp_... -- pnpm --silent --dir /path/to/livepage agent:mcp
```

Web chat apps that only accept OAuth connectors (ChatGPT, claude.ai) can't use a token yet; use the HTTP API below, or a client above.

Tools: `list_pages` (filter by folder `path` or `tags`), `list_folders`, `create_folder`, `create_page`, `open_daily_page`, `move_page`, `rename_page`, `set_page_tags`, `list_tags`, `create_view`, `get_backlinks`, `read_page`, `add_tab`, `write_paragraph`, `add_heading`, `insert_table`, `insert_mind_map`, `add_mind_map_node`, `insert_custom_ui`, `insert_html_block`, `update_html_block`, `get_block_actions`, `resolve_block_action`.

**HTTP**:

```bash
curl -H "Authorization: Bearer lp_..." https://<your app>/api/pages
curl -H "Authorization: Bearer lp_..." https://<your app>/api/pages/p_xxx/content
curl -X POST -H "Authorization: Bearer lp_..." -H "content-type: application/json" \
  -d '{"rows":[["Planet","Moons"],["Mars","2"]]}' https://<your app>/api/pages/p_xxx/tables
curl -X POST -H "Authorization: Bearer lp_..." -H "content-type: application/json" \
  -d '{"title":"Chapter 1","path":"Projects/Book","tags":["draft"]}' https://<your app>/api/pages
curl -X POST -H "Authorization: Bearer lp_..." -H "content-type: application/json" \
  -d '{"date":"2026-11-23"}' https://<your app>/api/daily
```

The folder, tag and view endpoints are listed at the top of `apps/server/src/agent-api.ts`.

## Layout

```
apps/web        React + TipTap editor, HTML block node view, sandbox iframe
apps/server     One server: web app (prod), accounts, sharing, API, live sync (Hocuspocus), Postgres
apps/sandbox    Serves the HTML block runner on its own origin with a strict CSP
packages/schema The shared page model (Yjs) used by editor, server and agents
packages/agent  Live agent client, demo script, MCP server
```

## Security notes

- Passwords are hashed with scrypt; sessions are random tokens stored hashed, in an HttpOnly, SameSite=Lax cookie (Secure in production). Cross-site writes are rejected by an Origin check.
- Every live connection is authenticated and checked against the page's members; viewers and commenters connect read-only, so the server drops their edits.
- HTML blocks run on a separate origin in a sandboxed iframe with a strict CSP (see SPEC.md §6). The app itself is served with a CSP that only allows frames from the sandbox.
- The shared `AGENT_TOKEN` exists for local development only and is ignored when `NODE_ENV=production`.
- Not yet: email verification, password reset, and two-factor sign-in.

## License

[MIT](LICENSE)
