import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

// A fake Devin API, and an in-memory Postgres.
type Call = { method: string; path: string; body: any };
const calls: Call[] = [];
let sessionStatus = 'running';
let n = 0;
const devin = createServer(async (req: IncomingMessage, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : null;
  calls.push({ method: req.method!, path: req.url!, body });
  assert.equal(req.headers.authorization, 'Bearer cog_test_key_123456');
  res.setHeader('content-type', 'application/json');
  if (req.method === 'POST' && req.url!.endsWith('/sessions')) {
    // Slow enough that events arriving together overlap.
    await new Promise((r) => setTimeout(r, 50));
    const id = `devin-${++n}`;
    return res.end(JSON.stringify({ session_id: id, url: `https://app.devin.ai/sessions/${n}`, status: 'new' }));
  }
  if (req.method === 'GET' && /\/sessions\/devin-\d+$/.test(req.url!)) return res.end(JSON.stringify({ status: sessionStatus }));
  if (req.method === 'POST' && req.url!.endsWith('/knowledge/notes')) return res.end(JSON.stringify({ note_id: `note-${++n}` }));
  if (req.method === 'PUT' && req.url!.includes('/knowledge/notes/')) return res.end(JSON.stringify({ note_id: req.url!.split('/').pop() }));
  res.end(JSON.stringify({ items: [] }));
});
await new Promise<void>((r) => devin.listen(0, '127.0.0.1', r));
process.env.DEVIN_API_URL = `http://127.0.0.1:${(devin.address() as AddressInfo).port}`;
process.env.LIVEPAGE_MEMORY_STORE = '1';

const { connect } = await import('../src/db.ts');
const { createApiToken } = await import('../src/auth.ts');
const { handleWake, wakeForEvent } = await import('../src/agent-wake.ts');
const db = await connect(undefined);
await db.query(`insert into users (id, email, name, password_hash) values ('u_1', 'j@example.com', 'Jean', 'x')`);
const tok = await createApiToken(db, 'u_1', 'Devin');
await db.query(`insert into agent_tasks (id, user_id, token_id, title) values ('tk_1', 'u_1', $1, 'Tighten the intro'), ('tk_2', 'u_1', $1, 'Second')`, [tok.id]);
const who = { id: 'u_1', email: 'j@example.com', name: 'Jean', kind: 'human' as const };

const app = createServer((req, res) => void handleWake(req, res, db, null as any, who, new URL(req.url!, 'http://x').pathname, () => {}).then((ok) => { if (!ok) res.writeHead(404).end(); }));
await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json() as any };
};
const event = (type: string, data: Record<string, unknown>, text = 'New task from Jean: "Tighten the intro".') =>
  ({ id: `e${Math.random()}`, type, at: new Date().toISOString(), text, data }) as any;

test('setting up Devin checks the key, keeps it encrypted, and gives the agent a token to hand over', async () => {
  const bad = await call('PUT', `/api/tokens/${tok.id}/wake`, { provider: 'devin', api_key: 'cog_test_key_123456' });
  assert.equal(bad.status, 400, 'a cog_ key needs the org id');
  const r = await call('PUT', `/api/tokens/${tok.id}/wake`, { provider: 'devin', api_key: 'cog_test_key_123456', org_id: 'org-abc', max_per_hour: 3 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(r.json.agent_token, /^lp_/);
  assert.equal(r.json.wake.key_hint, 'cog_…3456');
  assert.ok(calls.some((c) => c.method === 'GET' && c.path === '/v3/organizations/org-abc/sessions?first=1'), 'the key was checked');
  const [row] = await db.query('select api_key_enc, agent_token_enc from agent_wake_configs where token_id = $1', [tok.id]);
  assert.ok(!row.api_key_enc.includes('cog_test') && !row.agent_token_enc.includes('lp_'), 'stored encrypted');
  // Saving again (without a new key) keeps the key and the token.
  const again = await call('PUT', `/api/tokens/${tok.id}/wake`, { events: { tasks: true, asks: false, mentions: true } });
  assert.equal(again.status, 200);
  assert.equal(again.json.agent_token, undefined);
  assert.equal(again.json.wake.events.asks, false);
  (globalThis as any).agentToken = r.json.agent_token;
});

test('a task starts one Devin session, with the token as a secret; follow-ups go to it', async () => {
  calls.length = 0;
  const e = event('task.assigned', { task: { id: 'tk_1', title: 'Tighten the intro' }, take_with: { mcp: 'wait_for_requests', http: 'GET /api/agent-requests' } });
  await Promise.all([wakeForEvent(db, tok.id, e), wakeForEvent(db, tok.id, e), wakeForEvent(db, tok.id, e)]);
  const starts = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/sessions'));
  assert.equal(starts.length, 1, 'events arriving together start one session');
  const s = starts[0].body;
  assert.match(s.prompt, /Tighten the intro/);
  assert.match(s.prompt, /\$LIVEPAGE_TOKEN/);
  assert.ok(!s.prompt.includes('lp_'), 'the token is not in the prompt');
  assert.deepEqual(s.session_secrets.find((x: any) => x.key === 'LIVEPAGE_TOKEN'), { key: 'LIVEPAGE_TOKEN', value: (globalThis as any).agentToken, sensitive: true });
  const [ev] = await db.query(`select text from agent_task_events where task_id = 'tk_1'`);
  assert.match(ev.text, /app\.devin\.ai\/sessions\/1/, 'the task links to the session');

  calls.length = 0;
  await wakeForEvent(db, tok.id, event('task.message', { task: { id: 'tk_1' } }, 'Jean wrote on task tk_1: shorter please'));
  assert.equal(calls.filter((c) => c.path.endsWith('/sessions')).length, 0, 'no new session');
  const msg = calls.find((c) => c.path.endsWith('/sessions/devin-1/messages'));
  assert.match(msg!.body.message, /shorter please/);

  calls.length = 0;
  await wakeForEvent(db, tok.id, event('task.cancelled', { task: { id: 'tk_1' } }, 'Jean cancelled task tk_1.'));
  assert.match(calls.find((c) => c.path.endsWith('/messages'))!.body.message, /Stop now/);

  // Ask AI is turned off for this agent.
  calls.length = 0;
  await wakeForEvent(db, tok.id, event('request.created', { page: { id: 'p_1' }, request: { id: 'ar_1' } }));
  assert.equal(calls.length, 0);
});

test('a session that ended is replaced, and the hourly limit holds', async () => {
  sessionStatus = 'exit';
  calls.length = 0;
  await wakeForEvent(db, tok.id, event('task.message', { task: { id: 'tk_1' } }, 'Jean reopened it'));
  assert.equal(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/sessions')).length, 1, 'new session for the reopened task');
  sessionStatus = 'running';
  // Limit is 3 an hour: two started so far, one more is allowed, then none.
  calls.length = 0;
  await wakeForEvent(db, tok.id, event('task.assigned', { task: { id: 'tk_2' } }));
  assert.equal(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/sessions')).length, 1);
  calls.length = 0;
  await wakeForEvent(db, tok.id, event('comment.mention', { page: { id: 'p_1' }, thread: { id: 'th_1' } }, 'Jean mentioned you'));
  assert.equal(calls.length, 0, 'over the limit: nothing started');
  const g = await call('GET', `/api/tokens/${tok.id}/wake`);
  assert.match(g.json.wake.last_error, /limit is 3/);
  assert.equal(g.json.sessions.length, 2);
});

test('only the owner can see or change it', async () => {
  await db.query(`insert into users (id, email, name, password_hash) values ('u_2', 'o@example.com', 'Other', 'x')`);
  const other = createServer((req, res) => void handleWake(req, res, db, null as any, { ...who, id: 'u_2' }, new URL(req.url!, 'http://x').pathname, () => {}));
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
  const r = await fetch(`http://127.0.0.1:${(other.address() as AddressInfo).port}/api/tokens/${tok.id}/wake`);
  assert.equal(r.status, 404);
  other.close();
  app.close();
  devin.close();
});
