#!/usr/bin/env -S npx tsx
// MCP server: lets any MCP-capable AI (Claude, ChatGPT, local models via an MCP client...)
// join a Livepage page as a live collaborator.
//
//   claude mcp add livepage -- pnpm --dir /path/to/livepage agent:mcp
//
// Env: LIVEPAGE_URL (default ws://localhost:1234), AGENT_TOKEN, LIVEPAGE_AGENT_NAME
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { LiveAgent } from './client.ts';

const agents = new Map<string, LiveAgent>();
async function agentFor(page: string) {
  let a = agents.get(page);
  if (!a) {
    a = await LiveAgent.connect({ page, name: process.env.LIVEPAGE_AGENT_NAME ?? 'Agent' });
    agents.set(page, a);
  }
  return a;
}
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const page = z.string().regex(/^[\w.-]{1,128}$/).describe('Page id, as in ?page=<id> in the app URL');

const server = new McpServer({ name: 'livepage', version: '0.0.1' });

server.tool('read_page', 'Read the whole page as markdown. HTML blocks appear as <html-block id=...> with their code.',
  { page }, async ({ page: p }) => text((await agentFor(p)).read() || '(empty page)'));

server.tool('write_paragraph', 'Append a paragraph to the page. It is typed out live so collaborators see it appear.',
  { page, text: z.string() }, async ({ page: p, text: t }) => { await (await agentFor(p)).typeParagraph(t, 80); return text('ok'); });

server.tool('add_heading', 'Append a heading.',
  { page, text: z.string(), level: z.number().int().min(1).max(3).default(2) },
  async ({ page: p, text: t, level }) => { (await agentFor(p)).addHeading(t, level); return text('ok'); });

server.tool('insert_html_block',
  'Append a live HTML/JS block (rendered in a sandboxed iframe: inline <style>/<script>, CDN scripts allowed, no network requests). Use for animations, diagrams, interactive widgets.',
  { page, code: z.string(), title: z.string().optional() },
  async ({ page: p, code, title }) => text(`inserted ${await (await agentFor(p)).insertHtml(code, { title, typeCode: true })}`));

server.tool('update_html_block', 'Replace the code of an existing HTML block.',
  { page, block_id: z.string(), code: z.string() },
  async ({ page: p, block_id, code }) => { (await agentFor(p)).updateHtml(block_id, code); return text('ok'); });

await server.connect(new StdioServerTransport());

// Leave pages cleanly (removes our caret) when the MCP client goes away.
const shutdown = async () => {
  await Promise.all([...agents.values()].map((a) => a.disconnect()));
  process.exit(0);
};
process.stdin.on('close', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
