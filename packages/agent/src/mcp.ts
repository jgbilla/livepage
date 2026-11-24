#!/usr/bin/env -S npx tsx
// Local MCP server (stdio): lets any MCP-capable AI join a Livepage page as a live collaborator.
// No checkout needed for hosted apps: they also serve the same tools at https://<your app>/mcp.
//
//   claude mcp add livepage -e LIVEPAGE_URL=wss://<your app>/collab -e AGENT_TOKEN=lp_... -- pnpm --silent --dir /path/to/livepage agent:mcp
//
// Env: LIVEPAGE_URL (default ws://localhost:1234/collab; hosted: wss://<your app>/collab),
//      AGENT_TOKEN (an lp_... token from the app's home page), LIVEPAGE_AGENT_NAME,
//      LIVEPAGE_CHANNEL=1 to push work into Claude Code as it arrives (no listening loop):
//
//   claude mcp add livepage -e LIVEPAGE_CHANNEL=1 -e LIVEPAGE_URL=... -e AGENT_TOKEN=... -- pnpm --silent --dir /path/to/livepage agent:mcp
//   claude --dangerously-load-development-channels server:livepage
//
// With the channel on, this process follows the agent's event stream (GET /api/agent-events) and hands
// each event to Claude Code as a <channel source="livepage"> message. Taking the work is unchanged
// (wait_for_requests confirms it), so nothing is lost if a message is missed.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createLivepageMcp, httpBaseFor } from './tools.ts';
import { followAgentEvents } from './events.ts';

const wsUrl = process.env.LIVEPAGE_URL ?? 'ws://localhost:1234/collab';
const token = process.env.AGENT_TOKEN ?? 'dev-agent-token';
const channel = /^(1|true|yes|on)$/i.test(process.env.LIVEPAGE_CHANNEL ?? '');

const { server, close } = createLivepageMcp({ wsUrl, token, agentName: process.env.LIVEPAGE_AGENT_NAME, channel });
await server.connect(new StdioServerTransport());

let stopEvents: (() => void) | undefined;
if (channel) {
  stopEvents = followAgentEvents({
    baseUrl: httpBaseFor(wsUrl),
    token,
    onEvent: (e) => {
      const pending = (e.data as any)?.pending;
      if (e.type === 'ready' && !(pending?.requests || pending?.tasks || pending?.mentions)) return; // nothing waiting: say nothing
      // Channel meta keys must be letters, digits and underscores.
      const meta: Record<string, string> = { type: e.type };
      const d = e.data as any;
      if (d?.task?.id) meta.task_id = d.task.id;
      if (d?.request?.id) meta.request_id = d.request.id;
      if (d?.page?.id) meta.page_id = d.page.id;
      if (d?.comment?.thread_id) meta.thread_id = d.comment.thread_id;
      void server.server.notification({ method: 'notifications/claude/channel', params: { content: e.text, meta } }).catch(() => {});
    },
    onError: (msg) => process.stderr.write(`[livepage] event stream: ${msg}\n`),
  });
}

// Leave pages cleanly (removes our caret) when the MCP client goes away.
const shutdown = async () => { stopEvents?.(); await close(); process.exit(0); };
process.stdin.on('close', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
