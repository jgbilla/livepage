// Folders: every person has their own tree of folders and pages, like an Obsidian vault.
// Folders belong to one person (folders.owner_id). Where a page sits is stored per member
// (page_members.folder_id), so a page someone shares with you can go anywhere in your tree
// without moving it for anybody else. Pages with no folder sit at the top level.
import type { Db, Query } from './db.ts';
import { randomId } from './auth.ts';

export type Folder = { id: string; parent_id: string | null; name: string };

export const isFolderId = (s: string) => /^f_[\w-]{8,40}$/.test(s);

/** A folder name is one path segment: no slashes, not empty, not "." or "..". */
export function cleanName(raw: unknown): string | null {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!name || name.includes('/') || name === '.' || name === '..') return null;
  return name;
}

/** "2026/11/23" or "/Projects/ Book /" -> ["2026","11","23"] / ["Projects","Book"]. Null if a segment is invalid. */
export function splitPath(raw: unknown): string[] | null {
  const parts = String(raw ?? '').split('/').map((s) => s.trim()).filter(Boolean);
  const names = parts.map(cleanName);
  return names.every((n): n is string => !!n) ? names : null;
}

export async function listFolders(q: Query, ownerId: string): Promise<Folder[]> {
  return q('select id, parent_id, name from folders where owner_id = $1 order by lower(name)', [ownerId]);
}

/** Map of folder id -> "a/b/c" for one person. */
export function folderPaths(folders: Folder[]): Map<string, string> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out = new Map<string, string>();
  const pathOf = (id: string, seen = new Set<string>()): string => {
    const cached = out.get(id);
    if (cached !== undefined) return cached;
    const f = byId.get(id);
    if (!f || seen.has(id)) return '';
    seen.add(id);
    const p = f.parent_id ? `${pathOf(f.parent_id, seen)}/${f.name}` : f.name;
    out.set(id, p);
    return p;
  };
  folders.forEach((f) => pathOf(f.id));
  return out;
}

async function findChild(q: Query, ownerId: string, parentId: string | null, name: string): Promise<string | null> {
  const [row] = await q(
    'select id from folders where owner_id = $1 and parent_id is not distinct from $2 and lower(name) = lower($3)',
    [ownerId, parentId, name],
  );
  return row?.id ?? null;
}

/** Like `mkdir -p`: returns the id of the folder at this path, creating any that are missing. [] -> null (top level). */
export async function ensureFolderPath(q: Query, ownerId: string, segments: string[]): Promise<string | null> {
  let parent: string | null = null;
  for (const name of segments) {
    let id = await findChild(q, ownerId, parent, name);
    if (!id) {
      // "on conflict do nothing" makes two tabs racing to create the same folder harmless.
      await q('insert into folders (id, owner_id, parent_id, name) values ($1,$2,$3,$4) on conflict do nothing', [randomId('f', 9), ownerId, parent, name]);
      id = await findChild(q, ownerId, parent, name);
      if (!id) throw new Error('could not create folder');
    }
    parent = id;
  }
  return parent;
}

/** Existing folder at a path, or null if any part is missing. */
export async function folderAtPath(q: Query, ownerId: string, segments: string[]): Promise<string | null> {
  let parent: string | null = null;
  for (const name of segments) {
    parent = await findChild(q, ownerId, parent, name);
    if (!parent) return null;
  }
  return parent;
}

export async function ownsFolder(q: Query, ownerId: string, folderId: string): Promise<boolean> {
  const [row] = await q('select 1 from folders where id = $1 and owner_id = $2', [folderId, ownerId]);
  return !!row;
}

export class FolderError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function createFolder(db: Db, ownerId: string, name: string, parentId: string | null): Promise<Folder> {
  return db.tx(async (q) => {
    if (parentId && !(await ownsFolder(q, ownerId, parentId))) throw new FolderError(404, 'Parent folder not found.');
    if (await findChild(q, ownerId, parentId, name)) throw new FolderError(409, `A folder named "${name}" is already there.`);
    const id = randomId('f', 9);
    await q('insert into folders (id, owner_id, parent_id, name) values ($1,$2,$3,$4)', [id, ownerId, parentId, name]);
    return { id, parent_id: parentId, name };
  });
}

/** Rename and/or move a folder. Moving a folder into itself or one of its own subfolders is refused. */
export async function updateFolder(
  db: Db, ownerId: string, folderId: string, patch: { name?: string; parentId?: string | null },
): Promise<Folder> {
  return db.tx(async (q) => {
    const [f] = await q<Folder>('select id, parent_id, name from folders where id = $1 and owner_id = $2', [folderId, ownerId]);
    if (!f) throw new FolderError(404, 'Folder not found.');
    const name = patch.name ?? f.name;
    const parentId = patch.parentId === undefined ? f.parent_id : patch.parentId;
    if (parentId) {
      if (!(await ownsFolder(q, ownerId, parentId))) throw new FolderError(404, 'Target folder not found.');
      // Walk up from the new parent; finding ourselves means a cycle.
      let cur: string | null = parentId;
      while (cur) {
        if (cur === folderId) throw new FolderError(400, 'A folder cannot go inside itself.');
        const rows: { parent_id: string | null }[] = await q('select parent_id from folders where id = $1', [cur]);
        const row = rows[0];
        cur = row?.parent_id ?? null;
      }
    }
    const clash = await findChild(q, ownerId, parentId, name);
    if (clash && clash !== folderId) throw new FolderError(409, `A folder named "${name}" is already there.`);
    await q('update folders set name = $3, parent_id = $4 where id = $1 and owner_id = $2', [folderId, ownerId, name, parentId]);
    return { id: folderId, parent_id: parentId, name };
  });
}

/** Deletes the folder and its subfolders. No page is deleted: pages inside go back to the top level. */
export async function deleteFolder(db: Db, ownerId: string, folderId: string): Promise<boolean> {
  const rows = await db.query('delete from folders where id = $1 and owner_id = $2 returning id', [folderId, ownerId]);
  return rows.length > 0;
}

/** Put a page somewhere in this member's tree (null = top level). */
export async function movePage(q: Query, userId: string, pageId: string, folderId: string | null): Promise<void> {
  if (folderId && !(await ownsFolder(q, userId, folderId))) throw new FolderError(404, 'Folder not found.');
  await q('update page_members set folder_id = $3 where page_id = $1 and user_id = $2', [pageId, userId, folderId]);
}

/** Validates "YYYY-MM-DD" and returns the daily folder path ["YYYY","MM","DD"]. */
export function dailySegments(date: unknown): string[] | null {
  const m = String(date ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d));
  if (dt.getUTCFullYear() !== +y || dt.getUTCMonth() !== +mo - 1 || dt.getUTCDate() !== +d) return null;
  return [y, mo, d];
}

export const DAILY_TITLE = 'daily';
