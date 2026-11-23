import { useCallback, useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { META, MAIN_TAB } from '@livepage/schema';
import { api, colorFor, type Me, type Role } from '../api';
import { collabUrl } from '../config';
import { Link, navigate, useLocation } from '../router';
import { Backlinks } from '../Backlinks';
import { PageEditor } from '../editor/PageEditor';
import { TabBar } from '../TabBar';
import { ShareDialog } from './ShareDialog';
import { SidebarToggle } from '../Sidebar';
import { TagEditor } from '../TagEditor';
import { reloadWorkspace, setLiveTitle, useWorkspace } from '../workspace';

type PageInfo = { id: string; title: string; path: string; folder_id: string | null; tags: string[] };

type Peer = { name: string; color: string; kind?: string; tab?: string };

export function PageScreen({ pageId, me }: { pageId: string; me: Me }) {
  const [info, setInfo] = useState<{ role: Role; page: PageInfo } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ role: Role; page: PageInfo }>(`/pages/${pageId}`).then(setInfo).catch((e) => setError(e.message));
  }, [pageId]);

  if (error) return <div className="center"><p>{error} <Link to="/">Back to your pages</Link></p></div>;
  if (!info) return <div className="center muted">Loading…</div>;
  return <LivePage pageId={pageId} me={me} role={info.role} info={info.page} />;
}

function LivePage({ pageId, me, role, info }: { pageId: string; me: Me; role: Role; info: PageInfo }) {
  const ws = useWorkspace();
  const folderPath = ws?.pages.find((p) => p.id === pageId)?.path ?? info.path;
  const readOnly = role === 'viewer' || role === 'commenter';
  const user = useMemo(() => ({ id: me.id, name: me.name, color: colorFor(me.id) }), [me]);
  const [status, setStatus] = useState('connecting');
  const [peers, setPeers] = useState<Peer[]>([]);
  const [title, setTitle] = useState('');
  const [sharing, setSharing] = useState(false);
  const [tab, setTab] = useState(() => new URLSearchParams(location.search).get('tab') || MAIN_TAB);
  // Following a link to another tab of this same page changes only ?tab=.
  const { search } = useLocation();
  useEffect(() => { setTab(new URLSearchParams(search).get('tab') || MAIN_TAB); }, [search]);
  const [copied, setCopied] = useState(false);
  const [synced, setSynced] = useState(false);
  const copyLink = async () => {
    try { await navigator.clipboard.writeText(location.href); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* no clipboard */ }
  };

  const selectTab = useCallback((id: string) => {
    setTab(id);
    const url = new URL(location.href);
    if (id === MAIN_TAB) url.searchParams.delete('tab');
    else url.searchParams.set('tab', id);
    if (url.href !== location.href) navigate(url.pathname + url.search, true); // keeps useLocation in step
  }, []);

  // The session cookie authenticates the WebSocket; no token needed in the browser.
  const { doc, provider } = useMemo(() => {
    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({ url: collabUrl(), name: pageId, document: doc, token: 'session' });
    return { doc, provider };
  }, [pageId]);

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
  useEffect(() => () => { provider.destroy(); doc.destroy(); }, [provider, doc]);
  useEffect(() => { provider.setAwarenessField('tab', tab); }, [provider, tab]);
  useEffect(() => { document.title = `${title || 'Untitled'} · Livepage`; }, [title]);

  return (
    <div className="shell">
      <header className="topbar">
        <SidebarToggle />
        {folderPath && <span className="crumbs muted small">{folderPath.split('/').join(' / ')}</span>}
        <span className={`status status-${status}`}>{status}</span>
        {readOnly && <span className="badge">View only</span>}
        <div className="peers">
          {peers.map((p, i) => (
            <span key={i} className="peer" style={{ background: p.color }} title={p.name}>
              {p.kind === 'agent' ? '✦ ' : ''}{p.name}
            </span>
          ))}
        </div>
        <Link to={`/graph?page=${pageId}`} className="ghost-link small" >◉ Graph</Link>
        <button type="button" className="ghost" onClick={copyLink} title="Copy a link to this page (and tab). Paste it into any page to link here.">
          {copied ? 'Copied' : '🔗 Copy link'}
        </button>
        {role === 'owner' && <button type="button" className="primary" onClick={() => setSharing(true)}>Share</button>}
      </header>
      <main className={`page ${readOnly ? 'read-only' : ''}`}>
        <input
          className="page-title-input"
          placeholder="Untitled"
          value={title}
          readOnly={readOnly}
          aria-label="Page title"
          onChange={(e) => doc.getMap(META).set('title', e.target.value.slice(0, 200))}
        />
        <TagEditor pageId={pageId} initial={info.tags} readOnly={readOnly} />
        <TabBar doc={doc} active={tab} onSelect={selectTab} peers={peers} readOnly={readOnly} synced={synced} />
        <PageEditor key={tab} doc={doc} provider={provider} user={user} tab={tab} readOnly={readOnly} pageId={pageId} />
        <Backlinks pageId={pageId} tab={tab} />
      </main>
      {sharing && <ShareDialog pageId={pageId} onClose={() => setSharing(false)} />}
    </div>
  );
}
