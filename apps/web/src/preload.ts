// Starts downloads and requests as early as possible, side by side, instead of one after another.
import { prefetch } from './api';

let pageScreen: Promise<typeof import('./screens/PageScreen')> | null = null;
/** The editor screen's code. Asked for once; later calls share the same download. */
export const loadPageScreen = () => (pageScreen ??= import('./screens/PageScreen'));

/** Called before React renders: everything the first screen will need, all at once. */
export function preloadForLocation() {
  prefetch('/config');
  prefetch('/me');
  const path = location.pathname;
  if (path === '/login' || path.startsWith('/auth/') || path.startsWith('/s/')) return;
  prefetch('/pages'); // sidebar and home list
  const page = path.match(/^\/p\/([\w-]+)/);
  if (page) {
    prefetch(`/pages/${page[1]}`);
    void loadPageScreen();
  } else {
    // Not on a page yet, but the next click probably opens one: fetch the editor when the browser is idle.
    const idle = (window as any).requestIdleCallback ?? ((f: () => void) => setTimeout(f, 1500));
    idle(() => void loadPageScreen().catch(() => {}), { timeout: 4000 });
  }
}
