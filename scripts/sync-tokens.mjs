// Copies the design tokens (apps/web/src/design/tokens.css) into the HTML block runner
// (apps/sandbox/public/runner.html), so blocks agents write can use var(--lp-*) and match the page.
// The runner's CSP allows inline styles only, so the tokens are inlined between two markers.
//
//   node scripts/sync-tokens.mjs           # rewrite runner.html
//   node scripts/sync-tokens.mjs --check   # fail if runner.html is out of date (CI)
import { readFileSync, writeFileSync } from 'node:fs';

const TOKENS = new URL('../apps/web/src/design/tokens.css', import.meta.url);
const RUNNER = new URL('../apps/sandbox/public/runner.html', import.meta.url);
const START = '/*lp-tokens:start*/';
const END = '/*lp-tokens:end*/';

let css = readFileSync(TOKENS, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')                                    // comments
  .replace(/:root, :root\[data-theme\] \{[\s\S]*?\n\}\n/, '')          // legacy aliases: app-only
  .replace(/\s*\n\s*/g, '')                                            // whitespace
  .replace(/\s*([{};:,])\s*/g, '$1')
  .replace(/;}/g, '}');
// Escape for a JS template literal inside runner.html.
css = css.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

const runner = readFileSync(RUNNER, 'utf8');
const a = runner.indexOf(START), b = runner.indexOf(END);
if (a < 0 || b < 0) throw new Error('runner.html has no token markers');
const next = runner.slice(0, a + START.length) + css + runner.slice(b);
if (process.argv.includes('--check')) {
  if (next !== runner) { console.error('runner.html tokens are out of date: run node scripts/sync-tokens.mjs'); process.exit(1); }
  console.log('runner.html tokens are up to date');
} else {
  writeFileSync(RUNNER, next);
  console.log(`runner.html: ${css.length} bytes of tokens`);
}
