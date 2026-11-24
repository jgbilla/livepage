// Who a live connection appears as in presence (avatars, carets, tab dots). The browser or agent
// sends its own idea of this; the server replaces it with what the connection authenticated as.

export type ConnUser = { id: string; name: string; kind: 'human' | 'agent'; tokenId?: string; superAgent?: boolean };

/** A token name that says nothing: the default when someone leaves the name empty. */
export const isDefaultAgentName = (name: string | undefined) => !name || /^\s*agent\s*$/i.test(name);

export function presenceUser(conn: ConnUser, claimed: Record<string, unknown>): Record<string, unknown> {
  const said = typeof claimed.name === 'string' ? claimed.name.trim().slice(0, 80) : '';
  if (conn.kind === 'human') return { ...claimed, id: conn.id, name: conn.name, kind: 'human' };
  // The shared development token (demo, docs writer) names itself.
  if (conn.superAgent) return { ...claimed, name: said || 'Agent', kind: 'agent' };
  const name = isDefaultAgentName(conn.name) && said ? said : conn.name;
  // Agent tokens get a stable id per token; the built-in assistant has no token, one per person.
  const id = conn.tokenId ? `agent:${conn.tokenId}` : `ai:${conn.id}`;
  return { ...claimed, id, name, kind: 'agent' };
}
