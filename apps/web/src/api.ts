export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    headers: opts.body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    credentials: 'same-origin',
  });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export type Me = { id: string; name: string; email: string };
export type Role = 'owner' | 'editor' | 'commenter' | 'viewer';
export type PageSummary = { id: string; title: string; updated_at: string; role: Role; owner_name: string };

// People hues (DESIGN.md, --lp-person-1..7): hold white initials and never use agent violet.
const COLORS = ['#d4520f', '#1b6ec2', '#2b8a3e', '#0b7d8f', '#c2255c', '#b5650a', '#4f7a12'];
export function colorFor(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}
