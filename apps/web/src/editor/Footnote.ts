import { InputRule, Node, mergeAttributes, type Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { FOOTNOTE_NODE, newId, safeUrl } from '@livepage/schema';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    footnote: {
      /** Insert a footnote marker at the cursor and open its editor. */
      insertFootnote: (attrs?: Partial<FootnoteAttrs>) => ReturnType;
    };
  }
}

export type FootnoteAttrs = { id: string; note: string; url: string; title: string; author: string };
export type FootnoteEntry = FootnoteAttrs & { n: number; pos: number };

/** Footnotes of the editor's document in reading order, with their numbers. */
export function collectFootnotes(doc: PMNode): FootnoteEntry[] {
  const out: FootnoteEntry[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === FOOTNOTE_NODE) out.push({ ...(node.attrs as FootnoteAttrs), n: out.length + 1, pos });
    return true;
  });
  return out;
}

/** Find a footnote's current position by id (positions move as people type). */
export function footnotePos(editor: Editor, id: string): number | null {
  return collectFootnotes(editor.state.doc).find((f) => f.id === id)?.pos ?? null;
}

export function setFootnoteAttrs(editor: Editor, id: string, patch: Partial<FootnoteAttrs>): void {
  const pos = footnotePos(editor, id);
  if (pos == null) return;
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return;
  const next = { ...node.attrs, ...patch };
  if (patch.url !== undefined) next.url = patch.url.trim() === '' ? '' : (safeUrl(patch.url) || patch.url.trim());
  editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, next));
}

export function removeFootnoteById(editor: Editor, id: string): void {
  const pos = footnotePos(editor, id);
  if (pos == null) return;
  editor.view.dispatch(editor.state.tr.delete(pos, pos + 1));
}

const numbersKey = new PluginKey<DecorationSet>('footnoteNumbers');

function numberDecorations(doc: PMNode): DecorationSet {
  return DecorationSet.create(doc, collectFootnotes(doc).map((f) =>
    Decoration.node(f.pos, f.pos + 1, {}, { n: f.n })));
}

type Options = {
  /** Called with a new footnote's id right after it is inserted, so the UI can open its editor. */
  onInsert: (id: string) => void;
};

// An inline footnote marker. The note and its citation are the node's attributes, so a
// footnote moves, copies and deletes with its marker, and merges live like any other edit.
// Numbers are computed (a footnote's place in reading order), never stored.
export const Footnote = Node.create<Options>({
  name: FOOTNOTE_NODE,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return { onInsert: () => {} };
  },

  addAttributes() {
    const a = (name: string) => ({
      default: '',
      parseHTML: (el: HTMLElement) => el.getAttribute(`data-${name}`) ?? '',
      renderHTML: (attrs: Record<string, string>) => ({ [`data-${name}`]: attrs[name] || null }),
    });
    return { id: a('id'), note: a('note'), url: a('url'), title: a('title'), author: a('author') };
  },

  parseHTML() {
    return [{ tag: 'sup[data-footnote]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['sup', mergeAttributes(HTMLAttributes, { 'data-footnote': '' })];
  },

  // Plain DOM node view: <sup><a>n</a></sup>. The number comes from a node decoration.
  addNodeView() {
    return ({ node, decorations }) => {
      const dom = document.createElement('sup');
      dom.className = 'fn-ref';
      dom.contentEditable = 'false';
      const a = document.createElement('a');
      dom.appendChild(a);
      const paint = (n: PMNode, decos: readonly Decoration[]) => {
        const num: number | undefined = decos.find((d) => d.spec?.n)?.spec.n;
        a.textContent = String(num ?? '•');
        dom.dataset.footnoteId = n.attrs.id;
        dom.id = `fnref-${n.attrs.id}`;
        a.href = `#fn-${n.attrs.id}`;
        a.setAttribute('aria-label', `Footnote ${num ?? ''}`);
      };
      paint(node, decorations);
      return {
        dom,
        update: (n, decos) => {
          if (n.type.name !== FOOTNOTE_NODE) return false;
          paint(n, decos);
          return true;
        },
        ignoreMutation: () => true,
      };
    };
  },

  addCommands() {
    return {
      insertFootnote:
        (attrs = {}) =>
        ({ commands }) => {
          const id = attrs.id || newId('fn');
          const ok = commands.insertContent({ type: this.name, attrs: { note: '', url: '', title: '', author: '', ...attrs, id } });
          if (ok) setTimeout(() => this.options.onInsert(id), 0);
          return ok;
        },
    };
  },

  addKeyboardShortcuts() {
    return { 'Mod-Alt-f': () => this.editor.commands.insertFootnote() };
  },

  // Typing "/footnote" (or "/fn") followed by a space inserts one, like a slash command.
  addInputRules() {
    return [
      new InputRule({
        find: /\/(?:footnote|fn)\s$/,
        handler: ({ range, chain }) => {
          chain().deleteRange(range).insertFootnote().run();
        },
      }),
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: numbersKey,
        state: {
          init: (_, state) => numberDecorations(state.doc),
          apply: (tr, old) => (tr.docChanged ? numberDecorations(tr.doc) : old),
        },
        props: { decorations: (state) => numbersKey.getState(state) },
      }),
    ];
  },
});
