// The workspace switcher's list: the other Livepage copies a person uses (say, personal and
// work), each its own deployment at its own address. Saved per person so every device shows
// the same list. Each entry carries the time it was last changed, and a removed entry stays as
// a tombstone for a while, so two lists (two devices, or two workspaces handing the list to
// each other when you switch) merge without bringing back what you removed.
import type { Db } from './db.ts';

export type WorkspaceLink = { url: string; name: string; icon?: string; color: number; at: number; gone?: true };

const MAX = 40;
const TOMBSTONE_MS = 180 * 24 * 3600_000;

/** An http(s) origin with nothing after it, or null. Plain http only for this machine. */
export function cleanOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 300) return null;
  try {
    const u = new URL(raw);
    if (u.username || u.password) return null;
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
    return u.origin;
  } catch { return null; }
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '');

/** Keeps only well-formed entries, one per address. */
export function cleanLinks(raw: unknown): WorkspaceLink[] {
  if (!Array.isArray(raw)) return [];
  const out = new Map<string, WorkspaceLink>();
  for (const r of raw.slice(0, MAX * 2)) {
    const url = cleanOrigin(r?.url);
    const at = Number(r?.at);
    if (!url || !Number.isFinite(at) || at <= 0) continue;
    const link: WorkspaceLink = { url, name: text(r.name, 40) || new URL(url).hostname, color: Math.min(7, Math.max(1, Math.round(Number(r.color)) || 1)), at: Math.min(at, Date.now() + 60_000) };
    const icon = [...text(r.icon, 16)].slice(0, 2).join('');
    if (icon) link.icon = icon;
    if (r.gone === true) link.gone = true;
    const had = out.get(url);
    if (!had || had.at < link.at) out.set(url, link);
  }
  return [...out.values()];
}

/** Newest change wins for each address; old tombstones are dropped. */
export function mergeLinks(a: WorkspaceLink[], b: WorkspaceLink[]): WorkspaceLink[] {
  const by = new Map<string, WorkspaceLink>();
  for (const l of [...a, ...b]) { const had = by.get(l.url); if (!had || had.at < l.at) by.set(l.url, l); }
  const now = Date.now();
  return [...by.values()].filter((l) => !l.gone || now - l.at < TOMBSTONE_MS).sort((x, y) => x.at - y.at).slice(-MAX);
}

export async function getLinks(db: Db, userId: string): Promise<WorkspaceLink[]> {
  const [row] = await db.query<{ workspace_links: unknown }>('select workspace_links from users where id = $1', [userId]);
  return cleanLinks(row?.workspace_links);
}

/** Merges what the browser sent into what is saved, and returns the result. */
export async function saveLinks(db: Db, userId: string, incoming: unknown): Promise<WorkspaceLink[]> {
  return db.tx(async (q) => {
    const [row] = await q<{ workspace_links: unknown }>('select workspace_links from users where id = $1 for update', [userId]);
    const next = mergeLinks(cleanLinks(row?.workspace_links), cleanLinks(incoming));
    await q('update users set workspace_links = $2::jsonb where id = $1', [userId, JSON.stringify(next)]);
    return next;
  });
}
