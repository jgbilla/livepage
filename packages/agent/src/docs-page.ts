// Writes the Livepage documentation as a Livepage page: an Overview tab with a live
// architecture diagram and a feature mind map, then one tab per topic.
//
//   LIVEPAGE_URL=wss://<your app>/collab AGENT_TOKEN=lp_... pnpm agent:docs            # creates a new page
//   LIVEPAGE_URL=wss://<your app>/collab AGENT_TOKEN=lp_... pnpm agent:docs p_xxxx     # writes into an existing (empty) page
//   ... pnpm agent:docs p_xxxx --replace                                                # clears that page first, then rewrites it
// --replace keeps the page's comments and history (restore the old version from History if needed).
//
// This writes the whole page, so it is for a first version or a full restructure. To bring an existing documentation
// page up to date, change just the blocks or words that are out of date with the targeted edit tools (get_outline,
// read_blocks, replace_text, replace_blocks, insert_blocks, set_table_cell...) rather than running this again.
import * as Y from 'yjs';
import { fragment, listTabs, MAIN_TAB, META, removeTab, renameTab } from '@livepage/schema';
import { LiveAgent } from './client.ts';
import { httpBaseFor } from './tools.ts';

const wsUrl = process.env.LIVEPAGE_URL ?? 'ws://localhost:1234/collab';
const token = process.env.AGENT_TOKEN ?? 'dev-agent-token';
const base = httpBaseFor(wsUrl);
const TITLE = 'Livepage documentation';
// Examples use this app's real address, e.g. https://livepage.example.com/mcp
const HOST = new URL(base).host;

const replace = process.argv.includes('--replace');
let pageId = process.argv.slice(2).find((a) => !a.startsWith('--'));
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

if (replace) {
  doc.transact(() => {
    for (const t of listTabs(doc)) {
      const f = fragment(doc, t.id);
      if (f.length) f.delete(0, f.length);
      if (t.id !== MAIN_TAB) removeTab(doc, t.id);
    }
    for (const name of ['htmlCode', 'mindMaps', 'actions']) {
      const m = doc.getMap(name);
      for (const k of [...m.keys()]) m.delete(k);
    }
  });
}

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
- **Any AI:** ✦ Ask AI on every page with your own key (Claude, GPT, Gemini, OpenRouter or a local model), or connect your own agent over MCP or a plain HTTP API.
- **Comments:** on a selection, a block or the whole page, with replies, resolve and @mentions of people and agents.
- **Version history:** every saved version, who changed it, a word-level diff, and restore for everyone.
- **Sharing:** invite links with editor, commenter or viewer access, enforced on the server, or publish a public read-only page.
- **Organized like Obsidian:** your own folders in a sidebar, new pages filed in today's folder \`YYYY/MM/DD\` next to the daily page, tags, saved tag views, templates, and pages in tabs side by side.
- **Links:** type \`[[\` to link a page or one of its tabs. Links survive renames and moves, every page lists what links to it, and a graph view shows them all.
- **Search:** Cmd/Ctrl+K finds titles instantly and text in any block.
- **Markdown in and out:** import Markdown or an Obsidian vault, export a page as Markdown or PDF, or everything as a zip.
- **Installable:** add it to your home screen on phone, tablet or desktop; pages you've opened work offline.
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
    { text: 'Write', children: [{ text: 'Text, headings, lists' }, { text: 'Tables' }, { text: 'Mind maps' }, { text: 'Footnotes' }, { text: '/ menu' }, { text: 'Tabs' }] },
    { text: 'Build', children: [{ text: 'Custom UI blocks' }, { text: 'Streaming in order' }, { text: 'Host bridge (livepage.send)' }] },
    { text: 'Organize', children: [{ text: 'Folders and daily pages' }, { text: '[[Links]] and backlinks' }, { text: 'Graph view' }, { text: 'Tags and views' }, { text: 'Search' }, { text: 'Templates' }] },
    { text: 'Collaborate', children: [{ text: 'Live carets' }, { text: 'Comments and @mentions' }, { text: 'Version history' }, { text: 'Share links' }, { text: 'Roles' }] },
    { text: 'Agents', children: [{ text: 'Ask AI (your own key)' }, { text: 'Hosted MCP' }, { text: 'Local MCP' }, { text: 'HTTP API' }, { text: 'Task board' }, { text: 'Push: stream, webhooks, channel' }] },
    { text: 'Share', children: [{ text: 'Publish to the web' }, { text: 'Import Markdown / Obsidian' }, { text: 'Export Markdown, PDF, zip' }] },
    { text: 'Run it', children: [{ text: 'Render + Neon' }, { text: 'Docker' }, { text: 'Locally' }, { text: 'Install as an app' }] },
  ],
}, 'Livepage features');

write('main', `
## In this documentation
Each tab at the top goes into detail:
`);
table('main', [
  ['Tab', 'What it covers'],
  ['Getting started', 'Using the hosted app, running it locally, self-hosting with Docker, deploying to Render + Neon'],
  ['Editor and blocks', 'Every block type, the / menu, footnotes, custom UI streaming and the host bridge, tabs'],
  ['Organize and publish', 'Folders, daily pages, links and backlinks, graph, search, tags, templates, import, export and publishing'],
  ['Collaboration and sharing', 'Live editing, comments, version history, roles, share links and how access is enforced'],
  ['Accounts and sign-in', 'Email and password, Google via Neon Auth, sessions, agent tokens, security'],
  ['Connect agents', 'Ask AI, the task board, hosted MCP for any client, the local MCP server, push instead of polling, @mentions, the HTTP API and the full tool list'],
  ['Architecture', 'Components, the document model, storage, the sandbox security model, repo layout'],
  ['Roadmap', 'What is built, what comes next, and open questions'],
]);

// =====================================================================================
const gs = agent.addTab('Getting started');
write(gs, `
# Getting started
## Use the hosted app
1. Open your Livepage address (https://<your app>) and sign up with email and password, or with **Continue with Google** where it is enabled.
2. Click **+ New page**. It lands in today's folder (\`YYYY/MM/DD\`). Give it a title and start writing.
3. Click **Share** to invite people, press **✦ Ask AI** to work with an assistant, or create an **agent token** on your home page to let your own AI join.
4. Press **Today** in the sidebar for your daily page, and Cmd/Ctrl+K to search everything.
To install it as an app, use Share > Add to Home Screen in Safari, or the browser's Install button.
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
  ['SIGNUP_OPEN', 'App', 'Unset: only the first account can be created (one person per server). 1: anyone can sign up. 0: no sign-ups.'],
  ['NEON_AUTH_BASE_URL', 'App', 'Optional. Turns on "Continue with Google" through Neon Auth.'],
  ['AI_KEY_SECRET', 'App', 'Encrypts the Ask AI keys people save. Changing it makes saved keys unreadable (people paste them again).'],
  ['AI_ALLOW_PRIVATE_ENDPOINTS', 'App', 'Set to 1 to allow Ask AI endpoints on private addresses (Ollama, LM Studio). On in dev, off in production.'],
  ['PUBLIC_URL', 'App', 'Public address used in links sent to agents (mentions and webhooks). Render sets it automatically.'],
  ['WEBHOOK_ALLOW_PRIVATE', 'App', 'Set to 1 to let agent webhooks call private addresses in production.'],
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
  ['Table', 'Native', '/ menu > Table; cells are normal text', 'Built'],
  ['Mind map', 'Native', 'Click a node; Tab adds a child, Enter a sibling', 'Built'],
  ['Custom UI / HTML block', 'Sandboxed code', '"Edit code" to co-edit the source live', 'Built'],
  ['Page link', 'Inline', 'Type [[ and pick a page, add # for a tab', 'Built'],
  ['Footnote', 'Inline', '/ menu > Footnote, or Ctrl/Cmd+Alt+F after a selection', 'Built'],
  ['Drawing / whiteboard', 'Native', 'Shapes and arrows', 'Planned'],
  ['Design frame, images, files, database views', 'Native', '', 'Planned'],
]);
write(ed, `
## Inserting and formatting
Type \`/\` anywhere for the block menu: headings, lists, tables, mind maps, live HTML blocks, footnotes and page links. Select text for a small floating menu with bold, italic, link, comment, footnote and Ask AI. Footnotes are numbered in reading order and listed at the bottom of each tab.

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
const og = agent.addTab('Organize and publish');
write(og, `
# Organize and publish
## Folders and daily pages
The sidebar holds your own nested folders of pages, like an Obsidian vault: create, rename, drag to move and collapse them. **Today** opens \`YYYY/MM/DD/daily\` for your local date, creating it if it's missing.
New pages go in that day's folder too, from you or an agent, unless you start them inside a folder (its **+**) or an agent is given a folder path. Imports without a folder land there as well.

## Links, backlinks and the graph
- Type \`[[\` to search for a page and link it, add \`#\` to link one of its tabs, or paste a page link. Links point at ids, so they survive renames and moves.
- Every page lists the pages that link to it under "Linked from".
- **Graph view** (in the sidebar, or ◉ Graph on a page for the local graph around it) shows every page you can open and the links between them. Hover for neighbours, click to open, filter by title or #tag.

## Search
Cmd/Ctrl+K searches everything you can open. Titles match instantly, then full-text matches from any block (tables, mind maps and HTML code too) follow with a snippet. Enter opens the page at the right tab and highlights the words.

## Pages in tabs
Cmd/Ctrl-click or middle-click any page link to open it in a new tab, like Obsidian. Drag tabs to reorder, right-click to pin, close others or open side by side. Alt+1…9 jumps to a tab, Alt+T opens one and Alt+W closes it, and your tabs come back when you reload. (These are different from the tabs inside a page.)

## Tags and views
Tag pages, then save **views** in the sidebar that list the pages with any or all of some tags.

## Templates
Mark any page as a template from the ⋯ menu, start new pages from it in the sidebar, and pick one for your daily pages. \`{{date}}\`, \`{{title}}\`, \`{{yesterday}}\` and formats like \`{{date:MMMM D, YYYY}}\` fill in automatically. Any other \`{{Field}}\` stays highlighted for you or an agent to fill in.

## Import and export
Import Markdown files, a folder or an Obsidian vault (or a .zip): folders, frontmatter, \`#tags\`, \`[[links]]\` and \`[^1]\` footnotes come across. Export a page as Markdown or PDF, or everything as a zip you can open in Obsidian.

## Publish to the web
Publish a page to get a clean, public, read-only copy at \`/pub/<slug>\` that anyone can read without an account. Live HTML blocks keep running in the sandbox. Unpublish any time.
`);

// =====================================================================================
const co = agent.addTab('Collaboration and sharing');
write(co, `
# Collaboration and sharing
## Live editing
Every page is one shared document (Yjs) synced over a WebSocket. Edits from people and agents merge automatically, even when they type in the same paragraph at the same time. Each participant has a named caret, the presence bar shows who is on the page, and tab dots show who is on which tab.

## Comments
Select text and press **💬 Comment** (Ctrl/Cmd+Alt+M), click 💬 on a block, or use **Comment on the page**. Threads have replies and can be resolved. Type \`@\` to mention a person on the page or one of their agents: people see their mentions on the home page, and a mentioned agent gets the comment and answers in the thread (see Connect agents). Comments stay attached to their text while people and agents edit around it.

## Version history
History lists every saved version and who made it (a person, or an agent marked ✦), with a block-by-block diff down to the word. Restore any version and it comes back live for everyone. Agent edits always land in their own version, so they are easy to undo. Old versions are thinned out (all for 2 days, hourly to 30 days, then daily, at most 200 per page) and stored compressed.

## Roles
`);
table(co, [
  ['Role', 'Read', 'Comment', 'Edit', 'Share and manage members'],
  ['Owner', 'Yes', 'Yes', 'Yes', 'Yes'],
  ['Editor', 'Yes', 'Yes', 'Yes', 'No'],
  ['Commenter', 'Yes', 'Yes', 'No', 'No'],
  ['Viewer', 'Yes', 'No', 'No', 'No'],
]);
write(co, `
## Share links
1. Open a page and click **Share**.
2. Pick the access the link grants (editor, commenter or viewer) and click **Create link**.
3. Anyone who opens the link and signs in becomes a member with that role. A link never lowers someone's existing role.
The owner can turn links off, change members' roles or remove them at any time.

## Enforced on the server
Access isn't just hidden in the interface. Every live connection is authenticated and checked against the page's members. Viewers and commenters connect read-only (commenters can still comment), so the server drops any edit they send, even one forced from the browser's developer tools. People who aren't members see "Page not found, or you do not have access."
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
Livepage is model-agnostic: any AI can join a page, read it, and write text, tables, mind maps and custom UI live, with its own caret.

## Ask AI
Press **✦ Ask AI** on any page, or select text and pick Ask AI. Two ways to answer:
- **Built-in assistant:** bring your own key for Claude, GPT, Gemini, OpenRouter or any OpenAI-compatible or local model. Keys are stored encrypted, and the assistant edits the page live with its own caret.
- **Your own connected agent:** pick it in the panel's **Ask** menu, which shows whether it's online. The request goes to that agent (Claude Code, Cursor, Codex…), which works on the page with its own files, memory and tools and answers in the panel. Tell the agent *"Listen for Livepage requests and handle them"*.

Your pick is saved to your account (the same on every device) and also decides who answers **@AI** in your comments. The @ menu shows who will answer. If the agent you picked isn't listening and the built-in assistant is set up, the built-in assistant answers and says so; otherwise the comment waits for your agent.

Each page keeps your chat (only you see it), and it follows you to your other devices: ask on your laptop and watch the answer stream on your phone. An answer keeps going if you close the panel or your phone sleeps; **Stop** ends it.

To connect your own agent, create an agent token on your home page and use one of the setups below.

## Task board
**Tasks** in the sidebar is a board for handing jobs to your agents: give a task a title, some details and optionally a page, and pick which agent does it. The board shows each task as **Queued**, **Working**, **Needs you** or **Done** (failed and cancelled tasks sit with the finished ones), with the agent's latest note on the card. The agent gets the task the moment you hand it out, writes short notes as it goes, asks you a question when it is stuck (the task moves to Needs you, and the sidebar shows a count), and finishes with a summary. Pages it edits while working are listed on the task by themselves. Answer a question or write on a finished task and it goes back to the agent with the whole conversation. From a page, **··· → Hand to an agent** starts a task about that page. The board updates live on all your devices.

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

## Push instead of polling
A listening agent doesn't have to keep checking. Livepage pushes each piece of work to the agent the moment it arrives: Ask AI requests, tasks, answers on a task, and comments that mention it. Three ways to receive it:
- **Claude Code channel:** run the local MCP server with \`LIVEPAGE_CHANNEL=1\` and start Claude Code with the channel on. Work then appears in the session by itself, with no listening loop.
- **Event stream:** \`GET /api/agent-events\` with the agent token is a Server-Sent Events stream, for any script or runner.
- **Webhook:** **Add webhook** on an agent token, and Livepage POSTs each event there (see below).
\`\`\`
claude mcp add livepage -e LIVEPAGE_CHANNEL=1 -e LIVEPAGE_URL=wss://<your app>/collab -e AGENT_TOKEN=lp_... -- pnpm --silent --dir /path/to/livepage agent:mcp
claude --dangerously-load-development-channels server:livepage
\`\`\`
A push says what the work is; the agent still takes it with \`wait_for_requests\`, which confirms it has it. Work nobody confirms goes back in the queue, so a missed push loses nothing, and polling keeps working for clients without push.

## MCP tools
`);
table(ag, [
  ['Tool', 'What it does'],
  ['list_pages', 'Pages the token can open, with folder path, tags and your role; filter by path or tags'],
  ['list_folders / create_folder', 'Your folder tree; create a path like Projects/Book'],
  ['create_page / move_page / rename_page', 'Create a page (in today\'s YYYY/MM/DD folder unless given a path) with tags, move it, rename it'],
  ['open_daily_page', 'Get or create the daily page at YYYY/MM/DD/daily'],
  ['set_page_tags / list_tags / create_view', 'Tag pages, list tags, save a sidebar view of pages by tag'],
  ['get_backlinks', 'Pages and tabs that link to a page'],
  ['search_pages', 'Full-text search across every page you can open, with snippets'],
  ['get_link_graph', 'Every page you can open and the links between them'],
  ['read_page', 'The whole page as markdown, every tab, with node and footnote ids'],
  ['get_outline', 'Just the structure: tabs and headings with block ids and section sizes'],
  ['read_blocks', 'Blocks with their ids: the whole page, one tab, one section or a window from a block'],
  ['replace_text', 'Find and replace words in place; formatting, links and footnotes stay'],
  ['replace_blocks', 'Rewrite one block or a run of blocks (a section) with Markdown'],
  ['insert_blocks', 'New Markdown before or after a block, or at the start or end of a tab'],
  ['delete_blocks / move_blocks', 'Remove or reorder a block or a run of blocks, also across tabs'],
  ['set_table_cell / add_table_row / delete_table_row', 'Change a table without resending it'],
  ['write_paragraph / add_heading', 'Append text; paragraphs are typed out live. Link with [[p_id]] or [[p_id#tab_id]]'],
  ['insert_table', 'A native, editable table'],
  ['insert_mind_map / add_mind_map_node', 'A native mind map, then grow it node by node'],
  ['insert_custom_ui', 'A sandboxed block streamed as height and placeholders, CSS, HTML, then JS'],
  ['insert_html_block / update_html_block', 'Raw HTML in one piece, or replace a block\'s code'],
  ['get_block_actions / resolve_block_action', 'Receive input people send from block controls, and answer it'],
  ['add_tab', 'Create a tab; every writing tool takes an optional tab'],
  ['add_footnote / update_footnote / remove_footnote', 'Footnotes on a quote in the page'],
  ['get_mentions / dismiss_mention', 'Comments that @mention this agent (waits up to 60s for a new one)'],
  ['list_comments / add_comment / reply_to_comment / resolve_comment', 'Read, start, answer and resolve comment threads'],
  ['list_templates / set_template / get_template_fields / fill_template_fields', 'Templates and their {{Field}}s'],
  ['import_markdown / export_markdown', 'Markdown in and out'],
  ['publish_page / unpublish_page', 'A public read-only copy at /pub/<slug>'],
  ['wait_for_requests / reply_to_request', 'Ask AI requests and board tasks sent to this agent (plus comments that mention it, or @AI when it is your pick), and the answer shown in the panel'],
  ['list_tasks / get_task / update_task', 'Tasks from the board: read one with its conversation, post notes, ask (needs_you), finish (done or failed)'],
]);
write(ag, `
### Small edits, not rewrites
An agent never has to rewrite a page to change it. Every block has a stable id that stays valid while people and agents edit around it. To fix a sentence, an agent calls \`replace_text\`. To redo a section, it calls \`get_outline\`, reads that section with \`read_blocks\`, and sends new Markdown for those blocks with \`replace_blocks\`. Everything else on the page is left alone, so the edit costs a fraction of the tokens, comments on the rest of the page stay put, and History shows exactly what changed.

## HTTP API
For scripts in any language. Send the token as \`Authorization: Bearer lp_...\`. Add \`?tab=<id or title>\` to write into a tab.
`);
table(ag, [
  ['Method and path', 'What it does'],
  ['GET /api/pages', 'List your pages'],
  ['POST /api/pages', 'Create a page ({ "title", "path"? }); no path = today\'s YYYY/MM/DD folder'],
  ['GET /api/pages/<id>/content', 'Page as markdown, plus tabs and blocks'],
  ['GET /api/pages/<id>/outline', 'Tabs and headings with block ids and section sizes'],
  ['GET /api/pages/<id>/blocks', 'Blocks with ids and Markdown (?section=<heading id>, ?from=<block id>, ?limit=)'],
  ['POST /api/pages/<id>/blocks', 'Insert Markdown ({ "markdown", "before" or "after": block id })'],
  ['PUT /api/pages/<id>/blocks/<block id>', 'Replace a block, or a run with { "through": block id }'],
  ['DELETE /api/pages/<id>/blocks/<block id>', 'Delete a block, or a run with ?through=<block id>'],
  ['POST /api/pages/<id>/move', 'Move blocks ({ "block_id", "through", "before" or "after" })'],
  ['POST /api/pages/<id>/replace-text', 'Find and replace in place ({ "find", "replace", "all" })'],
  ['PATCH /api/pages/<id>/tables/<block id>', 'Table edits ({ "op": "set_cell", "row", "column", "text" }, "add_row", "delete_row")'],
  ['POST /api/pages/<id>/paragraphs', 'Append a paragraph ({ "text" })'],
  ['POST /api/pages/<id>/headings', 'Append a heading'],
  ['POST /api/pages/<id>/tables', 'Append a table ({ "rows": [[...]] })'],
  ['POST /api/pages/<id>/mind-maps', 'Append a mind map'],
  ['POST /api/pages/<id>/ui', 'Append a custom UI block (css, html, js)'],
  ['POST/PUT /api/pages/<id>/html-blocks', 'Add or replace an HTML block'],
  ['POST /api/pages/<id>/tabs', 'Add a tab'],
  ['GET /api/pages/<id>/actions', 'Pending input from block controls'],
  ['POST /api/daily', 'Open or create a daily page ({ "date"? }, default the person\'s today)'],
  ['GET /api/mentions?wait=30', 'Long-poll for comments that @mention this agent'],
  ['POST /api/pages/<id>/comments', 'Comment on the page ({ "body", "quote" })'],
  ['POST /api/pages/<id>/comments/<thread id>', 'Reply in a thread ({ "body" }); replying marks the mention handled'],
  ['GET /api/agent-requests?wait=20', 'Ask AI requests, comment mentions and board tasks for this agent'],
  ['GET /api/agent-events', 'Server-Sent Events: work pushed to this agent as it arrives'],
  ['GET /api/tasks', 'Tasks assigned to this agent (?all=1 includes finished ones)'],
  ['POST /api/tasks/<id>/ack', 'Confirm you took a task (it moves to Working)'],
  ['POST /api/tasks/<id>/update', 'Report ({ "status": "working" | "needs_you" | "done" | "failed", "note", "pages" }); returns anything the person wrote since'],
  ['POST /api/agent-requests/<id>/reply', 'Answer in the Ask panel ({ "text", "done" }); done: false posts a progress note'],
  ['GET /api/pages/<id>/versions', 'Version history; add /<version id>?compare=previous|current for a diff'],
  ['POST /api/pages/<id>/versions/<version id>/restore', 'Restore a version live for everyone'],
]);
write(ag, `
\`\`\`
curl -H "Authorization: Bearer lp_..." https://<your app>/api/pages/p_xxx/content
curl -X POST -H "Authorization: Bearer lp_..." -H "content-type: application/json" \\
  -d '{"rows":[["Planet","Moons"],["Mars","2"]]}' https://<your app>/api/pages/p_xxx/tables
\`\`\`

## @mentions and webhooks
When someone mentions an agent in a comment, the agent finds out by MCP (\`get_mentions\`), HTTP (\`GET /api/mentions?wait=30\`), its event stream or a webhook. On the home page, **Add webhook** on an agent token: Livepage POSTs each event for that agent to the URL right away (\`request.created\`, \`task.assigned\`, \`task.message\`, \`task.cancelled\` and \`comment.mention\`, named in \`x-livepage-event\`, with a \`text\` summary and the ids and links to act on), retrying a few times if it fails, signed with \`x-livepage-signature: sha256=HMAC_SHA256(secret, x-livepage-timestamp + "." + body)\`. Use it to start an agent run from a GitHub Action, a serverless function or an Agent SDK script. Agents write mentions as \`@[Name](user:<id>)\` or \`@[Name](agent:<id>)\`.
`);

// =====================================================================================
const ar = agent.addTab('Architecture');
write(ar, `
# Architecture
## Components
`);
table(ar, [
  ['Part', 'What it is', 'Code'],
  ['Web app', 'React 19 + TipTap 3 editor, Yjs collaboration, sidebar, search, graph, comments, history, Ask AI; installable and offline-capable', 'apps/web'],
  ['Server', 'Hocuspocus 4 live sync, HTTP API, hosted MCP, versions, mentions and webhooks, Ask AI, publishing; serves the web app on one origin', 'apps/server'],
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
- \`comments\`: where each comment is anchored (Yjs relative positions, so anchors follow the text).
- \`meta\`: the page title.
One document per page means one sync connection, one permission check and one history, and agents read the whole page in one call.

## Storage
Postgres, hosted by default (Neon or Supabase), so nothing is lost if a machine or container dies. The server saves each page's Yjs state and also writes a \`blocks\` table (id, tab, position, type, text, attributes) that you can query with SQL. Other tables: users, sessions, pages, page_members, share_links, api_tokens, folders, page_tags, views, page_links, comments, comment_mentions, page_versions, agent_requests and ai_settings. \`pnpm dev:memory\` swaps in an in-memory Postgres (PGlite) for quick tries.

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
  ['M2 Comments', 'Comments on a selection, block or page, threads, resolve, @mentions; agents answer by MCP, HTTP or webhook', 'Done'],
  ['Ask AI', 'Built-in assistant with your own key, or send the request to your own connected agent', 'Done'],
  ['M3 Writing quality', 'Done: / menu, selection menu, footnotes, version history. Next: drag handles, drawing block, code editor, suggestions', 'In progress'],
  ['M4 Databases and design', 'Done: tags and saved views. Next: collections with properties, read bridge for custom UI, design frames', 'In progress'],
  ['M5 Obsidian and integrations', 'Done: folders, daily pages, templates, wikilinks, backlinks, graph, search, Markdown and Obsidian import/export, publishing. Next: Google Drive', 'Mostly done'],
]);
write(rm, `
## Open questions
1. **Name:** "Livepage" is a working name.
2. **Agent permissions:** should agents edit directly by default, or start in suggestion mode?
3. **Offline:** pages you've opened already work offline in the installed app; should offline-first editing go further?
4. **Native apps:** is an App Store build worth it on top of the installable web app?
5. **OAuth for web chat apps:** let ChatGPT and claude.ai connect as MCP connectors.

Livepage is open source under the MIT license: https://github.com/jgbilla/livepage
`);

agent.useTab('main');
await new Promise((r) => setTimeout(r, 1500));
await agent.disconnect();
console.log(`[docs] done: ${base}/p/${pageId}`);
process.exit(0);
