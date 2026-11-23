// Cmd+K (Ctrl+K) quick switcher and search. Titles of your pages match instantly as you type;
// full-text matches from the server (any words in any block, tags, tables, mind maps) follow
// a moment later with a snippet. Enter opens the page at the tab where the words are and
// scrolls to them.
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
// Same value as MAIN_TAB in @livepage/schema; not imported so search doesn't pull in the sync code.
const MAIN_TAB = 'main';
import { api } from './api';
import { navigate } from './router';
import { reloadWorkspace, titleOf, useWorkspace, type TreePage } from './workspace';

type Hit = { id: string; title: string; tags: string[]; tab: string | null; snippet: string; path?: string };

const Ctx = createContext<() => void>(() => {});
/** Opens the switcher (for a sidebar button). */
export const useOpenSwitcher = () => useContext(Ctx);

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const shortcutLabel = isMac ? '⌘K' : 'Ctrl K';

export function SwitcherProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    addEventListener('keydown', onKey, true); // capture: the editor should not see it
    return () => removeEventListener('keydown', onKey, true);
  }, []);
  return (
    <Ctx.Provider value={() => setOpen(true)}>
      {children}
      {open && <Switcher onClose={() => setOpen(false)} />}
    </Ctx.Provider>
  );
}

/** Each word must start a word of the title, in any order ("bo no" finds "Book notes"); else a plain substring. */
function titleScore(title: string, words: string[]): number {
  const t = title.toLowerCase();
  if (!words.length) return 1;
  if (!words.every((w) => t.includes(w))) return 0;
  const starts = words.filter((w) => t.startsWith(w) || t.includes(` ${w}`)).length;
  return 1 + starts + (t.startsWith(words[0]) ? 2 : 0);
}

function Switcher({ onClose }: { onClose: () => void }) {
  const ws = useWorkspace();
  const [q, setQ] = useState('');
  const [server, setServer] = useState<{ q: string; hits: Hit[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const words = useMemo(() => q.trim().toLowerCase().split(/\s+/).filter(Boolean), [q]);

  // Full-text search, debounced. Stale answers are ignored.
  useEffect(() => {
    if (!words.length) { setServer(null); setLoading(false); return; }
    setLoading(true);
    let live = true;
    const t = setTimeout(() => {
      api<{ results: Hit[] }>(`/search?q=${encodeURIComponent(q)}&limit=20`)
        .then((r) => { if (live) setServer({ q, hits: r.results }); })
        .catch(() => { if (live) setServer({ q, hits: [] }); })
        .finally(() => { if (live) setLoading(false); });
    }, 140);
    return () => { live = false; clearTimeout(t); };
  }, [q, words.length]);

  const results: Hit[] = useMemo(() => {
    const pages = ws?.pages ?? [];
    const byId = new Map<string, TreePage>(pages.map((p) => [p.id, p]));
    if (!words.length) {
      // Recent pages.
      return pages.slice().sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 8)
        .map((p) => ({ id: p.id, title: titleOf(p), tags: p.tags, tab: null, snippet: '', path: p.path }));
    }
    const local = pages
      .map((p) => ({ p, s: titleScore(titleOf(p) || 'Untitled', words) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || b.p.updated_at.localeCompare(a.p.updated_at))
      .slice(0, 8)
      .map(({ p }) => ({ id: p.id, title: titleOf(p), tags: p.tags, tab: null, snippet: '', path: p.path }) as Hit);
    const fromServer = server?.hits ?? [];
    const snippets = new Map(fromServer.map((h) => [h.id, h]));
    const seen = new Set(local.map((h) => h.id));
    const merged = local.map((h) => {
      const s = snippets.get(h.id);
      return s ? { ...h, tab: s.tab, snippet: s.snippet } : h;
    });
    for (const h of fromServer) if (!seen.has(h.id)) merged.push({ ...h, title: byId.has(h.id) ? titleOf(byId.get(h.id)!) : h.title, path: byId.get(h.id)?.path });
    return merged;
  }, [ws, words, server]);

  const createRow = words.length > 0; // last row: create a page with this title
  const count = results.length + (createRow ? 1 : 0);
  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => { listRef.current?.querySelector<HTMLElement>(`[data-i="${sel}"]`)?.scrollIntoView({ block: 'nearest' }); }, [sel]);

  const open = (h: Hit, newTab = false) => {
    const href = `/p/${h.id}${h.tab && h.tab !== MAIN_TAB ? `?tab=${encodeURIComponent(h.tab)}` : ''}`;
    if (newTab) { window.open(href, '_blank'); return; }
    onClose();
    navigate(href);
    if (h.snippet && words.length) void revealWords(words);
  };
  const choose = async (i: number, newTab = false) => {
    if (i < results.length) return open(results[i], newTab);
    if (createRow) {
      onClose();
      const { page } = await api<{ page: { id: string } }>('/pages', { body: { title: q.trim() } });
      await reloadWorkspace();
      navigate(`/p/${page.id}`);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); setSel((s) => (s + 1) % Math.max(1, count)); }
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { e.preventDefault(); setSel((s) => (s - 1 + count) % Math.max(1, count)); }
    else if (e.key === 'Enter') { e.preventDefault(); void choose(sel, e.metaKey || e.ctrlKey); }
  };

  return (
    <div className="modal-backdrop switcher-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="switcher" role="dialog" aria-label="Search pages" onKeyDown={onKey}>
        <div className="switcher-input-row">
          <span className="switcher-glyph" aria-hidden>⌕</span>
          <input
            autoFocus className="switcher-input" placeholder="Search pages or jump to one…" value={q}
            onChange={(e) => setQ(e.target.value)} aria-controls="switcher-list"
            aria-activedescendant={count ? `sw-${sel}` : undefined} role="combobox" aria-expanded="true"
          />
          {loading && <span className="muted small">…</span>}
          <kbd className="switcher-kbd">esc</kbd>
        </div>
        <ul className="switcher-list" id="switcher-list" role="listbox" ref={listRef}>
          {!words.length && results.length > 0 && <li className="switcher-head muted small">Recent</li>}
          {results.map((h, i) => (
            <li
              key={h.id} id={`sw-${i}`} data-i={i} role="option" aria-selected={i === sel}
              className={`switcher-item ${i === sel ? 'active' : ''}`}
              onMouseMove={() => setSel(i)} onClick={(e) => void choose(i, e.metaKey || e.ctrlKey)}
            >
              <div className="switcher-title">
                <span>{highlight(h.title || 'Untitled', words)}</span>
                {h.path && <span className="muted small switcher-path">{h.path}</span>}
                {h.tags.slice(0, 4).map((t) => <span key={t} className="switcher-tag">#{t}</span>)}
              </div>
              {h.snippet && <div className="switcher-snippet muted small">{highlight(h.snippet, words)}</div>}
            </li>
          ))}
          {words.length > 0 && !loading && !results.length && <li className="switcher-head muted small">No pages contain “{q.trim()}”.</li>}
          {createRow && (
            <li
              id={`sw-${results.length}`} data-i={results.length} role="option" aria-selected={sel === results.length}
              className={`switcher-item switcher-create ${sel === results.length ? 'active' : ''}`}
              onMouseMove={() => setSel(results.length)} onClick={() => void choose(results.length)}
            >
              ＋ New page “{q.trim()}”
            </li>
          )}
        </ul>
        <div className="switcher-foot muted small">↑↓ to move · Enter to open · {isMac ? '⌘' : 'Ctrl'}+Enter in a new tab</div>
      </div>
    </div>
  );
}

/** Bold every occurrence of the words. */
function highlight(text: string, words: string[]): React.ReactNode {
  if (!words.length) return text;
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
}

/**
 * After opening a page from a search result, wait for its text to arrive, scroll the first
 * match into view and mark it for a few seconds (CSS Custom Highlight API where supported).
 */
async function revealWords(words: string[]) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    const root = document.querySelector('.editor .ProseMirror');
    if (!root) continue;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = (n.textContent ?? '').toLowerCase();
      const w = words.find((x) => text.includes(x));
      if (!w) continue;
      const at = text.indexOf(w);
      const range = document.createRange();
      range.setStart(n, at);
      range.setEnd(n, at + w.length);
      (n.parentElement ?? (root as HTMLElement)).scrollIntoView({ block: 'center', behavior: 'smooth' });
      const css = (globalThis as any).CSS;
      if (css?.highlights && typeof (globalThis as any).Highlight === 'function') {
        css.highlights.set('lp-search', new (globalThis as any).Highlight(range));
        setTimeout(() => css.highlights.delete('lp-search'), 4000);
      }
      return;
    }
  }
}
