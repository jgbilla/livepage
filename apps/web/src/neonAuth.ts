// "Continue with Google" through Neon Auth (Managed Better Auth). Only loaded when the server
// reports a Neon Auth URL. After the provider redirects back to /auth/callback, we trade the
// Neon Auth JWT for a normal Livepage session (POST /api/auth/neon).
import { appConfig } from './config';
import { api } from './api';

type Client = Awaited<ReturnType<typeof makeClient>>;
let client: Client | null = null;

async function makeClient(url: string) {
  const { createAuthClient } = await import('@neon/auth');
  return createAuthClient(url);
}

async function neon(): Promise<Client> {
  const url = appConfig().neonAuthUrl;
  if (!url) throw new Error('Google sign-in is not set up on this server.');
  client ??= await makeClient(url);
  return client;
}

export const neonAuthAvailable = () => !!appConfig().neonAuthUrl;

/** Start Google sign-in. `next` is where to land afterwards (a page or share link on this site). */
export async function signInWithGoogle(next: string) {
  const c = await neon();
  const callbackURL = `${location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
  const { error } = await c.signIn.social({ provider: 'google', callbackURL });
  if (error) throw new Error(error.message ?? 'Google sign-in failed.');
}

/** On /auth/callback: exchange the Neon Auth session for a Livepage session. */
export async function finishNeonSignIn(): Promise<void> {
  const c = await neon();
  // The Neon wrapper puts the Neon Auth JWT on the session (this is what its own getJWTToken reads).
  const { data, error } = await c.getSession();
  const token = data?.session?.token;
  if (error || !token) throw new Error(error?.message ?? 'Sign-in did not complete. Try again.');
  await api('/auth/neon', { body: { token } });
}

export async function neonSignOut() {
  if (!client) return;
  try { await client.signOut(); } catch { /* the Livepage session is what matters */ }
}
