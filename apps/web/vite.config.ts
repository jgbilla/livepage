import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the app, API and live sync share one origin (localhost:5173) through this
// proxy, exactly like production where the server serves everything. That keeps the session
// cookie first-party and the code paths identical.
const server = process.env.LIVEPAGE_SERVER ?? 'http://localhost:1234';

export default defineConfig({
  plugins: [react()],
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
