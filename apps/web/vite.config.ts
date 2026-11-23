import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { splashLinks } from './pwa/devices.mjs';

// Installable app (PWA): links the iOS launch screens into index.html and, after a production
// build, writes dist/sw.js with the list of files to keep offline and a version taken from their
// contents, so every deploy that changes the app gives the browser a new service worker.
function pwa(): Plugin {
  let outDir = 'dist';
  return {
    name: 'livepage-pwa',
    configResolved(c) { outDir = resolve(c.root, c.build.outDir); },
    transformIndexHtml: (html) => html.replace('<!-- pwa:splash -->', splashLinks()),
    writeBundle() {
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else files.push('/' + relative(outDir, full).split('\\').join('/'));
        }
      };
      walk(outDir);
      // Not kept offline: source maps, the build manifest, the worker itself, and the launch
      // screens (iOS reads those once, when the app is added to the home screen).
      const precache = files.filter((f) => !/\.map$|^\/\.vite\/|^\/sw\.js$|^\/splash\//.test(f)).sort();
      const hash = createHash('sha256');
      for (const f of precache) hash.update(f).update(readFileSync(join(outDir, f)));
      const sw = readFileSync(new URL('./pwa/sw.js', import.meta.url), 'utf8')
        .replace('__LP_VERSION__', hash.digest('hex').slice(0, 12))
        .replace('__LP_PRECACHE__', JSON.stringify(precache));
      writeFileSync(join(outDir, 'sw.js'), sw);
    },
  };
}

// In development the app, API and live sync share one origin (localhost:5173) through this
// proxy, exactly like production where the server serves everything. That keeps the session
// cookie first-party and the code paths identical.
const server = process.env.LIVEPAGE_SERVER ?? 'http://localhost:1234';

export default defineConfig({
  plugins: [react(), pwa()],
  envDir: '../..',
  // lowlight and the code block pull different highlight.js versions; one copy saves ~75 KB.
  resolve: { dedupe: ['highlight.js'] },
  build: {
    target: 'es2022',
    manifest: true, // lets the server send preload hints for the editor on page URLs (apps/server/src/static.ts)
    rollupOptions: {
      output: {
        // Split big, rarely-changing libraries into their own files so a deploy that only
        // touches app code keeps them cached in the browser, and screens that don't edit
        // (home, lists) never download the editor.
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (/node_modules\/(\.pnpm\/)?(react|react-dom|scheduler)[@/]/.test(id)) return 'react';
          if (/(prosemirror|@tiptap|linkifyjs|orderedmap|rope-sequence|w3c-keyname|fast-equals)/.test(id)) return 'editor';
          if (/(yjs|y-protocols|y-indexeddb|lib0|@hocuspocus)/.test(id)) return 'sync';
          if (/(highlight\.js|lowlight|devlop)/.test(id)) return 'highlight';
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: server, changeOrigin: false },
      '/mcp': { target: server, changeOrigin: false },
      '/pub': { target: server, changeOrigin: false }, // published pages
      '/collab': { target: server.replace(/^http/, 'ws'), ws: true, changeOrigin: false },
    },
  },
  preview: { port: 5173, strictPort: true },
});
