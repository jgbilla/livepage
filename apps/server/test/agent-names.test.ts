import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentDisplayName, clientDisplayName } from '@livepage/agent/tools';

test('agents show their token name, or their MCP client when the token name says nothing', () => {
  assert.equal(agentDisplayName('Research bot', 'claude-code'), 'Research bot');
  assert.equal(agentDisplayName('Agent', 'claude-code'), 'Claude Code');
  assert.equal(agentDisplayName('', 'cursor-vscode'), 'Cursor');
  assert.equal(agentDisplayName('Agent', undefined), 'Agent');
  assert.equal(agentDisplayName(undefined, undefined), 'Agent');
});

test('MCP client names read like products', () => {
  assert.equal(clientDisplayName('gemini-cli-mcp-client'), 'Gemini CLI');
  assert.equal(clientDisplayName('codex-mcp-client'), 'Codex');
  assert.equal(clientDisplayName('Visual Studio Code'), 'VS Code');
  assert.equal(clientDisplayName('my-cool-agent'), 'My Cool Agent');
  assert.equal(clientDisplayName('mcp-client'), undefined);
});

import { presenceUser } from '../src/presence.ts';

test('presence shows the name the person gave the agent token, whatever the agent claims', () => {
  const tok = { id: 'u_1', name: 'Claude on my Mac', kind: 'agent' as const, tokenId: 'tok_1' };
  assert.deepEqual(presenceUser(tok, { name: 'Agent', color: '#6e56cf', kind: 'agent' }), { name: 'Claude on my Mac', color: '#6e56cf', kind: 'agent', id: 'agent:tok_1' });
  assert.equal(presenceUser(tok, { name: 'Jean Billa', kind: 'human' }).name, 'Claude on my Mac');
  assert.equal(presenceUser(tok, { name: 'Jean Billa', kind: 'human' }).kind, 'agent');
});

test('an unnamed token ("Agent") falls back to the name the agent gives itself', () => {
  const tok = { id: 'u_1', name: 'Agent', kind: 'agent' as const, tokenId: 'tok_2' };
  assert.equal(presenceUser(tok, { name: 'Claude Code' }).name, 'Claude Code');
  assert.equal(presenceUser(tok, {}).name, 'Agent');
});

test('people show their account name and cannot appear as an agent', () => {
  const me = { id: 'u_1', name: 'Jean Billa', kind: 'human' as const };
  assert.deepEqual(presenceUser(me, { name: 'Totally Claude', kind: 'agent', color: '#123456' }), { name: 'Jean Billa', kind: 'human', color: '#123456', id: 'u_1' });
});
