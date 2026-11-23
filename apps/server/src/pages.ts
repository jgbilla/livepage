// Pages, membership, roles and share links.
import { randomBytes } from 'node:crypto';
import type { Db } from './db.ts';
import { randomId, type Principal } from './auth.ts';

export type Role = 'owner' | 'editor' | 'commenter' | 'viewer';
const RANK: Record<Role, number> = { viewer: 1, commenter: 2, editor: 3, owner: 4 };
export const atLeast = (role: Role | null, min: Role) => !!role && RANK[role] >= RANK[min];
/** Can this role change page content? Commenters will get comment-only writes in M2. */
export const canEdit = (role: Role | null) => atLeast(role, 'editor');

export const isPageId = (s: string) => /^p_[\w-]{8,40}$/.test(s);

export async function createPage(db: Db, ownerId: string, title = ''): Promise<{ id: string; title: string }> {
  const id = randomId('p', 9);
  await db.tx(async (q) => {
    await q('insert into pages (id, owner_id, title) values ($1,$2,$3)', [id, ownerId, title.slice(0, 200)]);
    await q("insert into page_members (page_id, user_id, role) values ($1,$2,'owner')", [id, ownerId]);
  });
  return { id, title };
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
    `select p.id, p.title, p.updated_at, m.role, u.name as owner_name
       from page_members m join pages p on p.id = m.page_id join users u on u.id = p.owner_id
      where m.user_id = $1 order by p.updated_at desc limit 500`,
    [userId],
  );
}

export async function pageInfo(db: Db, pageId: string) {
  const [page] = await db.query('select id, title, owner_id, updated_at from pages where id = $1', [pageId]);
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
