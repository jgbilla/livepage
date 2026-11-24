// Push: tell an agent the moment there is work for it, so it doesn't have to keep checking.
//
// Three ways out, all for the same events, all keyed by agent token:
//   1. A live event stream, GET /api/agent-events (Server-Sent Events, Bearer lp_ token). The local MCP
//      server listens on it and hands each event to Claude Code as a channel message (mcp.ts), and any
//      script can follow it with curl or EventSource.
//   2. The token's webhook, if it has one: a signed POST per event, retried a few times if it fails.
//   3. A cloud agent with wake set up (agent-wake.ts): a session is started for it (Devin).
//   4. The long polls that were already there (wait_for_requests, get_mentions) end early.
//
// A push says *that* there is work and what it is; taking the work is unchanged. Ask requests and tasks
// are still delivered on a lease by wait_for_requests and confirmed by the agent (ack, reply, update_task),
// so a push nobody acts on loses nothing: the work stays in the queue, and polling still works.
//
// Events: request.created (Ask AI), comment.mention, task.assigned, task.message (the person answered or
// reopened a task), task.cancelled. Each carries `text`, a one-paragraph summary written for a model,
// and `data` with ids and links.
import { createHmac } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from './db.ts';
import type { Principal } from './auth.ts';
import { send } from './agent-api.ts';
import { checkWebhookUrl } from './comments.ts';
import { wakeForEvent } from './agent-wake.ts';

export type AgentEventType = 'request.created' | 'comment.mention' | 'task.assigned' | 'task.message' | 'task.cancelled';
export type AgentEvent = { id: string; type: AgentEventType; at: string; text: string; data: Record<string, unknown> };

type Listener = (e: AgentEvent) => void;
const streams = new Map<string, Set<Listener>>(); // tokenId -> open event streams
let seq = 0;

/** How many event streams this agent has open right now (an open stream counts as listening). */
export const streamCount = (tokenId: string) => streams.get(tokenId)?.size ?? 0;

/** Send an event to an agent: its open streams now, and its webhook (in the background, with retries). */
export function pushToAgent(db: Db, tokenId: string, type: AgentEventType, text: string, data: Record<string, unknown>) {
  const event: AgentEvent = { id: `${Date.now().toString(36)}-${(++seq).toString(36)}`, type, at: new Date().toISOString(), text, data };
  for (const fn of streams.get(tokenId) ?? []) {
    try { fn(event); } catch { /* a broken stream is dropped by its own close handler */ }
  }
  void sendWebhook(db, tokenId, event).catch((e) => console.warn(`[push] webhook for ${tokenId}: ${(e as Error).message}`));
  // A cloud agent with wake set up (Devin) gets a session started for it when it isn't listening.
  void wakeForEvent(db, tokenId, event).catch((e) => console.warn(`[wake] ${tokenId}: ${(e as Error).message}`));
}

// ---- Webhooks

const RETRY_MS = [0, 5_000, 30_000, 120_000];

/** Signed like before: x-livepage-signature = sha256=HMAC(secret, `${timestamp}.${body}`). */
async function sendWebhook(db: Db, tokenId: string, event: AgentEvent) {
  const [h] = await db.query('select id, name, webhook_url, webhook_secret from api_tokens where id = $1 and webhook_url is not null', [tokenId]);
  if (!h) return;
  // The body keeps the shape comment.mention webhooks always had (its fields at the top level), plus the summary.
  const payload = JSON.stringify({
    type: event.type, event_id: event.id, delivered_at: event.at, agent: { token_id: h.id, name: h.name }, text: event.text, ...event.data,
  });
  for (let attempt = 0; attempt < RETRY_MS.length; attempt++) {
    if (RETRY_MS[attempt]) await new Promise((r) => setTimeout(r, RETRY_MS[attempt]).unref?.());
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = createHmac('sha256', h.webhook_secret).update(`${ts}.${payload}`).digest('hex');
    try {
      await checkWebhookUrl(h.webhook_url); // DNS can change after the URL was saved
      const res = await fetch(h.webhook_url, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(8000),
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Livepage-Webhook/1',
          'x-livepage-event': event.type,
          'x-livepage-delivery': event.id,
          'x-livepage-attempt': String(attempt + 1),
          'x-livepage-timestamp': ts,
          'x-livepage-signature': `sha256=${sig}`,
        },
        body: payload,
      });
      if (res.ok) return;
      // A 4xx (other than 408/429) is the receiver saying no; trying again would not change that.
      if (res.status < 500 && res.status !== 408 && res.status !== 429) { console.warn(`[push] webhook for ${h.id} answered ${res.status}`); return; }
      console.warn(`[push] webhook for ${h.id} answered ${res.status} (try ${attempt + 1})`);
    } catch (e) {
      const msg = (e as Error).message;
      if (/https|private network|resolve|full URL|secret/.test(msg)) { console.warn(`[push] webhook for ${h.id}: ${msg}`); return; }
      console.warn(`[push] webhook for ${h.id} failed (try ${attempt + 1}): ${msg}`);
    }
  }
}

// ---- Event stream

const HEARTBEAT_MS = 20_000; // keeps proxies (Render, nginx) from closing a quiet stream
const MAX_STREAMS_PER_TOKEN = 5;

export type PendingCounts = { requests: number; mentions: number; tasks: number };

async function pendingFor(db: Db, who: Principal): Promise<PendingCounts> {
  const [r] = await db.query(
    `select
       (select count(*)::int from agent_requests where token_id = $1 and status = 'pending') as requests,
       (select count(*)::int from comment_mentions where target_kind = 'agent' and target_id = $1 and handled_at is null) as mentions,
       (select count(*)::int from agent_tasks where token_id = $1 and status = 'queued') as tasks`, [who.tokenId]);
  return { requests: r?.requests ?? 0, mentions: r?.mentions ?? 0, tasks: r?.tasks ?? 0 };
}

/** GET /api/agent-events (agent token). Server-Sent Events; starts with `ready` and what is waiting. */
export async function handleAgentEvents(req: IncomingMessage, res: ServerResponse, db: Db, who: Principal): Promise<void> {
  if (who.kind !== 'agent' || !who.tokenId) return send(res, 403, { error: 'Use a personal agent token (lp_...).' });
  const tokenId = who.tokenId;
  let set = streams.get(tokenId);
  if ((set?.size ?? 0) >= MAX_STREAMS_PER_TOKEN) return send(res, 429, { error: 'This agent already has 5 event streams open. Close one first.' });

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no', // nginx: don't buffer the stream
  });
  res.socket?.setKeepAlive?.(true);
  res.socket?.setNoDelay?.(true);
  const write = (s: string) => { if (!res.writableEnded && !res.destroyed) res.write(s); };
  const emit = (event: string, data: unknown, id?: string) =>
    write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const listener: Listener = (e) => emit(e.type, e, e.id);
  if (!set) streams.set(tokenId, (set = new Set()));
  set.add(listener);
  const beat = setInterval(() => write(`: ${Date.now()}\n\n`), HEARTBEAT_MS);
  const stop = () => {
    clearInterval(beat);
    const s = streams.get(tokenId);
    s?.delete(listener);
    if (s && !s.size) streams.delete(tokenId);
  };
  res.on('close', stop);
  req.on('aborted', stop);

  write('retry: 3000\n\n');
  // What is already waiting, so an agent that (re)connects knows to take it with wait_for_requests.
  const pending = await pendingFor(db, who).catch(() => ({ requests: 0, mentions: 0, tasks: 0 }));
  emit('ready', { agent: { token_id: tokenId, name: who.name }, pending, text: readyText(pending) });
}

function readyText(p: PendingCounts): string {
  const parts = [
    p.requests && `${p.requests} Ask AI request${p.requests === 1 ? '' : 's'}`,
    p.tasks && `${p.tasks} task${p.tasks === 1 ? '' : 's'}`,
    p.mentions && `${p.mentions} comment mention${p.mentions === 1 ? '' : 's'}`,
  ].filter(Boolean);
  return parts.length
    ? `Connected to Livepage. Waiting for you: ${parts.join(', ')}. Call wait_for_requests (wait_seconds 0) to take them.`
    : 'Connected to Livepage. Nothing is waiting; new work arrives here as it comes in.';
}
