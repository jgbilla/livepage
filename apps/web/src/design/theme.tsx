// Light / dark / system theme. The choice lives in this browser (localStorage) and is applied as
// <html data-theme="light|dark"> (no attribute = follow the OS). index.html applies it before first
// paint so there is no flash; this module keeps it in sync and offers the sidebar switch.
import { useEffect, useState } from 'react';
import { Icon, type IconName } from './Icon';

export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'livepage:theme';
const listeners = new Set<() => void>();

export function themePref(): ThemePref {
  try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'system'; } catch { return 'system'; }
}

/** The theme actually showing right now. */
export function resolvedTheme(): 'light' | 'dark' {
  const forced = document.documentElement.dataset.theme;
  if (forced === 'light' || forced === 'dark') return forced;
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function setThemePref(pref: ThemePref) {
  try { if (pref === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, pref); } catch { /* private mode */ }
  if (pref === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = pref;
  listeners.forEach((l) => l());
}

/** Calls back whenever the showing theme changes (a pick here, or the OS switching). */
export function onThemeChange(cb: () => void): () => void {
  listeners.add(cb);
  const mq = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: dark)') : null;
  mq?.addEventListener('change', cb);
  return () => { listeners.delete(cb); mq?.removeEventListener('change', cb); };
}

export function useResolvedTheme(): 'light' | 'dark' {
  const [t, setT] = useState(resolvedTheme);
  useEffect(() => onThemeChange(() => setT(resolvedTheme())), []);
  return t;
}

const OPTIONS: { pref: ThemePref; icon: IconName; label: string }[] = [
  { pref: 'system', icon: 'monitor', label: 'Match system' },
  { pref: 'light', icon: 'sun', label: 'Light' },
  { pref: 'dark', icon: 'moon', label: 'Dark' },
];

export function ThemeSwitch() {
  const [pref, setPref] = useState(themePref);
  return (
    <span className="theme-switch" role="radiogroup" aria-label="Theme">
      {OPTIONS.map((o) => (
        <button key={o.pref} type="button" role="radio" aria-checked={pref === o.pref} className={pref === o.pref ? 'on' : ''} title={o.label} aria-label={o.label}
          onClick={() => { setThemePref(o.pref); setPref(o.pref); }}>
          <Icon name={o.icon} />
        </button>
      ))}
    </span>
  );
}
