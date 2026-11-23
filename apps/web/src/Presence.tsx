import { Icon } from './design/Icon';

// Who is on the page right now, as small overlapping initials avatars.
// Awareness has one entry per connection, so the same person in two tabs (or a reconnect that has
// not timed out yet) shows up twice there. People are shown once each.

export type Peer = { id?: string; name: string; color: string; kind?: string; tab?: string };

const keyOf = (p: Peer) => p.id ?? `${p.kind ?? 'human'}:${p.name}`;

/** One entry per person (or agent). With `byTab`, one per person per tab. */
export function uniquePeers(peers: Peer[], byTab = false): Peer[] {
  const seen = new Map<string, Peer>();
  for (const p of peers) {
    const k = byTab ? `${keyOf(p)}|${p.tab ?? ''}` : keyOf(p);
    if (!seen.has(k)) seen.set(k, p);
  }
  return [...seen.values()];
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const first = [...words[0]][0] ?? '';
  const last = words.length > 1 ? [...words[words.length - 1]][0] ?? '' : '';
  return (first + last).toUpperCase();
}

export function Presence({ peers, max = 4 }: { peers: Peer[]; max?: number }) {
  const list = uniquePeers(peers);
  const shown = list.slice(0, list.length > max ? max - 1 : max);
  const extra = list.length - shown.length;
  const all = list.map((p) => (p.kind === 'agent' ? `${p.name} (agent)` : p.name)).join(', ');
  return (
    <div className="peers" aria-label={`On this page: ${all}`} title={all}>
      {shown.map((p) => (
        <span key={keyOf(p)} className={`peer ${p.kind === 'agent' ? 'peer-agent' : ''}`} style={p.kind === 'agent' ? undefined : { background: p.color }}
          title={p.kind === 'agent' ? `${p.name} (agent)` : p.name}>
          {initials(p.name)}
          {p.kind === 'agent' && <span className="peer-spark" aria-hidden="true"><Icon name="sparkles" size={9} strokeWidth={2.25} /></span>}
        </span>
      ))}
      {extra > 0 && <span className="peer peer-more">+{extra}</span>}
    </div>
  );
}
