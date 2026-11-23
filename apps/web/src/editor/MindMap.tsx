import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import { useEffect, useState } from 'react';
import type * as Y from 'yjs';
import {
  MIND_NODE, addMindNode, mindChildren, mindMapNodes, newId, removeMindNode, setMindNodeText, type MindNode,
} from '@livepage/schema';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    mindMap: { insertMindMap: (rootText?: string) => ReturnType };
  }
}

// A native mind map block. Like HTML blocks, the tree stores only { blockId, title };
// the nodes live in the doc's "mindMaps" map, so people and agents edit the same map live.
export const MindMap = Node.create<{ doc: Y.Doc | null }>({
  name: MIND_NODE,
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addOptions() {
    return { doc: null };
  },
  addAttributes() {
    return { blockId: { default: null }, title: { default: '' } };
  },
  parseHTML() {
    return [{ tag: 'div[data-mind-map]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-mind-map': '' })];
  },
  addCommands() {
    return {
      insertMindMap:
        (rootText = 'Central idea') =>
        ({ commands }) => {
          const doc = this.options.doc;
          if (!doc) return false;
          const blockId = newId('mind');
          doc.transact(() => {
            const root = addMindNode(doc, blockId, null, rootText);
            addMindNode(doc, blockId, root, 'Branch');
          });
          return commands.insertContent({ type: this.name, attrs: { blockId } });
        },
    };
  },
  addNodeView() {
    const doc = this.options.doc;
    return ReactNodeViewRenderer((props: ReactNodeViewProps) => <MindMapView {...props} doc={doc} />);
  },
});

function MindMapView({ node, selected, doc }: ReactNodeViewProps & { doc: Y.Doc | null }) {
  const blockId = node.attrs.blockId as string;
  const map = doc && blockId ? mindMapNodes(doc, blockId) : null;
  const [nodes, setNodes] = useState<MindNode[]>(() => (map ? [...map.values()] : []));

  useEffect(() => {
    if (!map) return;
    const update = () => setNodes([...map.values()]);
    map.observe(update);
    update();
    return () => map.unobserve(update);
  }, [map]);

  if (!doc) return null;

  return (
    <NodeViewWrapper className={`mind-map ${selected ? 'is-selected' : ''}`} data-drag-handle>
      <div className="html-block-bar" contentEditable={false}>
        <span className="html-block-label">{node.attrs.title || 'Mind map'}</span>
        <span className="mm-hint">Tab adds a child, Enter adds a sibling</span>
      </div>
      <div className="mm-canvas" contentEditable={false}>
        {mindChildren(nodes, null).map((r) => <Branch key={r.id} n={r} isRoot nodes={nodes} doc={doc} blockId={blockId} />)}
      </div>
    </NodeViewWrapper>
  );
}

// Top-level (not nested in the view) so inputs keep focus across re-renders.
function Branch({ n, isRoot, nodes, doc, blockId }: { n: MindNode; isRoot: boolean; nodes: MindNode[]; doc: Y.Doc; blockId: string }) {
  const kids = mindChildren(nodes, n.id);
  return (
    <div className="mm-branch">
      <div className={`mm-node ${isRoot ? 'mm-root' : ''}`}>
        <input
          value={n.text}
          aria-label="Mind map node"
          size={Math.max(4, n.text.length)}
          onChange={(e) => setMindNodeText(doc, blockId, n.id, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Tab') { e.preventDefault(); addMindNode(doc, blockId, n.id, ''); }
            if (e.key === 'Enter' && n.parent) { e.preventDefault(); addMindNode(doc, blockId, n.parent, ''); }
          }}
        />
        <button type="button" title="Add child (Tab)" onClick={() => addMindNode(doc, blockId, n.id, 'New idea')}>+</button>
        {!isRoot && <button type="button" title="Remove" onClick={() => removeMindNode(doc, blockId, n.id)}>×</button>}
      </div>
      {kids.length > 0 && (
        <div className="mm-children">
          {kids.map((k) => <Branch key={k.id} n={k} isRoot={false} nodes={nodes} doc={doc} blockId={blockId} />)}
        </div>
      )}
    </div>
  );
}
