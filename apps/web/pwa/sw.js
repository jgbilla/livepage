// Livepage service worker: lets the installed app open instantly and work offline.
// vite.config.ts fills in VERSION and PRECACHE at build time and writes this to dist/sw.js.
//
// - The app shell (index.html, scripts, styles, icons) is cached when a version installs, and
//   every app URL opens from that cache. A new deploy installs a new worker in the background;
//   the app then offers "Reload" (see src/pwa.ts) instead of switching under your feet.
// - A few API reads (/api/config, /api/me, /api/pages and /api/pages/:id) go to the network
//   first and fall back to the last good answer when offline or when the server is slow to wake.
//   Page content itself is kept by the editor in IndexedDB (src/offline.ts). Signing out
//   deletes both.
// - Lookups ignore Vary: a proxy or CDN may add Vary: Origin, and module scripts are
//   requested in CORS mode, which would otherwise make every cached file miss.
// - Live sync (/collab), the agent endpoint (/mcp), published pages (/pub) and every other API
//   call never touch the cache. Other origins (the HTML block sandbox, Neon Auth, Google) are
//   not handled here at all.
const VERSION = '__LP_VERSION__';
const PRECACHE = __LP_PRECACHE__;
const SHELL = `lp-shell-${VERSION}`;
const API = 'lp-api';
const CACHED_API = /^\/api\/(config|me|pages|pages\/[\w-]+)$/;
const BYPASS = /^\/(api|collab|mcp|pub)(\/|$)/;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })));
    // The very first install takes over at once; later versions wait until the app says so.
    if (!self.registration.active) await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('lp-shell-') && key !== SHELL) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (CACHED_API.test(url.pathname) && !url.search) return event.respondWith(networkFirst(event));
  if (BYPASS.test(url.pathname) || url.pathname === '/sw.js') return;
  if (req.mode === 'navigate') return event.respondWith(shell(req));
  event.respondWith(cacheFirst(req));
});

// Every app URL (/, /p/..., /s/..., /auth/callback) is the same single-page shell.
async function shell(req) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match('/index.html', { ignoreVary: true });
  if (hit) return hit;
  return fetch(req);
}

async function cacheFirst(req) {
  const hit = await caches.match(req, { cacheName: SHELL, ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  // Hashed build files never change, so ones not precached (rare) are kept once fetched.
  if (res.ok && new URL(req.url).pathname.startsWith('/assets/')) {
    const copy = res.clone();
    void caches.open(SHELL).then((c) => c.put(req, copy));
  }
  return res;
}

// Network first, so the app shows current data. Falls back to the last good answer when the
// network fails, or when the server takes over 4 seconds (a free-plan host waking from sleep):
// the app opens with what it had, and the answer, when it comes, is saved for next time.
async function networkFirst(event) {
  const req = event.request;
  const cache = await caches.open(API);
  const network = fetch(req).then(async (res) => {
    if (res.ok) await cache.put(req, res.clone());
    else if (res.status === 401 || res.status === 403 || res.status === 404) await cache.delete(req);
    return res;
  });
  event.waitUntil(network.catch(() => {})); // keep the worker alive to save a late answer
  const slow = new Promise((resolve) => setTimeout(resolve, 4000, 'slow'));
  try {
    const first = await Promise.race([network, slow]);
    if (first !== 'slow') return first;
    const hit = await cache.match(req, { ignoreVary: true });
    return hit ?? await network;
  } catch (err) {
    const hit = await cache.match(req, { ignoreVary: true });
    if (hit) return hit;
    throw err;
  }
}
