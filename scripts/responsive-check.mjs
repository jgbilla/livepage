// Responsive check: opens every main screen at phone, tablet and desktop sizes, saves a
// screenshot of each, and fails if anything spills past the screen edge.
//
//   pnpm dev:memory                         # in one terminal (throwaway in-memory server)
//   pnpm check:responsive                   # in another; screenshots go to ./responsive-shots
//
// Options (env): LIVEPAGE_BASE (default http://localhost:5173), SHOTS_DIR, ONLY=320,390 (widths),
// SCREENS=page,comments (screen names), NO_SHOTS=1 (assertions only).
//
// What counts as a failure:
//   - the page scrolls sideways (document wider than the viewport), or
//   - a visible element sticks out past the right/left edge and is not inside a container that
//     scrolls sideways on purpose (tab bar, toolbar, code blocks, tables, mind maps), or
//   - the page title is cut off (its text is wider than the title field), or
//   - the top bar wraps onto a second row, or
//   - the same person shows twice in the presence avatars (they have the page open in two tabs).
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = (process.env.LIVEPAGE_BASE ?? 'http://localhost:5173').replace(/\/$/, '');
const OUT = process.env.SHOTS_DIR ?? 'responsive-shots';
const NO_SHOTS = !!process.env.NO_SHOTS;

const VIEWPORTS = [
  { name: '320', width: 320, height: 568, mobile: true },
  { name: '375', width: 375, height: 667, mobile: true },
  { name: '390', width: 390, height: 844, mobile: true },
  { name: '430', width: 430, height: 932, mobile: true },
  { name: '844-landscape', width: 844, height: 390, mobile: true },
  { name: '768', width: 768, height: 1024, mobile: true },
  { name: '1024', width: 1024, height: 768, mobile: false },
  { name: '1180', width: 1180, height: 820, mobile: false },
  { name: '1440', width: 1440, height: 900, mobile: false },
].filter((v) => !process.env.ONLY || process.env.ONLY.split(',').some((w) => v.name.startsWith(w)));

// ---------- seed: a user, a long-titled page with tabs and every block type, a published copy ----------
async function api(path, { cookie, body, method } = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return { json: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}

async function seed() {
  const email = `check-${Date.now()}@example.com`;
  const { cookie } = await api('/auth/signup', { body: { email, name: 'Jean Billa', password: 'responsive-check-1' } });
  const { json: tok } = await api('/tokens', { cookie, body: { name: 'Docs writer' } });
  // The docs page is the richest page we have: a long title, five tabs, code, tables, mind map, HTML blocks.
  const run = spawnSync('pnpm', ['agent:docs'], {
    env: { ...process.env, AGENT_TOKEN: tok.token, LIVEPAGE_URL: BASE.replace(/^http/, 'ws') + '/collab' },
    encoding: 'utf8',
  });
  const id = (run.stdout + run.stderr).match(/writing (p_[\w-]+)/)?.[1];
  if (!id) throw new Error(`could not write the docs page:\n${run.stdout}\n${run.stderr}`);
  const { json: pub } = await api(`/pages/${id}/publish`, { cookie, body: {} });
  await api('/pages', { cookie, body: { title: 'A page with a fairly long name that needs to wrap on phones' } });
  return { cookie, pageId: id, pubUrl: pub.url };
}

// ---------- the screens ----------
const isNarrow = (vp) => vp.width <= 800;
const SCREENS = [
  { name: 'sign-in', auth: false, go: (p) => p.goto(`${BASE}/login`), ready: '.auth-card' },
  { name: 'home', go: (p) => p.goto(`${BASE}/`), ready: '.home' },
  { name: 'page', go: (p, s) => p.goto(`${BASE}/p/${s.pageId}`), ready: '.ProseMirror', twoConnections: true },
  {
    name: 'drawer', go: async (p, s, vp) => {
      await p.goto(`${BASE}/p/${s.pageId}`);
      await p.waitForSelector('.ProseMirror');
      if (isNarrow(vp)) await p.click('.topbar .sidebar-toggle');
    }, ready: '.sidebar',
  },
  {
    name: 'comments', go: async (p, s) => {
      await p.goto(`${BASE}/p/${s.pageId}?comment=`);
    }, ready: '.comments',
  },
  {
    name: 'ask-ai', go: async (p, s) => {
      await p.goto(`${BASE}/p/${s.pageId}`);
      await p.waitForSelector('.ProseMirror');
      await p.click('button.ask-ai');
    }, ready: '.assistant',
  },
  {
    name: 'history', go: async (p, s, vp) => {
      await p.goto(`${BASE}/p/${s.pageId}`);
      await p.waitForSelector('.ProseMirror');
      // When the page column is narrow, History lives in the ⋯ menu.
      if (await p.isVisible('[title="Version history"]')) await p.click('[title="Version history"]');
      else { await p.click('.page-menu > button'); await p.click('.menu >> text=Version history'); }
    }, ready: '.vh',
  },
  {
    name: 'share', go: async (p, s) => {
      await p.goto(`${BASE}/p/${s.pageId}`);
      await p.waitForSelector('.ProseMirror');
      await p.click('.topbar button.primary');
    }, ready: '.modal',
  },
  {
    name: 'page-menu', go: async (p, s) => {
      await p.goto(`${BASE}/p/${s.pageId}`);
      await p.waitForSelector('.ProseMirror');
      await p.click('.page-menu > button');
    }, ready: '.menu',
  },
  {
    name: 'search', go: async (p) => {
      await p.goto(`${BASE}/`);
      await p.waitForSelector('.home');
      await p.keyboard.press('Control+k');
    }, ready: '.switcher',
  },
  { name: 'graph', go: (p) => p.goto(`${BASE}/graph`), ready: '.graph-canvas' },
  { name: 'published', auth: false, go: (p, s) => p.goto(`${BASE}${s.pubUrl}`), ready: 'body' },
].filter((s) => !process.env.SCREENS || process.env.SCREENS.split(',').includes(s.name));

// Runs in the page: list what spills past the viewport.
function measure() {
  const W = document.documentElement.clientWidth;
  const problems = [];
  const docW = document.documentElement.scrollWidth;
  if (docW > W + 1) problems.push(`page scrolls sideways: content is ${docW}px wide in a ${W}px screen`);
  const label = (el) => {
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    const txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30);
    return `${el.tagName.toLowerCase()}${cls}${txt ? ` "${txt}"` : ''}`;
  };
  // An element inside a container that scrolls or clips sideways is fine: that is on purpose.
  const clipped = (el) => {
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const ox = getComputedStyle(a).overflowX;
      if (ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') return true;
    }
    return false;
  };
  const seen = new Set();
  for (const el of document.body.querySelectorAll('*')) {
    if (el.closest('iframe, svg, canvas, .collaboration-carets__caret, .sr-only')) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) continue;
    if ((r.right > W + 1 || r.left < -1) && !clipped(el)) {
      // Report the outermost offender only.
      let top = el;
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        const ar = a.getBoundingClientRect();
        if (ar.right > W + 1 || ar.left < -1) top = a;
      }
      if (seen.has(top)) continue;
      seen.add(top);
      const tr = top.getBoundingClientRect();
      problems.push(`${label(top)} spills past the edge (${Math.round(tr.left)}..${Math.round(tr.right)} of ${W}px)`);
    }
  }
  const names = [...document.querySelectorAll('.topbar .peer[title]')].map((e) => e.getAttribute('title'));
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) problems.push(`"${dup}" shows more than once in the presence avatars`);
  const title = document.querySelector('.page-title-input');
  if (title && title.scrollWidth > title.clientWidth + 2) problems.push(`page title is cut off (${title.scrollWidth}px of text in ${title.clientWidth}px)`);
  const bar = document.querySelector('.topbar');
  if (bar && bar.getBoundingClientRect().height > 64) problems.push(`top bar is ${Math.round(bar.getBoundingClientRect().height)}px tall (wraps onto more rows)`);
  return problems;
}

const browser = await chromium.launch();
const state = await seed();
if (!NO_SHOTS) mkdirSync(OUT, { recursive: true });
const failures = [];
for (const vp of VIEWPORTS) {
  for (const screen of SCREENS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height }, isMobile: vp.mobile, hasTouch: vp.mobile, deviceScaleFactor: vp.mobile ? 2 : 1,
    });
    if (screen.auth !== false) {
      const [k, v] = state.cookie.split('=');
      await ctx.addCookies([{ name: k, value: v, url: BASE }]);
    }
    // The same person in two tabs: presence should still show them once.
    let other;
    if (screen.twoConnections) { other = await ctx.newPage(); await other.goto(`${BASE}/p/${state.pageId}`); }
    const page = await ctx.newPage();
    try {
      await screen.go(page, state, vp);
      await page.waitForSelector(screen.ready, { timeout: 15000 });
      await page.waitForTimeout(screen.name === 'graph' ? 1500 : 700);
      const problems = await page.evaluate(measure);
      for (const p of problems) failures.push(`${vp.name} ${screen.name}: ${p}`);
      if (!NO_SHOTS) await page.screenshot({ path: join(OUT, `${screen.name}-${vp.name}.png`) });
      console.log(`${problems.length ? '✗' : '✓'} ${vp.name.padEnd(14)} ${screen.name}${problems.length ? `\n    ${problems.join('\n    ')}` : ''}`);
    } catch (e) {
      failures.push(`${vp.name} ${screen.name}: ${e.message.split('\n')[0]}`);
      console.log(`✗ ${vp.name.padEnd(14)} ${screen.name}: ${e.message.split('\n')[0]}`);
    }
    await other?.close();
    await ctx.close();
  }
}
await browser.close();
if (failures.length) {
  console.error(`\n${failures.length} responsive problem(s).`);
  process.exit(1);
}
console.log(`\nAll ${VIEWPORTS.length * SCREENS.length} screen/size combinations fit.`);
