// Toggle lines, like Notion's toggle list: any line can hold blocks nested under it, and its caret
// (drawn by HeadingFold.ts, which folds headings and toggles alike) hides them.
//
// In the page it is a "toggle" node: the first child is the line, the rest are the nested blocks.
// Agents read and write it as an Obsidian foldable callout in Markdown ("> [!toggle] line", then "> " lines).
//
// Keys, as in Notion:
//   Enter at the end of the line     -> a new first block inside (open), or a new toggle below (closed)
//   Enter on an empty line           -> turns the toggle back into a plain line
//   Enter on the empty last block    -> leaves the toggle
//   Backspace at the start of line   -> turns the toggle back into a plain line (nested blocks stay, unnested)
//   Tab right after a toggle         -> moves the block inside it; Shift+Tab moves it (and what follows) back out
import { Node, mergeAttributes, type Editor } from '@tiptap/core';
import { Fragment, type Node as PMNode, type ResolvedPos } from '@tiptap/pm/model';
import { TextSelection, type EditorState } from '@tiptap/pm/state';
import { foldKey } from './HeadingFold';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    toggleBlock: {
      /** Turn the current line into a toggle line. */
      setToggleLine: () => ReturnType;
    };
  }
}

/** True while the "/" or "[[" menu is open: it owns Enter and Tab then. */
function menuOpen(editor: Editor): boolean {
  const s = editor.storage as unknown as Record<string, { onKey?: unknown } | undefined>;
  return !!(s.slashCommands?.onKey || s.pageLinkInput?.onKey);
}

/** The toggle whose line holds the cursor ($from in its first child), with its depth. */
function lineToggle($from: ResolvedPos): { node: PMNode; depth: number } | null {
  const d = $from.depth - 1;
  if (d < 0) return null;
  const node = $from.node(d);
  return node.type.name === 'toggle' && $from.index(d) === 0 ? { node, depth: d } : null;
}

const isFolded = (state: EditorState, pos: number) => {
  const st = foldKey.getState(state);
  const h = st?.heads.find((x) => x.kind === 'line' && x.pos === pos);
  return !!h && h.blocks > 0 && st!.folded.has(h.id);
};

export const ToggleBlock = Node.create({
  name: 'toggle',
  group: 'block',
  content: 'paragraph block*',
  defining: true,
  // Before the editor's own Enter, Backspace and Tab (lists check for list items themselves).
  priority: 110,

  parseHTML() { return [{ tag: 'div[data-type="toggle"]' }]; },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'toggle', class: 'toggle-block' }), 0]; },

  addCommands() {
    return {
      setToggleLine: () => ({ chain, state }) => {
        const { $from } = state.selection;
        if (lineToggle($from)) return true;
        return chain().setParagraph().wrapIn(this.name).run();
      },
    };
  },

  addKeyboardShortcuts() {
    const unwrap = (state: EditorState, toggle: PMNode, pos: number) => {
      const tr = state.tr.replaceWith(pos, pos + toggle.nodeSize, toggle.content);
      return tr.setSelection(TextSelection.create(tr.doc, pos + 1));
    };

    return {
      Enter: () => {
        const { state, view } = this.editor;
        if (menuOpen(this.editor)) return false;
        const { $from, empty } = state.selection;
        if (!empty) return false;
        const line = lineToggle($from);
        if (line) {
          const pos = $from.before(line.depth);
          // An empty line with nothing under it: back to a plain line, like leaving a list.
          if ($from.parent.content.size === 0 && line.node.childCount === 1) { view.dispatch(unwrap(state, line.node, pos)); return true; }
          if ($from.parentOffset !== $from.parent.content.size) return false; // mid-line: split as usual
          const para = state.schema.nodes.paragraph.create();
          if (isFolded(state, pos)) {
            // Closed: a new toggle below, like Notion.
            const at = pos + line.node.nodeSize;
            const tr = state.tr.insert(at, this.type.create(null, para));
            view.dispatch(tr.setSelection(TextSelection.create(tr.doc, at + 2)).scrollIntoView());
          } else {
            // Open: a new first block inside.
            const at = $from.after();
            const tr = state.tr.insert(at, para);
            view.dispatch(tr.setSelection(TextSelection.create(tr.doc, at + 1)).scrollIntoView());
          }
          return true;
        }
        // The empty last block inside a toggle: leave the toggle.
        const d = $from.depth - 1;
        if (d >= 0 && $from.node(d).type.name === 'toggle' && $from.parent.type.name === 'paragraph' && $from.parent.content.size === 0
          && $from.index(d) === $from.node(d).childCount - 1 && $from.index(d) > 0) {
          const start = $from.before();
          const after = $from.after(d) - $from.parent.nodeSize; // the toggle's end once the line is gone
          const tr = state.tr.delete(start, start + $from.parent.nodeSize).insert(after, state.schema.nodes.paragraph.create());
          view.dispatch(tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView());
          return true;
        }
        return false;
      },

      Backspace: () => {
        const { state, view } = this.editor;
        const { $from, empty } = state.selection;
        if (!empty || $from.parentOffset !== 0) return false;
        const line = lineToggle($from);
        if (!line) return false;
        view.dispatch(unwrap(state, line.node, $from.before(line.depth)));
        return true;
      },

      Tab: () => {
        const { state, view } = this.editor;
        if (menuOpen(this.editor)) return false;
        const { $from } = state.selection;
        if ($from.depth < 1 || !$from.parent.isTextblock || $from.parent.type.spec.code) return false;
        const d = $from.depth - 1;
        const container = $from.node(d);
        if (!['doc', 'toggle', 'blockquote'].includes(container.type.name)) return false;
        const index = $from.index(d);
        if (index === 0) return false;
        const prev = container.child(index - 1);
        if (prev.type.name !== 'toggle') return false;
        // Move this block to the end of the toggle just above it.
        const block = $from.parent;
        const start = $from.before();
        const offset = $from.parentOffset;
        const tr = state.tr.delete(start, start + block.nodeSize);
        const into = start - 1; // just inside the end of the toggle above
        tr.insert(into, block);
        view.dispatch(tr.setSelection(TextSelection.create(tr.doc, into + 1 + offset)).scrollIntoView());
        return true;
      },

      'Shift-Tab': () => {
        const { state, view } = this.editor;
        if (menuOpen(this.editor)) return false;
        const { $from } = state.selection;
        const d = $from.depth - 1;
        if (d < 0 || $from.node(d).type.name !== 'toggle' || $from.index(d) === 0) return false;
        // Move this block and the ones after it out of the toggle, right below it.
        const toggle = $from.node(d);
        const index = $from.index(d);
        const moved: PMNode[] = [];
        for (let i = index; i < toggle.childCount; i++) moved.push(toggle.child(i));
        const from = $from.before();
        const toggleEnd = $from.after(d);
        const offset = $from.parentOffset;
        const tr = state.tr.delete(from, toggleEnd - 1);
        const at = toggleEnd - (toggleEnd - 1 - from);
        tr.insert(at, Fragment.fromArray(moved));
        view.dispatch(tr.setSelection(TextSelection.create(tr.doc, at + 1 + offset)).scrollIntoView());
        return true;
      },
    };
  },
});
