// Serves the built web app (apps/web/dist) in production, with an SPA fallback to index.html.
// Files are read once, compressed once (Brotli and gzip) and kept in memory, so each request
// is a lookup: no disk reads and no per-request compression.
import { readFile, stat } from 'node:fs/promises';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.map': 'application/json',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json', '.map', '.webmanifest', '.txt', '.ico']);

type Entry = { type: string; etag: string; raw: Buffer; br?: Buffer; gz?: Buffer };

async function load(file: string): Promise<Entry> {
  const raw = await readFile(file);
  const ext = extname(file);
  const entry: Entry = { type: TYPES[ext] ?? 'application/octet-stream', etag: `"${createHash('sha1').update(raw).digest('base64url').slice(0, 20)}"`, raw };
  if (COMPRESSIBLE.has(ext) && raw.length > 1024) {
    entry.br = brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
    entry.gz = gzipSync(raw, { level: 9 });
  }
  return entry;
}

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

  const cache = new Map<string, Promise<Entry | null>>();
  const entryFor = (file: string) => {
    const hit = cache.get(file);
    if (hit) return hit;
    // Only files that exist are kept; client routes (/p/...) and typos are not, so the map stays small.
    const next = stat(file).then((s) => (s.isFile() ? load(file) : null)).catch(() => null);
    cache.set(file, next);
    void next.then((e) => { if (!e) cache.delete(file); });
    return next;
  };
  // Warm the shell so the first visitor after a (cold) start doesn't wait on compression.
  void entryFor(join(root, 'index.html'));

  // On a page URL the browser will need the editor. Tell it in the response headers, so those
  // files download alongside the app's first script instead of after it has run.
  let editorHints: string | null = null;
  void readFile(join(root, '.vite', 'manifest.json'), 'utf8').then((text) => {
    const manifest = JSON.parse(text) as Record<string, { file: string; imports?: string[] }>;
    const files = new Set<string>();
    const walk = (key: string) => {
      const chunk = manifest[key];
      if (!chunk || key === 'index.html' || files.has(chunk.file)) return;
      files.add(chunk.file);
      chunk.imports?.forEach(walk);
    };
    walk('src/screens/PageScreen.tsx');
    for (const f of files) void entryFor(join(root, f)); // compress these ahead of the first request
    editorHints = [...files].map((f) => `</${f}>; rel=modulepreload; crossorigin`).join(', ') || null;
  }).catch(() => { /* no manifest (older build): pages still work, just without the hints */ });

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let path: string;
    try { path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname); } catch { return false; }
    const safe = normalize(path).replace(/^(\.\.[/\\])+/, '');
    const file = join(root, safe);
    if (!file.startsWith(root)) return false;
    const isAsset = safe.startsWith('/assets/');
    let entry = safe === '/' ? null : await entryFor(file);
    if (!entry) {
      // A hashed asset that is gone (an old tab after a deploy) must 404, not get index.html as JS.
      if (isAsset) { res.writeHead(404, { 'Cache-Control': 'no-store' }).end(); return true; }
      entry = await entryFor(join(root, 'index.html')); // client-side routes: /p/..., /s/..., /login
      if (!entry) return false;
    }
    const headers: Record<string, string> = {
      'Content-Type': entry.type,
      'Cache-Control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
      ETag: entry.etag,
      Vary: 'Accept-Encoding',
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    };
    if (!isAsset && editorHints && path.startsWith('/p/')) headers.Link = editorHints;
    if (req.headers['if-none-match'] === entry.etag) { res.writeHead(304, headers).end(); return true; }
    const accept = String(req.headers['accept-encoding'] ?? '');
    let body = entry.raw;
    if (entry.br && /\bbr\b/.test(accept)) { body = entry.br; headers['Content-Encoding'] = 'br'; }
    else if (entry.gz && /\bgzip\b/.test(accept)) { body = entry.gz; headers['Content-Encoding'] = 'gzip'; }
    headers['Content-Length'] = String(body.length);
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  };
}
