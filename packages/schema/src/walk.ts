// Helpers for walking a page's block tree (the Yjs XML that TipTap edits), shared by
// Markdown export, the public HTML renderer and templates.
import * as Y from 'yjs';

/** One run of text with its marks, as TipTap stores it: mark name -> mark attrs (bold: {}, link: { href }). */
export type Run = { text: string; marks: Record<string, any> };

export type Inline =
  | { kind: 'text'; runs: Run[] }
  | { kind: 'element'; el: Y.XmlElement };

/** The inline content of a paragraph-like element: text runs and inline elements (links, footnotes, breaks), in order. */
export function inlineOf(el: Y.XmlElement): Inline[] {
  return el.toArray().map((c) => {
    if (c instanceof Y.XmlText) {
      const runs: Run[] = (c.toDelta() as { insert: unknown; attributes?: Record<string, any> }[])
        .filter((op) => typeof op.insert === 'string')
        .map((op) => ({ text: op.insert as string, marks: op.attributes ?? {} }));
      return { kind: 'text', runs } as Inline;
    }
    return { kind: 'element', el: c as Y.XmlElement } as Inline;
  });
}

/** Plain text of any node, ignoring marks. */
export function plainText(node: Y.XmlElement | Y.XmlText | Y.XmlFragment): string {
  if (node instanceof Y.XmlText) {
    return (node.toDelta() as { insert: unknown }[]).map((op) => (typeof op.insert === 'string' ? op.insert : '')).join('');
  }
  if (node instanceof Y.XmlElement && isMath(node)) return mathLatex(node);
  return node.toArray().map((c) => plainText(c as Y.XmlElement)).join(
    node instanceof Y.XmlElement && /^(paragraph|heading)$/.test(node.nodeName) ? '' : ' ',
  ).trim();
}

// ---------------------------------------------------------------------------
// Footnotes (built in the footnotes branch): an inline atom node "footnote" whose attrs hold
// everything, all strings: id, note, url, title, author. A footnote's number is its position
// among the tab's footnotes in reading order, so nothing here stores numbers.

export const FOOTNOTE = 'footnote';
export type FootnoteParts = { note: string; url: string; title: string; author: string };

export const isFootnote = (el: Y.XmlElement) => el.nodeName === FOOTNOTE;

export function footnoteParts(el: Y.XmlElement): FootnoteParts {
  const a = (k: string) => String(el.getAttribute(k) ?? '').trim();
  return { note: a('note') || a('content') || a('text') || plainText(el), url: a('url'), title: a('title'), author: a('author') };
}

/** "note — Author, Title, url" with the citation parts that are set. */
export function citationLine(f: FootnoteParts, fmt: { title?: (t: string) => string; url?: (u: string) => string } = {}): string {
  const cite = [f.author, f.title && (fmt.title ? fmt.title(f.title) : f.title), f.url && (fmt.url ? fmt.url(f.url) : f.url)].filter(Boolean).join(', ');
  return [f.note, cite].filter(Boolean).join(' — ');
}

/** A footnote element in the same shape the footnotes branch writes. */
export function makeFootnoteElement(f: Partial<FootnoteParts>): Y.XmlElement {
  const el = new Y.XmlElement(FOOTNOTE);
  el.setAttribute('id', `fn_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`);
  for (const k of ['note', 'url', 'title', 'author'] as const) el.setAttribute(k, String(f[k] ?? '').slice(0, 4000));
  return el;
}

/** Every Y.XmlText in a tree, in document order. */
export function textNodes(node: Y.XmlFragment | Y.XmlElement): Y.XmlText[] {
  const out: Y.XmlText[] = [];
  const walk = (n: Y.XmlFragment | Y.XmlElement | Y.XmlText) => {
    if (n instanceof Y.XmlText) out.push(n);
    else n.toArray().forEach((c) => walk(c as Y.XmlElement));
  };
  walk(node);
  return out;
}

// ---------------------------------------------------------------------------
// Math (LaTeX, rendered with KaTeX in the editor and on published pages). Two atom nodes whose one
// attribute is the LaTeX source:
//   inlineMath { latex }  inside text, like $E = mc^2$
//   blockMath  { latex }  a display equation on its own line, like $$\int_0^1 x\,dx$$
// In Markdown they are $...$ and $$...$$ (\(...\), \[...\] and ```math fences are read too).

export const INLINE_MATH = 'inlineMath';
export const BLOCK_MATH = 'blockMath';
/** Longest LaTeX source kept for one equation. */
export const MATH_MAX = 8000;

export const isMath = (el: Y.XmlElement) => el.nodeName === INLINE_MATH || el.nodeName === BLOCK_MATH;
export const mathLatex = (el: Y.XmlElement) => String(el.getAttribute('latex') ?? '');
export const cleanLatex = (latex: unknown) => (typeof latex === 'string' ? latex.trim().slice(0, MATH_MAX) : '');

export function makeMath(latex: string, display = false): Y.XmlElement {
  const el = new Y.XmlElement(display ? BLOCK_MATH : INLINE_MATH);
  el.setAttribute('latex', cleanLatex(latex));
  return el;
}

/** An inline equation as Markdown: $latex$ (on one line). */
export const inlineMathMarkdown = (latex: string) => `$${latex.trim().replace(/\s*\n\s*/g, ' ')}$`;
/** A display equation as Markdown: $$ on their own lines around it. */
export const blockMathMarkdown = (latex: string) => `$$\n${latex.trim()}\n$$`;

/**
 * Inline math in Markdown, with Pandoc's rules so prices stay text: the opening $ is followed by a
 * non-space, the closing $ follows a non-space and is not followed by a digit ("$5 and $10" is text).
 */
export const INLINE_MATH_RE = /^\$(?![\s$])((?:\\[\s\S]|[^\\$\n])+?)(?<!\s)\$(?!\d)/;
/** \( ... \) inline math, as many AI models write it. */
export const PAREN_MATH_RE = /^\\\(((?:\\(?!\))|[^\\\n])+?)\\\)/;
/** A display equation as a block: $$ ... $$ or \[ ... \], on one line or several. */
export const BLOCK_MATH_RE = /^ {0,3}(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n|$)/;
