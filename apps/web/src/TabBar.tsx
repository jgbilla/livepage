import { useEffect, useState } from 'react';
import type * as Y from 'yjs';
import { MAIN_TAB, addTab, listTabs, removeTab, renameTab, tabsMap, type Tab } from '@livepage/schema';
import { Icon } from './design/Icon';

type Peer = { name: string; color: string; tab?: string };

// Page tabs: a page's own sections, under its title (not the workspace tabs of open pages, see tabs.ts).
// Optional tabs at the top of a page. With one tab, only a small "+ Add tab" shows,
// so the page looks like a normal page. Each tab is its own live block document.
export function TabBar({ doc, active, onSelect, peers, readOnly = false, synced = true }: { doc: Y.Doc; active: string; onSelect: (id: string) => void; peers: Peer[]; readOnly?: boolean; synced?: boolean }) {
  const [tabs, setTabs] = useState<Tab[]>(() => listTabs(doc));
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => {
    const map = tabsMap(doc);
    const update = () => setTabs(listTabs(doc));
    map.observe(update);
    update();
    return () => map.unobserve(update);
  }, [doc]);

  // If the active tab was deleted by someone else, fall back to the main tab. Wait for the first
  // sync: before it, a link to a tab (?tab=) would look like a missing tab.
  useEffect(() => {
    if (synced && !tabs.some((t) => t.id === active)) onSelect(MAIN_TAB);
  }, [tabs, active, onSelect, synced]);

  const multi = tabs.length > 1;
  return (
    <nav className={`tabbar ${multi ? 'tabbar-multi' : ''}`} aria-label="Page tabs">
      {multi &&
        tabs.map((t) => (
          <div key={t.id} className={`tab ${t.id === active ? 'tab-active' : ''}`}>
            {editing === t.id ? (
              <input
                autoFocus
                defaultValue={t.title}
                aria-label="Tab name"
                onBlur={(e) => { renameTab(doc, t.id, e.target.value.trim()); setEditing(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur(); }}
              />
            ) : (
              <button type="button" className="tab-title" onClick={() => onSelect(t.id)} onDoubleClick={() => !readOnly && setEditing(t.id)} title="Double-click to rename">
                {t.title}
                {peers.filter((p) => p.tab === t.id).map((p, i) => (
                  <span key={i} className="tab-dot" style={{ background: p.color }} title={p.name} />
                ))}
              </button>
            )}
            {!readOnly && t.id !== MAIN_TAB && t.id === active && editing !== t.id && (
              <button
                type="button"
                className="tab-close"
                title="Delete tab"
                onClick={() => { if (confirm(`Delete the tab "${t.title}" and everything in it?`)) removeTab(doc, t.id); }}
                aria-label="Delete tab"
              >
                <Icon name="x" />
              </button>
            )}
          </div>
        ))}
      {!readOnly && <button type="button" className="tab-add" onClick={() => { const id = addTab(doc, `Tab ${tabs.length + 1}`); onSelect(id); setEditing(id); }} title="Add a section to this page, as its own tab">
        + Add page tab
      </button>}
    </nav>
  );
}
