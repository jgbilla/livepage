import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { AiSettings, type AiSettingsValue } from './AiSettings';
import { Icon } from '../design/Icon';

type ToolStep = { id: string; name: string; status: 'running' | 'done' | 'error'; note?: string };
type Turn = { role: 'user' | 'assistant'; text: string; steps?: ToolStep[]; error?: string; selection?: string; model?: string; status?: string };
type Agent = { id: string; name: string; online: boolean };
type AgentReq = {
  id: string; status: 'pending' | 'working' | 'done' | 'cancelled'; progress: string; reply: string; sig: string; agent_online: boolean; agent_name: string;
  /** queued: waiting for a poll; delivered: a poll took it but the agent hasn't confirmed; working: confirmed. */
  delivery?: 'queued' | 'delivered' | 'working' | 'finished';
};
const BUILTIN = 'builtin';
const loadTarget = () => { try { return localStorage.getItem('livepage.askTarget') || BUILTIN; } catch { return BUILTIN; } };
const saveTarget = (v: string) => { try { localStorage.setItem('livepage.askTarget', v); } catch { /* private mode */ } };

const LABELS: Record<string, string> = {
  read_page: 'Reading the page', write_paragraph: 'Writing', add_heading: 'Adding a heading', replace_text: 'Editing text',
  insert_table: 'Making a table', insert_mind_map: 'Making a mind map', add_mind_map_node: 'Growing the mind map',
  insert_custom_ui: 'Building a custom block', update_html_block: 'Updating a block', add_tab: 'Adding a tab',
};
const SUGGESTIONS = ['Summarize this page', 'Continue writing from where I stopped', 'Turn this into a table', 'Make an animated diagram of this'];

/** Text selected inside the editor, remembered so it survives focusing the chat box. */
function useEditorSelection(): [string, () => void] {
  const [sel, setSel] = useState('');
  useEffect(() => {
    const on = () => {
      const s = document.getSelection();
      if (!s || s.isCollapsed) return;
      const node = s.anchorNode instanceof Element ? s.anchorNode : s.anchorNode?.parentElement;
      if (node?.closest('.editor')) setSel(s.toString().trim().slice(0, 8000));
    };
    document.addEventListener('selectionchange', on);
    return () => document.removeEventListener('selectionchange', on);
  }, []);
  return [sel, () => setSel('')];
}

export function AssistantPanel({ pageId, tab, onClose }: { pageId: string; tab: string; onClose: () => void }) {
  const [ready, setReady] = useState<boolean | null>(null);
  const [setup, setSetup] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [selection, clearSelection] = useEditorSelection();
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [target, setTargetState] = useState(loadTarget);
  const setTarget = (v: string) => { setTargetState(v); saveTarget(v); setSetup(false); };
  const agent = agents.find((a) => a.id === target);
  const builtin = target === BUILTIN || !agent;
  const reqRef = useRef<string | null>(null);

  useEffect(() => {
    api<{ settings: AiSettingsValue | null }>('/ai/settings').then((r) => setReady(!!r.settings)).catch(() => setReady(false));
  }, []);
  // Your connected agents and whether they're online; refreshed while the panel is open.
  useEffect(() => {
    const load = () => api<{ agents: Agent[] }>('/agents').then((r) => setAgents(r.agents)).catch(() => {});
    void load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [turns]);
  useEffect(() => () => {
    abortRef.current?.abort();
    if (reqRef.current) void fetch(`/api/agent-requests/${reqRef.current}`, { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
  }, []);

  const patchLast = (fn: (t: Turn) => Turn) => setTurns((ts) => [...ts.slice(0, -1), fn(ts[ts.length - 1])]);

  /** Hand the request to a connected agent (Claude Code, Cursor…) and follow it until it answers. */
  const askAgent = async (a: Agent, prompt: string, sel: string, history: { role: string; text: string }[], ac: AbortController) => {
    // Only say the agent is working once it has confirmed it got the request (or replied).
    const statusFor = (r: AgentReq) =>
      r.status === 'working' ? (r.progress ? `${a.name}: ${r.progress}` : `${a.name} is working on it…`)
        : r.status !== 'pending' ? ''
        : r.delivery === 'delivered' ? `Sent to ${a.name}, waiting for it to confirm…`
        : r.agent_online ? `Waiting for ${a.name} to pick it up…`
        : `${a.name} isn't listening right now. Ask it to “listen for Livepage requests”; this request waits for it.`;
    let { request: r } = await api<{ request: AgentReq }>(`/pages/${pageId}/agent-requests`, { body: { tokenId: a.id, prompt, tab, selection: sel, history } });
    reqRef.current = r.id;
    patchLast((t) => ({ ...t, model: a.name, status: statusFor(r) }));
    while (r.status === 'pending' || r.status === 'working') {
      const res = await fetch(`/api/agent-requests/${r.id}?wait=25&since=${encodeURIComponent(r.sig)}`, { credentials: 'same-origin', signal: ac.signal });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Request failed (${res.status})`);
      r = (await res.json()).request;
      patchLast((t) => ({ ...t, status: statusFor(r) }));
    }
    reqRef.current = null;
    if (r.status === 'cancelled') patchLast((t) => ({ ...t, error: 'Cancelled.' }));
    else patchLast((t) => ({ ...t, text: r.reply || `${a.name} finished without a message.`, status: '' }));
  };

  const stop = () => {
    abortRef.current?.abort();
    if (reqRef.current) { void api(`/agent-requests/${reqRef.current}`, { method: 'DELETE' }).catch(() => {}); reqRef.current = null; }
  };

  const ask = async (prompt: string) => {
    if (!prompt.trim() || busy) return;
    if (agent) {
      const history = turns.filter((t) => t.text).map((t) => ({ role: t.role, text: t.text }));
      const sel = selection;
      setTurns((ts) => [...ts, { role: 'user', text: prompt, selection: sel || undefined }, { role: 'assistant', text: '', steps: [] }]);
      setInput('');
      clearSelection();
      setBusy(true);
      const ac = new AbortController();
      abortRef.current = ac;
      try { await askAgent(agent, prompt, sel, history, ac); }
      catch (e) { patchLast((t) => ({ ...t, status: '', error: (e as Error).name === 'AbortError' ? 'Stopped.' : (e as Error).message })); }
      finally { setBusy(false); abortRef.current = null; }
      return;
    }
    const history = turns.filter((t) => t.text).map((t) => ({ role: t.role, text: t.text }));
    const sel = selection;
    setTurns((ts) => [...ts, { role: 'user', text: prompt, selection: sel || undefined }, { role: 'assistant', text: '', steps: [] }]);
    setInput('');
    clearSelection();
    setBusy(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch(`/api/pages/${pageId}/assistant`, {
        method: 'POST', credentials: 'same-origin', signal: ac.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, tab, history, selection: sel }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 412) setReady(false);
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let afterTool = false; // start a new paragraph when the model talks again after using tools
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          const ev = JSON.parse(line.slice(6));
          if (ev.type === 'start') patchLast((t) => ({ ...t, model: ev.model }));
          else if (ev.type === 'text') {
            const sep = afterTool ? '\n\n' : '';
            afterTool = false;
            patchLast((t) => ({ ...t, text: t.text ? t.text + sep + ev.delta : ev.delta }));
          } else if (ev.type === 'tool') {
            afterTool = true;
            patchLast((t) => {
              const steps = [...(t.steps ?? [])];
              const at = steps.findIndex((s) => s.id === ev.id);
              const step = { id: ev.id, name: ev.name, status: ev.status, note: ev.note };
              if (at >= 0) steps[at] = step; else steps.push(step);
              return { ...t, steps };
            });
          } else if (ev.type === 'error') patchLast((t) => ({ ...t, error: ev.message }));
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') patchLast((t) => ({ ...t, error: (e as Error).message }));
      else patchLast((t) => ({ ...t, error: 'Stopped.' }));
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  return (
    <aside className="assistant" aria-label="AI assistant">
      <div className="assistant-head">
        <h2 className="panel-title"><Icon name="sparkles" />Ask AI</h2>
        <span className="spacer" />
        {ready && builtin && <button type="button" className="ghost" onClick={() => setSetup((v) => !v)}>{setup ? 'Back to chat' : 'Settings'}</button>}
        {turns.length > 0 && !busy && <button type="button" className="ghost" onClick={() => setTurns([])}>Clear</button>}
        <button type="button" className="ghost icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
      </div>

      {agents.length > 0 && (
        <label className="assistant-target">
          <span className="muted small">Ask</span>
          <select value={agent ? agent.id : BUILTIN} onChange={(e) => setTarget(e.target.value)} disabled={busy}>
            <option value={BUILTIN}>Built-in assistant (your API key)</option>
            <optgroup label="Your connected agents">
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}{a.online ? ' (online)' : ''}</option>)}
            </optgroup>
          </select>
        </label>
      )}
      {agent && !agent.online && turns.length === 0 && (
        <p className="small pad agent-hint">
          {agent.name} is offline. In that agent (for example Claude Code with the Livepage MCP server), say
          <code className="copy">Listen for Livepage requests and handle them</code>
          It answers here with everything it already knows: your files, memory and tools.
        </p>
      )}
      {ready === null ? <p className="muted small pad">Loading…</p> : builtin && (!ready || setup) ? (
        <div className="pad">
          {!ready && <p className="small">Use any AI model with your own API key: Claude, GPT, Gemini, anything on OpenRouter, or a local model. It edits this page live, next to you.</p>}
          <AiSettings compact onSaved={(s) => { setReady(!!s); if (s) setSetup(false); }} />
        </div>
      ) : (
        <>
          <div className="assistant-log">
            {turns.length === 0 && (
              <div className="pad">
                <p className="muted small">Ask about this page or have the assistant write, edit or build on it. Select text first to work on just that part.</p>
                <div className="assistant-suggest">
                  {SUGGESTIONS.map((s) => <button type="button" key={s} onClick={() => ask(s)}>{s}</button>)}
                </div>
              </div>
            )}
            {turns.map((t, i) => (
              <div key={i} className={`turn turn-${t.role}`}>
                {t.selection && <div className="turn-sel">“{t.selection.length > 120 ? `${t.selection.slice(0, 120)}…` : t.selection}”</div>}
                {t.steps && t.steps.length > 0 && (
                  <ul className="turn-steps">
                    {t.steps.map((s) => (
                      <li key={s.id} className={`step-${s.status}`} title={s.note}>
                        <Icon name={s.status === 'running' ? 'loader' : s.status === 'done' ? 'check' : 'alert'} className={s.status === 'running' ? 'spin' : undefined} />{LABELS[s.name] ?? s.name}{s.status === 'error' && s.note ? `: ${s.note}` : ''}
                      </li>
                    ))}
                  </ul>
                )}
                {t.status && <div className="turn-status"><Icon name="sparkles" />{t.status}</div>}
                {t.text && <div className="turn-text">{t.text}</div>}
                {t.role === 'assistant' && !t.text && !t.error && busy && i === turns.length - 1 && !(t.steps?.length) && !t.status && <div className="muted small">Thinking…</div>}
                {t.error && <div className="form-error small">{t.error}</div>}
              </div>
            ))}
            <div ref={endRef} />
          </div>
          <form className="assistant-input" onSubmit={(e) => { e.preventDefault(); void ask(input); }}>
            {selection && (
              <div className="sel-chip">
                <span>Selection: “{selection.length > 60 ? `${selection.slice(0, 60)}…` : selection}”</span>
                <button type="button" className="ghost icon-btn" onClick={clearSelection} aria-label="Don't use selection"><Icon name="x" /></button>
              </div>
            )}
            <textarea
              value={input}
              rows={3}
              placeholder={selection ? 'What should I do with the selection?' : 'Ask, or tell it what to write…'}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(input); } }}
            />
            <div className="row">
              <span className="muted small spacer">Enter to send, Shift+Enter for a new line</span>
              {busy
                ? <button type="button" onClick={stop}>Stop</button>
                : <button type="submit" className="primary" disabled={!input.trim()}>Send</button>}
            </div>
          </form>
        </>
      )}
    </aside>
  );
}
