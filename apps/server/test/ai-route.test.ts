// @AI follows the Ask AI pick. Run: pnpm --filter @livepage/server test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickAiRoute, routeDetail } from '../src/ai-route.ts';

const claude = { id: 'tok_1', name: 'Claude Code', online: true };

test('@AI: no agent picked uses the built-in assistant', () => {
  assert.deepEqual(pickAiRoute(null, true), { kind: 'builtin', ready: true });
  assert.equal(routeDetail(pickAiRoute(null, true)), 'Built-in assistant · uses your own key');
});

test('@AI: a picked agent that is listening answers', () => {
  const r = pickAiRoute(claude, true);
  assert.deepEqual(r, { kind: 'agent', ...claude });
  assert.match(routeDetail(r), /Goes to Claude Code/);
});

test('@AI: picked agent offline falls back to the built-in assistant when it is set up', () => {
  const r = pickAiRoute({ ...claude, online: false }, true);
  assert.equal(r.kind, 'builtin');
  assert.match(r.kind === 'builtin' ? r.note ?? '' : '', /Claude Code isn't listening/);
  assert.equal(routeDetail(r), 'Built-in assistant · Claude Code is offline');
});

test('@AI: picked agent offline and no built-in key waits for the agent', () => {
  const r = pickAiRoute({ ...claude, online: false }, false);
  assert.equal(r.kind, 'agent');
  assert.match(routeDetail(r), /offline, answers when it listens/);
});
