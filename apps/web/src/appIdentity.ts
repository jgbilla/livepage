// The home screen / Dock icon for this workspace. Each Livepage workspace is its own address, so
// Safari installs each as its own app; with the same icon, "Work" and "Personal" look identical on
// the home screen. Once you name a workspace, its icon gets that workspace's tile (color and
// letter or emoji, as in the switcher) in its empty corner, so you can tell the two apps apart.
// Safari reads the apple-touch-icon when you add the app, so this only changes new installs.
import { useEffect } from 'react';
import type { WsLink } from './workspaceLinks';

const BASE = '/icons/apple-touch-icon.png';
const SIZE = 180;

function draw(base: HTMLImageElement, link: Pick<WsLink, 'name' | 'icon' | 'color'>): string | null {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const g = c.getContext('2d');
  if (!g) return null;
  g.drawImage(base, 0, 0, SIZE, SIZE);
  const glyph = link.icon || [...link.name.trim()][0]?.toUpperCase() || '?';
  const emoji = !!link.icon && !/^[\p{L}\p{N}]/u.test(link.icon);
  // A rounded tile in the empty bottom-right corner, under the mark's violet square.
  const s = 66, x = SIZE - s - 18, y = SIZE - s - 18, r = 16;
  g.beginPath();
  g.roundRect(x, y, s, s, r);
  g.fillStyle = emoji ? '#efece6' : getComputedStyle(document.documentElement).getPropertyValue(`--lp-person-${link.color || 1}`).trim() || '#d4520f';
  g.fill();
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `${emoji ? 40 : 600 + ' ' + 36}px -apple-system, system-ui, "Segoe UI", sans-serif`;
  g.fillText(glyph, x + s / 2, y + s / 2 + (emoji ? 3 : 2));
  try { return c.toDataURL('image/png'); } catch { return null; }
}

/** Keep the install icon in step with this workspace's name, icon and color. */
export function useAppIdentity(self: Pick<WsLink, 'name' | 'icon' | 'color'> | null) {
  const sig = self ? `${self.name}|${self.icon ?? ''}|${self.color}` : '';
  useEffect(() => {
    const el = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]');
    if (!el) return;
    if (!self) { el.href = BASE; return; }
    let live = true;
    const img = new Image();
    img.onload = () => { const url = live ? draw(img, self) : null; if (url) el.href = url; };
    img.src = BASE;
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
}
