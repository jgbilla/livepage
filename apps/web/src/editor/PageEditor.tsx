import { useEffect, useRef } from 'react';
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
type User = { id: string; name: string; color: string };

export function PageEditor({ doc, provider, user, tab, readOnly }: { doc: Y.Doc; provider: HocuspocusProvider; user: User; tab: string; readOnly: boolean }) {
  const meRef = useRef(user);
  meRef.current = user;
  const editor = useEditor(
    {
      editable: !readOnly,
      extensions: [
        StarterKit.configure({ undoRedo: false, codeBlock: false }), // Yjs owns undo history
        CodeBlock,
        Collaboration.configure({ document: doc, field: fragmentName(tab) }), // one block tree per tab
        CollaborationCaret.configure({ provider, user: { name: user.name, color: user.color, kind: 'human' } }),
        Placeholder.configure({ placeholder: 'Write, or add a table, a mind map or a live HTML block…' }),
        Table.configure({ resizable: false }),
        TableRow,
        TableHeader,
        TableCell,
        HtmlBlock.configure({ doc, getUserName: () => meRef.current.name, readOnly }),
        MindMap.configure({ doc, readOnly }),
      ],
    },
    [doc, provider, tab, readOnly],
  );

  useEffect(() => {
    editor?.commands.updateUser({ name: user.name, color: user.color, kind: 'human' });
  }, [editor, user.name, user.color]);

  if (!editor) return null;
  return (
    <>
      {!readOnly && <div className="toolbar">
        <button type="button" onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>H2</button>
        <button type="button" onClick={() => editor.chain().focus().toggleBold().run()}><b>B</b></button>
        <button type="button" onClick={() => editor.chain().focus().toggleItalic().run()}><i>I</i></button>
        <button type="button" onClick={() => editor.chain().focus().toggleBulletList().run()}>• List</button>
        <button type="button" onClick={() => editor.chain().focus().toggleCodeBlock().run()}>Code</button>
        <button type="button" onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>Table</button>
        <button type="button" onClick={() => editor.chain().focus().insertMindMap().run()}>Mind map</button>
        <button type="button" onClick={() => editor.chain().focus().insertHtmlBlock().run()}>✦ HTML block</button>
      </div>}
      <EditorContent editor={editor} className="editor" />
    </>
  );
}
