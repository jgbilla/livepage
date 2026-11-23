import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the app, API and live sync share one origin (localhost:5173) through this
// proxy, exactly like production where the server serves everything. That keeps the session
// cookie first-party and the code paths identical.
const server = process.env.LIVEPAGE_SERVER ?? 'http://localhost:1234';

export default defineConfig({
  plugins: [react()],
  envDir: '../..',
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: server, changeOrigin: false },
      '/mcp': { target: server, changeOrigin: false },
      '/collab': { target: server.replace(/^http/, 'ws'), ws: true, changeOrigin: false },
    },
  },
  preview: { port: 5173, strictPort: true },
});
