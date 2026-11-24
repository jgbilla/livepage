// Wake a cloud agent (Devin) when one of your agents gets work: set it up, see its sessions, and send
// a page of context (for example "About me") into its knowledge. Server side: apps/server/src/agent-wake.ts.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { titleOf, useWorkspace } from '../workspace';
import { Icon } from '../design/Icon';

export type WakeEvents = { tasks: boolean; asks: boolean; mentions: boolean };
export type Wake = {
  provider: string; provider_label: string; key_hint: string; org_id: string | null; events: WakeEvents;
  playbook_id: string | null; max_acu: number | null; max_per_hour: number;
  knowledge: { page_id: string | null; notes: number; synced_at: string | null };
  last_error: string | null; last_error_at: string | null;
};
type WakeSession = { work_key: string; title: string; session_url: string; started_at: string; last_message_at: string | null };

const WHAT: { key: keyof WakeEvents; label: string }[] = [
  { key: 'tasks', label: 'Tasks from the task board' },
  { key: 'asks', label: 'Ask AI requests' },
  { key: 'mentions', label: 'Comments that @mention it' },
];

export function WakeDialog({ token, onClose }: { token: { id: string; name: string; last_used_at: string | null; wake: Wake | null }; onClose: () => void }) {
  const ws = useWorkspace();
  const [wake, setWake] = useState<Wake | null>(token.wake);
  const [sessions, setSessions] = useState<WakeSession[]>([]);
  const [key, setKey] = useState('');
  const [orgId, setOrgId] = useState(token.wake?.org_id ?? '');
  const [events, setEvents] = useState<WakeEvents>(token.wake?.events ?? { tasks: true, asks: true, mentions: true });
  const [perHour, setPerHour] = useState(String(token.wake?.max_per_hour ?? 10));
  const [maxAcu, setMaxAcu] = useState(token.wake?.max_acu ? String(token.wake.max_acu) : '');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null); // the agent's new token, shown once
  const [pageId, setPageId] = useState(token.wake?.knowledge.page_id ?? '');
  const [sent, setSent] = useState<string | null>(null);

  const load = () => api<{ wake: Wake | null; sessions: WakeSession[] }>(`/tokens/${token.id}/wake`).then((r) => { setWake(r.wake); setSessions(r.sessions); }).catch(() => {});
  useEffect(() => { void load(); }, [token.id]);

  const legacy = (key || wake?.key_hint || '').startsWith('apk_');
  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what); setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    void run('save', async () => {
      const r = await api<{ wake: Wake; agent_token?: string }>(`/tokens/${token.id}/wake`, {
        method: 'PUT',
        body: { provider: 'devin', ...(key.trim() ? { api_key: key.trim() } : {}), org_id: legacy ? '' : orgId.trim(), events, max_per_hour: perHour, max_acu: maxAcu.trim() || null },
      });
      setWake(r.wake); setKey('');
      if (r.agent_token) setFresh(r.agent_token);
    });
  };
  const off = () => {
    if (!confirm(`Stop waking Devin for ${token.name}? Its sessions keep running; new work waits until something listens for it.`)) return;
    void run('off', async () => { await api(`/tokens/${token.id}/wake`, { method: 'DELETE' }); onClose(); });
  };
  const test = () => void run('test', async () => { await api(`/tokens/${token.id}/wake/test`, { method: 'POST' }); await load(); setSent('The key works.'); });
  const sendContext = () => void run('knowledge', async () => {
    const r = await api<{ notes: string[] }>(`/tokens/${token.id}/wake/knowledge`, { body: { page_id: pageId } });
    setSent(`Sent ${r.notes.length} notes to Devin's Knowledge.`);
    await load();
  });

  const mcpUrl = `${location.origin}/mcp`;
  const pages = (ws?.pages ?? []).filter((p) => p.role === 'owner');

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal wake-dialog" role="dialog" aria-label={`Wake ${token.name} with Devin`} aria-modal="true">
        <div className="row">
          <h2>{token.name === 'Devin' ? 'Devin in the cloud' : `Wake ${token.name} with Devin`}</h2>
          <span className="spacer" />
          <button type="button" className="ghost icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <p className="muted small">When {token.name} gets work and isn't already listening, Livepage starts a Devin session for it. The session takes the work, edits your pages and reports back here. Follow-ups on the same task, Ask chat or comment thread go to the same session.</p>

        {fresh ? (
          <div className="token-fresh">
            <p><b>Devin is set up.</b> Each session gets {token.name}'s token as a secret, so it can reach Livepage on its own.{!token.last_used_at ? '' : ` If anything else used ${token.name}'s old token, it needs this new one.`}</p>
            <p className="small"><b>Recommended:</b> add Livepage to Devin as an MCP server, so Devin gets Livepage's tools directly. In Devin, open Customize, then MCPs, and add a custom server:</p>
            <dl className="wake-mcp small">
              <dt>Transport</dt><dd>Streamable HTTP</dd>
              <dt>URL</dt><dd><code className="copy">{mcpUrl}</code></dd>
              <dt>Header</dt><dd><code className="copy">Authorization: Bearer {fresh}</code></dd>
            </dl>
            <p className="small">Copy it now: this token won't be shown again.</p>
            <button type="button" className="link" onClick={() => setFresh(null)}>Done</button>
          </div>
        ) : (
          <form onSubmit={save}>
            <label className="field">Devin API key
              <input type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)}
                placeholder={wake ? `Saved (${wake.key_hint}). Paste a new one to replace it.` : 'cog_… (service user) or apk_… (legacy key)'} />
            </label>
            <p className="muted small">In Devin: Settings, then Devin API. A service user with the Member role is enough. Livepage keeps the key encrypted and never shows it again.</p>
            {!legacy && (
              <label className="field">Org id
                <input spellCheck={false} autoCapitalize="off" value={orgId} onChange={(e) => setOrgId(e.target.value)} placeholder="org-… (top of Settings, then Devin API)" />
              </label>
            )}
            <fieldset className="wake-events">
              <legend>Wake for</legend>
              {WHAT.map((w) => (
                <label key={w.key}><input type="checkbox" checked={events[w.key]} onChange={(e) => setEvents({ ...events, [w.key]: e.target.checked })} />{w.label}</label>
              ))}
            </fieldset>
            <div className="wake-limits">
              <label className="field">At most, sessions per hour
                <input inputMode="numeric" value={perHour} onChange={(e) => setPerHour(e.target.value.replace(/\D/g, ''))} />
              </label>
              <label className="field">ACU limit per session
                <input inputMode="numeric" value={maxAcu} placeholder="Devin's default" onChange={(e) => setMaxAcu(e.target.value.replace(/\D/g, ''))} />
              </label>
            </div>
            <div className="row modal-buttons">
              {wake && <button type="button" className="danger" onClick={off} disabled={!!busy}>Turn off</button>}
              <span className="spacer" />
              {wake && <button type="button" className="ghost" onClick={test} disabled={!!busy}>{busy === 'test' ? 'Checking…' : 'Check key'}</button>}
              <button type="submit" className="primary" disabled={!!busy || (!wake && !key.trim())}>{busy === 'save' ? 'Checking with Devin…' : wake ? 'Save' : 'Turn on'}</button>
            </div>
          </form>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        {wake?.last_error && !error && <p className="form-error"><Icon name="alert" size={14} /> {wake.last_error}</p>}

        {wake && (
          <>
            <h3>What Devin knows about you</h3>
            <p className="muted small">Pick a page about you (who you are, how you like to work, your projects). Livepage copies it into Devin's Knowledge, one note per section, plus a note on how to work with Livepage. Send it again after you edit the page; it updates the same notes.</p>
            <div className="row wake-knowledge">
              <select value={pageId} onChange={(e) => setPageId(e.target.value)} aria-label="Page to send">
                <option value="">Choose a page…</option>
                {pages.map((p) => <option key={p.id} value={p.id}>{titleOf(p) || 'Untitled'}</option>)}
              </select>
              <button type="button" onClick={sendContext} disabled={!pageId || !!busy}><Icon name="send" />{busy === 'knowledge' ? 'Sending…' : 'Send to Devin'}</button>
            </div>
            {wake.knowledge.synced_at && <p className="muted small">Last sent {new Date(wake.knowledge.synced_at).toLocaleString()} ({wake.knowledge.notes} notes).</p>}
            {sent && <p className="small" role="status">{sent}</p>}

            {sessions.length > 0 && (
              <>
                <h3>Recent sessions</h3>
                <ul className="wake-sessions">
                  {sessions.map((s) => (
                    <li key={s.work_key}>
                      <a href={s.session_url} target="_blank" rel="noreferrer">{s.title || s.work_key}<Icon name="external" size={12} /></a>
                      <span className="muted small">{new Date(s.last_message_at ?? s.started_at).toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
