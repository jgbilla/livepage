import { useEffect, useRef, useState } from 'react';
import { agentInitials, agentShade } from './agents';
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

/** An agent's square avatar, in its own shade with its own initials. */
export function AgentAvatar({ peer, size }: { peer: Peer; size?: 'sm' }) {
  return (
    <span className={`peer peer-agent agent-shade-${agentShade(peer)}${size ? ` peer-${size}` : ''}`} aria-hidden="true">
      {agentInitials(peer.name)}
      <span className="peer-spark"><Icon name="sparkles" size={9} strokeWidth={2.25} /></span>
    </span>
  );
}

function Avatar({ peer }: { peer: Peer }) {
  return peer.kind === 'agent'
    ? <AgentAvatar peer={peer} />
    : <span className="peer" style={{ background: peer.color }} aria-hidden="true">{initials(peer.name)}</span>;
}

/** Who is on the page. Tap (or click) for the list with each person's and agent's name. */
export function Presence({ peers, max = 4, meId, tabTitle }: { peers: Peer[]; max?: number; meId?: string; tabTitle?: (id: string) => string }) {
  const list = uniquePeers(peers);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  if (!list.length) return <div className="peers-wrap" />;
  // Agents first: they are the ones that are easy to mix up.
  const ordered = [...list.filter((p) => p.kind === 'agent'), ...list.filter((p) => p.kind !== 'agent')];
  const shown = ordered.slice(0, ordered.length > max ? max - 1 : max);
  const extra = ordered.length - shown.length;
  const label = (p: Peer) => (p.kind === 'agent' ? `${p.name} (agent)` : p.id && p.id === meId ? `${p.name} (you)` : p.name);
  const all = ordered.map(label).join(', ');
  return (
    <div className="peers-wrap" ref={wrap}>
      <button type="button" className="peers" aria-label={`On this page: ${all}`} aria-expanded={open} title={all} onClick={() => setOpen((v) => !v)}>
        {shown.map((p) => <Avatar key={keyOf(p)} peer={p} />)}
        {extra > 0 && <span className="peer peer-more" aria-hidden="true">+{extra}</span>}
      </button>
      {open && (
        <div className="menu peers-menu" role="dialog" aria-label="On this page">
          <div className="peers-menu-head">On this page</div>
          {ordered.map((p) => {
            const where = p.tab && tabTitle ? tabTitle(p.tab) : null;
            return (
              <div key={keyOf(p)} className="peers-row">
                <Avatar peer={p} />
                <span className="peers-name">{p.name}{p.id && p.id === meId && <span className="muted"> (you)</span>}</span>
                {p.kind === 'agent' && <span className={`agent-tag agent-shade-${agentShade(p)}`}>Agent</span>}
                {where && <span className="peers-where muted small">{where}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
