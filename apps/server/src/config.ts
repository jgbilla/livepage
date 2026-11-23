// Runtime configuration, all from environment variables (see .env.example and render.yaml).
const env = process.env;
const production = env.NODE_ENV === 'production';

function sandboxUrl(): string {
  if (env.SANDBOX_URL) return env.SANDBOX_URL.replace(/\/$/, '');
  if (env.SANDBOX_HOST) return `https://${env.SANDBOX_HOST}`; // Render passes the sandbox service's host
  return 'http://localhost:5174';
}

export const config = {
  production,
  port: Number(env.PORT ?? env.SERVER_PORT ?? 1234),
  sandboxUrl: sandboxUrl(),
  /** Serve the built web app from this server (production: one service for app + API + live sync). */
  webDist: env.WEB_DIST ?? (production ? new URL('../../web/dist/', import.meta.url).pathname : ''),
  secureCookies: env.SECURE_COOKIES ? env.SECURE_COOKIES === '1' : production,
  trustProxy: env.TRUST_PROXY ? env.TRUST_PROXY === '1' : production,
  /** Set SIGNUP_OPEN=0 to stop new sign-ups (people can still join through share links if they already have accounts). */
  signupOpen: env.SIGNUP_OPEN !== '0',
  /** Neon Auth (Managed Better Auth). `neon deploy` writes these. When set, the app offers "Continue with Google". */
  neonAuthUrl: env.NEON_AUTH_BASE_URL?.replace(/\/$/, '') || null,
  neonAuthJwksUrl: env.NEON_AUTH_JWKS_URL || (env.NEON_AUTH_BASE_URL ? `${env.NEON_AUTH_BASE_URL.replace(/\/$/, '')}/.well-known/jwks.json` : null),
};
