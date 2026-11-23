// Pages, membership, roles and share links.
import { randomBytes } from 'node:crypto';
import type { Db, Query } from './db.ts';
import { randomId, type Principal } from './auth.ts';
import { DAILY_TITLE, ensureFolderPath, ownsFolder, FolderError } from './folders.ts';

export type Role = 'owner' | 'editor' | 'commenter' | 'viewer';
const RANK: Record<Role, number> = { viewer: 1, commenter: 2, editor: 3, owner: 4 };
export const atLeast = (role: Role | null, min: Role) => !!role && RANK[role] >= RANK[min];
/** Can this role change page content? Commenters will get comment-only writes in M2. */
export const canEdit = (role: Role | null) => atLeast(role, 'editor');

export const isPageId = (s: string) => /^p_[\w-]{8,40}$/.test(s);

async function insertPage(q: Query, ownerId: string, title: string, folderId: string | null) {
  const id = randomId('p', 9);
  title = title.slice(0, 200);
  await q('insert into pages (id, owner_id, title) values ($1,$2,$3)', [id, ownerId, title]);
  await q("insert into page_members (page_id, user_id, role, folder_id) values ($1,$2,'owner',$3)", [id, ownerId, folderId]);
  return { id, title, folder_id: folderId };
}

/** New page owned by ownerId, in one of their folders (or a folder path, created if missing). */
export async function createPage(
  db: Db, ownerId: string, title = '', where: { folderId?: string | null; path?: string[] } = {},
): Promise<{ id: string; title: string; folder_id: string | null }> {
  return db.tx(async (q) => {
    let folderId = where.folderId ?? null;
    if (where.path) folderId = await ensureFolderPath(q, ownerId, where.path);
    else if (folderId && !(await ownsFolder(q, ownerId, folderId))) throw new FolderError(404, 'Folder not found.');
    return insertPage(q, ownerId, title, folderId);
  });
}

/**
 * The person's daily page for a date: the page titled "daily" in folder YYYY/MM/DD,
 * created (with its folders) if it does not exist yet. Safe to call twice at once.
 */
export async function dailyPage(db: Db, userId: string, segments: string[]): Promise<{ id: string; created: boolean }> {
  return db.tx(async (q) => {
    await q('select pg_advisory_xact_lock(hashtext($1))', [`daily:${userId}:${segments.join('/')}`]);
    const folderId = await ensureFolderPath(q, userId, segments);
    const [found] = await q(
      `select p.id from page_members m join pages p on p.id = m.page_id
        where m.user_id = $1 and m.folder_id = $2 and lower(p.title) = $3 order by p.created_at limit 1`,
      [userId, folderId, DAILY_TITLE],
    );
    if (found) return { id: found.id as string, created: false };
    const page = await insertPage(q, userId, DAILY_TITLE, folderId);
    return { id: page.id, created: true };
  });
}

export async function roleFor(db: Db, who: Principal | null, pageId: string): Promise<Role | null> {
  if (!who) return null;
  if (who.superAgent) {
    const [exists] = await db.query('select 1 from pages where id = $1', [pageId]);
    return exists ? 'editor' : null;
  }
  const [row] = await db.query('select role from page_members where page_id = $1 and user_id = $2', [pageId, who.id]);
  return (row?.role as Role) ?? null;
}

export async function listPages(db: Db, userId: string) {
  return db.query(
    `select p.id, p.title, p.updated_at, m.role, m.folder_id, u.name as owner_name, p.is_template, p.published_slug
       from page_members m join pages p on p.id = m.page_id join users u on u.id = p.owner_id
      where m.user_id = $1 order by p.updated_at desc limit 5000`,
    [userId],
  );
}

export async function pageInfo(db: Db, pageId: string) {
  const [page] = await db.query('select id, title, owner_id, updated_at, is_template, published_slug from pages where id = $1', [pageId]);
  return page ?? null;
}

export async function setTitle(db: Db, pageId: string, title: string) {
  await db.query('update pages set title = $2, updated_at = now() where id = $1', [pageId, title.slice(0, 200)]);
}

export async function touch(db: Db, pageId: string) {
  await db.query('update pages set updated_at = now() where id = $1', [pageId]);
}

export async function deletePage(db: Db, pageId: string) {
  await db.tx(async (q) => {
    await q('delete from documents where name = $1', [pageId]);
    await q('delete from pages where id = $1', [pageId]);
  });
}

export async function members(db: Db, pageId: string) {
  return db.query(
    `select u.id, u.name, u.email, m.role from page_members m join users u on u.id = m.user_id
      where m.page_id = $1 order by case m.role when 'owner' then 0 when 'editor' then 1 when 'commenter' then 2 else 3 end, u.name`,
    [pageId],
  );
}

export async function setMemberRole(db: Db, pageId: string, userId: string, role: Exclude<Role, 'owner'> | null) {
  if (role === null) await db.query("delete from page_members where page_id = $1 and user_id = $2 and role <> 'owner'", [pageId, userId]);
  else await db.query("update page_members set role = $3 where page_id = $1 and user_id = $2 and role <> 'owner'", [pageId, userId, role]);
}

export async function createShareLink(db: Db, pageId: string, role: Exclude<Role, 'owner'>, by: string): Promise<string> {
  const token = randomBytes(18).toString('base64url');
  await db.query('insert into share_links (token, page_id, role, created_by) values ($1,$2,$3,$4)', [token, pageId, role, by]);
  return token;
}

export async function shareLinks(db: Db, pageId: string) {
  return db.query('select token, role, created_at from share_links where page_id = $1 and not revoked order by created_at desc', [pageId]);
}

export async function revokeShareLink(db: Db, pageId: string, token: string) {
  await db.query('update share_links set revoked = true where page_id = $1 and token = $2', [pageId, token]);
}

/** Opening a share link adds you to the page with the link's role (never lowers a role you already have). */
export async function acceptShareLink(db: Db, token: string, userId: string): Promise<{ pageId: string; role: Role } | null> {
  const [link] = await db.query('select page_id, role from share_links where token = $1 and not revoked', [token]);
  if (!link) return null;
  const [existing] = await db.query('select role from page_members where page_id = $1 and user_id = $2', [link.page_id, userId]);
  if (existing && atLeast(existing.role, link.role)) return { pageId: link.page_id, role: existing.role };
  await db.query(
    `insert into page_members (page_id, user_id, role) values ($1,$2,$3)
     on conflict (page_id, user_id) do update set role = excluded.role`,
    [link.page_id, userId, link.role],
  );
  return { pageId: link.page_id, role: link.role };
}

// ---------- tags ----------

/** "#Book Notes " -> "book-notes". Letters, digits, - _ and / (for nested tags like project/alpha). */
export function cleanTag(raw: unknown): string | null {
  const t = String(raw ?? '').trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_\/-]/gu, '')
    .replace(/\/{2,}/g, '/').replace(/^\/|\/$/g, '').slice(0, 60);
  return t || null;
}

export async function pageTags(db: Db, pageId: string): Promise<string[]> {
  return (await db.query('select tag from page_tags where page_id = $1 order by tag', [pageId])).map((r) => r.tag);
}

/** Replace a page's tags. Returns the cleaned, sorted list. */
export async function setPageTags(db: Db, pageId: string, raw: unknown[]): Promise<string[]> {
  const tags = [...new Set(raw.map(cleanTag).filter((t): t is string => !!t))].slice(0, 30).sort();
  await db.tx(async (q) => {
    await q('delete from page_tags where page_id = $1', [pageId]);
    for (const t of tags) await q('insert into page_tags (page_id, tag) values ($1,$2) on conflict do nothing', [pageId, t]);
  });
  await touch(db, pageId);
  return tags;
}

/** Tags on pages this person can open, with counts. */
export async function tagsFor(db: Db, userId: string): Promise<{ tag: string; count: number }[]> {
  const rows = await db.query(
    `select t.tag, count(*)::int as count from page_tags t join page_members m on m.page_id = t.page_id
      where m.user_id = $1 group by t.tag order by t.tag`,
    [userId],
  );
  return rows.map((r) => ({ tag: r.tag, count: Number(r.count) }));
}

/** Tags for each of this person's pages, as page id -> tags. */
export async function tagsByPage(db: Db, userId: string): Promise<Map<string, string[]>> {
  const rows = await db.query(
    'select t.page_id, t.tag from page_tags t join page_members m on m.page_id = t.page_id where m.user_id = $1 order by t.tag',
    [userId],
  );
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.page_id, [...(out.get(r.page_id) ?? []), r.tag]);
  return out;
}

/** Pages that link here, limited to pages this person can open. */
export async function backlinks(db: Db, who: Principal, pageId: string) {
  const rows = await db.query(
    `select distinct l.from_page as page, p.title, l.from_tab as from_tab, l.from_tab_title, l.to_tab
       from page_links l join pages p on p.id = l.from_page
      where l.to_page = $1 and l.from_page <> $1
        and ($2::boolean or exists (select 1 from page_members m where m.page_id = l.from_page and m.user_id = $3))
      order by p.title`,
    [pageId, !!who.superAgent, who.id],
  );
  return rows;
}
