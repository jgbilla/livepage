// The open tabs strip across the top of the main area, and the screens inside it (see tabs.ts).
//
// Keeping live pages light: a tab connects to its page only once you first look at it (tabs
// restored on reload stay asleep until then). A tab you leave keeps its connection for a while,
// so switching back is instant, then disconnects after BACKGROUND_MS in the background.
//
// Wide screens: a strip of tabs per group, drag to reorder or into the other half, right-click
// for Pin, Open side by side, Close others. Phone width: one tab at a time and a switcher sheet.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { Me } from './api';
import { PaneContext, navigate, type Pane } from './router';
import { useNarrow } from './Sidebar';
import { HScrollEdges, useHScroll } from './HScroll';
import { Icon, type IconName } from './design/Icon';
import { titleOf, useWorkspace, type Workspace } from './workspace';
import {
  activateTab, closeOtherTabs, closeTab, closeTabsToRight, cycleTab, focusGroup, initTabs, moveTab, nthTab, openInTab,
  setSplit, setTabPath, splitTab, tabsSnapshot, togglePin, useTabs, type WTab,
} from './tabs';

const BACKGROUND_MS = 5 * 60_000; // a background tab disconnects after this long
const MAX_ALIVE = 8; // and at most this many stay connected at once
const TAB_DRAG = 'application/x-livepage-tab';
const PAGE_DRAG = 'application/x-livepage'; // a page dragged from the sidebar

export type ScreenFor = (path: string, search: string) => React.ReactNode;

/** What a tab shows in the strip: the page title, or the screen's name. */
export function tabLabel(path: string, ws: Workspace | null): { title: string; glyph: IconName } {
  const p = path.split(/[?#]/)[0];
  const page = p.match(/^\/p\/([\w-]+)/)?.[1];
  if (page) {
    const known = ws?.pages.find((x) => x.id === page);
    return { title: known ? titleOf(known) || 'Untitled' : ws ? 'Page' : '…', glyph: 'file' };
  }
  const tag = p.match(/^\/tag\/(.+)$/)?.[1];
  if (tag) return { title: decodeURIComponent(tag), glyph: 'hash' };
  const view = p.match(/^\/view\/([\w-]+)/)?.[1];
  if (view) return { title: ws?.views.find((v) => v.id === view)?.name ?? 'View', glyph: 'view' };
  if (p === '/graph') return { title: 'Graph', glyph: 'graph' };
  if (p === '/tasks') return { title: 'Tasks', glyph: 'tasks' };
  return { title: 'Home', glyph: 'home' };
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const ALT = isMac ? '⌥' : 'Alt+';

export function WorkspaceTabs({ me, screenFor }: { me: Me; screenFor: ScreenFor }) {
  useState(() => initTabs(me.id));
  const st = useTabs();
  const narrow = useNarrow();
  const ws = useWorkspace();
  const split = !narrow && st.groups.length > 1;
  // On wider screens the app shell is fixed: the window never scrolls, each side's body scrolls itself.
  // Phones keep the window scrolling so the browser's address bar can collapse.
  const inner = !narrow;
  const shown = split ? st.groups.map((_, i) => i) : [st.focus];
  const visible = shown.map((gi) => st.groups[gi].active);
  const allTabs = useMemo(() => st.groups.flatMap((g) => g.tabs), [st]);

  // ---- which tabs stay connected: visible ones, plus recently left ones ----
  const lastSeen = useRef(new Map<string, number>()); // tab id -> when it was last visible (Infinity while visible)
  const [, evict] = useReducer((x: number) => x + 1, 0);
  for (const id of visible) lastSeen.current.set(id, Infinity);
  useEffect(() => {
    const ids = new Set(allTabs.map((t) => t.id));
    for (const [id, t] of lastSeen.current) {
      if (!ids.has(id)) lastSeen.current.delete(id);
      else if (t === Infinity && !visible.includes(id)) lastSeen.current.set(id, Date.now());
    }
  });
  useEffect(() => {
    const sweep = () => {
      const now = Date.now();
      const bg = [...lastSeen.current].filter(([, t]) => t !== Infinity).sort((a, b) => b[1] - a[1]);
      let changed = false;
      bg.forEach(([id, t], i) => {
        if (now - t > BACKGROUND_MS || i >= MAX_ALIVE - visible.length) { lastSeen.current.delete(id); changed = true; }
      });
      if (changed) evict();
    };
    sweep();
    const timer = setInterval(sweep, 30_000);
    return () => clearInterval(timer);
  }, [visible.join(' ')]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- each tab keeps its own scroll position ----
  const scrolls = useRef(new Map<string, number>());
  const bodies = useRef<(HTMLDivElement | null)[]>([]);
  const scroller = (gi: number): { get: () => number; set: (y: number) => void } => {
    const el = bodies.current[gi];
    return inner && el ? { get: () => el.scrollTop, set: (y) => { el.scrollTop = y; } } : { get: () => scrollY, set: (y) => scrollTo(0, y) };
  };
  const shownRef = useRef<string[]>([]);
  useLayoutEffect(() => {
    shown.forEach((gi, i) => {
      const id = visible[i];
      if (shownRef.current[i] !== id) scroller(gi).set(scrolls.current.get(id) ?? 0);
    });
    shownRef.current = visible;
  });
  const current = useRef('');
  current.current = inner ? '' : visible[0];
  useEffect(() => {
    const on = () => { if (current.current) scrolls.current.set(current.current, scrollY); };
    addEventListener('scroll', on, { passive: true });
    return () => removeEventListener('scroll', on);
  }, []);

  // ---- the window title follows the focused tab ----
  const focused = st.groups[st.focus].tabs.find((t) => t.id === st.groups[st.focus].active)!;
  const focusedTitle = tabLabel(focused.path, ws).title;
  useEffect(() => { document.title = focused.path === '/' ? 'Livepage' : `${focusedTitle} · Livepage`; }, [focusedTitle, focused.path]);

  useShortcuts();

  // ---- drag a tab: reorder, move to the other half, or drop on the right to split ----
  const [dragging, setDragging] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [switcher, setSwitcher] = useState(false);
  useEffect(() => {
    const open = () => setSwitcher(true);
    addEventListener('livepage:tab-switcher', open);
    return () => removeEventListener('livepage:tab-switcher', open);
  }, []);
  useEffect(() => { if (!narrow) setSwitcher(false); }, [narrow]);

  const dropAt = (gi: number, index: number) => (e: React.DragEvent) => {
    const id = e.dataTransfer.getData(TAB_DRAG);
    e.preventDefault();
    setDragging(null);
    if (id) { moveTab(id, gi, index); return; }
    try {
      const d = JSON.parse(e.dataTransfer.getData(PAGE_DRAG));
      if (d?.kind === 'page') openInTab(`/p/${d.id}`, { group: gi, index });
    } catch { /* not ours */ }
  };

  const panesRef = useRef<HTMLDivElement>(null);
  const startResize = (e: React.PointerEvent) => {
    const box = panesRef.current?.getBoundingClientRect();
    if (!box) return;
    e.preventDefault();
    const move = (ev: PointerEvent) => setSplit((ev.clientX - box.left) / box.width);
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); document.body.classList.remove('wt-resizing'); };
    document.body.classList.add('wt-resizing');
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };

  return (
    <div ref={panesRef} className={`wt ${split ? 'wt-split' : 'wt-single'} ${inner ? 'wt-inner' : 'wt-narrow'} ${narrow && allTabs.length > 1 ? 'wt-has-bar' : ''}`}
      style={split ? ({ '--wt-ratio': st.split } as React.CSSProperties) : undefined}>
      {narrow && allTabs.length > 1 && (
        <button type="button" className="wt-mobilebar" onClick={() => setSwitcher(true)} aria-label={`${allTabs.length} open tabs. Show tabs`}>
          <span className="wt-count" aria-hidden="true">{allTabs.length}</span>
          <span className="wt-mobile-title">{focusedTitle}</span>
          <Icon name="chevron-down" />
        </button>
      )}
      {st.groups.map((g, gi) => {
        const isShown = shown.includes(gi);
        return (
          <div key={g.id} className={`wt-pane ${gi === st.focus ? 'wt-focused' : ''}`} hidden={!isShown}
            onPointerDownCapture={() => focusGroup(gi)} onFocusCapture={() => focusGroup(gi)}>
            {!narrow && (
              <Strip active={`${g.active} ${g.tabs.length}`} label={split ? `Open tabs, ${gi === 0 ? 'left' : 'right'} side` : 'Open tabs'}
                onDragOver={(e) => { if (e.dataTransfer.types.includes(TAB_DRAG) || e.dataTransfer.types.includes(PAGE_DRAG)) e.preventDefault(); }}
                onDrop={dropAt(gi, g.tabs.length)}>
                {g.tabs.map((t, ti) => (
                  <TabChip key={t.id} tab={t} ws={ws} active={t.id === g.active} focused={gi === st.focus && t.id === g.active}
                    onDropAt={(after) => dropAt(gi, ti + (after ? 1 : 0))} onDrag={setDragging}
                    onMenu={(x, y) => setMenu({ id: t.id, x, y })} />
                ))}
                <button type="button" className="wt-new" title={`New tab (${ALT}T)`} aria-label="New tab"
                  onClick={() => openInTab('/', { group: gi, index: g.tabs.length })}><Icon name="plus" /></button>
              </Strip>
            )}
            <div className="wt-body" ref={(el) => { bodies.current[gi] = el; }}
              onScroll={inner ? (e) => scrolls.current.set(g.active, e.currentTarget.scrollTop) : undefined}>
              {g.tabs.filter((t) => lastSeen.current.has(t.id) || t.id === g.active && isShown).map((t) => (
                <TabView key={t.id} tab={t} visible={isShown && t.id === g.active} focused={gi === st.focus} screenFor={screenFor} />
              ))}
            </div>
            {dragging && !split && !narrow && (
              <div className="wt-splitzone" onDragOver={(e) => e.preventDefault()} onDrop={(e) => {
                const id = e.dataTransfer.getData(TAB_DRAG); setDragging(null);
                if (id) splitTab(id);
              }}>Drop to open side by side</div>
            )}
          </div>
        );
      })}
      {split && <div className="wt-divider" role="separator" aria-orientation="vertical" aria-label="Resize the two sides" onPointerDown={startResize}
        onDoubleClick={() => setSplit(0.5)} />}
      {menu && <TabMenu {...menu} groups={st.groups.length} onClose={() => setMenu(null)} />}
      {switcher && <TabSwitcher ws={ws} onClose={() => setSwitcher(false)} />}
    </div>
  );
}

/** A group's strip of tabs: scrolls sideways with edge fades and keeps the active tab in view. */
function Strip({ active, label, children, ...rest }: { active: string; label: string; children: React.ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  const { ref, edges, nudge } = useHScroll<HTMLDivElement>(active);
  return (
    <div className="hscroll wt-strip-wrap">
      <div ref={ref} className="wt-strip" role="tablist" aria-label={label} {...rest}>{children}</div>
      <HScrollEdges edges={edges} nudge={nudge} />
    </div>
  );
}

/** One open tab's screen, with its own location. Kept mounted (hidden) while it stays connected. */
const TabView = memo(function TabView({ tab, visible, focused, screenFor }: { tab: WTab; visible: boolean; focused: boolean; screenFor: ScreenFor }) {
  const [path, query] = tab.path.split('?');
  const search = query ? `?${query}` : '';
  const active = visible && focused;
  const pane = useMemo<Pane>(() => ({
    path, search, focused: active,
    navigate: (to, replace) => (active ? navigate(to, replace) : setTabPath(tab.id, to)),
  }), [path, search, active, tab.id]);
  // The screen itself only re-renders when this tab's path changes, not on every tab switch.
  const screen = useMemo(() => screenFor(path, search), [screenFor, path, search]);
  return (
    <div className={`wt-view ${visible ? 'wt-visible' : ''}`} hidden={!visible} data-tab={tab.id}>
      <PaneContext.Provider value={pane}>{screen}</PaneContext.Provider>
    </div>
  );
});

function TabChip({ tab, ws, active, focused, onDropAt, onDrag, onMenu }: {
  tab: WTab; ws: Workspace | null; active: boolean; focused: boolean;
  onDropAt: (after: boolean) => (e: React.DragEvent) => void; onDrag: (id: string | null) => void; onMenu: (x: number, y: number) => void;
}) {
  const { title, glyph } = tabLabel(tab.path, ws);
  const [over, setOver] = useState<'before' | 'after' | null>(null);
  const side = (e: React.DragEvent) => { const r = e.currentTarget.getBoundingClientRect(); return e.clientX > r.left + r.width / 2 ? 'after' : 'before'; };
  return (
    <div role="tab" tabIndex={active ? 0 : -1} aria-selected={active}
      className={`wt-tab ${active ? 'wt-tab-active' : ''} ${focused ? 'wt-tab-focused' : ''} ${tab.pinned ? 'wt-tab-pinned' : ''} ${over ? `wt-drop-${over}` : ''}`}
      title={tab.pinned ? `${title} (pinned)` : title}
      draggable
      onDragStart={(e) => { e.dataTransfer.setData(TAB_DRAG, tab.id); e.dataTransfer.effectAllowed = 'move'; onDrag(tab.id); }}
      onDragEnd={() => onDrag(null)}
      onDragOver={(e) => { if (e.dataTransfer.types.includes(TAB_DRAG) || e.dataTransfer.types.includes(PAGE_DRAG)) { e.preventDefault(); e.stopPropagation(); setOver(side(e)); } }}
      onDragLeave={() => setOver(null)}
      onDrop={(e) => { e.stopPropagation(); const after = side(e) === 'after'; setOver(null); onDropAt(after)(e); }}
      onClick={() => activateTab(tab.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateTab(tab.id); }
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          const next = (e.key === 'ArrowRight' ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling) as HTMLElement | null;
          if (next?.classList.contains('wt-tab')) next.focus();
        }
        if (e.key === 'Delete' && !tab.pinned) closeTab(tab.id);
      }}
      onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
      onAuxClick={(e) => { if (e.button === 1 && !tab.pinned) { e.preventDefault(); closeTab(tab.id); } }}
      onContextMenu={(e) => { e.preventDefault(); onMenu(e.clientX, e.clientY); }}>
      <span className="wt-glyph"><Icon name={tab.pinned ? 'pin' : glyph} size={14} /></span>
      <span className="wt-title">{title}</span>
      {!tab.pinned && (
        <button type="button" className="wt-close" tabIndex={-1} aria-label={`Close ${title}`} title={`Close tab (${ALT}W)`}
          onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}><Icon name="x" size={14} /></button>
      )}
    </div>
  );
}

function TabMenu({ id, x, y, groups, onClose }: { id: string; x: number; y: number; groups: number; onClose: () => void }) {
  const st = useTabs();
  const tab = st.groups.flatMap((g) => g.tabs).find((t) => t.id === id);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: Event) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    addEventListener('pointerdown', away, true);
    addEventListener('keydown', esc);
    addEventListener('blur', onClose);
    ref.current?.querySelector('button')?.focus();
    return () => { removeEventListener('pointerdown', away, true); removeEventListener('keydown', esc); removeEventListener('blur', onClose); };
  }, [onClose]);
  if (!tab) return null;
  const item = (icon: IconName, label: string, run: () => void, hint?: string) => (
    <button type="button" role="menuitem" onClick={() => { onClose(); run(); }}><Icon name={icon} />{label}{hint && <kbd>{hint}</kbd>}</button>
  );
  return (
    <div ref={ref} className="wt-menu" role="menu" style={{ left: Math.min(x, innerWidth - 230), top: Math.min(y, innerHeight - 220) }}>
      {item('pin', tab.pinned ? 'Unpin tab' : 'Pin tab', () => togglePin(id))}
      {item('columns', groups > 1 ? 'Move to the other side' : 'Open side by side', () => splitTab(id))}
      {item('external', 'Open in a new browser tab', () => window.open(tab.path, '_blank'))}
      <hr />
      {!tab.pinned && item('x', 'Close tab', () => closeTab(id), `${ALT}W`)}
      {item('tabs', 'Close other tabs', () => closeOtherTabs(id))}
      {item('chevron-right', 'Close tabs to the right', () => closeTabsToRight(id))}
    </div>
  );
}

/** Phone width: every open tab in a sheet, like a mobile browser's tab switcher. */
function TabSwitcher({ ws, onClose }: { ws: Workspace | null; onClose: () => void }) {
  const st = useTabs();
  const tabs = st.groups.flatMap((g, gi) => g.tabs.map((t) => ({ t, current: gi === st.focus && g.active === t.id })));
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', esc);
    return () => removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="wt-sheet-backdrop" onClick={onClose}>
      <div className="wt-sheet" role="dialog" aria-label="Open tabs" onClick={(e) => e.stopPropagation()}>
        <div className="wt-sheet-head">
          <strong>Open tabs</strong>
          <span className="muted small">{tabs.length}</span>
          <button type="button" className="ghost" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <ul className="wt-sheet-list">
          {tabs.map(({ t, current }) => {
            const { title, glyph } = tabLabel(t.path, ws);
            return (
              <li key={t.id} className={current ? 'current' : ''}>
                <button type="button" className="wt-sheet-open" onClick={() => { onClose(); activateTab(t.id); }} aria-current={current || undefined}>
                  <span className="wt-glyph"><Icon name={t.pinned ? 'pin' : glyph} /></span>
                  <span className="wt-title">{title}</span>
                </button>
                {!t.pinned && <button type="button" className="wt-close" aria-label={`Close ${title}`} onClick={() => closeTab(t.id)}><Icon name="x" /></button>}
              </li>
            );
          })}
        </ul>
        <button type="button" className="primary wt-sheet-new" onClick={() => { onClose(); openInTab('/'); }}><Icon name="plus" />New tab</button>
      </div>
    </div>
  );
}

/**
 * Ctrl+Tab / Ctrl+Shift+Tab switch tabs where the browser lets the page see them (installed app,
 * Safari). Everywhere: Alt+Shift+] and [ for next and previous, Alt+1…9 to jump (9 is the last),
 * Alt+T for a new tab, Alt+W to close. Cmd/Ctrl+T and W belong to the browser, so they stay its own.
 */
function useShortcuts() {
  const handler = useCallback((e: KeyboardEvent) => {
    if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Tab') { e.preventDefault(); cycleTab(e.shiftKey ? -1 : 1); return; }
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    let done = true;
    if (e.shiftKey && e.code === 'BracketRight') cycleTab(1);
    else if (e.shiftKey && e.code === 'BracketLeft') cycleTab(-1);
    else if (!e.shiftKey && e.code === 'KeyT') openInTab('/');
    else if (!e.shiftKey && e.code === 'KeyW') { const st = tabsSnapshot(); const g = st.groups[st.focus]; const t = g.tabs.find((x) => x.id === g.active); if (t && !t.pinned) closeTab(t.id); }
    else if (!e.shiftKey && /^Digit[1-9]$/.test(e.code)) { const n = Number(e.code.slice(5)); nthTab(n === 9 ? -1 : n - 1); }
    else done = false;
    if (done) { e.preventDefault(); e.stopPropagation(); }
  }, []);
  useEffect(() => {
    addEventListener('keydown', handler, true);
    return () => removeEventListener('keydown', handler, true);
  }, [handler]);
}
