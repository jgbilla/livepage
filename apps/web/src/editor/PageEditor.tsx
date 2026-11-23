import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import Placeholder from '@tiptap/extension-placeholder';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import type * as Y from 'yjs';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { fragmentName } from '@livepage/schema';
import { HtmlBlock } from './HtmlBlock';
import { MindMap } from './MindMap';
import { CodeBlock } from './CodeBlock';
import { CommentHighlights, anchorFromSelection, type CommentStore } from './comments';
import type { CommentAnchor } from '@livepage/schema';
import { LinkMenu, PageLink, PageLinkInput } from './PageLink';
import { TemplateFields } from './TemplateFields';
import { titleOf, workspaceSnapshot } from '../workspace';
import { Footnote } from './Footnote';
import { Footnotes } from './Footnotes';
import { renderCaret } from './caret';
type User = { id: string; name: string; color: string };

type Props = {
  doc: Y.Doc; provider: HocuspocusProvider; user: User; tab: string; readOnly: boolean; pageId: string;
  /** Comments: highlights come from the store; onComment opens the composer for an anchor. */
  comments?: CommentStore; canComment?: boolean; onComment?: (anchor: CommentAnchor) => void; onEditor?: (e: Editor | null) => void;
};

export function PageEditor({ doc, provider, user, tab, readOnly, pageId, comments, canComment, onComment, onEditor }: Props) {
  const meRef = useRef(user);
  meRef.current = user;
  const [footnoteEdit, setFootnoteEdit] = useState<{ id: string; at: number } | null>(null);
  const editor = useEditor(
    {
      editable: !readOnly,
      extensions: [
        StarterKit.configure({ undoRedo: false, codeBlock: false }), // Yjs owns undo history
        CodeBlock,
        Collaboration.configure({ document: doc, field: fragmentName(tab) }), // one block tree per tab
        CollaborationCaret.configure({ provider, user: { id: user.id, name: user.name, color: user.color, kind: 'human' }, render: renderCaret }),
        Placeholder.configure({ placeholder: 'Write, or add a table, a mind map or a live HTML block…' }),
        Table.configure({ resizable: false }),
        TableRow,
        TableHeader,
        TableCell,
        HtmlBlock.configure({ doc, getUserName: () => meRef.current.name, readOnly }),
        MindMap.configure({ doc, readOnly }),
        PageLink.configure({ doc, currentPage: pageId }),
        TemplateFields,
        PageLinkInput.configure({ getTitle: (id) => { const p = workspaceSnapshot()?.pages.find((x) => x.id === id); return p ? titleOf(p) : null; } }),
        Footnote.configure({ onInsert: (id) => setFootnoteEdit({ id, at: Date.now() }) }),
        CommentHighlights.configure({ store: comments ?? null }),
      ],
    },
    [doc, provider, tab, readOnly, pageId],
  );

  useEffect(() => { onEditor?.(editor); return () => onEditor?.(null); }, [editor, onEditor]);

  // A small "Comment" button next to a text selection or a selected block.
  const [bubble, setBubble] = useState<{ top: number; left: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!editor || !canComment) return;
    const update = () => {
      const { selection } = editor.state;
      const box = wrapRef.current?.getBoundingClientRect();
      if (selection.empty || !box) return setBubble(null);
      const end = editor.view.coordsAtPos(selection.to);
      const start = editor.view.coordsAtPos(selection.from);
      setBubble({ top: Math.min(start.top, end.top) - box.top - 36, left: Math.max(0, Math.min(end.right - box.left, box.width - 110)) });
    };
    const hide = () => setTimeout(() => { if (!wrapRef.current?.contains(document.activeElement)) setBubble(null); }, 150);
    editor.on('selectionUpdate', update);
    editor.on('blur', hide);
    return () => { editor.off('selectionUpdate', update); editor.off('blur', hide); };
  }, [editor, canComment]);

  const startComment = () => {
    if (!editor || !onComment) return;
    onComment(anchorFromSelection(editor) ?? { kind: 'page' });
    setBubble(null);
  };

  // Ctrl/Cmd+Alt+M comments on the selection, like Google Docs.
  useEffect(() => {
    if (!editor || !canComment) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.altKey && e.key.toLowerCase() === 'm') { e.preventDefault(); startComment(); }
    };
    const dom = editor.view.dom;
    dom.addEventListener('keydown', onKey);
    return () => dom.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    editor?.commands.updateUser({ id: user.id, name: user.name, color: user.color, kind: 'human' });
  }, [editor, user.id, user.name, user.color]);

  if (!editor) return null;
  return (
    <>
      {!readOnly && <div className="toolbar">
        <button type="button" onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>H2</button>
        <button type="button" onClick={() => editor.chain().focus().toggleBold().run()}><b>B</b></button>
        <button type="button" onClick={() => editor.chain().focus().toggleItalic().run()}><i>I</i></button>
        <button type="button" onClick={() => editor.chain().focus().toggleBulletList().run()}>• List</button>
        <button type="button" onClick={() => editor.chain().focus().toggleCodeBlock().run()}>Code</button>
        <button type="button" title="Footnote (Ctrl/⌘+Alt+F, or type /footnote)" onClick={() => editor.chain().focus().insertFootnote().run()}>Footnote¹</button>
        <button type="button" onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>Table</button>
        <button type="button" onClick={() => editor.chain().focus().insertMindMap().run()}>Mind map</button>
        <button type="button" onClick={() => editor.chain().focus().insertHtmlBlock().run()}>✦ HTML block</button>
        {canComment && <button type="button" title="Comment on the selection (Ctrl+Alt+M)" onClick={startComment}>💬 Comment</button>}
      </div>}
      {readOnly && canComment && <div className="toolbar">
        <button type="button" title="Select text, then comment on it (Ctrl+Alt+M)" onClick={startComment}>💬 Comment</button>
      </div>}
      <div className={`editor-wrap ${canComment ? 'can-comment' : ''}`} ref={wrapRef}>
        <EditorContent editor={editor} className="editor" />
        {!readOnly && <LinkMenu editor={editor} doc={doc} currentPage={pageId} />}
        {bubble && (
          <button type="button" className="comment-bubble" style={{ top: bubble.top, left: bubble.left }}
            onMouseDown={(e) => e.preventDefault()} onClick={startComment}>💬 Comment</button>
        )}
      </div>
      <Footnotes editor={editor} readOnly={readOnly} editRequest={footnoteEdit} />
    </>
  );
}
