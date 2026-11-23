// Comments, replies, resolve, and @mentions of people and agents.
//
// Threads live in Postgres so commenters (read-only on the live doc) can comment too.
// A thread is its first comment (id === thread_id) plus the replies after it.
// When a comment @mentions an agent, that agent can find it three ways:
//   1. poll or long-poll GET /api/mentions (MCP tool get_mentions does this),
//   2. an optional webhook on its agent token (POSTed right away, signed with HMAC-SHA256),
//   3. read the page's comments (list_comments).
// Replying in the thread marks the agent's mention as handled.
import { createHmac, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Hocuspocus } from '@hocuspocus/server';
import * as Y from 'yjs';
import { COMMENT_LIMITS, cleanAnchor, currentAnchorText, parseMentions, plainBody, textAnchorForQuote, type CommentAnchor, type MentionTarget, MAIN_TAB } from '@livepage/schema';
import type { Db } from './db.ts';
import { randomId, type Principal } from './auth.ts';
import { atLeast, type Role } from './pages.ts';
import { config } from './config.ts';
import { aiAvailable } from './assistant/settings.ts';

export type CommentRow = {
  id: string; page_id: string; thread_id: string; tab: string; anchor: CommentAnchor | null; body: string;
  author_id: string; author_name: string; author_kind: 'human' | 'agent'; token_id: string | null;
  created_at: string; edited_at: string | null; resolved_at: string | null; resolved_by: string | null;
};
export type Thread = CommentRow & { replies: CommentRow[]; current_text?: string | null };
export type Mentionable = { kind: 'user' | 'agent'; id: string; name: string; detail: string };

const COLS = 'id, page_id, thread_id, tab, anchor, body, author_id, author_name, author_kind, token_id, created_at, edited_at, resolved_at, resolved_by';
export const isCommentId = (s: string | undefined) => !!s && /^c_[\w-]{8,40}$/.test(s);

/** Tell every open browser on this page to reload its comments. */
function broadcast(hp: Hocuspocus, pageId: string) {
  hp.documents.get(pageId)?.broadcastStateless(JSON.stringify({ type: 'comments' }));
}

/** Who can be @mentioned on a page: its members, and the agents (tokens) of members who can comment. */
export async function mentionables(db: Db, pageId: string): Promise<Mentionable[]> {
  const people = await db.query(
    `select u.id, u.name, m.role from page_members m join users u on u.id = m.user_id where m.page_id = $1 order by u.name`, [pageId]);
  const agents = await db.query(
    `select t.id, t.name, u.name as owner_name from api_tokens t
       join page_members m on m.user_id = t.user_id and m.page_id = $1 and m.role in ('owner','editor','commenter')
       join users u on u.id = t.user_id order by t.name`, [pageId]);
  return [
    // The built-in assistant: mentioning it runs it as whoever wrote the comment, with their own key.
    ...(aiAvailable() ? [{ kind: 'agent' as const, id: ASSISTANT_ID, name: 'AI', detail: 'Built-in assistant · uses your own key' }] : []),
    ...agents.map((a) => ({ kind: 'agent' as const, id: a.id, name: a.name, detail: `Agent · ${a.owner_name}` })),
    ...people.map((p) => ({ kind: 'user' as const, id: p.id, name: p.name, detail: p.role })),
  ];
}

export const ASSISTANT_ID = 'assistant';

export async function listThreads(db: Db, pageId: string, status: 'open' | 'resolved' | 'all' = 'all', doc?: Y.Doc): Promise<Thread[]> {
  const rows = await db.query<CommentRow>(`select ${COLS} from comments where page_id = $1 order by created_at, id`, [pageId]);
  const threads = new Map<string, Thread>();
  for (const r of rows) if (r.id === r.thread_id) threads.set(r.id, { ...r, replies: [] });
  for (const r of rows) if (r.id !== r.thread_id) threads.get(r.thread_id)?.replies.push(r);
  let list = [...threads.values()];
  if (status === 'open') list = list.filter((t) => !t.resolved_at);
  if (status === 'resolved') list = list.filter((t) => t.resolved_at);
  if (doc) for (const t of list) if (t.anchor?.kind === 'text') t.current_text = currentAnchorText(doc, t.anchor);
  return list;
}

export async function getThread(db: Db, pageId: string, threadId: string): Promise<Thread | null> {
  return (await listThreads(db, pageId)).find((t) => t.id === threadId) ?? null;
}

async function getComment(db: Db, pageId: string, id: string): Promise<CommentRow | null> {
  const [row] = await db.query<CommentRow>(`select ${COLS} from comments where page_id = $1 and id = $2`, [pageId, id]);
  return row ?? null;
}

const isAuthor = (c: CommentRow, who: Principal) =>
  c.author_id === who.id && (who.kind === 'agent' ? c.token_id === (who.tokenId ?? null) : c.author_kind === 'human');

/** Body as sent: trimmed, capped, and only mentions of people/agents who can be mentioned here. */
async function checkBody(db: Db, pageId: string, raw: unknown) {
  const body = String(raw ?? '').trim();
  if (!body) throw new HttpError(400, 'Write something first.');
  if (body.length > COMMENT_LIMITS.bodyMax) throw new HttpError(400, `Comments are limited to ${COMMENT_LIMITS.bodyMax} characters.`);
  const allowed = new Map((await mentionables(db, pageId)).map((m) => [`${m.kind}:${m.id}`, m]));
  const mentions = parseMentions(body).filter((m) => allowed.has(`${m.kind}:${m.id}`));
  return { body, mentions };
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export type NewComment = {
  body: unknown;
  threadId?: string;
  tab?: string;
  /** From the web app: an exact anchor. */
  anchor?: unknown;
  /** From agents: the text to anchor to (first match), or a block id. */
  quote?: string;
  blockId?: string;
  occurrence?: number;
};

export async function createComment(db: Db, hp: Hocuspocus, who: Principal, role: Role, pageId: string, input: NewComment): Promise<CommentRow> {
  if (!atLeast(role, 'commenter')) throw new HttpError(403, 'You can view this page but not comment on it.');
  const checked = await checkBody(db, pageId, input.body);
  const body = checked.body;
  let mentions = checked.mentions;
  let threadId: string;
  let tab = MAIN_TAB;
  let anchor: CommentAnchor | null = null;
  const id = randomId('c', 10);

  if (input.threadId) {
    const root = await getComment(db, pageId, input.threadId);
    if (!root || root.id !== root.thread_id) throw new HttpError(404, 'Comment thread not found.');
    threadId = root.id;
    tab = root.tab;
    // A person's reply that @mentions nobody goes to the agents already in the conversation, the way a
    // reply in a chat would: every connected agent that answered in this thread, and the built-in assistant
    // if it answered this person here. Mention anyone and only they are notified.
    if (who.kind === 'human' && !who.superAgent && !mentions.length) mentions = await threadAgents(db, pageId, threadId, who.id);
  } else {
    threadId = id;
    tab = typeof input.tab === 'string' && /^[\w-]{1,64}$/.test(input.tab) ? input.tab : MAIN_TAB;
    if (input.anchor !== undefined) {
      anchor = cleanAnchor(input.anchor);
      if (!anchor) throw new HttpError(400, 'Bad comment anchor.');
    } else if (input.blockId) {
      anchor = { kind: 'block', blockId: String(input.blockId).slice(0, 80) };
    } else if (input.quote) {
      anchor = await withDoc(hp, pageId, who, (doc) => textAnchorForQuote(doc, String(input.quote), tab, Number(input.occurrence) || 1));
      if (!anchor) throw new HttpError(400, 'That text was not found on the page (in this tab). Quote it exactly, within one paragraph.');
    } else {
      anchor = { kind: 'page' };
    }
  }

  const row = await db.tx(async (q) => {
    const [c] = await q<CommentRow>(
      `insert into comments (id, page_id, thread_id, tab, anchor, body, author_id, author_name, author_kind, token_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning ${COLS}`,
      [id, pageId, threadId, tab, anchor ? JSON.stringify(anchor) : null, body, who.id, who.name, who.kind, who.tokenId ?? null]);
    // Answering in a thread handles your own mentions in it.
    const me = who.kind === 'agent' ? ['agent', who.tokenId ?? ''] : ['user', who.id];
    await q(`update comment_mentions set handled_at = now() where thread_id = $1 and target_kind = $2 and target_id = $3 and handled_at is null`,
      [threadId, me[0], me[1]]);
    for (const m of mentions) {
      if (m.kind === me[0] && m.id === me[1]) continue; // mentioning yourself does nothing
      if (m.kind === 'agent' && m.id === ASSISTANT_ID) continue; // the built-in assistant runs right away, no inbox
      await q(`insert into comment_mentions (id, comment_id, page_id, thread_id, target_kind, target_id) values ($1,$2,$3,$4,$5,$6)`,
        [randomId('mn', 10), id, pageId, threadId, m.kind, m.id]);
    }
    if (input.threadId) await q('update comments set resolved_at = null, resolved_by = null where id = $1', [threadId]); // a reply reopens
    return c;
  });

  broadcast(hp, pageId);
  const targets = mentions.filter((m) => !(m.kind === 'agent' && m.id === who.tokenId) && !(m.kind === 'user' && who.kind === 'human' && m.id === who.id));
  for (const m of targets) wake(`${m.kind}:${m.id}`);
  if (who.kind === 'human' && targets.some((m) => m.kind === 'agent' && m.id === ASSISTANT_ID)) {
    void answerWithAssistant(db, hp, who, role, pageId, threadId).catch((e) => console.warn('[comments] assistant:', e.message));
  }
  const agentIds = targets.filter((m) => m.kind === 'agent' && m.id !== ASSISTANT_ID).map((m) => m.id);
  if (agentIds.length) void notifyAgents(db, hp, pageId, row, agentIds).catch((e) => console.warn('[comments] webhook:', e.message));
  return row;
}

/** Agents that replied in a thread, as implicit mentions for a follow-up from this person. */
async function threadAgents(db: Db, pageId: string, threadId: string, personId: string): Promise<MentionTarget[]> {
  const rows = await db.query<{ token_id: string | null; author_id: string }>(
    `select distinct c.token_id, c.author_id from comments c
      where c.page_id = $1 and c.thread_id = $2 and c.author_kind = 'agent'`, [pageId, threadId]);
  const allowed = new Map((await mentionables(db, pageId)).filter((m) => m.kind === 'agent').map((m) => [m.id, m.name]));
  const out: MentionTarget[] = [];
  for (const r of rows) {
    const id = r.token_id ?? (r.author_id === personId ? ASSISTANT_ID : null);
    if (id && allowed.has(id) && !out.some((m) => m.id === id)) out.push({ kind: 'agent', id, name: allowed.get(id)! });
  }
  return out;
}

export async function updateComment(db: Db, hp: Hocuspocus, who: Principal, role: Role, pageId: string, id: string, patch: { body?: unknown; resolved?: unknown }) {
  const c = await getComment(db, pageId, id);
  if (!c) throw new HttpError(404, 'Comment not found.');
  if (patch.body !== undefined) {
    if (!isAuthor(c, who)) throw new HttpError(403, 'Only the author can edit a comment.');
    const { body } = await checkBody(db, pageId, patch.body);
    await db.query('update comments set body = $2, edited_at = now() where id = $1', [id, body]);
  }
  if (patch.resolved !== undefined) {
    if (c.id !== c.thread_id) throw new HttpError(400, 'Resolve the thread (its first comment), not a reply.');
    if (!atLeast(role, 'commenter')) throw new HttpError(403, 'You can view this page but not comment on it.');
    if (patch.resolved) {
      await db.query('update comments set resolved_at = now(), resolved_by = $2 where id = $1', [id, who.name]);
      await db.query('update comment_mentions set handled_at = now() where thread_id = $1 and handled_at is null', [id]);
    } else {
      await db.query('update comments set resolved_at = null, resolved_by = null where id = $1', [id]);
    }
  }
  broadcast(hp, pageId);
  return getComment(db, pageId, id);
}

export async function deleteComment(db: Db, hp: Hocuspocus, who: Principal, role: Role, pageId: string, id: string) {
  const c = await getComment(db, pageId, id);
  if (!c) throw new HttpError(404, 'Comment not found.');
  if (!isAuthor(c, who) && role !== 'owner') throw new HttpError(403, 'Only the author or the page owner can delete a comment.');
  if (c.id === c.thread_id) await db.query('delete from comments where thread_id = $1 and page_id = $2', [id, pageId]);
  else await db.query('delete from comments where id = $1', [id]);
  broadcast(hp, pageId);
}

// ---------------------------------------------------------------------------
// Mentions inbox (people and agents)

export type MentionItem = {
  id: string; page_id: string; page_title: string; thread_id: string; comment_id: string; created_at: string;
  author_name: string; author_kind: string; body: string; text: string; quote: string | null; url: string;
};

function targetOf(who: Principal): [string, string] | null {
  if (who.kind === 'agent') return who.tokenId ? ['agent', who.tokenId] : null;
  return ['user', who.id];
}

export async function listMentions(db: Db, who: Principal, includeHandled = false): Promise<MentionItem[]> {
  const t = targetOf(who);
  if (!t) return [];
  const rows = await db.query(
    `select mn.id, mn.page_id, p.title as page_title, mn.thread_id, mn.comment_id, mn.created_at, mn.handled_at,
            c.author_name, c.author_kind, c.body, r.anchor
       from comment_mentions mn
       join comments c on c.id = mn.comment_id
       join comments r on r.id = mn.thread_id
       join pages p on p.id = mn.page_id
       join page_members m on m.page_id = mn.page_id and m.user_id = $3
      where mn.target_kind = $1 and mn.target_id = $2 ${includeHandled ? '' : 'and mn.handled_at is null'}
      order by mn.created_at desc limit 100`, [t[0], t[1], who.id]);
  return rows.map((r) => ({
    id: r.id, page_id: r.page_id, page_title: r.page_title || 'Untitled', thread_id: r.thread_id, comment_id: r.comment_id,
    created_at: r.created_at, author_name: r.author_name, author_kind: r.author_kind, body: r.body, text: plainBody(r.body),
    quote: r.anchor?.quote ?? null, url: `${config.publicUrl}/p/${r.page_id}?comment=${r.thread_id}`,
    ...(includeHandled ? { handled: !!r.handled_at } : {}),
  }));
}

export async function markMentionDone(db: Db, who: Principal, id: string) {
  const t = targetOf(who);
  if (!t) return;
  await db.query('update comment_mentions set handled_at = now() where id = $1 and target_kind = $2 and target_id = $3', [id, t[0], t[1]]);
}

// Long-poll support: GET /api/mentions?wait=20 returns as soon as a new mention arrives.
const waiters = new Map<string, Set<() => void>>();
function wake(key: string) {
  const set = waiters.get(key);
  if (!set) return;
  waiters.delete(key);
  for (const fn of set) fn();
}
export function waitForMention(who: Principal, ms: number): Promise<void> {
  const t = targetOf(who);
  if (!t || ms <= 0) return Promise.resolve();
  const key = `${t[0]}:${t[1]}`;
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); waiters.get(key)?.delete(done); resolve(); };
    const timer = setTimeout(done, ms);
    let set = waiters.get(key);
    if (!set) waiters.set(key, (set = new Set()));
    set.add(done);
  });
}

// ---------------------------------------------------------------------------
// Agent webhooks

/** Private, loopback and link-local addresses are refused unless WEBHOOK_ALLOW_PRIVATE=1. */
function privateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')) return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? privateAddress(mapped[1]) : false;
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

export async function checkWebhookUrl(raw: string): Promise<string> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new HttpError(400, 'Enter a full URL, like https://example.com/hook.'); }
  const allowPrivate = process.env.WEBHOOK_ALLOW_PRIVATE === '1' || process.env.NODE_ENV !== 'production';
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) throw new HttpError(400, 'Webhooks must use https.');
  if (url.username || url.password) throw new HttpError(400, 'Put secrets in the webhook secret, not the URL.');
  if (!allowPrivate) {
    const addrs = isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true }).catch(() => []);
    if (!addrs.length) throw new HttpError(400, 'That webhook host does not resolve.');
    if (addrs.some((a) => privateAddress(a.address))) throw new HttpError(400, 'Webhooks cannot point at private network addresses.');
  }
  return url.toString();
}

export async function setWebhook(db: Db, userId: string, tokenId: string, rawUrl: unknown): Promise<{ webhook_url: string | null; webhook_secret?: string }> {
  const [tok] = await db.query('select id, webhook_secret from api_tokens where id = $1 and user_id = $2', [tokenId, userId]);
  if (!tok) throw new HttpError(404, 'Agent token not found.');
  if (rawUrl === null || rawUrl === '') {
    await db.query('update api_tokens set webhook_url = null, webhook_secret = null where id = $1', [tokenId]);
    return { webhook_url: null };
  }
  const url = await checkWebhookUrl(String(rawUrl));
  const secret = tok.webhook_secret ?? `whsec_${randomBytes(24).toString('base64url')}`;
  await db.query('update api_tokens set webhook_url = $2, webhook_secret = $3 where id = $1', [tokenId, url, secret]);
  return { webhook_url: url, webhook_secret: secret };
}

async function notifyAgents(db: Db, hp: Hocuspocus, pageId: string, comment: CommentRow, tokenIds: string[]) {
  const hooks = await db.query('select id, name, webhook_url, webhook_secret from api_tokens where id = any($1) and webhook_url is not null', [tokenIds]);
  if (!hooks.length) return;
  const thread = await getThread(db, pageId, comment.thread_id);
  const [page] = await db.query('select title from pages where id = $1', [pageId]);
  const currentText = thread?.anchor?.kind === 'text'
    ? await withDoc(hp, pageId, null, (doc) => currentAnchorText(doc, thread.anchor!)).catch(() => null)
    : null;
  for (const h of hooks) {
    const payload = JSON.stringify({
      type: 'comment.mention',
      delivered_at: new Date().toISOString(),
      agent: { token_id: h.id, name: h.name },
      page: { id: pageId, title: page?.title || 'Untitled', url: `${config.publicUrl}/p/${pageId}` },
      comment: { id: comment.id, thread_id: comment.thread_id, author_name: comment.author_name, author_kind: comment.author_kind, body: comment.body, text: plainBody(comment.body) },
      thread: thread && {
        id: thread.id, tab: thread.tab, anchor: thread.anchor?.kind ?? 'page', block_id: thread.anchor?.kind === 'block' ? thread.anchor.blockId : undefined,
        quote: currentText ?? (thread.anchor && 'quote' in thread.anchor ? thread.anchor.quote : null),
        comments: [thread, ...thread.replies].map((c) => ({ id: c.id, author_name: c.author_name, author_kind: c.author_kind, text: plainBody(c.body), created_at: c.created_at })),
      },
      reply_with: {
        http: `POST ${config.publicUrl}/api/pages/${pageId}/comments/${comment.thread_id}  {"body": "..."}  (Authorization: Bearer <this agent's token>)`,
        mcp: `reply_to_comment { page: "${pageId}", thread_id: "${comment.thread_id}", body: "..." }`,
      },
    });
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
          'x-livepage-event': 'comment.mention',
          'x-livepage-timestamp': ts,
          'x-livepage-signature': `sha256=${sig}`,
        },
        body: payload,
      });
      if (!res.ok) console.warn(`[comments] webhook for ${h.id} answered ${res.status}`);
    } catch (e) {
      console.warn(`[comments] webhook for ${h.id} failed: ${(e as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------

/** Run fn against the live page document (loads it if no one has it open). */
async function withDoc<T>(hp: Hocuspocus, pageId: string, who: Principal | null, fn: (doc: Y.Doc) => T): Promise<T> {
  const conn = await hp.openDirectConnection(pageId, { user: who ? { id: who.id, name: who.name, kind: who.kind } : { id: 'system', name: 'Livepage', kind: 'agent' } });
  try {
    let out!: T;
    // Read-only work, but transact gives us the loaded document.
    await conn.transact((d) => { out = fn(d as unknown as Y.Doc); });
    return out;
  } finally {
    await conn.disconnect();
  }
}

export async function threadsWithText(db: Db, hp: Hocuspocus, who: Principal, pageId: string, status: 'open' | 'resolved' | 'all') {
  const rows = await listThreads(db, pageId, status);
  if (!rows.some((t) => t.anchor?.kind === 'text')) return rows;
  return withDoc(hp, pageId, who, (doc) => {
    for (const t of rows) if (t.anchor?.kind === 'text') t.current_text = currentAnchorText(doc, t.anchor);
    return rows;
  });
}

// ---------------------------------------------------------------------------
// @AI in a comment: run the built-in assistant as the comment's author (their key, their access),
// on the thread's tab with the commented text as the selection, and answer in the thread.

const ASSISTANT_TIMEOUT_MS = 5 * 60_000;

async function answerWithAssistant(db: Db, hp: Hocuspocus, who: Principal, role: Role, pageId: string, threadId: string) {
  const { runAssistant, assistantName } = await import('./assistant/run.ts');
  const { canEdit } = await import('./pages.ts');
  const bot: Principal = { id: who.id, email: who.email, name: assistantName(who), kind: 'agent' };
  const reply = await createComment(db, hp, bot, role, pageId, { body: 'Working on it…', threadId });
  const setBody = async (text: string) => {
    await db.query('update comments set body = $2, edited_at = now() where id = $1', [reply.id, text.slice(0, COMMENT_LIMITS.bodyMax) || 'Done.']);
    broadcast(hp, pageId);
  };
  if (!canEdit(role)) return setBody('I can only work on pages you can edit. Ask the page owner for edit access.');

  const thread = await getThread(db, pageId, threadId);
  if (!thread) return;
  const quote = thread.anchor?.kind === 'text'
    ? await withDoc(hp, pageId, null, (doc) => currentAnchorText(doc, thread.anchor!)).catch(() => (thread.anchor as { quote?: string }).quote ?? '')
    : '';
  const all = [thread, ...thread.replies].filter((c) => c.id !== reply.id);
  const last = all[all.length - 1];
  const history = all.slice(0, -1).map((c) => ({
    role: (c.author_kind === 'agent' && c.author_id === who.id && !c.token_id ? 'assistant' : 'user') as 'user' | 'assistant',
    text: `${c.author_kind === 'human' ? `${c.author_name}: ` : ''}${plainBody(c.body)}`,
  }));
  const prompt = `${who.name} wrote to you in a comment on this page${quote ? ' (on the selected text)' : ''}. ` +
    `Do what the comment asks, on the page if it asks for changes. Your final message is posted as your reply in the comment thread, so keep it short.\n\n` +
    `Comment: ${plainBody(last.body).replace(/@AI\b/g, '').trim()}`;

  let text = '';
  const errors: string[] = [];
  try {
    await runAssistant({
      db, user: who, pageId, tab: thread.tab, prompt, history, selection: quote || '',
      signal: AbortSignal.timeout(ASSISTANT_TIMEOUT_MS),
      emit: (e) => {
        if (e.type === 'done') text = e.text || (e.changes.length ? `Done: ${e.changes.join(', ')}.` : 'Done.');
        else if (e.type === 'error') errors.push(e.message);
      },
    });
  } catch (e) {
    errors.push((e as Error).message);
  }
  await setBody([text, ...errors.map((m) => `(${m})`)].filter(Boolean).join('\n\n') || 'Done.');
}
