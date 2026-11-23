// HTTP API for the web app and for agents. Mounted under /api by index.ts.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Hocuspocus } from '@hocuspocus/server';
import type { Db } from './db.ts';
import {
  bearer, clearCookie, createApiToken, createSession, createUser, destroySession, login, readCookie, resolvePrincipal,
  sessionCookie, validateSignup, type Principal,
} from './auth.ts';
import {
  acceptShareLink, atLeast, canEdit, createPage, createShareLink, deletePage, isPageId, listPages, members, pageInfo,
  revokeShareLink, roleFor, setMemberRole, shareLinks, type Role,
} from './pages.ts';
import { handleContent, readJson, send } from './agent-api.ts';
import { config } from './config.ts';
import { handleAiApi, handleAssistantRun } from './assistant/http.ts';
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
      return send(res, 200, { pages: await listPages(db, who.id) });
    }
    if (path === '/api/pages' && method === 'POST') {
      if (who.superAgent) return send(res, 400, { error: 'Use a personal agent token to create pages.' });
      const b = await readJson(req);
      return send(res, 201, { page: await createPage(db, who.id, String(b.title ?? '')) });
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

  if (!sub && method === 'GET') return send(res, 200, { page: await pageInfo(db, pageId), role });
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

  if (sub === 'assistant' && !id) return handleAssistantRun(req, res, db, who, pageId, canEdit(role));

  if (sub && CONTENT.has(sub)) {
    return handleContent({
      req, res, hp, url, page: pageId, collection: sub === 'content' ? undefined : sub, id,
      who: { id: who.id, name: who.name, kind: who.kind }, writable: canEdit(role),
    });
  }

  return send(res, 404, { error: 'not found' });
}
