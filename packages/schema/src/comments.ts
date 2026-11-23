// Comments: shared helpers for the web app, the server and agents.
//
// Comment threads live in Postgres (not in the Y.Doc), so commenters and viewers, who connect
// to the live page read-only, can still comment. A thread is anchored to the page in one of
// three ways:
//   - text:  a range of text, kept as two Yjs relative positions, so the anchor follows the
//            text while people and agents keep editing around it. `quote` is the text as it
//            was when the comment was made (shown if the text is later deleted).
//   - block: a whole block with a blockId (HTML / custom UI block, mind map).
//   - page:  the page as a whole.
//
// Mentions are written inline in a comment body as @[Name](user:<user id>) or
// @[Name](agent:<agent token id>). The server checks every target and drops the rest.
import * as Y from 'yjs';
import { MAIN_TAB, fragment } from './index.ts';

export type CommentAnchor =
  | { kind: 'text'; start: string; end: string; quote: string }
  | { kind: 'block'; blockId: string; quote?: string }
  | { kind: 'page' };

export type MentionTarget = { kind: 'user' | 'agent'; id: string; name: string };

export const COMMENT_LIMITS = { bodyMax: 8000, quoteMax: 500 };

export const MENTION_RE = /@\[([^\]\n]{1,80})\]\((user|agent):([\w-]{1,64})\)/g;

/** Every @[Name](kind:id) in a body, de-duplicated. */
export function parseMentions(body: string): MentionTarget[] {
  const seen = new Map<string, MentionTarget>();
  for (const m of body.matchAll(MENTION_RE)) {
    const t = { kind: m[2] as 'user' | 'agent', id: m[3], name: m[1] };
    seen.set(`${t.kind}:${t.id}`, t);
  }
  return [...seen.values()];
}

/** The inline syntax for a mention, e.g. for an agent writing "@[Jean](user:u_123)". */
export const mentionToken = (t: MentionTarget) => `@[${t.name.replace(/[\]\n]/g, '')}](${t.kind}:${t.id})`;

/** A body as plain text: mentions become "@Name". */
export const plainBody = (body: string) => body.replace(MENTION_RE, (_m, name) => `@${name}`);

// --- relative positions <-> strings (base64, works in browsers and Node) ---

export function encodeRelPos(rel: Y.RelativePosition): string {
  const bytes = Y.encodeRelativePosition(rel);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function decodeRelPos(s: string): Y.RelativePosition | null {
  try {
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return Y.decodeRelativePosition(bytes);
  } catch {
    return null;
  }
}

/** Plain text of one text node, with embeds counted as one character, matching Yjs indexes. */
function flatText(t: Y.XmlText): string {
  return t.toDelta().map((op: { insert: unknown }) => (typeof op.insert === 'string' ? op.insert : '￼')).join('');
}

function* textNodes(node: Y.XmlFragment | Y.XmlElement): Generator<Y.XmlText> {
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) yield child;
    else if (child instanceof Y.XmlElement) yield* textNodes(child);
  }
}

/**
 * Anchor for the first occurrence of `quote` in a tab (used by agents, which name the text
 * they mean instead of a cursor range). `occurrence` picks a later match (1 = first).
 * Matches stay inside one paragraph, heading, list item or table cell.
 */
export function textAnchorForQuote(doc: Y.Doc, quote: string, tab: string = MAIN_TAB, occurrence = 1): CommentAnchor | null {
  const q = quote.trim();
  if (!q) return null;
  let seen = 0;
  for (const t of textNodes(fragment(doc, tab))) {
    const text = flatText(t);
    let from = text.indexOf(q);
    while (from !== -1) {
      if (++seen === occurrence) {
        const start = Y.createRelativePositionFromTypeIndex(t, from, 0);
        const end = Y.createRelativePositionFromTypeIndex(t, from + q.length, -1);
        return { kind: 'text', start: encodeRelPos(start), end: encodeRelPos(end), quote: q.slice(0, COMMENT_LIMITS.quoteMax) };
      }
      from = text.indexOf(q, from + 1);
    }
  }
  return null;
}

/**
 * The text an anchor covers right now, or null when it can no longer be found (the text was
 * deleted, or the range now spans several paragraphs and only the stored quote is shown).
 */
export function currentAnchorText(doc: Y.Doc, anchor: CommentAnchor): string | null {
  if (anchor.kind !== 'text') return null;
  const s = decodeRelPos(anchor.start);
  const e = decodeRelPos(anchor.end);
  if (!s || !e) return null;
  const a = Y.createAbsolutePositionFromRelativePosition(s, doc);
  const b = Y.createAbsolutePositionFromRelativePosition(e, doc);
  if (!a || !b) return null;
  if (a.type === b.type && a.type instanceof Y.XmlText) {
    if (b.index <= a.index) return null;
    return flatText(a.type).slice(a.index, b.index);
  }
  return anchor.quote;
}

/** Validates an anchor that came from a client. Returns a clean copy or null. */
export function cleanAnchor(raw: unknown): CommentAnchor | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : null);
  if (a.kind === 'page') return { kind: 'page' };
  if (a.kind === 'block') {
    const blockId = str(a.blockId, 80);
    if (!blockId) return null;
    const quote = typeof a.quote === 'string' ? a.quote.slice(0, COMMENT_LIMITS.quoteMax) : undefined;
    return { kind: 'block', blockId, ...(quote ? { quote } : {}) };
  }
  if (a.kind === 'text') {
    const start = str(a.start, 400);
    const end = str(a.end, 400);
    if (!start || !end || !decodeRelPos(start) || !decodeRelPos(end)) return null;
    return { kind: 'text', start, end, quote: typeof a.quote === 'string' ? a.quote.slice(0, COMMENT_LIMITS.quoteMax) : '' };
  }
  return null;
}
