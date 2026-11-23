import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { AiSettings, type AiSettingsValue } from './AiSettings';

type ToolStep = { id: string; name: string; status: 'running' | 'done' | 'error'; note?: string };
type Turn = { role: 'user' | 'assistant'; text: string; steps?: ToolStep[]; error?: string; selection?: string; model?: string };

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

  useEffect(() => {
    api<{ settings: AiSettingsValue | null }>('/ai/settings').then((r) => setReady(!!r.settings)).catch(() => setReady(false));
  }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [turns]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const patchLast = (fn: (t: Turn) => Turn) => setTurns((ts) => [...ts.slice(0, -1), fn(ts[ts.length - 1])]);

  const ask = async (prompt: string) => {
    if (!prompt.trim() || busy) return;
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
        <b>✦ Ask AI</b>
        <span className="spacer" />
        {ready && <button type="button" className="ghost" onClick={() => setSetup((v) => !v)}>{setup ? 'Back to chat' : 'Settings'}</button>}
        {turns.length > 0 && !busy && <button type="button" className="ghost" onClick={() => setTurns([])}>Clear</button>}
        <button type="button" className="ghost" aria-label="Close" onClick={onClose}>✕</button>
      </div>

      {ready === null ? <p className="muted small pad">Loading…</p> : !ready || setup ? (
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
                        {s.status === 'running' ? '◌' : s.status === 'done' ? '✓' : '!'} {LABELS[s.name] ?? s.name}{s.status === 'error' && s.note ? `: ${s.note}` : ''}
                      </li>
                    ))}
                  </ul>
                )}
                {t.text && <div className="turn-text">{t.text}</div>}
                {t.role === 'assistant' && !t.text && !t.error && busy && i === turns.length - 1 && !(t.steps?.length) && <div className="muted small">Thinking…</div>}
                {t.error && <div className="form-error small">{t.error}</div>}
              </div>
            ))}
            <div ref={endRef} />
          </div>
          <form className="assistant-input" onSubmit={(e) => { e.preventDefault(); void ask(input); }}>
            {selection && (
              <div className="sel-chip">
                <span>Selection: “{selection.length > 60 ? `${selection.slice(0, 60)}…` : selection}”</span>
                <button type="button" className="ghost" onClick={clearSelection} aria-label="Don't use selection">✕</button>
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
                ? <button type="button" onClick={() => abortRef.current?.abort()}>Stop</button>
                : <button type="submit" className="primary" disabled={!input.trim()}>Send</button>}
            </div>
          </form>
        </>
      )}
    </aside>
  );
}
