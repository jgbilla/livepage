// The small menu that floats over selected text, like Notion's: bold, italic, strikethrough, code,
// link, comment, footnote and Ask AI. It replaces the fixed toolbar; blocks come from the "/" menu.
// On touch screens it sits under the selection so the phone's own copy/paste bar stays visible.
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';

type Props = {
  editor: Editor;
  wrapRef: RefObject<HTMLDivElement | null>;
  readOnly: boolean;
  canComment: boolean;
  onComment: () => void;
  onAskAi?: () => void;
};

const touch = () => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;

export function SelectionMenu({ editor, wrapRef, readOnly, canComment, onComment, onAskAi }: Props) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [linking, setLinking] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [, force] = useState(0);

  useEffect(() => {
    const update = () => {
      const { selection } = editor.state;
      const box = wrapRef.current?.getBoundingClientRect();
      // Blocks (HTML, mind maps) have their own bars; this is for text.
      if (selection.empty || selection instanceof NodeSelection || !box) { setLinking(null); return setPos(null); }
      if (readOnly && !canComment) return setPos(null);
      const start = editor.view.coordsAtPos(selection.from);
      const end = editor.view.coordsAtPos(selection.to);
      const w = menuRef.current?.offsetWidth ?? 280;
      const mid = (Math.min(start.left, end.left) + Math.max(start.right, end.right)) / 2 - box.left;
      const left = Math.max(0, Math.min(mid - w / 2, box.width - w));
      const top = touch() ? Math.max(start.bottom, end.bottom) - box.top + 10 : Math.min(start.top, end.top) - box.top - 42;
      setPos({ top, left });
      force((n) => n + 1);
    };
    const hide = () => setTimeout(() => { if (!wrapRef.current?.contains(document.activeElement)) { setPos(null); setLinking(null); } }, 150);
    editor.on('selectionUpdate', update);
    editor.on('transaction', update);
    editor.on('blur', hide);
    return () => { editor.off('selectionUpdate', update); editor.off('transaction', update); editor.off('blur', hide); };
  }, [editor, wrapRef, readOnly, canComment]);

  if (!pos) return null;
  const c = () => editor.chain().focus();
  const btn = (label: React.ReactNode, title: string, on: () => void, active = false, cls = '') => (
    <button type="button" title={title} aria-label={title} aria-pressed={active} className={`${active ? 'on' : ''} ${cls}`}
      onMouseDown={(e) => e.preventDefault()} onClick={on}>{label}</button>
  );
  const applyLink = () => {
    const href = (linking ?? '').trim();
    if (!href) c().extendMarkRange('link').unsetLink().run();
    else c().extendMarkRange('link').setLink({ href: /^[a-z][\w+.-]*:|^\/|^#/i.test(href) ? href : `https://${href}` }).run();
    setLinking(null);
  };

  return (
    <div className="selection-menu" ref={menuRef} style={{ top: pos.top, left: pos.left }} role="toolbar" aria-label="Format the selection">
      {linking !== null ? (
        <form className="selection-link" onSubmit={(e) => { e.preventDefault(); applyLink(); }}>
          <input autoFocus type="text" inputMode="url" autoCapitalize="off" autoCorrect="off" placeholder="Paste a link…" value={linking}
            onChange={(e) => setLinking(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { setLinking(null); editor.commands.focus(); } }} />
          <button type="submit">{linking.trim() ? 'Link' : 'Remove'}</button>
        </form>
      ) : (
        <>
          {!readOnly && <>
            {btn(<b>B</b>, 'Bold (Ctrl/⌘+B)', () => c().toggleBold().run(), editor.isActive('bold'))}
            {btn(<i>I</i>, 'Italic (Ctrl/⌘+I)', () => c().toggleItalic().run(), editor.isActive('italic'))}
            {btn(<s>S</s>, 'Strikethrough', () => c().toggleStrike().run(), editor.isActive('strike'))}
            {btn(<code>{'<>'}</code>, 'Inline code (Ctrl/⌘+E)', () => c().toggleCode().run(), editor.isActive('code'))}
            {btn('↗ Link', 'Link to a web address', () => setLinking(String(editor.getAttributes('link').href ?? '')), editor.isActive('link'))}
            <span className="sep" aria-hidden />
          </>}
          {canComment && btn('💬 Comment', 'Comment (Ctrl/⌘+Alt+M)', onComment)}
          {!readOnly && btn('¹', 'Footnote after the selection (Ctrl/⌘+Alt+F)', () => {
            editor.chain().focus().setTextSelection(editor.state.selection.to).insertFootnote().run();
          })}
          {!readOnly && onAskAi && btn('✨ Ask AI', 'Ask AI about the selection', onAskAi, false, 'ask')}
        </>
      )}
    </div>
  );
}
