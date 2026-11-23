export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// Requests started before React renders (see prefetch below). A GET that matches one uses it
// once instead of asking again, so the first screen does not wait for a chain of requests.
const early = new Map<string, { res: Promise<Response>; at: number }>();
export function prefetch(path: string) {
  if (!early.has(path)) early.set(path, { res: fetch(`/api${path}`, { credentials: 'same-origin' }), at: Date.now() });
}

async function takeEarly(path: string): Promise<Response | null> {
  const hit = early.get(path);
  if (!hit) return null;
  early.delete(path);
  if (Date.now() - hit.at > 15_000) return null; // too old to trust
  const res = await hit.res.catch(() => null);
  return res?.ok ? res : null; // a failure (say, signed out at the time) is asked again
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const pre = opts.method === undefined && opts.body === undefined ? await takeEarly(path) : null;
  const res = pre ?? await fetchApi(path, opts);
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  return data as T;
}

function fetchApi(path: string, opts: { method?: string; body?: unknown }) {
  return fetch(`/api${path}`, {
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    headers: opts.body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    credentials: 'same-origin',
  });
}

export type Me = { id: string; name: string; email: string };
export type Role = 'owner' | 'editor' | 'commenter' | 'viewer';
export type PageSummary = { id: string; title: string; updated_at: string; role: Role; owner_name: string };

const COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#f08c00', '#0c8599', '#d6336c'];
export function colorFor(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}
