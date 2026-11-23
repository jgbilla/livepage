// Draws the app icons and iOS launch screens from the Livepage mark (apps/web/public/favicon.svg):
// an ink square with a caret (you) and a violet squircle (the agent). Run after changing the mark:
//
//   node scripts/make-app-icons.mjs
//
// Writes apps/web/public/icons/* and apps/web/public/splash/*. The PNGs are committed, so a
// normal build needs neither this script nor a browser.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPLASH_DEVICES, splashName } from '../apps/web/pwa/devices.mjs';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'public');
const INK = '#1f1d1a';
const PAPER = '#fcfbf9';
const BG = { light: '#fcfbf9', dark: '#161514' };

// The mark on a 32-unit grid, centred. `scale` shrinks it for maskable icons (Android crops them to a circle).
function svg({ size, radius = 0, scale = 1, background = INK, border = null }) {
  const t = `translate(16 16) scale(${scale}) translate(-18.5 -15)`; // the favicon's mark sits at 18.5,15
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">
    <defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b6cf6"/><stop offset="1" stop-color="#5741b8"/></linearGradient></defs>
    <rect width="32" height="32" rx="${radius}" fill="${background}"${border ? ` stroke="${border}" stroke-width="0.4"` : ''}/>
    <g transform="${t}"><rect x="11" y="8" width="3" height="16" rx="1.5" fill="${PAPER}"/><rect x="19" y="6" width="7" height="7" rx="2.2" fill="url(#a)"/></g>
  </svg>`;
}

const ICONS = [
  // Desktop install and Android (not cropped): a rounded square with see-through corners.
  { file: 'icons/icon-192.png', size: 192, radius: 7, transparent: true },
  { file: 'icons/icon-512.png', size: 512, radius: 7, transparent: true },
  // Android adaptive icons: full bleed, the mark inside the 80% safe circle.
  { file: 'icons/maskable-192.png', size: 192, scale: 0.8 },
  { file: 'icons/maskable-512.png', size: 512, scale: 0.8 },
  // iOS home screen: full bleed and opaque; iOS rounds the corners itself.
  { file: 'icons/apple-touch-icon.png', size: 180, scale: 0.95 },
];

const browser = await chromium.launch();
try {
  for (const icon of ICONS) {
    const page = await browser.newPage({ viewport: { width: icon.size, height: icon.size }, deviceScaleFactor: 1 });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg(icon)}`);
    mkdirSync(dirname(join(PUBLIC, icon.file)), { recursive: true });
    await page.screenshot({ path: join(PUBLIC, icon.file), omitBackground: !!icon.transparent });
    await page.close();
  }
  mkdirSync(join(PUBLIC, 'splash'), { recursive: true });
  for (const device of SPLASH_DEVICES) {
    const [w, h, r] = device;
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: r });
      const mark = svg({ size: 120, radius: 7, border: theme === 'dark' ? '#3a3835' : null });
      await page.setContent(`<style>html,body{margin:0;height:100%}body{background:${BG[theme]};display:grid;place-items:center}svg{display:block;margin-top:-4vh}</style>${mark}`);
      await page.screenshot({ path: join(PUBLIC, splashName(device, theme)) });
      await page.close();
    }
  }
} finally {
  await browser.close();
}
console.log(`wrote ${ICONS.length} icons and ${SPLASH_DEVICES.length * 2} launch screens to ${PUBLIC}`);
