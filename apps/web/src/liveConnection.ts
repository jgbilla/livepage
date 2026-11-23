// Getting the live connection back quickly when the app comes back on screen.
//
// A phone suspends the app (and its WebSocket) when it goes to the background or the screen
// locks. When it comes back, the old socket often still looks open but is dead, and the
// provider would only notice after 30 seconds without messages; a socket that did close waits
// out its retry backoff (up to 30 seconds too). Meanwhile edits from your other devices don't
// show up, and yours don't leave. So on coming back (or back online) the connection is redone
// at once, which also resyncs the page with the server.
import type { HocuspocusProvider } from '@hocuspocus/provider';

const AWAY_MS = 5000;

export function reconnectOnWake(provider: HocuspocusProvider): () => void {
  const wsp = provider.configuration.websocketProvider;
  let hiddenAt = document.visibilityState === 'hidden' ? Date.now() : 0;
  let check: ReturnType<typeof setTimeout> | undefined;

  const revive = () => {
    clearTimeout(check);
    if (wsp.status !== 'connected') { void wsp.connect(); return; } // skip the remaining backoff
    const socket = wsp.webSocket;
    try { socket?.close(); } catch { /* already gone */ }
    // A dead socket may never report that it closed: treat it as closed so the provider reconnects.
    check = setTimeout(() => {
      if (wsp.webSocket === socket && wsp.status === 'connected') {
        (wsp as unknown as { emit: (e: string, a: unknown) => void }).emit('close', { event: { code: 4408, reason: 'resumed' } });
      }
    }, 2000);
  };

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt >= AWAY_MS) revive();
    hiddenAt = 0;
  };
  const onPageShow = (e: PageTransitionEvent) => { if (e.persisted) revive(); };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', revive);
  window.addEventListener('pageshow', onPageShow);
  return () => {
    clearTimeout(check);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('online', revive);
    window.removeEventListener('pageshow', onPageShow);
  };
}
