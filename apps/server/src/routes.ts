// HTTP API for the web app and for agents. Mounted under /api by index.ts.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Hocuspocus } from '@hocuspocus/server';
import type { Db } from './db.ts';
import {
  bearer, clearCookie, createApiToken, createSession, createUser, destroySession, login, readCookie, resolvePrincipal,
  randomId, sessionCookie, SignupClosedError, validateSignup, type Principal,
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
import { sameOrigin } from './origin.ts';
import { getLinks, saveLinks } from './workspace-links.ts';
import { handleAiApi, handleAssistantRun } from './assistant/http.ts';
import { createAgentRequest, handleAgentRequests, touchAgent } from './agent-requests.ts';
import { handleChat } from './chats.ts';
import { handleAgentEvents } from './agent-push.ts';
import { handleTasks } from './tasks.ts';
import { handleWake, wakeSummaries } from './agent-wake.ts';
import { bumpWorkspace, handleWorkspaceEvents, workspaceRev } from './workspace-events.ts';
import {
  HttpError, createComment, deleteComment, isCommentId, listMentions, markMentionDone, mentionables, setWebhook, threadsWithText,
  updateComment, waitForMention,
} from './comments.ts';
import { neonAuthEnabled, userForNeonIdentity, verifyNeonToken } from './neon-auth.ts';
import { dailyTemplateFor, fillFromTemplate, listTemplates, setDailyTemplate, setTemplateFlag, titleFromTemplate } from './templates.ts';
import { noteTimeZone, personClock } from './clock.ts';
import { exportPage, exportVault, IMPORT_LIMITS, importFiles } from './transfer.ts';
import { publishPage, unpublishPage } from './publish.ts';
import { readDoc, writeDoc } from './docs.ts';
import { fillFields, listFields } from '@livepage/schema';

const CONTENT = new Set(['footnotes', 'content', 'paragraphs', 'headings', 'html-blocks', 'ui', 'tables', 'mind-maps', 'actions', 'tabs', 'outline', 'blocks', 'move', 'replace-text']);
const SHARE_ROLES = new Set(['editor', 'commenter', 'viewer']);

// Tiny in-memory rate limits for login/signup. Good enough for one server instance.
// Per IP (10 a minute) and, for logins, per account (10 wrong passwords per 15 minutes), because
// the IP comes from X-Forwarded-For behind a proxy and a client can put anything at its front.
export const attempts = new Map<string, { n: number; reset: number }>();
export function limited(key: string, max = 10, windowMs = 60_000): boolean {
  const now = Date.now();
  if (attempts.size > 50_000) for (const [k, a] of attempts) if (a.reset < now) attempts.delete(k); // stay small
  if (attempts.size > 50_000) attempts.clear();
  const a = attempts.get(key);
  if (!a || a.reset < now) { attempts.set(key, { n: 1, reset: now + windowMs }); return false; }
  return ++a.n > max;
}
const LOGIN_FAILS = { max: 10, windowMs: 15 * 60_000 };
const loginKey = (email: unknown) => `login:${String(email ?? '').trim().toLowerCase().slice(0, 254)}`;
/** Has this account had too many wrong passwords lately? (Does not count this attempt.) */
function accountLocked(email: unknown): boolean {
  const a = attempts.get(loginKey(email));
  return !!a && a.reset >= Date.now() && a.n >= LOGIN_FAILS.max;
}
const clientIp = (req: IncomingMessage) =>
  (config.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '') || req.socket.remoteAddress || '?';

/** Reject cross-site writes that ride on the session cookie (see origin.ts). */
const isSameOrigin = (req: IncomingMessage) => sameOrigin(req.headers.origin, req.headers.host);

const SIGNUP_CLOSED = new SignupClosedError().message;

/** Can a new account be created right now? (config.signupMode) */
let hasAccounts = false; // once true it stays true: accounts are never all deleted while running
export async function signupOpen(db: Db): Promise<boolean> {
  if (config.signupMode !== 'first-account') return config.signupMode === 'open';
  if (hasAccounts) return false;
  const [row] = await db.query('select exists (select 1 from users) as any');
  hasAccounts = !!row?.any;
  return !hasAccounts;
}

export async function handleApi(req: IncomingMessage, res: ServerResponse, db: Db, hp: Hocuspocus): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  const path = url.pathname.replace(/\/+$/, '');
  const method = req.method ?? 'GET';
  const secure = config.secureCookies;

  if (method !== 'GET' && method !== 'HEAD' && !isSameOrigin(req)) return send(res, 403, { error: 'cross-site request blocked' });

  try {
    // ---------- public ----------
    if (path === '/api/health') return send(res, 200, { ok: true });
    if (path === '/api/config') {
      return send(res, 200, { sandboxUrl: config.sandboxUrl, signupOpen: await signupOpen(db), neonAuthUrl: neonAuthEnabled() ? config.neonAuthUrl : null });
    }

    if (path === '/api/auth/signup' && method === 'POST') {
      if (!(await signupOpen(db))) return send(res, 403, { error: SIGNUP_CLOSED });
      if (limited(clientIp(req))) return send(res, 429, { error: 'Too many attempts. Try again in a minute.' });
      const b = await readJson(req);
      const problem = validateSignup(b.email, b.name, b.password);
      if (problem) return send(res, 400, { error: problem });
      const [taken] = await db.query('select 1 from users where email = $1', [String(b.email).trim().toLowerCase()]);
      if (taken) return send(res, 409, { error: 'An account with this email already exists. Log in instead.' });
      let user;
      try { user = await createUser(db, b.email, b.name, b.password); }
      catch (e) { if (e instanceof SignupClosedError) return send(res, 403, { error: e.message }); throw e; }
      const raw = await createSession(db, user.id);
      return send(res, 201, { user }, { 'Set-Cookie': sessionCookie(raw, secure) });
    }

    if (path === '/api/auth/login' && method === 'POST') {
      if (limited(clientIp(req))) return send(res, 429, { error: 'Too many attempts. Try again in a minute.' });
      const b = await readJson(req);
      if (accountLocked(b.email)) return send(res, 429, { error: 'Too many wrong passwords for this account. Try again in 15 minutes, or continue with Google.' });
      const user = await login(db, b.email, b.password);
      if (!user) {
        limited(loginKey(b.email), LOGIN_FAILS.max, LOGIN_FAILS.windowMs);
        return send(res, 401, { error: 'Wrong email or password.' });
      }
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
      if (!known && !(await signupOpen(db))) return send(res, 403, { error: SIGNUP_CLOSED });
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
    // The browser reports its time zone, so agents can file new pages by the person's own day.
    if (who.kind === 'human') void noteTimeZone(db, who.id, req.headers['x-time-zone']);
    // Any change you make (from any device, or through your agents) refreshes your page list everywhere.
    // (The task board has its own counter, bumped by tasks.ts, so a task note doesn't reload the page list.)
    if (method !== 'GET' && method !== 'HEAD' && !who.superAgent && !path.startsWith('/api/tasks')) {
      res.on('finish', () => { if (res.statusCode < 400) bumpWorkspace(who.id); });
    }
    if (path === '/api/workspace/events' && method === 'GET') return handleWorkspaceEvents(req, res, who.id, url);
    if (path === '/api/agent-events' && method === 'GET') return handleAgentEvents(req, res, db, who);
    if (path.startsWith('/api/tasks') && (await handleTasks(req, res, db, who, url, path))) return;
    if ((path === '/api/agents' || path === '/api/agents/target' || path.startsWith('/api/agent-requests')) && (await handleAgentRequests(req, res, db, who, url, path))) return;

    if (path === '/api/me' && method === 'GET') return send(res, 200, { user: { id: who.id, name: who.name, email: who.email }, kind: who.kind });
    // The workspace switcher's list (your other Livepage copies). People only: agents never need it.
    if (path === '/api/me/workspaces') {
      if (who.kind !== 'human') return send(res, 403, { error: 'Only people have a workspace list.' });
      if (method === 'GET') return send(res, 200, { links: await getLinks(db, who.id) });
      if (method === 'PUT') return send(res, 200, { links: await saveLinks(db, who.id, (await readJson(req)).links) });
    }

    // Agent tokens are managed by people only (an agent cannot mint more tokens).
    if (path === '/api/tokens') {
      if (who.kind !== 'human') return send(res, 403, { error: 'Only people can manage agent tokens.' });
      if (method === 'GET') {
        const tokens = await db.query('select id, name, created_at, last_used_at, webhook_url from api_tokens where user_id = $1 order by created_at desc', [who.id]);
        const wakes = await wakeSummaries(db, who.id);
        return send(res, 200, { tokens: tokens.map((t) => ({ ...t, wake: wakes.get(t.id) ?? null })) });
      }
      if (method === 'POST') {
        const b = await readJson(req);
        const t = await createApiToken(db, who.id, String(b.name ?? 'Agent'));
        return send(res, 201, t);
      }
    }
    if (path.startsWith('/api/tokens/') && (await handleWake(req, res, db, hp, who, path, (id) => dropConnections(hp, (c) => c?.user?.tokenId === id)))) return;
    const tokenDel = path.match(/^\/api\/tokens\/(tok_[\w-]+)$/);
    if (tokenDel && method === 'DELETE') {
      if (who.kind !== 'human') return send(res, 403, { error: 'Only people can manage agent tokens.' });
      const gone = await db.query('delete from api_tokens where id = $1 and user_id = $2 returning id', [tokenDel[1], who.id]);
      if (gone.length) dropConnections(hp, (c) => c?.user?.tokenId === tokenDel[1]); // a deleted token stops working at once
      return send(res, 200, { ok: true });
    }
    // Optional webhook, called when someone @mentions this agent in a comment.
    if (tokenDel && method === 'PATCH') {
      if (who.kind !== 'human') return send(res, 403, { error: 'Only people can manage agent tokens.' });
      const b = await readJson(req);
      // Rename: the name this agent shows on pages (avatar, caret, comments).
      if (typeof b.name === 'string') {
        const name = b.name.trim().slice(0, 80);
        if (!name) return send(res, 400, { error: 'Give the agent a name.' });
        const done = await db.query('update api_tokens set name = $3 where id = $1 and user_id = $2 returning id', [tokenDel[1], who.id, name]);
        if (!done.length) return send(res, 404, { error: 'No such token.' });
        // Agents already on a page switch to the new name with their next presence update (at most ~15s).
        hp.documents.forEach((doc) => {
          for (const conn of doc.getConnections()) if (conn.context?.user?.tokenId === tokenDel[1]) conn.context.user.name = name;
        });
        if (!('webhook_url' in b)) return send(res, 200, { ok: true, name });
      }
      return send(res, 200, await setWebhook(db, who.id, tokenDel[1], b.webhook_url ?? null));
    }

    // Mentions inbox: comments that @mention you (people) or this agent token (agents).
    // ?wait=<seconds> long-polls up to 60s for a new one when there are none.
    if (path === '/api/mentions' && method === 'GET') {
      const all = url.searchParams.get('all') === '1';
      let list = await listMentions(db, who, all);
      const wait = Math.min(60, Math.max(0, Number(url.searchParams.get('wait')) || 0));
      if (!list.length && wait && !all) {
        await waitForMention(who, wait * 1000);
        list = await listMentions(db, who);
      }
      return send(res, 200, { mentions: list });
    }
    const mentionDone = path.match(/^\/api\/mentions\/(mn_[\w-]+)\/done$/);
    if (mentionDone && method === 'POST') {
      await markMentionDone(db, who, mentionDone[1]);
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
      const placed = await placement(b);
      if ('error' in placed) return send(res, 400, { error: placed.error });
      const clock = await personClock(db, who.id, b);
      // Not told where: today's daily folder YYYY/MM/DD (the person's local date), next to the daily page.
      const where = 'path' in placed || 'folderId' in placed ? placed : { path: dailySegments(clock.date)! };
      // From a template: a copy of it, with {{date}}, {{title}}... filled in. Any template you can open works.
      let template: { id: string; title: string } | null = null;
      if (b.template_id) {
        const tid = String(b.template_id);
        const [t] = isPageId(tid) && (await roleFor(db, who, tid))
          ? await db.query('select id, title from pages where id = $1 and is_template', [tid]) : [];
        if (!t) return send(res, 404, { error: 'Template not found.' });
        template = t;
      }
      const title = b.title !== undefined && b.title !== null && String(b.title) !== ''
        ? String(b.title)
        : template ? titleFromTemplate(template.title, { ...clock, title: '' }) : '';
      const page = await createPage(db, who.id, title, where);
      if (template) await fillFromTemplate(hp, db, who, page.id, template.id, { ...clock, title });
      const tags = Array.isArray(b.tags) ? await setPageTags(db, page.id, b.tags) : await pageTags(db, page.id);
      const folderPath = page.folder_id ? (folderPaths(await listFolders(db.query, who.id)).get(page.folder_id) ?? '') : '';
      return send(res, 201, { page: { ...page, title, tags, path: folderPath } });
    }

    // Full-text search over every page you can open: title, tags and block text (?q=words&limit=20).
    if (path === '/api/search' && method === 'GET') {
      const q = (url.searchParams.get('q') ?? '').slice(0, 300);
      const limit = Number(url.searchParams.get('limit') ?? 20) || 20;
      return send(res, 200, { query: q, results: await searchPages(db, who, q, limit) });
    }
    // Every page you can open and the links between them (for the graph view).
    if (path === '/api/graph' && method === 'GET') return send(res, 200, await linkGraph(db, who));

    // Today's page: folder YYYY/MM/DD, page "daily". The browser sends its local date; without one, the person's own today.
    if (path === '/api/daily' && method === 'POST') {
      if (who.superAgent) return send(res, 400, { error: 'Use a personal agent token for daily pages.' });
      const b = await readJson(req);
      if (b.date !== undefined && b.date !== null && !dailySegments(b.date)) return send(res, 400, { error: 'date must be YYYY-MM-DD' });
      const clock = await personClock(db, who.id, b);
      const segments = dailySegments(clock.date)!;
      const r = await dailyPage(db, who.id, segments);
      if (r.created) {
        const tid = await dailyTemplateFor(db, who.id);
        if (tid) await fillFromTemplate(hp, db, who, r.id, tid, { ...clock, title: 'daily' });
      }
      return send(res, r.created ? 201 : 200, { page: { id: r.id, title: 'daily', path: segments.join('/') }, created: r.created });
    }

    // ---------- templates ----------
    if (path === '/api/templates' && method === 'GET') {
      if (who.superAgent) return send(res, 200, { templates: [], daily_template_id: null });
      return send(res, 200, await listTemplates(db, who.id));
    }
    if (path === '/api/templates/daily' && method === 'PUT') {
      if (who.superAgent) return send(res, 400, { error: 'Use a personal agent token.' });
      const b = await readJson(req);
      const id = b.page_id ? String(b.page_id) : null;
      if (id && !isPageId(id)) return send(res, 400, { error: 'bad page_id' });
      if (!(await setDailyTemplate(db, who.id, id))) return send(res, 404, { error: 'That page is not a template you can open.' });
      return send(res, 200, { daily_template_id: id });
    }

    // ---------- import / export ----------
    if (path === '/api/export' && method === 'GET') {
      if (who.superAgent) return send(res, 400, { error: 'Use a personal agent token.' });
      const zip = await exportVault(hp, db, who.id);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="livepage-${new Date().toISOString().slice(0, 10)}.zip"`,
        'Cache-Control': 'no-store',
      });
      res.end(Buffer.from(zip));
      return;
    }
    if (path === '/api/import' && method === 'POST') {
      if (who.superAgent) return send(res, 400, { error: 'Use a personal agent token to import.' });
      const b = await readJson(req, IMPORT_LIMITS.bytes);
      if (!Array.isArray(b.files) || !b.files.length) return send(res, 400, { error: 'files must be a list of { path, content }' });
      // No `into`: today's daily folder, like any new page. "" = the top level.
      const into = b.into === undefined || b.into === null
        ? dailySegments((await personClock(db, who.id, b)).date)
        : splitPath(b.into);
      if (!into) return send(res, 400, { error: 'into must look like "Imported/Vault"' });
      const report = await importFiles(hp, db, { id: who.id, name: who.name, kind: who.kind }, b.files, into);
      return send(res, 201, report);
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
      // Renames, tags, sharing and deletes show in everyone's page list who has the page (looked
      // up first: deleting the page removes its members).
      if (method !== 'GET' && method !== 'HEAD' && sub !== 'chat' && sub !== 'assistant' && sub !== 'agent-requests') {
        const members = (await db.query<{ user_id: string }>('select user_id from page_members where page_id = $1', [pageId])).map((r) => r.user_id);
        res.on('finish', () => { if (res.statusCode < 400) bumpWorkspace(...members, ...(sub === 'members' && id ? [id] : [])); });
      }
      return pageRoutes({ req, res, db, hp, url, who, role, pageId, sub, id, method });
    }

    return send(res, 404, { error: 'not found' });
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
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
    // One round trip: the queries are independent, so they run side by side.
    const [[m], folders, info, tags] = await Promise.all([
      who.superAgent ? [] : db.query('select folder_id from page_members where page_id = $1 and user_id = $2', [pageId, who.id]),
      who.superAgent ? [] : listFolders(db.query, who.id),
      pageInfo(db, pageId),
      pageTags(db, pageId),
    ]);
    const folderId: string | null = m?.folder_id ?? null;
    const folderPath = folderId ? folderPaths(folders).get(folderId) ?? '' : '';
    return send(res, 200, { page: { ...info, folder_id: folderId, path: folderPath, tags }, role });
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
    if (b.title !== undefined || b.tags !== undefined || b.template !== undefined) {
      if (!canEdit(role)) return send(res, 403, { error: 'You can only view this page.' });
    }
    if (b.template !== undefined) await setTemplateFlag(db, pageId, !!b.template);
    if (b.title !== undefined) await renamePage(hp, db, pageId, String(b.title), who);
    if (b.tags !== undefined) {
      if (!Array.isArray(b.tags)) return send(res, 400, { error: 'tags must be a list' });
      await setPageTags(db, pageId, b.tags);
    }
    return send(res, 200, { ok: true });
  }

  if (sub === 'backlinks' && method === 'GET') return send(res, 200, { backlinks: await backlinks(db, who, pageId) });

  if (sub === 'export' && method === 'GET') {
    const format = url.searchParams.get('format') ?? 'md';
    if (format !== 'md') return send(res, 400, { error: 'format must be md (for PDF, use Export → PDF in the app, which prints the page)' });
    const { name, markdown } = await exportPage(hp, db, who.superAgent ? '' : who.id, pageId);
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'no-store',
    });
    res.end(markdown);
    return;
  }

  // {{fields}} left in a page made from a template, for a person or an agent to fill in.
  if (sub === 'fields') {
    if (method === 'GET') return send(res, 200, { fields: listFields(await readDoc(hp, db, pageId)) });
    if (method === 'POST') {
      if (!canEdit(role)) return send(res, 403, { error: 'You can only view this page.' });
      const b = await readJson(req);
      if (!b.fields || typeof b.fields !== 'object' || Array.isArray(b.fields)) return send(res, 400, { error: 'fields must be { "name": "text" }' });
      const filled = await writeDoc(hp, pageId, { id: who.id, name: who.name, kind: who.kind }, (doc) => fillFields(doc, b.fields));
      return send(res, 200, { filled, fields: listFields(await readDoc(hp, db, pageId)) });
    }
  }

  if (sub === 'publish') {
    if (role !== 'owner') return send(res, 403, { error: 'Only the owner can publish a page.' });
    if (method === 'POST') {
      const slug = await publishPage(db, pageId);
      return send(res, 200, { slug, url: `/pub/${slug}` });
    }
    if (method === 'DELETE') {
      await unpublishPage(db, pageId);
      return send(res, 200, { ok: true });
    }
  }

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
    hp.closeConnections(pageId);
    return send(res, 200, { ok: true });
  }

  if (sub === 'members') {
    // Email addresses are for the owner (who manages access); everyone else sees names and roles.
    if (method === 'GET') {
      const list = await members(db, pageId);
      return send(res, 200, { members: role === 'owner' ? list : list.map(({ email: _email, ...m }) => m) });
    }
    if (!atLeast(role, 'owner')) return send(res, 403, { error: 'Only the owner can change who has access.' });
    if (method === 'PUT' && id) {
      const b = await readJson(req);
      const next = b.role === null ? null : String(b.role);
      if (next !== null && !SHARE_ROLES.has(next)) return send(res, 400, { error: 'bad role' });
      await setMemberRole(db, pageId, id, next as Exclude<Role, 'owner'> | null);
      // Open live connections keep the access they had when they connected. Close them so
      // everyone reconnects and is checked again: a removed person loses access at once.
      hp.closeConnections(pageId);
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
  if (sub === 'chat') return handleChat(req, res, db, who, pageId, url, id);
  if (sub === 'mentionables' && method === 'GET') return send(res, 200, { mentionables: await mentionables(db, pageId, who) });

  if (sub === 'comments') {
    try {
      if (!id && method === 'GET') {
        const st = url.searchParams.get('status');
        const status = st === 'open' || st === 'resolved' ? st : 'all';
        return send(res, 200, { threads: await threadsWithText(db, hp, who, pageId, status) });
      }
      const b = method === 'GET' || method === 'DELETE' ? {} : await readJson(req);
      if (!id && method === 'POST') {
        const comment = await createComment(db, hp, who, role, pageId, {
          body: b.body, tab: b.tab, anchor: b.anchor, quote: b.quote, blockId: b.block_id ?? b.blockId, occurrence: b.occurrence,
        });
        return send(res, 201, { comment });
      }
      if (id && !isCommentId(id)) return send(res, 404, { error: 'not found' });
      if (id && method === 'POST') return send(res, 201, { comment: await createComment(db, hp, who, role, pageId, { body: b.body, threadId: id }) });
      if (id && method === 'PATCH') return send(res, 200, { comment: await updateComment(db, hp, who, role, pageId, id, { body: b.body, resolved: b.resolved }) });
      if (id && method === 'DELETE') { await deleteComment(db, hp, who, role, pageId, id); return send(res, 200, { ok: true }); }
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      throw e;
    }
  }

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
  // Taken before reading: a change that lands meanwhile makes the app's next check reload again.
  const rev = workspaceRev(userId);
  const [folders, pages, tagMap, tags, views] = await Promise.all([
    listFolders(db.query, userId), listPages(db, userId), tagsByPage(db, userId), tagsFor(db, userId), listViews(db, userId),
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
  return { pages: out, folders: folders.map((f) => ({ ...f, path: paths.get(f.id) })), tags, views, rev };
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

/** Close live connections (any page) whose context matches; their clients reconnect and are checked again. */
export function dropConnections(hp: Hocuspocus, match: (context: any) => boolean) {
  hp.documents.forEach((doc) => {
    for (const conn of doc.getConnections()) if (match(conn.context)) conn.close();
  });
}
