import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import Placeholder from '@tiptap/extension-placeholder';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { TaskItem, TaskList } from '@tiptap/extension-list';
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
import { SlashCommands, SlashMenu, openSlashMenu, type SlashContext } from './SlashMenu';
import { SelectionMenu } from './SelectionMenu';
type User = { id: string; name: string; color: string };

type Props = {
  doc: Y.Doc; provider: HocuspocusProvider; user: User; tab: string; readOnly: boolean; pageId: string;
  /** Comments: highlights come from the store; onComment opens the composer for an anchor. */
  comments?: CommentStore; canComment?: boolean; onComment?: (anchor: CommentAnchor) => void; onEditor?: (e: Editor | null) => void;
  /** Opens the Ask AI panel (from the "/" menu and the selection menu). */
  onAskAi?: () => void;
};

export function PageEditor({ doc, provider, user, tab, readOnly, pageId, comments, canComment, onComment, onEditor, onAskAi }: Props) {
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
        CollaborationCaret.configure({ provider, user: { id: user.id, name: user.name, color: user.color, kind: 'human' } }),
        Placeholder.configure({
          placeholder: ({ editor: e }) => (e.isEmpty ? 'Write, or type / to add a heading, table, mind map, live HTML block…' : 'Type / for blocks, [[ to link a page'),
        }),
        Table.configure({ resizable: false }),
        TableRow,
        TableHeader,
        TableCell,
        TaskList,
        TaskItem.configure({ nested: true }),
        SlashCommands,
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

  const wrapRef = useRef<HTMLDivElement>(null);

  const startComment = () => {
    if (!editor || !onComment) return;
    onComment(anchorFromSelection(editor) ?? { kind: 'page' });
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

  const slashCtx: SlashContext = { doc, canComment: !!canComment, onComment, onAskAi };

  if (!editor) return null;
  return (
    <>
      <div className={`editor-wrap ${canComment ? 'can-comment' : ''}`} ref={wrapRef}>
        <EditorContent editor={editor} className="editor" />
        {!readOnly && <LinkMenu editor={editor} doc={doc} currentPage={pageId} />}
        {!readOnly && <SlashMenu editor={editor} ctx={slashCtx} />}
        <SelectionMenu editor={editor} wrapRef={wrapRef} readOnly={readOnly} canComment={!!canComment && !!onComment} onComment={startComment} onAskAi={onAskAi} />
        {!readOnly && <InsertButton editor={editor} />}
      </div>
      <Footnotes editor={editor} readOnly={readOnly} editRequest={footnoteEdit} />
    </>
  );
}

/** Touch screens: a "+" button that opens the "/" menu, since "/" is a keyboard switch away on phones. */
function InsertButton({ editor }: { editor: Editor }) {
  const [lift, setLift] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    // Keep it above the on-screen keyboard.
    const on = () => setLift(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
    vv.addEventListener('resize', on);
    vv.addEventListener('scroll', on);
    on();
    return () => { vv.removeEventListener('resize', on); vv.removeEventListener('scroll', on); };
  }, []);
  return (
    <button type="button" className="insert-fab" style={{ bottom: 16 + lift }} title="Insert a block" aria-label="Insert a block"
      onMouseDown={(e) => e.preventDefault()} onPointerDown={(e) => e.preventDefault()} onClick={() => openSlashMenu(editor)}>+</button>
  );
}
