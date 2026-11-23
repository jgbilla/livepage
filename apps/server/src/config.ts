// Runtime configuration, all from environment variables (see .env.example and render.yaml).
const env = process.env;
const production = env.NODE_ENV === 'production';

function publicHost(host: string): string {
  return host.includes('.') ? host : `${host}.onrender.com`;
}

function sandboxUrl(): string {
  if (env.SANDBOX_URL) return env.SANDBOX_URL.replace(/\/$/, '');
  // Render's fromService `host` is the internal name (e.g. "livepage-sandbox"); its public address is <name>.onrender.com.
  if (env.SANDBOX_HOST) return `https://${publicHost(env.SANDBOX_HOST)}`;
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
  /**
   * Built-in assistant: people's AI API keys are encrypted with this secret before they are stored.
   * Required in production (render.yaml generates one). Changing it makes saved keys unreadable.
   */
  aiKeySecret: env.AI_KEY_SECRET || (production ? '' : 'livepage-dev-only-secret'),
  /** Let people point the assistant at private or local addresses (Ollama, LM Studio). Off in production by default. */
  aiAllowPrivate: env.AI_ALLOW_PRIVATE_ENDPOINTS ? env.AI_ALLOW_PRIVATE_ENDPOINTS === '1' : !production,
};
