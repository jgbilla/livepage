// Serves the built web app (apps/web/dist) in production, with an SPA fallback to index.html.
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.map': 'application/json',
};

export function staticHandler(root: string, sandboxUrl: string, neonAuthOrigin: string | null = null) {
  // The app page itself: no inline scripts, frames only from the sandbox origin.
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    `connect-src 'self'${neonAuthOrigin ? ` ${neonAuthOrigin}` : ''}`, // 'self' includes ws(s):// to this host
    `frame-src ${sandboxUrl}${neonAuthOrigin ? ` ${neonAuthOrigin}` : ''}`, // Neon Auth may use an iframe for OAuth
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const safe = normalize(path).replace(/^(\.\.[/\\])+/, '');
    let file = join(root, safe);
    if (!file.startsWith(root)) return false;
    let isAsset = true;
    try {
      if (!(await stat(file)).isFile()) throw new Error();
    } catch {
      file = join(root, 'index.html'); // client-side routes: /p/..., /s/..., /login
      isAsset = false;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': isAsset && safe.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        'Content-Security-Policy': csp,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return true;
    } catch {
      return false;
    }
  };
}
