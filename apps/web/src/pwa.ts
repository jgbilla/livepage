// Installed-app support (PWA). Registers the service worker (apps/web/pwa/sw.js, built by
// vite.config.ts), says when a new version is ready, and knows whether to suggest installing.
// The service worker only runs in production builds; `pnpm dev` never registers it.
import { useSyncExternalStore } from 'react';

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
type State = { updateReady: boolean; online: boolean; install: InstallEvent | null };

let state: State = { updateReady: false, online: typeof navigator === 'undefined' ? true : navigator.onLine, install: null };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => { state = { ...state, ...patch }; listeners.forEach((l) => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export const usePwa = () => useSyncExternalStore(subscribe, () => state);
/** False when the device has no network. Live sync keeps retrying; edits stay in this browser meanwhile. */
export const useOnline = () => usePwa().online;

/** Running from the home screen or as an installed desktop app, not in a browser tab. */
export const isStandalone = () =>
  matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** iPhone or iPad (iPadOS reports itself as a Mac with a touch screen). */
export const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function startPwa() {
  addEventListener('online', () => set({ online: true }));
  addEventListener('offline', () => set({ online: false }));
  // Chrome, Edge and Android offer installing; keep the offer so our own button can show it.
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); set({ install: e as InstallEvent }); });
  addEventListener('appinstalled', () => set({ install: null }));

  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  // On the very first visit the app's data was fetched before the worker took over, so nothing
  // is saved for offline yet. Ask again once it is in charge, so the next launch works offline.
  if (!navigator.serviceWorker.controller) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      const page = location.pathname.match(/^\/p\/([\w-]+)/);
      for (const path of ['/config', '/me', '/pages', ...(page ? [`/pages/${page[1]}`] : [])]) {
        void fetch(`/api${path}`, { credentials: 'same-origin' }).catch(() => {});
      }
    }, { once: true });
  }
  const register = () => navigator.serviceWorker.register('/sw.js').then((reg) => {
    const ready = () => { if (navigator.serviceWorker.controller) set({ updateReady: true }); };
    if (reg.waiting) ready();
    reg.addEventListener('updatefound', () => {
      const next = reg.installing;
      next?.addEventListener('statechange', () => { if (next.state === 'installed') ready(); });
    });
    // An installed app can stay open for days: look for a new version whenever it comes back to
    // the front, and every half hour while it is in use.
    const check = () => { if (document.visibilityState === 'visible' && navigator.onLine) reg.update().catch(() => {}); };
    document.addEventListener('visibilitychange', check);
    setInterval(check, 30 * 60_000);
  }).catch(() => { /* blocked (private mode, old browser): the app works as a normal web page */ });
  // After the page has loaded, so caching the app never competes with the first screen.
  if (document.readyState === 'complete') void register();
  else addEventListener('load', () => void register(), { once: true });
}

/** Switch to the new version: the waiting service worker takes over, then the app reloads. */
export async function applyUpdate() {
  const reg = await navigator.serviceWorker?.getRegistration();
  if (!reg?.waiting) { location.reload(); return; }
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
  reg.waiting.postMessage({ type: 'SKIP_WAITING' });
}

export const dismissUpdate = () => set({ updateReady: false });

/** Show the browser's own install dialog (Chrome, Edge, Android). */
export async function promptInstall() {
  const e = state.install;
  if (!e) return;
  set({ install: null }); // each offer can be used once
  await e.prompt().catch(() => {});
}

const HINT_KEY = 'lp.installHint';
export function installHintDismissed() {
  try { return localStorage.getItem(HINT_KEY) === 'dismissed'; } catch { return true; }
}
export function dismissInstallHint() {
  try { localStorage.setItem(HINT_KEY, 'dismissed'); } catch { /* storage blocked */ }
}
