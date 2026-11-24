// Wake a cloud agent: when one of your agents gets work and nobody is listening for it, Livepage
// starts a session for it with the agent's provider. Today that's Devin; the provider table below is
// where others go.
//
// It sits behind push (agent-push.ts): every event that goes to an agent's stream and webhook also
// comes here. If the agent has wake set up, isn't listening right now (no wait_for_requests poll, no
// event stream), and the event is one it wakes for, Livepage starts a session with a prompt that says
// what the work is and how to reach Livepage. The session gets this agent's own Livepage token as a
// secret (LIVEPAGE_TOKEN), takes the work with wait_for_requests like any agent, and reports back
// with update_task / reply_to_request / reply_to_comment. Nothing about taking work changes, so a
// wake that fails loses nothing: the work stays queued.
//
// One session per piece of work. The key is the task, the Ask chat on a page, or the comment thread.
// The first event claims the key (a row in agent_wake_sessions, so two servers can't both start one);
// later events for the same work (the person answers a task, a follow-up in Ask, a reply in the
// thread, a cancel) are sent to that session as messages. A session that has ended gets replaced.
//
// Tokens are stored hashed, so to hand one to a cloud agent Livepage gives it a new value when wake is
// set up and keeps that value encrypted (AI_KEY_SECRET, like Ask AI keys). Provider keys are encrypted
// the same way. Neither is ever sent back to the browser.
//
//   Person (session cookie)
//     GET    /api/tokens/:id/wake               -> { wake, sessions }
//     PUT    /api/tokens/:id/wake               { provider: 'devin', api_key?, org_id?, events?, playbook_id?, max_acu?, max_per_hour? }
//                                               -> { wake, agent_token? }  (agent_token: the new token value, shown once)
//     DELETE /api/tokens/:id/wake               turn it off (the token keeps working)
//     POST   /api/tokens/:id/wake/test          check the key works
//     POST   /api/tokens/:id/wake/knowledge     { page_id } copy a page into the provider's knowledge, one note per ## section
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Hocuspocus } from '@hocuspocus/server';
import type * as Y from 'yjs';
import { pageAsMarkdown } from '@livepage/schema';
import type { Db } from './db.ts';
import { rotateApiToken, type Principal } from './auth.ts';
import { readJson, send } from './agent-api.ts';
import { config } from './config.ts';
import { decryptKey, encryptKey } from './assistant/settings.ts';
import { roleFor } from './pages.ts';
import type { AgentEvent } from './agent-push.ts';
import { isListening } from './agent-requests.ts';

export type WakeEvents = { tasks: boolean; asks: boolean; mentions: boolean };
type ConfigRow = {
  token_id: string; user_id: string; provider: string; api_key_enc: string; key_hint: string; org_id: string | null;
  agent_token_enc: string; events: string; playbook_id: string | null; max_acu: number | null; max_per_hour: number;
  knowledge: { page_id?: string; notes?: Record<string, string>; synced_at?: string }; last_error: string | null; last_error_at: string | null;
};

class WakeError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// ---- Devin (docs.devin.ai). Keys starting cog_ use the current v3 API (needs the org id); legacy
// apk_ keys use v1. Both take a prompt, a title, tags and per-session secrets.

type Session = { id: string; url: string; status?: string };
type Provider = {
  label: string;
  check(key: string, orgId: string | null): Promise<void>;
  start(c: Creds, s: { prompt: string; title: string; tags: string[]; secrets: Record<string, string>; playbookId?: string | null; maxAcu?: number | null }): Promise<Session>;
  message(c: Creds, sessionId: string, text: string): Promise<void>;
  status(c: Creds, sessionId: string): Promise<string | null>;
  putNote(c: Creds, n: { id?: string; name: string; body: string; trigger: string }): Promise<string>;
  deleteNote(c: Creds, id: string): Promise<void>;
};
type Creds = { key: string; orgId: string | null };

const devinBase = () => (process.env.DEVIN_API_URL || 'https://api.devin.ai').replace(/\/$/, '');
const isV3 = (key: string) => !key.startsWith('apk_');

async function devin(c: Creds, method: string, path: string, body?: unknown): Promise<any> {
  const base = isV3(c.key) ? `${devinBase()}/v3/organizations/${encodeURIComponent(c.orgId ?? '')}` : `${devinBase()}/v1`;
  let res: Response;
  try {
    res = await fetch(base + path, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${c.key}`, 'content-type': 'application/json', 'user-agent': 'Livepage/1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new WakeError(502, `Couldn't reach Devin: ${(e as Error).message}`);
  }
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const why = json?.detail ?? json?.title ?? json?.message ?? json?.error ?? text.slice(0, 200);
    const hint = res.status === 401 ? ' Check the API key.'
      : res.status === 403 ? ' The key works but lacks permission (it needs to create sessions and manage knowledge).'
      : res.status === 404 && isV3(c.key) ? ' Check the org id (Settings > Devin API, it starts with org-).' : '';
    throw new WakeError(res.status === 401 || res.status === 403 || res.status === 404 ? 400 : 502, `Devin answered ${res.status}: ${typeof why === 'string' ? why : JSON.stringify(why)}.${hint}`);
  }
  return json;
}

const devinProvider: Provider = {
  label: 'Devin',
  async check(key, orgId) {
    if (isV3(key) && !orgId) throw new WakeError(400, 'Add your Devin org id (Settings > Devin API, it starts with org-).');
    await devin({ key, orgId }, 'GET', isV3(key) ? '/sessions?first=1' : '/sessions?limit=1');
  },
  async start(c, s) {
    const session_secrets = Object.entries(s.secrets).map(([key, value]) => ({ key, value, sensitive: true }));
    const body: Record<string, unknown> = { prompt: s.prompt, title: s.title, tags: s.tags, session_secrets };
    if (s.playbookId) body.playbook_id = s.playbookId;
    if (s.maxAcu) body.max_acu_limit = s.maxAcu;
    if (!isV3(c.key)) body.idempotent = true;
    const r = await devin(c, 'POST', '/sessions', body);
    if (!r?.session_id) throw new WakeError(502, 'Devin did not return a session id.');
    return { id: r.session_id, url: r.url ?? `https://app.devin.ai/sessions/${String(r.session_id).replace(/^devin-/, '')}`, status: r.status };
  },
  async message(c, id, text) {
    if (isV3(c.key)) await devin(c, 'POST', `/sessions/${encodeURIComponent(id)}/messages`, { message: text });
    else await devin(c, 'POST', `/session/${encodeURIComponent(id)}/message`, { message: text });
  },
  async status(c, id) {
    const r = await devin(c, 'GET', isV3(c.key) ? `/sessions/${encodeURIComponent(id)}` : `/session/${encodeURIComponent(id)}`);
    return r?.status_enum ?? r?.status ?? null;
  },
  async putNote(c, n) {
    if (isV3(c.key)) {
      const body = { name: n.name, body: n.body, trigger: n.trigger };
      const r = n.id ? await devin(c, 'PUT', `/knowledge/notes/${encodeURIComponent(n.id)}`, body) : await devin(c, 'POST', '/knowledge/notes', body);
      return r?.note_id ?? r?.id ?? n.id ?? '';
    }
    const body = { name: n.name, body: n.body, trigger_description: n.trigger };
    const r = n.id ? await devin(c, 'PUT', `/knowledge/${encodeURIComponent(n.id)}`, body) : await devin(c, 'POST', '/knowledge', body);
    return r?.id ?? r?.note_id ?? n.id ?? '';
  },
  async deleteNote(c, id) {
    await devin(c, 'DELETE', isV3(c.key) ? `/knowledge/notes/${encodeURIComponent(id)}` : `/knowledge/${encodeURIComponent(id)}`);
  },
};

const PROVIDERS: Record<string, Provider> = { devin: devinProvider };
/** Sessions that have ended: a follow-up starts a new one instead. */
const ENDED = new Set(['exit', 'error', 'finished', 'expired', 'stopped', 'blocked_permanently']);

// ---- Settings

const parseEvents = (s: string): WakeEvents => {
  const set = new Set(s.split(','));
  return { tasks: set.has('tasks'), asks: set.has('asks'), mentions: set.has('mentions') };
};
const hint = (key: string) => (key.length > 12 ? `${key.slice(0, 4)}…${key.slice(-4)}` : '••••');

async function getConfig(db: Db, tokenId: string): Promise<ConfigRow | null> {
  const [row] = await db.query<ConfigRow>('select * from agent_wake_configs where token_id = $1', [tokenId]);
  return row ?? null;
}

function summary(c: ConfigRow) {
  return {
    provider: c.provider, provider_label: PROVIDERS[c.provider]?.label ?? c.provider, key_hint: c.key_hint, org_id: c.org_id,
    events: parseEvents(c.events), playbook_id: c.playbook_id, max_acu: c.max_acu, max_per_hour: c.max_per_hour,
    knowledge: { page_id: c.knowledge?.page_id ?? null, notes: Object.keys(c.knowledge?.notes ?? {}).length, synced_at: c.knowledge?.synced_at ?? null },
    last_error: c.last_error, last_error_at: c.last_error_at,
  };
}
export type WakeSummary = ReturnType<typeof summary>;

/** For the agent list: which of this person's agents wake, and with what. */
export async function wakeSummaries(db: Db, userId: string): Promise<Map<string, WakeSummary>> {
  const rows = await db.query<ConfigRow>('select * from agent_wake_configs where user_id = $1', [userId]);
  return new Map(rows.map((r) => [r.token_id, summary(r)]));
}

const creds = (c: ConfigRow): Creds => ({ key: decryptKey(c.user_id, c.api_key_enc), orgId: c.org_id });

async function noteError(db: Db, tokenId: string, msg: string | null) {
  await db.query('update agent_wake_configs set last_error = $2, last_error_at = case when $2::text is null then null else now() end where token_id = $1', [tokenId, msg]);
}

// ---- Waking

type Work = { key: string; title: string; kind: 'tasks' | 'asks' | 'mentions'; followUp: boolean; cancel: boolean };

/** What piece of work an event is about, so its follow-ups reach the same session. */
function workFor(e: AgentEvent): Work | null {
  const d = e.data as any;
  switch (e.type) {
    case 'task.assigned': return { key: `task:${d.task?.id}`, title: `Livepage task: ${d.task?.title ?? ''}`, kind: 'tasks', followUp: false, cancel: false };
    case 'task.message': return { key: `task:${d.task?.id}`, title: `Livepage task: ${d.task?.title ?? ''}`, kind: 'tasks', followUp: true, cancel: false };
    case 'task.cancelled': return { key: `task:${d.task?.id}`, title: '', kind: 'tasks', followUp: true, cancel: true };
    // Ask AI: one chat per page, so follow-ups in it go to the same session for a while.
    case 'request.created': return { key: `ask:${d.page?.id}`, title: `Livepage Ask: ${d.page?.title ?? ''}`, kind: 'asks', followUp: !!d.request?.follow_up, cancel: false };
    case 'comment.mention': return { key: `thread:${d.page?.id}:${d.thread?.id ?? d.comment?.thread_id}`, title: `Livepage comment: ${d.page?.title ?? ''}`, kind: 'mentions', followUp: false, cancel: false };
    default: return null;
  }
}
/** An Ask chat or comment thread idle this long starts a fresh session next time. Tasks keep theirs. */
const REUSE_MS: Record<Work['kind'], number> = { tasks: Infinity, asks: 2 * 3600_000, mentions: 6 * 3600_000 };
/** A claim with no session after this long (the server restarted mid-start) can be taken again. */
const CLAIM_MS = 2 * 60_000;

function sessionPrompt(e: AgentEvent, agentName: string, personName: string): string {
  const d = e.data as any;
  const how = [d.take_with && `- Take it: ${d.take_with.mcp} (MCP), or ${d.take_with.http}`, d.report_with && `- Report: ${d.report_with.mcp} (MCP), or ${d.report_with.http}`, d.reply_with && `- Answer: ${d.reply_with.mcp ?? ''}${d.reply_with.mcp ? ' (MCP), or ' : ''}${d.reply_with.http}`]
    .filter(Boolean).join('\n');
  return [
    `You are "${agentName}", ${personName}'s agent in Livepage, a writing app where people and agents edit pages together (${config.publicUrl}). New work just arrived for you:`,
    '',
    e.text,
    '',
    'How to reach Livepage:',
    `- If the Livepage MCP server is installed for you (${config.publicUrl}/mcp), use its tools.`,
    `- Otherwise use the HTTP API at ${config.publicUrl}/api with the header "Authorization: Bearer $LIVEPAGE_TOKEN". LIVEPAGE_TOKEN is a secret of this session: pass it to the commands that need it, and never print it, commit it or write it into a page.`,
    how,
    '',
    'How to work:',
    `1. Take the work first (wait_for_requests with wait_seconds 0, or GET ${config.publicUrl}/api/agent-requests, then ack it), so ${personName} sees you have it.`,
    '2. Edit pages with targeted edits: read the outline, then change only the blocks that need it. Never rewrite a whole page.',
    `3. If you need ${personName}, ask (a task: update_task with status needs_you and your question) and wait. Their answer arrives in this session as a message.`,
    '4. Finish by reporting back in Livepage (done with a short summary). Don\'t open pull requests or change repositories unless the work asks for it.',
    `5. Before you finish, call wait_for_requests (wait_seconds 0) once more: anything else waiting for you is yours too.`,
  ].join('\n');
}

const inFlight = new Set<string>();

/** Called for every event pushed to an agent (agent-push.ts). Starts or messages a session if this agent wakes. */
export async function wakeForEvent(db: Db, tokenId: string, e: AgentEvent): Promise<void> {
  const work = workFor(e);
  if (!work) return;
  const cfg = await getConfig(db, tokenId);
  if (!cfg) return;
  if (!parseEvents(cfg.events)[work.kind]) return;
  const provider = PROVIDERS[cfg.provider];
  if (!provider) return;

  const [existing] = await db.query('select * from agent_wake_sessions where token_id = $1 and work_key = $2', [tokenId, work.key]);
  const c = creds(cfg);
  const fresh = existing?.session_id && Date.now() - new Date(existing.last_message_at ?? existing.started_at).getTime() < REUSE_MS[work.kind];

  // Follow-ups (and anything for work that already has a live session) go to that session.
  if (existing?.session_id && (fresh || work.cancel)) {
    const text = work.cancel ? `${e.text}\nStop now and don't change anything else.` : `${e.text}\n(Take it with wait_for_requests, wait_seconds 0, then carry on.)`;
    try {
      const st = work.cancel ? null : await provider.status(c, existing.session_id).catch(() => null);
      if (!st || !ENDED.has(String(st).toLowerCase())) {
        await provider.message(c, existing.session_id, text);
        await db.query('update agent_wake_sessions set last_message_at = now() where token_id = $1 and work_key = $2', [tokenId, work.key]);
        return;
      }
    } catch (err) {
      if (work.cancel) return;
      console.warn(`[wake] message to ${existing.session_id} failed, starting a new session: ${(err as Error).message}`);
    }
  }
  if (work.cancel) return;
  // Someone is listening (the agent's own loop, or a session we started that is still polling): it gets the work directly.
  if (isListening(tokenId)) return;

  // Claim the work so only one session starts for it (across servers, and across events arriving together).
  const lock = `${tokenId}|${work.key}`;
  if (inFlight.has(lock)) return;
  inFlight.add(lock);
  try {
    const claimed = await db.query(
      `insert into agent_wake_sessions (token_id, work_key, title) values ($1, $2, $3)
         on conflict (token_id, work_key) do update set claimed_at = now(), session_id = null, session_url = null, started_at = null, last_message_at = null, title = excluded.title
         where agent_wake_sessions.session_id is not null or agent_wake_sessions.claimed_at < now() - ($4::int * interval '1 millisecond')
       returning work_key`, [tokenId, work.key, work.title.slice(0, 200), CLAIM_MS]);
    if (!claimed.length) return; // another start is under way
    // The hourly limit counts every session started (including ones that replaced an ended session).
    const hourAgo = Date.now() - 3600_000;
    const [lim] = await db.query<{ recent_starts: string[] }>('select recent_starts from agent_wake_configs where token_id = $1', [tokenId]);
    const recent = (lim?.recent_starts ?? []).filter((t) => new Date(t).getTime() > hourAgo);
    if (recent.length >= cfg.max_per_hour) {
      await db.query('delete from agent_wake_sessions where token_id = $1 and work_key = $2 and session_id is null', [tokenId, work.key]);
      await noteError(db, tokenId, `Didn't start a session: ${recent.length} already started in the last hour (your limit is ${cfg.max_per_hour}). The work is still waiting.`);
      return;
    }
    await db.query('update agent_wake_configs set recent_starts = $2 where token_id = $1', [tokenId, JSON.stringify([...recent, new Date().toISOString()])]);
    const [who] = await db.query('select t.name as agent, u.name as person from api_tokens t join users u on u.id = t.user_id where t.id = $1', [tokenId]);
    try {
      const s = await provider.start(c, {
        prompt: sessionPrompt(e, who?.agent ?? 'Agent', who?.person ?? 'your person'),
        title: work.title.slice(0, 120),
        tags: ['livepage', work.kind],
        secrets: { LIVEPAGE_TOKEN: decryptKey(cfg.user_id, cfg.agent_token_enc), LIVEPAGE_URL: config.publicUrl },
        playbookId: cfg.playbook_id,
        maxAcu: cfg.max_acu,
      });
      await db.query('update agent_wake_sessions set session_id = $3, session_url = $4, started_at = now(), last_message_at = now() where token_id = $1 and work_key = $2',
        [tokenId, work.key, s.id, s.url]);
      await noteError(db, tokenId, null);
      if (work.kind === 'tasks') await noteOnTask(db, String((e.data as any).task?.id ?? ''), `${provider.label} started working on this: ${s.url}`);
    } catch (err) {
      await db.query('delete from agent_wake_sessions where token_id = $1 and work_key = $2 and session_id is null', [tokenId, work.key]);
      await noteError(db, tokenId, `Couldn't start a ${provider.label} session: ${(err as Error).message}`);
      throw err;
    }
  } finally {
    inFlight.delete(lock);
  }
}

/** A line on the task's timeline, so the person can open the session from the board. */
async function noteOnTask(db: Db, taskId: string, text: string) {
  if (!taskId) return;
  await db.query(
    `insert into agent_task_events (id, task_id, kind, author_kind, author_name, text) values ($1, $2, 'note', 'system', 'Livepage', $3)`,
    [`te_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, taskId, text]);
}

// ---- Knowledge: copy a page (for example "About Jean") into the provider, one note per ## section.

function sections(markdown: string, fallback: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  let cur = { name: fallback, body: [] as string[] };
  for (const line of markdown.replace(/^---\n[\s\S]*?\n---\n/, '').split('\n')) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      if (cur.body.join('\n').trim()) out.push({ name: cur.name, body: cur.body.join('\n').trim() });
      cur = { name: h[1], body: [] };
    } else if (!/^#\s/.test(line)) cur.body.push(line);
  }
  if (cur.body.join('\n').trim()) out.push({ name: cur.name, body: cur.body.join('\n').trim() });
  return out;
}

const WORKFLOW_NOTE = (personName: string) => ({
  name: 'Livepage: how to do work from Livepage',
  trigger: 'When a session is about a Livepage task, Ask AI request or comment mention',
  body: [
    `Livepage (${config.publicUrl}) is ${personName}'s writing app. Sessions started from it carry a LIVEPAGE_TOKEN secret: send it as "Authorization: Bearer $LIVEPAGE_TOKEN" to ${config.publicUrl}/api or the MCP server at ${config.publicUrl}/mcp. Never print it or write it anywhere.`,
    '1. Take the work: wait_for_requests (wait_seconds 0) or GET /api/agent-requests, then ack it (POST /api/tasks/:id/ack or /api/agent-requests/:id/ack).',
    '2. Read before writing: GET /api/pages/:page/outline, then GET /api/pages/:page/blocks?section=... Edit with targeted block edits (PUT /api/pages/:page/blocks/:id, POST /api/pages/:page/blocks, POST /api/pages/:page/replace-text). Never rewrite whole pages.',
    '3. Tasks: report with POST /api/tasks/:id/update {status, note}: working with short notes, needs_you with a question when stuck, then done or failed with a summary.',
    '4. Ask AI: answer with POST /api/agent-requests/:id/reply {text, done: true}. Comments: reply with POST /api/pages/:page/comments/:threadId {body}.',
    `5. ${personName} answers arrive as messages in the session. Keep replies short and plain.`,
  ].join('\n'),
});

async function syncKnowledge(db: Db, hp: Hocuspocus, who: Principal, cfg: ConfigRow, pageId: string) {
  const role = await roleFor(db, who, pageId);
  if (!role) throw new WakeError(404, 'No such page.');
  const [page] = await db.query('select title from pages where id = $1', [pageId]);
  const conn = await hp.openDirectConnection(pageId, { user: { id: who.id, name: who.name, kind: who.kind } });
  let markdown = '';
  try { await conn.transact((d) => { markdown = pageAsMarkdown(d as unknown as Y.Doc); }); } finally { await conn.disconnect(); }
  const title = page?.title || 'About me';
  const parts = sections(markdown, 'Overview');
  if (!parts.length) throw new WakeError(400, 'That page is empty.');
  if (parts.length > 40) throw new WakeError(400, 'That page has more than 40 sections. Merge some first.');
  const provider = PROVIDERS[cfg.provider]!;
  const c = creds(cfg);
  const before = cfg.knowledge?.page_id === pageId ? cfg.knowledge.notes ?? {} : cfg.knowledge?.notes ?? {};
  const notes: Record<string, string> = {};
  const all = [
    ...parts.map((p) => ({ name: `${title}: ${p.name}`.slice(0, 200), body: p.body.slice(0, 60_000), trigger: `Always, when working for ${who.name}: ${p.name}` })),
    WORKFLOW_NOTE(who.name),
  ];
  for (const n of all) {
    const id = before[n.name];
    try { notes[n.name] = await provider.putNote(c, { ...n, id }); } catch (e) {
      if (!id) throw e;
      notes[n.name] = await provider.putNote(c, n); // deleted on the provider's side: make it again
    }
  }
  for (const [name, id] of Object.entries(before)) if (!(name in notes)) await provider.deleteNote(c, id).catch(() => {});
  const knowledge = { page_id: pageId, notes, synced_at: new Date().toISOString() };
  await db.query('update agent_wake_configs set knowledge = $2, updated_at = now() where token_id = $1', [cfg.token_id, JSON.stringify(knowledge)]);
  return { notes: Object.keys(notes), synced_at: knowledge.synced_at };
}

// ---- HTTP

export async function handleWake(req: IncomingMessage, res: ServerResponse, db: Db, hp: Hocuspocus, who: Principal, path: string,
  drop: (tokenId: string) => void): Promise<boolean> {
  const m = path.match(/^\/api\/tokens\/(tok_[\w-]+)\/wake(?:\/(test|knowledge))?$/);
  if (!m) return false;
  if (who.kind !== 'human') { send(res, 403, { error: 'Only people can set up agents.' }); return true; }
  const [tokenId, action] = [m[1], m[2]];
  const [tok] = await db.query('select id, name from api_tokens where id = $1 and user_id = $2', [tokenId, who.id]);
  if (!tok) { send(res, 404, { error: 'No such agent.' }); return true; }
  const method = req.method;
  try {
    const cfg = await getConfig(db, tokenId);
    if (!action && method === 'GET') {
      const sessions = await db.query(
        'select work_key, title, session_url, started_at, last_message_at from agent_wake_sessions where token_id = $1 and session_id is not null order by coalesce(last_message_at, started_at) desc limit 10', [tokenId]);
      send(res, 200, { wake: cfg ? summary(cfg) : null, sessions });
      return true;
    }
    if (!action && method === 'DELETE') {
      await db.query('delete from agent_wake_configs where token_id = $1', [tokenId]);
      await db.query('delete from agent_wake_sessions where token_id = $1', [tokenId]);
      send(res, 200, { ok: true });
      return true;
    }
    if (!action && method === 'PUT') {
      const b = await readJson(req);
      const provider = String(b.provider ?? cfg?.provider ?? 'devin');
      const p = PROVIDERS[provider];
      if (!p) throw new WakeError(400, `Unknown provider ${provider}.`);
      const newKey = typeof b.api_key === 'string' && b.api_key.trim() ? b.api_key.trim() : null;
      const key = newKey ?? (cfg && cfg.provider === provider ? decryptKey(who.id, cfg.api_key_enc) : null);
      if (!key) throw new WakeError(400, `Paste your ${p.label} API key.`);
      if (/\s/.test(key) || key.length > 500) throw new WakeError(400, 'That API key looks wrong.');
      const orgId = typeof b.org_id === 'string' ? (b.org_id.trim() || null) : cfg?.org_id ?? null;
      if (orgId && !/^[\w-]{1,100}$/.test(orgId)) throw new WakeError(400, 'That org id looks wrong.');
      await p.check(key, orgId);
      const ev = b.events && typeof b.events === 'object' ? b.events : cfg ? parseEvents(cfg.events) : { tasks: true, asks: true, mentions: true };
      const events = (['tasks', 'asks', 'mentions'] as const).filter((k) => ev[k]).join(',');
      const playbook = typeof b.playbook_id === 'string' ? (b.playbook_id.trim() || null) : cfg?.playbook_id ?? null;
      if (playbook && !/^[\w-]{1,100}$/.test(playbook)) throw new WakeError(400, 'That playbook id looks wrong.');
      const num = (v: unknown, lo: number, hi: number, d: number | null) => (v === null || v === '' ? null : Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);
      const maxAcu = 'max_acu' in b ? num(b.max_acu, 1, 1000, null) : cfg?.max_acu ?? null;
      const perHour = 'max_per_hour' in b ? (num(b.max_per_hour, 1, 60, 10) ?? 10) : cfg?.max_per_hour ?? 10;
      // The session needs this agent's token. It's stored hashed, so give it a new value and keep that, encrypted.
      let agentToken: string | null = null;
      if (!cfg || b.rotate_token === true) {
        agentToken = await rotateApiToken(db, who.id, tokenId);
        if (!agentToken) throw new WakeError(404, 'No such agent.');
        drop(tokenId);
      }
      await db.query(
        `insert into agent_wake_configs (token_id, user_id, provider, api_key_enc, key_hint, org_id, agent_token_enc, events, playbook_id, max_acu, max_per_hour)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict (token_id) do update set provider = excluded.provider, api_key_enc = excluded.api_key_enc, key_hint = excluded.key_hint,
           org_id = excluded.org_id, agent_token_enc = coalesce($12, agent_wake_configs.agent_token_enc), events = excluded.events,
           playbook_id = excluded.playbook_id, max_acu = excluded.max_acu, max_per_hour = excluded.max_per_hour,
           last_error = null, last_error_at = null, updated_at = now()`,
        [tokenId, who.id, provider, encryptKey(who.id, key), hint(key), orgId, encryptKey(who.id, agentToken ?? ''), events, playbook, maxAcu, perHour,
          agentToken ? encryptKey(who.id, agentToken) : null]);
      send(res, 200, { wake: summary((await getConfig(db, tokenId))!), ...(agentToken ? { agent_token: agentToken } : {}) });
      return true;
    }
    if (!cfg) throw new WakeError(400, 'Set up wake for this agent first.');
    if (action === 'test' && method === 'POST') {
      await PROVIDERS[cfg.provider]!.check(creds(cfg).key, cfg.org_id);
      await noteError(db, tokenId, null);
      send(res, 200, { ok: true });
      return true;
    }
    if (action === 'knowledge' && method === 'POST') {
      const b = await readJson(req);
      const pageId = String(b.page_id ?? '');
      if (!/^p_[\w-]+$/.test(pageId)) throw new WakeError(400, 'Pick a page to send.');
      send(res, 200, await syncKnowledge(db, hp, who, cfg, pageId));
      return true;
    }
    return false;
  } catch (e) {
    const status = e instanceof WakeError ? e.status : (e as { status?: number }).status ?? 500;
    send(res, status, { error: (e as Error).message });
    return true;
  }
}
