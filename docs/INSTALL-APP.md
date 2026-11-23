# Livepage as an app

Livepage installs as an app from the browser (a Progressive Web App). No app store is involved.

## Install it

- **iPhone and iPad:** open your Livepage site in Safari, tap **Share**, then **Add to Home Screen**. (Chrome and other browsers on iOS 16.4+ offer the same thing from their Share menu.) Livepage shows a small card with these steps on the home and sign-in screens until you close it.
- **Android, Chrome, Edge (desktop):** use the browser's **Install** button in the address bar, or the **Install** button on Livepage's card.
- **Mac Safari:** File > **Add to Dock**.

On iPhone and iPad the home screen app keeps its own storage, separate from Safari, so you sign in once more inside the app.

## What you get

- Opens full screen from the home screen, with its own icon and launch screen (light and dark).
- **Starts instantly and works offline.** The app's code is kept on the device. Pages you have opened before open with no network, and you can keep writing: edits are kept on the device and sync when you are back online (the page's status shows "offline" meanwhile). Pages you have never opened, search, comments, Ask AI and sharing need a connection.
- **Updates itself.** When a new version is deployed, the app shows "A new version of Livepage is ready" with a Reload button, instead of changing under you mid-sentence. It checks whenever it comes back to the front and every half hour.
- Signing out removes the offline copies from the device.

## How it works (for developers)

| Piece | Where |
| --- | --- |
| Web app manifest | `apps/web/public/manifest.webmanifest` |
| Icons, apple-touch-icon, iOS launch screens | `apps/web/public/icons/`, `apps/web/public/splash/`, drawn by `node scripts/make-app-icons.mjs` from the Livepage mark; device list in `apps/web/pwa/devices.mjs` |
| Service worker | `apps/web/pwa/sw.js`; `vite.config.ts` writes it to `dist/sw.js` with the list of built files and a version taken from their contents |
| Registration, update prompt, install hint | `apps/web/src/pwa.ts`, `apps/web/src/PwaPrompts.tsx` |
| iOS meta tags, `viewport-fit=cover` | `apps/web/index.html`; safe-area padding at the end of `styles.css` |

What the service worker caches, and what it never touches:

- **App shell** (index.html, scripts, styles, icons): cached when a version installs; every app URL opens from it.
- **`/api/config`, `/api/me`, `/api/pages`, `/api/pages/:id`:** network first; the last good answer when offline or when the server takes over 4 seconds (Render free plan waking up), so the app still opens at once. Deleted on sign-out.
- **Page content:** not the service worker's job. The editor already keeps opened pages in IndexedDB (`src/offline.ts`) and merges them with the server through Yjs.
- **Never cached:** live sync (`/collab`), every other `/api` call, `/mcp`, published pages (`/pub`), and anything on another origin (the HTML block sandbox, Neon Auth, Google sign-in).

The service worker only runs in production builds. `pnpm dev` never registers it. To test it locally: `pnpm build`, then run the server (`LIVEPAGE_MEMORY_STORE=1 pnpm --filter @livepage/server dev`) and `npx vite preview` in `apps/web` (it proxies `/api` and `/collab` like the dev server).

**Sign-in in the installed app.** Email and password are plain requests. "Continue with Google" is a full-page redirect to Neon Auth and Google and back to `/auth/callback`. iOS shows those outside pages inside the app's window with a small browser bar, then returns to the app. Neon Auth only uses a popup when the app runs in an iframe, which an installed app never does.

**Turning it off.** A deployed service worker keeps running until a new one replaces it, so do not just delete `sw.js`. To retire it, deploy a `sw.js` that calls `self.registration.unregister()` and deletes the `lp-` caches.

## A native App Store app (not built)

The installed web app covers what Livepage needs today. If an App Store listing becomes worth it, this is what it takes:

- **Wrapper:** [Capacitor](https://capacitorjs.com) (MIT) is the simplest route. It puts this same web app in a native iOS shell (WKWebView). Either bundle the built `apps/web/dist` into the app and point `/api` and `/collab` at the hosted server (then allow that origin in the server's CORS and cookie settings, since the app's own origin becomes `capacitor://localhost`), or load the hosted site directly (simpler, but Apple pushes back on apps that are only a website).
- **Sign-in:** Google blocks OAuth inside embedded web views. Use the system browser sheet (`ASWebAuthenticationSession`, via a Capacitor plugin) with a custom URL scheme or universal link for the callback, then hand the token to `/api/auth/neon` as today. Session cookies across origins need care; a bearer token stored in the iOS Keychain is the usual fix.
- **Sandbox:** HTML blocks keep working as long as the sandbox origin stays a separate https origin; WKWebView supports cross-origin iframes.
- **Native extras worth the effort:** push notifications for @mentions (APNs; also possible for home screen web apps since iOS 16.4 via Web Push), a Share extension ("save to Livepage"), and widgets.
- **Apple account and review:** Apple Developer Program, $99 a year. Needs a Mac with Xcode to build and sign, App Store screenshots, a privacy policy URL, and the privacy "nutrition label". Review usually takes 1 to 3 days, and is repeated for every native update (web changes inside a wrapper that loads the hosted site ship without review). Apple's guideline 4.2 rejects apps that are "just a website", so the app should add something native (offline, share extension, notifications).
- **Rough effort:** a working Capacitor build in a few days; sign-in, push and store polish take one to two weeks more.
