import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../src/db.ts';
import { claimTasks, UNCONFIRMED_AFTER } from '../src/tasks.ts';
import { isUnconfirming, presenceOf } from '../src/agent-requests.ts';

// An agent whose loop takes tasks but never confirms them (each 45s lease runs out) is caught:
// it stops counting as ready, and an "any available agent" task is left for another agent.
test('an agent that keeps taking a task without confirming it is flagged, and stops getting open tasks', async () => {
  process.env.LIVEPAGE_MEMORY_STORE = '1';
  const db = await connect(undefined);
  await db.query(`insert into users (id, email, name, password_hash) values ('u_t', 't@example.com', 'Jean', 'x')`);
  await db.query(`insert into api_tokens (id, user_id, name, token_hash) values ('tok_a', 'u_t', 'Broken loop', 'h_a'), ('tok_b', 'u_t', 'Cursor', 'h_b')`);
  await db.query(`insert into agent_tasks (id, user_id, token_id, any_agent, title) values ('tk_any', 'u_t', null, true, 'Draft the launch post')`);
  const leaseRunsOut = () => db.query(`update agent_tasks set delivered_at = now() - interval '1 minute'`);

  for (let i = 1; i <= UNCONFIRMED_AFTER; i++) {
    const got = await claimTasks(db, 'tok_a', 'u_t');
    assert.deepEqual(got.map((t) => t.id), ['tk_any'], `delivery ${i}`);
    assert.equal(isUnconfirming('tok_a'), i >= UNCONFIRMED_AFTER);
    await leaseRunsOut();
  }
  assert.equal(presenceOf('tok_a').unconfirmed, true);
  assert.equal(presenceOf('tok_a').listening, false, 'not shown as ready');
  assert.deepEqual(await claimTasks(db, 'tok_a', 'u_t'), [], 'the broken loop stops getting the open task');
  assert.deepEqual((await claimTasks(db, 'tok_b', 'u_t')).map((t) => t.id), ['tk_any'], 'another agent can take it');
  const [row] = await db.query(`select delivered_to, delivery_count from agent_tasks where id = 'tk_any'`);
  assert.deepEqual(row, { delivered_to: 'tok_b', delivery_count: 1 });
});
