// Collapsible headings, like Obsidian folding and Notion toggle headings.
//
// Every heading at the top level of a tab can fold: a caret beside it hides everything under it, up to
// the next heading of the same or a higher level (the same section that the agents' get_outline and
// read_blocks use). A "toggle heading" (from the "/" menu) is a heading with toggle=true saved in the
// page, so its caret shows for everyone all the time; any other heading shows its caret on hover.
//
// What is folded is a per-person view choice, like Obsidian: it is kept in this browser (localStorage,
// per page and tab) and never written to the page. Folding is only decorations, so collaborators, agents,
// search, export and history all still see the whole page.
//
// Headings are tracked by the same stable block id the agent tools use (b_<client>_<clock>, from the
// Yjs node behind the heading), so a fold survives edits, reloads and other people's changes.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import type * as Y from 'yjs';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    headingFold: {
      /** Turn the current block into a toggle heading (a heading whose fold caret always shows). */
      setToggleHeading: (level: 1 | 2 | 3) => ReturnType;
      /** Fold or unfold the heading the cursor is in. */
      toggleFold: () => ReturnType;
    };
  }
}

type Options = { storageKey: string | null };

/** One top-level heading and its section. `end` is where the section stops (the next block outside it). */
type Head = { pos: number; size: number; end: number; index: number; id: string; level: number; toggle: boolean; blocks: number; text: string };
type FoldState = { folded: Set<string>; heads: Head[]; deco: DecorationSet };

export const foldKey = new PluginKey<FoldState>('headingFold');

const CHEVRON = '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';

function yId(t: Y.AbstractType<unknown>): string {
  const own = (t as unknown as Y.XmlElement).getAttribute?.('blockId');
  if (own) return String(own);
  const id = t._item?.id;
  return id ? `b_${id.client.toString(36)}_${id.clock.toString(36)}` : '';
}

/** Top-level ProseMirror node -> its block id, from the Yjs binding (empty until the page has synced). */
function idLookup(state: EditorState): Map<PMNode, string> {
  const out = new Map<PMNode, string>();
  const binding = (ySyncPluginKey.getState(state) as { binding?: { type: Y.XmlFragment; mapping: Map<unknown, PMNode | PMNode[]> } } | undefined)?.binding;
  if (!binding?.type) return out;
  for (const child of binding.type.toArray()) {
    const pm = binding.mapping.get(child);
    if (pm && !Array.isArray(pm) && pm.type.name === 'heading') out.set(pm, yId(child as unknown as Y.AbstractType<unknown>));
  }
  return out;
}

/**
 * The headings of the doc with their sections. A heading whose node changed since the binding last synced
 * (it was just edited here) is not in the binding yet, so it keeps the id it had before the edit.
 */
function computeHeads(state: EditorState, prev?: { heads: Head[]; tr: Transaction }): Head[] {
  const ids = idLookup(state);
  const before = new Map<number, string>();
  if (prev) for (const h of prev.heads) before.set(prev.tr.mapping.map(h.pos, -1), h.id);
  const tops: { node: PMNode; pos: number }[] = [];
  state.doc.forEach((node, pos) => tops.push({ node, pos }));
  const heads: Head[] = [];
  tops.forEach(({ node, pos }, index) => {
    if (node.type.name !== 'heading') return;
    const level = Number(node.attrs.level ?? 1);
    let j = index + 1;
    while (j < tops.length && !(tops[j].node.type.name === 'heading' && Number(tops[j].node.attrs.level ?? 1) <= level)) j++;
    const end = j < tops.length ? tops[j].pos : state.doc.content.size;
    const id = ids.get(node) || before.get(pos) || `@${pos}`;
    heads.push({ pos, size: node.nodeSize, end, index, id, level, toggle: !!node.attrs.toggle, blocks: j - index - 1, text: node.textContent });
  });
  return heads;
}

const isFolded = (h: Head, folded: Set<string>) => h.blocks > 0 && folded.has(h.id);

/** Top-level heads that are folded and not themselves inside a folded section. */
function visibleFolds(heads: Head[], folded: Set<string>): Head[] {
  const out: Head[] = [];
  let hiddenUntil = -1;
  for (const h of heads) {
    if (h.pos < hiddenUntil) continue;
    if (isFolded(h, folded)) { out.push(h); hiddenUntil = h.end; }
  }
  return out;
}

function buildDeco(state: EditorState, heads: Head[], folded: Set<string>): DecorationSet {
  const decos: Decoration[] = [];
  let hiddenUntil = -1;
  for (const h of heads) {
    if (h.pos < hiddenUntil) continue; // inside a folded section: hidden below, no caret
    const closed = isFolded(h, folded);
    const can = h.blocks > 0 || h.toggle;
    decos.push(Decoration.node(h.pos, h.pos + h.size, {
      class: ['fold-heading', can ? 'can-fold' : '', closed ? 'is-folded' : '', h.toggle ? 'is-toggle' : ''].filter(Boolean).join(' '),
    }));
    if (can) {
      decos.push(Decoration.widget(h.pos + 1, (view) => caret(view, h, closed), { side: -1, key: `fold:${h.id}:${closed}:${h.blocks > 0}`, ignoreSelection: true }));
    }
    if (closed) {
      const label = `${h.blocks} ${h.blocks === 1 ? 'block' : 'blocks'}`;
      decos.push(Decoration.widget(h.pos + h.size - 1, (view) => moreChip(view, h, label), { side: 1, key: `more:${h.id}:${label}`, ignoreSelection: true }));
      state.doc.nodesBetween(h.pos + h.size, h.end, (node, pos) => {
        decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'fold-hidden' }));
        return false;
      });
      hiddenUntil = h.end;
    }
  }
  return DecorationSet.create(state.doc, decos);
}

function caret(view: EditorView, h: Head, closed: boolean): HTMLElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `fold-caret${closed ? ' closed' : ''}${h.blocks ? '' : ' empty'}`;
  b.contentEditable = 'false';
  b.tabIndex = -1;
  b.innerHTML = CHEVRON;
  const what = closed ? 'Expand section' : 'Collapse section';
  b.title = h.blocks ? what : 'Write under this heading';
  b.setAttribute('aria-label', what);
  b.setAttribute('aria-expanded', String(!closed));
  hookClick(b, view, h.id);
  return b;
}

function moreChip(view: EditorView, h: Head, label: string): HTMLElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'fold-more';
  b.contentEditable = 'false';
  b.tabIndex = -1;
  b.textContent = label;
  b.title = 'Expand section';
  b.setAttribute('aria-label', `Expand section, ${label} hidden`);
  hookClick(b, view, h.id);
  return b;
}

function hookClick(el: HTMLElement, view: EditorView, id: string) {
  // Keep focus and the selection where they are; act on click so a scroll on a phone doesn't toggle.
  el.addEventListener('mousedown', (e) => e.preventDefault());
  el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggle(view, id); });
}

function toggle(view: EditorView, id: string) {
  const st = foldKey.getState(view.state);
  if (!st) return;
  const head = st.heads.find((h) => h.id === id);
  // An empty toggle heading: start writing under it, like opening an empty toggle in Notion.
  if (head && head.blocks === 0) {
    if (!view.editable) return;
    const at = head.pos + head.size;
    const tr = view.state.tr.insert(at, view.state.schema.nodes.paragraph.create());
    view.dispatch(tr.setSelection(TextSelection.create(tr.doc, at + 1)).scrollIntoView());
    view.focus();
    return;
  }
  const folding = !st.folded.has(id);
  const tr = view.state.tr.setMeta(foldKey, { set: id, folded: folding });
  // Folding with the cursor inside the section: move it to the end of the heading, so it isn't lost in hidden text.
  if (folding && head) {
    const { from } = view.state.selection;
    if (from >= head.pos + head.size && from < head.end) tr.setSelection(TextSelection.create(tr.doc, head.pos + head.size - 1));
  }
  view.dispatch(tr);
}

/**
 * Some edits make Yjs replace a heading's node, which gives it a new id (for example a line inserted
 * just above it). A folded heading that vanished this way stays folded if a heading with the same
 * level and text, that wasn't there before, took its place.
 */
function carryFolds(before: Head[], after: Head[], folded: Set<string>): Set<string> | null {
  const now = new Set(after.map((h) => h.id));
  const known = new Set(before.map((h) => h.id));
  let out: Set<string> | null = null;
  for (const gone of before) {
    if (!folded.has(gone.id) || now.has(gone.id)) continue;
    const heir = after.find((h) => !known.has(h.id) && h.level === gone.level && h.text === gone.text && !(out ?? folded).has(h.id));
    if (!heir) continue;
    out ??= new Set(folded);
    out.delete(gone.id);
    out.add(heir.id);
  }
  return out;
}

function load(key: string | null): Set<string> {
  if (!key) return new Set();
  try { const v = JSON.parse(localStorage.getItem(key) ?? '[]'); return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []); } catch { return new Set(); }
}
function save(key: string | null, folded: Set<string>) {
  if (!key) return;
  try {
    const ids = [...folded].filter((id) => !id.startsWith('@'));
    if (ids.length) localStorage.setItem(key, JSON.stringify(ids)); else localStorage.removeItem(key);
  } catch { /* private mode: folds last until reload */ }
}

/** The top-level heading whose text holds the cursor, if any. */
function headAtCursor(state: EditorState): Head | null {
  const st = foldKey.getState(state);
  const { $from } = state.selection;
  if (!st || $from.depth < 1) return null;
  const pos = $from.before(1);
  return st.heads.find((h) => h.pos === pos) ?? null;
}

export const HeadingFold = Extension.create<Options>({
  name: 'headingFold',
  // Before the editor's own Backspace.
  priority: 110,
  addOptions() { return { storageKey: null }; },

  addGlobalAttributes() {
    return [{
      types: ['heading'],
      attributes: {
        toggle: {
          default: false,
          keepOnSplit: false,
          parseHTML: (el) => el.getAttribute('data-toggle') === 'true',
          renderHTML: (attrs) => (attrs.toggle ? { 'data-toggle': 'true' } : {}),
        },
      },
    }];
  },

  addCommands() {
    return {
      setToggleHeading: (level) => ({ chain }) => chain().setHeading({ level }).updateAttributes('heading', { toggle: true }).run(),
      toggleFold: () => ({ state, view }) => {
        const h = headAtCursor(state);
        if (!h || !h.blocks) return false;
        toggle(view, h.id);
        return true;
      },
    };
  },

  addKeyboardShortcuts() {
    return {
      // Like Notion's toggles and Obsidian's fold command.
      'Mod-Enter': () => this.editor.commands.toggleFold(),
      // Backspace at the start of the block right after a folded section would merge into hidden text:
      // go to the end of the folded heading instead (and drop the line if it is empty).
      Backspace: () => {
        const { state, view } = this.editor;
        const { $from, empty } = state.selection;
        const st = foldKey.getState(state);
        if (!empty || !st || $from.depth !== 1 || $from.parentOffset !== 0) return false;
        const pos = $from.before(1);
        const h = visibleFolds(st.heads, st.folded).find((x) => x.end === pos);
        if (!h) return false;
        let tr = state.tr;
        if ($from.parent.content.size === 0 && $from.parent.isTextblock) tr = tr.delete(pos, pos + $from.parent.nodeSize);
        tr.setSelection(TextSelection.create(tr.doc, h.pos + h.size - 1));
        view.dispatch(tr);
        return true;
      },
    };
  },

  addProseMirrorPlugins() {
    const storageKey = this.options.storageKey;
    return [new Plugin<FoldState>({
      key: foldKey,
      state: {
        init: (_config, state) => {
          const folded = load(storageKey);
          const heads = computeHeads(state);
          return { folded, heads, deco: buildDeco(state, heads, folded) };
        },
        apply: (tr, old, _oldState, state) => {
          const meta = tr.getMeta(foldKey) as { set?: string; folded?: boolean; unfold?: string[] } | undefined;
          let folded = old.folded;
          if (meta) {
            folded = new Set(folded);
            if (meta.set) { if (meta.folded) folded.add(meta.set); else folded.delete(meta.set); }
            for (const id of meta.unfold ?? []) folded.delete(id);
            save(storageKey, folded);
          }
          // Re-read ids on every doc change, and on the binding's first sync (a doc change too).
          const heads = tr.docChanged ? computeHeads(state, { heads: old.heads, tr }) : old.heads;
          if (!meta && !tr.docChanged) return old;
          if (tr.docChanged && folded.size) {
            const moved = carryFolds(old.heads, heads, folded);
            if (moved) { folded = moved; save(storageKey, folded); }
          }
          return { folded, heads, deco: buildDeco(state, heads, folded) };
        },
      },
      // The cursor landed inside a folded section (arrow keys, a link to a heading, find, undo...): unfold it, like Obsidian.
      appendTransaction: (trs, _old, state) => {
        if (!trs.some((t) => t.selectionSet || t.docChanged) || trs.some((t) => t.getMeta(ySyncPluginKey))) return null;
        const st = foldKey.getState(state);
        if (!st?.folded.size) return null;
        const { from } = state.selection;
        const open = st.heads.filter((h) => isFolded(h, st.folded) && from >= h.pos + h.size && from < h.end).map((h) => h.id);
        return open.length ? state.tr.setMeta(foldKey, { unfold: open }) : null;
      },
      props: {
        decorations: (state) => foldKey.getState(state)?.deco ?? null,
      },
    })];
  },
});
