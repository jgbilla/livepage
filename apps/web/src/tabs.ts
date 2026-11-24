// Workspace tabs: the pages (and other screens) you have open, in a strip across the top of the
// main area, like Obsidian's tabs. Not to be confused with page tabs (a page's own sections,
// shown under its title, see TabBar.tsx).
//
// - The URL bar always shows the focused tab. Every history entry is tagged with its tab, so
//   Back and Forward move between the places you were, across tabs.
// - Up to two groups side by side (split view). Each group has its own tabs and active tab.
// - Saved per person in localStorage and restored on reload.
import { useSyncExternalStore } from 'react';
import { routerHooks, type OpenTabOptions } from './router';

export type WTab = { id: string; path: string; pinned?: boolean };
export type Group = { id: string; tabs: WTab[]; active: string };
export type TabsState = { groups: Group[]; focus: number; split: number };

const uid = () => Math.random().toString(36).slice(2, 10);
const here = () => location.pathname + location.search;
const pathname = (p: string) => p.split(/[?#]/)[0];
// Screens outside the workspace (signing in, share links) never become tabs.
const outside = (p: string) => /^\/(login|s\/|auth\/|pub\/)/.test(p);

let key = '';
let s: TabsState = fresh('/');
const listeners = new Set<() => void>();

function fresh(path: string): TabsState {
  const t = { id: uid(), path };
  return { groups: [{ id: uid(), tabs: [t], active: t.id }], focus: 0, split: 0.5 };
}

const clone = (st: TabsState): TabsState => ({ ...st, groups: st.groups.map((g) => ({ ...g, tabs: g.tabs.map((t) => ({ ...t })) })) });

/** Pinned tabs first, no empty groups, every group has an active tab, focus in range. */
function normalize(st: TabsState): TabsState {
  let groups = st.groups.filter((g) => g.tabs.length).slice(0, 2);
  if (!groups.length) return fresh('/');
  groups = groups.map((g) => {
    const tabs = [...g.tabs.filter((t) => t.pinned), ...g.tabs.filter((t) => !t.pinned)];
    return { ...g, tabs, active: tabs.some((t) => t.id === g.active) ? g.active : tabs[0].id };
  });
  const split = Number.isFinite(st.split) ? Math.min(0.8, Math.max(0.2, st.split)) : 0.5;
  return { groups, focus: Math.min(Math.max(0, st.focus), groups.length - 1), split };
}

function commit(next: TabsState) {
  s = normalize(next);
  try { if (key) localStorage.setItem(key, JSON.stringify(s)); } catch { /* private mode */ }
  listeners.forEach((l) => l());
}

function load(): TabsState | null {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!v || !Array.isArray(v.groups)) return null;
    const groups: Group[] = v.groups.map((g: any) => ({
      id: String(g.id ?? uid()), active: String(g.active ?? ''),
      tabs: (Array.isArray(g.tabs) ? g.tabs : []).filter((t: any) => t && typeof t.path === 'string' && t.path.startsWith('/') && !outside(t.path))
        .map((t: any) => ({ id: String(t.id ?? uid()), path: t.path, ...(t.pinned ? { pinned: true } : {}) })),
    }));
    const st = normalize({ groups, focus: Number(v.focus) || 0, split: Number(v.split) || 0.5 });
    return st;
  } catch { return null; }
}

// ---------- reading ----------

export const tabsSnapshot = () => s;
export function useTabs(): TabsState {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => s);
}
export const focusedTab = (st = s) => { const g = st.groups[st.focus]; return g.tabs.find((t) => t.id === g.active)!; };
function find(id: string, st = s) {
  for (let gi = 0; gi < st.groups.length; gi++) {
    const ti = st.groups[gi].tabs.findIndex((t) => t.id === id);
    if (ti >= 0) return { gi, ti, tab: st.groups[gi].tabs[ti] };
  }
  return null;
}

// ---------- history ----------

/** Show the focused tab in the URL bar. push: a new history entry (switching tabs); else replace it. */
function show(push: boolean, later = false) {
  const t = focusedTab();
  const state = { wtab: t.id };
  if (here() === t.path && (history.state as any)?.wtab === t.id) return;
  if (push && here() !== t.path) history.pushState(state, '', t.path);
  else history.replaceState(state, '', t.path);
  const tell = () => dispatchEvent(new PopStateEvent('popstate'));
  if (later) queueMicrotask(tell); // setup runs while React renders: tell the rest of the app after
  else tell();
}

/** The URL changed (a link, Back/Forward): it belongs to the tab its history entry names, else the focused tab. */
function onPop() {
  const url = here();
  if (outside(url)) return;
  const id = (history.state as any)?.wtab as string | undefined;
  const f = id ? find(id) : null;
  if (f) {
    if (s.focus === f.gi && s.groups[f.gi].active === id && f.tab.path === url) return;
    const next = clone(s);
    next.focus = f.gi;
    next.groups[f.gi].active = f.tab.id;
    next.groups[f.gi].tabs[f.ti].path = url;
    commit(next);
    return;
  }
  // An entry from a tab that has since closed, or with no tab: it opens in the focused tab.
  const next = clone(s);
  const g = next.groups[next.focus];
  const t = g.tabs.find((x) => x.id === g.active)!;
  t.path = url;
  commit(next);
  history.replaceState({ ...(history.state && typeof history.state === 'object' ? history.state : {}), wtab: t.id }, '');
}

// ---------- setup ----------

let listening = false;
/** Load this person's tabs and fit the current URL into them. Safe to call again for the same person. */
export function initTabs(userId: string) {
  const k = `lp.wtabs.${userId}`;
  if (k === key) return;
  key = k;
  const url = outside(here()) ? '/' : here();
  const stored = load();
  if (!stored) s = fresh(url);
  else {
    s = stored;
    const id = (history.state as any)?.wtab as string | undefined;
    const byId = id ? find(id) : null;
    const byPath = url === '/' ? undefined : s.groups[s.focus].tabs.find((t) => t.path === url) ?? s.groups.flatMap((g) => g.tabs).find((t) => t.path === url);
    const next = clone(s);
    if (byId) { // a reload: the URL is that tab's
      next.focus = byId.gi; next.groups[byId.gi].active = byId.tab.id; next.groups[byId.gi].tabs[byId.ti].path = url;
    } else if (byPath) {
      const f = find(byPath.id)!; next.focus = f.gi; next.groups[f.gi].active = byPath.id;
    } else if (url !== '/') { // a link from elsewhere: a new tab next to the one you were on
      const g = next.groups[next.focus];
      const t = { id: uid(), path: url };
      g.tabs.splice(g.tabs.findIndex((x) => x.id === g.active) + 1, 0, t);
      g.active = t.id;
    } // the bare app URL: just bring back the tabs you had
    s = normalize(next);
  }
  commit(s);
  show(false, true);
  if (!listening) { listening = true; addEventListener('popstate', onPop); }
  routerHooks.state = () => ({ wtab: focusedTab().id });
  routerHooks.beforePush = (to) => {
    if (outside(to)) return false;
    const t = focusedTab();
    if (pathname(to) === pathname(t.path)) return false; // moving around inside the tab you are on
    // Already open in another tab: go to that tab instead of opening the page a second time.
    if (goToOpenTab(to)) return true;
    // A pinned tab stays where it is: following a link from it opens a new tab.
    if (!t.pinned) return false;
    openInTab(to);
    return true;
  };
  routerHooks.openTab = (to, opts) => {
    // "Open in new tab" on something already open goes to its tab too. Side by side still opens a copy.
    if (!opts?.split && (opts?.background ? openTabFor(to) : goToOpenTab(to))) return;
    openInTab(to, opts);
  };
}

/** The tab that already shows this page or screen (the focused side first). Home is never matched: a new tab starts there. */
function openTabFor(path: string) {
  const p = pathname(path);
  if (p === '/' || outside(p)) return null;
  const order = [s.groups[s.focus], ...s.groups.filter((_, i) => i !== s.focus)];
  for (const g of order) {
    const t = g.tabs.find((x) => x.id === g.active && pathname(x.path) === p) ?? g.tabs.find((x) => pathname(x.path) === p);
    if (t) return t;
  }
  return null;
}

/** Switch to the tab that already has this path open, taking it to the exact place asked for. False when there is none. */
function goToOpenTab(path: string): boolean {
  const t = openTabFor(path);
  if (!t) return false;
  // A link to a place inside the page (a page tab, a comment) takes the open tab there; a plain link leaves it where it was.
  if (path !== pathname(path) && t.path !== path) setTabPath(t.id, path);
  if (t.id === focusedTab().id) show(false);
  else activateTab(t.id);
  return true;
}

// ---------- actions ----------

/** Open a path in a new tab: next to the current one, or in the other half of a split. */
export function openInTab(path: string, opts: OpenTabOptions & { group?: number; index?: number } = {}) {
  const next = clone(s);
  let gi = opts.group ?? next.focus;
  if (opts.split) {
    if (next.groups.length < 2) next.groups.push({ id: uid(), tabs: [], active: '' });
    gi = next.focus === 0 ? 1 : 0;
  }
  const g = next.groups[gi];
  const t = { id: uid(), path };
  const pinned = g.tabs.filter((x) => x.pinned).length;
  const after = g.tabs.findIndex((x) => x.id === g.active) + 1;
  const at = opts.index ?? (opts.split ? g.tabs.length : Math.max(after, pinned));
  g.tabs.splice(at, 0, t);
  if (!opts.background || !g.active) g.active = t.id;
  if (!opts.background) next.focus = gi;
  commit(next);
  if (!opts.background) show(true);
}

export function activateTab(id: string) {
  const f = find(id);
  if (!f) return;
  if (s.focus === f.gi && s.groups[f.gi].active === id) return;
  const next = clone(s);
  next.focus = f.gi;
  next.groups[f.gi].active = id;
  commit(next);
  show(true);
}

/** Clicking into the other half of a split makes it the one the URL bar shows. */
export function focusGroup(gi: number) {
  if (s.focus === gi || !s.groups[gi]) return;
  commit({ ...clone(s), focus: gi });
  show(false);
}

export function closeTabs(ids: string[]) {
  if (!ids.length) return;
  const before = focusedTab().id;
  const next = clone(s);
  for (const id of ids) {
    const f = find(id, next);
    if (!f) continue;
    const g = next.groups[f.gi];
    g.tabs.splice(f.ti, 1);
    if (g.active === id) g.active = (g.tabs[f.ti] ?? g.tabs[f.ti - 1])?.id ?? '';
    if (!g.tabs.length) {
      if (next.groups.length > 1) { next.groups.splice(f.gi, 1); if (next.focus >= f.gi) next.focus = Math.max(0, next.focus - 1); }
      else { const h = { id: uid(), path: '/' }; g.tabs = [h]; g.active = h.id; } // the last tab: back to Home
    }
  }
  commit(next);
  if (focusedTab().id !== before) show(false);
}
export const closeTab = (id: string) => closeTabs([id]);

export function closeOtherTabs(id: string) {
  const f = find(id);
  if (!f) return;
  closeTabs(s.groups[f.gi].tabs.filter((t) => t.id !== id && !t.pinned).map((t) => t.id));
  activateTab(id);
}

export function closeTabsToRight(id: string) {
  const f = find(id);
  if (!f) return;
  closeTabs(s.groups[f.gi].tabs.slice(f.ti + 1).filter((t) => !t.pinned).map((t) => t.id));
}

export function togglePin(id: string) {
  const next = clone(s);
  const f = find(id, next);
  if (!f) return;
  f.tab.pinned = !f.tab.pinned || undefined;
  if (!f.tab.pinned) delete f.tab.pinned;
  commit(next);
}

/** Drag and drop: move a tab to `index` in group `gi` (a new group when gi is the group count). */
export function moveTab(id: string, gi: number, index: number) {
  const next = clone(s);
  const f = find(id, next);
  if (!f) return;
  const [tab] = next.groups[f.gi].tabs.splice(f.ti, 1);
  if (gi >= next.groups.length) next.groups.push({ id: uid(), tabs: [], active: '' });
  const target = next.groups[gi];
  const at = f.gi === gi && f.ti < index ? index - 1 : index;
  target.tabs.splice(Math.max(0, Math.min(at, target.tabs.length)), 0, tab);
  target.active = tab.id;
  const src = next.groups[f.gi];
  if (src.active === id && src !== target) src.active = (src.tabs[f.ti] ?? src.tabs[f.ti - 1])?.id ?? '';
  next.groups = next.groups.filter((g) => g.tabs.length);
  next.focus = next.groups.indexOf(target);
  commit(next);
  show(false);
}

/** Open this tab side by side: a copy in a new right half, or move it to the other half. */
export function splitTab(id: string) {
  const f = find(id);
  if (!f) return;
  if (s.groups.length > 1) { moveTab(id, f.gi === 0 ? 1 : 0, Number.MAX_SAFE_INTEGER); return; }
  openInTab(f.tab.path, { split: true });
}

export function cycleTab(delta: number) {
  const g = s.groups[s.focus];
  const i = g.tabs.findIndex((t) => t.id === g.active);
  const t = g.tabs[(i + delta + g.tabs.length) % g.tabs.length];
  if (t) activateTab(t.id);
}

export function nthTab(n: number) {
  const g = s.groups[s.focus];
  const t = n < 0 ? g.tabs[g.tabs.length - 1] : g.tabs[n];
  if (t) activateTab(t.id);
}

/** A tab that is not focused changed its own path (for example a page tab fell back to the main one). */
export function setTabPath(id: string, path: string) {
  const next = clone(s);
  const f = find(id, next);
  if (!f || f.tab.path === path) return;
  f.tab.path = path;
  commit(next);
}

export function setSplit(ratio: number) {
  commit({ ...clone(s), split: ratio });
}
