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
