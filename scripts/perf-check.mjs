// Load-speed check: opens the home screen and a rich page on a throttled connection (slow 4G,
// 4x slower CPU, the Lighthouse mobile profile) and prints how long each takes and how much
// is downloaded. Run it before and after a change to see the difference.
//
//   pnpm build && NODE_ENV=production LIVEPAGE_MEMORY_STORE=1 SIGNUP_OPEN=1 SECURE_COOKIES=0 PORT=5173 pnpm --filter @livepage/server start
//   pnpm check:perf            # LIVEPAGE_BASE=http://localhost:5173 by default; RUNS=5
//
// Measure a production build (as above), not `pnpm dev`: the dev server ships unbundled modules.
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';

const BASE = (process.env.LIVEPAGE_BASE ?? 'http://localhost:5173').replace(/\/$/, '');
const RUNS = Number(process.env.RUNS ?? 5);
const NET = { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 };

async function api(path, { cookie, body } = {}) {
  const call = () => fetch(`${BASE}/api${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', connection: 'close', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await call().catch(call); // an idle keep-alive socket may have been closed: ask once more
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return { json: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}

async function seed() {
  const { cookie } = await api('/auth/signup', { body: { email: `perf-${Date.now()}@example.com`, name: 'Perf Check', password: 'perf-check-12345' } });
  const { json: tok } = await api('/tokens', { cookie, body: { name: 'Docs writer' } });
  const run = spawnSync('pnpm', ['agent:docs'], {
    env: { ...process.env, AGENT_TOKEN: tok.token, LIVEPAGE_URL: BASE.replace(/^http/, 'ws') + '/collab' }, encoding: 'utf8',
  });
  const pageId = (run.stdout + run.stderr).match(/writing (p_[\w-]+)/)?.[1];
  if (!pageId) throw new Error(`could not write the docs page:\n${run.stdout}\n${run.stderr}`);
  for (let i = 0; i < 40; i++) await api('/pages', { cookie, body: { title: `Note ${i + 1}` } });
  return { cookie, pageId };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** One visit. `warm` keeps the browser's cache and saved copies from an earlier visit in the same context. */
async function visit(context, url, readySelector, readyText) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', NET);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  let bytes = 0, requests = 0;
  cdp.on('Network.loadingFinished', (e) => { bytes += e.encodedDataLength; requests++; });
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'commit' });
  await page.waitForFunction(([sel, min]) => {
    const el = document.querySelector(sel);
    return !!el && (el.textContent ?? '').trim().length >= min;
  }, [readySelector, readyText], { timeout: 120_000 });
  const ready = Date.now() - t0;
  // First paint: the moment the screen stops being blank (a placeholder counts).
  const paint = await page.evaluate(() => performance.getEntriesByName('first-paint')[0]?.startTime ?? performance.getEntriesByType('paint')[0]?.startTime ?? 0);
  await page.waitForTimeout(1500); // let trailing requests finish so the byte count is complete
  await page.close();
  return { ready, firstPaint: Math.round(paint), kb: Math.round(bytes / 1024), requests };
}

const s = await seed();
const browser = await chromium.launch();
const [name, value] = s.cookie.split('=');
const rows = [];
for (const [label, path, sel, min] of [['Home', '/', '.home', 20], ['Page', `/p/${s.pageId}`, '.ProseMirror', 200]]) {
  const cold = [], warm = [];
  for (let i = 0; i < RUNS; i++) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addCookies([{ name, value, url: BASE }]);
    cold.push(await visit(context, BASE + path, sel, min));
    warm.push(await visit(context, BASE + path, sel, min));
    await context.close();
  }
  for (const [kind, runs] of [['first visit', cold], ['repeat visit', warm]]) {
    rows.push({ screen: label, visit: kind, 'first paint (ms)': median(runs.map((r) => r.firstPaint)), 'content ready (ms)': median(runs.map((r) => r.ready)),
      'downloaded (KB)': median(runs.map((r) => r.kb)), requests: median(runs.map((r) => r.requests)) });
  }
}
await browser.close();
console.log(`\n${BASE}  (slow 4G: 150 ms latency, 1.6 Mbps; CPU 4x slower; median of ${RUNS})`);
console.table(rows);
