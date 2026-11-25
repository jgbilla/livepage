import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { BLOCK_MATH, MATH_MAX } from '@livepage/schema';
import { caretAfter, isMathNode, loadKatex, renderLatex, subscribeMathEdits, type MathEditRequest } from './Math';

// The small card that edits an equation's LaTeX. The equation itself is the live preview: it
// re-renders on the page as you type (and for everyone else on the page). Enter finishes,
// Shift+Enter adds a line, Escape or a click outside closes. An equation left empty is removed.

/** Quick inserts, mostly for phones where a backslash is two keyboards away. `|` is where the caret goes. */
const SNIPPETS: { tex: string; show: string; label: string }[] = [
  { tex: '\\frac{|}{}', show: '\\frac{a}{b}', label: 'Fraction' },
  { tex: '^{|}', show: 'x^{2}', label: 'Superscript' },
  { tex: '_{|}', show: 'x_{i}', label: 'Subscript' },
  { tex: '\\sqrt{|}', show: '\\sqrt{x}', label: 'Square root' },
  { tex: '\\sum_{i=1}^{n} |', show: '\\sum', label: 'Sum' },
  { tex: '\\int_{a}^{b} |', show: '\\int', label: 'Integral' },
  { tex: '\\pi', show: '\\pi', label: 'Pi' },
  { tex: '\\alpha', show: '\\alpha', label: 'Alpha' },
  { tex: '\\leq ', show: '\\leq', label: 'Less than or equal' },
  { tex: '\\times ', show: '\\times', label: 'Times' },
];

function Tex({ tex }: { tex: string }) {
  const r = renderLatex(tex, false);
  return r && !r.error ? <span dangerouslySetInnerHTML={{ __html: r.html }} /> : <span className="mono">{tex}</span>;
}

export function MathEditor({ editor }: { editor: Editor }) {
  const [req, setReq] = useState<MathEditRequest | null>(null);
  const [latex, setLatex] = useState('');
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [, setReady] = useState(0);
  const pos = useRef<number | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const display = useRef(false);

  // Open on request (a click on an equation, a new equation, Enter on a selected one).
  useEffect(() => subscribeMathEdits(editor, (r) => {
    if (!r) return;
    const node = editor.state.doc.nodeAt(r.pos);
    if (!isMathNode(node)) return;
    pos.current = r.pos;
    display.current = node!.type.name === BLOCK_MATH;
    setLatex(String(node!.attrs.latex ?? ''));
    setReq(r);
    void loadKatex().then(() => setReady((n) => n + 1));
  }), [editor]);

  // Follow the equation as the page changes around it (people typing above it, an agent's edits).
  useEffect(() => {
    if (!req) return;
    const onTr = ({ transaction }: { transaction: import('@tiptap/pm/state').Transaction }) => {
      if (pos.current == null || !transaction.docChanged) return;
      // Changing an equation's LaTeX replaces the (leaf) node, so its old position maps as "deleted":
      // look at both sides of the mapped position, and where it was, for the equation.
      const old = pos.current;
      const at = [transaction.mapping.map(old, -1), transaction.mapping.map(old, 1), old]
        .find((p) => p <= editor.state.doc.content.size && isMathNode(editor.state.doc.nodeAt(p)));
      const node = at == null ? null : editor.state.doc.nodeAt(at);
      if (at == null || !isMathNode(node)) { pos.current = null; setReq(null); return; }
      pos.current = at;
      // Someone else changed it while it is open: show their version.
      const now = String(node!.attrs.latex ?? '');
      if (inputRef.current && now !== inputRef.current.value) setLatex(now);
    };
    editor.on('transaction', onTr);
    return () => { editor.off('transaction', onTr); };
  }, [editor, req]);

  // Sit under the equation (above it when there is no room, e.g. with the phone keyboard up).
  useLayoutEffect(() => {
    if (!req) return;
    const place = () => {
      const dom = pos.current == null ? null : (editor.view.nodeDOM(pos.current) as HTMLElement | null);
      setRect(dom?.getBoundingClientRect?.() ?? null);
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    window.visualViewport?.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('resize', place);
    };
  }, [req, latex, editor]);

  // The field grows with what is in it (wrapped lines too), up to a few lines.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, 180)}px`;
  }, [latex, req, rect?.width]);

  useEffect(() => {
    if (!req) return;
    const t = setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 0);
    return () => clearTimeout(t);
  }, [req]);

  // A click outside closes it.
  useEffect(() => {
    if (!req) return;
    const down = (e: PointerEvent) => { if (!cardRef.current?.contains(e.target as Node)) close(); };
    document.addEventListener('pointerdown', down, true);
    return () => document.removeEventListener('pointerdown', down, true);
  });

  function write(next: string) {
    const v = next.slice(0, MATH_MAX);
    setLatex(v);
    const at = pos.current;
    const node = at == null ? null : editor.state.doc.nodeAt(at);
    if (at == null || !isMathNode(node) || node!.attrs.latex === v) return;
    editor.view.dispatch(editor.state.tr.setNodeMarkup(at, undefined, { ...node!.attrs, latex: v }).setMeta('addToHistory', true));
  }

  function close() {
    const at = pos.current;
    pos.current = null;
    setReq(null);
    if (at == null) return;
    const node = editor.state.doc.nodeAt(at);
    if (!isMathNode(node)) return;
    if (!String(node!.attrs.latex ?? '').trim()) {
      editor.chain().focus().deleteRange({ from: at, to: at + node!.nodeSize }).run();
      return;
    }
    caretAfter(editor, at);
  }

  function remove() {
    const at = pos.current;
    if (at == null) return;
    const node = editor.state.doc.nodeAt(at);
    pos.current = null;
    setReq(null);
    if (isMathNode(node)) editor.chain().focus().deleteRange({ from: at, to: at + node!.nodeSize }).run();
  }

  function snippet(tex: string) {
    const el = inputRef.current;
    if (!el) return;
    const [before, after] = tex.split('|');
    const s = el.selectionStart ?? latex.length;
    const e = el.selectionEnd ?? latex.length;
    const picked = latex.slice(s, e);
    const next = latex.slice(0, s) + before + picked + (after ?? '') + latex.slice(e);
    write(next);
    const caret = s + before.length + picked.length;
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(caret, caret); });
  }

  if (!req || !rect) return null;
  const err = latex.trim() ? renderLatex(latex.trim(), display.current)?.error : null;
  const width = Math.min(380, window.innerWidth - 16);
  const vv = window.visualViewport;
  const visibleBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
  const height = cardRef.current?.offsetHeight ?? 200;
  const below = rect.bottom + 8;
  const top = below + height > visibleBottom - 8 && rect.top - height - 8 > 8 ? rect.top - height - 8 : below;
  const anchorX = display.current ? rect.left + rect.width / 2 - width / 2 : rect.left - 12;
  const left = Math.max(8, Math.min(anchorX, window.innerWidth - width - 8));
  const lines = latex.split('\n').length;

  return (
    <div ref={cardRef} className="math-card" style={{ top, left, width }} role="dialog" aria-label={display.current ? 'Edit equation' : 'Edit inline equation'}
      onKeyDown={(e) => {
        if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing)) { e.preventDefault(); close(); }
      }}>
      <div className="math-card-head">
        <span>{display.current ? 'Equation' : 'Inline equation'}</span>
        <span className="muted">LaTeX</span>
      </div>
      <textarea ref={inputRef} className="math-input" value={latex} rows={Math.max(display.current ? 2 : 1, Math.min(8, lines))}
        spellCheck={false} autoCapitalize="off" autoCorrect="off" autoComplete="off" enterKeyHint="done"
        placeholder={display.current ? '\\int_0^1 x^2\\,dx = \\frac{1}{3}' : 'E = mc^2'}
        aria-invalid={!!err} aria-describedby={err ? 'math-error' : undefined}
        onChange={(e) => write(e.target.value)} />
      {err && <div className="math-error" id="math-error" role="status">{err}</div>}
      <div className="math-snippets" role="toolbar" aria-label="Insert">
        {SNIPPETS.map((s) => (
          <button type="button" key={s.tex} title={s.label} aria-label={s.label} onPointerDown={(e) => e.preventDefault()} onClick={() => snippet(s.tex)}>
            <Tex tex={s.show} />
          </button>
        ))}
      </div>
      <div className="math-card-actions">
        <span className="math-hint">Enter to finish · Shift+Enter new line</span>
        <button type="button" className="ghost" onClick={remove}>Delete</button>
        <button type="button" className="primary" onClick={close}>Done</button>
      </div>
    </div>
  );
}
