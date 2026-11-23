// Publishing: a page's owner can put it on the web at /pub/<slug>, readable by anyone without
// an account. The public page is plain server-rendered HTML (no editor, no app code, no
// session), rendered from the live document on every request, so it always shows the latest
// version. HTML blocks still run, in the same separate-origin sandbox as in the app.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Hocuspocus } from '@hocuspocus/server';
import { randomBytes } from 'node:crypto';
import { escapeHtml, pageToHtml, MAIN_TAB, type LinkTarget } from '@livepage/schema';
import type { Db } from './db.ts';
import { readDoc } from './docs.ts';
import { config } from './config.ts';

const slugify = (title: string) =>
  (title || 'page').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'page';

/** Publish (or keep published) and return the slug. The slug never changes once set, so shared links keep working. */
export async function publishPage(db: Db, pageId: string): Promise<string> {
  const [p] = await db.query('select title, published_slug from pages where id = $1', [pageId]);
  if (p?.published_slug) return p.published_slug;
  const slug = `${slugify(p?.title ?? '')}-${randomBytes(4).toString('hex')}`;
  await db.query('update pages set published_slug = $2, published_at = now() where id = $1', [pageId, slug]);
  return slug;
}

export async function unpublishPage(db: Db, pageId: string): Promise<void> {
  await db.query('update pages set published_slug = null, published_at = null where id = $1', [pageId]);
}

export const isPubPath = (url: string | undefined) => /^\/pub\//.test(url ?? '');

const PUB_JS = `// Starts each HTML block of a published page in the sandbox (see apps/server/src/publish.ts).
(function () {
  var data = JSON.parse(document.getElementById('lp-blocks').textContent || '{}');
  var sandbox = data.sandbox;
  document.querySelectorAll('.html-block[data-block]').forEach(function (holder) {
    var b = data.blocks[holder.getAttribute('data-block')];
    if (!b) return;
    var frame = document.createElement('iframe');
    frame.src = sandbox + '/runner.html';
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('loading', 'lazy');
    frame.title = b.title || 'Live block';
    frame.style.height = b.height + 'px';
    holder.appendChild(frame);
    addEventListener('message', function (e) {
      if (e.source !== frame.contentWindow || !e.data || typeof e.data !== 'object') return;
      if (e.data.type === 'livepage:ready') frame.contentWindow.postMessage({ type: 'livepage:render', code: b.code }, '*');
      if (e.data.type === 'livepage:height') frame.style.height = Math.max(40, Math.min(2000, Number(e.data.height) || 0)) + 'px';
      // livepage:action is ignored: a public reader cannot send anything to the page.
    });
  });
  // Tabs: show one at a time (without JavaScript every tab is shown, one after another).
  var tabs = document.querySelectorAll('.tabs a');
  if (!tabs.length) return;
  function show(id) {
    document.querySelectorAll('.tab').forEach(function (t) { t.hidden = t.id !== 'tab-' + id; });
    tabs.forEach(function (a) { a.classList.toggle('on', a.getAttribute('href') === '#tab-' + id); });
  }
  tabs.forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); var id = a.getAttribute('href').slice(5); history.replaceState(null, '', '#tab-' + id); show(id); }); });
  var want = location.hash.indexOf('#tab-') === 0 ? location.hash.slice(5) : tabs[0].getAttribute('href').slice(5);
  show(document.getElementById('tab-' + want) ? want : tabs[0].getAttribute('href').slice(5));
})();
`;

// Reading mode of the Livepage design language (DESIGN.md): serif prose, sans headings and chrome,
// the same paper neutrals, accent and radii as the app (values from apps/web/src/design/tokens.css).
const CSS = `
:root{color-scheme:light;--fg:#1f1d1a;--muted:#5f5a52;--faint:#8a857c;--line:#e7e4de;--bg:#fcfbf9;--accent:#2a52c2;--accent-soft:rgb(47 91 211/.10);--code:#f2f0ec;--surface:#fff;
--sans:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI Variable Text","Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
--serif:"Iowan Old Style","Palatino Linotype",Palatino,Charter,"Bitstream Charter","Source Serif Pro",Georgia,serif;
--mono:ui-monospace,"SF Mono",SFMono-Regular,"JetBrains Mono",Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--fg:#ecebe7;--muted:#b0aba2;--faint:#8a857d;--line:#302e2b;--bg:#161514;--accent:#92aeff;--accent-soft:rgb(123 156 255/.14);--code:#1d1c1a;--surface:#201f1d}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:18px/1.72 var(--serif);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
::selection{background:var(--accent-soft)}
main{max-width:720px;margin:0 auto;padding:72px 24px 96px}
h1.title{font:700 clamp(2rem,6vw,2.6rem)/1.15 var(--sans);margin:0 0 10px;letter-spacing:-.022em}
.byline{color:var(--faint);font:14px var(--sans);margin-bottom:40px}
h1,h2,h3,h4{font-family:var(--sans);font-weight:600;line-height:1.25;letter-spacing:-.015em;margin:1.8em 0 .5em}
h2{font-size:1.4rem}h3{font-size:1.15rem}
a{color:var(--accent);text-decoration-color:color-mix(in srgb,currentColor 35%,transparent);text-underline-offset:3px}a:hover{text-decoration-color:currentColor}
p{margin:.75em 0}img{max-width:100%;border-radius:8px}li::marker{color:var(--faint)}
blockquote{margin:1.2em 0;padding:0 0 0 1em;border-left:3px solid var(--line);color:var(--muted)}
pre{background:var(--code);padding:14px 16px;border:1px solid var(--line);border-radius:12px;overflow:auto;font-size:14px;line-height:1.6}
code{font:0.85em var(--mono);background:var(--code);padding:.12em .35em;border-radius:4px}pre code{background:none;padding:0;font-size:inherit}
.table{overflow-x:auto}table{border-collapse:separate;border-spacing:0;margin:1.2em 0;font:15px/1.5 var(--sans);border:1px solid var(--line);border-radius:8px;overflow:hidden;width:100%}
th,td{border-right:1px solid var(--line);border-bottom:1px solid var(--line);padding:8px 12px;text-align:left;vertical-align:top}tr>:last-child{border-right:0}tr:last-child>*{border-bottom:0}th{background:var(--code);font-weight:600}td p,th p{margin:0}
hr{border:0;border-top:1px solid var(--line);margin:2.4em 0}
.html-block{margin:1.4em 0}.html-block iframe{display:block;width:100%;border:0;border-radius:12px;background:transparent}
.mind-map{margin:1.4em 0;padding:14px 18px;border:1px solid var(--line);border-radius:12px;background:var(--surface);font:15px/1.55 var(--sans)}.mind-map figcaption{font-weight:600;margin-bottom:4px}
.page-link{color:var(--accent);background:var(--accent-soft);border-radius:4px;padding:0 4px;text-decoration:none;font:.9em var(--sans);font-weight:500}.page-link.off{color:var(--muted);background:none;border-bottom:1px dotted var(--faint);border-radius:0}
sup.fnref a{text-decoration:none;font:600 .7em var(--sans);padding:0 1px}
.footnotes{margin-top:3em;padding-top:1em;border-top:1px solid var(--line);font:15px/1.6 var(--sans);color:var(--muted)}.footnotes a.back{text-decoration:none}
.tabs{display:flex;gap:4px;flex-wrap:wrap;border-bottom:1px solid var(--line);margin:0 0 28px;font:500 14px var(--sans)}
.tabs a{padding:8px 12px;color:var(--muted);text-decoration:none;border-bottom:2px solid transparent;margin-bottom:-1px}.tabs a:hover{color:var(--fg)}.tabs a.on{color:var(--fg);border-color:var(--fg);font-weight:600}
.tab>h2.tab-title{display:none}
footer{margin-top:72px;padding-top:20px;border-top:1px solid var(--line);color:var(--faint);font:13px var(--sans);display:flex;align-items:center;gap:8px}
footer .mark{width:16px;height:16px;border-radius:5px;background:var(--fg);position:relative;display:inline-block}footer .mark::after{content:'';position:absolute;right:3px;top:3px;width:5px;height:5px;border-radius:1.5px;background:linear-gradient(135deg,#8b6cf6,#5741b8)}
@media print{.tabs{display:none}.tab[hidden]{display:block!important}.tab>h2.tab-title{display:block}}
`;

function notFound(res: ServerResponse) {
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end('<!doctype html><meta charset="utf-8"><title>Not found</title><p style="font:16px system-ui;padding:40px">This page is not published (or was unpublished).</p>');
}

/** GET /pub/<slug> (the page) and /pub/_/pub.js (its one script). */
export async function handlePub(req: IncomingMessage, res: ServerResponse, db: Db, hp: Hocuspocus): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  if (path === '/pub/_/pub.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' });
    res.end(PUB_JS);
    return;
  }
  const m = path.match(/^\/pub\/([a-z0-9-]{4,80})\/?$/);
  if (!m) return notFound(res);
  const [page] = await db.query(
    `select p.id, p.title, p.updated_at, u.name as owner_name from pages p join users u on u.id = p.owner_id where p.published_slug = $1`, [m[1]],
  );
  if (!page) return notFound(res);
  const doc = await readDoc(hp, db, page.id);

  // Links: to another published page go to its public address; to a private page, only the link's own text shows.
  const targets = new Map<string, string>();
  const ids = new Set<string>();
  const collect = (t: LinkTarget) => ids.add(t.page);
  pageToHtml(doc, { link: (t) => { collect(t); return { href: null, label: '' }; } });
  if (ids.size) {
    const rows = await db.query('select id, published_slug from pages where id = any($1) and published_slug is not null', [[...ids]]);
    rows.forEach((r) => targets.set(r.id, r.published_slug));
  }
  const { tabs, blocks } = pageToHtml(doc, {
    link: (t) => {
      const label = String(t.label || 'a page');
      const slug = targets.get(t.page);
      if (t.page === page.id) return { href: t.tab && t.tab !== MAIN_TAB ? `#tab-${t.tab}` : '#', label };
      return slug ? { href: `/pub/${slug}${t.tab && t.tab !== MAIN_TAB ? `#tab-${t.tab}` : ''}`, label } : { href: null, label };
    },
  });

  const title = String(page.title || 'Untitled');
  const description = (tabs[0]?.html ?? '').replace(/<section class="footnotes">[\s\S]*$/, '').replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  const many = tabs.length > 1;
  const body = many
    ? `<nav class="tabs">${tabs.map((t) => `<a href="#tab-${escapeHtml(t.id)}">${escapeHtml(t.title)}</a>`).join('')}</nav>`
      + tabs.map((t) => `<section class="tab" id="tab-${escapeHtml(t.id)}"><h2 class="tab-title">${escapeHtml(t.title)}</h2>${t.html}</section>`).join('')
    : tabs[0]?.html ?? '';
  const data = JSON.stringify({ sandbox: config.sandboxUrl, blocks: Object.fromEntries(blocks.map((b) => [b.id, b])) }).replace(/</g, '\\u003c');
  const updated = new Date(page.updated_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(description)}">
<meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}">
<style>${CSS}</style></head>
<body><main><article>
<h1 class="title">${escapeHtml(title)}</h1>
<div class="byline">${escapeHtml(String(page.owner_name ?? ''))} · Updated ${escapeHtml(updated)}</div>
${body}
</article><footer><span class="mark" aria-hidden="true"></span>Published with Livepage</footer></main>
<script type="application/json" id="lp-blocks">${data}</script>
<script src="/pub/_/pub.js" defer></script>
</body></html>`;

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Content-Security-Policy': [
      "default-src 'none'", "script-src 'self'", "style-src 'unsafe-inline'", 'img-src https: data:',
      `frame-src ${config.sandboxUrl}`, "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  });
  res.end(req.method === 'HEAD' ? undefined : html);
}
