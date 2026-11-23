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
  /** Name shown on the agent's caret. */
  agentName?: string;
};

/** HTTP base of the app for a collab WebSocket URL: wss://host/collab -> https://host */
export const httpBaseFor = (wsUrl: string) => wsUrl.replace(/^ws/, 'http').replace(/\/collab\/?$/, '');

export function createLivepageMcp(opts: LivepageMcpOptions): { server: McpServer; close: () => Promise<void> } {
  const httpBase = httpBaseFor(opts.wsUrl);
  const agents = new Map<string, Promise<LiveAgent>>();
  async function agentFor(page: string, tab?: string) {
    let a = agents.get(page);
    if (!a) {
      a = LiveAgent.connect({ page, url: opts.wsUrl, token: opts.token, name: opts.agentName ?? 'Agent' });
      agents.set(page, a);
      a.catch(() => agents.delete(page));
    }
    return (await a).useTab(tab);
  }
  const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
  const page = z.string().regex(/^p_[\w-]{8,40}$/).describe('Page id, from the app URL: /p/<page id>');
  const tab = z.string().optional().describe('Tab id or title to write in (see read_page). Omit for the main tab.');

  const server = new McpServer(
    { name: 'livepage', version: '0.0.2' },
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
Pages can have tabs (shown at the top). Writing tools take an optional tab; add_tab creates one.
Use list_pages to find page ids, and call read_page first to see what is there.`,
    },
  );

  server.tool('read_page', 'Read the whole page as markdown. Tables are markdown tables, mind maps are outlines with node ids, HTML blocks show their code.',
    { page }, async ({ page: p }) => text((await agentFor(p)).read() || '(empty page)'));

  server.tool('list_pages', 'List the pages this agent token can open (id, title, your role).', {}, async () => {
    const res = await fetch(`${httpBase}/api/pages`, { headers: { authorization: `Bearer ${opts.token}` } });
    if (!res.ok) return text(`could not list pages: ${res.status} ${await res.text()}`);
    const { pages } = (await res.json()) as { pages: { id: string; title: string; role?: string }[] };
    return text(pages.map((p) => `${p.id}  ${p.title || 'Untitled'}${p.role ? `  (${p.role})` : ''}`).join('\n') || 'no pages');
  });

  server.tool('add_tab', 'Add a tab to the page (tabs show at the top; each tab is its own scrolling document). Returns the tab id.',
    { page, title: z.string() }, async ({ page: p, title }) => text(`added tab ${(await agentFor(p)).addTab(title)}`));

  server.tool('write_paragraph', 'Append a paragraph to the page. It is typed out live so collaborators see it appear.',
    { page, tab, text: z.string() }, async ({ page: p, tab: tb, text: t }) => { await (await agentFor(p, tb)).typeParagraph(t, 80); return text('ok'); });

  server.tool('add_heading', 'Append a heading.',
    { page, tab, text: z.string(), level: z.number().int().min(1).max(3).default(2) },
    async ({ page: p, tab: tb, text: t, level }) => { (await agentFor(p, tb)).addHeading(t, level); return text('ok'); });

  server.tool('insert_table', 'Append a native table (editable by everyone). First row is the header.',
    { page, tab, rows: z.array(z.array(z.string())).min(1) },
    async ({ page: p, tab: tb, rows }) => { (await agentFor(p, tb)).addTable(rows); return text('ok'); });

  type Tree = { text: string; children?: Tree[] };
  const tree: z.ZodType<Tree> = z.lazy(() => z.object({ text: z.string(), children: z.array(tree).optional() }));

  server.tool('insert_mind_map', 'Append a native mind map (editable by everyone). Returns the block id.',
    { page, tab, root: tree, title: z.string().optional() },
    async ({ page: p, tab: tb, root, title }) => text(`inserted ${(await agentFor(p, tb)).addMindMap(root, title)}`));

  server.tool('add_mind_map_node', 'Add a node under an existing mind map node (ids come from read_page).',
    { page, block_id: z.string(), parent_node_id: z.string(), text: z.string() },
    async ({ page: p, block_id, parent_node_id, text: t }) => text(`added ${(await agentFor(p)).addMindNode(block_id, parent_node_id, t)}`));

  server.tool('insert_custom_ui',
    'Append a custom UI block, streamed in order: initial_height and placeholders, then css, then html (previewed while writing), then js (runs once complete). Runs in a sandbox: CDN scripts allowed, no network requests. Use livepage.send(action, values) in js to send input back.',
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

  const close = async () => {
    const live = await Promise.allSettled([...agents.values()]);
    agents.clear();
    await Promise.all(live.map((r) => (r.status === 'fulfilled' ? r.value.disconnect() : null)));
  };
  return { server, close };
}
