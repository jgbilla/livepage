import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Me } from './api';
import { loadConfig } from './config';
import { navigate, useLocation } from './router';
import { AuthScreen } from './screens/AuthScreen';
import { HomeScreen } from './screens/HomeScreen';
import { PageScreen } from './screens/PageScreen';
import { ShareScreen } from './screens/ShareScreen';
import { NeonCallbackScreen } from './screens/NeonCallbackScreen';
import { neonSignOut } from './neonAuth';
import { Layout } from './Sidebar';
import { ListScreen } from './screens/ListScreen';

export function App() {
  const { path } = useLocation();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [ready, setReady] = useState(false);

  const refreshMe = useCallback(async () => {
    try { setMe((await api<{ user: Me | null }>('/me')).user); }
    catch (e) { if (e instanceof ApiError && e.status === 401) setMe(null); else throw e; }
  }, []);

  useEffect(() => { Promise.all([loadConfig(), refreshMe()]).then(() => setReady(true)); }, [refreshMe]);

  if (!ready || me === undefined) return <div className="center muted">Loading…</div>;

  if (path === '/auth/callback') return <NeonCallbackScreen onSignedIn={refreshMe} />;

  if (!me) {
    // Remember where they were going (a page or a share link) and come back after signing in.
    return <AuthScreen onSignedIn={async () => { await refreshMe(); if (path === '/login') navigate('/', true); }} />;
  }

  const logout = async () => { await api('/auth/logout', { body: {} }); await neonSignOut(); setMe(null); navigate('/login', true); };

  const share = path.match(/^\/s\/([\w-]+)/);
  if (share) return <ShareScreen token={share[1]} />;
  const page = path.match(/^\/p\/([\w-]+)/);
  const tag = path.match(/^\/tag\/(.+)$/);
  const view = path.match(/^\/view\/([\w-]+)/);
  return (
    <Layout me={me} onLogout={logout}>
      {page ? <PageScreen key={page[1]} pageId={page[1]} me={me} />
        : tag ? <ListScreen key={tag[1]} tag={decodeURIComponent(tag[1])} />
        : view ? <ListScreen key={view[1]} viewId={view[1]} />
        : <HomeScreen me={me} />}
    </Layout>
  );
}
