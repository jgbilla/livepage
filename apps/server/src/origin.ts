// Same-origin checks for requests that ride on the session cookie.

/**
 * True when there is no Origin (non-browser clients such as agents) or when the Origin's host is
 * the Host the request was sent to. Browsers always send Origin on cross-site POSTs and on
 * WebSocket upgrades, so this stops other sites from acting with a signed-in person's cookie.
 */
export function sameOrigin(origin: string | null | undefined, host: string | null | undefined): boolean {
  if (!origin) return true;
  if (origin === 'null') return false; // sandboxed iframes and some redirects: never trusted
  try { return new URL(origin).host === host; } catch { return false; }
}

export const sameOriginHeaders = (h: Headers) => sameOrigin(h.get('origin'), h.get('host'));
