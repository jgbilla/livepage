import { useEffect } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import Placeholder from '@tiptap/extension-placeholder';
import type * as Y from 'yjs';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { FRAGMENT } from '@livepage/schema';
import { HtmlBlock } from './HtmlBlock';
import type { Identity } from '../identity';

export function PageEditor({ doc, provider, me }: { doc: Y.Doc; provider: HocuspocusProvider; me: Identity }) {
  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({ undoRedo: false }), // Yjs owns undo history
        Collaboration.configure({ document: doc, field: FRAGMENT }),
        CollaborationCaret.configure({ provider, user: { name: me.name, color: me.color, kind: 'human' } }),
        Placeholder.configure({ placeholder: 'Write something, or press the ✦ button to add a live HTML block…' }),
        HtmlBlock.configure({ doc }),
      ],
    },
    [doc, provider],
  );

  useEffect(() => {
    editor?.commands.updateUser({ name: me.name, color: me.color, kind: 'human' });
  }, [editor, me.name, me.color]);

  if (!editor) return null;
  return (
    <>
      <div className="toolbar">
        <button type="button" onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>H2</button>
        <button type="button" onClick={() => editor.chain().focus().toggleBold().run()}><b>B</b></button>
        <button type="button" onClick={() => editor.chain().focus().toggleItalic().run()}><i>I</i></button>
        <button type="button" onClick={() => editor.chain().focus().toggleBulletList().run()}>• List</button>
        <button type="button" onClick={() => editor.chain().focus().insertHtmlBlock().run()}>✦ HTML block</button>
      </div>
      <EditorContent editor={editor} className="editor" />
    </>
  );
}
