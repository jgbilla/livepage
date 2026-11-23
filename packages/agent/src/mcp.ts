#!/usr/bin/env -S npx tsx
// Local MCP server (stdio): lets any MCP-capable AI join a Livepage page as a live collaborator.
// No checkout needed for hosted apps: they also serve the same tools at https://<your app>/mcp.
//
//   claude mcp add livepage -e LIVEPAGE_URL=wss://<your app>/collab -e AGENT_TOKEN=lp_... -- pnpm --silent --dir /path/to/livepage agent:mcp
//
// Env: LIVEPAGE_URL (default ws://localhost:1234/collab; hosted: wss://<your app>/collab),
//      AGENT_TOKEN (an lp_... token from the app's home page), LIVEPAGE_AGENT_NAME
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createLivepageMcp } from './tools.ts';

const { server, close } = createLivepageMcp({
  wsUrl: process.env.LIVEPAGE_URL ?? 'ws://localhost:1234/collab',
  token: process.env.AGENT_TOKEN ?? 'dev-agent-token',
  agentName: process.env.LIVEPAGE_AGENT_NAME,
});
await server.connect(new StdioServerTransport());

// Leave pages cleanly (removes our caret) when the MCP client goes away.
const shutdown = async () => { await close(); process.exit(0); };
process.stdin.on('close', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
