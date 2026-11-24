// The task board: hand a job to one of your agents and follow it.
//
// A task is a title and instructions (optionally about a page) assigned to one of your agent tokens.
// The agent gets it the same way as Ask AI requests: pushed to its event stream and webhook
// (agent-push.ts), and delivered on a lease by wait_for_requests. It reports with update_task: progress
// notes, "needs you" with a question, done or failed with a summary. Pages it edits while working on
// a task are listed on the task by themselves (noteAgentEdit, called from the live document's onChange).
//
//   Person (session cookie)
//     GET    /api/tasks                            -> { tasks, rev }  (the board follows rev on /api/workspace/events)
//     POST   /api/tasks                            { title, details?, token_id ('any' = any available agent), page_id? } -> { task }
//     GET    /api/tasks/:id                        -> { task, events }
//     PATCH  /api/tasks/:id                        { title?, details?, token_id?, status?: queued|cancelled|done }
//     POST   /api/tasks/:id/messages               { text }  answer the agent; a finished task goes back to it
//     DELETE /api/tasks/:id
//   Agent (Bearer lp_ token)
//     GET    /api/tasks?all=1                      -> { tasks } assigned to this agent (open ones unless all=1)
//     GET    /api/tasks/:id                        -> { task, events }
//     POST   /api/tasks/:id/ack                    confirms a delivered task (status working)
//     POST   /api/tasks/:id/update                 { status?: working|needs_you|done|failed, note?, pages? }
//                                                  -> { ok, messages } (anything the person wrote since you last looked)
//   GET /api/agent-requests (wait_for_requests) also returns { tasks } delivered to the agent.
//
// Statuses: queued (waiting for the agent) -> working -> needs_you | done | failed. The person can
// answer (back to queued with their message), reopen or retry, cancel, or mark done.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from './db.ts';
import { randomId, type Principal } from './auth.ts';
import { readJson, send } from './agent-api.ts';
import { config } from './config.ts';
import { roleFor, isPageId } from './pages.ts';
import { pushToAgent } from './agent-push.ts';
import { bumpTasks, tasksRev } from './workspace-events.ts';
import { isListening, isOnline, isReady, isUnconfirming, presenceOf, setUnconfirming, wakeAgent } from './agent-requests.ts';

export type TaskStatus = 'queued' | 'working' | 'needs_you' | 'done' | 'failed' | 'cancelled';
const AGENT_STATUSES = new Set<TaskStatus>(['working', 'needs_you', 'done', 'failed']);
const PERSON_STATUSES = new Set<TaskStatus>(['queued', 'cancelled', 'done']);
/** Deliveries without a confirmation before a task counts as "delivered but not confirmed" (two leases ran out). */
export const UNCONFIRMED_AFTER = 3;
const LEASE_MS = 45_000; // same as Ask requests: a delivered task nobody confirms is offered again
export const TASK_LIMITS = { title: 200, details: 8000, note: 2000, message: 4000, openPerToken: 50, pages: 20 };

type TaskRow = {
  id: string; user_id: string; token_id: string | null; any_agent: boolean; agent_name: string | null; agent_last_used: string | null; title: string; details: string;
  page_id: string | null; page_title: string | null; status: TaskStatus; note: string;
  delivered_at: string | null; delivered_to: string | null; delivered_to_name: string | null; delivery_count: number; agent_seen_at: string | null; last_message_at: string | null;
  created_at: string; updated_at: string; done_at: string | null;
};
export type TaskEvent = {
  id: string; kind: 'created' | 'note' | 'status' | 'message' | 'page' | 'assigned';
  author_kind: 'human' | 'agent' | 'system'; author_name: string; text: string; status: TaskStatus | null;
  page_id: string | null; page_title?: string | null; created_at: string;
};

const COLS = `t.id, t.user_id, t.token_id, t.any_agent, k.name as agent_name, k.last_used_at as agent_last_used, t.title, t.details, t.page_id, p.title as page_title, t.status, t.note,
  t.delivered_at, t.delivered_to, d.name as delivered_to_name, t.delivery_count, t.agent_seen_at, t.last_message_at, t.created_at, t.updated_at, t.done_at`;
const FROM = 'agent_tasks t left join api_tokens k on k.id = t.token_id left join api_tokens d on d.id = t.delivered_to left join pages p on p.id = t.page_id';

const isTaskId = (s: string) => /^tk_[\w-]{8,40}$/.test(s);
const clip = (s: unknown, n: number) => String(s ?? '').trim().slice(0, n);
export const taskUrl = (id: string) => `${config.publicUrl}/tasks?task=${id}`;

async function getTask(db: Db, id: string): Promise<TaskRow | null> {
  const [row] = await db.query<TaskRow>(`select ${COLS} from ${FROM} where t.id = $1`, [id]);
  return row ?? null;
}

async function pagesOf(db: Db, ids: string[]): Promise<Map<string, { id: string; title: string }[]>> {
  const out = new Map<string, { id: string; title: string }[]>();
  if (!ids.length) return out;
  const rows = await db.query(
    `select tp.task_id, tp.page_id, coalesce(p.title, '') as title from agent_task_pages tp join pages p on p.id = tp.page_id
      where tp.task_id = any($1) order by tp.first_at`, [ids]);
  for (const r of rows) {
    let list = out.get(r.task_id);
    if (!list) out.set(r.task_id, (list = []));
    list.push({ id: r.page_id, title: r.title });
  }
  return out;
}

/** Waiting on the agent: queued, or working with a message from the person it has not seen. */
const hasUnseenMessage = (t: TaskRow) => !!t.last_message_at && (!t.agent_seen_at || new Date(t.last_message_at) > new Date(t.agent_seen_at));
function delivery(t: TaskRow): 'queued' | 'delivered' | null {
  if (t.status !== 'queued' && !(t.status === 'working' && hasUnseenMessage(t))) return null;
  return t.delivered_at && Date.now() - new Date(t.delivered_at).getTime() < LEASE_MS ? 'delivered' : 'queued';
}

export const ANY = 'any';
const unclaimed = (t: TaskRow) => t.any_agent && !t.token_id;

function shape(t: TaskRow, pages: { id: string; title: string }[] = [], anyListening = false) {
  const { user_id: _u, delivered_at: _d, agent_seen_at: _s, agent_last_used: _l, delivered_to: _dt, delivered_to_name: _dn, delivery_count: _c, ...rest } = t;
  const p = t.token_id ? presenceOf(t.token_id, t.agent_last_used) : null;
  return {
    ...rest, agent_name: unclaimed(t) ? 'Any available agent' : t.agent_name ?? 'Removed agent', page_title: t.page_id ? t.page_title || 'Untitled' : null,
    delivery: delivery(t), agent_online: t.token_id ? isOnline(t.token_id) : false,
    // Whether anyone will pick it up now: the assigned agent is listening, or (any agent) one of yours is.
    agent_listening: p ? p.listening : unclaimed(t) && anyListening, agent_last_seen_at: p?.last_seen_at ?? null,
    // Taken again and again but never confirmed: the agent's loop is likely broken (it doesn't call ack or update_task).
    unconfirmed: t.delivery_count >= UNCONFIRMED_AFTER ? { agent_name: t.delivered_to_name ?? t.agent_name ?? 'The agent', times: t.delivery_count } : null,
    pages, url: taskUrl(t.id),
  };
}

/** Is any of this person's agents listening right now? (for "any available agent" tasks) */
async function anyListeningFor(db: Db, userId: string): Promise<boolean> {
  const rows = await db.query<{ id: string }>('select id from api_tokens where user_id = $1', [userId]);
  return rows.some((r) => isReady(r.id));
}

async function events(db: Db, taskId: string): Promise<TaskEvent[]> {
  return db.query<TaskEvent>(
    `select e.id, e.kind, e.author_kind, e.author_name, e.text, e.status, e.page_id, p.title as page_title, e.created_at
       from agent_task_events e left join pages p on p.id = e.page_id where e.task_id = $1 order by e.created_at, e.id`, [taskId]);
}

async function addEvent(db: Db, taskId: string, e: Omit<TaskEvent, 'id' | 'created_at' | 'page_title'>) {
  await db.query(
    `insert into agent_task_events (id, task_id, kind, author_kind, author_name, text, status, page_id) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [randomId('te', 10), taskId, e.kind, e.author_kind, e.author_name, e.text, e.status, e.page_id]);
}

/** The board changed for this person; also forget which task the agent is working on (noteAgentEdit). */
function changed(t: { user_id: string; token_id: string | null }) {
  bumpTasks(t.user_id);
  if (t.token_id) activeTask.delete(t.token_id);
}

/** What an agent reads about a task: instructions, page, and the conversation so far. */
function taskText(t: TaskRow, evs: TaskEvent[], from: string): string {
  const convo = evs.filter((e) => e.kind === 'message' || (e.kind === 'note' && e.text) || e.kind === 'status')
    .slice(-12).map((e) => `  ${e.author_kind === 'human' ? e.author_name : 'you'}${e.status ? ` [${e.status}]` : ''}: ${e.text || '(no note)'}`);
  return [
    `task ${t.id} from ${from}: ${t.title}`,
    t.details ? `instructions:\n${t.details}` : '',
    t.page_id ? `page: ${t.page_id} (${t.page_title || 'Untitled'})` : '',
    convo.length ? `so far:\n${convo.join('\n')}` : '',
    `report with update_task (task_id ${t.id}): a short note as you go, status needs_you with a question if you are stuck, then done or failed with a summary.`,
  ].filter(Boolean).join('\n');
}

function pushTask(db: Db, t: TaskRow, type: 'task.assigned' | 'task.message' | 'task.cancelled', personName: string, message?: string) {
  if (unclaimed(t)) {
    // Any available agent: offer it to every one of this person's agents that is listening; the first to confirm takes it.
    void db.query<{ id: string }>('select id from api_tokens where user_id = $1', [t.user_id]).then((rows) => {
      for (const { id } of rows) {
        wakeAgent(id);
        if (isListening(id)) pushTaskTo(db, id, t, type, personName, message);
      }
    }).catch(() => {});
    return;
  }
  if (!t.token_id) return;
  pushTaskTo(db, t.token_id, t, type, personName, message);
  wakeAgent(t.token_id);
}

function pushTaskTo(db: Db, tokenId: string, t: TaskRow, type: 'task.assigned' | 'task.message' | 'task.cancelled', personName: string, message?: string) {
  const text = type === 'task.cancelled'
    ? `${personName} cancelled task ${t.id} ("${t.title}"). Stop working on it.`
    : type === 'task.message'
      ? `${personName} wrote on task ${t.id} ("${t.title}"): ${message ?? ''}\nTake it with wait_for_requests (wait_seconds 0), or read it with get_task, then carry on.`
      : `New task from ${personName}: "${t.title}"${t.page_id ? ` on page ${t.page_id} (${t.page_title || 'Untitled'})` : ''}.\nTake it with wait_for_requests (wait_seconds 0), then report with update_task.`;
  pushToAgent(db, tokenId, type, text, {
    task: { id: t.id, title: t.title, details: t.details, status: t.status, url: taskUrl(t.id) },
    page: t.page_id ? { id: t.page_id, title: t.page_title || 'Untitled', url: `${config.publicUrl}/p/${t.page_id}` } : null,
    message: message ?? null,
    take_with: { mcp: 'wait_for_requests { wait_seconds: 0 }', http: `GET ${config.publicUrl}/api/agent-requests  (then POST /api/tasks/${t.id}/ack)` },
    report_with: { mcp: `update_task { task_id: "${t.id}", status, note }`, http: `POST ${config.publicUrl}/api/tasks/${t.id}/update  {"status": "...", "note": "..."}` },
  });
}

// ---- Delivery to agents (wait_for_requests)

/** Tasks waiting for this agent, marked delivered (on a lease). Returned with what the agent needs to start. */
export async function claimTasks(db: Db, tokenId: string, userId: string): Promise<{ id: string; text: string; title: string; page_id: string | null }[]> {
  const rows = await db.query<{ id: string; delivery_count: number }>(
    `update agent_tasks set delivered_at = now(), delivered_to = $1,
         delivery_count = case when delivered_to = $1 then delivery_count + 1 else 1 end
      where (token_id = $1 or (any_agent and token_id is null and user_id = $3
               -- an agent that keeps taking an open task without confirming it stops getting it, so another can
               and not ($4 and delivered_to = $1 and delivery_count >= ${UNCONFIRMED_AFTER})))
        and (status = 'queued' or (status = 'working' and last_message_at is not null and (agent_seen_at is null or last_message_at > agent_seen_at)))
        and (delivered_at is null or delivered_at < now() - ($2::int * interval '1 millisecond'))
      returning id, delivery_count`, [tokenId, LEASE_MS, userId, isUnconfirming(tokenId)]);
  if (rows.some((r) => r.delivery_count >= UNCONFIRMED_AFTER)) setUnconfirming(tokenId, userId, true);
  const out = [];
  for (const { id } of rows) {
    const t = await getTask(db, id);
    if (!t) continue;
    const [owner] = await db.query('select name from users where id = $1', [t.user_id]);
    out.push({ id, title: t.title, page_id: t.page_id, text: taskText(t, await events(db, id), owner?.name ?? 'your person') });
    // Not confirmed in time: offer it again on the agent's next poll.
    setTimeout(() => { wakeAgent(tokenId); bumpTasks(t.user_id); }, LEASE_MS + 1000).unref?.();
    bumpTasks(t.user_id);
  }
  return out;
}

// ---- Pages touched: an agent editing a page while it works on a task

const activeTask = new Map<string, { taskId: string | null; userId: string; at: number }>(); // tokenId -> its working task
const recorded = new Set<string>(); // `${taskId}:${pageId}` already listed

/** Called for every live edit. Cheap when the editor is a person or an agent with no working task. */
export function noteAgentEdit(db: Db, pageId: string, user: { kind?: string; tokenId?: string } | undefined) {
  if (user?.kind !== 'agent' || !user.tokenId) return;
  const tokenId = user.tokenId;
  void (async () => {
    let a = activeTask.get(tokenId);
    if (!a || Date.now() - a.at > 60_000) {
      const [row] = await db.query(
        `select id, user_id from agent_tasks where token_id = $1 and status = 'working' order by updated_at desc limit 1`, [tokenId]);
      a = { taskId: row?.id ?? null, userId: row?.user_id ?? '', at: Date.now() };
      activeTask.set(tokenId, a);
    }
    if (!a.taskId) return;
    const key = `${a.taskId}:${pageId}`;
    if (recorded.has(key)) return;
    recorded.add(key);
    if (recorded.size > 5000) recorded.clear();
    const added = await db.query(
      'insert into agent_task_pages (task_id, page_id) values ($1, $2) on conflict do nothing returning page_id', [a.taskId, pageId]);
    if (added.length) bumpTasks(a.userId);
  })().catch((e) => console.warn('[tasks] page touched:', (e as Error).message));
}

async function addPages(db: Db, who: Principal, t: TaskRow, ids: unknown): Promise<number> {
  if (!Array.isArray(ids)) return 0;
  let n = 0;
  for (const raw of ids.slice(0, TASK_LIMITS.pages)) {
    const id = String(raw);
    if (!isPageId(id) || !(await roleFor(db, who, id))) continue;
    n += (await db.query('insert into agent_task_pages (task_id, page_id) values ($1, $2) on conflict do nothing returning page_id', [t.id, id])).length;
  }
  return n;
}

// ---- HTTP

export async function handleTasks(req: IncomingMessage, res: ServerResponse, db: Db, who: Principal, url: URL, path: string): Promise<boolean> {
  const method = req.method ?? 'GET';
  const isAgent = who.kind === 'agent' && !!who.tokenId;
  const isPerson = who.kind === 'human' && !who.superAgent;
  if (!isAgent && !isPerson) { send(res, 403, { error: 'Use your account or a personal agent token (lp_...).' }); return true; }

  if (path === '/api/tasks' && method === 'GET') {
    if (isAgent) {
      const all = url.searchParams.get('all') === '1';
      const rows = await db.query<TaskRow>(
        `select ${COLS} from ${FROM} where (t.token_id = $1 or (t.any_agent and t.token_id is null and t.user_id = $2))
           ${all ? '' : `and t.status in ('queued','working','needs_you')`} order by t.created_at desc limit 100`, [who.tokenId, who.id]);
      const pages = await pagesOf(db, rows.map((r) => r.id));
      send(res, 200, { tasks: rows.map((r) => shape(r, pages.get(r.id))) });
      return true;
    }
    const rev = tasksRev(who.id);
    const rows = await db.query<TaskRow>(
      `select ${COLS} from ${FROM} where t.user_id = $1
         and (t.status not in ('done','failed','cancelled') or t.updated_at > now() - interval '30 days')
       order by t.updated_at desc limit 300`, [who.id]);
    const pages = await pagesOf(db, rows.map((r) => r.id));
    const anyListening = await anyListeningFor(db, who.id);
    send(res, 200, { tasks: rows.map((r) => shape(r, pages.get(r.id), anyListening)), rev });
    return true;
  }

  if (path === '/api/tasks' && method === 'POST') {
    if (!isPerson) { send(res, 403, { error: 'People hand out tasks; agents report on them with update_task.' }); return true; }
    const b = await readJson(req);
    const title = clip(b.title, TASK_LIMITS.title);
    if (!title) { send(res, 400, { error: 'Give the task a title.' }); return true; }
    const any = b.token_id === ANY;
    const [token] = any
      ? [{ id: null, name: 'Any available agent' }]
      : await db.query('select id, name from api_tokens where id = $1 and user_id = $2', [String(b.token_id ?? ''), who.id]);
    if (!token) { send(res, 404, { error: 'Pick one of your agents. Make one under Agents on your home page.' }); return true; }
    if (any && !(await db.query('select 1 from api_tokens where user_id = $1 limit 1', [who.id])).length) {
      send(res, 404, { error: 'Make an agent token under Agents on your home page first.' }); return true;
    }
    const pageId = b.page_id ? String(b.page_id) : null;
    if (pageId && !(isPageId(pageId) && (await roleFor(db, who, pageId)))) { send(res, 404, { error: 'That page is not one you can open.' }); return true; }
    const [{ n }] = any
      ? await db.query(`select count(*)::int as n from agent_tasks where user_id = $1 and any_agent and token_id is null and status = 'queued'`, [who.id])
      : await db.query(`select count(*)::int as n from agent_tasks where token_id = $1 and status in ('queued','working','needs_you')`, [token.id]);
    if (n >= TASK_LIMITS.openPerToken) { send(res, 429, { error: `${token.name} already has ${n} open tasks.` }); return true; }
    const id = randomId('tk', 10);
    await db.query(
      'insert into agent_tasks (id, user_id, token_id, title, details, page_id, any_agent) values ($1,$2,$3,$4,$5,$6,$7)',
      [id, who.id, token.id, title, clip(b.details, TASK_LIMITS.details), pageId, any]);
    if (pageId) await db.query('insert into agent_task_pages (task_id, page_id) values ($1, $2) on conflict do nothing', [id, pageId]);
    await addEvent(db, id, { kind: 'created', author_kind: 'human', author_name: who.name, text: '', status: 'queued', page_id: null });
    const t = (await getTask(db, id))!;
    changed(t);
    pushTask(db, t, 'task.assigned', who.name);
    send(res, 201, { task: shape(t, (await pagesOf(db, [id])).get(id), unclaimed(t) && (await anyListeningFor(db, t.user_id))) });
    return true;
  }

  const m = path.match(/^\/api\/tasks\/([\w-]+)(?:\/(ack|update|messages))?$/);
  if (!m || !isTaskId(m[1])) return false;
  const [, id, action] = m;
  const t = await getTask(db, id);
  const mine = t && (isAgent ? t.token_id === who.tokenId || (unclaimed(t) && t.user_id === who.id) : t.user_id === who.id);
  if (!t || !mine) { send(res, 404, { error: 'Task not found.' }); return true; }

  if (!action && method === 'GET') {
    if (isAgent) await db.query('update agent_tasks set agent_seen_at = now() where id = $1', [id]);
    send(res, 200, { task: shape(t, (await pagesOf(db, [id])).get(id), unclaimed(t) && (await anyListeningFor(db, t.user_id))), events: await events(db, id) });
    return true;
  }

  // ---- Agent: confirm and report
  if (action === 'ack' || action === 'update') {
    if (!isAgent || method !== 'POST') { send(res, 403, { error: 'For the agent the task is assigned to.' }); return true; }
    if (t.status === 'cancelled') { send(res, 409, { error: 'The person cancelled this task. Stop working on it.' }); return true; }
    setUnconfirming(who.tokenId!, who.id, false); // it confirms what it takes after all
    if (unclaimed(t)) {
      // Any available agent: the first agent to confirm takes it.
      const took = await db.query(`update agent_tasks set token_id = $2 where id = $1 and token_id is null returning id`, [id, who.tokenId]);
      if (!took.length) { send(res, 409, { error: 'Another agent already took this task. Leave it.' }); return true; }
      await addEvent(db, id, { kind: 'assigned', author_kind: 'agent', author_name: who.name, text: who.name, status: null, page_id: null });
      t.token_id = who.tokenId!;
      t.agent_name = who.name;
    }
    const b = action === 'update' ? await readJson(req) : {};
    const status = b.status ? String(b.status) as TaskStatus : undefined;
    if (status && !AGENT_STATUSES.has(status)) { send(res, 400, { error: 'status is one of working, needs_you, done, failed.' }); return true; }
    const note = clip(b.note, TASK_LIMITS.note);
    if ((status === 'needs_you') && !note) { send(res, 400, { error: 'Say what you need from the person in note.' }); return true; }
    // Anything the person wrote since the agent last looked: hand it over now, so it is never missed.
    const unseen = await db.query<{ author_name: string; text: string; created_at: string }>(
      `select author_name, text, created_at from agent_task_events where task_id = $1 and kind = 'message'
         and ($2::timestamptz is null or created_at > $2) order by created_at`, [id, t.agent_seen_at]);
    // A finished task stays finished unless the agent says otherwise; acking or a bare note means working.
    const next: TaskStatus = status ?? (t.status === 'queued' || t.status === 'needs_you' ? 'working' : t.status);
    const finished = next === 'done' || next === 'failed';
    await db.query(
      `update agent_tasks set status = $2, note = case when $3 <> '' then $3 else note end, agent_seen_at = now(), delivery_count = 0,
         delivered_at = coalesce(delivered_at, now()), updated_at = now(), done_at = case when $4 then now() else null end where id = $1`,
      [id, next, note, finished]);
    if (note || next !== t.status) {
      await addEvent(db, id, { kind: next !== t.status ? 'status' : 'note', author_kind: 'agent', author_name: t.agent_name ?? who.name, text: note, status: next !== t.status ? next : null, page_id: null });
    }
    await addPages(db, who, t, b.pages);
    changed(t);
    send(res, 200, { ok: true, status: next, messages: unseen.map((u) => ({ from: u.author_name, text: u.text, at: u.created_at })) });
    return true;
  }

  // ---- Person: answer, edit, move, cancel, delete
  if (!isPerson) { send(res, 403, { error: 'Report on a task with POST /api/tasks/:id/update.' }); return true; }

  if (action === 'messages' && method === 'POST') {
    const b = await readJson(req);
    const text = clip(b.text, TASK_LIMITS.message);
    if (!text) { send(res, 400, { error: 'Write something first.' }); return true; }
    if (!t.token_id) { send(res, 409, { error: 'This task has no agent. Assign one first.' }); return true; }
    // Answering a question, or writing on a finished task, gives it back to the agent.
    const next: TaskStatus = t.status === 'working' ? 'working' : 'queued';
    await db.query(
      `update agent_tasks set status = $2, last_message_at = now(), delivered_at = null, updated_at = now(), done_at = null where id = $1`, [id, next]);
    await addEvent(db, id, { kind: 'message', author_kind: 'human', author_name: who.name, text, status: next !== t.status ? next : null, page_id: null });
    const fresh = (await getTask(db, id))!;
    changed(fresh);
    pushTask(db, fresh, 'task.message', who.name, text);
    send(res, 201, { task: shape(fresh, (await pagesOf(db, [id])).get(id), unclaimed(fresh) && (await anyListeningFor(db, fresh.user_id))) });
    return true;
  }

  if (!action && method === 'PATCH') {
    const b = await readJson(req);
    const sets: string[] = [];
    const params: unknown[] = [id];
    const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    if (b.title !== undefined) {
      const title = clip(b.title, TASK_LIMITS.title);
      if (!title) { send(res, 400, { error: 'A task needs a title.' }); return true; }
      set('title', title);
    }
    if (b.details !== undefined) set('details', clip(b.details, TASK_LIMITS.details));
    let reassigned: { id: string | null; name: string } | null = null;
    const wantAny = b.token_id === ANY;
    if (b.token_id !== undefined && (wantAny ? !unclaimed(t) : b.token_id !== t.token_id)) {
      const [token] = wantAny ? [{ id: null, name: 'Any available agent' }]
        : await db.query('select id, name from api_tokens where id = $1 and user_id = $2', [String(b.token_id), who.id]);
      if (!token) { send(res, 404, { error: 'That agent is not one of yours.' }); return true; }
      reassigned = token;
      set('token_id', token.id);
      set('any_agent', wantAny);
      set('agent_seen_at', null);
    }
    let status: TaskStatus | undefined = b.status ? String(b.status) as TaskStatus : undefined;
    if (status && !PERSON_STATUSES.has(status)) { send(res, 400, { error: 'status is one of queued, cancelled, done.' }); return true; }
    if (reassigned && !status && t.status !== 'done') status = 'queued';
    if (status && status !== t.status) {
      set('status', status);
      sets.push(`done_at = ${status === 'done' || status === 'cancelled' ? 'now()' : 'null'}`);
    }
    if (status === 'queued' || reassigned) sets.push('delivered_at = null', 'delivery_count = 0');
    if (!sets.length) { send(res, 200, { task: shape(t) }); return true; }
    sets.push('updated_at = now()');
    await db.query(`update agent_tasks set ${sets.join(', ')} where id = $1`, params);
    if (reassigned) await addEvent(db, id, { kind: 'assigned', author_kind: 'human', author_name: who.name, text: reassigned.name, status: status ?? null, page_id: null });
    else if (status && status !== t.status) await addEvent(db, id, { kind: 'status', author_kind: 'human', author_name: who.name, text: '', status, page_id: null });
    const fresh = (await getTask(db, id))!;
    changed(t);
    if (reassigned && t.token_id && t.status !== 'done' && t.status !== 'cancelled') pushTask(db, t, 'task.cancelled', who.name);
    if (status === 'cancelled' && t.status !== 'cancelled') pushTask(db, t, 'task.cancelled', who.name);
    if ((reassigned || status === 'queued') && fresh.status === 'queued') pushTask(db, fresh, 'task.assigned', who.name);
    send(res, 200, { task: shape(fresh, (await pagesOf(db, [id])).get(id), unclaimed(fresh) && (await anyListeningFor(db, fresh.user_id))) });
    return true;
  }

  if (!action && method === 'DELETE') {
    await db.query('delete from agent_tasks where id = $1', [id]);
    changed(t);
    if (t.token_id && (t.status === 'queued' || t.status === 'working')) pushTask(db, t, 'task.cancelled', who.name);
    send(res, 200, { ok: true });
    return true;
  }
  return false;
}
