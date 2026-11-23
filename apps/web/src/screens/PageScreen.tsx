import { useCallback, useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { META, MAIN_TAB } from '@livepage/schema';
import { api, colorFor, type Me, type Role } from '../api';
import { collabUrl } from '../config';
import { Link } from '../router';
import { PageEditor } from '../editor/PageEditor';
import { TabBar } from '../TabBar';
import { ShareDialog } from './ShareDialog';
import { HistoryPanel } from './HistoryPanel';

type Peer = { name: string; color: string; kind?: string; tab?: string };

export function PageScreen({ pageId, me }: { pageId: string; me: Me }) {
  const [role, setRole] = useState<Role | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ role: Role }>(`/pages/${pageId}`).then((r) => setRole(r.role)).catch((e) => setError(e.message));
  }, [pageId]);

  if (error) return <div className="center"><p>{error} <Link to="/">Back to your pages</Link></p></div>;
  if (!role) return <div className="center muted">Loading…</div>;
  return <LivePage pageId={pageId} me={me} role={role} />;
}

function LivePage({ pageId, me, role }: { pageId: string; me: Me; role: Role }) {
  const readOnly = role === 'viewer' || role === 'commenter';
  const user = useMemo(() => ({ id: me.id, name: me.name, color: colorFor(me.id) }), [me]);
  const [status, setStatus] = useState('connecting');
  const [peers, setPeers] = useState<Peer[]>([]);
  const [title, setTitle] = useState('');
  const [sharing, setSharing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [tab, setTab] = useState(() => new URLSearchParams(location.search).get('tab') || MAIN_TAB);

  const selectTab = useCallback((id: string) => {
    setTab(id);
    const url = new URL(location.href);
    if (id === MAIN_TAB) url.searchParams.delete('tab');
    else url.searchParams.set('tab', id);
    history.replaceState(null, '', url);
  }, []);

  // The session cookie authenticates the WebSocket; no token needed in the browser.
  const { doc, provider } = useMemo(() => {
    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({ url: collabUrl(), name: pageId, document: doc, token: 'session' });
    return { doc, provider };
  }, [pageId]);

  useEffect(() => {
    const onStatus = ({ status }: { status: string }) => setStatus(status);
    const awareness = provider.awareness!;
    const onAwareness = () => {
      const list: Peer[] = [];
      awareness.getStates().forEach((s) => s.user && list.push({ ...s.user, tab: s.tab ?? MAIN_TAB }));
      setPeers(list);
    };
    const meta = doc.getMap(META);
    const onMeta = () => setTitle(String(meta.get('title') ?? ''));
    provider.on('status', onStatus);
    awareness.on('change', onAwareness);
    meta.observe(onMeta);
    onMeta();
    return () => {
      provider.off('status', onStatus);
      awareness.off('change', onAwareness);
      meta.unobserve(onMeta);
    };
  }, [provider, doc]);

  useEffect(() => () => { provider.destroy(); doc.destroy(); }, [provider, doc]);
  useEffect(() => { provider.setAwarenessField('tab', tab); }, [provider, tab]);
  useEffect(() => { document.title = `${title || 'Untitled'} · Livepage`; }, [title]);

  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">Livepage</Link>
        <span className={`status status-${status}`}>{status}</span>
        {readOnly && <span className="badge">View only</span>}
        <div className="peers">
          {peers.map((p, i) => (
            <span key={i} className="peer" style={{ background: p.color }} title={p.name}>
              {p.kind === 'agent' ? '✦ ' : ''}{p.name}
            </span>
          ))}
        </div>
        {!readOnly && <button type="button" className="ghost" onClick={() => setShowHistory(true)} title="Version history">History</button>}
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
        <TabBar doc={doc} active={tab} onSelect={selectTab} peers={peers} readOnly={readOnly} />
        <PageEditor key={tab} doc={doc} provider={provider} user={user} tab={tab} readOnly={readOnly} />
      </main>
      {sharing && <ShareDialog pageId={pageId} onClose={() => setSharing(false)} />}
      {showHistory && <HistoryPanel pageId={pageId} canRestore={!readOnly} onClose={() => setShowHistory(false)} />}
    </div>
  );
}
