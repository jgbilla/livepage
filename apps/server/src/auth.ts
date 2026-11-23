// Accounts, sessions and API tokens. Plain Node crypto, no extra dependencies.
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { IncomingMessage } from 'node:http';
import type { Db } from './db.ts';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export type User = { id: string; email: string; name: string };
export type Principal = User & { kind: 'human' | 'agent'; superAgent?: boolean };

export const SESSION_COOKIE = 'lp_session';
const SESSION_DAYS = 30;

export const randomId = (prefix: string, bytes = 12) => `${prefix}_${randomBytes(bytes).toString('base64url')}`;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
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

export async function createUser(db: Db, email: string, name: string, password: string): Promise<User> {
  const user = { id: randomId('u'), email: email.trim().toLowerCase(), name: name.trim() };
  await db.query('insert into users (id, email, name, password_hash) values ($1,$2,$3,$4)', [
    user.id, user.email, user.name, await hashPassword(password),
  ]);
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

export async function userFromSession(db: Db, raw: string | null): Promise<User | null> {
  if (!raw) return null;
  const [row] = await db.query(
    'select u.id, u.email, u.name from sessions s join users u on u.id = s.user_id where s.id_hash = $1 and s.expires_at > now()',
    [sha256(raw)],
  );
  return row ?? null;
}

// ---- API tokens: how agents act on a person's behalf ----

export async function createApiToken(db: Db, userId: string, name: string): Promise<{ id: string; token: string }> {
  const token = `lp_${randomBytes(24).toString('base64url')}`;
  const id = randomId('tok', 8);
  await db.query('insert into api_tokens (id, user_id, name, token_hash) values ($1,$2,$3,$4)', [id, userId, name.slice(0, 80) || 'Agent', sha256(token)]);
  return { id, token };
}

export async function userFromApiToken(db: Db, token: string | null): Promise<(User & { tokenName: string }) | null> {
  if (!token || !token.startsWith('lp_')) return null;
  const [row] = await db.query(
    'select u.id, u.email, u.name, t.name as token_name, t.id as token_id from api_tokens t join users u on u.id = t.user_id where t.token_hash = $1',
    [sha256(token)],
  );
  if (!row) return null;
  void db.query('update api_tokens set last_used_at = now() where id = $1', [row.token_id]);
  return { id: row.id, email: row.email, name: row.name, tokenName: row.token_name };
}

/**
 * Who is calling? Session cookie (browsers), "lp_" API token (agents acting for a person),
 * or, in development only, the shared AGENT_TOKEN (a super-agent that can open any page).
 */
export async function resolvePrincipal(db: Db, opts: { cookie?: string | null; token?: string | null }): Promise<Principal | null> {
  const devToken = process.env.NODE_ENV !== 'production' ? process.env.AGENT_TOKEN ?? 'dev-agent-token' : null;
  if (opts.token && devToken && opts.token === devToken) {
    return { id: 'dev-agent', email: '', name: 'Agent', kind: 'agent', superAgent: true };
  }
  const viaToken = await userFromApiToken(db, opts.token ?? null);
  if (viaToken) return { id: viaToken.id, email: viaToken.email, name: viaToken.tokenName, kind: 'agent' };
  const viaSession = await userFromSession(db, readCookie(opts.cookie));
  if (viaSession) return { ...viaSession, kind: 'human' };
  return null;
}

export function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : null;
}
