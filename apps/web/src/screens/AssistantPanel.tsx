import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { AiSettings, type AiSettingsValue } from './AiSettings';
import { Icon } from '../design/Icon';

type ToolStep = { id: string; name: string; status: 'running' | 'done' | 'error'; note?: string };
type Turn = {
  id: string; role: 'user' | 'assistant'; text: string; steps?: ToolStep[]; error?: string; selection?: string; model?: string; status?: string;
  running?: boolean; kind?: 'builtin' | 'agent'; requestId?: string;
};
type ChatState = { turns: Turn[]; rev: number; running: boolean };
type Agent = { id: string; name: string; online: boolean };
const BUILTIN = 'builtin';
// Who answers, saved on the server so it follows you to your other devices and decides who answers
// @AI in comments too. The local copy only makes the menu right before the server answers.
const loadTarget = () => { try { return localStorage.getItem('livepage.askTarget') || BUILTIN; } catch { return BUILTIN; } };
const saveTarget = (v: string) => { try { localStorage.setItem('livepage.askTarget', v); } catch { /* private mode */ } };

const LABELS: Record<string, string> = {
  read_page: 'Reading the page', write_paragraph: 'Writing', add_heading: 'Adding a heading', replace_text: 'Editing text',
  insert_table: 'Making a table', insert_mind_map: 'Making a mind map', add_mind_map_node: 'Growing the mind map',
  insert_custom_ui: 'Building a custom block', update_html_block: 'Updating a block', add_tab: 'Adding a tab',
  read_blocks: 'Reading a section', replace_blocks: 'Rewriting', insert_blocks: 'Writing', delete_blocks: 'Removing', move_blocks: 'Moving',
  edit_table: 'Editing a table',
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

/**
 * This page's Ask AI chat, as the server has it, kept current with a long poll: answers stream
 * in whichever device asked. Polls only while the app is on screen (a phone in a pocket, or a
 * background tab, doesn't keep the server and database awake) and catches up when it comes back.
 */
function useChat(pageId: string): ChatState & { refresh: () => Promise<void> } {
  const [state, setState] = useState<ChatState>({ turns: [], rev: -1, running: false });
  const revRef = useRef(-1);
  useEffect(() => {
    let alive = true;
    let ac: AbortController | null = null;
    const take = (c: ChatState) => { if (alive && c.rev !== revRef.current) { revRef.current = c.rev; setState(c); } };
    const loop = async (mine: number) => {
      while (alive && mine === gen && document.visibilityState === 'visible') {
        const ctl = (ac = new AbortController());
        const since = revRef.current;
        try {
          const res = await fetch(`/api/pages/${pageId}/chat?wait=25${since >= 0 ? `&since=${since}` : ''}`, { credentials: 'same-origin', signal: ctl.signal, cache: 'no-store' });
          if (!res.ok) throw new Error(String(res.status));
          take(await res.json());
        } catch {
          if (!alive || ctl.signal.aborted) return;
          await new Promise((r) => setTimeout(r, 3000)); // offline or the server is waking: try again shortly
        }
      }
    };
    let gen = 0; // one loop at a time: coming back on screen starts a fresh one
    const start = () => {
      const mine = ++gen;
      ac?.abort();
      void (async () => { await Promise.resolve(); if (mine === gen) await loop(mine); })();
    };
    const onVis = () => { if (document.visibilityState === 'visible') start(); else ac?.abort(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('online', start);
    start();
    return () => { alive = false; gen++; ac?.abort(); document.removeEventListener('visibilitychange', onVis); window.removeEventListener('online', start); };
  }, [pageId]);
  const refresh = useCallback(async () => {
    const c = await api<ChatState>(`/pages/${pageId}/chat`);
    if (c.rev !== revRef.current) { revRef.current = c.rev; setState(c); }
  }, [pageId]);
  return { ...state, refresh };
}

export function AssistantPanel({ pageId, tab, onClose }: { pageId: string; tab: string; onClose: () => void }) {
  const [ready, setReady] = useState<boolean | null>(null);
  const [setup, setSetup] = useState(false);
  const chat = useChat(pageId);
  const { turns } = chat;
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const busy = sending || chat.running;
  const [selection, clearSelection] = useEditorSelection();
  const endRef = useRef<HTMLDivElement>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [target, setTargetState] = useState(loadTarget);
  const setTarget = (v: string) => {
    setTargetState(v); saveTarget(v); setSetup(false);
    void api('/agents/target', { method: 'PUT', body: { target: v } }).catch((e) => setSendError((e as Error).message));
  };
  const agent = agents.find((a) => a.id === target);
  const builtin = target === BUILTIN || !agent;

  useEffect(() => {
    api<{ settings: AiSettingsValue | null }>('/ai/settings').then((r) => setReady(!!r.settings)).catch(() => setReady(false));
  }, []);
  // Your connected agents and whether they're online; refreshed while the panel is open.
  useEffect(() => {
    const load = () => api<{ agents: Agent[]; target?: string; saved?: boolean }>('/agents').then((r) => {
      setAgents(r.agents);
      const local = loadTarget();
      if (!r.saved && local !== BUILTIN && r.agents.some((a) => a.id === local)) {
        // Picked in this browser before picks were saved to the account: keep it, and save it.
        void api('/agents/target', { method: 'PUT', body: { target: local } }).catch(() => {});
      } else if (r.target) { setTargetState(r.target); saveTarget(r.target); } // the account's pick, maybe made on another device
    }).catch(() => {});
    void load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);
  const last = turns[turns.length - 1];
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [turns.length, last?.text, last?.steps?.length, last?.status]);

  // The chat lives on the server: the question goes there, and the answer streams back through
  // useChat on this device and on every other one with this page's panel open. Closing the panel
  // (or the phone going to sleep) doesn't stop it; Stop does.
  const ask = async (prompt: string) => {
    if (!prompt.trim() || busy) return;
    const sel = selection;
    setSending(true);
    setSendError('');
    try {
      if (agent) await api(`/pages/${pageId}/agent-requests`, { body: { tokenId: agent.id, prompt, tab, selection: sel } });
      else await api(`/pages/${pageId}/assistant`, { body: { prompt, tab, selection: sel } });
      setInput('');
      clearSelection();
      await chat.refresh();
    } catch (e) {
      if ((e as { status?: number }).status === 412) setReady(false);
      setSendError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const stop = () => {
    const t = [...turns].reverse().find((x) => x.running);
    if (t?.requestId) void api(`/agent-requests/${t.requestId}`, { method: 'DELETE' }).catch(() => {});
    else void api(`/pages/${pageId}/chat/stop`, { body: {} }).catch(() => {});
  };
  const clear = () => { void api(`/pages/${pageId}/chat`, { method: 'DELETE' }).then(() => chat.refresh()).catch((e) => setSendError(e.message)); };

  return (
    <aside className="assistant" aria-label="AI assistant">
      <div className="assistant-head">
        <h2 className="panel-title"><Icon name="sparkles" />Ask AI</h2>
        <span className="spacer" />
        {ready && builtin && <button type="button" className="ghost" onClick={() => setSetup((v) => !v)}>{setup ? 'Back to chat' : 'Settings'}</button>}
        {turns.length > 0 && !busy && <button type="button" className="ghost" onClick={clear}>Clear</button>}
        <button type="button" className="ghost icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
      </div>

      {agents.length > 0 && (
        <label className="assistant-target" title="@AI in your comments goes to the same AI">
          <span className="muted small assistant-target-label">Ask and @AI</span>
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
                {t.role === 'assistant' && !t.text && !t.error && t.running && !(t.steps?.length) && !t.status && <div className="muted small">Thinking…</div>}
                {t.error && <div className="form-error small">{t.error}</div>}
              </div>
            ))}
            {sendError && <p className="form-error small pad">{sendError}</p>}
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
