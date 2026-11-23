// Obsidian-style sidebar: a Today button, your folder tree (drag pages and folders to move
// them), saved tag views and all tags. Folders are yours alone; pages shared with you show
// up at the top level until you file them somewhere.
import { Suspense, createContext, lazy, useContext, useEffect, useMemo, useState } from 'react';
import { api, type Me } from './api';
import { Link, navigate, useLocation } from './router';
import {
  deleteFolder, deleteView, moveFolder, movePage, newFolder, newPage, newPageFromTemplate, openToday, reloadWorkspace, renameFolder, renamePage,
  titleOf, useWorkspace, type Folder, type TreePage, type View,
} from './workspace';
import { ViewDialog } from './screens/ViewDialog';
import { shortcutLabel, SwitcherProvider, useOpenSwitcher } from './QuickSwitcher';
const ImportDialog = lazy(() => import('./screens/ImportDialog').then((m) => ({ default: m.ImportDialog })));

// ---------- layout + open/closed state ----------

const SidebarCtx = createContext<{ open: boolean; toggle: () => void }>({ open: true, toggle: () => {} });
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const NARROW = '(max-width: 800px)';
const narrowNow = () => typeof matchMedia !== 'undefined' && matchMedia(NARROW).matches;

/** True at phone width; follows the window as it is resized or rotated. */
function useNarrow() {
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

/** The ☰ button screens put at the start of their top bar. */
export function SidebarToggle() {
  const { open, toggle } = useContext(SidebarCtx);
  return (
    <button type="button" className="ghost sidebar-toggle" onClick={toggle} aria-label={open ? 'Hide sidebar' : 'Show sidebar'} title={open ? 'Hide sidebar' : 'Show sidebar'}>
      ☰
    </button>
  );
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
  const activePage = path.match(/^\/p\/([\w-]+)/)?.[1] ?? null;
  const expanded = useExpanded();
  const [creating, setCreating] = useState<{ parentId: string | null } | null>(null);
  const [rootOver, setRootOver] = useState(false);
  const [viewDialog, setViewDialog] = useState<View | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openSwitcher = useOpenSwitcher();
  const [importing, setImporting] = useState(false);
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

  const ctx: TreeCtx = { tree, expanded, activePage, drop, setCreating, creating, run };

  return (
    <aside className="sidebar" aria-label="Pages and folders">
      <div className="sb-head">
        <SidebarToggle />
        <Link to="/" className="brand">Livepage</Link>
      </div>
      <div className="sb-nav">
        <button type="button" className="sb-search" onClick={openSwitcher} title="Search all pages, or jump to one">
          <span>⌕ Search</span><kbd>{shortcutLabel}</kbd>
        </button>
        <Link to="/graph" className={`sb-graph ${path === '/graph' ? 'active' : ''}`}>◉ Graph</Link>
      </div>
      <div className="sb-actions">
        <button type="button" className="sb-today" onClick={today} disabled={busy} title="Open today's page (YYYY/MM/DD/daily)">
          ☀ Today
        </button>
        <button type="button" className="sb-icon" onClick={() => void run(() => newPage(null))} title="New page">＋ Page</button>
        <button type="button" className="sb-icon" onClick={() => setCreating({ parentId: null })} title="New folder">＋ Folder</button>
      </div>
      {error && <p className="form-error small sb-error" onClick={() => setError(null)}>{error}</p>}

      <div className="sb-scroll">
        <div
          className={`sb-section sb-files ${rootOver ? 'drop-over' : ''}`}
          onDragOver={(e) => { if (e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); setRootOver(true); } }}
          onDragLeave={(e) => { if (e.currentTarget === e.target) setRootOver(false); }}
          onDrop={drop(null)}
        >
          <div className="sb-label">Files</div>
          {!ws ? <p className="muted small sb-pad">Loading…</p> : (
            <ul className="tree" role="tree">
              <Children parentId={null} depth={0} ctx={ctx} />
            </ul>
          )}
          {ws && !ws.pages.length && !ws.folders.length && !creating && <p className="muted small sb-pad">No pages yet.</p>}
        </div>

        <div className="sb-section">
          <div className="sb-label">Templates</div>
          <ul className="sb-list">
            {templates.map((t) => (
              <li key={t.id} className={`sb-item ${activePage === t.id ? 'active' : ''}`}>
                <button type="button" className="sb-link sb-template" title={`New page from "${titleOf(t) || 'Untitled'}"`}
                  onClick={() => void run(() => newPageFromTemplate(t.id))}>
                  <span className="sb-glyph">＋</span>{titleOf(t) || 'Untitled'}
                </button>
                <span className="sb-hover">
                  <Link to={`/p/${t.id}`} className="sb-mini" title="Edit template">✎</Link>
                </span>
              </li>
            ))}
            {ws && !templates.length && <li className="muted small sb-pad">Make any page a template from ⋯ on the page.</li>}
          </ul>
        </div>

        <div className="sb-section">
          <div className="sb-label">
            Views <button type="button" className="sb-mini" onClick={() => setViewDialog('new')} title="New view from tags">＋</button>
          </div>
          <ul className="sb-list">
            {ws?.views.map((v) => (
              <li key={v.id} className={`sb-item ${path === `/view/${v.id}` ? 'active' : ''}`}>
                <Link to={`/view/${v.id}`} className="sb-link"><span className="sb-glyph">◫</span>{v.name}</Link>
                <span className="sb-hover">
                  <button type="button" className="sb-mini" title="Edit view" onClick={() => setViewDialog(v)}>✎</button>
                  <button type="button" className="sb-mini" title="Delete view"
                    onClick={() => confirm(`Delete the view "${v.name}"? Pages and tags stay as they are.`) && void run(() => deleteView(v.id))}>✕</button>
                </span>
              </li>
            ))}
            {ws && !ws.views.length && <li className="muted small sb-pad">Save a list of pages by tag with ＋.</li>}
          </ul>
        </div>

        <div className="sb-section">
          <div className="sb-label">Tags</div>
          <ul className="sb-list">
            {ws?.tags.map((t) => (
              <li key={t.tag} className={`sb-item ${decodeURIComponent(path) === `/tag/${t.tag}` ? 'active' : ''}`}>
                <Link to={`/tag/${encodeURIComponent(t.tag)}`} className="sb-link"><span className="sb-glyph">#</span>{t.tag}</Link>
                <span className="muted small sb-count">{t.count}</span>
              </li>
            ))}
            {ws && !ws.tags.length && <li className="muted small sb-pad">Add tags under a page title.</li>}
          </ul>
        </div>
      </div>

      <div className="sb-foot">
        <span className="muted small">{me.name}</span>
        <span className="row">
          <button type="button" className="ghost" onClick={() => setImporting(true)} title="Import Markdown or an Obsidian vault, or export everything">⇅ Import / export</button>
          <button type="button" className="ghost" onClick={onLogout}>Log out</button>
        </span>
      </div>
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
};

function Children({ parentId, depth, ctx }: { parentId: string | null; depth: number; ctx: TreeCtx }) {
  const folders = ctx.tree.folders.get(parentId) ?? [];
  const pages = ctx.tree.pages.get(parentId) ?? [];
  return (
    <>
      {ctx.creating && ctx.creating.parentId === parentId && (
        <li className="tree-row" style={{ paddingLeft: 8 + depth * 14 }}>
          <span className="tree-chev">▸</span>
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
  const count = (ctx.tree.pages.get(folder.id)?.length ?? 0) + (ctx.tree.folders.get(folder.id)?.length ?? 0);
  return (
    <li role="treeitem" aria-expanded={open}>
      <div
        className={`tree-row tree-folder ${over ? 'drop-over' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        draggable={!renaming}
        onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ kind: 'folder', id: folder.id })); e.dataTransfer.effectAllowed = 'move'; }}
        onDragOver={(e) => { if (e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); e.stopPropagation(); setOver(true); } }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { setOver(false); ctx.drop(folder.id)(e); }}
        onClick={() => !renaming && ctx.expanded.toggle(folder.id)}
      >
        <span className={`tree-chev ${open ? 'open' : ''}`}>▸</span>
        {renaming ? (
          <NameInput initial={folder.name} onDone={(name) => { setRenaming(false); if (name && name !== folder.name) void ctx.run(() => renameFolder(folder.id, name)); }} />
        ) : (
          <span className="tree-name">{folder.name}</span>
        )}
        {!renaming && (
          <span className="sb-hover" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="sb-mini" title="New page here" onClick={() => void ctx.run(() => newPage(folder.id))}>＋</button>
            <button type="button" className="sb-mini" title="New folder here" onClick={() => { ctx.expanded.open([folder.id]); ctx.setCreating({ parentId: folder.id }); }}>▸＋</button>
            <button type="button" className="sb-mini" title="Rename" onClick={() => setRenaming(true)}>✎</button>
            <button type="button" className="sb-mini" title="Delete folder" onClick={() => {
              const msg = count
                ? `Delete "${folder.name}" and the folders inside it? No pages are deleted: pages inside move to the top level.`
                : `Delete the empty folder "${folder.name}"?`;
              if (confirm(msg)) void ctx.run(() => deleteFolder(folder.id));
            }}>✕</button>
          </span>
        )}
      </div>
      {open && (
        <ul role="group" className="tree">
          <Children parentId={folder.id} depth={depth + 1} ctx={ctx} />
          {!count && !(ctx.creating?.parentId === folder.id) && <li className="muted small tree-empty" style={{ paddingLeft: 30 + depth * 14 }}>Empty</li>}
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
        className={`tree-row tree-page ${ctx.activePage === page.id ? 'active' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        draggable={!renaming}
        onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ kind: 'page', id: page.id })); e.dataTransfer.effectAllowed = 'move'; }}
        onDoubleClick={() => canEdit && setRenaming(true)}
      >
        <span className="tree-chev tree-doc">{page.role === 'owner' ? '' : '⇄'}</span>
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
            {canEdit && <button type="button" className="sb-mini" title="Rename" onClick={() => setRenaming(true)}>✎</button>}
            {page.role === 'owner' && (
              <button type="button" className="sb-mini" title="Delete page" onClick={() => {
                if (!confirm(`Delete "${title}" for everyone? This cannot be undone.`)) return;
                void ctx.run(async () => {
                  await api(`/pages/${page.id}`, { method: 'DELETE' });
                  await reloadWorkspace();
                  if (ctx.activePage === page.id) navigate('/');
                });
              }}>✕</button>
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
