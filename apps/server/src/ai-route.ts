// Who answers @AI in a comment: the same AI the person picked in the Ask AI panel's Ask menu.
//
// The pick is saved per person on the server (users.ask_target), so it follows them to every device.
// If they picked one of their connected agents (Claude Code on their laptop, say), an @AI comment
// becomes a mention of that agent: it gets it with wait_for_requests or get_mentions (or its webhook)
// and answers in the thread. If that agent isn't listening and the built-in assistant is set up, the
// built-in assistant answers now instead of the comment waiting; otherwise the mention waits for the agent.
import type { Db } from './db.ts';
import { BUILTIN, getAskTarget, isOnline } from './agent-requests.ts';
import { aiAvailable, getSettings } from './assistant/settings.ts';

export type AiRoute =
  | { kind: 'builtin'; ready: boolean; /** The agent the person picked, when it's offline and the built-in assistant stands in. */ instead?: string; note?: string }
  | { kind: 'agent'; id: string; name: string; online: boolean };

type Picked = { id: string; name: string; online: boolean } | null;

/** The decision itself, kept pure so it can be tested. */
export function pickAiRoute(picked: Picked, builtinReady: boolean): AiRoute {
  if (!picked) return { kind: 'builtin', ready: builtinReady };
  if (picked.online || !builtinReady) return { kind: 'agent', ...picked };
  return { kind: 'builtin', ready: true, instead: picked.name, note: `${picked.name} isn't listening right now, so the built-in assistant answered.` };
}

export async function resolveAiRoute(db: Db, userId: string): Promise<AiRoute> {
  const target = await getAskTarget(db, userId);
  let picked: Picked = null;
  if (target !== BUILTIN) {
    const [t] = await db.query('select id, name from api_tokens where id = $1 and user_id = $2', [target, userId]);
    if (t) picked = { id: t.id, name: t.name, online: isOnline(t.id) };
  }
  const builtinReady = aiAvailable() && !!(await getSettings(db, userId).catch(() => null));
  return pickAiRoute(picked, builtinReady);
}

/** What the @mention menu says next to AI, so you know who will answer before you send. */
export function routeDetail(r: AiRoute): string {
  if (r.kind === 'agent') return r.online ? `Goes to ${r.name} · your pick in Ask AI` : `Goes to ${r.name} · offline, answers when it listens`;
  if (r.instead) return `Built-in assistant · ${r.instead} is offline`;
  return 'Built-in assistant · uses your own key';
}
