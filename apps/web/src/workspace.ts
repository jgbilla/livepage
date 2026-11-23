// The signed-in person's workspace: folders, pages, tags and saved views. One shared store,
// so the sidebar, the home list and the page screen all see the same data and refresh together.
import { useEffect, useSyncExternalStore } from 'react';
import { api, type PageSummary } from './api';
import { navigate } from './router';

export type Folder = { id: string; parent_id: string | null; name: string; path: string };
export type TreePage = PageSummary & { folder_id: string | null; path: string; tags: string[]; is_template?: boolean; published_slug?: string | null };
export type TagCount = { tag: string; count: number };
export type View = { id: string; name: string; tags: string[]; match: 'any' | 'all' };
export type Workspace = { pages: TreePage[]; folders: Folder[]; tags: TagCount[]; views: View[] };

let state: Workspace | null = null;
const liveTitles = new Map<string, string>(); // titles typed in an open page, before the server saves them
const listeners = new Set<() => void>();
const emit = () => { state = state && { ...state }; listeners.forEach((l) => l()); };

// The last workspace this person saw is kept in the browser, so the sidebar and home list
// appear at once on the next visit and are then refreshed from the server.
const CACHE_KEY = 'lp.workspace';
let cacheUser: string | null = null;
export function hydrateWorkspace(userId: string) {
  if (cacheUser === userId) return;
  cacheUser = userId;
  if (state) return;
  try {
    const saved = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null');
    if (saved?.user === userId && saved.ws?.pages) state = saved.ws;
    else localStorage.removeItem(CACHE_KEY);
  } catch { /* storage blocked or corrupt: just load from the server */ }
}
let fresh = false; // has the server answered since this tab opened?
/** On sign-out: the next person on this device starts from nothing. */
export function resetWorkspace() { state = null; fresh = false; cacheUser = null; liveTitles.clear(); emit(); }

let inflight: Promise<void> | null = null;
export function reloadWorkspace(): Promise<void> {
  inflight ??= api<Workspace>('/pages')
    .then((w) => {
      state = w; fresh = true; liveTitles.clear(); emit();
      try { if (cacheUser) localStorage.setItem(CACHE_KEY, JSON.stringify({ user: cacheUser, ws: w })); } catch { /* full or blocked */ }
    })
    .finally(() => { inflight = null; });
  return inflight;
}

export function useWorkspace(): Workspace | null {
  const ws = useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state);
  useEffect(() => { if (!state || !fresh) void reloadWorkspace(); }, []);
  return ws;
}

export const workspaceSnapshot = () => state;

export function titleOf(p: { id: string; title: string }): string {
  return liveTitles.get(p.id) ?? p.title;
}

/** The open page tells the sidebar its title as you type. */
export function setLiveTitle(pageId: string, title: string) {
  if (liveTitles.get(pageId) === title) return;
  liveTitles.set(pageId, title);
  emit();
}

/** Today's date on this device, as YYYY-MM-DD (not UTC: "today" is the person's own day). */
export function localDate(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export async function openToday() {
  const d = new Date();
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const { page } = await api<{ page: { id: string } }>('/daily', { body: { date: localDate(d), time } });
  await reloadWorkspace();
  navigate(`/p/${page.id}`);
}

export async function newPage(folderId: string | null = null) {
  const { page } = await api<{ page: { id: string } }>('/pages', { body: { title: '', folder_id: folderId } });
  await reloadWorkspace();
  navigate(`/p/${page.id}`);
}

/** A new page that starts as a copy of a template, with {{date}} and friends filled in for this device's date and time. */
export async function newPageFromTemplate(templateId: string, folderId: string | null = null) {
  const d = new Date();
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const { page } = await api<{ page: { id: string } }>('/pages', { body: { template_id: templateId, folder_id: folderId, date: localDate(d), time } });
  await reloadWorkspace();
  navigate(`/p/${page.id}`);
}

export async function newFolder(name: string, parentId: string | null) {
  const { folder } = await api<{ folder: Folder }>('/folders', { body: { name, parent_id: parentId } });
  await reloadWorkspace();
  return folder;
}

export async function renameFolder(id: string, name: string) {
  await api(`/folders/${id}`, { method: 'PATCH', body: { name } });
  await reloadWorkspace();
}

export async function moveFolder(id: string, parentId: string | null) {
  await api(`/folders/${id}`, { method: 'PATCH', body: { parent_id: parentId } });
  await reloadWorkspace();
}

export async function deleteFolder(id: string) {
  await api(`/folders/${id}`, { method: 'DELETE' });
  await reloadWorkspace();
}

export async function movePage(id: string, folderId: string | null) {
  await api(`/pages/${id}`, { method: 'PATCH', body: { folder_id: folderId } });
  await reloadWorkspace();
}

export async function renamePage(id: string, title: string) {
  await api(`/pages/${id}`, { method: 'PATCH', body: { title } });
  await reloadWorkspace();
}

export async function setTags(pageId: string, tags: string[]): Promise<string[]> {
  const r = await api<{ tags: string[] }>(`/pages/${pageId}/tags`, { method: 'PUT', body: { tags } });
  await reloadWorkspace();
  return r.tags;
}

export async function saveView(v: Omit<View, 'id'> & { id?: string }): Promise<View> {
  const r = v.id
    ? await api<{ view: View }>(`/views/${v.id}`, { method: 'PATCH', body: v })
    : await api<{ view: View }>('/views', { body: v });
  await reloadWorkspace();
  return r.view;
}

export async function deleteView(id: string) {
  await api(`/views/${id}`, { method: 'DELETE' });
  await reloadWorkspace();
}

/** Same rule as the server: a tag also matches its nested tags (book matches book/notes). */
export function matchesTags(pageTags: string[], want: string[], match: 'any' | 'all'): boolean {
  const has = (w: string) => pageTags.some((t) => t === w || t.startsWith(`${w}/`));
  return match === 'all' ? want.every(has) : want.some(has);
}

/** Same cleaning as the server, so chips look right before the round trip. */
export function cleanTag(raw: string): string {
  return raw.trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_/-]/gu, '')
    .replace(/\/{2,}/g, '/').replace(/^\/|\/$/g, '').slice(0, 60);
}
