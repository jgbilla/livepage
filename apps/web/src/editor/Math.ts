// LaTeX math in the editor: inline equations inside text ($E = mc^2$) and display equations on
// their own line ($$...$$). Both are atom nodes whose one attribute is the LaTeX source, so an
// equation moves, copies, deletes and merges live like any other edit. KaTeX renders them; it is
// loaded the first time a page shows an equation, so pages without math don't pay for it.
//
// Typing: $x^2$ (closing $), \(x^2\) and $$x^2$$ make an inline equation; $$ and a space on an empty
// line makes a display equation. "/" menu: Equation (block) and Inline equation. Selection menu: turns
// the selected text into an equation. Click an equation (or select it and press Enter) to edit it.
import { InputRule, Node, mergeAttributes, type Editor } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { KatexOptions } from 'katex';
import { BLOCK_MATH, INLINE_MATH, MATH_MAX } from '@livepage/schema';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    math: {
      /** Insert an inline equation at the cursor (or around the selected text) and open its editor. */
      insertInlineMath: (latex?: string) => ReturnType;
      /** Insert a display equation as a block and open its editor. */
      insertBlockMath: (latex?: string) => ReturnType;
    };
  }
}

// ---------------------------------------------------------------------------
// KaTeX, loaded on demand

type Katex = typeof import('katex').default;
let katex: Katex | null = null;
let loading: Promise<Katex> | null = null;

export function loadKatex(): Promise<Katex> {
  loading ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([m]) => (katex = m.default));
  return loading;
}

const OPTIONS: KatexOptions = {
  throwOnError: true,
  strict: 'ignore',
  trust: false, // no \href, \url, \includegraphics or raw HTML from a page
  maxSize: 40,
  maxExpand: 1000,
  output: 'htmlAndMathml', // MathML for screen readers
};

export type Rendered = { html: string; error: string | null };
const cache = new Map<string, Rendered>();

/** KaTeX HTML for an equation, or the error KaTeX gives for it. Null until KaTeX has loaded. */
export function renderLatex(latex: string, display: boolean): Rendered | null {
  if (!katex) return null;
  const key = `${display ? 'D' : 'I'}${latex}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let out: Rendered;
  try {
    out = { html: katex.renderToString(latex, { ...OPTIONS, displayMode: display }), error: null };
  } catch (e) {
    const msg = String((e as Error).message ?? e).replace(/^KaTeX parse error:\s*/, '');
    out = { html: '', error: msg };
  }
  if (cache.size > 500) cache.clear();
  cache.set(key, out);
  return out;
}

// ---------------------------------------------------------------------------
// Opening the equation editor (MathEditor.tsx shows it)

export type MathEditRequest = { pos: number; fresh: boolean; at: number };
type Storage = { request: MathEditRequest | null; listeners: Set<() => void> };

const storageOf = (editor: Editor) => (editor.storage as unknown as Record<string, Storage>)[INLINE_MATH];

export function openMathEditor(editor: Editor, pos: number, fresh = false) {
  const s = storageOf(editor);
  if (!s || !editor.isEditable) return;
  s.request = { pos, fresh, at: Date.now() };
  s.listeners.forEach((l) => l());
}

export function subscribeMathEdits(editor: Editor, fn: (r: MathEditRequest | null) => void): () => void {
  const s = storageOf(editor);
  if (!s) return () => {};
  const l = () => fn(s.request);
  s.listeners.add(l);
  return () => { s.listeners.delete(l); };
}

export const isMathNode = (n: PMNode | null | undefined) => !!n && (n.type.name === INLINE_MATH || n.type.name === BLOCK_MATH);

// ---------------------------------------------------------------------------
// Node views

/** Paint an equation into `dom`: KaTeX when it has loaded, the source until then, a hint when empty. */
function paint(dom: HTMLElement, latex: string, display: boolean) {
  dom.dataset.latex = latex;
  const src = latex.trim();
  dom.classList.toggle('is-empty', !src);
  dom.classList.remove('has-error');
  dom.removeAttribute('title');
  if (!src) {
    dom.textContent = display ? 'Add an equation' : 'Equation';
    return;
  }
  const r = renderLatex(src, display);
  if (!r) {
    dom.textContent = src;
    dom.classList.add('is-loading');
    void loadKatex().then(() => { if (dom.dataset.latex === latex) { dom.classList.remove('is-loading'); paint(dom, latex, display); } });
    return;
  }
  dom.classList.remove('is-loading');
  if (r.error) {
    dom.textContent = src;
    dom.classList.add('has-error');
    dom.title = r.error;
    return;
  }
  dom.innerHTML = r.html;
}

function mathView(display: boolean) {
  return ({ node, editor, getPos }: { node: PMNode; editor: Editor; getPos: (() => number | undefined) | boolean }) => {
    const dom = document.createElement(display ? 'div' : 'span');
    dom.className = display ? 'math-block' : 'math-inline';
    dom.contentEditable = 'false';
    dom.setAttribute('role', 'math');
    let latex = String(node.attrs.latex ?? '');
    dom.setAttribute('aria-label', latex);
    paint(dom, latex, display);
    if (editor.isEditable) {
      dom.tabIndex = -1;
      dom.addEventListener('mousedown', (e) => e.preventDefault()); // keep the caret from landing inside KaTeX's spans
      dom.addEventListener('click', (e) => {
        e.preventDefault();
        const pos = typeof getPos === 'function' ? getPos() : undefined;
        if (pos == null) return;
        editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
        openMathEditor(editor, pos);
      });
    }
    return {
      dom,
      update: (n: PMNode) => {
        if (n.type !== node.type) return false;
        const next = String(n.attrs.latex ?? '');
        if (next !== latex) { latex = next; dom.setAttribute('aria-label', latex); paint(dom, latex, display); }
        return true;
      },
      ignoreMutation: () => true,
      stopEvent: (e: Event) => e.type === 'mousedown' || e.type === 'click',
    };
  };
}

const latexAttr = {
  latex: {
    default: '',
    parseHTML: (el: HTMLElement) => latexFromHtml(el),
    renderHTML: (attrs: Record<string, string>) => ({ 'data-latex': attrs.latex ?? '' }),
  },
};

/** Our own markup carries data-latex; equations copied from other KaTeX/MathJax pages carry a TeX annotation. */
function latexFromHtml(el: HTMLElement): string {
  const own = el.getAttribute('data-latex');
  if (own != null) return own.slice(0, MATH_MAX);
  const tex = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? el.getAttribute('alttext') ?? '';
  return tex.trim().slice(0, MATH_MAX);
}

// ---------------------------------------------------------------------------
// Typing shortcuts

/** "$5-$" and "$1,000$" are prices, not math. */
const looksLikeMoney = (s: string) => /^\d[\d.,\s]*[-–]?$/.test(s);

function inlineRule(find: RegExp, accept: (inner: string) => boolean = () => true) {
  return new InputRule({
    find,
    handler: ({ state, range, match }) => {
      const inner = (match[2] ?? '').trim();
      if (!inner || !accept(inner)) return null;
      // match[1] is the equation with its markers; anything before it in the match stays as typed.
      const start = range.from + match[0].lastIndexOf(match[1]);
      const type = state.schema.nodes[INLINE_MATH];
      // $$x$$ alone on an empty top-level line becomes a display equation.
      const $from = state.doc.resolve(start);
      const whole = $from.parent.type.name === 'paragraph' && $from.depth === 1 && $from.parentOffset === 0 && range.to === $from.end();
      if (match[1].startsWith('$$') && whole) {
        const block = state.schema.nodes[BLOCK_MATH].create({ latex: inner });
        state.tr.replaceWith($from.before(), $from.after(), block);
        return;
      }
      state.tr.replaceWith(start, range.to, type.create({ latex: inner }));
    },
  });
}

// ---------------------------------------------------------------------------
// Extensions

export const InlineMath = Node.create<object, Storage>({
  name: INLINE_MATH,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addStorage() { return { request: null, listeners: new Set() }; },
  addAttributes() { return latexAttr; },

  parseHTML() {
    return [
      { tag: 'span[data-type="inline-math"]' },
      // A KaTeX equation pasted from another site (not a display one: BlockMath takes those).
      { tag: 'span.katex', getAttrs: (el) => (el.closest('.katex-display') ? false : null) },
    ];
  },
  renderHTML({ HTMLAttributes }) { return ['span', mergeAttributes(HTMLAttributes, { 'data-type': 'inline-math' })]; },
  renderText({ node }) { return `$${node.attrs.latex}$`; },
  addNodeView() { return mathView(false) as never; },

  addCommands() {
    return {
      insertInlineMath: (latex) => ({ state, chain, editor }) => {
        const { from, to, empty } = state.selection;
        const src = latex ?? (empty ? '' : state.doc.textBetween(from, to, ' '));
        const ok = chain().insertContentAt({ from, to }, { type: INLINE_MATH, attrs: { latex: src.slice(0, MATH_MAX) } }).run();
        if (ok) setTimeout(() => openMathEditor(editor, from, true), 0);
        return ok;
      },
    };
  },

  addKeyboardShortcuts() {
    const openSelected = () => {
      const sel = this.editor.state.selection;
      if (!(sel instanceof NodeSelection) || !isMathNode(sel.node)) return false;
      openMathEditor(this.editor, sel.from);
      return true;
    };
    return {
      'Mod-Shift-e': () => this.editor.commands.insertInlineMath(),
      Enter: openSelected,
    };
  },

  addInputRules() {
    return [
      // $$x$$ (checked first, so the single-$ rule never sees it)
      inlineRule(/(?:^|[^\\$])(\$\$([^$\n]+)\$\$)$/),
      // $x$: the inside starts and ends with a non-space, like Markdown, and isn't a price.
      inlineRule(/(?:^|[^\\$\w])(\$([^\s$](?:[^$\n]*[^\s$\\])?)\$)$/, (s) => !looksLikeMoney(s)),
      // \(x\)
      inlineRule(/(?:^|[^\\])(\\\(([^\n]+?)\\\))$/),
      // $$ and a space on an empty line: a display equation.
      new InputRule({
        find: /^\$\$\s$/,
        handler: ({ state, range, chain }) => {
          const $from = state.doc.resolve(range.from);
          if ($from.parent.type.name !== 'paragraph' || $from.parent.textContent.trim() !== '$$') return null;
          chain().deleteRange(range).insertBlockMath().run();
        },
      }),
    ];
  },
});

export const BlockMath = Node.create({
  name: BLOCK_MATH,
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() { return latexAttr; },
  parseHTML() {
    return [
      { tag: 'div[data-type="block-math"]' },
      { tag: '.katex-display', getAttrs: (el) => (el.querySelector('annotation') ? null : false) },
    ];
  },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'block-math' })]; },
  renderText({ node }) { return `$$\n${node.attrs.latex}\n$$`; },
  addNodeView() { return mathView(true) as never; },

  addCommands() {
    return {
      insertBlockMath: (latex = '') => ({ state, chain, editor }) => {
        const { $from, empty } = state.selection;
        const src = latex || (empty ? '' : state.doc.textBetween(state.selection.from, state.selection.to, '\n'));
        const node = { type: BLOCK_MATH, attrs: { latex: src.slice(0, MATH_MAX) } };
        // On an empty line the equation takes its place; otherwise it goes after the current block.
        const emptyLine = $from.parent.isTextblock && $from.parent.content.size === 0 && $from.depth > 0;
        const at = emptyLine ? { from: $from.before(), to: $from.after() } : $from.depth > 0 ? $from.after(1) : state.selection.from;
        const ok = chain().insertContentAt(at, node).run();
        if (!ok) return false;
        // Find where it landed: the first display equation at or after the insert point with this source.
        const startAt = typeof at === 'number' ? at : at.from;
        setTimeout(() => {
          let found: number | null = null;
          editor.state.doc.nodesBetween(Math.max(0, startAt - 1), Math.min(editor.state.doc.content.size, startAt + 3), (n, pos) => {
            if (found == null && n.type.name === BLOCK_MATH) found = pos;
            return found == null;
          });
          if (found != null) {
            // Leave a paragraph after it so there is always somewhere to keep writing.
            const after = found + (editor.state.doc.nodeAt(found)?.nodeSize ?? 1);
            if (after >= editor.state.doc.content.size) editor.chain().insertContentAt(after, { type: 'paragraph' }).run();
            openMathEditor(editor, found, true);
          }
        }, 0);
        return true;
      },
    };
  },
});

/** Put the caret right after an equation (when its editor closes). */
export function caretAfter(editor: Editor, pos: number) {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return;
  const after = pos + node.nodeSize;
  const tr = editor.state.tr;
  if (node.isInline) tr.setSelection(TextSelection.create(tr.doc, after));
  else tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(after, tr.doc.content.size))));
  editor.view.dispatch(tr);
  editor.commands.focus();
}
