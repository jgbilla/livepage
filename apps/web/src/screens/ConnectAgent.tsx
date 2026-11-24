import { useState } from 'react';
import { api } from '../api';
import { collabUrl } from '../config';
import { Icon } from '../design/Icon';

// How to connect an agent and get it listening, as copy-paste steps. Used on the home page right after
// making a token, and from the task board for an agent that isn't picking work up.

export const LISTEN_COMMAND = '/mcp__livepage__listen';
export const LISTEN_PHRASE = 'Listen for Livepage requests and tasks';

function CopyLine({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* clipboard blocked: the text is selectable */ }
  };
  return (
    <div className="copy-line">
      <code>{text}</code>
      <button type="button" className="ghost icon-btn" onClick={copy} title={done ? 'Copied' : 'Copy'} aria-label={label ? `Copy ${label}` : 'Copy'}>
        <Icon name={done ? 'check' : 'copy'} />
      </button>
    </div>
  );
}

/** The steps themselves. `token` fills the commands in; without one they show lp_... */
export function ConnectSteps({ token, name }: { token: string | null; name: string }) {
  const origin = location.origin;
  const key = token ?? 'lp_...';
  return (
    <ol className="connect-steps">
      <li>
        <b>Connect {name} (once).</b> In a terminal, for Claude Code:
        <CopyLine label="the connect command" text={`claude mcp add --transport http livepage ${origin}/mcp --header "Authorization: Bearer ${key}"`} />
        <details className="connect-more">
          <summary>Cursor, VS Code, Gemini CLI, Codex</summary>
          <p className="muted small">Cursor (~/.cursor/mcp.json), Gemini CLI (~/.gemini/settings.json, with "httpUrl" for "url"):</p>
          <CopyLine label="the MCP config" text={`{ "mcpServers": { "livepage": { "url": "${origin}/mcp", "headers": { "Authorization": "Bearer ${key}" } } } }`} />
          <p className="muted small">VS Code (.vscode/mcp.json):</p>
          <CopyLine label="the VS Code config" text={`{ "servers": { "livepage": { "type": "http", "url": "${origin}/mcp", "headers": { "Authorization": "Bearer ${key}" } } } }`} />
        </details>
      </li>
      <li>
        <b>Start it listening.</b> In Claude Code, run:
        <CopyLine label="the listen command" text={LISTEN_COMMAND} />
        <span className="muted small">Any other agent: tell it “{LISTEN_PHRASE}”. It then picks up Ask AI requests, tasks and @mentions until you stop it.</span>
      </li>
      <li>
        <b>Optional: no listening loop.</b> From a clone of the repo, Livepage can push work straight into a Claude Code session:
        <CopyLine label="the channel setup" text={`claude mcp add livepage -e LIVEPAGE_CHANNEL=1 -e LIVEPAGE_URL=${collabUrl()} -e AGENT_TOKEN=${key} -- pnpm --silent --dir /path/to/livepage agent:mcp`} />
        <CopyLine label="the start command" text="claude --dangerously-load-development-channels server:livepage" />
      </li>
    </ol>
  );
}

/** A dialog for one agent. Its key can't be shown again, so it offers a new one to fill the commands in. */
export function ConnectAgentDialog({ agent, onClose }: { agent: { id: string; name: string }; onClose: () => void }) {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const newKey = async () => {
    if (!confirm(`Make a new key for ${agent.name}? The old key stops working, so anything still using it must be reconnected.`)) return;
    setBusy(true); setError(null);
    try { setToken((await api<{ token: string }>(`/tokens/${agent.id}/rotate`, { body: {} })).token); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal connect-dialog" role="dialog" aria-label={`Connect ${agent.name}`} onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <h2>Get {agent.name} listening</h2>
          <span className="spacer" />
          <button type="button" className="ghost icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <p className="muted small">Already connected? Skip to step 2. An agent only picks up work while it's listening.</p>
        {token
          ? <p className="token-fresh small"><b>New key made.</b> It's filled in below and won't be shown again. The old key no longer works.</p>
          : <p className="small">The commands need {agent.name}'s key, which is only shown once. <button type="button" className="link" disabled={busy} onClick={newKey}>Make a new key to fill them in</button></p>}
        {error && <p className="form-error small">{error}</p>}
        <ConnectSteps token={token} name={agent.name} />
        <div className="row modal-buttons"><button type="button" className="primary" onClick={onClose}>Done</button></div>
      </div>
    </div>
  );
}
