// Obsidian-style sidebar: a Today button, your folder tree (drag pages and folders to move
// them), saved tag views and all tags. Folders are yours alone; pages shared with you show
// up at the top level until you file them somewhere.
import { Suspense, createContext, lazy, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, type Me } from './api';
import { Link, navigate, useLocation } from './router';
import {
  deleteFolder, deleteView, moveFolder, movePage, newFolder, newPage, newPageFromTemplate, openToday, reloadWorkspace, renameFolder, renamePage,
  titleOf, useWorkspace, type Folder, type TreePage, type View,
} from './workspace';
import { ViewDialog } from './screens/ViewDialog';
import { shortcutLabel, SwitcherProvider, useOpenSwitcher } from './QuickSwitcher';
const ImportDialog = lazy(() => import('./screens/ImportDialog').then((m) => ({ default: m.ImportDialog })));
import { Icon } from './design/Icon';
import { ThemeSwitch } from './design/theme';
import { initials } from './Presence';
import { colorFor } from './api';

// ---------- layout + open/closed state ----------

const SidebarCtx = createContext<{ open: boolean; toggle: () => void }>({ open: true, toggle: () => {} });
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const NARROW = '(max-width: 800px)';
const narrowNow = () => typeof matchMedia !== 'undefined' && matchMedia(NARROW).matches;

/** True at phone width; follows the window as it is resized or rotated. */
export function useNarrow() {
  const [narrow, setNarrow] = useState(narrowNow);
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const mq = matchMedia(NARROW);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

// Wide screens: the sidebar sits beside the page, open or closed as you last left it.
// Phone width: it is a drawer over the page that always starts closed (so the top bar,
// Share and History stay tappable), opens from ☰, and closes on picking a page or tapping outside.
export function Layout({ me, onLogout, children }: { me: Me; onLogout: () => void; children: React.ReactNode }) {
  const narrow = useNarrow();
  const [docked, setDocked] = useState(() => store.get('lp.sidebar') !== 'closed');
  const [drawer, setDrawer] = useState(false);
  const open = narrow ? drawer : docked;
  const toggle = () => {
    if (narrow) setDrawer((o) => !o);
    else setDocked((o) => { store.set('lp.sidebar', o ? 'closed' : 'open'); return !o; });
  };
  const { path, search } = useLocation();
  useEffect(() => setDrawer(false), [path, search, narrow]);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawer(false); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [drawer]);
  return (
    <SidebarCtx.Provider value={{ open, toggle }}>
      <SwitcherProvider>
      <div className={`layout ${open ? 'sidebar-open' : 'sidebar-closed'} ${narrow ? 'layout-narrow' : ''}`}>
        {open && <Sidebar me={me} onLogout={onLogout} />}
        {open && narrow && <div className="sidebar-scrim" onClick={toggle} />}
        <div className="layout-main">{children}</div>
      </div>
      </SwitcherProvider>
    </SidebarCtx.Provider>
  );
}

/** The sidebar button screens put at the start of their top bar. */
export function SidebarToggle() {
  const { open, toggle } = useContext(SidebarCtx);
  return (
    <button type="button" className="ghost sidebar-toggle" onClick={toggle} aria-label={open ? 'Hide sidebar' : 'Show sidebar'} title={open ? 'Hide sidebar' : 'Show sidebar'}>
      <Icon name="menu" />
    </button>
  );
}


// ---------- sidebar pieces ----------

const WIDTH = { min: 208, max: 440, initial: 260 };

/** Drag the sidebar's right edge to resize it; remembered in this browser. */
function useSidebarWidth() {
  const [value, setValue] = useState(() => {
    const n = Number(store.get('lp.sidebar.width'));
    return n >= WIDTH.min && n <= WIDTH.max ? n : WIDTH.initial;
  });
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX, start = value;
    let last = start;
    document.documentElement.classList.add('sb-resizing');
    const move = (ev: PointerEvent) => { last = Math.max(WIDTH.min, Math.min(WIDTH.max, start + ev.clientX - startX)); setValue(last); };
    const up = () => {
      document.documentElement.classList.remove('sb-resizing');
      removeEventListener('pointermove', move); removeEventListener('pointerup', up);
      store.set('lp.sidebar.width', String(Math.round(last)));
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  };
  const reset = () => { setValue(WIDTH.initial); store.set('lp.sidebar.width', String(WIDTH.initial)); };
  return { value, startDrag, reset };
}

const collapsedSections = () => new Set<string>(JSON.parse(store.get('lp.sb.collapsed') ?? '[]'));

/** A sidebar section: a small caps label that folds the section, actions that show on hover. */
function Section({ id, label, actions, className, dropProps, children }: {
  id: string; label: string; actions?: React.ReactNode; className?: string;
  dropProps?: React.HTMLAttributes<HTMLDivElement>; children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(() => collapsedSections().has(id));
  const toggle = () => {
    const all = collapsedSections();
    if (collapsed) all.delete(id); else all.add(id);
    store.set('lp.sb.collapsed', JSON.stringify([...all]));
    setCollapsed(!collapsed);
  };
  return (
    <div className={`sb-section ${className ?? ''} ${collapsed ? 'collapsed' : ''}`} {...dropProps}>
      <div className="sb-label">
        <button type="button" className="sb-label-btn" onClick={toggle} aria-expanded={!collapsed}>
          {label}<Icon name="chevron-down" className="sb-label-chev" />
        </button>
        {actions && <span className="sb-label-actions">{actions}</span>}
      </div>
      {!collapsed && <div className="sb-section-body">{children}</div>}
    </div>
  );
}

function SkeletonRows() {
  return <div className="sb-skeleton" aria-label="Loading">{[72, 54, 64].map((w, i) => <span key={i} style={{ width: `${w}%` }} />)}</div>;
}

// ---------- tree helpers ----------

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
type Drag = { kind: 'page' | 'folder'; id: string };
const DRAG_TYPE = 'application/x-livepage';

function useExpanded() {
  const [set, setSet] = useState<Set<string>>(() => new Set(JSON.parse(store.get('lp.expanded') ?? '[]')));
  const save = (s: Set<string>) => { store.set('lp.expanded', JSON.stringify([...s])); return s; };
  return {
    has: (id: string) => set.has(id),
    toggle: (id: string) => setSet((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return save(n); }),
    open: (ids: string[]) => setSet((s) => (ids.every((i) => s.has(i)) ? s : save(new Set([...s, ...ids])))),
  };
}

function Sidebar({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const ws = useWorkspace();
  const { path } = useLocation();
  const narrow = useNarrow();
  const activePage = path.match(/^\/p\/([\w-]+)/)?.[1] ?? null;
  const expanded = useExpanded();
  const [creating, setCreating] = useState<{ parentId: string | null } | null>(null);
  const [rootOver, setRootOver] = useState(false);
  const [viewDialog, setViewDialog] = useState<View | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openSwitcher = useOpenSwitcher();
  const [importing, setImporting] = useState(false);
  const width = useSidebarWidth();
  const [dragging, setDragging] = useState<string | null>(null);
  const templates = useMemo(() => (ws?.pages ?? []).filter((p) => p.is_template)
    .sort((a, b) => byName(titleOf(a) || 'Untitled', titleOf(b) || 'Untitled')), [ws]);

  const tree = useMemo(() => {
    const folders = new Map<string | null, Folder[]>();
    const pages = new Map<string | null, TreePage[]>();
    const known = new Set(ws?.folders.map((f) => f.id));
    for (const f of ws?.folders ?? []) folders.set(f.parent_id, [...(folders.get(f.parent_id) ?? []), f]);
    for (const p of ws?.pages ?? []) {
      const k = p.folder_id && known.has(p.folder_id) ? p.folder_id : null;
      pages.set(k, [...(pages.get(k) ?? []), p]);
    }
    folders.forEach((l) => l.sort((a, b) => byName(a.name, b.name)));
    pages.forEach((l) => l.sort((a, b) => byName(titleOf(a) || 'Untitled', titleOf(b) || 'Untitled')));
    return { folders, pages, byId: new Map(ws?.folders.map((f) => [f.id, f])) };
  }, [ws]);

  // Open the folders above the page you are on (for example after Today).
  const activeFolder = ws?.pages.find((p) => p.id === activePage)?.folder_id ?? null;
  useEffect(() => {
    const chain: string[] = [];
    for (let f = activeFolder ? tree.byId.get(activeFolder) : undefined; f; f = f.parent_id ? tree.byId.get(f.parent_id) : undefined) chain.push(f.id);
    if (chain.length) expanded.open(chain);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFolder, tree]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); }
  };

  const today = () => { if (!busy) { setBusy(true); void run(openToday).finally(() => setBusy(false)); } };

  const drop = (target: string | null) => (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setRootOver(false);
    let d: Drag;
    try { d = JSON.parse(e.dataTransfer.getData(DRAG_TYPE)); } catch { return; }
    if (d.kind === 'page') {
      const p = ws?.pages.find((x) => x.id === d.id);
      if (p && (p.folder_id ?? null) !== target) void run(() => movePage(d.id, target));
    } else if (d.id !== target) {
      const f = tree.byId.get(d.id);
      if (f && f.parent_id !== target) void run(() => moveFolder(d.id, target));
    }
    if (target) expanded.open([target]);
  };

  const ctx: TreeCtx = { tree, expanded, activePage, drop, setCreating, creating, run, dragging, setDragging };

  return (
    <aside className="sidebar" aria-label="Pages and folders" style={narrowNow() ? undefined : { width: width.value }}>
      <div className="sb-head">
        <Link to="/" className="brand"><span className="brand-mark" aria-hidden="true" />Livepage</Link>
        <SidebarToggle />
      </div>
      <nav className="sb-nav-list" aria-label="Go to">
        <button type="button" className="sb-row" onClick={openSwitcher} title="Search all pages, or jump to one">
          <span className="sb-glyph"><Icon name="search" /></span><span className="sb-row-label">Search</span><kbd>{shortcutLabel}</kbd>
        </button>
        <button type="button" className="sb-row" onClick={today} disabled={busy} title="Open today's page (YYYY/MM/DD/daily)">
          <span className="sb-glyph"><Icon name="today" /></span><span className="sb-row-label">Today</span>
        </button>
        <Link to="/" className={`sb-row ${path === '/' ? 'active' : ''}`}>
          <span className="sb-glyph"><Icon name="home" /></span><span className="sb-row-label">Home</span>
        </Link>
        <Link to="/graph" className={`sb-row ${path === '/graph' ? 'active' : ''}`}>
          <span className="sb-glyph"><Icon name="graph" /></span><span className="sb-row-label">Graph</span>
        </Link>
        {narrow && <button type="button" className="sb-row" onClick={() => dispatchEvent(new Event('livepage:tab-switcher'))} title="Your open tabs">
          <span className="sb-glyph"><Icon name="tabs" /></span><span className="sb-row-label">Open tabs</span>
        </button>}
      </nav>
      {error && <p className="form-error small sb-error" onClick={() => setError(null)}>{error}</p>}

      <div className="sb-scroll">
        <Section id="files" label="Pages" className={`sb-files ${rootOver ? 'drop-over' : ''}`}
          actions={<>
            <button type="button" className="sb-mini" onClick={() => void run(() => newPage(null))} title="New page" aria-label="New page"><Icon name="plus" /></button>
            <button type="button" className="sb-mini" onClick={() => setCreating({ parentId: null })} title="New folder" aria-label="New folder"><Icon name="folder-plus" /></button>
          </>}
          dropProps={{
            onDragOver: (e) => { if (e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); setRootOver(true); } },
            onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setRootOver(false); },
            onDrop: drop(null),
          }}>
          {!ws ? <SkeletonRows /> : (
            <ul className="tree" role="tree">
              <Children parentId={null} depth={0} ctx={ctx} />
            </ul>
          )}
          {ws && !ws.pages.length && !ws.folders.length && !creating && (
            <div className="sb-empty">
              <p>No pages yet.</p>
              <button type="button" className="sb-empty-action" onClick={() => void run(() => newPage(null))}><Icon name="plus" />New page</button>
            </div>
          )}
        </Section>

        <Section id="views" label="Views"
          actions={<button type="button" className="sb-mini" onClick={() => setViewDialog('new')} title="New view from tags" aria-label="New view from tags"><Icon name="plus" /></button>}>
          <ul className="sb-list">
            {ws?.views.map((v) => (
              <li key={v.id} className={`sb-item ${path === `/view/${v.id}` ? 'active' : ''}`}>
                <Link to={`/view/${v.id}`} className="sb-link"><span className="sb-glyph"><Icon name="view" /></span><span className="sb-row-label">{v.name}</span></Link>
                <span className="sb-hover">
                  <button type="button" className="sb-mini" title="Edit view" aria-label="Edit view" onClick={() => setViewDialog(v)}><Icon name="pencil" /></button>
                  <button type="button" className="sb-mini" title="Delete view" aria-label="Delete view"
                    onClick={() => confirm(`Delete the view "${v.name}"? Pages and tags stay as they are.`) && void run(() => deleteView(v.id))}><Icon name="trash" /></button>
                </span>
              </li>
            ))}
            {ws && !ws.views.length && <li className="sb-hint">Save a list of pages by tag.</li>}
          </ul>
        </Section>

        <Section id="templates" label="Templates">
          <ul className="sb-list">
            {templates.map((t) => (
              <li key={t.id} className={`sb-item ${activePage === t.id ? 'active' : ''}`}>
                <button type="button" className="sb-link sb-template" title={`New page from "${titleOf(t) || 'Untitled'}"`}
                  onClick={() => void run(() => newPageFromTemplate(t.id))}>
                  <span className="sb-glyph"><Icon name="template" /></span><span className="sb-row-label">{titleOf(t) || 'Untitled'}</span>
                </button>
                <span className="sb-hover">
                  <Link to={`/p/${t.id}`} className="sb-mini" title="Edit template" aria-label="Edit template"><Icon name="pencil" /></Link>
                </span>
              </li>
            ))}
            {ws && !templates.length && <li className="sb-hint">Turn any page into a template from its ⋯ menu.</li>}
          </ul>
        </Section>

        <Section id="tags" label="Tags">
          <ul className="sb-list">
            {ws?.tags.map((t) => (
              <li key={t.tag} className={`sb-item ${decodeURIComponent(path) === `/tag/${t.tag}` ? 'active' : ''}`}>
                <Link to={`/tag/${encodeURIComponent(t.tag)}`} className="sb-link"><span className="sb-glyph"><Icon name="hash" /></span><span className="sb-row-label">{t.tag}</span></Link>
                <span className="sb-count">{t.count}</span>
              </li>
            ))}
            {ws && !ws.tags.length && <li className="sb-hint">Add tags under a page title.</li>}
          </ul>
        </Section>
      </div>

      <div className="sb-foot">
        <span className="sb-me" title={me.name}>
          <span className="avatar" style={{ background: colorFor(me.id) }} aria-hidden="true">{initials(me.name)}</span>
          <span>{me.name}</span>
        </span>
        <span className="row">
          <ThemeSwitch />
          <button type="button" className="ghost icon-btn" onClick={() => setImporting(true)} title="Import Markdown or an Obsidian vault, or export everything" aria-label="Import or export"><Icon name="import-export" /></button>
          <button type="button" className="ghost icon-btn" onClick={onLogout} title="Log out" aria-label="Log out"><Icon name="log-out" /></button>
        </span>
      </div>
      {!narrowNow() && <div className="sb-resize" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" title="Drag to resize, double-click to reset"
        onPointerDown={width.startDrag} onDoubleClick={width.reset} />}
      {importing && <Suspense fallback={null}><ImportDialog onClose={() => setImporting(false)} /></Suspense>}
      {viewDialog && <ViewDialog view={viewDialog === 'new' ? null : viewDialog} tags={ws?.tags ?? []} onClose={(saved) => {
        setViewDialog(null);
        if (saved) navigate(`/view/${saved.id}`);
      }} />}
    </aside>
  );
}

type TreeCtx = {
  tree: { folders: Map<string | null, Folder[]>; pages: Map<string | null, TreePage[]>; byId: Map<string, Folder> };
  expanded: ReturnType<typeof useExpanded>;
  activePage: string | null;
  drop: (target: string | null) => (e: React.DragEvent) => void;
  creating: { parentId: string | null } | null;
  setCreating: (c: { parentId: string | null } | null) => void;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  /** The page or folder being dragged, dimmed in place while it moves. */
  dragging: string | null;
  setDragging: (id: string | null) => void;
};

function Children({ parentId, depth, ctx }: { parentId: string | null; depth: number; ctx: TreeCtx }) {
  const folders = ctx.tree.folders.get(parentId) ?? [];
  const pages = ctx.tree.pages.get(parentId) ?? [];
  return (
    <>
      {ctx.creating && ctx.creating.parentId === parentId && (
        <li className="tree-row" style={{ '--depth': depth } as React.CSSProperties}>
          <span className="tree-chev" />
          <span className="sb-glyph"><Icon name="folder" /></span>
          <NameInput initial="" placeholder="Folder name" onDone={(name) => {
            ctx.setCreating(null);
            if (name) void ctx.run(async () => { await newFolder(name, parentId); if (parentId) ctx.expanded.open([parentId]); });
          }} />
        </li>
      )}
      {folders.map((f) => <FolderNode key={f.id} folder={f} depth={depth} ctx={ctx} />)}
      {pages.map((p) => <PageNode key={p.id} page={p} depth={depth} ctx={ctx} />)}
    </>
  );
}

function FolderNode({ folder, depth, ctx }: { folder: Folder; depth: number; ctx: TreeCtx }) {
  const open = ctx.expanded.has(folder.id);
  const [renaming, setRenaming] = useState(false);
  const [over, setOver] = useState(false);
  // Hovering a closed folder while dragging opens it after a moment, so you can drop deeper.
  const openTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const leave = () => { setOver(false); clearTimeout(openTimer.current); };
  const count = (ctx.tree.pages.get(folder.id)?.length ?? 0) + (ctx.tree.folders.get(folder.id)?.length ?? 0);
  return (
    <li role="treeitem" aria-expanded={open}>
      <div
        className={`tree-row tree-folder ${over ? 'drop-over' : ''} ${ctx.dragging === folder.id ? 'dragging' : ''}`}
        style={{ '--depth': depth } as React.CSSProperties}
        draggable={!renaming}
        onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ kind: 'folder', id: folder.id })); e.dataTransfer.effectAllowed = 'move'; ctx.setDragging(folder.id); }}
        onDragEnd={() => ctx.setDragging(null)}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
          e.preventDefault(); e.stopPropagation();
          if (!over) { setOver(true); if (!open) openTimer.current = setTimeout(() => ctx.expanded.open([folder.id]), 600); }
        }}
        onDragLeave={leave}
        onDrop={(e) => { leave(); ctx.drop(folder.id)(e); }}
        onClick={() => !renaming && ctx.expanded.toggle(folder.id)}
      >
        <span className={`tree-chev ${open ? 'open' : ''}`}><Icon name="chevron-right" /></span>
        <span className="sb-glyph"><Icon name={open ? 'folder-open' : 'folder'} /></span>
        {renaming ? (
          <NameInput initial={folder.name} onDone={(name) => { setRenaming(false); if (name && name !== folder.name) void ctx.run(() => renameFolder(folder.id, name)); }} />
        ) : (
          <span className="tree-name">{folder.name}</span>
        )}
        {!renaming && (
          <span className="sb-hover" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="sb-mini" title="New page here" aria-label="New page here" onClick={() => void ctx.run(() => newPage(folder.id))}><Icon name="plus" /></button>
            <button type="button" className="sb-mini" title="New folder here" onClick={() => { ctx.expanded.open([folder.id]); ctx.setCreating({ parentId: folder.id }); }} aria-label="New folder here"><Icon name="folder-plus" /></button>
            <button type="button" className="sb-mini" title="Rename" aria-label="Rename" onClick={() => setRenaming(true)}><Icon name="pencil" /></button>
            <button type="button" className="sb-mini" title="Delete folder" aria-label="Delete folder" onClick={() => {
              const msg = count
                ? `Delete "${folder.name}" and the folders inside it? No pages are deleted: pages inside move to the top level.`
                : `Delete the empty folder "${folder.name}"?`;
              if (confirm(msg)) void ctx.run(() => deleteFolder(folder.id));
            }}><Icon name="trash" /></button>
          </span>
        )}
      </div>
      {open && (
        <ul role="group" className="tree tree-group" style={{ '--depth': depth } as React.CSSProperties}>
          <Children parentId={folder.id} depth={depth + 1} ctx={ctx} />
          {!count && !(ctx.creating?.parentId === folder.id) && <li className="tree-empty" style={{ '--depth': depth + 1 } as React.CSSProperties}>Empty folder</li>}
        </ul>
      )}
    </li>
  );
}

function PageNode({ page, depth, ctx }: { page: TreePage; depth: number; ctx: TreeCtx }) {
  const [renaming, setRenaming] = useState(false);
  const title = titleOf(page) || 'Untitled';
  const canEdit = page.role === 'owner' || page.role === 'editor';
  return (
    <li role="treeitem" aria-selected={ctx.activePage === page.id}>
      <div
        className={`tree-row tree-page ${ctx.activePage === page.id ? 'active' : ''} ${ctx.dragging === page.id ? 'dragging' : ''}`}
        style={{ '--depth': depth } as React.CSSProperties}
        draggable={!renaming}
        onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ kind: 'page', id: page.id })); e.dataTransfer.effectAllowed = 'move'; ctx.setDragging(page.id); }}
        onDragEnd={() => ctx.setDragging(null)}
        onDoubleClick={() => canEdit && setRenaming(true)}
      >
        <span className="tree-chev" />
        <span className="sb-glyph" title={page.role === 'owner' ? undefined : 'Shared with you'}><Icon name={page.role === 'owner' ? 'file' : 'users'} /></span>
        {renaming ? (
          <NameInput initial={titleOf(page)} placeholder="Untitled" onDone={(name) => {
            setRenaming(false);
            if (name !== null && name !== titleOf(page)) void ctx.run(() => renamePage(page.id, name));
          }} allowEmpty />
        ) : (
          <Link to={`/p/${page.id}`} className="tree-name">{title}</Link>
        )}
        {!renaming && (
          <span className="sb-hover">
            {canEdit && <button type="button" className="sb-mini" title="Rename" aria-label="Rename" onClick={() => setRenaming(true)}><Icon name="pencil" /></button>}
            {page.role === 'owner' && (
              <button type="button" className="sb-mini" title="Delete page" aria-label="Delete page" onClick={() => {
                if (!confirm(`Delete "${title}" for everyone? This cannot be undone.`)) return;
                void ctx.run(async () => {
                  await api(`/pages/${page.id}`, { method: 'DELETE' });
                  await reloadWorkspace();
                  if (ctx.activePage === page.id) navigate('/');
                });
              }}><Icon name="trash" /></button>
            )}
          </span>
        )}
      </div>
    </li>
  );
}

/** Inline name editor: Enter saves, Escape cancels, leaving the field saves. */
function NameInput({ initial, placeholder, onDone, allowEmpty = false }: { initial: string; placeholder?: string; onDone: (v: string | null) => void; allowEmpty?: boolean }) {
  const [v, setV] = useState(initial);
  const [done, setDone] = useState(false);
  const finish = (val: string | null) => {
    if (done) return;
    setDone(true);
    const t = val?.trim() ?? null;
    onDone(t === null || (!t && !allowEmpty) ? null : t);
  };
  return (
    <input
      className="tree-input"
      autoFocus
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => { if (e.key === 'Enter') finish(v); if (e.key === 'Escape') finish(null); }}
      onBlur={() => finish(v)}
    />
  );
}
