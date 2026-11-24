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
  /** Run as a Claude Code channel: work is pushed into the session as <channel> messages (mcp.ts, LIVEPAGE_CHANNEL=1). */
  channel?: boolean;
};

const CHANNEL_INSTRUCTIONS = `
Livepage pushes work to you as <channel source="livepage"> messages the moment it arrives: Ask AI requests, tasks from
the task board, and comments that mention you. You do not need to loop on wait_for_requests. When a request or task arrives,
call wait_for_requests with wait_seconds 0 to take it (that confirms you have it), do it, and answer as usual
(reply_to_request, update_task). A comment mention says which thread to read and answer with reply_to_comment. The attribute type says what it is: request.created, task.assigned,
task.message (the person wrote on a task), task.cancelled (stop working on it), comment.mention, or ready (what was
waiting when you connected).`;

const GENERIC_NAME = /^\s*(agent)?\s*$/i; // empty, or the default a token gets when left unnamed
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
    { name: 'livepage', version: '0.0.4' },
    {
      instructions: `You are a collaborator on a live Livepage page, next to the people editing it.
To change what is already on a page, edit only what needs changing. Never rewrite a page, a tab or a section to change
a few words, and never re-run a script that regenerates it: that costs far more tokens and drops the comments anchored to the old text.
- Find the place: get_outline lists headings with block ids; read_blocks reads one section (or the page) with every block's id.
- A few words or a sentence: replace_text (find and replace in place; formatting, links and footnotes stay).
- A whole block or section: replace_blocks with Markdown. New content in the middle: insert_blocks before/after a block.
- Remove or reorder: delete_blocks, move_blocks. Tables: set_table_cell, add_table_row, delete_table_row.
Block ids stay valid while the page changes around them; a replaced or moved block gets a new id, which the tool returns.
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
New pages go in today's daily folder YYYY/MM/DD (the person's local date) unless you give a path; pass a path
when the person names a folder, or "" for the top level.
Link pages and tabs inside write_paragraph text with [[p_id]] or [[p_id#tab_id]]; the link shows the target's current title
and survives renames and moves. read_page shows links the same way; get_backlinks lists pages that link to a page.
search_pages finds pages by any words in them; get_link_graph shows how pages link together.
Use list_pages or search_pages to find page ids. Before writing, see what is there: get_outline for a long page
(then read_blocks for the section you need), read_page for a short one.
Templates: any page can be a template (list_templates). create_page with template starts a page as a copy of one, with
{{date}}, {{title}} and similar filled in; other {{Fields}} are left for you: get_template_fields, then fill_template_fields.
open_daily_page uses the person's daily template when they set one.
import_markdown creates a page from Markdown (Obsidian [[links]], #tags, frontmatter and [^1] footnotes work); export_markdown
gives a page as a Markdown file. publish_page puts a page on the public web (owner only), and unpublish_page takes it down.
People can also ask you from the Ask AI panel inside Livepage. When asked to listen for Livepage requests, loop on
wait_for_requests: for each request, work on its page (get_outline or read_page first; use its tab; edit what is there with the targeted edit tools), using your own context and tools
as needed, then answer with reply_to_request, and go straight back to wait_for_requests: the person's follow-ups in the same chat
arrive as new requests carrying the earlier turns. Send short progress with reply_to_request(done=false) on long tasks.
People also hand you tasks on the task board. They arrive through wait_for_requests (or list_tasks). Work on them with your
own context and the page tools, report with update_task as you go (a short note), ask with status needs_you when you are stuck,
and finish with done or failed and a one-line summary.
People comment on text, blocks or the whole page and can @mention you; @AI reaches you too when the person picked you in
the Ask AI menu. While listening, these arrive through wait_for_requests as well. Once you have replied in a thread, the person's
later replies there reach you too, without an @. Check get_mentions, read the thread (list_comments) and the page,
then answer with reply_to_comment and make any edit they asked for.${opts.channel ? CHANNEL_INSTRUCTIONS : ''}`,
      ...(opts.channel ? { capabilities: { experimental: { 'claude/channel': {} } } } : {}),
    },
  );

  server.tool('read_page', 'Read the whole page as markdown. Tables are markdown tables, mind maps are outlines with node ids, HTML blocks show their code, footnotes are [^n] with definitions (and ids) at the end of each tab. On a long page, get_outline plus read_blocks for one section costs far fewer tokens. To edit, use read_blocks: it gives the block ids the edit tools need.',
    { page }, async ({ page: p }) => text((await agentFor(p)).read() || '(empty page)'));

  // ---- Targeted edits ----
  const blockId = z.string().min(1).max(80);
  const through = blockId.optional().describe('Last block of a run: everything from block_id through this block (same tab) is included.');
  const where = {
    before: blockId.optional().describe('Put it right before this block.'),
    after: blockId.optional().describe('Put it right after this block.'),
    at: z.enum(['start', 'end']).optional().describe('Without before/after: the start or the end (default) of the tab.'),
  };
  const mdHelp = 'Markdown: headings, **bold**, lists, tables, code fences, [links](https://...), [[p_id]] page links.';
  const idList = (ids: string[]) => ids.join(', ');

  server.tool('get_outline',
    'The page\'s structure without its text: each tab, its headings with their block ids, and how many blocks each section has. Start here on a long page, then read_blocks the one section you need.',
    { page, tab: z.string().optional().describe('Only this tab (id or title). Omit for every tab.') },
    async ({ page: p, tab: tb }) => tryText(async () => (await agentFor(p)).outline(tb) || '(empty page)'));

  server.tool('read_blocks',
    'Read blocks with their ids, each as "[block_id type]" followed by its Markdown. Give section (a heading\'s block id, from get_outline) to read just that heading and what is under it, from to start at a block, or neither for the whole page or tab. Use the ids with replace_blocks, insert_blocks, delete_blocks, move_blocks and the table tools.',
    {
      page,
      tab: z.string().optional().describe('Only this tab (id or title). Omit for every tab.'),
      section: blockId.optional().describe('A heading\'s block id: read that section only.'),
      from: blockId.optional().describe('Start reading at this block.'),
      limit: z.number().int().min(1).max(1000).default(200).describe('At most this many blocks.'),
    },
    async ({ page: p, tab: tb, section, from, limit }) => tryText(async () => {
      const a = await agentFor(p);
      return a.readBlocks({ tab: a.tabId(tb), section, from, limit }) || '(no blocks)';
    }));

  server.tool('replace_text',
    'Change words in place: find exact text and replace it, keeping formatting, links, footnotes and comments around it. The cheapest way to fix, reword or update something. find must sit inside one paragraph, heading, list item or table cell, written as plain text (no Markdown markers). If it appears more than once, quote more words or pass block_id, occurrence or all. An empty replace deletes the text.',
    {
      page,
      find: z.string().min(1).max(4000).describe('Exact text now on the page.'),
      replace: z.string().max(20000).describe('Text to put in its place. Words that stay the same keep their formatting and comments; inline Markdown (**bold**, `code`, [link](url)) sets formatting.'),
      block_id: blockId.optional().describe('Only look inside this block.'),
      tab: z.string().optional().describe('Only look in this tab (id or title). Omit for every tab.'),
      occurrence: z.number().int().min(1).optional().describe('Which match to replace (1 = first) when there are several.'),
      all: z.boolean().default(false).describe('Replace every match.'),
      match_case: z.boolean().default(true),
    },
    async ({ page: p, find, replace, block_id, tab: tb, occurrence, all, match_case }) => tryText(async () => {
      const a = await agentFor(p);
      const r = await a.replaceText(find, replace, { blockId: block_id, tab: a.tabId(tb), occurrence, all, matchCase: match_case });
      return `replaced ${r.replaced} in ${idList(r.blocks)}`;
    }));

  server.tool('replace_blocks',
    `Rewrite one block, or a run of blocks (block_id through through_block_id, for example a whole section), with new Markdown. Everything else on the page is untouched. For a change of a few words use replace_text instead. Returns the new block ids. ${mdHelp}`,
    { page, block_id: blockId, through_block_id: through, markdown: z.string().min(1) },
    async ({ page: p, block_id, through_block_id, markdown }) =>
      tryText(async () => `replaced; new blocks: ${idList((await agentFor(p)).replaceBlocks(block_id, markdown, through_block_id))}`));

  server.tool('insert_blocks',
    `Insert new content at a chosen place: before or after a block, or at the start or end of a tab. Returns the new block ids. ${mdHelp}`,
    { page, tab, markdown: z.string().min(1), ...where },
    async ({ page: p, tab: tb, markdown, before, after, at }) =>
      tryText(async () => `inserted ${idList((await agentFor(p, tb)).insertBlocks(markdown, { before, after, at }))}`));

  server.tool('delete_blocks', 'Delete one block, or a run of blocks (block_id through through_block_id). People can bring it back from History.',
    { page, block_id: blockId, through_block_id: through },
    async ({ page: p, block_id, through_block_id }) =>
      tryText(async () => `deleted ${(await agentFor(p)).deleteBlocks(block_id, through_block_id)} block(s)`));

  server.tool('move_blocks',
    'Move one block, or a run of blocks (for example a section), before or after another block, or to the start or end of a tab (also another tab). Moved blocks get new ids, which are returned.',
    { page, block_id: blockId, through_block_id: through, ...where, tab: z.string().optional().describe('With at: the tab to move to (id or title). Defaults to the tab the blocks are in.') },
    async ({ page: p, block_id, through_block_id, before, after, at, tab: tb }) => tryText(async () => {
      const a = await agentFor(p);
      return `moved; new blocks: ${idList(a.moveBlocks(block_id, { before, after, at, tab: a.tabId(tb) }, through_block_id))}`;
    }));

  const tableId = blockId.describe('The table\'s block id (from read_blocks).');
  server.tool('set_table_cell', 'Change one cell of a table. Rows and columns count from 1; row 1 is the header row.',
    { page, block_id: tableId, row: z.number().int().min(1), column: z.number().int().min(1), text: z.string() },
    async ({ page: p, block_id, row, column, text: t }) => tryText(async () => { (await agentFor(p)).setTableCell(block_id, row, column, t); return 'ok'; }));

  server.tool('add_table_row', 'Add a row to a table: at the end, or at a row number (rows count from 1; row 1 is the header and stays first).',
    { page, block_id: tableId, cells: z.array(z.string()), row: z.number().int().min(1).optional().describe('Where the new row goes. Omit to add it at the end.') },
    async ({ page: p, block_id, cells, row }) => tryText(async () => `added row ${(await agentFor(p)).addTableRow(block_id, cells, row)}`));

  server.tool('delete_table_row', 'Delete a row of a table (rows count from 1).',
    { page, block_id: tableId, row: z.number().int().min(1) },
    async ({ page: p, block_id, row }) => tryText(async () => { (await agentFor(p)).removeTableRow(block_id, row); return 'ok'; }));

  async function http<T = any>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${httpBase}/api${path}`, {
      method, signal,
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

  type AgentTask = { id: string; title: string; page_id: string | null; text: string };
  type AgentReq = { id: string; page_id: string; page_title: string; tab: string; prompt: string; selection: string; history?: { role: string; text: string }[] };
  type ListenMention = { id: string; page_id: string; page_title: string; thread_id: string; tab: string; author_name: string; text: string; quote: string | null };
  // A one-step way to start listening. In Claude Code this is the /mcp__livepage__listen command.
  server.prompt('listen', 'Listen for Livepage work: Ask AI requests, tasks from the task board and comments that mention you, and handle each one as it arrives.',
    () => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `Listen for Livepage work and handle it as it arrives, until I tell you to stop.
Loop: call wait_for_requests (wait_seconds 25). When it returns nothing, call it again right away.
- An Ask AI request: work on its page with the targeted edit tools, answer with reply_to_request, then listen again.
- A task from the task board: do it with your own context and the page tools. Send a short update_task note as you go,
  use status needs_you with a question if you are stuck (the answer comes back through wait_for_requests), and finish
  with update_task done (or failed) and a one-line summary. Then listen again.
- A comment that mentions you: read the thread with list_comments, do what it asks, answer with reply_to_comment, then listen again.
Keep each reply to me short; the person follows along in Livepage.`,
        },
      }],
    }));

  server.tool('wait_for_requests',
    'Wait for requests people send you from the Ask AI panel in Livepage, and tasks they hand you on the task board (up to wait_seconds), and take them. Each request has a page, tab, the person\'s prompt, any text they had selected, and earlier chat turns. A follow-up the person types in the same chat (like "apply" or "yes") arrives as a new request with the earlier turns; act on it in that context. Comments that @mention you (or @AI, when the person picked you in Ask AI) arrive here too: answer those in the thread with reply_to_comment. Tasks: report on them with update_task. Call it in a loop when asked to listen, including after each reply, so follow-ups reach you.',
    { wait_seconds: z.number().min(0).max(30).default(25) },
    async ({ wait_seconds }, extra) => tryText(async () => {
      // Pass the call's abort signal on, so a cancelled or timed-out call ends the long poll instead of
      // leaving it open to take a request nobody will see.
      const { requests, mentions = [], tasks = [] } = await http<{ requests: AgentReq[]; mentions?: ListenMention[]; tasks?: AgentTask[] }>('GET', `/agent-requests?wait=${wait_seconds}`, undefined, extra?.signal);
      if (!requests.length && !mentions.length && !tasks.length) return 'no requests yet; call wait_for_requests again to keep listening';
      // Confirm we got them. Unconfirmed requests and tasks go back in the queue after a short while.
      await Promise.all([
        ...requests.map((r) => http('POST', `/agent-requests/${r.id}/ack`).catch(() => {})),
        ...tasks.map((t) => http('POST', `/tasks/${t.id}/ack`).catch(() => {})),
      ]);
      return requests.map((r) => [
        `request ${r.id}${r.history?.length ? ' (follow-up in an ongoing chat)' : ''}`,
        `page: ${r.page_id} (${r.page_title || 'Untitled'})${r.tab && r.tab !== 'main' ? `, tab ${r.tab}` : ''}`,
        r.history?.length ? `earlier in this chat:\n${r.history.map((h) => `  ${h.role}: ${h.text}`).join('\n')}` : '',
        r.selection ? `selected text:\n${r.selection}` : '',
        `asks: ${r.prompt}`,
        `answer with reply_to_request (request_id ${r.id}), then call wait_for_requests again for the next message.`,
      ].filter(Boolean).join('\n')).concat(mentions.map((m) => [
        `comment ${m.id} on page ${m.page_id} (${m.page_title})${m.tab && m.tab !== 'main' ? `, tab ${m.tab}` : ''}, thread ${m.thread_id}${m.quote ? `, on "${m.quote}"` : ''}`,
        `${m.author_name}: ${m.text}`,
        `read the thread with list_comments and the page, do what it asks, answer with reply_to_comment (page ${m.page_id}, thread_id ${m.thread_id}), then call wait_for_requests again.`,
      ].join('\n'))).concat(tasks.map((t) => `${t.text}\nthen call wait_for_requests again.`)).join('\n\n---\n\n');
    }));

  server.tool('reply_to_request',
    'Answer a request from the Ask AI panel. The text shows in the person\'s chat. Use done=false for a short progress note while you are still working; done=true (default) finishes it.',
    { request_id: z.string().regex(/^ar_[\w-]+$/), text: z.string(), done: z.boolean().default(true) },
    async ({ request_id, text: t, done }) => tryText(async () => { await http('POST', `/agent-requests/${request_id}/reply`, { text: t, done }); return 'ok'; }));

  // ---- Task board
  const taskId = z.string().regex(/^tk_[\w-]+$/).describe('Task id (tk_...)');
  type TaskRow = { id: string; title: string; status: string; note: string; page_id: string | null; page_title: string | null; pages: { id: string; title: string }[]; updated_at: string };
  server.tool('list_tasks',
    'Tasks people handed you on the Livepage task board: open ones (queued, working, needs you), or all with include_finished. New ones also arrive through wait_for_requests.',
    { include_finished: z.boolean().default(false) },
    async ({ include_finished }) => tryText(async () => {
      const { tasks } = await http<{ tasks: TaskRow[] }>('GET', `/tasks${include_finished ? '?all=1' : ''}`);
      return tasks.map((t) => `${t.id}  [${t.status}]  ${t.title}${t.page_id ? `  (page ${t.page_id})` : ''}${t.note ? `\n  last note: ${t.note}` : ''}`).join('\n') || 'no tasks';
    }));

  server.tool('get_task', 'Read one task: its instructions, page, pages you have touched for it, and the whole conversation with the person.',
    { task_id: taskId },
    async ({ task_id }) => tryText(async () => {
      const { task, events } = await http<{ task: TaskRow & { details: string }; events: { kind: string; author_kind: string; author_name: string; text: string; status: string | null; created_at: string }[] }>('GET', `/tasks/${task_id}`);
      return [
        `task ${task.id} [${task.status}]: ${task.title}`,
        task.details ? `instructions:\n${task.details}` : '',
        task.page_id ? `page: ${task.page_id} (${task.page_title})` : '',
        task.pages.length ? `pages touched: ${task.pages.map((p) => `${p.id} (${p.title || 'Untitled'})`).join(', ')}` : '',
        `timeline:\n${events.map((e) => `  ${e.created_at.slice(0, 16).replace('T', ' ')} ${e.author_kind === 'agent' ? 'you' : e.author_name} ${e.kind}${e.status ? ` -> ${e.status}` : ''}${e.text ? `: ${e.text}` : ''}`).join('\n')}`,
      ].filter(Boolean).join('\n');
    }));

  server.tool('update_task',
    'Report on a task from the task board. Send a short note as you go (it shows on the task card). status: working (default once you start), needs_you (stuck: put your question in note; the person\'s answer comes back through wait_for_requests), done or failed (put a summary in note). pages: ids of pages you made or changed, if not edited live. The answer includes anything the person wrote since you last looked.',
    {
      task_id: taskId,
      status: z.enum(['working', 'needs_you', 'done', 'failed']).optional(),
      note: z.string().max(2000).optional(),
      pages: z.array(z.string().regex(/^p_[\w-]{8,40}$/)).max(20).optional(),
    },
    async ({ task_id, status, note, pages }) => tryText(async () => {
      const r = await http<{ status: string; messages: { from: string; text: string }[] }>('POST', `/tasks/${task_id}/update`, { status, note, pages });
      return `ok, task is ${r.status}${r.messages.length ? `\nnew from the person:\n${r.messages.map((m) => `  ${m.from}: ${m.text}`).join('\n')}` : ''}`;
    }));

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

  server.tool('create_page', 'Create a page, with tags or from a template (ids from list_templates). Without a path it goes in today\'s daily folder YYYY/MM/DD (the person\'s local date). Returns the page id and folder, and any {{fields}} left to fill in.',
    {
      title: z.string().optional().describe('Omit with a template to use the template title (its {{date}} etc. filled in).'),
      path: folderPath.optional().describe('Folder path like "Projects/Book" (created if missing) when the person names one; "" = top level. Omit for today\'s daily folder.'),
      tags: z.array(z.string()).optional(),
      template: z.string().regex(/^p_[\w-]{8,40}$/).optional().describe('Template page id'),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('The person\'s local date, for the daily folder and {{date}}. Defaults to their today.'),
    },
    async ({ title, path, tags, template, date }) => tryText(async () => {
      const r = await http('POST', '/pages', { title: title ?? (template ? undefined : ''), path, tags, template_id: template, date });
      const where = `  in ${r.page.path || 'the top level'}`;
      if (!template) return `created ${r.page.id}${where}`;
      const { fields } = await http<{ fields: string[] }>('GET', `/pages/${r.page.id}/fields`);
      return `created ${r.page.id}  "${r.page.title}"${where}${fields.length ? `\nfields to fill in: ${fields.map((f) => `{{${f}}}`).join(', ')}` : ''}`;
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
    { markdown: z.string(), title: z.string().optional().describe('Defaults to the frontmatter title or "Imported"'),
      path: folderPath.optional().describe('Folder path when the person names one; "" = top level. Omit for today\'s daily folder YYYY/MM/DD.') },
    async ({ markdown, title, path }) => tryText(async () => {
      const name = `${(title || 'Imported').replace(/[\\/]/g, '-')}.md`;
      const r = await http<{ pages: { id: string; title: string; path: string }[]; unresolved: string[] }>('POST', '/import', { files: [{ path: name, content: markdown }], into: path });
      return `created ${r.pages[0]?.id}  in ${r.pages[0]?.path || 'the top level'}${r.unresolved.length ? `\nlinks not found: ${r.unresolved.join(', ')}` : ''}`;
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
    { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD. Defaults to the person\'s today (their own time zone).') },
    async ({ date }) => tryText(async () => {
      const r = await http('POST', '/daily', { date });
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

  server.tool('write_paragraph', 'Append a paragraph to the end of the page (to put text elsewhere, use insert_blocks; to change existing text, replace_text). It is typed out live so collaborators see it appear. Link to a page or tab with [[p_id]], [[p_id#tab_id]] or [[p_id|label]] (ids from list_pages and read_page).',
    { page, tab, text: z.string() }, async ({ page: p, tab: tb, text: t }) => { await (await agentFor(p, tb)).typeParagraph(t, 80); return text('ok'); });

  server.tool('add_heading', 'Append a heading to the end of the page.',
    { page, tab, text: z.string(), level: z.number().int().min(1).max(3).default(2) },
    async ({ page: p, tab: tb, text: t, level }) => { (await agentFor(p, tb)).addHeading(t, level); return text('ok'); });

  server.tool('insert_table', 'Append a native table (editable by everyone). First row is the header. To change a table that is already there, use set_table_cell, add_table_row and delete_table_row.',
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

  server.tool('update_html_block', 'Replace the code of an existing HTML/custom UI block (block ids come from read_page or read_blocks).',
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
    'Comments where someone @mentioned you (this agent), or replied in a thread you answered, that you have not answered yet, across all pages. Waits up to wait_seconds for a new one. Answer with reply_to_comment (and edit the page if asked); use dismiss_mention if no reply is needed.',
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
