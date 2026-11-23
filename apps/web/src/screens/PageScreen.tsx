import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { IndexeddbPersistence } from 'y-indexeddb';
import { META, MAIN_TAB, listTabs, type CommentAnchor } from '@livepage/schema';
import type { Editor } from '@tiptap/core';
import { Icon } from '../design/Icon';
import { api, colorFor, type Me, type Role } from '../api';
import { collabUrl } from '../config';
import { Link, useLocation, useNavigate } from '../router';
import { Backlinks } from '../Backlinks';
import { PageEditor } from '../editor/PageEditor';
import { TabBar } from '../TabBar';
import { forgetLocalPage, localPageName, noteLocalPage } from '../offline';
import { PageSkeleton } from '../Skeleton';

// Opened on demand, so they are not part of what every page view downloads.
const ShareDialog = lazy(() => import('./ShareDialog').then((m) => ({ default: m.ShareDialog })));
const HistoryPanel = lazy(() => import('./HistoryPanel').then((m) => ({ default: m.HistoryPanel })));
const AssistantPanel = lazy(() => import('./AssistantPanel').then((m) => ({ default: m.AssistantPanel })));
import { SidebarToggle } from '../Sidebar';
import { TagEditor } from '../TagEditor';
import { PageMenu } from '../PageMenu';
import { Presence, uniquePeers, type Peer } from '../Presence';
import { reloadWorkspace, setLiveTitle, useWorkspace } from '../workspace';

type PageInfo = { id: string; title: string; path: string; folder_id: string | null; tags: string[]; is_template?: boolean; published_slug?: string | null };
import { CommentsPanel } from './CommentsPanel';
import { CommentStore } from '../editor/comments';


type Live = { doc: Y.Doc; provider: HocuspocusProvider };

export function PageScreen({ pageId, me }: { pageId: string; me: Me }) {
  const [info, setInfo] = useState<{ role: Role; page: PageInfo } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The live connection starts right away, next to the request for the page's details, not after it.
  // The copy saved in this browser (if any) fills the page before the server has answered.
  // The session cookie authenticates the WebSocket; no token needed in the browser.
  const live = useMemo(() => {
    const doc = new Y.Doc();
    const name = localPageName(me.id, pageId);
    let local: IndexeddbPersistence | null = null;
    try { local = new IndexeddbPersistence(name, doc); noteLocalPage(name); } catch { /* private mode: no local copy */ }
    const provider = new HocuspocusProvider({ url: collabUrl(), name: pageId, document: doc, token: 'session' });
    return { doc, provider, local, name };
  }, [pageId, me.id]);
  useEffect(() => () => {
    live.provider.destroy();
    void live.local?.destroy().catch(() => {});
    live.doc.destroy();
  }, [live]);

  useEffect(() => {
    api<{ role: Role; page: PageInfo }>(`/pages/${pageId}`).then(setInfo).catch((e) => {
      setError(e.message);
      // Gone, or no longer shared with you: don't keep a copy on this device.
      if (e?.status === 404 || e?.status === 403) void (live.local?.clearData() ?? Promise.resolve()).catch(() => {}).then(() => forgetLocalPage(live.name));
    });
  }, [pageId, live]);

  if (error) return <div className="center"><p>{error} <Link to="/">Back to your pages</Link></p></div>;
  if (!info) return <PageSkeleton />;
  return <LivePage pageId={pageId} me={me} role={info.role} info={info.page} live={live} />;
}

function LivePage({ pageId, me, role, info, live }: { pageId: string; me: Me; role: Role; info: PageInfo; live: Live }) {
  const ws = useWorkspace();
  const folderPath = ws?.pages.find((p) => p.id === pageId)?.path ?? info.path;
  const readOnly = role === 'viewer' || role === 'commenter';
  const user = useMemo(() => ({ id: me.id, name: me.name, color: colorFor(me.id) }), [me]);
  const [status, setStatus] = useState('connecting');
  const [peers, setPeers] = useState<Peer[]>([]);
  const [title, setTitle] = useState('');
  const [sharing, setSharing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [asking, setAsking] = useState(false);
  // This workspace tab's own location (it may be in the background or the other half of a split).
  const loc = useLocation();
  const { search } = loc;
  const nav = useNavigate();
  const locRef = useRef(loc);
  locRef.current = loc;
  const [tab, setTab] = useState(() => new URLSearchParams(search).get('tab') || MAIN_TAB);
  // Following a link to another tab of this same page changes only ?tab=.
  useEffect(() => { setTab(new URLSearchParams(search).get('tab') || MAIN_TAB); }, [search]);
  const [copied, setCopied] = useState(false);
  const [synced, setSynced] = useState(false);
  const [isTemplate, setIsTemplate] = useState(!!info.is_template);
  const [publishedSlug, setPublishedSlug] = useState(info.published_slug ?? null);
  const copyLink = async () => {
    try { await navigator.clipboard.writeText(location.origin + loc.path + loc.search); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* no clipboard */ }
  };
  const canComment = role !== 'viewer';
  const commentStore = useMemo(() => new CommentStore(), [pageId]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [commentsOpen, setCommentsOpen] = useState(() => new URLSearchParams(search).has('comment') || pageColumnWidth() >= 1100);
  const [pendingComment, setPendingComment] = useState<CommentAnchor | null>(null);
  const [openComments, setOpenComments] = useState(0);
  const openAskAi = useCallback(() => { setAsking(true); setCommentsOpen(false); }, []);
  const startComment = useCallback((a: CommentAnchor) => { setPendingComment(a); setCommentsOpen(true); setAsking(false); }, []);

  const selectTab = useCallback((id: string) => {
    setTab(id);
    const { path, search } = locRef.current;
    const q = new URLSearchParams(search);
    if (id === MAIN_TAB) q.delete('tab');
    else q.set('tab', id);
    const qs = q.toString();
    const to = path + (qs ? `?${qs}` : '');
    if (to !== path + search) nav(to, true); // keeps useLocation in step
  }, [nav]);

  const { doc, provider } = live;

  const tabTitle = useCallback((id: string) => listTabs(doc).find((t) => t.id === id)?.title ?? id, [doc]);

  useEffect(() => {
    const onStatus = ({ status }: { status: string }) => setStatus(status);
    const onSynced = () => setSynced(true);
    if (provider.isSynced) setSynced(true);
    provider.on('synced', onSynced);
    const awareness = provider.awareness!;
    const onAwareness = () => {
      const list: Peer[] = [];
      awareness.getStates().forEach((s) => s.user && list.push({ ...s.user, tab: s.tab ?? MAIN_TAB }));
      setPeers(list);
    };
    const meta = doc.getMap(META);
    const onMeta = () => { const t = String(meta.get('title') ?? ''); setTitle(t); setLiveTitle(pageId, t); };
    provider.on('status', onStatus);
    const offSynced = () => provider.off('synced', onSynced);
    awareness.on('change', onAwareness);
    meta.observe(onMeta);
    onMeta();
    return () => {
      provider.off('status', onStatus);
      offSynced();
      awareness.off('change', onAwareness);
      meta.unobserve(onMeta);
    };
  }, [provider, doc, pageId]);

  // A page shared with you that is not in your sidebar yet (just opened from a link): show it.
  useEffect(() => { if (ws && !ws.pages.some((p) => p.id === pageId)) void reloadWorkspace(); }, [ws, pageId]);
  useEffect(() => { provider.setAwarenessField('tab', tab); }, [provider, tab]);

  return (
    <div className={`shell ${commentsOpen ? 'with-comments' : ''}`}>
      <header className="topbar page-topbar">
        <SidebarToggle />
        {folderPath && <span className="crumbs muted small">{folderPath.split('/').join(' / ')}</span>}
        <span className={`status status-${status}`} role="status" title={status === 'connected' ? 'Connected: changes sync live' : status}>
          <span className="status-dot" aria-hidden="true" />
          <span className={status === 'connected' ? 'sr-only' : 'status-label'}>{status === 'connected' ? 'Connected' : status}</span>
        </span>
        {readOnly && <span className="badge">{role === 'commenter' ? 'Can comment' : 'View only'}</span>}
        {isTemplate && <span className="badge badge-template narrow-hide" title="New pages can start from this template">Template</span>}
        {publishedSlug && <a className="badge badge-published narrow-hide" href={`/pub/${publishedSlug}`} target="_blank" rel="noopener" title="Published: open the public page"><span className="dot" /><span className="badge-label">Published</span></a>}
        <Presence peers={peers} />
        <Link to={`/graph?page=${pageId}`} className="ghost-link narrow-hide" title="Graph around this page"><Icon name="graph" />Graph</Link>
        {!readOnly && <button type="button" className="ghost narrow-hide" onClick={() => setShowHistory(true)} title="Version history"><Icon name="history" />History</button>}
        {!readOnly && <button type="button" className={`ask-ai ${asking ? 'on' : ''}`} onClick={() => { setAsking((v) => !v); setCommentsOpen(false); }} title="Ask AI" aria-label="Ask AI"><Icon name="sparkles" /><span className="ask-ai-label">Ask AI</span></button>}
        <button type="button" className="ghost narrow-hide" onClick={copyLink} title="Copy a link to this page (and tab). Paste it into any page to link here.">
          {copied ? <><Icon name="check" /><span className="copy-link-label">Copied</span></> : <><Icon name="link" /><span className="copy-link-label">Copy link</span></>}
        </button>
        <button type="button" className={`comments-toggle ${commentsOpen ? 'on' : ''}`} onClick={() => { setCommentsOpen((o) => !o); setAsking(false); }} aria-pressed={commentsOpen}>
          <Icon name="comment" />{openComments ? <span className="count">{openComments}</span> : null}<span className="sr-only"> comments</span>
        </button>
        {role === 'owner' && <button type="button" className="primary" onClick={() => setSharing(true)}>Share</button>}
        <PageMenu pageId={pageId} role={role} title={title} isTemplate={isTemplate} publishedSlug={publishedSlug}
          onChange={(p) => { if (p.isTemplate !== undefined) setIsTemplate(p.isTemplate); if (p.publishedSlug !== undefined) setPublishedSlug(p.publishedSlug); }}
          onHistory={readOnly ? undefined : () => setShowHistory(true)} onCopyLink={copyLink} copied={copied} />
      </header>
      <main className={`page ${readOnly ? 'read-only' : ''} ${asking ? 'with-assistant' : ''}`}>
        <TitleInput value={title} readOnly={readOnly} onChange={(t) => doc.getMap(META).set('title', t.slice(0, 200))} />
        <TagEditor pageId={pageId} initial={info.tags} readOnly={readOnly} />
        <TabBar doc={doc} active={tab} onSelect={selectTab} peers={uniquePeers(peers, true)} readOnly={readOnly} synced={synced} />
        <PageEditor key={tab} doc={doc} provider={provider} user={user} tab={tab} readOnly={readOnly} pageId={pageId}
          comments={commentStore} canComment={canComment} onComment={startComment} onEditor={setEditor}
          onAskAi={readOnly ? undefined : openAskAi} />
        <Backlinks pageId={pageId} tab={tab} />
      </main>
      {asking && <Suspense fallback={null}><AssistantPanel pageId={pageId} tab={tab} onClose={() => setAsking(false)} /></Suspense>}
      <CommentsPanel pageId={pageId} tab={tab} tabTitle={tabTitle} onSelectTab={selectTab} provider={provider} me={me} role={role}
        editor={editor} store={commentStore} pending={pendingComment} setPending={setPendingComment}
        open={commentsOpen} setOpen={setCommentsOpen} onCount={setOpenComments} />
      {sharing && <Suspense fallback={null}><ShareDialog pageId={pageId} onClose={() => setSharing(false)} /></Suspense>}
      {showHistory && <Suspense fallback={null}><HistoryPanel pageId={pageId} canRestore={!readOnly} onClose={() => setShowHistory(false)} /></Suspense>}
    </div>
  );
}

/** The page title: wraps onto more lines instead of being cut off on narrow screens. Enter moves on, no line breaks. */
function TitleInput({ value, readOnly, onChange }: { value: string; readOnly: boolean; onChange: (title: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  useLayoutEffect(fit, [value, fit]);
  useEffect(() => {
    addEventListener('resize', fit);
    return () => removeEventListener('resize', fit);
  }, [fit]);
  return (
    <textarea
      ref={ref}
      className="page-title-input"
      placeholder="Untitled"
      rows={1}
      value={value}
      readOnly={readOnly}
      aria-label="Page title"
      onChange={(e) => onChange(e.target.value.replace(/[\r\n]+/g, ' '))}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
        e.preventDefault();
        (e.currentTarget.closest('.page')?.querySelector('.editor .ProseMirror') as HTMLElement | null)?.focus();
      }}
    />
  );
}

/** Width of the page column (the window minus a docked sidebar). Comments open by default only when they fit beside the page. */
function pageColumnWidth() {
  return (document.querySelector('.wt-pane.wt-focused') ?? document.querySelector('.layout-main'))?.clientWidth ?? window.innerWidth;
}
