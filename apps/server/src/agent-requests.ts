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
//     GET    /api/agents                                -> { agents: your agent tokens + online status, target, saved }
//     PUT    /api/agents/target                         { target: 'builtin' | <token id> } -> who answers Ask AI and @AI
//     PUT    /api/agents/task-target                    { target: <token id> | 'any' | null } -> who new tasks go to by default
//     POST   /api/pages/:page/agent-requests            { tokenId, prompt, tab?, selection? } -> { request }
//                                                       (question and answer also go in the page's Ask AI chat, chats.ts)
//     GET    /api/agent-requests/:id?wait=25            -> { request } (returns early when it changes)
//     DELETE /api/agent-requests/:id                    -> cancel
//   Agent (Bearer lp_ token)
//     GET    /api/agent-requests?wait=20                -> { requests, mentions, tasks } pending for this token, now delivered
//                                                       (mentions: comments that @mention it, or @AI when the person picked it)
//                                                       (tasks: from the task board, tasks.ts; confirm with POST /api/tasks/:id/ack)
//   New requests are also pushed to the agent's event stream and webhook (agent-push.ts).
//     POST   /api/agent-requests/:id/ack                -> confirms the agent received it (status working)
//     POST   /api/agent-requests/:id/reply              { text, done? }  (done=false: progress note)
//
// Delivery is a lease, not a hand-off. A long poll can outlive whoever started it (the agent's turn
// ended, its tool call timed out, the network dropped), and if that poll claimed the request for good,
// the request would sit at "working" forever while nobody works on it. So a poll only *delivers* a
// request (claimed_at, still pending); the agent confirms it with ack (or any reply or progress note),
// which moves it to working. A delivered request nobody confirms within LEASE_MS goes back in the
// queue for the agent's next poll. That's how a follow-up in the same Ask chat always reaches it.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from './db.ts';
import { randomId, type Principal } from './auth.ts';
import { readJson, send } from './agent-api.ts';
import { canEdit, roleFor } from './pages.ts';
import { changeChat, historyOf, readChat, startExchange } from './chats.ts';
import { plainBody } from '@livepage/schema';
import { pushToAgent, streamCount } from './agent-push.ts';
import { claimTasks } from './tasks.ts';
import { bumpTasks } from './workspace-events.ts';
import { config } from './config.ts';

const ONLINE_MS = 2 * 60_000;
const MAX_WAIT = 30_000;
const LEASE_MS = 45_000; // a delivered but unconfirmed request is offered again after this
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
// "Listening" is stricter than online: the agent is waiting for work right now (a wait_for_requests long poll or
// an event stream is open), or its last poll ended a moment ago and its loop is about to call again. An agent that
// made one call and stopped is online for a while but will never pick a task up; the board says so.
const LISTEN_GAP_MS = 60_000;
const lastListen = new Map<string, number>(); // tokenId -> when its last long poll ended
/** Agents whose loop takes tasks but never confirms them (each lease runs out), so they aren't really picking work up. */
const unconfirming = new Set<string>();
export const isUnconfirming = (tokenId: string) => unconfirming.has(tokenId);
export function setUnconfirming(tokenId: string, userId: string, on: boolean) {
  if (unconfirming.has(tokenId) === on) return;
  if (on) unconfirming.add(tokenId); else unconfirming.delete(tokenId);
  bumpTasks(userId);
}
/** Will it pick work up now: listening, and confirming what it takes. */
export const isReady = (tokenId: string) => isListening(tokenId) && !unconfirming.has(tokenId);
export const isListening = (tokenId: string) =>
  (listening.get(tokenId) ?? 0) > 0 || streamCount(tokenId) > 0 || Date.now() - (lastListen.get(tokenId) ?? 0) < LISTEN_GAP_MS;
/** Where an agent is, for the people who hand it work. */
export function presenceOf(tokenId: string, lastUsedAt?: string | Date | null) {
  const seen = Math.max(lastSeen.get(tokenId) ?? 0, lastUsedAt ? new Date(lastUsedAt).getTime() : 0);
  const listen = lastListen.get(tokenId);
  return {
    listening: isReady(tokenId),
    unconfirmed: unconfirming.has(tokenId),
    last_seen_at: seen ? new Date(seen).toISOString() : null,
    last_listen_at: (listening.get(tokenId) ?? 0) > 0 || streamCount(tokenId) > 0 ? new Date().toISOString() : listen ? new Date(listen).toISOString() : null,
  };
}
/** An agent started or stopped listening: its person's open boards show it (the tasks counter). */
export function listeningChanged(tokenId: string, userId: string, was: boolean) {
  const now = isListening(tokenId);
  // A fresh start (after a pause of a minute or more) gets a clean slate: it may be a fixed loop.
  if (now && !was) unconfirming.delete(tokenId);
  if (now !== was) bumpTasks(userId);
}
/** Waiting for work this moment (an open long poll or event stream), without the grace gap: whether to wake a cloud agent. */
export const isWaitingNow = (tokenId: string) => (listening.get(tokenId) ?? 0) > 0 || streamCount(tokenId) > 0;
export const isOnline = (tokenId: string) => (listening.get(tokenId) ?? 0) > 0 || streamCount(tokenId) > 0 || Date.now() - (lastSeen.get(tokenId) ?? 0) < ONLINE_MS;

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
/** New work for an agent outside this file (a comment mention): end its wait_for_requests long poll. */
export const wakeAgent = (tokenId: string) => wake(`token:${tokenId}`);
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

/** Where a request is: queued (not picked up), delivered (a poll took it, the agent hasn't confirmed),
 *  working (the agent confirmed or replied), or finished. Lease expiry turns delivered back into queued. */
function delivery(r: AgentRequest): 'queued' | 'delivered' | 'working' | 'finished' {
  if (r.status === 'done' || r.status === 'cancelled') return 'finished';
  if (r.status === 'working') return 'working';
  return r.claimed_at && Date.now() - new Date(r.claimed_at).getTime() < LEASE_MS ? 'delivered' : 'queued';
}
const signature = (r: AgentRequest) => `${r.status}|${delivery(r)}|${r.progress}|${r.reply.length}`;
function forPerson(r: AgentRequest & { user_id?: string }) {
  const { user_id: _u, history: _h, ...rest } = r;
  return { ...rest, delivery: delivery(r), sig: signature(r), agent_online: isOnline(r.token_id) };
}

/** What the Ask AI chat shows while an agent has the request. */
function statusFor(r: AgentRequest): string {
  const name = r.agent_name || 'Your agent';
  const d = delivery(r);
  if (r.status === 'working') return r.progress ? `${name}: ${r.progress}` : `${name} is working on it…`;
  if (r.status !== 'pending') return '';
  if (d === 'delivered') return `Sent to ${name}, waiting for it to confirm…`;
  return isOnline(r.token_id) ? `Waiting for ${name} to pick it up…`
    : `${name} isn't listening right now. Ask it to “listen for Livepage requests”; this request waits for it.`;
}

/** A request changed: wake whoever follows it, and update its answer in the person's Ask AI chat. */
function changed(db: Db, id: string) {
  wake(`req:${id}`);
  void (async () => {
    const r = await getRequest(db, id);
    if (!r) return;
    const finished = r.status === 'done' || r.status === 'cancelled';
    await changeChat(db, r.user_id, r.page_id, (turns) => {
      const t = turns.find((x) => x.requestId === id);
      if (!t) return;
      t.model = r.agent_name || t.model;
      t.status = statusFor(r);
      t.running = !finished;
      if (r.status === 'done') t.text = r.reply || `${r.agent_name || 'The agent'} finished without a message.`;
      if (r.status === 'cancelled') t.error = 'Cancelled.';
    }, finished);
  })().catch((e) => console.warn('[agent-requests] chat update failed:', (e as Error).message));
}

export const BUILTIN = 'builtin';

/** Who this person picked in the Ask menu: 'builtin', or one of their own agent token ids. */
export async function getAskTarget(db: Db, userId: string): Promise<string> {
  const [row] = await db.query(
    `select u.ask_target, t.id as token_id from users u left join api_tokens t on t.id = u.ask_target and t.user_id = u.id where u.id = $1`, [userId]);
  return row?.token_id ?? BUILTIN; // a deleted token falls back to the built-in assistant
}

/** Comment mentions for this agent that its listen loop hasn't been handed yet. Marks them handed over. */
async function claimMentions(db: Db, who: Principal) {
  const ids = (await db.query(
    `update comment_mentions set delivered_at = now()
      where target_kind = 'agent' and target_id = $1 and handled_at is null and delivered_at is null returning id`, [who.tokenId])).map((r) => r.id as string);
  if (!ids.length) return [];
  return db.query(
    `select mn.id, mn.page_id, p.title as page_title, mn.thread_id, r.tab, c.author_name, c.body, r.anchor
       from comment_mentions mn
       join comments c on c.id = mn.comment_id
       join comments r on r.id = mn.thread_id
       join pages p on p.id = mn.page_id
       join page_members m on m.page_id = mn.page_id and m.user_id = $2
      where mn.id = any($1) order by mn.created_at`, [ids, who.id]).then((rows) => rows.map((r) => ({
    id: r.id, page_id: r.page_id, page_title: r.page_title || 'Untitled', thread_id: r.thread_id, tab: r.tab,
    author_name: r.author_name, text: plainBody(r.body), quote: r.anchor?.quote ?? null,
  })));
}

/** People: list your agents with online status. */
export async function listAgents(db: Db, userId: string) {
  const rows = await db.query(
    `select t.id, t.name, t.last_used_at, w.provider as wake_provider, w.events as wake_events
       from api_tokens t left join agent_wake_configs w on w.token_id = t.id where t.user_id = $1 order by t.created_at desc`, [userId]);
  return rows.map((t) => ({
    id: t.id, name: t.name, online: isOnline(t.id), last_used_at: t.last_used_at, ...presenceOf(t.id, t.last_used_at),
    // A cloud agent (agent-wake.ts) that starts a session for tasks when it isn't listening: it takes work any time.
    wakes: t.wake_provider && String(t.wake_events).split(',').includes('tasks') ? (t.wake_provider === 'devin' ? 'Devin' : t.wake_provider) : null,
  }));
}

export const ANY_AGENT = 'any';
/** Who new tasks go to by default: the saved pick (if that agent still exists), else an agent that wakes for tasks (a cloud agent is always reachable), else none. */
export async function getTaskTarget(db: Db, userId: string, agents: { id: string; wakes: string | null }[]): Promise<{ target: string | null; saved: boolean }> {
  const [row] = await db.query('select task_target from users where id = $1', [userId]);
  const saved = row?.task_target as string | null;
  if (saved === ANY_AGENT && agents.length > 1) return { target: ANY_AGENT, saved: true };
  if (saved && agents.some((a) => a.id === saved)) return { target: saved, saved: true };
  return { target: agents.find((a) => a.wakes)?.id ?? null, saved: false };
}

export async function handleAgentRequests(req: IncomingMessage, res: ServerResponse, db: Db, who: Principal, url: URL, path: string): Promise<boolean> {
  const method = req.method ?? 'GET';

  if (path === '/api/agents' && method === 'GET') {
    if (who.kind !== 'human') { send(res, 403, { error: 'For people only.' }); return true; }
    const [agents, target, [row]] = await Promise.all([listAgents(db, who.id), getAskTarget(db, who.id),
      db.query('select ask_target from users where id = $1', [who.id])]);
    const task = await getTaskTarget(db, who.id, agents);
    // saved=false: never picked on any device yet, so a browser may send the pick it remembers from before.
    send(res, 200, { agents, target, saved: row?.ask_target != null, task_target: task.target, task_target_saved: task.saved });
    return true;
  }
  // The default agent for new tasks (the task form starts on it), saved per person so every device agrees.
  if (path === '/api/agents/task-target' && method === 'PUT') {
    if (who.kind !== 'human' || who.superAgent) { send(res, 403, { error: 'For people only.' }); return true; }
    const b = await readJson(req);
    const target = b.target == null ? null : String(b.target);
    if (target && target !== ANY_AGENT) {
      const [tok] = await db.query('select id from api_tokens where id = $1 and user_id = $2', [target, who.id]);
      if (!tok) { send(res, 404, { error: 'That agent is not one of yours.' }); return true; }
    }
    await db.query('update users set task_target = $2 where id = $1', [who.id, target]);
    bumpTasks(who.id); // open boards on your other devices pick it up
    send(res, 200, { task_target: target });
    return true;
  }
  if (path === '/api/agents/target' && method === 'PUT') {
    if (who.kind !== 'human' || who.superAgent) { send(res, 403, { error: 'For people only.' }); return true; }
    const b = await readJson(req);
    const target = String(b.target ?? BUILTIN);
    if (target !== BUILTIN) {
      const [tok] = await db.query('select id from api_tokens where id = $1 and user_id = $2', [target, who.id]);
      if (!tok) { send(res, 404, { error: 'That agent is not one of yours.' }); return true; }
    }
    await db.query('update users set ask_target = $2 where id = $1', [who.id, target]);
    send(res, 200, { target });
    return true;
  }

  // ---- Agent side: pick up work
  if (path === '/api/agent-requests' && method === 'GET') {
    if (who.kind !== 'agent' || !who.tokenId) { send(res, 403, { error: 'Use a personal agent token (lp_...).' }); return true; }
    const tokenId = who.tokenId;
    const claim = () => db.query(
      `update agent_requests set claimed_at = now()
        where token_id = $1 and status = 'pending'
          and (claimed_at is null or claimed_at < now() - ($2::int * interval '1 millisecond'))
        returning id`, [tokenId, LEASE_MS]);
    const was = isListening(tokenId);
    listening.set(tokenId, (listening.get(tokenId) ?? 0) + 1);
    listeningChanged(tokenId, who.id, was);
    try {
      let ids = (await claim()).map((r) => r.id as string);
      let mentions = await claimMentions(db, who);
      let tasks = await claimTasks(db, tokenId, who.id);
      const ms = waitMs(url);
      if (!ids.length && !mentions.length && !tasks.length && ms) {
        await wait(`token:${tokenId}`, ms, closeSignal(req, res));
        if (!res.writableEnded && !res.destroyed) {
          ids = (await claim()).map((r) => r.id as string);
          mentions = await claimMentions(db, who);
          tasks = await claimTasks(db, tokenId, who.id);
        }
      }
      lastSeen.set(tokenId, Date.now());
      for (const id of ids) {
        changed(db, id);
        // If this delivery is never confirmed, offer it again: wake this token's next poll and the person's panel.
        setTimeout(() => { wake(`token:${tokenId}`); changed(db, id); }, LEASE_MS + 1000).unref?.();
      }
      const requests = ids.length ? await db.query(`select ${COLS} from ${FROM} where r.id = any($1) order by r.created_at`, [ids]) : [];
      if (!res.writableEnded && !res.destroyed) send(res, 200, { requests, mentions, tasks });
      else {
        if (mentions.length) await db.query('update comment_mentions set delivered_at = null where id = any($1)', [mentions.map((m) => m.id)]);
        if (tasks.length) await db.query('update agent_tasks set delivered_at = null where id = any($1)', [tasks.map((t) => t.id)]);
      }
    } finally {
      listening.set(tokenId, (listening.get(tokenId) ?? 1) - 1);
      lastListen.set(tokenId, Date.now());
      // If the loop doesn't call again, the agent has stopped listening: tell the board once the gap has passed.
      setTimeout(() => listeningChanged(tokenId, who.id, true), LISTEN_GAP_MS + 500).unref?.();
    }
    return true;
  }

  const ack = path.match(/^\/api\/agent-requests\/(ar_[\w-]+)\/ack$/);
  if (ack && method === 'POST') {
    if (who.kind !== 'agent' || !who.tokenId) { send(res, 403, { error: 'Use a personal agent token (lp_...).' }); return true; }
    const r = await getRequest(db, ack[1]);
    if (!r || r.token_id !== who.tokenId) { send(res, 404, { error: 'Request not found.' }); return true; }
    if (r.status === 'cancelled') { send(res, 409, { error: 'The person cancelled this request. Stop working on it.' }); return true; }
    if (r.status === 'pending') {
      await db.query(`update agent_requests set status = 'working', claimed_at = coalesce(claimed_at, now()) where id = $1 and status = 'pending'`, [r.id]);
      changed(db, r.id);
    }
    send(res, 200, { ok: true });
    return true;
  }

  const reply = path.match(/^\/api\/agent-requests\/(ar_[\w-]+)\/reply$/);
  if (reply && method === 'POST') {
    if (who.kind !== 'agent' || !who.tokenId) { send(res, 403, { error: 'Use a personal agent token (lp_...).' }); return true; }
    const r = await getRequest(db, reply[1]);
    if (!r || r.token_id !== who.tokenId) { send(res, 404, { error: 'Request not found.' }); return true; }
    if (r.status === 'cancelled') { send(res, 409, { error: 'The person cancelled this request. Stop working on it.' }); return true; }
    if (r.status === 'done') { send(res, 409, { error: 'This request is already answered. Wait for the next one with wait_for_requests.' }); return true; }
    const b = await readJson(req);
    const text = String(b.text ?? '').trim();
    if (b.done === false) {
      await db.query(`update agent_requests set progress = $2, status = 'working', claimed_at = coalesce(claimed_at, now()) where id = $1`, [r.id, text.slice(0, LIMITS.progress)]);
    } else {
      await db.query(`update agent_requests set reply = $2, status = 'done', claimed_at = coalesce(claimed_at, now()), done_at = now() where id = $1`, [r.id, text.slice(0, LIMITS.reply)]);
    }
    changed(db, r.id);
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
        changed(db, r.id);
      }
      send(res, 200, { ok: true });
      return true;
    }
    if (method === 'GET') {
      const since = url.searchParams.get('since') ?? '';
      const sig = signature;
      const ms = waitMs(url);
      if (ms && sig(r) === since && (r.status === 'pending' || r.status === 'working')) {
        await wait(`req:${r.id}`, ms, closeSignal(req, res));
        r = (await getRequest(db, r.id)) ?? r;
      }
      if (!res.writableEnded && !res.destroyed) {
        send(res, 200, { request: forPerson(r) });
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
  // The earlier turns of this page's Ask AI chat, from the server, so a follow-up asked on another device has them too.
  const chat = await readChat(db, who.id, pageId);
  if (chat.running) return send(res, 409, { error: 'Still waiting on your last question. Wait for it, or stop it.' });
  const history = historyOf(chat.turns).slice(-12);
  const id = randomId('ar', 10);
  const tab = typeof b.tab === 'string' && /^[\w-]{1,64}$/.test(b.tab) ? b.tab : 'main';
  await db.query(
    'insert into agent_requests (id, user_id, token_id, page_id, tab, prompt, selection, history) values ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, who.id, token.id, pageId, tab, prompt.slice(0, LIMITS.prompt), String(b.selection ?? '').slice(0, LIMITS.selection), JSON.stringify(history)],
  );
  const r = (await getRequest(db, id))!;
  await startExchange(db, who.id, pageId, { prompt, selection: String(b.selection ?? '').slice(0, LIMITS.selection) },
    { kind: 'agent', requestId: id, model: token.name, status: statusFor(r) });
  wake(`token:${token.id}`);
  pushToAgent(db, token.id, 'request.created',
    `${who.name} asked you in Ask AI on page ${pageId} (${r.page_title || 'Untitled'}): ${prompt.slice(0, 500)}\nTake it with wait_for_requests (wait_seconds 0), then answer with reply_to_request.`,
    {
      request: { id, prompt: prompt.slice(0, LIMITS.prompt), selection: r.selection, tab, follow_up: history.length > 0 },
      page: { id: pageId, title: r.page_title || 'Untitled', url: `${config.publicUrl}/p/${pageId}` },
      take_with: { mcp: 'wait_for_requests { wait_seconds: 0 }', http: `GET ${config.publicUrl}/api/agent-requests  (then POST /api/agent-requests/${id}/ack)` },
    });
  send(res, 201, { request: forPerson(r) });
}
