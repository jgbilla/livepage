import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { followAgentEvents, type LivepageEvent } from '@livepage/agent/events';
import { handleAgentEvents, pushToAgent, streamCount } from '../src/agent-push.ts';
import type { Db } from '../src/db.ts';

// No database needed: nothing is waiting, and the token has no webhook.
const db = { query: async (sql: string) => (sql.includes('count(*)') ? [{ requests: 0, mentions: 0, tasks: 1 }] : []), tx: async () => { throw new Error('unused'); } } as unknown as Db;
const who = { id: 'u_1', email: '', name: 'Claude Code', kind: 'agent' as const, tokenId: 'tok_test' };

test('an agent following its event stream gets work the moment it is pushed', async () => {
  const server = createServer((req, res) => void handleAgentEvents(req, res, db, who));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const got: LivepageEvent[] = [];
  const ready = new Promise<void>((resolve) => {
    const stop = followAgentEvents({
      baseUrl: `http://127.0.0.1:${port}`, token: 'lp_x',
      onEvent: (e) => { got.push(e); if (e.type === 'ready') resolve(); if (e.type === 'task.assigned') { stop(); done(); } },
    });
  });
  let done!: () => void;
  const assigned = new Promise<void>((r) => { done = r; });
  await ready;
  assert.equal(streamCount('tok_test'), 1, 'an open stream counts as listening');
  assert.match(got[0].text, /1 task/, 'ready says what is already waiting');
  pushToAgent(db, 'tok_test', 'task.assigned', 'New task from Jean: "Tighten the intro".', { task: { id: 'tk_1' } });
  await assigned;
  const e = got.find((x) => x.type === 'task.assigned')!;
  assert.equal(e.text, 'New task from Jean: "Tighten the intro".');
  assert.deepEqual(e.data, { task: { id: 'tk_1' } });
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});
