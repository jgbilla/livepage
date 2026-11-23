// Comment anchors in the editor: highlights, click-to-open, and turning a selection into an anchor.
// Threads themselves come from the server (see screens/CommentsPanel.tsx); anchors are Yjs
// relative positions, resolved here against the live document so they follow the text.
import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey, NodeSelection, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, ySyncPluginKey } from '@tiptap/y-tiptap';
import { decodeRelPos, encodeRelPos, type CommentAnchor } from '@livepage/schema';

export type AnchoredThread = { id: string; anchor: CommentAnchor | null; resolved: boolean };
export type Range = { from: number; to: number };

/** Shared between the editor plugin and the comments panel. */
export class CommentStore {
  threads: AnchoredThread[] = [];
  activeId: string | null = null;
  onActivate: (id: string) => void = () => {};
  private listeners = new Set<() => void>();
  set(threads: AnchoredThread[]) { this.threads = threads; this.emit(); }
  activate(id: string | null) { this.activeId = id; this.emit(); }
  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit() { for (const fn of this.listeners) fn(); }
}

const key = new PluginKey<DecorationSet>('livepageComments');

function findBlock(doc: PMNode, blockId: string): Range | null {
  let found: Range | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.attrs?.blockId === blockId) { found = { from: pos, to: pos + node.nodeSize }; return false; }
    return true;
  });
  return found;
}

/** Where an anchor is in the current editor document, or null if it cannot be found (or is the whole page). */
export function resolveAnchor(editor: Editor, anchor: CommentAnchor | null) {
  return resolveIn(editor.state, anchor);
}

function resolveIn(state: EditorState, anchor: CommentAnchor | null): (Range & { block: boolean }) | null {
  if (!anchor || anchor.kind === 'page') return null;
  if (anchor.kind === 'block') {
    const r = findBlock(state.doc, anchor.blockId);
    return r && { ...r, block: true };
  }
  const sync = ySyncPluginKey.getState(state);
  if (!sync?.binding) return null;
  const s = decodeRelPos(anchor.start);
  const e = decodeRelPos(anchor.end);
  if (!s || !e) return null;
  try {
    const from = relativePositionToAbsolutePosition(sync.doc, sync.type, s, sync.binding.mapping);
    const to = relativePositionToAbsolutePosition(sync.doc, sync.type, e, sync.binding.mapping);
    if (from == null || to == null || to <= from) return null;
    return { from, to, block: false };
  } catch {
    return null;
  }
}

/** The anchor for the current selection: a selected block, a text range, or null (nothing selected). */
export function anchorFromSelection(editor: Editor): CommentAnchor | null {
  const sel = editor.state.selection;
  if (sel instanceof NodeSelection && sel.node.attrs?.blockId) {
    return { kind: 'block', blockId: String(sel.node.attrs.blockId), quote: String(sel.node.attrs.title || '') || undefined };
  }
  if (sel.empty) return null;
  const sync = ySyncPluginKey.getState(editor.state);
  if (!sync?.binding) return null;
  const quote = editor.state.doc.textBetween(sel.from, sel.to, ' ').trim().slice(0, 500);
  if (!quote) return null;
  return {
    kind: 'text',
    start: encodeRelPos(absolutePositionToRelativePosition(sel.from, sync.type, sync.binding.mapping)),
    end: encodeRelPos(absolutePositionToRelativePosition(sel.to, sync.type, sync.binding.mapping)),
    quote,
  };
}

/** Ask the comments panel to start a thread on a block (used by block toolbars). */
export function requestBlockComment(blockId: string, title?: string) {
  window.dispatchEvent(new CustomEvent('livepage:comment-block', { detail: { blockId, title } }));
}

export const CommentHighlights = Extension.create<{ store: CommentStore | null }>({
  name: 'commentHighlights',
  addOptions() { return { store: null }; },

  onCreate() {
    const store = this.options.store;
    if (!store) return;
    const unsubscribe = store.subscribe(() => {
      if (!this.editor.isDestroyed) this.editor.view.dispatch(this.editor.state.tr.setMeta(key, 'refresh'));
    });
    this.editor.on('destroy', unsubscribe);
  },

  addProseMirrorPlugins() {
    const store = this.options.store;
    if (!store) return [];
    const build = (state: EditorState) => {
      const decos: Decoration[] = [];
      for (const t of store.threads) {
        if (t.resolved) continue;
        const r = resolveIn(state, t.anchor);
        if (!r || r.to > state.doc.content.size) continue;
        const active = t.id === store.activeId ? ' comment-active' : '';
        decos.push(r.block
          ? Decoration.node(r.from, r.to, { class: `has-comment${active}`, 'data-comment': t.id }, { comment: t.id })
          : Decoration.inline(r.from, r.to, { class: `comment-anchor${active}`, 'data-comment': t.id }, { comment: t.id }));
      }
      return DecorationSet.create(state.doc, decos);
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: () => DecorationSet.empty,
          // Map highlights through edits right away, then rebuild from the Yjs anchors once the
          // edit has reached the Y.Doc (the sync plugin writes it after this transaction).
          apply: (tr, old, _prev, next) => (tr.getMeta(key) ? build(next) : tr.docChanged ? old.map(tr.mapping, tr.doc) : old),
        },
        view: (view) => ({
          update: (v, prev) => {
            if (v.state.doc === prev.doc) return;
            clearTimeout(timer);
            timer = setTimeout(() => { if (!(v as any).isDestroyed && v.dom.isConnected) v.dispatch(v.state.tr.setMeta(key, 'refresh')); }, 50);
          },
          destroy: () => clearTimeout(timer),
        }),
        props: {
          decorations: (state) => key.getState(state),
          handleClick: (view, pos, event) => {
            const el = (event.target as HTMLElement | null)?.closest?.('[data-comment]');
            const id = el?.getAttribute('data-comment');
            if (id) { store.onActivate(id); return false; }
            const hit = key.getState(view.state)?.find(pos, pos)[0];
            const hid = hit?.spec?.comment as string | undefined;
            if (hid) store.onActivate(hid);
            return false;
          },
        },
      }),
    ];
  },
});
