// Ask AI chats, kept on the server so they follow you to every device.
//
// Each person has one chat per page (other people on the page don't see it). The server owns it:
// it writes your question, then fills in the answer as the built-in assistant streams it or as
// your connected agent works and replies. Every open Ask panel (your Mac, your phone) follows it
// with a long poll, so an answer started on one device streams on the others, and it is still
// there after a reload, a closed tab or the phone going to sleep.
//
//   GET    /api/pages/:page/chat?since=<rev>&wait=25  -> { turns, rev, running }  (returns early on a change)
//   DELETE /api/pages/:page/chat                       -> clear it
//   POST   /api/pages/:page/chat/stop                  -> stop the built-in assistant's answer
//
// Changes are held in memory and written to Postgres at most once a second while an answer
// streams, and right away when it finishes.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from './db.ts';
import { randomId, type Principal } from './auth.ts';
import { send } from './agent-api.ts';

export type ToolStep = { id: string; name: string; status: 'running' | 'done' | 'error'; note?: string };
export type Turn = {
  id: string; role: 'user' | 'assistant'; text: string; at: string;
  selection?: string; steps?: ToolStep[]; error?: string; model?: string; status?: string;
  /** Still being answered. */
  running?: boolean;
  /** Who answers: the built-in assistant, or one of your connected agents (requestId). */
  kind?: 'builtin' | 'agent'; requestId?: string;
};
type Chat = { turns: Turn[]; rev: number; dirty: boolean; timer: NodeJS.Timeout | null; lastUse: number };

export const CHATS_SQL = `
create table if not exists ai_chats (
  user_id    text not null references users(id) on delete cascade,
  page_id    text not null references pages(id) on delete cascade,
  turns      jsonb not null default '[]',
  rev        bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, page_id)
)`;

const MAX_TURNS = 200;
const MAX_TEXT = 40_000;
const SAVE_MS = 1000;
const MAX_WAIT = 30_000;
const CACHE_MAX = 500;

const chats = new Map<string, Chat>();
const loading = new Map<string, Promise<Chat>>();
const runs = new Map<string, AbortController>(); // built-in assistant answers in progress, by chat
const waiters = new Map<string, Set<() => void>>();
const keyOf = (userId: string, pageId: string) => `${userId} ${pageId}`;

let ready: Promise<unknown> | null = null;
const ensureTable = (db: Db) => (ready ??= db.query(CHATS_SQL));

async function load(db: Db, key: string, userId: string, pageId: string): Promise<Chat> {
  const hit = chats.get(key);
  if (hit) { hit.lastUse = Date.now(); return hit; }
  let p = loading.get(key);
  if (!p) {
    p = (async () => {
      await ensureTable(db);
      const [row] = await db.query<{ turns: Turn[]; rev: string }>('select turns, rev from ai_chats where user_id = $1 and page_id = $2', [userId, pageId]);
      const turns: Turn[] = Array.isArray(row?.turns) ? row!.turns : [];
      // A built-in answer only runs inside this process; one saved as running was cut off by a restart.
      for (const t of turns) {
        if (t.running && t.kind !== 'agent') { t.running = false; t.status = ''; t.error ??= 'Interrupted: the server restarted. Ask again.'; }
      }
      const chat: Chat = { turns, rev: Number(row?.rev ?? 0), dirty: false, timer: null, lastUse: Date.now() };
      chats.set(key, chat);
      evict();
      return chat;
    })().finally(() => loading.delete(key));
    loading.set(key, p);
  }
  return p;
}

function evict() {
  if (chats.size <= CACHE_MAX) return;
  const idle = [...chats.entries()].filter(([k, c]) => !c.dirty && !runs.has(k) && !waiters.has(k)).sort((a, b) => a[1].lastUse - b[1].lastUse);
  for (const [k] of idle.slice(0, chats.size - CACHE_MAX)) chats.delete(k);
}

async function save(db: Db, key: string) {
  const chat = chats.get(key);
  if (!chat) return;
  if (chat.timer) { clearTimeout(chat.timer); chat.timer = null; }
  if (!chat.dirty) return;
  chat.dirty = false;
  const [userId, pageId] = key.split(' ');
  try {
    await db.query(
      `insert into ai_chats (user_id, page_id, turns, rev, updated_at) values ($1, $2, $3, $4, now())
       on conflict (user_id, page_id) do update set turns = excluded.turns, rev = excluded.rev, updated_at = now()`,
      [userId, pageId, JSON.stringify(chat.turns), chat.rev],
    );
  } catch (e) {
    // The page was deleted (foreign key), or the database is briefly away: keep it in memory.
    console.warn('[chats] save failed:', (e as Error).message);
  }
}

function wake(key: string) {
  const set = waiters.get(key);
  if (!set) return;
  waiters.delete(key);
  for (const fn of set) fn();
}

/** Change a chat: fn edits the turns in place. Wakes every open panel; saves soon (or now). */
export async function changeChat(db: Db, userId: string, pageId: string, fn: (turns: Turn[]) => Turn[] | void, now = false) {
  const key = keyOf(userId, pageId);
  const chat = await load(db, key, userId, pageId);
  const next = fn(chat.turns);
  if (next) chat.turns = next;
  if (chat.turns.length > MAX_TURNS) chat.turns = chat.turns.slice(-MAX_TURNS);
  chat.rev += 1;
  chat.dirty = true;
  chat.lastUse = Date.now();
  wake(key);
  if (now) await save(db, key);
  else chat.timer ??= setTimeout(() => void save(db, key), SAVE_MS);
}

/** Update one turn, if it is still there (the chat may have been cleared meanwhile). */
export function changeTurn(db: Db, userId: string, pageId: string, turnId: string, fn: (t: Turn) => void, now = false) {
  return changeChat(db, userId, pageId, (turns) => {
    const t = turns.find((x) => x.id === turnId);
    if (t) { fn(t); if (t.text.length > MAX_TEXT) t.text = t.text.slice(0, MAX_TEXT); }
  }, now);
}

export async function readChat(db: Db, userId: string, pageId: string) {
  const key = keyOf(userId, pageId);
  const chat = await load(db, key, userId, pageId);
  return { turns: chat.turns, rev: chat.rev, running: chat.turns.some((t) => t.running) };
}

/** Earlier turns, text only, for the model or agent to read. */
export const historyOf = (turns: Turn[]) =>
  turns.filter((t) => t.text && !t.running).slice(-24).map((t) => ({ role: t.role, text: t.text.slice(0, 4000) }));

/** Start a new exchange: your question and an empty answer that the server fills in. */
export async function startExchange(
  db: Db, userId: string, pageId: string,
  q: { prompt: string; selection?: string }, a: Pick<Turn, 'kind' | 'requestId' | 'model' | 'status'>,
): Promise<{ answerId: string }> {
  const at = new Date().toISOString();
  const answerId = randomId('t', 8);
  await changeChat(db, userId, pageId, (turns) => {
    turns.push({ id: randomId('t', 8), role: 'user', text: q.prompt, at, selection: q.selection || undefined });
    turns.push({ id: answerId, role: 'assistant', text: '', at, steps: [], running: true, ...a });
  }, true);
  return { answerId };
}

/** True while an answer is still coming in this chat. */
export async function chatBusy(db: Db, userId: string, pageId: string) {
  return (await readChat(db, userId, pageId)).running;
}

export function trackRun(userId: string, pageId: string, ac: AbortController) {
  const key = keyOf(userId, pageId);
  runs.set(key, ac);
  return () => { if (runs.get(key) === ac) runs.delete(key); };
}

export async function handleChat(req: IncomingMessage, res: ServerResponse, db: Db, who: Principal, pageId: string, url: URL, action?: string) {
  if (who.kind !== 'human' || who.superAgent) return send(res, 403, { error: 'Ask AI chats are for people.' });
  const method = req.method ?? 'GET';
  const key = keyOf(who.id, pageId);

  if (!action && method === 'GET') {
    let chat = await readChat(db, who.id, pageId);
    const since = url.searchParams.get('since');
    const ms = Math.min(MAX_WAIT, Math.max(0, Number(url.searchParams.get('wait')) * 1000 || 0));
    if (ms && since !== null && Number(since) === chat.rev) {
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); waiters.get(key)?.delete(done); resolve(); };
        const timer = setTimeout(done, ms);
        let set = waiters.get(key);
        if (!set) waiters.set(key, (set = new Set()));
        set.add(done);
        res.on('close', done);
      });
      // A streaming answer changes many times a second: answer with a few changes at once.
      if (!res.destroyed) await new Promise((r) => setTimeout(r, 80));
      chat = await readChat(db, who.id, pageId);
    }
    if (!res.writableEnded && !res.destroyed) send(res, 200, chat);
    return;
  }

  if (!action && method === 'DELETE') {
    if (await chatBusy(db, who.id, pageId)) return send(res, 409, { error: 'Stop the answer first, then clear the chat.' });
    await changeChat(db, who.id, pageId, () => [], true);
    return send(res, 200, { ok: true });
  }

  if (action === 'stop' && method === 'POST') {
    runs.get(key)?.abort();
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'not found' });
}
