// Telling agents apart. Several agents can be on one page (Claude Code, Cursor, your own AI...), so
// each gets its own violet shade and its own initials, and the same agent looks the same in the
// presence avatars, its caret and its tab dot. DESIGN.md: agents stay violet squircles.

export const AGENT_SHADES = 5;

type Who = { id?: string; name?: unknown; kind?: unknown };

/** Stable key for an agent (matches Presence's keyOf). */
export const agentKey = (p: Who) => (typeof p.id === 'string' && p.id ? p.id : `agent:${String(p.name ?? '')}`);

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// Shades handed out for the agents on the current page, so two agents never share one while there
// are shades left. Carets read this too, since they only see their own user.
let assigned = new Map<string, number>();

/** Give every agent on the page its own shade. Same set of agents, same shades, for every viewer. */
export function assignAgentShades(keys: string[]): void {
  const next = new Map<string, number>();
  const taken = new Set<number>();
  for (const k of [...new Set(keys)].sort()) {
    let s = hash(k) % AGENT_SHADES;
    for (let i = 0; i < AGENT_SHADES && taken.has(s); i++) s = (s + 1) % AGENT_SHADES;
    taken.add(s);
    next.set(k, s + 1);
  }
  assigned = next;
}

/** 1-based shade, for the --lp-agent-N tokens. */
export const agentShade = (p: Who) => assigned.get(agentKey(p)) ?? (hash(agentKey(p)) % AGENT_SHADES) + 1;

const FILLER = new Set(['the', 'my', 'agent', 'bot', 'mcp', 'client', 'app']);

/** Initials for an agent: "Claude Code" CC, "Cursor" C, "Jean's AI" AI, "gemini-cli" GC. */
export function agentInitials(name: string): string {
  const words = name.replace(/[_\-.]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  // "Jean's AI": the person's name would read as a person, so show what it is.
  if (words.length >= 2 && /['’]s$/i.test(words[0]) && /^ai$/i.test(words[words.length - 1])) return 'AI';
  if (words.length === 1 && /^ai$/i.test(words[0])) return 'AI';
  const kept = words.filter((w) => !FILLER.has(w.toLowerCase()));
  const use = kept.length ? kept : words;
  const first = [...use[0]][0] ?? '';
  const second = use.length > 1 ? [...use[1]][0] ?? '' : '';
  return (first + second).toUpperCase();
}
