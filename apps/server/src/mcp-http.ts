// Hosted MCP endpoint: https://<your app>/mcp (MCP "Streamable HTTP" transport).
// Any MCP client (Claude, Cursor, Codex, Gemini CLI, VS Code, ...) connects with just this URL
// and an agent token sent as "Authorization: Bearer lp_...". No checkout or local process needed.
//
// Each MCP session gets its own set of live page connections, made over this server's own
// collab WebSocket with the caller's token, so the agent shows up on the page with a caret
// exactly like a local agent, and page permissions are enforced the same way.
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createLivepageMcp } from '@livepage/agent/tools';
import type { Db } from './db.ts';
import { bearer, resolvePrincipal } from './auth.ts';
import { readJson } from './agent-api.ts';
import { config } from './config.ts';
import { touchAgent } from './agent-requests.ts';

type Session = { transport: StreamableHTTPServerTransport; close: () => Promise<void>; tokenHash: string; lastSeen: number };
const sessions = new Map<string, Session>();
const IDLE_MS = 30 * 60_000;
const MAX_SESSIONS = 200;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// Bearer-token only (no cookies), so any origin may call it; browsers-based MCP clients need CORS.
function cors(res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, mcp-session-id, mcp-protocol-version, last-event-id');
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id, www-authenticate');
}

function fail(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

async function endSession(id: string) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  await s.close().catch(() => {});
  await s.transport.close().catch(() => {});
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.lastSeen > IDLE_MS) void endSession(id);
}, 60_000).unref();

export const isMcpPath = (url: string | undefined) => /^\/mcp\/?(\?|$)/.test(url ?? '');

export async function handleMcp(req: IncomingMessage, res: ServerResponse, db: Db): Promise<void> {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const token = bearer(req);
  const who = token ? await resolvePrincipal(db, { token }) : null;
  if (!token || !who || who.kind !== 'agent') {
    return fail(res, 401, 'Send an agent token as "Authorization: Bearer lp_...". Create one on your Livepage home page.', {
      'www-authenticate': 'Bearer realm="livepage"',
    });
  }

  touchAgent(who);
  const sid = req.headers['mcp-session-id'];
  const sessionId = Array.isArray(sid) ? sid[0] : sid;
  const body = req.method === 'POST' ? await readJson(req).catch(() => undefined) : undefined;

  if (sessionId) {
    const s = sessions.get(sessionId);
    if (!s) return fail(res, 404, 'Session not found or expired. Start a new session.');
    if (s.tokenHash !== sha(token)) return fail(res, 403, 'This session belongs to another token.');
    s.lastSeen = Date.now();
    await s.transport.handleRequest(req, res, body);
    if (req.method === 'DELETE') await endSession(sessionId);
    return;
  }

  if (req.method !== 'POST' || !isInitializeRequest(body)) {
    return fail(res, 400, 'Missing mcp-session-id. Start with an initialize request.');
  }
  if (sessions.size >= MAX_SESSIONS) return fail(res, 503, 'Too many open MCP sessions. Try again later.');

  // Live page connections go to this same server over loopback, authenticated with the caller's token.
  const { server, close } = createLivepageMcp({
    wsUrl: `ws://127.0.0.1:${config.port}/collab`,
    token,
    agentName: who.name || 'Agent',
    agentId: who.tokenId ? `agent:${who.tokenId}` : undefined,
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => { sessions.set(id, { transport, close, tokenHash: sha(token), lastSeen: Date.now() }); },
  });
  transport.onclose = () => { if (transport.sessionId) void endSession(transport.sessionId); };
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
