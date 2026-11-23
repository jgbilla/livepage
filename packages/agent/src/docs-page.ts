// Writes the Livepage documentation as a Livepage page: an Overview tab with a live
// architecture diagram and a feature mind map, then one tab per topic.
//
//   LIVEPAGE_URL=wss://<your app>/collab AGENT_TOKEN=lp_... pnpm agent:docs            # creates a new page
//   LIVEPAGE_URL=wss://<your app>/collab AGENT_TOKEN=lp_... pnpm agent:docs p_xxxx     # writes into an existing (empty) page
import * as Y from 'yjs';
import { fragment, META, renameTab } from '@livepage/schema';
import { LiveAgent } from './client.ts';
import { httpBaseFor } from './tools.ts';

const wsUrl = process.env.LIVEPAGE_URL ?? 'ws://localhost:1234/collab';
const token = process.env.AGENT_TOKEN ?? 'dev-agent-token';
const base = httpBaseFor(wsUrl);
const TITLE = 'Livepage documentation';
// Examples use this app's real address, e.g. https://livepage.example.com/mcp
const HOST = new URL(base).host;

let pageId = process.argv[2];
if (!pageId) {
  const res = await fetch(`${base}/api/pages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title: TITLE }),
  });
  if (!res.ok) throw new Error(`could not create the page: ${res.status} ${await res.text()}`);
  pageId = ((await res.json()) as { page: { id: string } }).page.id;
}
console.log(`[docs] writing ${pageId}`);

const agent = await LiveAgent.connect({ page: pageId, url: wsUrl, token, name: 'Docs writer' });
const doc = agent.doc;

// ---- tiny markdown-ish writer: headings, paragraphs, bullets, numbered lists, code blocks,
// with inline `code` and **bold**.
function inline(text: string): Y.XmlText {
  const t = new Y.XmlText();
  let i = 0;
  for (const part of text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean)) {
    if (part.startsWith('`')) t.insert(i, part.slice(1, -1), { code: {}, bold: null });
    else if (part.startsWith('**')) t.insert(i, part.slice(2, -2), { bold: {}, code: null });
    else t.insert(i, part, { bold: null, code: null });
    i += part.startsWith('`') ? part.length - 2 : part.startsWith('**') ? part.length - 4 : part.length;
  }
  return t;
}
const para = (text: string) => { const p = new Y.XmlElement('paragraph'); p.insert(0, [inline(text)]); return p; };
function list(kind: 'bulletList' | 'orderedList', items: string[]) {
  const l = new Y.XmlElement(kind);
  l.insert(0, items.map((it) => { const li = new Y.XmlElement('listItem'); li.insert(0, [para(it)]); return li; }));
  return l;
}

function write(tab: string, src: string) {
  src = src.replaceAll('https://<your app>', base).replaceAll('wss://<your app>', wsUrl.replace(/\/collab\/?$/, '')).replaceAll('<your app>', HOST);
  const out: Y.XmlElement[] = [];
  const lines = src.replace(/^\n/, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const h = line.match(/^(#{1,3}) (.*)$/);
    if (h) {
      const el = new Y.XmlElement('heading');
      el.setAttribute('level', h[1].length as unknown as string);
      el.insert(0, [inline(h[2])]);
      out.push(el);
    } else if (line.startsWith('```')) {
      const code: string[] = [];
      while (++i < lines.length && !lines[i].startsWith('```')) code.push(lines[i]);
      const el = new Y.XmlElement('codeBlock');
      const t = new Y.XmlText();
      t.insert(0, code.join('\n'));
      el.insert(0, [t]);
      out.push(el);
    } else if (/^(- |\d+\. )/.test(line)) {
      const ordered = /^\d+\. /.test(line);
      const items: string[] = [];
      while (i < lines.length && (ordered ? /^\d+\. /.test(lines[i]) : lines[i].startsWith('- '))) {
        items.push(lines[i].replace(/^(- |\d+\. )/, ''));
        i++;
      }
      i--;
      out.push(list(ordered ? 'orderedList' : 'bulletList', items));
    } else {
      out.push(para(line));
    }
  }
  doc.transact(() => { const f = fragment(doc, tab); f.insert(f.length, out); });
}
const table = (tab: string, rows: string[][]) => agent.useTab(tab).addTable(rows);

doc.transact(() => {
  doc.getMap(META).set('title', TITLE);
  renameTab(doc, 'main', 'Overview');
});

// =====================================================================================
// Overview
await agent.useTab('main').typeParagraph(
  'Livepage is an open-source writing canvas where people and AI agents edit the same live page together. This page is the documentation, and it is itself a Livepage page: an agent wrote it through the same tools any agent can use.',
  120,
);
write('main', `
Write like in Notion, keep notes like in Obsidian, and drop in live HTML/JS blocks (animations, diagrams, small apps) the way Claude Artifacts and ChatGPT Canvas do. Every block on a page, whether text, a table, a mind map or custom UI, can be edited by everyone on the page, people and agents alike, and changes show up for everyone as they happen.

## At a glance
- **One live page:** a single scrolling page, with optional tabs at the top.
- **Any mix of blocks:** text, headings, lists, tables, mind maps and sandboxed custom UI, side by side.
- **Real-time collaboration:** live carets and presence for every person and agent.
- **Any AI:** agents connect over MCP or a plain HTTP API. No model is built in.
- **Sharing:** invite links with editor, commenter or viewer access, enforced on the server.
- **Yours to run:** MIT licensed, self-hostable with Docker, or one-click on Render with a Neon Postgres database.

## How it fits together
The diagram below is a custom UI block. It runs in a sandbox on a separate domain, like any HTML block on a page.
`);
await agent.useTab('main').streamUI({
  title: 'Architecture',
  initialHeight: 360,
  placeholders: ['Drawing the architecture…', 'Connecting the pieces…'],
  css: `
:root{--bg:#fbfaff;--ink:#1f1d2b;--muted:#6b6880;--line:#d9d5ee;--app:#7048e8;--db:#0ca678;--sb:#f08c00;--ag:#1c7ed6}
@media (prefers-color-scheme:dark){:root{--bg:#17161f;--ink:#ecebf5;--muted:#a3a0b8;--line:#35334a}}
*{box-sizing:border-box}
body{margin:0;font:13px/1.35 system-ui,sans-serif;background:var(--bg);color:var(--ink)}
.wrap{position:relative;height:340px;max-width:760px;margin:0 auto}
svg{position:absolute;inset:0;width:100%;height:100%}
.box{position:absolute;border:1.5px solid var(--c);border-radius:10px;padding:8px 10px;background:color-mix(in srgb,var(--c) 9%,var(--bg));cursor:default;transition:transform .15s}
.box:hover{transform:translateY(-2px)}
.box b{display:block;color:var(--c);font-size:13px}.box span{color:var(--muted);font-size:11.5px}
.tip{position:absolute;left:0;right:0;bottom:0;text-align:center;color:var(--muted);font-size:12px;min-height:16px}
path{fill:none;stroke:var(--line);stroke-width:2}
circle.pk{r:4}`,
  html: `
<div class="wrap" id="w">
  <svg id="s" viewBox="0 0 760 320" preserveAspectRatio="none"></svg>
  <div class="box" data-k="people" style="--c:var(--app);left:2%;top:6%;width:22%"><b>People</b><span>Browsers: editor, carets, tabs</span></div>
  <div class="box" data-k="agents" style="--c:var(--ag);left:2%;top:58%;width:22%"><b>Agents</b><span>Any AI via MCP or HTTP API</span></div>
  <div class="box" data-k="app" style="--c:var(--app);left:38%;top:26%;width:24%"><b>Livepage server</b><span>Web app · /api · /collab (Yjs) · /mcp</span></div>
  <div class="box" data-k="db" style="--c:var(--db);left:76%;top:6%;width:22%"><b>Postgres</b><span>Neon by default: pages, members, blocks</span></div>
  <div class="box" data-k="sb" style="--c:var(--sb);left:76%;top:58%;width:22%"><b>Sandbox</b><span>Separate origin for HTML blocks</span></div>
  <div class="tip" id="tip">Hover a box to see what it does.</div>
</div>`,
  js: `
const tips={people:'People edit in the browser. Every keystroke is a Yjs update, merged live over a WebSocket.',
agents:'Agents join like people: with a token, a named caret and the same page permissions.',
app:'One server, one origin: serves the app, the HTTP API, live sync and the hosted MCP endpoint.',
db:'Pages are saved as Yjs documents plus a queryable blocks table. Hosted Postgres means nothing is lost if a machine dies.',
sb:'HTML blocks run in a sandboxed iframe on another domain with a strict CSP, so they can never touch your session.'};
const w=document.getElementById('w'),s=document.getElementById('s'),tip=document.getElementById('tip');
const r=k=>{const e=w.querySelector('[data-k='+k+']'),a=e.getBoundingClientRect(),b=w.getBoundingClientRect();
return{x:(a.left-b.left+a.width/2)/b.width*760,y:(a.top-b.top+a.height/2)/b.height*320}};
const links=[['people','app','#7048e8'],['agents','app','#1c7ed6'],['app','db','#0ca678'],['app','sb','#f08c00']];
let paths=[];
function draw(){s.innerHTML='';paths=links.map(([a,b,c])=>{const p=r(a),q=r(b),m=(p.x+q.x)/2;
const el=document.createElementNS('http://www.w3.org/2000/svg','path');el.setAttribute('d','M'+p.x+','+p.y+' C'+m+','+p.y+' '+m+','+q.y+' '+q.x+','+q.y);s.appendChild(el);
const dot=document.createElementNS('http://www.w3.org/2000/svg','circle');dot.setAttribute('class','pk');dot.setAttribute('r','4');dot.setAttribute('fill',c);s.appendChild(dot);
return{el,dot,len:el.getTotalLength(),t:Math.random()}})}
draw();addEventListener('resize',draw);
(function tick(){for(const p of paths){p.t=(p.t+0.006)%1;const f=p.t<.5?p.t*2:2-p.t*2;const pt=p.el.getPointAtLength(f*p.len);p.dot.setAttribute('cx',pt.x);p.dot.setAttribute('cy',pt.y)}requestAnimationFrame(tick)})();
w.querySelectorAll('.box').forEach(b=>{b.onmouseenter=()=>tip.textContent=tips[b.dataset.k];b.onmouseleave=()=>tip.textContent='Hover a box to see what it does.'});`,
});

write('main', `
## Everything Livepage does
This mind map is a native block: click a node to edit it, press Tab for a child or Enter for a sibling.
`);
agent.useTab('main').addMindMap({
  text: 'Livepage',
  children: [
    { text: 'Write', children: [{ text: 'Text, headings, lists' }, { text: 'Tables' }, { text: 'Mind maps' }, { text: 'Tabs' }] },
    { text: 'Build', children: [{ text: 'Custom UI blocks' }, { text: 'Streaming in order' }, { text: 'Host bridge (livepage.send)' }] },
    { text: 'Collaborate', children: [{ text: 'Live carets' }, { text: 'Share links' }, { text: 'Roles' }] },
    { text: 'Agents', children: [{ text: 'Hosted MCP' }, { text: 'Local MCP' }, { text: 'HTTP API' }] },
    { text: 'Run it', children: [{ text: 'Render + Neon' }, { text: 'Docker' }, { text: 'Locally' }] },
  ],
}, 'Livepage features');

write('main', `
## In this documentation
Each tab at the top goes into detail:
`);
table('main', [
  ['Tab', 'What it covers'],
  ['Getting started', 'Using the hosted app, running it locally, self-hosting with Docker, deploying to Render + Neon'],
  ['Editor and blocks', 'Every block type, when to use which, custom UI streaming and the host bridge, tabs'],
  ['Collaboration and sharing', 'Live editing, roles, share links and how access is enforced'],
  ['Accounts and sign-in', 'Email and password, Google via Neon Auth, sessions, agent tokens, security'],
  ['Connect agents', 'Hosted MCP for any client, the local MCP server, the HTTP API and the full tool list'],
  ['Architecture', 'Components, the document model, storage, the sandbox security model, repo layout'],
  ['Roadmap', 'What is built, what comes next, and open questions'],
]);

// =====================================================================================
const gs = agent.addTab('Getting started');
write(gs, `
# Getting started
## Use the hosted app
1. Open your Livepage address (https://<your app>) and sign up with email and password, or with **Continue with Google** where it is enabled.
2. Click **+ New page**. Give it a title and start writing.
3. Click **Share** to invite people, or create an **agent token** on your home page to let an AI join.
On Render's free plan the app sleeps after 15 minutes without visitors, so the first visit after a break can take about a minute.

## Run it locally
Needs Node 22+ and pnpm 10 (\`corepack enable\`). Pages are stored in a hosted Postgres by default, so a free Neon or Supabase database is enough.
\`\`\`
pnpm install
cp .env.example .env        # paste your hosted DATABASE_URL (keep ?sslmode=require)
pnpm dev                    # open http://localhost:5173
\`\`\`
Just looking around? \`pnpm dev:memory\` uses an in-memory Postgres, and everything is lost when the server stops.
To see an agent at work, create a page, then run \`pnpm agent:demo <page id>\`. It types with its own caret, adds a table and a mind map, streams in a custom UI block and writes in a second tab.

## Self-host with Docker
\`\`\`
cp .env.example .env        # set DATABASE_URL to your hosted Postgres
docker compose up --build   # then open http://localhost:1234
\`\`\`
Prefer a database on the same machine? Add \`--profile local-db\` and point \`DATABASE_URL\` at the bundled Postgres. Its data lives in a Docker volume, so back it up yourself.

## Deploy to Render + Neon (about 15 minutes)
1. Create a Neon project and copy its pooled connection string.
2. On Render: **New > Blueprint**, pick the livepage repository. Render reads \`render.yaml\` and creates two services: \`livepage\` (the app) and \`livepage-sandbox\` (where HTML blocks run, on a separate domain).
3. Paste \`DATABASE_URL\` when asked, and optionally \`NEON_AUTH_BASE_URL\` for Google sign-in.
4. Click **Apply**. Every push to main redeploys automatically.
5. For Google sign-in, add the app address as a Neon Auth trusted domain: \`neon neon-auth domain add https://<your app>\`.

## Configuration
`);
table(gs, [
  ['Variable', 'Where', 'What it does'],
  ['DATABASE_URL', 'App', 'Postgres connection (required). Use the pooled URL on Neon.'],
  ['PG_POOL_MAX', 'App', 'Max database connections (default 5, for free tiers).'],
  ['SANDBOX_URL', 'App', 'Public address of the sandbox. Must be a different domain from the app.'],
  ['SANDBOX_FRAME_ANCESTORS', 'Sandbox', 'The app address allowed to embed HTML blocks.'],
  ['SIGNUP_OPEN', 'App', 'Set to 0 to close sign-ups once your people have accounts.'],
  ['NEON_AUTH_BASE_URL', 'App', 'Optional. Turns on "Continue with Google" through Neon Auth.'],
  ['AGENT_TOKEN', 'Dev only', 'Shared development token. Ignored in production.'],
]);

// =====================================================================================
const ed = agent.addTab('Editor and blocks');
write(ed, `
# Editor and blocks
A page is a stack of blocks, and every block type is first-class: any mix on the same page or tab, the same live merging, and the same access for people and agents. There is no separate "AI area".
`);
table(ed, [
  ['Block', 'Kind', 'How to edit', 'Status'],
  ['Paragraph, heading, list, quote, code', 'Native text', 'Type; agents write character by character', 'Built'],
  ['Table', 'Native', 'Toolbar > Table; cells are normal text', 'Built'],
  ['Mind map', 'Native', 'Click a node; Tab adds a child, Enter a sibling', 'Built'],
  ['Custom UI / HTML block', 'Sandboxed code', '"Edit code" to co-edit the source live', 'Built'],
  ['Drawing / whiteboard', 'Native', 'Shapes and arrows', 'Planned'],
  ['Design frame, images, files, database views', 'Native', '', 'Planned'],
]);
write(ed, `
## Native first, custom UI when it earns it
Native blocks are editable, searchable and exportable like text, so they win whenever they fit. Custom UI is for what native blocks can't do: motion, simulations, interactive explainers and one-off visualizations. Agents follow the same rule: plain text first, then a native table or mind map, and custom UI only for motion or interaction.

## Custom UI blocks
- **Sandboxed:** each block runs in an iframe on a separate origin with a strict Content Security Policy. Scripts from CDNs are allowed, but blocks can't make network requests or reach your session.
- **Streams in order:** an agent reserves the block's height and shows placeholder messages first, then streams CSS, then HTML (previewed as it arrives), then JS, which runs once the block is complete. You watch it take shape instead of waiting.
- **Co-edited code:** a block's source is a live text field, so people and agents can edit the same code at the same time.
- **Host bridge:** controls inside a block can send input back with \`livepage.send('action_name', { values })\`. The host checks every message (exact iframe, action name format, at most 8 KB, one per second per block), records it on the page, and the agent answers it. A note shows under the block when it does.
Try the diagram on the Overview tab: it is a custom UI block.

## Tabs
Tabs are optional, like Google Docs tabs, and show at the top of the page. Click to switch, double-click to rename, and × to delete (except the main tab). The active tab is in the URL (\`?tab=<id>\`), so links can point at a tab, and dots on each tab show who is there. Agents can read every tab at once and write into any of them.
`);

// =====================================================================================
const co = agent.addTab('Collaboration and sharing');
write(co, `
# Collaboration and sharing
## Live editing
Every page is one shared document (Yjs) synced over a WebSocket. Edits from people and agents merge automatically, even when they type in the same paragraph at the same time. Each participant has a named caret, the presence bar shows who is on the page, and tab dots show who is on which tab.

## Roles
`);
table(co, [
  ['Role', 'Read', 'Edit', 'Share and manage members'],
  ['Owner', 'Yes', 'Yes', 'Yes'],
  ['Editor', 'Yes', 'Yes', 'No'],
  ['Commenter', 'Yes', 'No (comments come in a later milestone)', 'No'],
  ['Viewer', 'Yes', 'No', 'No'],
]);
write(co, `
## Share links
1. Open a page and click **Share**.
2. Pick the access the link grants (editor, commenter or viewer) and click **Create link**.
3. Anyone who opens the link and signs in becomes a member with that role. A link never lowers someone's existing role.
The owner can turn links off, change members' roles or remove them at any time.

## Enforced on the server
Access isn't just hidden in the interface. Every live connection is authenticated and checked against the page's members. Viewers and commenters connect read-only, so the server drops any edit they send, even one forced from the browser's developer tools. People who aren't members see "Page not found, or you do not have access."
`);

// =====================================================================================
const ac = agent.addTab('Accounts and sign-in');
write(ac, `
# Accounts and sign-in
## Ways to sign in
- **Email and password:** passwords are hashed with scrypt. Sign-up and login are rate limited per IP.
- **Continue with Google:** through Neon Auth (Managed Better Auth), when \`NEON_AUTH_BASE_URL\` is set. The server verifies Neon Auth's signed token, then signs you in with a normal Livepage session. A Google account is only linked to an existing password account when Google confirms the email is verified.
## Sessions
Sessions are random tokens stored hashed, sent in an HttpOnly, SameSite=Lax cookie (Secure in production), valid for 30 days. Requests that change something from a foreign Origin are rejected.

## Agent tokens
An agent token (\`lp_...\`) lets an AI act with your access, under the token's name.
1. On your home page, click **+ Agent token** and name it (for example "Cursor").
2. Copy it: it is shown once and stored hashed.
3. Give it to the agent's MCP or HTTP setup. Revoke it on the home page any time; the last-used time shows there too.
Agents can't create tokens, and a token only opens pages its owner can open. Keep tokens out of chats and repositories.

## Security notes
- HTML blocks run on a separate domain in a sandboxed iframe with a strict CSP, and the app only allows frames from that sandbox.
- The shared development \`AGENT_TOKEN\` is ignored when the server runs in production.
- Not yet: email verification, password reset and two-factor sign-in.
`);

// =====================================================================================
const ag = agent.addTab('Connect agents');
write(ag, `
# Connect agents
Livepage is model-agnostic: any AI can join a page, read it, and write text, tables, mind maps and custom UI live, with its own caret. Start by creating an agent token on your home page.

## Hosted MCP (any client, nothing to install)
Every Livepage app serves an MCP endpoint at \`https://<your app>/mcp\` (Streamable HTTP). Connect with that address and the header \`Authorization: Bearer lp_...\`.
**Claude Code**
\`\`\`
claude mcp add --transport http livepage https://<your app>/mcp --header "Authorization: Bearer lp_..."
\`\`\`
**Cursor** (~/.cursor/mcp.json) and **Gemini CLI** (~/.gemini/settings.json, with "httpUrl" in place of "url")
\`\`\`
{ "mcpServers": { "livepage": { "url": "https://<your app>/mcp", "headers": { "Authorization": "Bearer lp_..." } } } }
\`\`\`
**VS Code** (.vscode/mcp.json)
\`\`\`
{ "servers": { "livepage": { "type": "http", "url": "https://<your app>/mcp", "headers": { "Authorization": "Bearer lp_..." } } } }
\`\`\`
**Codex** (~/.codex/config.toml, token in the LIVEPAGE_TOKEN environment variable)
\`\`\`
[mcp_servers.livepage]
url = "https://<your app>/mcp"
bearer_token_env_var = "LIVEPAGE_TOKEN"
\`\`\`
Web chat apps that only accept OAuth connectors (ChatGPT, claude.ai) can't use a token yet.

## Local MCP server
For clients that only run local servers, run the bundled stdio server from a checkout, or bridge the hosted one with \`npx -y mcp-remote https://<your app>/mcp --header "Authorization: Bearer lp_..."\`.
\`\`\`
claude mcp add livepage -e LIVEPAGE_URL=wss://<your app>/collab -e AGENT_TOKEN=lp_... -- pnpm --silent --dir /path/to/livepage agent:mcp
\`\`\`

## MCP tools
`);
table(ag, [
  ['Tool', 'What it does'],
  ['list_pages', 'Pages the token can open, with your role'],
  ['read_page', 'The whole page as markdown, every tab, with block and node ids'],
  ['write_paragraph / add_heading', 'Append text; paragraphs are typed out live'],
  ['insert_table', 'A native, editable table'],
  ['insert_mind_map / add_mind_map_node', 'A native mind map, then grow it node by node'],
  ['insert_custom_ui', 'A sandboxed block streamed as height and placeholders, CSS, HTML, then JS'],
  ['insert_html_block / update_html_block', 'Raw HTML in one piece, or replace a block\'s code'],
  ['get_block_actions / resolve_block_action', 'Receive input people send from block controls, and answer it'],
  ['add_tab', 'Create a tab; every writing tool takes an optional tab'],
]);
write(ag, `
## HTTP API
For scripts in any language. Send the token as \`Authorization: Bearer lp_...\`. Add \`?tab=<id or title>\` to write into a tab.
`);
table(ag, [
  ['Method and path', 'What it does'],
  ['GET /api/pages', 'List your pages'],
  ['POST /api/pages', 'Create a page ({ "title" })'],
  ['GET /api/pages/<id>/content', 'Page as markdown, plus tabs and blocks'],
  ['POST /api/pages/<id>/paragraphs', 'Append a paragraph ({ "text" })'],
  ['POST /api/pages/<id>/headings', 'Append a heading'],
  ['POST /api/pages/<id>/tables', 'Append a table ({ "rows": [[...]] })'],
  ['POST /api/pages/<id>/mind-maps', 'Append a mind map'],
  ['POST /api/pages/<id>/ui', 'Append a custom UI block (css, html, js)'],
  ['POST/PUT /api/pages/<id>/html-blocks', 'Add or replace an HTML block'],
  ['POST /api/pages/<id>/tabs', 'Add a tab'],
  ['GET /api/pages/<id>/actions', 'Pending input from block controls'],
]);
write(ag, `
\`\`\`
curl -H "Authorization: Bearer lp_..." https://<your app>/api/pages/p_xxx/content
curl -X POST -H "Authorization: Bearer lp_..." -H "content-type: application/json" \\
  -d '{"rows":[["Planet","Moons"],["Mars","2"]]}' https://<your app>/api/pages/p_xxx/tables
\`\`\`
`);

// =====================================================================================
const ar = agent.addTab('Architecture');
write(ar, `
# Architecture
## Components
`);
table(ar, [
  ['Part', 'What it is', 'Code'],
  ['Web app', 'React 19 + TipTap 3 editor, Yjs collaboration, tabs, sharing screens', 'apps/web'],
  ['Server', 'Hocuspocus 4 live sync, HTTP API, hosted MCP, serves the web app; one origin', 'apps/server'],
  ['Sandbox', 'Separate-origin runner for HTML blocks with a strict CSP', 'apps/sandbox'],
  ['Schema', 'Shared page model used by the editor, the server and agents', 'packages/schema'],
  ['Agent', 'Live agent client, demo, MCP tools and the local MCP server', 'packages/agent'],
]);
write(ar, `
In production one server serves the web app, \`/api\`, live sync at \`/collab\` and \`/mcp\` on the same origin, so the session cookie also authenticates the WebSocket. In development Vite proxies the same paths.

## Document model
Each page is one Yjs document:
- One block tree per tab: \`default\` for the main tab, \`tab:<id>\` for the others.
- \`tabs\`: tab ids, titles and order. Empty means a single main tab.
- \`htmlCode\`: one live text per HTML block, so code is co-edited character by character.
- \`mindMaps\`: mind map nodes, edited node by node.
- \`actions\`: input people sent from block controls, waiting for an agent.
- \`meta\`: the page title.
One document per page means one sync connection, one permission check and one history, and agents read the whole page in one call.

## Storage
Postgres, hosted by default (Neon or Supabase), so nothing is lost if a machine or container dies. The server saves each page's Yjs state and also writes a \`blocks\` table (id, tab, position, type, text, attributes) that you can query with SQL. Other tables: users, sessions, pages, page_members, share_links and api_tokens. \`pnpm dev:memory\` swaps in an in-memory Postgres (PGlite) for quick tries.

## Security model for HTML blocks
- Blocks run in a sandboxed iframe served from a different site (on Render, \`*.onrender.com\` is on the Public Suffix List, so the app and the sandbox are different sites).
- The sandbox sends a strict CSP: no network requests, scripts only from trusted CDNs, and only the app may embed it.
- The app's own CSP only allows frames from the sandbox, and never lets itself be framed.
- Messages from a block are validated by the host before anything happens.
`);

// =====================================================================================
const rm = agent.addTab('Roadmap');
write(rm, `
# Roadmap
`);
table(rm, [
  ['Milestone', 'What', 'Status'],
  ['M0 Live demo', 'Two browsers and an agent edit one page live: caret, table, mind map, streamed custom UI, host bridge, tabs', 'Done'],
  ['M1 Accounts, sharing, hosting', 'Sign up, page list, roles, share links, agent tokens, Render + Neon deploy, Google sign-in', 'Done'],
  ['M2 Comments', 'Comment on a selection, threads, agents read and reply', 'Next'],
  ['M3 Writing quality', 'Slash menu, drag handles, drawing block, code editor, suggestions, version history', 'Planned'],
  ['M4 Databases and design', 'Collections with properties and views, read bridge for custom UI, design frames', 'Planned'],
  ['M5 Obsidian and integrations', 'Wikilinks, backlinks, markdown round-trip, Google Drive', 'Planned'],
]);
write(rm, `
## Open questions
1. **Name:** "Livepage" is a working name.
2. **Agent permissions:** should agents edit directly by default, or start in suggestion mode?
3. **Built-in AI:** keep the server model-free, or add an optional "Ask AI" button with your own key?
4. **Offline:** Yjs supports offline editing; is offline-first a goal for v1?
5. **OAuth for web chat apps:** let ChatGPT and claude.ai connect as MCP connectors.

Livepage is open source under the MIT license: https://github.com/jgbilla/livepage
`);

agent.useTab('main');
await new Promise((r) => setTimeout(r, 1500));
await agent.disconnect();
console.log(`[docs] done: ${base}/p/${pageId}`);
process.exit(0);
