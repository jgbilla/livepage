// Your other Livepage workspaces (say, personal and work), for the switcher at the top of the
// sidebar. Each workspace is its own copy of Livepage at its own address, with its own sign-in,
// so switching opens the other address. That copy brings back the tabs you had open there.
//
// The list is saved on the server for you (so every device shows it), and handed to the other
// workspace in the address when you switch (#lp-ws=..., never sent to any server), so adding a
// workspace once makes both of them know about each other. A hand-off is only taken from the
// workspace that actually sent you (the browser's referrer), and one the receiving workspace
// doesn't know yet has to be accepted first, so no other site can slip an entry into your list.
import { useSyncExternalStore } from 'react';
import { api } from './api';
import { isStandalone } from './pwa';

export type WsLink = { url: string; name: string; icon?: string; color: number; at: number; gone?: true };

export const HERE = typeof location === 'undefined' ? '' : location.origin;
const HANDOFF_KEY = 'lp.ws.handoff';

type State = { links: WsLink[]; offer: WsLink | null };
let state: State = { links: [], offer: null };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => { state = { ...state, ...patch }; listeners.forEach((l) => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

const store = {
  get: (k: string, s: Storage | undefined = globalThis.localStorage) => { try { return s?.getItem(k) ?? null; } catch { return null; } },
  set: (k: string, v: string | null, s: Storage | undefined = globalThis.localStorage) => { try { if (v === null) s?.removeItem(k); else s?.setItem(k, v); } catch { /* blocked */ } },
};

// ---------- addresses and names ----------

/** "work.example.com" or "https://work.example.com/p/x" → "https://work.example.com"; null if it can't be a workspace. */
export function toOrigin(input: string): string | null {
  let raw = input.trim();
  if (!raw) return null;
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) raw = `${/^(localhost|127\.0\.0\.1)\b/.test(raw) ? 'http' : 'https'}://${raw}`;
  try {
    const u = new URL(raw);
    if (u.username || u.password || !u.hostname.includes('.') && !/^(localhost|\[::1\])$/.test(u.hostname)) return null;
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
    return u.origin;
  } catch { return null; }
}

export const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };

/** A first guess at a name from the address: "acme-notes.onrender.com" → "Acme notes". */
export function guessName(url: string) {
  const first = hostOf(url).split('.')[0].replace(/[-_]+/g, ' ').trim();
  return first ? first[0].toUpperCase() + first.slice(1) : 'Livepage';
}

/** The first letter (or emoji) of a name, for its tile. */
export const initialOf = (name: string) => [...name.trim()][0]?.toUpperCase() ?? '?';

// ---------- reading ----------

const useState_ = () => useSyncExternalStore(subscribe, () => state);
const visible = (links: WsLink[]) => links.filter((l) => !l.gone);

/** This workspace's own entry, or null when you never named it (it shows as plain "Livepage"). */
export const selfLink = (links = state.links) => visible(links).find((l) => l.url === HERE) ?? null;

export function useWorkspaceLinks() {
  const s = useState_();
  const all = visible(s.links);
  return { self: all.find((l) => l.url === HERE) ?? null, others: all.filter((l) => l.url !== HERE), all, offer: s.offer };
}

/** The name to show for this workspace: yours, or "Livepage" until you name it. */
export const useWorkspaceName = () => useWorkspaceLinks().self?.name ?? 'Livepage';

export function nextColor(links = state.links) {
  const used = new Set(visible(links).map((l) => l.color));
  for (let c = 1; c <= 7; c++) if (!used.has(c)) return c;
  return (visible(links).length % 7) + 1;
}

// ---------- loading and saving ----------

let key = '';
export async function initWorkspaceLinks(userId: string) {
  const k = `lp.wslinks.${userId}`;
  if (k === key) return;
  key = k;
  try { set({ links: JSON.parse(store.get(k) ?? '[]') }); } catch { set({ links: [] }); }
  try {
    const { links } = await api<{ links: WsLink[] }>('/me/workspaces');
    if (key !== k) return;
    commit(merge(state.links, links), false);
  } catch { /* offline: the saved copy is fine */ }
  takeOffer();
}

/** On sign-out. */
export function resetWorkspaceLinks() { key = ''; set({ links: [], offer: null }); }

function merge(a: WsLink[], b: WsLink[]) {
  const by = new Map<string, WsLink>();
  for (const l of [...a, ...b]) { const had = by.get(l.url); if (!had || had.at < l.at) by.set(l.url, l); }
  return [...by.values()].sort((x, y) => x.at - y.at);
}

let saving: Promise<unknown> = Promise.resolve();
function commit(links: WsLink[], push = true) {
  set({ links });
  if (key) store.set(key, JSON.stringify(links));
  if (!push) return;
  const k = key;
  saving = saving.then(() => api<{ links: WsLink[] }>('/me/workspaces', { method: 'PUT', body: { links } }))
    .then((r) => { if (key === k && r.links) { set({ links: merge(state.links, r.links) }); store.set(k, JSON.stringify(state.links)); } })
    .catch(() => { /* kept in this browser; the next change or visit saves it */ });
}

const now = () => Math.max(Date.now(), ...state.links.map((l) => l.at + 1));

export function saveLink(link: Omit<WsLink, 'at' | 'gone'>) {
  const clean: WsLink = { url: link.url, name: link.name.trim().slice(0, 40) || guessName(link.url), color: link.color, at: now() };
  const icon = [...(link.icon ?? '').trim()].slice(0, 2).join('');
  if (icon) clean.icon = icon;
  commit(merge(state.links, [clean]));
}

export function removeLink(url: string) {
  const had = state.links.find((l) => l.url === url);
  if (had) commit(merge(state.links, [{ ...had, at: now(), gone: true }]));
}

// ---------- switching ----------

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));

/** The address that opens a workspace, carrying your list so it learns about this one too. */
export function hrefFor(url: string) {
  const self = selfLink() ?? { url: HERE, name: guessName(HERE), color: 0, at: 1 };
  const links = merge(state.links, [self]).map(({ url: u, name, icon, color, at, gone }) => ({ url: u, name, icon, color, at, gone }));
  return `${url}/#lp-ws=${b64(JSON.stringify({ from: HERE, links }))}`;
}

/** An installed app opens the other workspace in its own window (its own installed app, if you have one). */
export const opensNewWindow = () => isStandalone();

export function switchTo(url: string) {
  const href = hrefFor(url);
  if (opensNewWindow()) window.open(href, '_blank', 'noopener');
  else location.assign(href);
}

/** Warm up the connection to the other workspaces (and wake a sleeping free server) when the menu opens. */
export function preconnect(urls: string[]) {
  for (const u of urls) {
    if (document.head.querySelector(`link[rel="preconnect"][href="${u}"]`)) continue;
    const l = document.createElement('link');
    l.rel = 'preconnect'; l.href = u; l.crossOrigin = 'anonymous';
    document.head.appendChild(l);
  }
}

/**
 * At startup, before the router reads the address: take a hand-off from the workspace you came
 * from, and clean it out of the address bar. It is kept for the session, so it survives signing in.
 */
export function captureHandoff() {
  const m = location.hash.match(/^#lp-ws=([\w-]+)$/);
  if (!m) return;
  history.replaceState(history.state, '', location.pathname + location.search);
  try {
    const data = JSON.parse(unb64(m[1]));
    const from = document.referrer ? new URL(document.referrer).origin : '';
    if (!from || from === HERE || data?.from !== from || !Array.isArray(data.links)) return;
    store.set(HANDOFF_KEY, JSON.stringify({ from, links: data.links.slice(0, 60) }), globalThis.sessionStorage);
  } catch { /* not ours, or mangled: ignore */ }
}

const wellFormed = (l: any): l is WsLink => !!l && typeof l.url === 'string' && toOrigin(l.url) === l.url && typeof l.name === 'string'
  && Number.isFinite(l.at) && l.at > 0 && Number.isFinite(l.color);

function takeOffer() {
  const raw = store.get(HANDOFF_KEY, globalThis.sessionStorage);
  if (!raw) return;
  let h: { from: string; links: unknown[] };
  try { h = JSON.parse(raw); } catch { store.set(HANDOFF_KEY, null, globalThis.sessionStorage); return; }
  const links = h.links.filter(wellFormed).map((l) => ({ ...l, name: l.name.slice(0, 40), color: Math.min(7, Math.max(0, Math.round(l.color))) }));
  const sender = links.find((l) => l.url === h.from && !l.gone) ?? { url: h.from, name: guessName(h.from), color: 0, at: 1 };
  if (visible(state.links).some((l) => l.url === h.from)) { // a workspace you already switch between
    store.set(HANDOFF_KEY, null, globalThis.sessionStorage);
    pendingLinks = links;
    acceptOffer();
    return;
  }
  pendingLinks = links;
  set({ offer: { ...sender, color: sender.color || nextColor() } });
}

let pendingLinks: WsLink[] = [];
/** Yes: you can switch back to the workspace you came from, and both lists agree from now on. */
export function acceptOffer() {
  store.set(HANDOFF_KEY, null, globalThis.sessionStorage);
  const offer = state.offer;
  let incoming = pendingLinks;
  pendingLinks = [];
  if (offer && !incoming.some((l) => l.url === offer.url && l.at > 1)) incoming = [...incoming.filter((l) => l.url !== offer.url), { ...offer, at: now() }];
  // An unnamed workspace sends itself with at=1; it loses to anything you have set.
  incoming = incoming.map((l) => (l.color ? l : { ...l, color: nextColor() }));
  set({ offer: null });
  const next = merge(state.links, incoming);
  if (JSON.stringify(next) !== JSON.stringify(state.links)) commit(next);
}

export function declineOffer() {
  store.set(HANDOFF_KEY, null, globalThis.sessionStorage);
  pendingLinks = [];
  set({ offer: null });
}
