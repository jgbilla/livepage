import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import { useEffect, useState } from 'react';
import type * as Y from 'yjs';
import { HTML_NODE, htmlCodeText, newId } from '@livepage/schema';
import { SandboxFrame } from './SandboxFrame';
import { CodeArea } from './CodeArea';

export const STARTER_CODE = `<div class="pulse">Hello from an HTML block</div>
<style>
  .pulse { font: 600 28px system-ui; padding: 40px; text-align: center;
           animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 50% { transform: scale(1.08); color: #e8590c; } }
</style>`;

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    htmlBlock: { insertHtmlBlock: (code?: string, title?: string) => ReturnType };
  }
}

type Options = { doc: Y.Doc | null };

// The block itself only stores { blockId, title } in the ProseMirror tree.
// Its code lives in the doc's "htmlCode" map as a Y.Text (see packages/schema).
export const HtmlBlock = Node.create<Options>({
  name: HTML_NODE,
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addOptions() {
    return { doc: null };
  },

  addAttributes() {
    return {
      blockId: { default: null },
      title: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-html-block]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-html-block': '' })];
  },

  addCommands() {
    return {
      insertHtmlBlock:
        (code = STARTER_CODE, title = '') =>
        ({ commands }) => {
          const doc = this.options.doc;
          if (!doc) return false;
          const blockId = newId('html');
          htmlCodeText(doc, blockId).insert(0, code);
          return commands.insertContent({ type: this.name, attrs: { blockId, title } });
        },
    };
  },

  addNodeView() {
    const doc = this.options.doc;
    return ReactNodeViewRenderer((props: ReactNodeViewProps) => <HtmlBlockView {...props} doc={doc} />);
  },
});

function HtmlBlockView({ node, selected, doc }: ReactNodeViewProps & { doc: Y.Doc | null }) {
  const blockId = node.attrs.blockId as string;
  const text = doc && blockId ? htmlCodeText(doc, blockId) : null;
  const [code, setCode] = useState(() => text?.toString() ?? '');
  const [showCode, setShowCode] = useState(false);

  useEffect(() => {
    if (!text) return;
    const update = () => setCode(text.toString());
    text.observe(update);
    update();
    return () => text.unobserve(update);
  }, [text]);

  return (
    <NodeViewWrapper className={`html-block ${selected ? 'is-selected' : ''}`} data-drag-handle>
      <div className="html-block-bar" contentEditable={false}>
        <span className="html-block-label">{node.attrs.title || 'HTML block'}</span>
        <button type="button" onClick={() => setShowCode((s) => !s)}>{showCode ? 'Hide code' : 'Edit code'}</button>
      </div>
      <div contentEditable={false}>
        <SandboxFrame code={code} />
        {showCode && text && <CodeArea text={text} />}
      </div>
    </NodeViewWrapper>
  );
}
