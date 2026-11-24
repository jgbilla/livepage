// Column resizing for tables on touch screens. With a mouse, prosemirror-tables' columnResizing
// (Table.configure({ resizable: true })) already drags column borders. Touch screens never send
// it a drag, so here a finger on a column border (the grip shown on the table the cursor is in)
// drags it instead. Either way the width lands in each cell's `colwidth` attribute, which lives in
// the shared document: it is saved with the page and syncs live to everyone on it.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { TableMap } from '@tiptap/pm/tables';
import type { Node as PMNode } from '@tiptap/pm/model';
import { TableView } from '@tiptap/extension-table';

/** Narrowest a column can be dragged to (px). Shared with Table.configure({ cellMinWidth }). */
export const TABLE_CELL_MIN_WIDTH = 60;
/** Width a column that nobody has sized keeps at least (px): on a phone a table with some sized
 * columns scrolls sideways instead of squeezing the others to a sliver. */
export const TABLE_DEFAULT_COL_WIDTH = 110;

/** The table view, with unsized columns at least TABLE_DEFAULT_COL_WIDTH wide. */
export class LpTableView extends TableView {
  constructor(node: PMNode, _min: number, view?: EditorView, attrs?: Record<string, unknown>) {
    super(node, TABLE_DEFAULT_COL_WIDTH, view, attrs);
  }
}

/** How close to a column border a finger must land to grab it (px, either side). */
const TOUCH_SLOP = 14;

const key = new PluginKey('tableTouchResize');

/** The table that holds the cursor gets `table-active`, which shows the touch grips. */
function activeTable(state: EditorState): DecorationSet {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (n.type.spec.tableRole === 'table') {
      const pos = $from.before(d);
      return DecorationSet.create(state.doc, [Decoration.node(pos, pos + n.nodeSize, { class: 'table-active' })]);
    }
  }
  return DecorationSet.empty;
}

type Drag = {
  tablePos: number; col: number; startX: number; startWidth: number; width: number;
  cols: HTMLTableColElement[]; table: HTMLTableElement; saved: { cols: string[]; minWidth: string };
};

/** Sets column `col` of the table at `tablePos` to `width` px in every row, in one transaction. */
export function setColumnWidth(view: EditorView, tablePos: number, col: number, width: number) {
  const table = view.state.doc.nodeAt(tablePos);
  if (!table) return;
  const map = TableMap.get(table);
  const start = tablePos + 1;
  const tr = view.state.tr;
  for (let row = 0; row < map.height; row++) {
    const i = row * map.width + col;
    if (row && map.map[i] === map.map[i - map.width]) continue; // a cell spanning rows: done already
    const pos = map.map[i];
    const attrs = table.nodeAt(pos)!.attrs;
    const index = attrs.colspan === 1 ? 0 : col - map.colCount(pos);
    if (attrs.colwidth?.[index] === width) continue;
    const colwidth = attrs.colwidth ? attrs.colwidth.slice() : Array(attrs.colspan).fill(0);
    colwidth[index] = width;
    tr.setNodeMarkup(start + pos, null, { ...attrs, colwidth });
  }
  if (tr.docChanged) view.dispatch(tr);
}

export const TableTouchResize = Extension.create({
  name: 'tableTouchResize',
  addProseMirrorPlugins() {
    const editor = this.editor;
    let drag: Drag | null = null;

    const move = (e: TouchEvent) => {
      if (!drag) return;
      e.preventDefault();
      drag.width = Math.max(TABLE_CELL_MIN_WIDTH, Math.round(drag.startWidth + e.touches[0].clientX - drag.startX));
      // Preview without touching the document, so collaborators see one change, not hundreds.
      drag.cols[drag.col].style.width = `${drag.width}px`;
      const total = drag.cols.reduce((s, c) => s + (parseFloat(c.style.width) || TABLE_DEFAULT_COL_WIDTH), 0);
      drag.table.style.minWidth = `${total}px`;
    };
    const end = () => {
      window.removeEventListener('touchmove', move);
      window.removeEventListener('touchend', end);
      window.removeEventListener('touchcancel', end);
      const d = drag;
      drag = null;
      document.documentElement.classList.remove('table-resizing');
      if (!d) return;
      // Drop the preview styles; the table view redraws the columns from the document.
      d.cols.forEach((c, i) => { c.style.width = d.saved.cols[i]; });
      d.table.style.minWidth = d.saved.minWidth;
      if (d.width !== d.startWidth) setColumnWidth(editor.view, d.tablePos, d.col, d.width);
    };

    return [new Plugin({
      key,
      props: {
        decorations: activeTable,
        handleDOMEvents: {
          touchstart: (view, e) => {
            if (!view.editable || e.touches.length !== 1) return false;
            const t = e.touches[0];
            let cellEl = (e.target as HTMLElement).closest?.('td, th') as HTMLTableCellElement | null;
            if (!cellEl || !cellEl.closest('.table-active') || !view.dom.contains(cellEl)) return false;
            // Grab the border nearest the finger: this cell's right edge, or the left one (the previous column's).
            const r = cellEl.getBoundingClientRect();
            let right = Math.abs(t.clientX - r.right) <= TOUCH_SLOP;
            if (!right && Math.abs(t.clientX - r.left) <= TOUCH_SLOP) {
              const prev = cellEl.previousElementSibling as HTMLTableCellElement | null;
              if (!prev) return false;
              cellEl = prev;
              right = true;
            }
            if (!right) return false;
            const cellPos = view.posAtDOM(cellEl, 0) - 1;
            const $cell = view.state.doc.resolve(cellPos);
            const tableNode = $cell.node(-1);
            if (tableNode?.type.spec.tableRole !== 'table') return false;
            const tablePos = $cell.before(-1);
            const map = TableMap.get(tableNode);
            const cell = $cell.nodeAfter!;
            const col = map.colCount(cellPos - (tablePos + 1)) + cell.attrs.colspan - 1;
            const tableEl = cellEl.closest('table')!;
            const cols = [...tableEl.querySelectorAll(':scope > colgroup > col')] as HTMLTableColElement[];
            if (!cols[col]) return false;
            const own = cell.attrs.colwidth?.[cell.attrs.colwidth.length - 1];
            const startWidth = own || Math.round(cellEl.getBoundingClientRect().width / cell.attrs.colspan);
            const saved = { cols: cols.map((c) => c.style.width), minWidth: tableEl.style.minWidth };
            // While dragging, fix the other columns at their current size, so only the dragged one moves.
            cols.forEach((c, i) => { if (!c.style.width) c.style.width = `${Math.round(tableEl.rows[0]?.cells[i]?.getBoundingClientRect().width ?? TABLE_CELL_MIN_WIDTH)}px`; });
            drag = { tablePos, col, startX: t.clientX, startWidth, width: startWidth, cols, table: tableEl, saved };
            document.documentElement.classList.add('table-resizing');
            window.addEventListener('touchmove', move, { passive: false });
            window.addEventListener('touchend', end);
            window.addEventListener('touchcancel', end);
            e.preventDefault(); // no scroll, no caret move, no long-press menu
            return true;
          },
        },
      },
    })];
  },
});
