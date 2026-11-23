// Ask AI with your own connected agent.
//
// Livepage can't start Claude Code, Cursor or Codex on someone's machine, but those agents are
// already connected to Livepage over MCP (or HTTP) with a personal agent token, and they bring
// their own context: the person's files, memory and tools. So the Ask AI panel can hand a request
// to one of them: it goes in a small queue, the agent picks it up (long poll, MCP tool
// wait_for_requests), works on the page live with the normal tools and its own caret, and answers
// with reply_to_request. The panel shows which agents are online and streams the status.
//
//   Person (session cookie)
//     GET    /api/agents                                -> your agent tokens + online status
//     POST   /api/pages/:page/agent-requests            { tokenId, prompt, tab?, selection?, history? } -> { request }
//     GET    /api/agent-requests/:id?wait=25            -> { request } (returns early when it changes)
//     DELETE /api/agent-requests/:id                    -> cancel
//   Agent (Bearer lp_ token)
//     GET    /api/agent-requests?wait=20                -> { requests } pending for this token, now claimed
//     POST   /api/agent-requests/:id/reply              { text, done? }  (done=false: progress note)
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from './db.ts';
import { randomId, type Principal } from './auth.ts';
import { readJson, send } from './agent-api.ts';
import { canEdit, roleFor } from './pages.ts';

const ONLINE_MS = 2 * 60_000;
const MAX_WAIT = 30_000;
const LIMITS = { prompt: 8000, selection: 8000, reply: 20_000, progress: 300, pendingPerToken: 20 };

export type AgentRequest = {
  id: string; page_id: string; page_title?: string; tab: string; prompt: string; selection: string; history?: unknown;
  status: 'pending' | 'working' | 'done' | 'cancelled'; progress: string; reply: string;
  created_at: string; claimed_at: string | null; done_at: string | null; token_id: string; agent_name?: string;
};

// ---- Presence: an agent is "online" if it called Livepage recently or is waiting for requests now.
const lastSeen = new Map<string, number>();
const listening = new Map<string, number>(); // tokenId -> open long polls
export function touchAgent(who: Principal | null | undefined) {
  if (who?.kind === 'agent' && who.tokenId) lastSeen.set(who.tokenId, Date.now());
}
const isOnline = (tokenId: string) => (listening.get(tokenId) ?? 0) > 0 || Date.now() - (lastSeen.get(tokenId) ?? 0) < ONLINE_MS;

// ---- Long-poll wakeups, keyed by "token:<id>" (new work for an agent) or "req:<id>" (a request changed).
const waiters = new Map<string, Set<() => void>>();
function wake(key: string) {
  const set = waiters.get(key);
  if (!set) return;
  waiters.delete(key);
  for (const fn of set) fn();
}
function wait(key: string, ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); waiters.get(key)?.delete(done); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    let set = waiters.get(key);
    if (!set) waiters.set(key, (set = new Set()));
    set.add(done);
    signal?.addEventListener('abort', done);
  });
}
const waitMs = (url: URL) => Math.min(MAX_WAIT, Math.max(0, Number(url.searchParams.get('wait') ?? 0) * 1000 || 0));
function closeSignal(req: IncomingMessage, res: ServerResponse): AbortSignal {
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  req.on('aborted', () => ac.abort());
  return ac.signal;
}

const COLS = `r.id, r.page_id, p.title as page_title, r.tab, r.prompt, r.selection, r.history, r.status, r.progress, r.reply,
  r.created_at, r.claimed_at, r.done_at, r.token_id, t.name as agent_name`;
const FROM = 'agent_requests r join pages p on p.id = r.page_id join api_tokens t on t.id = r.token_id';

async function getRequest(db: Db, id: string): Promise<(AgentRequest & { user_id: string }) | null> {
  const [row] = await db.query(`select ${COLS}, r.user_id from ${FROM} where r.id = $1`, [id]);
  return row ?? null;
}

/** People: list your agents with online status. */
export async function listAgents(db: Db, userId: string) {
  const rows = await db.query('select id, name, last_used_at from api_tokens where user_id = $1 order by created_at desc', [userId]);
  return rows.map((t) => ({ id: t.id, name: t.name, online: isOnline(t.id), last_used_at: t.last_used_at }));
}

export async function handleAgentRequests(req: IncomingMessage, res: ServerResponse, db: Db, who: Principal, url: URL, path: string): Promise<boolean> {
  const method = req.method ?? 'GET';

  if (path === '/api/agents' && method === 'GET') {
    if (who.kind !== 'human') { send(res, 403, { error: 'For people only.' }); return true; }
    send(res, 200, { agents: await listAgents(db, who.id) });
    return true;
  }

  // ---- Agent side: pick up work
  if (path === '/api/agent-requests' && method === 'GET') {
    if (who.kind !== 'agent' || !who.tokenId) { send(res, 403, { error: 'Use a personal agent token (lp_...).' }); return true; }
    const tokenId = who.tokenId;
    const claim = () => db.query(
      `update agent_requests set status = 'working', claimed_at = now()
        where token_id = $1 and status = 'pending' returning id`, [tokenId]);
    listening.set(tokenId, (listening.get(tokenId) ?? 0) + 1);
    try {
      let ids = (await claim()).map((r) => r.id as string);
      const ms = waitMs(url);
      if (!ids.length && ms) {
        await wait(`token:${tokenId}`, ms, closeSignal(req, res));
        if (!res.writableEnded && !res.destroyed) ids = (await claim()).map((r) => r.id as string);
      }
      lastSeen.set(tokenId, Date.now());
      for (const id of ids) wake(`req:${id}`);
      const requests = ids.length ? await db.query(`select ${COLS} from ${FROM} where r.id = any($1) order by r.created_at`, [ids]) : [];
      if (!res.writableEnded && !res.destroyed) send(res, 200, { requests });
    } finally {
      listening.set(tokenId, (listening.get(tokenId) ?? 1) - 1);
    }
    return true;
  }

  const reply = path.match(/^\/api\/agent-requests\/(ar_[\w-]+)\/reply$/);
  if (reply && method === 'POST') {
    if (who.kind !== 'agent' || !who.tokenId) { send(res, 403, { error: 'Use a personal agent token (lp_...).' }); return true; }
    const r = await getRequest(db, reply[1]);
    if (!r || r.token_id !== who.tokenId) { send(res, 404, { error: 'Request not found.' }); return true; }
    if (r.status === 'cancelled') { send(res, 409, { error: 'The person cancelled this request. Stop working on it.' }); return true; }
    const b = await readJson(req);
    const text = String(b.text ?? '').trim();
    if (b.done === false) {
      await db.query(`update agent_requests set progress = $2, status = 'working' where id = $1`, [r.id, text.slice(0, LIMITS.progress)]);
    } else {
      await db.query(`update agent_requests set reply = $2, status = 'done', done_at = now() where id = $1`, [r.id, text.slice(0, LIMITS.reply)]);
    }
    wake(`req:${r.id}`);
    send(res, 200, { ok: true });
    return true;
  }

  // ---- Person side: follow or cancel a request
  const one = path.match(/^\/api\/agent-requests\/(ar_[\w-]+)$/);
  if (one) {
    if (who.kind !== 'human') { send(res, 403, { error: 'For people only.' }); return true; }
    let r = await getRequest(db, one[1]);
    if (!r || r.user_id !== who.id) { send(res, 404, { error: 'Request not found.' }); return true; }
    if (method === 'DELETE') {
      if (r.status === 'pending' || r.status === 'working') {
        await db.query(`update agent_requests set status = 'cancelled', done_at = now() where id = $1`, [r.id]);
        wake(`req:${r.id}`);
      }
      send(res, 200, { ok: true });
      return true;
    }
    if (method === 'GET') {
      const since = url.searchParams.get('since') ?? '';
      const sig = (x: AgentRequest) => `${x.status}|${x.progress}|${x.reply.length}`;
      const ms = waitMs(url);
      if (ms && sig(r) === since && (r.status === 'pending' || r.status === 'working')) {
        await wait(`req:${r.id}`, ms, closeSignal(req, res));
        r = (await getRequest(db, r.id)) ?? r;
      }
      if (!res.writableEnded && !res.destroyed) {
        const { user_id: _u, history: _h, ...rest } = r;
        send(res, 200, { request: { ...rest, sig: sig(r), agent_online: isOnline(r.token_id) } });
      }
      return true;
    }
  }
  return false;
}

/** POST /api/pages/:page/agent-requests (person, editor of the page). */
export async function createAgentRequest(req: IncomingMessage, res: ServerResponse, db: Db, who: Principal, pageId: string) {
  if (who.kind !== 'human' || who.superAgent) return send(res, 403, { error: 'For people only.' });
  if (!canEdit(await roleFor(db, who, pageId))) return send(res, 403, { error: 'You can view this page but not edit it.' });
  const b = await readJson(req);
  const [token] = await db.query('select id, name from api_tokens where id = $1 and user_id = $2', [String(b.tokenId ?? ''), who.id]);
  if (!token) return send(res, 404, { error: 'That agent is not one of yours. Create one under Agents on your home page.' });
  const prompt = String(b.prompt ?? '').trim();
  if (!prompt) return send(res, 400, { error: 'Ask something first.' });
  const [{ n }] = await db.query(`select count(*)::int as n from agent_requests where token_id = $1 and status = 'pending'`, [token.id]);
  if (n >= LIMITS.pendingPerToken) return send(res, 429, { error: `${token.name} already has ${n} requests waiting. Is it listening?` });
  const history = Array.isArray(b.history)
    ? b.history.filter((h: any) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.text === 'string')
        .slice(-12).map((h: any) => ({ role: h.role, text: h.text.slice(0, 4000) }))
    : [];
  const id = randomId('ar', 10);
  const tab = typeof b.tab === 'string' && /^[\w-]{1,64}$/.test(b.tab) ? b.tab : 'main';
  await db.query(
    'insert into agent_requests (id, user_id, token_id, page_id, tab, prompt, selection, history) values ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, who.id, token.id, pageId, tab, prompt.slice(0, LIMITS.prompt), String(b.selection ?? '').slice(0, LIMITS.selection), JSON.stringify(history)],
  );
  wake(`token:${token.id}`);
  const r = (await getRequest(db, id))!;
  const { user_id: _u, history: _h, ...rest } = r;
  send(res, 201, { request: { ...rest, sig: `${r.status}|${r.progress}|0`, agent_online: isOnline(token.id) } });
}
