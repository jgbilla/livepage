import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { WorkspaceTabs } from './WorkspaceTabs';
import { api, ApiError, type Me } from './api';
import { loadConfig } from './config';
import { navigate, useLocation } from './router';
import { AuthScreen } from './screens/AuthScreen';
import { HomeScreen } from './screens/HomeScreen';
import { ShareScreen } from './screens/ShareScreen';
import { NeonCallbackScreen } from './screens/NeonCallbackScreen';
import { neonSignOut } from './neonAuth';
import { Layout } from './Sidebar';
import { ListScreen } from './screens/ListScreen';
import { loadPageScreen } from './preload';
import { clearLocalPages } from './offline';
import { BootSkeleton, PageSkeleton } from './Skeleton';
import { hydrateWorkspace, resetWorkspace } from './workspace';
import { resetWorkspaceLinks } from './workspaceLinks';
import { resetTasks } from './tasks';

// The editor (and the graph) are big; they load on their own so the first screen is light.
const PageScreen = lazy(() => loadPageScreen().then((m) => ({ default: m.PageScreen })));
const GraphScreen = lazy(() => import('./screens/GraphScreen').then((m) => ({ default: m.GraphScreen })));
const TasksScreen = lazy(() => import('./screens/TasksScreen').then((m) => ({ default: m.TasksScreen })));

export function App() {
  const { path } = useLocation();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [ready, setReady] = useState(false);
  // One open tab's screen. Each tab has its own path, so this takes it instead of reading the URL bar.
  const screenFor = useCallback((p: string) => {
    if (!me) return null;
    const page = p.match(/^\/p\/([\w-]+)/);
    const tag = p.match(/^\/tag\/(.+)$/);
    const view = p.match(/^\/view\/([\w-]+)/);
    return (
      <Suspense fallback={<PageSkeleton />}>
        {page ? <PageScreen key={page[1]} pageId={page[1]} me={me} />
          : tag ? <ListScreen key={tag[1]} tag={decodeURIComponent(tag[1])} />
          : view ? <ListScreen key={view[1]} viewId={view[1]} />
          : p === '/graph' ? <GraphScreen />
          : p === '/tasks' ? <TasksScreen />
          : <HomeScreen me={me} />}
      </Suspense>
    );
  }, [me]);

  const refreshMe = useCallback(async () => {
    try { setMe((await api<{ user: Me | null }>('/me')).user); }
    catch (e) { if (e instanceof ApiError && e.status === 401) setMe(null); else throw e; }
  }, []);

  useEffect(() => { Promise.all([loadConfig(), refreshMe()]).then(() => setReady(true)); }, [refreshMe]);

  if (!ready || me === undefined) return <BootSkeleton />;

  if (path === '/auth/callback') return <NeonCallbackScreen onSignedIn={refreshMe} />;

  if (me) hydrateWorkspace(me.id);
  if (!me) {
    // Remember where they were going (a page or a share link) and come back after signing in.
    return <AuthScreen onSignedIn={async () => { await refreshMe(); if (path === '/login') navigate('/', true); }} />;
  }

  const logout = async () => { await api('/auth/logout', { body: {} }); await neonSignOut(); await clearLocalPages(); resetWorkspace(); resetWorkspaceLinks(); resetTasks(); setMe(null); navigate('/login', true); };

  const share = path.match(/^\/s\/([\w-]+)/);
  if (share) return <ShareScreen token={share[1]} />;
  return (
    <Layout me={me} onLogout={logout}>
      <WorkspaceTabs key={me.id} me={me} screenFor={screenFor} />
    </Layout>
  );
}
