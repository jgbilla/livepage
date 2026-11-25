// A page as plain, static HTML, for the public published view. No editor, no app code:
// text is escaped, links are checked, and HTML blocks become empty placeholders that the
// published page fills with sandboxed iframes (the same separate-origin sandbox as the app).
import * as Y from 'yjs';
import { fragment, HTML_NODE, LINK_NODE, listTabs, MIND_NODE, mindChildren, mindMapNodes, type LinkTarget, type MindNode } from './index.ts';
import { BLOCK_MATH, citationLine, footnoteParts, INLINE_MATH, inlineOf, isFootnote, mathLatex, plainText, type Run } from './walk.ts';
import { safeHref } from './markdown.ts';

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export type RenderedBlock = { id: string; title: string; code: string; height: number };
export type RenderedTab = { id: string; title: string; html: string };

export type RenderOptions = {
  /** Where a page link goes. Return null to show it as plain text (a page that is not public). */
  link?: (t: LinkTarget) => { href: string; label: string } | { href: null; label: string };
  /**
   * Renders LaTeX to HTML (the server passes KaTeX). Must return safe HTML. Without it, equations
   * show as their escaped source. `math` on the result tells the caller the page needs the math styles.
   */
  math?: (latex: string, display: boolean) => string;
};

/** Every tab as HTML, plus the HTML blocks the page needs to start in sandboxes. */
export function pageToHtml(doc: Y.Doc, opts: RenderOptions = {}): { tabs: RenderedTab[]; blocks: RenderedBlock[]; math: boolean } {
  const blocks: RenderedBlock[] = [];
  const used = { math: false };
  const tabs = listTabs(doc).map((t) => {
    // Tab ids come from the shared document, which any editor can write to directly, so they are
    // escaped like any other text before they go into an id or href.
    const ctx: Ctx = { doc, opts, blocks, notes: [], tab: escapeHtml(String(t.id)), used };
    const body = (fragment(doc, t.id).toArray() as Y.XmlElement[]).map((n) => block(n, ctx)).join('\n');
    const notes = ctx.notes.length
      ? `<section class="footnotes"><ol>${ctx.notes.map((n, i) => `<li id="fn-${ctx.tab}-${i + 1}">${n} <a href="#fnref-${ctx.tab}-${i + 1}" class="back" aria-label="Back to text">↩</a></li>`).join('')}</ol></section>`
      : '';
    return { id: t.id, title: t.title, html: body + notes };
  });
  return { tabs, blocks, math: used.math };
}

type Ctx = { doc: Y.Doc; opts: RenderOptions; blocks: RenderedBlock[]; notes: string[]; tab: string; used: { math: boolean } };

function math(latex: string, display: boolean, ctx: Ctx): string {
  const src = latex.trim();
  if (!src) return '';
  ctx.used.math = true;
  let html: string | null = null;
  try { html = ctx.opts.math?.(src, display) ?? null; } catch { html = null; }
  const inner = html ?? tag('code', escapeHtml(src));
  return display ? tag('div', inner, ' class="math-display"') : tag('span', inner, ' class="math-inline"');
}

const tag = (name: string, inner: string, attrs = '') => `<${name}${attrs}>${inner}</${name}>`;

/** Column widths dragged in the editor (each first-row cell's colwidth), as a <colgroup>. */
function colgroup(table: Y.XmlElement): { html: string; style: string } | null {
  const first = table.toArray().find((r): r is Y.XmlElement => r instanceof Y.XmlElement);
  if (!first) return null;
  const cols: (number | null)[] = [];
  for (const c of first.toArray()) {
    if (!(c instanceof Y.XmlElement)) continue;
    const span = Math.max(1, Math.min(100, Number(c.getAttribute('colspan') ?? 1) || 1));
    const w = c.getAttribute('colwidth') as unknown;
    for (let i = 0; i < span; i++) {
      const n = Array.isArray(w) ? Number(w[i]) : NaN;
      cols.push(Number.isFinite(n) && n > 0 ? Math.min(4000, Math.round(n)) : null);
    }
  }
  if (!cols.some((w) => w)) return null;
  // Like the editor: every column sized means the table is exactly that wide, otherwise at least that wide.
  const total = cols.reduce<number>((s, w) => s + (w ?? 60), 0);
  const style = cols.every((w) => w) ? ` style="table-layout:fixed;width:${total}px"` : ` style="table-layout:fixed;min-width:${total}px"`;
  return { html: `<colgroup>${cols.map((w) => (w ? `<col style="width:${w}px">` : '<col>')).join('')}</colgroup>`, style };
}

function block(node: Y.XmlElement | Y.XmlText, ctx: Ctx): string {
  if (node instanceof Y.XmlText) return tag('p', escapeHtml(plainText(node)));
  const el = node;
  const kids = () => (el.toArray() as Y.XmlElement[]).map((c) => block(c, ctx)).join('');
  switch (el.nodeName) {
    case 'paragraph': return tag('p', inline(el, ctx) || '<br>');
    case 'heading': { const l = Math.min(6, Math.max(1, Number(el.getAttribute('level') ?? 1))); return tag(`h${l}`, inline(el, ctx)); }
    case 'blockquote': return tag('blockquote', kids());
    case 'horizontalRule': return '<hr>';
    case BLOCK_MATH: return math(mathLatex(el), true, ctx);
    case 'codeBlock': return tag('pre', tag('code', escapeHtml(plainText(el))));
    case 'bulletList': return tag('ul', kids());
    case 'orderedList': { const s = Number(el.getAttribute('start') ?? 1); return tag('ol', kids(), s > 1 ? ` start="${s}"` : ''); }
    case 'listItem': case 'taskItem': return tag('li', kids());
    case 'taskList': return tag('ul', kids());
    case 'table': { const c = colgroup(el); return tag('div', tag('table', (c?.html ?? '') + kids(), c?.style ?? ''), ' class="table"'); }
    case 'tableRow': return tag('tr', kids());
    case 'tableHeader': return tag('th', kids());
    case 'tableCell': return tag('td', kids());
    case HTML_NODE: {
      const id = String(el.getAttribute('blockId') ?? '');
      const code = ctx.doc.getMap<Y.Text>('htmlCode').get(id)?.toString() ?? '';
      const height = Math.min(2000, Math.max(40, Number(el.getAttribute('initialHeight') ?? 120) || 120));
      ctx.blocks.push({ id, title: String(el.getAttribute('title') ?? ''), code, height });
      return `<div class="html-block" data-block="${escapeHtml(id)}" style="min-height:${height}px"></div>`;
    }
    case MIND_NODE: {
      const nodes = [...mindMapNodes(ctx.doc, String(el.getAttribute('blockId') ?? '')).values()];
      const list = (parent: string | null): string => {
        const ch = mindChildren(nodes, parent);
        return ch.length ? tag('ul', ch.map((n: MindNode) => tag('li', escapeHtml(n.text) + list(n.id))).join('')) : '';
      };
      const title = String(el.getAttribute('title') ?? '');
      return tag('figure', (title ? tag('figcaption', escapeHtml(title)) : '') + list(null), ' class="mind-map"');
    }
    default: {
      const inner = el.toArray();
      return inner.length && inner.every((c) => c instanceof Y.XmlElement) ? kids() : tag('p', inline(el, ctx));
    }
  }
}

function run(r: Run): string {
  let s = escapeHtml(r.text);
  const m = r.marks;
  if (m.code) s = tag('code', s);
  if (m.strike) s = tag('s', s);
  if (m.underline) s = tag('u', s);
  if (m.italic) s = tag('em', s);
  if (m.bold) s = tag('strong', s);
  const href = m.link?.href ? safeHref(String(m.link.href)) : null;
  if (href) s = tag('a', s, ` href="${escapeHtml(href)}" rel="noopener noreferrer nofollow"`);
  return s;
}

function inline(el: Y.XmlElement, ctx: Ctx): string {
  let out = '';
  for (const part of inlineOf(el)) {
    if (part.kind === 'text') { out += part.runs.map(run).join(''); continue; }
    const c = part.el;
    if (c.nodeName === LINK_NODE) {
      const t = c.getAttributes() as LinkTarget;
      const l = ctx.opts.link?.(t) ?? { href: null, label: String(t.label ?? 'link') };
      out += l.href ? tag('a', escapeHtml(l.label), ` href="${escapeHtml(l.href)}" class="page-link"`) : tag('span', escapeHtml(l.label), ' class="page-link off"');
    } else if (isFootnote(c)) {
      const f = footnoteParts(c);
      const url = f.url ? safeHref(f.url) : null;
      const n = ctx.notes.length + 1;
      ctx.notes.push(citationLine(
        { note: escapeHtml(f.note), author: escapeHtml(f.author), title: escapeHtml(f.title), url: url ? escapeHtml(url) : '' },
        { title: (t) => tag('cite', t), url: (u) => tag('a', u, ` href="${u}" rel="noopener noreferrer nofollow"`) },
      ));
      out += `<sup class="fnref" id="fnref-${ctx.tab}-${n}"><a href="#fn-${ctx.tab}-${n}">${n}</a></sup>`;
    } else if (c.nodeName === INLINE_MATH) {
      out += math(mathLatex(c), false, ctx);
    } else if (c.nodeName === 'hardBreak') {
      out += '<br>';
    } else {
      out += inline(c, ctx);
    }
  }
  return out;
}
