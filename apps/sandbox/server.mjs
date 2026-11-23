// The sandbox origin. HTML blocks run here, never on the app origin.
// It serves one page (runner.html) with a strict Content-Security-Policy.
// The app embeds it as <iframe sandbox="allow-scripts"> (no allow-same-origin),
// so block code gets an opaque origin: no cookies, no storage, no access to the app.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const port = Number(process.env.SANDBOX_PORT ?? 5174);
// Which pages may embed the sandbox. Space-separated origins.
const frameAncestors = process.env.SANDBOX_FRAME_ANCESTORS ?? 'http://localhost:5173 http://127.0.0.1:5173';
// CDNs block code may load libraries from (GSAP, three.js, d3...).
const scriptHosts = process.env.SANDBOX_SCRIPT_HOSTS ?? 'https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com';

const csp = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' ${scriptHosts}`,
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com data:',
  'img-src data: blob: https:',
  'media-src data: blob: https:',
  // No fetch/XHR/WebSocket: block code cannot phone home with page content.
  "connect-src 'none'",
  "form-action 'none'",
  `frame-ancestors ${frameAncestors}`,
].join('; ');

const runner = await readFile(new URL('./public/runner.html', import.meta.url));

createServer((req, res) => {
  if (req.url === '/' || req.url?.startsWith('/runner.html')) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-cache',
    });
    res.end(runner);
    return;
  }
  res.writeHead(404).end();
}).listen(port, () => console.log(`[sandbox] http://localhost:${port}`));
