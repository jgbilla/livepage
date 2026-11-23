// The Livepage MCP tools, shared by the local stdio server (mcp.ts) and the hosted
// endpoint (https://<your app>/mcp, see apps/server/src/mcp-http.ts).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { LiveAgent } from './client.ts';

export type LivepageMcpOptions = {
  /** WebSocket URL of the collab server, e.g. wss://app.example.com/collab */
  wsUrl: string;
  /** Agent token (lp_...) the agent acts as. */
  token: string;
  /** Name shown on the agent's avatar and caret. A generic one ("Agent") gives way to the MCP client's own name. */
  agentName?: string;
  /** Stable id for this agent (its token id), so several agents on a page stay apart. */
  agentId?: string;
};

const GENERIC_NAME = /^\s*(agent|ai|assistant|bot|mcp|token|default|livepage)?\s*$/i;
const KNOWN_CLIENTS: [RegExp, string][] = [
  [/^claude[-_ ]?code/i, 'Claude Code'], [/^claude[-_ ]?(ai|desktop)?$/i, 'Claude'], [/^cursor/i, 'Cursor'],
  [/^codex/i, 'Codex'], [/^gemini/i, 'Gemini CLI'], [/visual studio code|^vscode/i, 'VS Code'], [/^windsurf/i, 'Windsurf'],
  [/^zed/i, 'Zed'], [/^cline/i, 'Cline'], [/^goose/i, 'Goose'], [/^chatgpt|^openai/i, 'ChatGPT'],
];

/** A readable name from an MCP client's clientInfo.name: "claude-code" -> "Claude Code". */
export function clientDisplayName(raw: string | undefined): string | undefined {
  const name = (raw ?? '').trim();
  if (!name) return undefined;
  for (const [re, label] of KNOWN_CLIENTS) if (re.test(name)) return label;
  const words = name.replace(/[-_]+/g, ' ').replace(/\b(mcp|client)\b/gi, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return undefined;
  return words.map((w) => (w === w.toLowerCase() ? w[0].toUpperCase() + w.slice(1) : w)).join(' ').slice(0, 40);
}

/** The name an agent shows on the page: its token's name, unless that says nothing (then its MCP client's). */
export function agentDisplayName(tokenName: string | undefined, clientName: string | undefined): string {
  if (tokenName && !GENERIC_NAME.test(tokenName)) return tokenName;
  return clientDisplayName(clientName) ?? (tokenName?.trim() || 'Agent');
}

/** HTTP base of the app for a collab WebSocket URL: wss://host/collab -> https://host */
export const httpBaseFor = (wsUrl: string) => wsUrl.replace(/^ws/, 'http').replace(/\/collab\/?$/, '');

export function createLivepageMcp(opts: LivepageMcpOptions): { server: McpServer; close: () => Promise<void> } {
  const httpBase = httpBaseFor(opts.wsUrl);
  const agents = new Map<string, Promise<LiveAgent>>();
  async function agentFor(page: string, tab?: string) {
    let a = agents.get(page);
    if (!a) {
      // Named when it first joins a page; by then the client has introduced itself (initialize).
      const name = agentDisplayName(opts.agentName, server.server.getClientVersion()?.name);
      a = LiveAgent.connect({ page, url: opts.wsUrl, token: opts.token, name, id: opts.agentId });
      agents.set(page, a);
      a.catch(() => agents.delete(page));
    }
    return (await a).useTab(tab);
  }
  const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
  const page = z.string().regex(/^p_[\w-]{8,40}$/).describe('Page id, from the app URL: /p/<page id>');
  const tab = z.string().optional().describe('Tab id or title to write in (see read_page). Omit for the main tab.');

  const server = new McpServer(
    { name: 'livepage', version: '0.0.3' },
    {
      instructions: `You are a collaborator on a live Livepage page, next to the people editing it.
Pick the lightest block that does the job:
- Plain writing: write_paragraph / add_heading.
- Tabular data: insert_table (a native, editable table). Do not build tables in HTML.
- Ideas and structure: insert_mind_map, then add_mind_map_node to grow it.
- Only when it needs motion, drawing or interaction: insert_custom_ui. Give css, html and js separately;
  they stream in that order so people see the block take shape. Controls that only change the view should
  run locally in js. To get input back from people, call livepage.send('action_name', {values}) from js,
  then poll get_block_actions and answer each with resolve_block_action.
  Style custom UI with the Livepage design tokens so it matches the page in light and dark: var(--lp-text), var(--lp-text-secondary), var(--lp-surface), var(--lp-border), var(--lp-accent), var(--lp-radius-lg), var(--lp-space-4), var(--lp-font-sans), var(--lp-shadow-2), and var(--lp-cat-1) to var(--lp-cat-8) for chart series; the block background is transparent over the page.
Cite sources with footnotes: write the sentence first, then add_footnote with after_text set to the words the
citation belongs to, plus url, title and author. Footnotes number themselves and list at the bottom of the tab.
Pages can have tabs (shown at the top). Writing tools take an optional tab; add_tab creates one.
Pages live in folders in each person's sidebar (like Obsidian) and can have tags. list_pages shows folder paths and tags;
create_page, move_page, set_page_tags and open_daily_page (folder YYYY/MM/DD, page "daily") organize them.
Link pages and tabs inside write_paragraph text with [[p_id]] or [[p_id#tab_id]]; the link shows the target's current title
and survives renames and moves. read_page shows links the same way; get_backlinks lists pages that link to a page.
search_pages finds pages by any words in them; get_link_graph shows how pages link together.
Use list_pages or search_pages to find page ids, and call read_page first to see what is there.
Templates: any page can be a template (list_templates). create_page with template starts a page as a copy of one, with
{{date}}, {{title}} and similar filled in; other {{Fields}} are left for you: get_template_fields, then fill_template_fields.
open_daily_page uses the person's daily template when they set one.
import_markdown creates a page from Markdown (Obsidian [[links]], #tags, frontmatter and [^1] footnotes work); export_markdown
gives a page as a Markdown file. publish_page puts a page on the public web (owner only), and unpublish_page takes it down.
People can also ask you from the Ask AI panel inside Livepage. When asked to listen for Livepage requests, loop on
wait_for_requests: for each request, work on its page (read_page first; use its tab), using your own context and tools
as needed, then answer with reply_to_request. Send short progress with reply_to_request(done=false) on long tasks.
People comment on text, blocks or the whole page and can @mention you. Check get_mentions, read the thread
(list_comments) and the page, then answer with reply_to_comment and make any edit they asked for.`,

    },
  );

  server.tool('read_page', 'Read the whole page as markdown. Tables are markdown tables, mind maps are outlines with node ids, HTML blocks show their code, footnotes are [^n] with definitions (and ids) at the end of each tab.',
    { page }, async ({ page: p }) => text((await agentFor(p)).read() || '(empty page)'));

  async function http<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${httpBase}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${opts.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as any).error ?? `${res.status}`);
    return data as T;
  }
  const tryText = async (fn: () => Promise<string>) => { try { return text(await fn()); } catch (e) { return text(`error: ${(e as Error).message}`); } };
  const folderPath = z.string().describe('Folder path like "Projects/Book" (folders are created if missing). "" means the top level.');
  type PageRow = { id: string; title: string; role?: string; path?: string; tags?: string[] };
  const pageLine = (p: PageRow) =>
    `${p.id}  ${p.path ? `${p.path}/` : ''}${p.title || 'Untitled'}${p.tags?.length ? `  ${p.tags.map((t) => `#${t}`).join(' ')}` : ''}${p.role && p.role !== 'owner' ? `  (${p.role})` : ''}`;

  type AgentReq = { id: string; page_id: string; page_title: string; tab: string; prompt: string; selection: string; history?: { role: string; text: string }[] };
  server.tool('wait_for_requests',
    'Wait for requests people send you from the Ask AI panel in Livepage (up to wait_seconds), and claim them. Each has a page, tab, the person\'s prompt, any text they had selected, and earlier chat turns. Call it in a loop when asked to listen.',
    { wait_seconds: z.number().min(0).max(30).default(25) },
    async ({ wait_seconds }) => tryText(async () => {
      const { requests } = await http<{ requests: AgentReq[] }>('GET', `/agent-requests?wait=${wait_seconds}`);
      if (!requests.length) return 'no requests yet; call wait_for_requests again to keep listening';
      return requests.map((r) => [
        `request ${r.id}`,
        `page: ${r.page_id} (${r.page_title || 'Untitled'})${r.tab && r.tab !== 'main' ? `, tab ${r.tab}` : ''}`,
        r.history?.length ? `earlier in this chat:\n${r.history.map((h) => `  ${h.role}: ${h.text}`).join('\n')}` : '',
        r.selection ? `selected text:\n${r.selection}` : '',
        `asks: ${r.prompt}`,
      ].filter(Boolean).join('\n')).join('\n\n---\n\n');
    }));

  server.tool('reply_to_request',
    'Answer a request from the Ask AI panel. The text shows in the person\'s chat. Use done=false for a short progress note while you are still working; done=true (default) finishes it.',
    { request_id: z.string().regex(/^ar_[\w-]+$/), text: z.string(), done: z.boolean().default(true) },
    async ({ request_id, text: t, done }) => tryText(async () => { await http('POST', `/agent-requests/${request_id}/reply`, { text: t, done }); return 'ok'; }));

  server.tool('list_pages',
    'List the pages this agent token can open: id, folder path/title, tags, and your role if not owner. Optionally only one folder (path) or pages with some tags.',
    {
      path: z.string().optional().describe('Only pages directly in this folder, e.g. "2026/11/23". "" = top level.'),
      tags: z.array(z.string()).optional().describe('Only pages with these tags (a tag also matches nested tags like book/notes).'),
      match: z.enum(['any', 'all']).default('any'),
    },
    async ({ path, tags, match }) => tryText(async () => {
      const qs = new URLSearchParams();
      if (path !== undefined) qs.set('path', path);
      tags?.forEach((t) => qs.append('tag', t));
      if (tags?.length) qs.set('match', match);
      const { pages } = await http<{ pages: PageRow[] }>('GET', `/pages${qs.size ? `?${qs}` : ''}`);
      return pages.map(pageLine).join('\n') || 'no pages';
    }));

  server.tool('list_folders', 'List your folders (each person has their own folder tree, like an Obsidian vault).', {},
    async () => tryText(async () => {
      const { folders } = await http<{ folders: { path: string }[] }>('GET', '/folders');
      return folders.map((f) => f.path).sort().join('\n') || 'no folders';
    }));

  server.tool('create_folder', 'Create a folder path (like mkdir -p).', { path: folderPath },
    async ({ path }) => tryText(async () => `created ${(await http('POST', '/folders', { path })).folder.path}`));

  server.tool('create_page', 'Create a page, optionally in a folder path, with tags, or from a template (ids from list_templates). Returns the page id, and any {{fields}} left to fill in.',
    {
      title: z.string().optional().describe('Omit with a template to use the template title (its {{date}} etc. filled in).'),
      path: folderPath.optional(), tags: z.array(z.string()).optional(),
      template: z.string().regex(/^p_[\w-]{8,40}$/).optional().describe('Template page id'),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Date for {{date}} in the template (the person\'s local date). Defaults to today.'),
    },
    async ({ title, path, tags, template, date }) => tryText(async () => {
      const r = await http('POST', '/pages', { title: title ?? (template ? undefined : ''), path: path || undefined, tags, template_id: template, date });
      if (!template) return `created ${r.page.id}`;
      const { fields } = await http<{ fields: string[] }>('GET', `/pages/${r.page.id}/fields`);
      return `created ${r.page.id}  "${r.page.title}"${fields.length ? `\nfields to fill in: ${fields.map((f) => `{{${f}}}`).join(', ')}` : ''}`;
    }));

  server.tool('list_templates', 'List the templates you can use (pages marked as templates), and which one daily pages start from.', {},
    async () => tryText(async () => {
      const { templates, daily_template_id } = await http<{ templates: PageRow[]; daily_template_id: string | null }>('GET', '/templates');
      return templates.map((t) => `${t.id}  ${t.title || 'Untitled'}${t.id === daily_template_id ? '  (daily pages)' : ''}`).join('\n') || 'no templates';
    }));

  server.tool('set_template', 'Mark a page as a template (or not). Use {{date}}, {{time}}, {{title}}, {{yesterday}}, {{tomorrow}}, {{weekday}} or {{date:MMMM D, YYYY}} for values filled in automatically, and any other {{Name}} for a field to fill in later.',
    { page, template: z.boolean().default(true), daily: z.boolean().optional().describe('Also make it (or stop it being) the template for new daily pages') },
    async ({ page: p, template, daily }) => tryText(async () => {
      await http('PATCH', `/pages/${p}`, { template });
      if (daily !== undefined) await http('PUT', '/templates/daily', { page_id: daily && template ? p : null });
      return 'ok';
    }));

  server.tool('get_template_fields', 'List the {{fields}} still waiting to be filled in on a page made from a template.', { page },
    async ({ page: p }) => tryText(async () => (await http<{ fields: string[] }>('GET', `/pages/${p}/fields`)).fields.map((f) => `{{${f}}}`).join('\n') || 'no fields left'));

  server.tool('fill_template_fields', 'Fill in {{fields}} on a page: { "Field name": "text" }. Names match without caring about case.',
    { page, fields: z.record(z.string(), z.string()) },
    async ({ page: p, fields }) => tryText(async () => {
      const r = await http<{ filled: number; fields: string[] }>('POST', `/pages/${p}/fields`, { fields });
      return `filled ${r.filled}${r.fields.length ? `; still open: ${r.fields.map((f) => `{{${f}}}`).join(', ')}` : ''}`;
    }));

  server.tool('import_markdown', 'Create a page from Markdown. Frontmatter title/tags, #tags, [[Page title]] links to your pages, [^1] footnotes, tables and ```livepage-html blocks are understood.',
    { markdown: z.string(), title: z.string().optional().describe('Defaults to the frontmatter title or "Imported"'), path: folderPath.optional() },
    async ({ markdown, title, path }) => tryText(async () => {
      const name = `${(title || 'Imported').replace(/[\\/]/g, '-')}.md`;
      const r = await http<{ pages: { id: string; title: string }[]; unresolved: string[] }>('POST', '/import', { files: [{ path: name, content: markdown }], into: path || undefined });
      return `created ${r.pages[0]?.id}${r.unresolved.length ? `\nlinks not found: ${r.unresolved.join(', ')}` : ''}`;
    }));

  server.tool('export_markdown', 'Get a page as a Markdown file (frontmatter, [[links]] by title, footnotes as [^1]).', { page },
    async ({ page: p }) => tryText(async () => {
      const res = await fetch(`${httpBase}/api/pages/${p}/export?format=md`, { headers: { authorization: `Bearer ${opts.token}` } });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as any).error ?? String(res.status));
      return res.text();
    }));

  server.tool('publish_page', 'Publish a page to the public web (anyone with the link can read it, live HTML blocks included). Owner only. Returns the public URL.',
    { page }, async ({ page: p }) => tryText(async () => `${httpBase}${(await http('POST', `/pages/${p}/publish`)).url}`));

  server.tool('unpublish_page', 'Take a published page off the public web.', { page },
    async ({ page: p }) => tryText(async () => { await http('DELETE', `/pages/${p}/publish`); return 'unpublished'; }));

  server.tool('open_daily_page',
    'Get (or create) the daily page for a date: folder YYYY/MM/DD, page titled "daily". Returns the page id to write into.',
    { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD. Pass the person\'s local date when you know it; defaults to today where this MCP server runs.') },
    async ({ date }) => tryText(async () => {
      const d = new Date();
      const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const r = await http('POST', '/daily', { date: date ?? today });
      return `${r.created ? 'created' : 'opened'} ${r.page.id}  ${r.page.path}/daily`;
    }));

  server.tool('move_page', 'Move a page to a folder path in your tree ("" = top level). Only changes your own sidebar.',
    { page, path: folderPath },
    async ({ page: p, path }) => tryText(async () => { await http('PATCH', `/pages/${p}`, path ? { path } : { folder_id: null }); return 'ok'; }));

  server.tool('rename_page', 'Change a page title.', { page, title: z.string() },
    async ({ page: p, title }) => tryText(async () => { await http('PATCH', `/pages/${p}`, { title }); return 'ok'; }));

  server.tool('set_page_tags', 'Replace the tags on a page (everyone with access sees them). Tags are lowercased; spaces become -.',
    { page, tags: z.array(z.string()) },
    async ({ page: p, tags }) => tryText(async () => `tags: ${(await http('PUT', `/pages/${p}/tags`, { tags })).tags.join(', ') || '(none)'}`));

  server.tool('list_tags', 'List tags on pages you can open, with counts, plus your saved tag views.', {},
    async () => tryText(async () => {
      const [{ tags }, { views }] = await Promise.all([http('GET', '/tags'), http('GET', '/views')]);
      const t = (tags as { tag: string; count: number }[]).map((x) => `#${x.tag} (${x.count})`).join('\n') || 'no tags';
      const v = (views as { name: string; tags: string[]; match: string }[]).map((x) => `${x.name}: ${x.match} of ${x.tags.map((y) => `#${y}`).join(' ')}`).join('\n');
      return v ? `${t}\n\nViews:\n${v}` : t;
    }));

  server.tool('create_view', 'Save a view in the sidebar: a named list of the pages that have any (or all) of some tags.',
    { name: z.string(), tags: z.array(z.string()).min(1), match: z.enum(['any', 'all']).default('any') },
    async ({ name, tags, match }) => tryText(async () => `created view ${(await http('POST', '/views', { name, tags, match })).view.id}`));

  server.tool('get_backlinks', 'List the pages (and tabs) that link to a page.', { page },
    async ({ page: p }) => tryText(async () => {
      const { backlinks } = await http<{ backlinks: { page: string; title: string; from_tab: string; from_tab_title: string; to_tab: string | null }[] }>('GET', `/pages/${p}/backlinks`);
      return backlinks.map((b) => `${b.page}${b.from_tab !== 'main' ? `#${b.from_tab}` : ''}  ${b.title || 'Untitled'}${b.from_tab_title ? ` › ${b.from_tab_title}` : ''}${b.to_tab ? `  (links to tab ${b.to_tab})` : ''}`).join('\n') || 'no backlinks';
    }));

  server.tool('search_pages',
    'Full-text search across every page this agent token can open: titles, tags and the text of all blocks (also tables, mind maps and HTML code). Every word must appear. Returns page ids with a snippet and the tab of the first match.',
    { query: z.string().min(1), limit: z.number().int().min(1).max(50).default(20) },
    async ({ query, limit }) => tryText(async () => {
      const { results } = await http<{ results: { id: string; title: string; tags: string[]; tab: string | null; snippet: string }[] }>(
        'GET', `/search?q=${encodeURIComponent(query)}&limit=${limit}`);
      return results.map((r) => `${r.id}${r.tab && r.tab !== 'main' ? `#${r.tab}` : ''}  ${r.title || 'Untitled'}${r.tags.length ? `  ${r.tags.map((t) => `#${t}`).join(' ')}` : ''}${r.snippet ? `\n    ${r.snippet}` : ''}`).join('\n') || 'no matches';
    }));

  server.tool('get_link_graph',
    'The graph of links between the pages this agent token can open: every page (id, title, tags) and every link "from -> to". Use it to find hubs, orphans and related pages.',
    {}, async () => tryText(async () => {
      const { nodes, edges } = await http<{ nodes: { id: string; title: string; tags: string[]; links: number }[]; edges: { source: string; target: string; count: number }[] }>('GET', '/graph');
      const pages = nodes.map((n) => `${n.id}  ${n.title || 'Untitled'}${n.tags.length ? `  ${n.tags.map((t) => `#${t}`).join(' ')}` : ''}  (${n.links} links)`);
      const links = edges.map((e) => `${e.source} -> ${e.target}${e.count > 1 ? ` (x${e.count})` : ''}`);
      return `pages (${nodes.length}):\n${pages.join('\n')}\n\nlinks (${edges.length}):\n${links.join('\n') || 'none'}`;
    }));

  server.tool('add_tab', 'Add a tab to the page (tabs show at the top; each tab is its own scrolling document). Returns the tab id.',
    { page, title: z.string() }, async ({ page: p, title }) => text(`added tab ${(await agentFor(p)).addTab(title)}`));

  server.tool('write_paragraph', 'Append a paragraph to the page. It is typed out live so collaborators see it appear. Link to a page or tab with [[p_id]], [[p_id#tab_id]] or [[p_id|label]] (ids from list_pages and read_page).',
    { page, tab, text: z.string() }, async ({ page: p, tab: tb, text: t }) => { await (await agentFor(p, tb)).typeParagraph(t, 80); return text('ok'); });

  server.tool('add_heading', 'Append a heading.',
    { page, tab, text: z.string(), level: z.number().int().min(1).max(3).default(2) },
    async ({ page: p, tab: tb, text: t, level }) => { (await agentFor(p, tb)).addHeading(t, level); return text('ok'); });

  server.tool('insert_table', 'Append a native table (editable by everyone). First row is the header.',
    { page, tab, rows: z.array(z.array(z.string())).min(1) },
    async ({ page: p, tab: tb, rows }) => { (await agentFor(p, tb)).addTable(rows); return text('ok'); });

  const cite = {
    note: z.string().max(4000).optional().describe('Footnote text, e.g. a remark or a quote. Optional when it is only a citation.'),
    url: z.string().max(2048).optional().describe('Source link (http/https).'),
    title: z.string().max(500).optional().describe('Source title.'),
    author: z.string().max(500).optional().describe('Source author(s) or publisher.'),
  };

  server.tool('add_footnote',
    'Add a footnote (the way to cite a source). The marker goes right after after_text, matched exactly in the tab; omit after_text to put it at the end of the last paragraph. Returns the footnote id and number.',
    {
      page, tab,
      after_text: z.string().max(500).optional().describe('Exact words in the page the footnote follows, e.g. the end of the cited sentence.'),
      last: z.boolean().default(false).describe('Use the last match of after_text instead of the first.'),
      ...cite,
    },
    async ({ page: p, tab: tb, after_text, last, ...c }) => {
      const r = (await agentFor(p, tb)).addFootnote({ ...c, afterText: after_text, last });
      return text(`added footnote ${r.n} (${r.id})`);
    });

  server.tool('update_footnote', 'Change a footnote\'s text or citation (ids come from read_page). Fields left out stay as they are.',
    { page, footnote_id: z.string(), ...cite },
    async ({ page: p, footnote_id, ...c }) => { (await agentFor(p)).editFootnote(footnote_id, c); return text('ok'); });

  server.tool('remove_footnote', 'Delete a footnote and its marker.',
    { page, footnote_id: z.string() },
    async ({ page: p, footnote_id }) => { (await agentFor(p)).removeFootnote(footnote_id); return text('ok'); });

  type Tree = { text: string; children?: Tree[] };
  const tree: z.ZodType<Tree> = z.lazy(() => z.object({ text: z.string(), children: z.array(tree).optional() }));

  server.tool('insert_mind_map', 'Append a native mind map (editable by everyone). Returns the block id.',
    { page, tab, root: tree, title: z.string().optional() },
    async ({ page: p, tab: tb, root, title }) => text(`inserted ${(await agentFor(p, tb)).addMindMap(root, title)}`));

  server.tool('add_mind_map_node', 'Add a node under an existing mind map node (ids come from read_page).',
    { page, block_id: z.string(), parent_node_id: z.string(), text: z.string() },
    async ({ page: p, block_id, parent_node_id, text: t }) => text(`added ${(await agentFor(p)).addMindNode(block_id, parent_node_id, t)}`));

  server.tool('insert_custom_ui',
    'Append a custom UI block, streamed in order: initial_height and placeholders, then css, then html (previewed while writing), then js (runs once complete). Runs in a sandbox: CDN scripts allowed, no network requests. Use livepage.send(action, values) in js to send input back. Style it with the Livepage design tokens so it matches the page in light and dark: var(--lp-text), var(--lp-text-secondary), var(--lp-surface), var(--lp-border), var(--lp-accent), var(--lp-radius-lg), var(--lp-space-4), var(--lp-font-sans), var(--lp-shadow-2), and var(--lp-cat-1) to var(--lp-cat-8) for chart series; the block background is transparent over the page.',
    {
      page,
      tab,
      title: z.string().optional(),
      initial_height: z.number().int().min(40).max(2000).default(240),
      placeholders: z.array(z.string()).max(5).default(['Designing…']),
      css: z.string().default(''),
      html: z.string(),
      js: z.string().default(''),
    },
    async ({ page: p, tab: tb, title, initial_height, placeholders, css, html, js }) =>
      text(`inserted ${await (await agentFor(p, tb)).streamUI({ title, initialHeight: initial_height, placeholders, css, html, js })}`));

  server.tool('insert_html_block', 'Append a raw HTML/JS block in one piece (prefer insert_custom_ui).',
    { page, tab, code: z.string(), title: z.string().optional() },
    async ({ page: p, tab: tb, code, title }) => text(`inserted ${await (await agentFor(p, tb)).insertHtml(code, { title, typeCode: true })}`));

  server.tool('update_html_block', 'Replace the code of an existing HTML/custom UI block.',
    { page, block_id: z.string(), code: z.string() },
    async ({ page: p, block_id, code }) => { (await agentFor(p)).updateHtml(block_id, code); return text('ok'); });

  server.tool('get_block_actions',
    'Get actions people sent from custom UI controls (livepage.send). Waits up to wait_seconds for one to arrive. Each returned action is claimed by you.',
    { page, wait_seconds: z.number().min(0).max(60).default(20) },
    async ({ page: p, wait_seconds }) => {
      const list = await (await agentFor(p)).waitForActions(wait_seconds * 1000);
      return text(list.length ? JSON.stringify(list, null, 2) : 'no actions');
    });

  server.tool('resolve_block_action', 'Mark a block action as handled, with a short note people see under the block.',
    { page, action_id: z.string(), note: z.string().max(200).optional() },
    async ({ page: p, action_id, note }) => { (await agentFor(p)).resolveAction(action_id, note); return text('ok'); });

  // ---- Comments and @mentions (HTTP API with the same token) ----
  async function call(path: string, init: { method?: string; body?: unknown } = {}): Promise<any> {
    const res = await fetch(`${httpBase}/api${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { authorization: `Bearer ${opts.token}`, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  }
  const safe = (fn: () => Promise<string>) => fn().then(text, (e: Error) => text(`error: ${e.message}`));
  const plain = (b: string) => b.replace(/@\[([^\]\n]{1,80})\]\((?:user|agent):[\w-]{1,64}\)/g, '@$1');
  type C = { id: string; author_name: string; author_kind: string; body: string; created_at: string };
  type T = C & { tab: string; anchor: any; current_text?: string | null; resolved_at: string | null; replies: C[] };
  const renderThread = (t: T) => {
    const where = t.anchor?.kind === 'text' ? `on "${t.current_text ?? t.anchor.quote}"${t.current_text == null ? ' (text since deleted)' : ''}`
      : t.anchor?.kind === 'block' ? `on block ${t.anchor.blockId}` : 'on the page';
    const lines = [`thread ${t.id} ${where}${t.tab !== 'main' ? ` [tab ${t.tab}]` : ''}${t.resolved_at ? ' (resolved)' : ''}`];
    for (const c of [t, ...t.replies]) lines.push(`  - ${c.author_name}${c.author_kind === 'agent' ? ' (agent)' : ''}: ${plain(c.body)}`);
    return lines.join('\n');
  };
  const mentionHelp = 'To @mention someone, write @[Name](user:<id>) or @[Name](agent:<id>) with an id from list_comments.';

  server.tool('list_comments',
    'List comment threads on a page (open ones by default), with what each is anchored to, every reply, and who can be @mentioned.',
    { page, status: z.enum(['open', 'resolved', 'all']).default('open') },
    async ({ page: p, status }) => safe(async () => {
      const [{ threads }, { mentionables }] = await Promise.all([call(`/pages/${p}/comments?status=${status}`), call(`/pages/${p}/mentionables`)]);
      const people = (mentionables as { kind: string; id: string; name: string }[]).map((m) => `@[${m.name}](${m.kind}:${m.id})`).join('  ');
      return `${(threads as T[]).map(renderThread).join('\n\n') || `no ${status === 'all' ? '' : `${status} `}comments`}\n\nCan be mentioned: ${people || 'nobody'}`;
    }));

  server.tool('add_comment',
    `Start a comment thread. Anchor it to text by quoting it exactly (within one paragraph), to a block with block_id, or leave both out to comment on the whole page. ${mentionHelp}`,
    { page, body: z.string().min(1).max(8000), quote: z.string().optional(), occurrence: z.number().int().min(1).optional().describe('Which match of quote, if it appears more than once'), block_id: z.string().optional(), tab },
    async ({ page: p, body, quote, occurrence, block_id, tab: tb }) => safe(async () => {
      const { comment } = await call(`/pages/${p}/comments`, { body: { body, quote, occurrence, block_id, tab: tb } });
      return `started thread ${comment.id}`;
    }));

  server.tool('reply_to_comment',
    `Reply in a comment thread. Replying also marks your mentions in that thread as handled. ${mentionHelp}`,
    { page, thread_id: z.string(), body: z.string().min(1).max(8000) },
    async ({ page: p, thread_id, body }) => safe(async () => {
      const { comment } = await call(`/pages/${p}/comments/${thread_id}`, { body: { body } });
      return `replied (${comment.id})`;
    }));

  server.tool('resolve_comment', 'Resolve a comment thread (or reopen it with resolved: false).',
    { page, thread_id: z.string(), resolved: z.boolean().default(true) },
    async ({ page: p, thread_id, resolved }) => safe(async () => {
      await call(`/pages/${p}/comments/${thread_id}`, { method: 'PATCH', body: { resolved } });
      return resolved ? 'resolved' : 'reopened';
    }));

  server.tool('get_mentions',
    'Comments where someone @mentioned you (this agent) that you have not answered yet, across all pages. Waits up to wait_seconds for a new one. Answer with reply_to_comment (and edit the page if asked); use dismiss_mention if no reply is needed.',
    { wait_seconds: z.number().min(0).max(60).default(0) },
    async ({ wait_seconds }) => safe(async () => {
      const { mentions } = await call(`/mentions?wait=${wait_seconds}`);
      if (!mentions.length) return 'no new mentions';
      return (mentions as any[]).map((m) =>
        `mention ${m.id} on page ${m.page_id} "${m.page_title}", thread ${m.thread_id}${m.quote ? ` (on "${m.quote}")` : ''}\n  ${m.author_name}: ${m.text}\n  ${m.url}`).join('\n\n');
    }));

  server.tool('dismiss_mention', 'Mark a mention as handled without replying.',
    { mention_id: z.string() },
    async ({ mention_id }) => safe(async () => { await call(`/mentions/${mention_id}/done`, { method: 'POST' }); return 'ok'; }));

  const close = async () => {
    const live = await Promise.allSettled([...agents.values()]);
    agents.clear();
    await Promise.all(live.map((r) => (r.status === 'fulfilled' ? r.value.disconnect() : null)));
  };
  return { server, close };
}
