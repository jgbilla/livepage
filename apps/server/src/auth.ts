// Accounts, sessions and API tokens. Plain Node crypto, no extra dependencies.
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { IncomingMessage } from 'node:http';
import type { Db } from './db.ts';
import { config } from './config.ts';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export type User = { id: string; email: string; name: string };
export type Principal = User & { kind: 'human' | 'agent'; superAgent?: boolean; /** Agent token id (tok_...) when acting through a personal agent token. */ tokenId?: string };

export const SESSION_COOKIE = 'lp_session';
const SESSION_DAYS = 30;

export const randomId = (prefix: string, bytes = 12) => `${prefix}_${randomBytes(bytes).toString('base64url')}`;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false; // accounts created through Neon Auth (Google) have no password here
  const [algo, saltB64, keyB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !keyB64) return false;
  const key = Buffer.from(keyB64, 'base64');
  const got = await scrypt(password, Buffer.from(saltB64, 'base64'), key.length);
  return timingSafeEqual(key, got);
}

export function validateSignup(email: unknown, name: unknown, password: unknown): string | null {
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return 'Enter a valid email.';
  if (typeof name !== 'string' || !name.trim() || name.length > 80) return 'Enter your name.';
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) return 'Use a password of at least 8 characters.';
  return null;
}

export class SignupClosedError extends Error {
  constructor() { super('Sign-ups are closed: this Livepage belongs to one person. To use Livepage yourself, clone it from GitHub and run your own.'); }
}

export async function createUser(db: Db, email: string, name: string, password: string): Promise<User> {
  const user = { id: randomId('u'), email: email.trim().toLowerCase(), name: name.trim() };
  // In single-person mode the insert only happens while there is no account yet, so two
  // sign-ups racing on a fresh server can't both get in.
  const rows = await db.query(
    `insert into users (id, email, name, password_hash) select $1,$2,$3,$4
      where $5::boolean or not exists (select 1 from users) returning id`,
    [user.id, user.email, user.name, await hashPassword(password), config.signupMode === 'open'],
  );
  if (!rows.length) throw new SignupClosedError();
  return user;
}

export async function login(db: Db, email: string, password: string): Promise<User | null> {
  const [row] = await db.query('select id, email, name, password_hash from users where email = $1', [String(email).trim().toLowerCase()]);
  if (!row || !(await verifyPassword(String(password), row.password_hash))) return null;
  return { id: row.id, email: row.email, name: row.name };
}

/** Creates a session and returns the raw cookie value. Only its hash is stored. */
export async function createSession(db: Db, userId: string): Promise<string> {
  const raw = randomBytes(32).toString('base64url');
  await db.query(`insert into sessions (id_hash, user_id, expires_at) values ($1, $2, now() + interval '${SESSION_DAYS} days')`, [sha256(raw), userId]);
  return raw;
}

export async function destroySession(db: Db, raw: string) {
  sessionCache.delete(sha256(raw));
  await db.query('delete from sessions where id_hash = $1', [sha256(raw)]);
}

export function sessionCookie(raw: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${raw}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
}
export function clearCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

export function readCookie(header: string | null | undefined, name = SESSION_COOKIE): string | null {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=') || null;
  }
  return null;
}

// Every API call and every live connection checks the session. Remembering a valid session for
// a short while saves a database round trip on each of them (opening a page makes several).
// Signing out removes the entry at once; only valid sessions are remembered.
const SESSION_CACHE_MS = 30_000;
const sessionCache = new Map<string, { user: User; until: number }>();

export async function userFromSession(db: Db, raw: string | null): Promise<User | null> {
  if (!raw) return null;
  const hash = sha256(raw);
  const hit = sessionCache.get(hash);
  if (hit && hit.until > Date.now()) return hit.user;
  const [row] = await db.query(
    'select u.id, u.email, u.name, s.expires_at from sessions s join users u on u.id = s.user_id where s.id_hash = $1 and s.expires_at > now()',
    [hash],
  );
  if (!row) { sessionCache.delete(hash); return null; }
  const user: User = { id: row.id, email: row.email, name: row.name };
  if (sessionCache.size > 10_000) sessionCache.clear();
  sessionCache.set(hash, { user, until: Math.min(Date.now() + SESSION_CACHE_MS, new Date(row.expires_at).getTime()) });
  return user;
}

// ---- API tokens: how agents act on a person's behalf ----

export async function createApiToken(db: Db, userId: string, name: string): Promise<{ id: string; token: string }> {
  const token = `lp_${randomBytes(24).toString('base64url')}`;
  const id = randomId('tok', 8);
  await db.query('insert into api_tokens (id, user_id, name, token_hash) values ($1,$2,$3,$4)', [id, userId, name.slice(0, 80) || 'Agent', sha256(token)]);
  return { id, token };
}

/** Give a token a new secret value (the old one stops working). Used when Livepage must hand the token to a cloud agent. */
export async function rotateApiToken(db: Db, userId: string, tokenId: string): Promise<string | null> {
  const token = `lp_${randomBytes(24).toString('base64url')}`;
  const done = await db.query('update api_tokens set token_hash = $3 where id = $1 and user_id = $2 returning id', [tokenId, userId, sha256(token)]);
  return done.length ? token : null;
}

export async function userFromApiToken(db: Db, token: string | null): Promise<(User & { tokenName: string; tokenId: string }) | null> {
  if (!token || !token.startsWith('lp_')) return null;
  const [row] = await db.query(
    'select u.id, u.email, u.name, t.name as token_name, t.id as token_id from api_tokens t join users u on u.id = t.user_id where t.token_hash = $1',
    [sha256(token)],
  );
  if (!row) return null;
  void db.query('update api_tokens set last_used_at = now() where id = $1', [row.token_id]);
  return { id: row.id, email: row.email, name: row.name, tokenName: row.token_name, tokenId: row.token_id };
}

/**
 * Short-lived tokens for the built-in assistant (apps/server/src/assistant). Each run gets one,
 * in memory only, so the assistant joins the page over the collab socket as an agent with
 * exactly the access of the person who asked it. Removed when the run ends.
 */
export const assistantTokens = new Map<string, Principal>();

/**
 * Who is calling? Session cookie (browsers), "lp_" API token (agents acting for a person),
 * or, in development only, the shared AGENT_TOKEN (a super-agent that can open any page).
 */
export async function resolvePrincipal(db: Db, opts: { cookie?: string | null; token?: string | null }): Promise<Principal | null> {
  const assistant = opts.token ? assistantTokens.get(opts.token) : undefined;
  if (assistant) return assistant;
  const devToken = devAgentToken();
  if (opts.token && devToken && opts.token === devToken) {
    return { id: 'dev-agent', email: '', name: 'Agent', kind: 'agent', superAgent: true };
  }
  const viaToken = await userFromApiToken(db, opts.token ?? null);
  if (viaToken) return { id: viaToken.id, email: viaToken.email, name: viaToken.tokenName, kind: 'agent', tokenId: viaToken.tokenId };
  const viaSession = await userFromSession(db, readCookie(opts.cookie));
  if (viaSession) return { ...viaSession, kind: 'human' };
  return null;
}

/**
 * The shared development token, or null when it must not work. It opens every page, so it only
 * works on a development server that is not reachable as a public site: never with
 * NODE_ENV=production, and never when PUBLIC_URL (or Render's address) is a real host name.
 * Someone running `pnpm start` on a VPS without NODE_ENV would otherwise publish a master key.
 */
export function devAgentToken(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.NODE_ENV === 'production') return null;
  const pub = env.PUBLIC_URL || env.RENDER_EXTERNAL_URL;
  if (pub) {
    let host = '';
    try { host = new URL(pub).hostname; } catch { return null; }
    if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)) return null;
  }
  if (env.RENDER) return null;
  return env.AGENT_TOKEN || 'dev-agent-token';
}

export function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : null;
}
