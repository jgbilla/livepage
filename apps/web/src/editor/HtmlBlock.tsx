import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import { useEffect, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { HTML_NODE, actionsMap, htmlCodeText, newId, pushAction, validateAction, ACTION_LIMITS, type BlockAction } from '@livepage/schema';
import { SandboxFrame } from './SandboxFrame';
import { CodeArea } from './CodeArea';
import { requestBlockComment } from './comments';

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

type Options = { doc: Y.Doc | null; getUserName: () => string; readOnly: boolean };

// The block itself only stores { blockId, title } in the ProseMirror tree.
// Its code lives in the doc's "htmlCode" map as a Y.Text (see packages/schema).
export const HtmlBlock = Node.create<Options>({
  name: HTML_NODE,
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addOptions() {
    return { doc: null, getUserName: () => 'Someone', readOnly: false };
  },

  addAttributes() {
    return {
      blockId: { default: null },
      title: { default: '' },
      status: { default: 'ready' },
      initialHeight: { default: 120 },
      placeholders: { default: '[]' },
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
    const { doc, getUserName, readOnly } = this.options;
    return ReactNodeViewRenderer((props: ReactNodeViewProps) => <HtmlBlockView {...props} doc={doc} getUserName={getUserName} readOnly={readOnly} />);
  },
});

function parsePlaceholders(raw: unknown): string[] {
  try {
    const v = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(v) ? v.map(String).slice(0, 10) : [];
  } catch {
    return [];
  }
}

type ViewProps = ReactNodeViewProps & { doc: Y.Doc | null; getUserName: () => string; readOnly: boolean };

function HtmlBlockView({ node, selected, doc, getUserName, updateAttributes, readOnly }: ViewProps) {
  const blockId = node.attrs.blockId as string;
  const streaming = node.attrs.status === 'streaming';
  const initialHeight = Math.max(40, Math.min(2000, Number(node.attrs.initialHeight) || 120));
  const placeholders = parsePlaceholders(node.attrs.placeholders);
  const text = doc && blockId ? htmlCodeText(doc, blockId) : null;
  const [code, setCode] = useState(() => text?.toString() ?? '');
  const [showCode, setShowCode] = useState(false);
  const [tick, setTick] = useState(0);
  const [lastAction, setLastAction] = useState<BlockAction | null>(null);
  const lastSent = useRef(0);

  useEffect(() => {
    if (!text) return;
    const update = () => setCode(text.toString());
    text.observe(update);
    update();
    return () => text.unobserve(update);
  }, [text]);

  // Cycle the agent's placeholder messages while the block is being written.
  useEffect(() => {
    if (!streaming || placeholders.length < 2) return;
    const t = setInterval(() => setTick((n) => n + 1), 1400);
    return () => clearInterval(t);
  }, [streaming, placeholders.length]);

  // Show the latest bridge action for this block and what the agent did with it.
  useEffect(() => {
    if (!doc) return;
    const map = actionsMap(doc);
    const update = () => {
      const mine = [...map.values()].filter((a) => a.blockId === blockId).sort((a, b) => b.at - a.at);
      setLastAction(mine[0] ?? null);
    };
    map.observe(update);
    update();
    return () => map.unobserve(update);
  }, [doc, blockId]);

  // Host side of the bridge: everything from the sandbox is untrusted.
  const onAction = (action: unknown, values: unknown) => {
    if (!doc || readOnly) return; // viewers can look, not send
    const ok = validateAction(action, values);
    if (!ok) return console.warn('[livepage] rejected block action', action);
    const now = Date.now();
    if (now - lastSent.current < 1000 / ACTION_LIMITS.perBlockPerSecond) return;
    lastSent.current = now;
    pushAction(doc, { blockId, action: ok.action, values: ok.values, by: getUserName() });
  };

  return (
    <NodeViewWrapper className={`html-block ${selected ? 'is-selected' : ''}`} data-drag-handle>
      <div className="html-block-bar" contentEditable={false}>
        <span className="html-block-label">
          {node.attrs.title || 'HTML block'}
          {streaming && <span className="streaming-badge">writing…</span>}
        </span>
        <span className="html-block-actions">
          {streaming && !readOnly && (
            <button type="button" title="Run the block now, even if the agent has not finished" onClick={() => updateAttributes({ status: 'ready' })}>
              Run now
            </button>
          )}
          <button type="button" className="block-comment-btn" title="Comment on this block" onClick={() => requestBlockComment(blockId, node.attrs.title || 'HTML block')}>💬</button>
          <button type="button" onClick={() => setShowCode((s) => !s)}>{showCode ? 'Hide code' : readOnly ? 'View code' : 'Edit code'}</button>
        </span>
      </div>
      <div contentEditable={false} className="html-block-body">
        <SandboxFrame code={code} streaming={streaming} initialHeight={initialHeight} onAction={onAction} />
        {streaming && placeholders.length > 0 && (
          <div className="html-block-placeholder">{placeholders[tick % placeholders.length]}</div>
        )}
        {lastAction && (
          <div className={`bridge-status bridge-${lastAction.status}`}>
            {lastAction.status === 'done'
              ? `✦ Agent: ${lastAction.note || 'done'}`
              : `Sent "${lastAction.action}" to the agent${lastAction.status === 'claimed' ? ', working on it…' : '…'}`}
          </div>
        )}
        {showCode && text && <CodeArea text={text} readOnly={readOnly} />}
      </div>
    </NodeViewWrapper>
  );
}
