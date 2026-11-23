// Links to pages and tabs. A link stores the target's ids (page, tab), never its path or title,
// so renaming or moving the target never breaks it; the link always shows the current title.
// Type [[ to search, or paste a link to a page or tab of this app.
import { useEffect, useMemo, useState } from 'react';
import { Extension, Node, mergeAttributes, type Editor } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type * as Y from 'yjs';
import { LINK_NODE, MAIN_TAB, listTabs, tabsMap, type Tab } from '@livepage/schema';
import { api } from '../api';
import { navigate } from '../router';
import { titleOf, useWorkspace } from '../workspace';

export const linkHref = (page: string, tab?: string | null) => `/p/${page}${tab && tab !== MAIN_TAB ? `?tab=${encodeURIComponent(tab)}` : ''}`;

// ---------- tabs of any page (cached; the open page reads its own doc) ----------

const tabCache = new Map<string, Promise<Tab[]>>();
function fetchTabs(page: string): Promise<Tab[]> {
  let p = tabCache.get(page);
  if (!p) {
    p = api<{ tabs: Tab[] }>(`/pages/${page}/tabs`).then((r) => r.tabs).catch(() => []);
    tabCache.set(page, p);
    setTimeout(() => tabCache.delete(page), 30_000);
  }
  return p;
}

function useTabs(page: string | null, doc: Y.Doc, currentPage: string): Tab[] {
  const [tabs, setTabs] = useState<Tab[]>([]);
  useEffect(() => {
    if (!page) { setTabs([]); return; }
    if (page === currentPage) {
      const map = tabsMap(doc);
      const update = () => setTabs(listTabs(doc));
      map.observe(update);
      update();
      return () => map.unobserve(update);
    }
    let live = true;
    void fetchTabs(page).then((t) => live && setTabs(t));
    return () => { live = false; };
  }, [page, doc, currentPage]);
  return tabs;
}

// ---------- the inline link node ----------

type LinkOpts = { doc: Y.Doc | null; currentPage: string };

export const PageLink = Node.create<LinkOpts>({
  name: LINK_NODE,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  addOptions() { return { doc: null, currentPage: '' }; },
  addAttributes() {
    return {
      page: { default: null, parseHTML: (el) => el.getAttribute('data-page') },
      tab: { default: null, parseHTML: (el) => el.getAttribute('data-tab') },
      label: { default: null, parseHTML: (el) => el.getAttribute('data-label') ?? el.textContent },
    };
  },
  parseHTML() { return [{ tag: 'a[data-page-link]' }]; },
  renderHTML({ node, HTMLAttributes }) {
    const { page, tab, label } = node.attrs;
    return ['a', mergeAttributes(HTMLAttributes, {
      'data-page-link': '', 'data-page': page, 'data-tab': tab, 'data-label': label, href: linkHref(page, tab),
    }), label || 'link'];
  },
  renderText({ node }) { return node.attrs.label || 'link'; },
  addNodeView() {
    const { doc, currentPage } = this.options;
    return ReactNodeViewRenderer((props: ReactNodeViewProps) => <LinkView {...props} doc={doc!} currentPage={currentPage} />);
  },
});

function LinkView({ node, selected, doc, currentPage }: ReactNodeViewProps & { doc: Y.Doc; currentPage: string }) {
  const { page, tab, label } = node.attrs as { page: string; tab: string | null; label: string | null };
  const ws = useWorkspace();
  const target = ws?.pages.find((p) => p.id === page);
  const tabs = useTabs(tab ? page : null, doc, currentPage);
  const tabTitle = tab ? tabs.find((t) => t.id === tab)?.title : null;
  // Current titles when we can see them; the stored label otherwise (for pages you cannot open).
  const [labelPage, labelTab] = String(label ?? '').split(' › ');
  const pageTitle = page === currentPage && tab ? null : target ? titleOf(target) || 'Untitled' : labelPage || 'Page';
  const text = [pageTitle, tab ? tabTitle ?? labelTab ?? 'Tab' : null].filter(Boolean).join(' › ');
  const missing = ws && !target && page !== currentPage;
  return (
    <NodeViewWrapper as="span" className={`page-link ${selected ? 'is-selected' : ''} ${missing ? 'page-link-missing' : ''}`}>
      <a
        href={linkHref(page, tab)}
        title={missing ? 'You cannot open this page' : `Open ${text}`}
        contentEditable={false}
        onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); navigate(linkHref(page, tab)); }}
      >
        {tab && page === currentPage ? '⇥ ' : '↗ '}{text}
      </a>
    </NodeViewWrapper>
  );
}

// ---------- [[ suggestions and paste ----------

type MenuKeys = { onKey: ((e: KeyboardEvent) => boolean) | null };
const linkKey = new PluginKey('pageLinkInput');

/** Lets the [[ menu take arrow keys / Enter / Escape, and turns pasted app links into links. */
export const PageLinkInput = Extension.create<{ getTitle: (page: string) => string | null }, MenuKeys>({
  name: 'pageLinkInput',
  addOptions() { return { getTitle: () => null }; },
  addStorage() { return { onKey: null }; },
  addProseMirrorPlugins() {
    const storage = this.storage;
    const editor = this.editor;
    const getTitle = this.options.getTitle;
    return [new Plugin({
      key: linkKey,
      props: {
        handleKeyDown: (_view, event) => storage.onKey?.(event) ?? false,
        handlePaste: (_view, event) => {
          const text = event.clipboardData?.getData('text/plain').trim() ?? '';
          const m = text.match(/^(?:(https?:\/\/[^/\s]+))?\/p\/(p_[\w-]{8,40})(?:\?tab=([\w-]+))?\/?$/);
          if (!m || (m[1] && m[1] !== location.origin)) return false;
          const title = getTitle(m[2]);
          editor.chain().focus().insertContent([{ type: LINK_NODE, attrs: { page: m[2], tab: m[3] ?? null, label: title } }, { type: 'text', text: ' ' }]).run();
          return true;
        },
      },
    })];
  },
});

type Item = { key: string; page: string; tab: string | null; title: string; hint: string };

/** The menu that opens after typing [[. Type a page name; add # to pick one of its tabs. */
export function LinkMenu({ editor, doc, currentPage }: { editor: Editor; doc: Y.Doc; currentPage: string }) {
  const ws = useWorkspace();
  const [match, setMatch] = useState<{ from: number; to: number; query: string } | null>(null);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const update = () => {
      const { state } = editor;
      const { $from, empty } = state.selection;
      if (!empty || !editor.isEditable) return setMatch(null);
      const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
      const m = before.match(/\[\[([^\]\n￼]{0,80})$/);
      setMatch(m ? { from: $from.pos - m[0].length, to: $from.pos, query: m[1] } : null);
    };
    editor.on('transaction', update);
    return () => { editor.off('transaction', update); };
  }, [editor]);
  useEffect(() => setIndex(0), [match?.query]);

  const [pageQ, tabQ] = match ? (match.query.includes('#') ? [match.query.slice(0, match.query.indexOf('#')), match.query.slice(match.query.indexOf('#') + 1)] : [match.query, null]) : ['', null];
  const pages = useMemo(() => {
    const q = pageQ.trim().toLowerCase();
    const all = (ws?.pages ?? []).map((p) => ({ ...p, t: titleOf(p) || 'Untitled' }));
    const hits = all.filter((p) => p.t.toLowerCase().includes(q) || p.path.toLowerCase().includes(q));
    // Exact and prefix matches first, then by most recently edited.
    const score = (t: string) => (t.toLowerCase() === q ? 0 : t.toLowerCase().startsWith(q) ? 1 : 2);
    return hits.sort((a, b) => score(a.t) - score(b.t) || +new Date(b.updated_at) - +new Date(a.updated_at));
  }, [ws, pageQ]);

  // With "#": tabs of the first matching page (or of this page when nothing is typed before #).
  const tabPage = tabQ === null ? null : pageQ.trim() ? pages[0]?.id ?? null : currentPage;
  const tabs = useTabs(tabPage, doc, currentPage);
  const thisPageTabs = useTabs(match && tabQ === null ? currentPage : null, doc, currentPage);

  const items: Item[] = useMemo(() => {
    if (!match) return [];
    const pageTitle = (id: string) => { const p = ws?.pages.find((x) => x.id === id); return p ? titleOf(p) || 'Untitled' : 'This page'; };
    if (tabQ !== null && tabPage) {
      const q = tabQ.trim().toLowerCase();
      return tabs.filter((t) => t.title.toLowerCase().includes(q)).slice(0, 8).map((t) => ({
        key: `${tabPage}#${t.id}`, page: tabPage, tab: t.id === MAIN_TAB ? null : t.id, title: `${pageTitle(tabPage)} › ${t.title}`,
        hint: tabPage === currentPage ? 'tab on this page' : 'tab',
      }));
    }
    const q = pageQ.trim().toLowerCase();
    const ownTabs = thisPageTabs.length > 1
      ? thisPageTabs.filter((t) => q && t.title.toLowerCase().includes(q)).slice(0, 3).map((t) => ({
        key: `${currentPage}#${t.id}`, page: currentPage, tab: t.id === MAIN_TAB ? null : t.id, title: `${pageTitle(currentPage)} › ${t.title}`, hint: 'tab on this page',
      }))
      : [];
    return [
      ...pages.filter((p) => p.id !== currentPage || !q).slice(0, 8).map((p) => ({ key: p.id, page: p.id, tab: null, title: p.t, hint: p.path || '' })),
      ...ownTabs,
    ];
  }, [match, tabQ, tabPage, tabs, thisPageTabs, pages, pageQ, ws, currentPage]);

  const pick = (it: Item) => {
    if (!match) return;
    editor.chain().focus().deleteRange({ from: match.from, to: match.to })
      .insertContent([{ type: LINK_NODE, attrs: { page: it.page, tab: it.tab, label: it.title } }, { type: 'text', text: ' ' }]).run();
    setMatch(null);
  };

  // Keyboard: the editor asks us first while the menu is open.
  const storage = (editor.storage as unknown as Record<string, MenuKeys>).pageLinkInput;
  useEffect(() => {
    if (!storage) return;
    storage.onKey = !match ? null : (e) => {
      if (e.key === 'Escape') { setMatch(null); return true; }
      if (!items.length) return false;
      if (e.key === 'ArrowDown') { setIndex((i) => (i + 1) % items.length); return true; }
      if (e.key === 'ArrowUp') { setIndex((i) => (i - 1 + items.length) % items.length); return true; }
      if (e.key === 'Enter' || e.key === 'Tab') { pick(items[Math.min(index, items.length - 1)]); return true; }
      return false;
    };
    return () => { storage.onKey = null; };
  });

  if (!match) return null;
  let coords = { left: 0, bottom: 0 };
  try { coords = editor.view.coordsAtPos(match.from); } catch { /* position gone */ }
  return (
    <div className="link-menu" style={{ left: coords.left, top: coords.bottom + 4 }} onMouseDown={(e) => e.preventDefault()}>
      <div className="link-menu-head muted small">{tabQ === null ? 'Link to a page · type # for a tab' : 'Link to a tab'}</div>
      {items.length ? items.map((it, i) => (
        <button type="button" key={it.key} className={`link-item ${i === index ? 'active' : ''}`} onMouseEnter={() => setIndex(i)} onClick={() => pick(it)}>
          <span>{it.tab || it.hint.startsWith('tab') ? '⇥' : '↗'} {it.title}</span>
          {it.hint && <span className="muted small">{it.hint}</span>}
        </button>
      )) : <div className="muted small link-item">No matches</div>}
    </div>
  );
}
