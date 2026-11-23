import { useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { COLLAB_URL } from './config';
import { getIdentity, saveIdentity, type Identity } from './identity';
import { PageEditor } from './editor/PageEditor';

function pageIdFromUrl(): string {
  const p = new URLSearchParams(location.search).get('page');
  return p && /^[\w.-]{1,128}$/.test(p) ? p : 'welcome';
}

type Peer = { name: string; color: string; kind?: string };

export function App() {
  const pageId = pageIdFromUrl();
  const [me, setMe] = useState<Identity>(getIdentity);
  const [status, setStatus] = useState('connecting');
  const [peers, setPeers] = useState<Peer[]>([]);

  const { doc, provider } = useMemo(() => {
    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({ url: COLLAB_URL, name: pageId, document: doc, token: me.id });
    return { doc, provider };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);

  useEffect(() => {
    const onStatus = ({ status }: { status: string }) => setStatus(status);
    const awareness = provider.awareness!;
    const onAwareness = () => {
      const list: Peer[] = [];
      awareness.getStates().forEach((s) => s.user && list.push(s.user));
      setPeers(list);
    };
    provider.on('status', onStatus);
    awareness.on('change', onAwareness);
    return () => {
      provider.off('status', onStatus);
      awareness.off('change', onAwareness);
    };
  }, [provider]);

  useEffect(() => () => { provider.destroy(); doc.destroy(); }, [provider, doc]);

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">Livepage</span>
        <span className="page-name">/{pageId}</span>
        <span className={`status status-${status}`}>{status}</span>
        <div className="peers">
          {peers.map((p, i) => (
            <span key={i} className="peer" style={{ background: p.color }} title={p.name}>
              {p.kind === 'agent' ? '✦ ' : ''}{p.name}
            </span>
          ))}
        </div>
        <input
          className="name-input"
          value={me.name}
          aria-label="Your display name"
          onChange={(e) => { const next = { ...me, name: e.target.value }; setMe(next); saveIdentity(next); }}
        />
      </header>
      <main className="page">
        <PageEditor doc={doc} provider={provider} me={me} />
      </main>
    </div>
  );
}
