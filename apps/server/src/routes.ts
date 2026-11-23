// HTTP API for the web app and for agents. Mounted under /api by index.ts.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Hocuspocus } from '@hocuspocus/server';
import type { Db } from './db.ts';
import {
  bearer, clearCookie, createApiToken, createSession, createUser, destroySession, login, readCookie, resolvePrincipal,
  randomId, sessionCookie, validateSignup, type Principal,
} from './auth.ts';
import {
  acceptShareLink, atLeast, backlinks, canEdit, cleanTag, createPage, createShareLink, dailyPage, deletePage, isPageId, listPages, members,
  pageInfo, pageTags, revokeShareLink, roleFor, setMemberRole, setPageTags, setTitle, shareLinks, tagsByPage, tagsFor, type Role,
} from './pages.ts';
import {
  cleanName, createFolder, dailySegments, deleteFolder, ensureFolderPath, folderAtPath, folderPaths, FolderError, isFolderId,
  listFolders, movePage, splitPath, updateFolder,
} from './folders.ts';
import * as Y from 'yjs';
import { META } from '@livepage/schema';
import { handleContent, readJson, send } from './agent-api.ts';
import { linkGraph, searchPages } from './search.ts';
import { config } from './config.ts';
import { handleAiApi, handleAssistantRun } from './assistant/http.ts';
import { createAgentRequest, handleAgentRequests, touchAgent } from './agent-requests.ts';
import { neonAuthEnabled, userForNeonIdentity, verifyNeonToken } from './neon-auth.ts';

const CONTENT = new Set(['content', 'paragraphs', 'headings', 'html-blocks', 'ui', 'tables', 'mind-maps', 'actions', 'tabs']);
const SHARE_ROLES = new Set(['editor', 'commenter', 'viewer']);

// Tiny in-memory rate limit for login/signup (per IP). Good enough for one server instance.
const attempts = new Map<string, { n: number; reset: number }>();
function limited(ip: string, max = 10, windowMs = 60_000): boolean {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.reset < now) { attempts.set(ip, { n: 1, reset: now + windowMs }); return false; }
  return ++a.n > max;
}
const clientIp = (req: IncomingMessage) =>
  (config.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '') || req.socket.remoteAddress || '?';

/** Reject cross-site writes that ride on the session cookie. */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients (agents) send no Origin
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

export async function handleApi(req: IncomingMessage, res: ServerResponse, db: Db, hp: Hocuspocus): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  const path = url.pathname.replace(/\/+$/, '');
  const method = req.method ?? 'GET';
  const secure = config.secureCookies;

  if (method !== 'GET' && method !== 'HEAD' && !sameOrigin(req)) return send(res, 403, { error: 'cross-site request blocked' });

  try {
    // ---------- public ----------
    if (path === '/api/health') return send(res, 200, { ok: true });
    if (path === '/api/config') {
      return send(res, 200, { sandboxUrl: config.sandboxUrl, signupOpen: config.signupOpen, neonAuthUrl: neonAuthEnabled() ? config.neonAuthUrl : null });
    }

    if (path === '/api/auth/signup' && method === 'POST') {
      if (!config.signupOpen) return send(res, 403, { error: 'Sign-ups are closed on this server.' });
      if (limited(clientIp(req))) return send(res, 429, { error: 'Too many attempts. Try again in a minute.' });
      const b = await readJson(req);
      const problem = validateSignup(b.email, b.name, b.password);
      if (problem) return send(res, 400, { error: problem });
      const [taken] = await db.query('select 1 from users where email = $1', [String(b.email).trim().toLowerCase()]);
      if (taken) return send(res, 409, { error: 'An account with this email already exists. Log in instead.' });
      const user = await createUser(db, b.email, b.name, b.password);
      const raw = await createSession(db, user.id);
      return send(res, 201, { user }, { 'Set-Cookie': sessionCookie(raw, secure) });
    }

    if (path === '/api/auth/login' && method === 'POST') {
      if (limited(clientIp(req))) return send(res, 429, { error: 'Too many attempts. Try again in a minute.' });
      const b = await readJson(req);
      const user = await login(db, b.email, b.password);
      if (!user) return send(res, 401, { error: 'Wrong email or password.' });
      const raw = await createSession(db, user.id);
      return send(res, 200, { user }, { 'Set-Cookie': sessionCookie(raw, secure) });
    }

    // Exchange a Neon Auth JWT (after "Continue with Google") for a Livepage session.
    if (path === '/api/auth/neon' && method === 'POST') {
      if (!neonAuthEnabled()) return send(res, 404, { error: 'Neon Auth is not configured on this server.' });
      if (limited(clientIp(req))) return send(res, 429, { error: 'Too many attempts. Try again in a minute.' });
      const b = await readJson(req);
      let claims;
      try { claims = await verifyNeonToken(String(b.token ?? '')); }
      catch (e) { return send(res, 401, { error: `Sign-in could not be verified (${(e as Error).message}).` }); }
      const [known] = await db.query('select 1 from users where neon_auth_id = $1 or email = $2', [String(claims.sub), String(claims.email ?? '').toLowerCase()]);
      if (!known && !config.signupOpen) return send(res, 403, { error: 'Sign-ups are closed on this server.' });
      try {
        const user = await userForNeonIdentity(db, claims);
        const raw = await createSession(db, user.id);
        return send(res, 200, { user }, { 'Set-Cookie': sessionCookie(raw, secure) });
      } catch (e) {
        return send(res, 409, { error: (e as Error).message });
      }
    }

    if (path === '/api/auth/logout' && method === 'POST') {
      const raw = readCookie(req.headers.cookie);
      if (raw) await destroySession(db, raw);
      return send(res, 200, { ok: true }, { 'Set-Cookie': clearCookie(secure) });
    }

    // ---------- signed in (cookie or agent token) ----------
    const who = await resolvePrincipal(db, { cookie: req.headers.cookie, token: bearer(req) });
    if (path === '/api/me' && method === 'GET' && !who) return send(res, 200, { user: null }); // signed out is a normal state
    if (!who) return send(res, 401, { error: 'Sign in first.' });
    touchAgent(who);
    if ((path === '/api/agents' || path.startsWith('/api/agent-requests')) && (await handleAgentRequests(req, res, db, who, url, path))) return;

    if (path === '/api/me' && method === 'GET') return send(res, 200, { user: { id: who.id, name: who.name, email: who.email }, kind: who.kind });

    // Agent tokens are managed by people only (an agent cannot mint more tokens).
    if (path === '/api/tokens') {
      if (who.kind !== 'human') return send(res, 403, { error: 'Only people can manage agent tokens.' });
      if (method === 'GET') {
        return send(res, 200, { tokens: await db.query('select id, name, created_at, last_used_at from api_tokens where user_id = $1 order by created_at desc', [who.id]) });
      }
      if (method === 'POST') {
        const b = await readJson(req);
        const t = await createApiToken(db, who.id, String(b.name ?? 'Agent'));
        return send(res, 201, t);
      }
    }
    const tokenDel = path.match(/^\/api\/tokens\/(tok_[\w-]+)$/);
    if (tokenDel && method === 'DELETE') {
      if (who.kind !== 'human') return send(res, 403, { error: 'Only people can manage agent tokens.' });
      await db.query('delete from api_tokens where id = $1 and user_id = $2', [tokenDel[1], who.id]);
      return send(res, 200, { ok: true });
    }

    if (path.startsWith('/api/ai/')) return handleAiApi(req, res, db, who, path);

    if (path === '/api/pages' && method === 'GET') {
      if (who.superAgent) return send(res, 200, { pages: await db.query('select id, title, updated_at from pages order by updated_at desc limit 500') });
      return send(res, 200, await workspace(db, who.id, url));
    }
    if (path === '/api/pages' && method === 'POST') {
      if (who.superAgent) return send(res, 400, { error: 'Use a personal agent token to create pages.' });
      const b = await readJson(req);
      const where = await placement(b);
      if ('error' in where) return send(res, 400, { error: where.error });
      const page = await createPage(db, who.id, String(b.title ?? ''), where);
      const tags = Array.isArray(b.tags) ? await setPageTags(db, page.id, b.tags) : [];
      return send(res, 201, { page: { ...page, tags } });
    }

    // Full-text search over every page you can open: title, tags and block text (?q=words&limit=20).
    if (path === '/api/search' && method === 'GET') {
      const q = (url.searchParams.get('q') ?? '').slice(0, 300);
      const limit = Number(url.searchParams.get('limit') ?? 20) || 20;
      return send(res, 200, { query: q, results: await searchPages(db, who, q, limit) });
    }
    // Every page you can open and the links between them (for the graph view).
    if (path === '/api/graph' && method === 'GET') return send(res, 200, await linkGraph(db, who));

    // Today's page: folder YYYY/MM/DD, page "daily". The browser sends its local date.
    if (path === '/api/daily' && method === 'POST') {
      if (who.superAgent) return send(res, 400, { error: 'Use a personal agent token for daily pages.' });
      const b = await readJson(req);
      const segments = dailySegments(b.date);
      if (!segments) return send(res, 400, { error: 'date must be YYYY-MM-DD' });
      const r = await dailyPage(db, who.id, segments);
      return send(res, r.created ? 201 : 200, { page: { id: r.id, title: 'daily', path: segments.join('/') }, created: r.created });
    }

    // ---------- folders (each person's own tree) ----------
    if (path.startsWith('/api/folders') || path === '/api/tags') {
      if (who.superAgent) return send(res, 400, { error: 'Folders and tags need a personal agent token.' });
    }
    if (path.startsWith('/api/views') && who.superAgent) return send(res, 400, { error: 'Views need a personal agent token.' });
    if (path === '/api/views' && method === 'GET') return send(res, 200, { views: await listViews(db, who.id) });
    if (path === '/api/views' && method === 'POST') {
      const v = viewInput(await readJson(req));
      if ('error' in v) return send(res, 400, { error: v.error });
      const id = randomId('v', 9);
      await db.query('insert into views (id, owner_id, name, tags, match) values ($1,$2,$3,$4,$5)', [id, who.id, v.name, JSON.stringify(v.tags), v.match]);
      return send(res, 201, { view: { id, ...v } });
    }
    const viewM = path.match(/^\/api\/views\/(v_[\w-]{8,40})$/);
    if (viewM && method === 'PATCH') {
      const [cur] = await db.query('select name, tags, match from views where id = $1 and owner_id = $2', [viewM[1], who.id]);
      if (!cur) return send(res, 404, { error: 'View not found.' });
      const v = viewInput({ ...cur, ...(await readJson(req)) });
      if ('error' in v) return send(res, 400, { error: v.error });
      await db.query('update views set name = $3, tags = $4, match = $5 where id = $1 and owner_id = $2', [viewM[1], who.id, v.name, JSON.stringify(v.tags), v.match]);
      return send(res, 200, { view: { id: viewM[1], ...v } });
    }
    if (viewM && method === 'DELETE') {
      await db.query('delete from views where id = $1 and owner_id = $2', [viewM[1], who.id]);
      return send(res, 200, { ok: true });
    }
    if (path === '/api/tags' && method === 'GET') return send(res, 200, { tags: await tagsFor(db, who.id) });
    if (path === '/api/folders' && method === 'GET') {
      const folders = await listFolders(db.query, who.id);
      const paths = folderPaths(folders);
      return send(res, 200, { folders: folders.map((f) => ({ ...f, path: paths.get(f.id) })) });
    }
    if (path === '/api/folders' && method === 'POST') {
      const b = await readJson(req);
      if (b.path !== undefined) {
        // mkdir -p
        const segments = splitPath(b.path);
        if (!segments?.length) return send(res, 400, { error: 'path must look like "Projects/Book" (no empty parts)' });
        const id = await db.tx((q) => ensureFolderPath(q, who.id, segments));
        return send(res, 201, { folder: { id, path: segments.join('/') } });
      }
      const name = cleanName(b.name);
      if (!name) return send(res, 400, { error: 'Folder names cannot be empty or contain "/".' });
      const parent = b.parent_id ? String(b.parent_id) : null;
      return send(res, 201, { folder: await createFolder(db, who.id, name, parent) });
    }
    const folderM = path.match(/^\/api\/folders\/([\w-]+)$/);
    if (folderM && isFolderId(folderM[1])) {
      if (method === 'PATCH') {
        const b = await readJson(req);
        const patch: { name?: string; parentId?: string | null } = {};
        if (b.name !== undefined) {
          const name = cleanName(b.name);
          if (!name) return send(res, 400, { error: 'Folder names cannot be empty or contain "/".' });
          patch.name = name;
        }
        if (b.parent_id !== undefined) patch.parentId = b.parent_id ? String(b.parent_id) : null;
        return send(res, 200, { folder: await updateFolder(db, who.id, folderM[1], patch) });
      }
      if (method === 'DELETE') {
        return (await deleteFolder(db, who.id, folderM[1])) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'Folder not found.' });
      }
    }

    const share = path.match(/^\/api\/share\/([\w-]{10,64})$/);
    if (share && method === 'POST') {
      if (who.superAgent) return send(res, 400, { error: 'not for the dev agent' });
      const r = await acceptShareLink(db, share[1], who.id);
      return r ? send(res, 200, r) : send(res, 404, { error: 'This share link is invalid or was turned off.' });
    }

    const m = path.match(/^\/api\/pages\/([\w-]+)(?:\/([\w-]+)(?:\/([\w-]+))?)?$/);
    if (m && isPageId(m[1])) {
      const [, pageId, sub, id] = m;
      const role = await roleFor(db, who, pageId);
      if (!role) return send(res, 404, { error: 'Page not found, or you do not have access.' });
      return pageRoutes({ req, res, db, hp, url, who, role, pageId, sub, id, method });
    }

    return send(res, 404, { error: 'not found' });
  } catch (e) {
    const msg = (e as Error).message;
    if (e instanceof FolderError) return send(res, e.status, { error: msg });
    if (msg === 'body too large' || e instanceof SyntaxError) return send(res, 400, { error: msg });
    console.error('[api]', e);
    return send(res, 500, { error: 'server error' });
  }
}

type PageCtx = {
  req: IncomingMessage; res: ServerResponse; db: Db; hp: Hocuspocus; url: URL; who: Principal; role: Role;
  pageId: string; sub?: string; id?: string; method: string;
};

async function pageRoutes(c: PageCtx): Promise<void> {
  const { req, res, db, hp, url, who, role, pageId, sub, id, method } = c;

  if (!sub && method === 'GET') {
    const [m] = who.superAgent ? [] : await db.query('select folder_id from page_members where page_id = $1 and user_id = $2', [pageId, who.id]);
    const folderId: string | null = m?.folder_id ?? null;
    const folderPath = folderId && !who.superAgent ? folderPaths(await listFolders(db.query, who.id)).get(folderId) ?? '' : '';
    return send(res, 200, { page: { ...(await pageInfo(db, pageId)), folder_id: folderId, path: folderPath, tags: await pageTags(db, pageId) }, role });
  }

  // Rename, move (in your own tree) and retag. Moving is yours alone, so any role can do it.
  if (!sub && method === 'PATCH') {
    const b = await readJson(req);
    if (b.folder_id !== undefined || b.path !== undefined) {
      if (who.superAgent) return send(res, 400, { error: 'Moving pages needs a personal agent token.' });
      const where = await placement(b);
      if ('error' in where) return send(res, 400, { error: where.error });
      await db.tx(async (q) => {
        const folderId = where.path ? await ensureFolderPath(q, who.id, where.path) : where.folderId ?? null;
        await movePage(q, who.id, pageId, folderId);
      });
    }
    if (b.title !== undefined || b.tags !== undefined) {
      if (!canEdit(role)) return send(res, 403, { error: 'You can only view this page.' });
    }
    if (b.title !== undefined) await renamePage(hp, db, pageId, String(b.title), who);
    if (b.tags !== undefined) {
      if (!Array.isArray(b.tags)) return send(res, 400, { error: 'tags must be a list' });
      await setPageTags(db, pageId, b.tags);
    }
    return send(res, 200, { ok: true });
  }

  if (sub === 'backlinks' && method === 'GET') return send(res, 200, { backlinks: await backlinks(db, who, pageId) });

  if (sub === 'tags') {
    if (method === 'GET') return send(res, 200, { tags: await pageTags(db, pageId) });
    if (!canEdit(role)) return send(res, 403, { error: 'You can only view this page.' });
    const b = method === 'DELETE' ? {} : await readJson(req);
    const current = await pageTags(db, pageId);
    if (method === 'PUT') {
      if (!Array.isArray(b.tags)) return send(res, 400, { error: 'tags must be a list' });
      return send(res, 200, { tags: await setPageTags(db, pageId, b.tags) });
    }
    if (method === 'POST') return send(res, 200, { tags: await setPageTags(db, pageId, [...current, ...(Array.isArray(b.tags) ? b.tags : [b.tag])]) });
    if (method === 'DELETE' && id) return send(res, 200, { tags: await setPageTags(db, pageId, current.filter((t) => t !== cleanTag(id))) });
  }
  if (!sub && method === 'DELETE') {
    if (role !== 'owner') return send(res, 403, { error: 'Only the owner can delete a page.' });
    await deletePage(db, pageId);
    return send(res, 200, { ok: true });
  }

  if (sub === 'members') {
    if (method === 'GET') return send(res, 200, { members: await members(db, pageId) });
    if (!atLeast(role, 'owner')) return send(res, 403, { error: 'Only the owner can change who has access.' });
    if (method === 'PUT' && id) {
      const b = await readJson(req);
      const next = b.role === null ? null : String(b.role);
      if (next !== null && !SHARE_ROLES.has(next)) return send(res, 400, { error: 'bad role' });
      await setMemberRole(db, pageId, id, next as Exclude<Role, 'owner'> | null);
      return send(res, 200, { members: await members(db, pageId) });
    }
  }

  if (sub === 'share-links') {
    if (!atLeast(role, 'owner')) return send(res, 403, { error: 'Only the owner can manage share links.' });
    if (method === 'GET') return send(res, 200, { links: await shareLinks(db, pageId) });
    if (method === 'POST') {
      const b = await readJson(req);
      if (!SHARE_ROLES.has(b.role)) return send(res, 400, { error: 'role must be editor, commenter or viewer' });
      return send(res, 201, { token: await createShareLink(db, pageId, b.role, who.id) });
    }
    if (method === 'DELETE' && id) {
      await revokeShareLink(db, pageId, id);
      return send(res, 200, { ok: true });
    }
  }

  if (sub === 'agent-requests' && !id && method === 'POST') return createAgentRequest(req, res, db, who, pageId);
  if (sub === 'assistant' && !id) return handleAssistantRun(req, res, db, who, pageId, canEdit(role));

  if (sub && CONTENT.has(sub)) {
    return handleContent({
      req, res, hp, url, page: pageId, collection: sub === 'content' ? undefined : sub, id,
      who: { id: who.id, name: who.name, kind: who.kind }, writable: canEdit(role),
    });
  }

  return send(res, 404, { error: 'not found' });
}

/** Where a new or moved page goes: { folder_id } (null = top level) or { path: "a/b" } (created if missing). */
async function placement(b: any): Promise<{ folderId?: string | null; path?: string[] } | { error: string }> {
  if (b.path !== undefined && b.path !== null) {
    const segments = splitPath(b.path);
    if (!segments) return { error: 'path must look like "Projects/Book" (no empty parts)' };
    return { path: segments };
  }
  if (b.folder_id !== undefined) {
    const folderId = b.folder_id ? String(b.folder_id) : null;
    if (folderId && !isFolderId(folderId)) return { error: 'bad folder_id' };
    return { folderId };
  }
  return {};
}

/** Everything the sidebar needs: folders, pages (with folder, path and tags) and tag counts. ?path= and ?tag= filter pages. */
async function workspace(db: Db, userId: string, url: URL) {
  const [folders, pages, tagMap, tags] = await Promise.all([
    listFolders(db.query, userId), listPages(db, userId), tagsByPage(db, userId), tagsFor(db, userId),
  ]);
  const paths = folderPaths(folders);
  let out = pages.map((p: any) => ({ ...p, path: p.folder_id ? paths.get(p.folder_id) ?? '' : '', tags: tagMap.get(p.id) ?? [] }));
  const wantPath = url.searchParams.get('path');
  if (wantPath !== null) {
    const segments = splitPath(wantPath) ?? [];
    const folderId = segments.length ? await folderAtPath(db.query, userId, segments) : null;
    out = segments.length && !folderId ? [] : out.filter((p) => p.folder_id === folderId);
  }
  // ?tag=a&tag=b (or ?tag=a,b) with ?match=all|any (default any). A tag also matches its nested tags (a/x).
  const wantTags = url.searchParams.getAll('tag').flatMap((t) => t.split(',')).map(cleanTag).filter((t): t is string => !!t);
  if (wantTags.length) out = out.filter((p) => matchesTags(p.tags, wantTags, url.searchParams.get('match') === 'all' ? 'all' : 'any'));
  return { pages: out, folders: folders.map((f) => ({ ...f, path: paths.get(f.id) })), tags, views: await listViews(db, userId) };
}

/** Title lives in the live document (so open editors update at once) and in pages.title (for lists). */
async function renamePage(hp: Hocuspocus, db: Db, pageId: string, title: string, who: Principal) {
  title = title.slice(0, 200);
  const conn = await hp.openDirectConnection(pageId, { user: { id: who.id, name: who.name, kind: who.kind } });
  try {
    await conn.transact((d) => { (d as unknown as Y.Doc).getMap(META).set('title', title); });
  } finally {
    await conn.disconnect();
  }
  await setTitle(db, pageId, title);
}

export function matchesTags(pageTags: string[], want: string[], match: 'any' | 'all'): boolean {
  const has = (w: string) => pageTags.some((t) => t === w || t.startsWith(`${w}/`));
  return match === 'all' ? want.every(has) : want.some(has);
}

async function listViews(db: Db, userId: string) {
  const rows = await db.query('select id, name, tags, match from views where owner_id = $1 order by lower(name)', [userId]);
  return rows.map((r) => ({ ...r, tags: typeof r.tags === 'string' ? JSON.parse(r.tags) : r.tags }));
}

function viewInput(b: any): { name: string; tags: string[]; match: 'any' | 'all' } | { error: string } {
  const name = String(b.name ?? '').trim().slice(0, 80);
  if (!name) return { error: 'A view needs a name.' };
  const raw = Array.isArray(b.tags) ? b.tags : typeof b.tags === 'string' ? b.tags.split(/[,\s]+/) : [];
  const tags = [...new Set(raw.map(cleanTag).filter(Boolean))].slice(0, 20) as string[];
  if (!tags.length) return { error: 'Pick at least one tag for the view.' };
  return { name, tags, match: b.match === 'all' ? 'all' : 'any' };
}
