// Bridge from Neon Auth (Managed Better Auth: Google and other social sign-in) to Livepage's
// own accounts. The browser signs in with Neon Auth, then sends us the Neon Auth JWT once.
// We verify it against the branch's JWKS, find or create the matching Livepage user, and
// start a normal Livepage session. Everything after that (pages, sharing, live sync, agent
// tokens) is unchanged, and email/password accounts keep working side by side.
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Db } from './db.ts';
import { randomId, SignupClosedError, type User } from './auth.ts';
import { config } from './config.ts';

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

export const neonAuthEnabled = () => !!(config.neonAuthUrl && config.neonAuthJwksUrl);

type NeonClaims = JWTPayload & { email?: string; name?: string; emailVerified?: boolean; email_verified?: boolean };

export async function verifyNeonToken(token: string): Promise<NeonClaims> {
  if (!neonAuthEnabled()) throw new Error('Neon Auth is not configured on this server.');
  jwks ??= createRemoteJWKSet(new URL(config.neonAuthJwksUrl!));
  const { payload } = await jwtVerify(token, jwks, { algorithms: ['EdDSA', 'ES256', 'RS256'] });
  // The token must come from this server's Neon Auth (same origin as NEON_AUTH_BASE_URL).
  const expected = new URL(config.neonAuthUrl!).origin;
  if (payload.iss && new URL(payload.iss).origin !== expected) throw new Error('token from a different auth server');
  if (!payload.sub) throw new Error('token has no subject');
  return payload as NeonClaims;
}

/** Find the Livepage user for a Neon Auth identity, linking by verified email or creating one. */
export async function userForNeonIdentity(db: Db, claims: NeonClaims): Promise<User> {
  const sub = String(claims.sub);
  const [linked] = await db.query('select id, email, name from users where neon_auth_id = $1', [sub]);
  if (linked) return linked;

  const email = String(claims.email ?? '').trim().toLowerCase();
  if (!email) throw new Error('Your sign-in did not share an email address.');
  const verified = claims.emailVerified === true || claims.email_verified === true;
  const [byEmail] = await db.query('select id, email, name from users where email = $1', [email]);
  if (byEmail) {
    // Only link to an existing password account when the provider vouches for the email.
    if (!verified) throw new Error('An account with this email already exists. Log in with your password.');
    await db.query('update users set neon_auth_id = $2 where id = $1', [byEmail.id, sub]);
    return byEmail;
  }
  const user = { id: randomId('u'), email, name: String(claims.name ?? '').trim().slice(0, 80) || email.split('@')[0] };
  const rows = await db.query(
    `insert into users (id, email, name, password_hash, neon_auth_id) select $1,$2,$3,null,$4
      where $5::boolean or not exists (select 1 from users) returning id`,
    [user.id, user.email, user.name, sub, config.signupMode === 'open'],
  );
  if (!rows.length) throw new SignupClosedError(); // single-person mode: someone else got the first account
  return user;
}
