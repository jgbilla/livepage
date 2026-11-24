// Targeted edits: read a page as addressable blocks and change only what needs changing,
// instead of rewriting the page. Used by the MCP tools, the HTTP agent API and the built-in assistant.
//
// A "block" is a top-level node of a tab (paragraph, heading, list, table, code block, HTML block, mind map...).
// Block ids are stable: HTML blocks and mind maps use their blockId attribute; every other block uses the id
// Yjs gave the node when it was created (b_<client>_<clock>), so an id survives edits to the block and to
// everything around it, for every participant, without storing anything extra in the page.
// A block that is replaced or moved is a new node and gets a new id; the edit functions return the new ids.
import * as Y from 'yjs';
import { fragment, HTML_NODE, listTabs, MAIN_TAB, makeParagraph, MIND_NODE, mindMapAsOutline, htmlCodeMap } from './index.ts';
import { blockToMarkdown, markdownToBlocks } from './markdown.ts';
import { plainText } from './walk.ts';

type Node = Y.XmlElement | Y.XmlText;

/** The stable id of a top-level block. `fallback` is used for nodes not yet in a doc. */
export function blockIdOf(node: Node, fallback = ''): string {
  if (node instanceof Y.XmlElement) {
    const own = node.getAttribute('blockId');
    if (own) return String(own);
  }
  const id = node._item?.id;
  return id ? `b_${id.client.toString(36)}_${id.clock.toString(36)}` : fallback;
}

export type BlockRef = { id: string; tab: string; index: number; node: Node };

const topBlocks = (doc: Y.Doc, tab: string): Node[] => fragment(doc, tab).toArray() as Node[];

export function findBlock(doc: Y.Doc, id: string): BlockRef | null {
  for (const t of listTabs(doc)) {
    const nodes = topBlocks(doc, t.id);
    for (let index = 0; index < nodes.length; index++) {
      if (blockIdOf(nodes[index]) === id) return { id, tab: t.id, index, node: nodes[index] };
    }
  }
  return null;
}

function mustFind(doc: Y.Doc, id: string): BlockRef {
  const hit = findBlock(doc, id);
  if (!hit) throw new Error(`no block ${id} on this page (it may have been replaced, moved or deleted; read the blocks again)`);
  return hit;
}

/** A run of neighbouring blocks: `id` alone, or everything from `id` through `through` (same tab, either order). */
function range(doc: Y.Doc, id: string, through?: string | null): { tab: string; from: number; count: number } {
  const a = mustFind(doc, id);
  if (!through || through === id) return { tab: a.tab, from: a.index, count: 1 };
  const b = mustFind(doc, through);
  if (b.tab !== a.tab) throw new Error('block_id and through_block_id are in different tabs');
  const from = Math.min(a.index, b.index);
  return { tab: a.tab, from, count: Math.abs(a.index - b.index) + 1 };
}

const typeOf = (n: Node) => (n instanceof Y.XmlText ? 'text' : n.nodeName);
const headingLevel = (n: Node) => (n instanceof Y.XmlElement && n.nodeName === 'heading' ? Number(n.getAttribute('level') ?? 1) : 0);

// ---------------------------------------------------------------------------
// Reading

export type OutlineHeading = { id: string; level: number; text: string; blocks: number };
export type OutlineTab = { id: string; title: string; blocks: number; headings: OutlineHeading[] };

/** The headings of each tab with their block ids and how many blocks each section holds (heading included). */
export function pageOutline(doc: Y.Doc, tab?: string): OutlineTab[] {
  return listTabs(doc).filter((t) => !tab || t.id === tab).map((t) => {
    const nodes = topBlocks(doc, t.id);
    const headings: OutlineHeading[] = [];
    nodes.forEach((n, i) => {
      const level = headingLevel(n);
      if (!level) return;
      let end = i + 1;
      while (end < nodes.length && !(headingLevel(nodes[end]) && headingLevel(nodes[end]) <= level)) end++;
      headings.push({ id: blockIdOf(n), level, text: plainText(n), blocks: end - i });
    });
    return { id: t.id, title: t.title, blocks: nodes.length, headings };
  });
}

export function outlineAsText(tabs: OutlineTab[]): string {
  return tabs.map((t) => [
    `tab ${t.id} "${t.title}" (${t.blocks} blocks)`,
    ...t.headings.map((h) => `${'  '.repeat(h.level)}${'#'.repeat(h.level)} ${h.text}  [${h.id}]  (${h.blocks} blocks)`),
  ].join('\n')).join('\n\n');
}

export type BlockView = { id: string; tab: string; position: number; type: string; markdown: string };

function viewOf(doc: Y.Doc, node: Node, tab: string, position: number): BlockView {
  const id = blockIdOf(node, `${tab}:pos_${position}`);
  const type = typeOf(node);
  // HTML blocks and mind maps are shown the way read_page shows them (code, node ids): they have their own edit tools.
  const markdown =
    type === HTML_NODE ? `<html-block title="${(node as Y.XmlElement).getAttribute('title') ?? ''}">\n${htmlCodeMap(doc).get(id)?.toString() ?? ''}\n</html-block>`
    : type === MIND_NODE ? `<mind-map title="${(node as Y.XmlElement).getAttribute('title') ?? ''}">\n${mindMapAsOutline(doc, id)}\n</mind-map>`
    : blockToMarkdown(doc, node);
  return { id, tab, position, type, markdown };
}

export type ReadBlocksOptions = {
  /** Only this tab. Defaults to every tab, or to the tab of `section` / `from`. */
  tab?: string;
  /** A heading's block id: read that heading and everything under it, up to the next heading of the same or a higher level. */
  section?: string;
  /** Start at this block id. */
  from?: string;
  /** At most this many blocks (after `from` / inside `section`). */
  limit?: number;
};

/** Blocks with their ids and Markdown: the whole page, one tab, one section, or a window starting at a block. */
export function readBlocks(doc: Y.Doc, opts: ReadBlocksOptions = {}): { blocks: BlockView[]; more: number } {
  const limit = Math.max(1, Math.min(opts.limit ?? 1000, 1000));
  if (opts.section || opts.from) {
    const start = mustFind(doc, (opts.section ?? opts.from)!);
    const nodes = topBlocks(doc, start.tab);
    let end = nodes.length;
    if (opts.section) {
      const level = headingLevel(start.node);
      if (!level) throw new Error(`block ${opts.section} is not a heading; use from to read from any block`);
      end = start.index + 1;
      while (end < nodes.length && !(headingLevel(nodes[end]) && headingLevel(nodes[end]) <= level)) end++;
    }
    const stop = Math.min(end, start.index + limit);
    return { blocks: nodes.slice(start.index, stop).map((n, i) => viewOf(doc, n, start.tab, start.index + i)), more: end - stop };
  }
  const all = listTabs(doc).filter((t) => !opts.tab || t.id === opts.tab)
    .flatMap((t) => topBlocks(doc, t.id).map((n, i) => viewOf(doc, n, t.id, i)));
  return { blocks: all.slice(0, limit), more: Math.max(0, all.length - limit) };
}

/** `[id type]` on a line of its own, then the block's Markdown. Tabs are marked when the page has several. */
export function blocksAsText(doc: Y.Doc, r: { blocks: BlockView[]; more: number }): string {
  const tabs = listTabs(doc);
  const out: string[] = [];
  let tab = '';
  for (const b of r.blocks) {
    if (tabs.length > 1 && b.tab !== tab) {
      tab = b.tab;
      out.push(`=== tab ${tab} "${tabs.find((t) => t.id === tab)?.title ?? ''}" ===`);
    }
    out.push(`[${b.id} ${b.type}]\n${b.markdown}`.trimEnd());
  }
  if (r.more > 0) out.push(`(${r.more} more blocks: call again with from set to the block after the last one, or read a section)`);
  return out.join('\n\n');
}

// ---------------------------------------------------------------------------
// Editing blocks

export type Where = {
  /** Insert right before this block. */
  before?: string | null;
  /** Insert right after this block. */
  after?: string | null;
  /** Without before/after: the start or the end (default) of `tab`. */
  at?: 'start' | 'end';
  tab?: string;
};

function place(doc: Y.Doc, where: Where): { tab: string; index: number } {
  if (where.before) { const b = mustFind(doc, where.before); return { tab: b.tab, index: b.index }; }
  if (where.after) { const b = mustFind(doc, where.after); return { tab: b.tab, index: b.index + 1 }; }
  const tab = where.tab ?? MAIN_TAB;
  return { tab, index: where.at === 'start' ? 0 : fragment(doc, tab).length };
}

const idsAt = (doc: Y.Doc, tab: string, index: number, count: number) =>
  topBlocks(doc, tab).slice(index, index + count).map((n) => blockIdOf(n));

/** Insert Markdown as new blocks. Returns the new block ids. */
export function insertBlocks(doc: Y.Doc, markdown: string, where: Where = {}): { tab: string; ids: string[] } {
  let out = { tab: MAIN_TAB, ids: [] as string[] };
  doc.transact(() => {
    const { tab, index } = place(doc, where);
    const els = markdownToBlocks(doc, markdown);
    if (!els.length) throw new Error('markdown is empty');
    fragment(doc, tab).insert(index, els);
    out = { tab, ids: idsAt(doc, tab, index, els.length) };
  });
  return out;
}

/** Replace one block (or the run from `id` through `through`) with Markdown. Returns the new block ids. */
export function replaceBlocks(doc: Y.Doc, id: string, markdown: string, through?: string | null): { tab: string; ids: string[] } {
  let out = { tab: MAIN_TAB, ids: [] as string[] };
  doc.transact(() => {
    const r = range(doc, id, through);
    const els = markdownToBlocks(doc, markdown);
    if (!els.length) throw new Error('markdown is empty; use delete_blocks to remove blocks');
    const f = fragment(doc, r.tab);
    // New blocks go in first, so a caret or comment just after the old ones stays where it was.
    f.insert(r.from + r.count, els);
    f.delete(r.from, r.count);
    out = { tab: r.tab, ids: idsAt(doc, r.tab, r.from, els.length) };
  });
  return out;
}

/** Delete one block, or the run from `id` through `through`. Returns how many were removed. */
export function deleteBlocks(doc: Y.Doc, id: string, through?: string | null): number {
  let n = 0;
  doc.transact(() => {
    const r = range(doc, id, through);
    fragment(doc, r.tab).delete(r.from, r.count);
    n = r.count;
  });
  return n;
}

/** Move one block (or a run) before/after another block, or to the start/end of a tab. Moved blocks get new ids. */
export function moveBlocks(doc: Y.Doc, id: string, where: Where, through?: string | null): { tab: string; ids: string[] } {
  let out = { tab: MAIN_TAB, ids: [] as string[] };
  doc.transact(() => {
    const r = range(doc, id, through);
    const src = fragment(doc, r.tab);
    const nodes = topBlocks(doc, r.tab).slice(r.from, r.from + r.count);
    const target = where.before ?? where.after;
    if (target && nodes.some((n) => blockIdOf(n) === target)) throw new Error('cannot move blocks next to themselves');
    const copies = nodes.map((n) => n.clone() as Node);
    const dest = place(doc, { ...where, tab: where.tab ?? r.tab });
    fragment(doc, dest.tab).insert(dest.index, copies);
    // Inserting above the source in the same tab shifts it down.
    const shift = dest.tab === r.tab && dest.index <= r.from ? copies.length : 0;
    src.delete(r.from + shift, r.count);
    const at = dest.tab === r.tab && dest.index > r.from ? dest.index - r.count : dest.index;
    out = { tab: dest.tab, ids: idsAt(doc, dest.tab, at, copies.length) };
  });
  return out;
}

// ---------------------------------------------------------------------------
// Find and replace inside text, in place (formatting, links, footnotes and comments around it are untouched)

export type TextHit = { blockId: string; tab: string; text: Y.XmlText; offset: number; length: number };

function textsIn(node: Node): Y.XmlText[] {
  if (node instanceof Y.XmlText) return [node];
  if (node.nodeName === HTML_NODE || node.nodeName === MIND_NODE) return [];
  return node.toArray().flatMap((c) => (c instanceof Y.XmlText || c instanceof Y.XmlElement ? textsIn(c) : []));
}

type Op = { insert: unknown; attributes?: Record<string, unknown> };
const runText = (t: Y.XmlText) => (t.toDelta() as Op[]).map((op) => (typeof op.insert === 'string' ? op.insert : '￼')).join('');

export type FindOptions = {
  /** Only inside this block. */
  blockId?: string | null;
  /** Only in this tab. Defaults to every tab. */
  tab?: string | null;
  matchCase?: boolean;
};

/** Every place `find` appears in the page's text, in reading order. A match never spans two blocks, list items or cells. */
export function findText(doc: Y.Doc, find: string, opts: FindOptions = {}): TextHit[] {
  if (!find) return [];
  const needle = opts.matchCase === false ? find.toLowerCase() : find;
  const hits: TextHit[] = [];
  const scan = (node: Node, tab: string) => {
    const blockId = blockIdOf(node);
    for (const text of textsIn(node)) {
      const s = opts.matchCase === false ? runText(text).toLowerCase() : runText(text);
      for (let at = s.indexOf(needle); at >= 0; at = s.indexOf(needle, at + needle.length)) {
        hits.push({ blockId, tab, text, offset: at, length: find.length });
      }
    }
  };
  if (opts.blockId) {
    const b = mustFind(doc, opts.blockId);
    scan(b.node, b.tab);
  } else {
    for (const t of listTabs(doc)) if (!opts.tab || t.id === opts.tab) topBlocks(doc, t.id).forEach((n) => scan(n, t.id));
  }
  return hits;
}

/** The marks on the character at `offset`, so replacement text keeps the formatting of what it replaces. */
export function marksAt(text: Y.XmlText, offset: number): Record<string, unknown> {
  let at = 0;
  for (const op of text.toDelta() as Op[]) {
    const len = typeof op.insert === 'string' ? op.insert.length : 1;
    if (offset < at + len) return { ...(op.attributes ?? {}) };
    at += len;
  }
  return {};
}

export type ReplaceOptions = FindOptions & {
  /** Replace every match instead of one. */
  all?: boolean;
  /** Which match to replace when not `all` (1 = first). Required when the text appears more than once. */
  occurrence?: number;
};

/** Pick the matches a replace should touch. Throws with a useful message when the text is missing or ambiguous. */
export function hitsToReplace(doc: Y.Doc, find: string, opts: ReplaceOptions = {}): TextHit[] {
  if (!find) throw new Error('find is empty');
  let hits = findText(doc, find, opts);
  // Quoted from Markdown: "read\_page" is "read_page" on the page.
  if (!hits.length && /\\[\\`*_[\]<#>+.-]/.test(find)) hits = findText(doc, find.replace(/\\([\\`*_[\]<#>+.-])/g, '$1'), opts);
  if (!hits.length) {
    throw new Error(`"${find.slice(0, 80)}" is not on the page${opts.blockId ? ' in that block' : ''}. Quote it exactly as the page has it (without Markdown markers), within one paragraph, list item or table cell.`);
  }
  if (opts.all) return hits;
  if (opts.occurrence) {
    const hit = hits[opts.occurrence - 1];
    if (!hit) throw new Error(`only ${hits.length} match${hits.length === 1 ? '' : 'es'} of "${find.slice(0, 80)}"`);
    return [hit];
  }
  if (hits.length > 1) {
    const blocks = [...new Set(hits.map((h) => h.blockId))];
    throw new Error(`"${find.slice(0, 80)}" appears ${hits.length} times (blocks ${blocks.slice(0, 8).join(', ')}). Quote more words, or pass block_id, occurrence, or all.`);
  }
  return hits;
}

// Marks that Markdown can write, so a replacement's **bold**, `code`, ~~strike~~, *italic* and [links](url) apply.
const MD_MARKS = ['bold', 'italic', 'strike', 'code', 'link'] as const;
type Run = { text: string; marks: Record<string, unknown> | null /* null = keep the formatting already there */ };

/**
 * The replacement as runs of text. Markdown markers in it become formatting; anything that is not a single
 * line of inline Markdown (a list, a heading, a page link...) is taken literally.
 */
function replacementRuns(replace: string): { runs: Run[]; formatted: boolean } {
  const literal = { runs: [{ text: replace, marks: null }], formatted: false };
  if (!/[*_`~[\\]/.test(replace)) return literal;
  const lead = replace.match(/^\s*/)![0];
  const core = replace.slice(lead.length).trimEnd();
  const trail = replace.slice(lead.length + core.length);
  if (!core) return literal;
  const scratch = new Y.Doc();
  const els = markdownToBlocks(scratch, core);
  if (els.length !== 1 || els[0].nodeName !== 'paragraph') return literal;
  fragment(scratch).insert(0, els);
  const kids = els[0].toArray();
  if (!kids.every((k) => k instanceof Y.XmlText)) return literal;
  const parsed: Run[] = kids.flatMap((k) => ((k as Y.XmlText).toDelta() as Op[])
    .map((op) => ({ text: typeof op.insert === 'string' ? op.insert : '', marks: { ...(op.attributes ?? {}) } })));
  // Only escapes ("read\_page"): plain text, keeping the formatting already there.
  if (parsed.every((r) => !Object.keys(r.marks!).length)) return { runs: [{ text: lead + parsed.map((r) => r.text).join('') + trail, marks: null }], formatted: false };
  return { runs: [{ text: lead, marks: null }, ...parsed, { text: trail, marks: null }].filter((r) => r.text), formatted: true };
}

const sameMark = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Change one match with as small an edit as possible: the words that stay the same are left alone, so
 * their formatting, links, footnotes and comment anchors survive. Only the part that differs is rewritten.
 */
function replaceHit(h: TextHit, replace: string) {
  const old = runText(h.text).slice(h.offset, h.offset + h.length);
  const { runs, formatted } = replacementRuns(replace);
  const chars = runs.flatMap((r) => [...r.text].map((ch) => ({ ch, marks: r.marks })));
  const neu = chars.map((c) => c.ch).join('');
  // Compare by UTF-16 units, as Yjs offsets are.
  const units: { ch: string; marks: Run['marks'] }[] = chars.flatMap((c) => c.ch.split('').map((u) => ({ ch: u, marks: c.marks })));
  let pre = 0;
  while (pre < old.length && pre < neu.length && old[pre] === neu[pre]) pre++;
  let suf = 0;
  while (suf < old.length - pre && suf < neu.length - pre && old[old.length - 1 - suf] === neu[neu.length - 1 - suf]) suf++;

  // Formatting for new text with none of its own: like typing, it takes the marks of the text before it.
  const at = h.offset + pre;
  const inherited = pre > 0 ? marksAt(h.text, at - 1) : marksAt(h.text, at);
  const midOld = old.length - pre - suf;
  if (midOld > 0) h.text.delete(at, midOld);
  let pos = at;
  const mid = units.slice(pre, units.length - suf);
  for (let i = 0; i < mid.length;) {
    const marks = mid[i].marks;
    let j = i;
    while (j < mid.length && mid[j].marks === marks) j++;
    const text = mid.slice(i, j).map((u) => u.ch).join('');
    const attrs = marks ? { ...Object.fromEntries(Object.entries(inherited).filter(([k]) => !(MD_MARKS as readonly string[]).includes(k))), ...marks } : inherited;
    h.text.insert(pos, text, attrs);
    pos += text.length;
    i = j;
  }

  // Kept words whose Markdown formatting changed ("word" -> "**word**"): reformat them in place.
  if (!formatted) return;
  const kept = [...units.slice(0, pre).map((u, i) => ({ u, idx: h.offset + i })),
    ...units.slice(units.length - suf).map((u, i) => ({ u, idx: pos + i }))];
  for (const { u, idx } of kept) {
    if (!u.marks) continue;
    const now = marksAt(h.text, idx);
    const change: Record<string, unknown> = {};
    for (const m of MD_MARKS) if (!sameMark(now[m], u.marks[m])) change[m] = u.marks[m] ?? null;
    if (Object.keys(change).length) h.text.format(idx, 1, change);
  }
}

/**
 * Find and replace in place. Returns the number of replacements and the blocks touched. Only the
 * characters that change are rewritten, and Markdown in the replacement (**bold**, `code`, [link](url)) applies.
 */
export function replaceText(doc: Y.Doc, find: string, replace: string, opts: ReplaceOptions = {}): { replaced: number; blocks: string[] } {
  let out = { replaced: 0, blocks: [] as string[] };
  doc.transact(() => {
    const hits = hitsToReplace(doc, find, opts);
    // Last match first, so earlier offsets in the same text stay valid.
    for (const h of [...hits].reverse()) replaceHit(h, replace);
    out = { replaced: hits.length, blocks: [...new Set(hits.map((h) => h.blockId))] };
  });
  return out;
}

// ---------------------------------------------------------------------------
// Tables: change a cell or a row without resending the table. Rows and columns count from 1; row 1 is the header.

function tableOf(doc: Y.Doc, id: string): Y.XmlElement {
  const b = mustFind(doc, id);
  if (!(b.node instanceof Y.XmlElement) || b.node.nodeName !== 'table') throw new Error(`block ${id} is a ${typeOf(b.node)}, not a table`);
  return b.node;
}

const rowsOf = (table: Y.XmlElement) => table.toArray().filter((r): r is Y.XmlElement => r instanceof Y.XmlElement);

/** Cell content from one line of Markdown (bold, links, [[page links]]...). */
function cellContent(doc: Y.Doc, text: string): Y.XmlElement[] {
  const els = text.trim() ? markdownToBlocks(doc, text) : [];
  return els.length ? els : [makeParagraph().el];
}

export function setTableCell(doc: Y.Doc, tableId: string, row: number, column: number, text: string): void {
  doc.transact(() => {
    const rows = rowsOf(tableOf(doc, tableId));
    const r = rows[row - 1];
    if (!r) throw new Error(`the table has ${rows.length} rows; row ${row} does not exist`);
    const cells = rowsOf(r);
    const cell = cells[column - 1];
    if (!cell) throw new Error(`row ${row} has ${cells.length} columns; column ${column} does not exist`);
    const old = cell.length;
    cell.insert(old, cellContent(doc, text));
    cell.delete(0, old);
  });
}

/** Add a row. `row` is where it goes (1-based; default: after the last row). Missing cells are left empty. */
export function insertTableRow(doc: Y.Doc, tableId: string, cells: string[], row?: number | null): number {
  let at = 0;
  doc.transact(() => {
    const table = tableOf(doc, tableId);
    const rows = rowsOf(table);
    const width = Math.max(1, ...rows.map((r) => r.length));
    if (cells.length > width) throw new Error(`the table has ${width} columns but ${cells.length} cells were given`);
    // Nothing goes above a header row.
    const first = rows[0] && rowsOf(rows[0]).some((c) => c.nodeName === 'tableHeader') ? 1 : 0;
    at = Math.max(first, Math.min(row ? row - 1 : rows.length, rows.length));
    // Column widths someone dragged (each cell's colwidth) carry over to the new row.
    const model = rows[at === 0 ? 0 : at - 1] ?? rows[0];
    const widths = model ? rowsOf(model).map((c) => c.getAttribute('colwidth')) : [];
    const el = new Y.XmlElement('tableRow');
    el.insert(0, Array.from({ length: width }, (_, i) => {
      const c = new Y.XmlElement('tableCell');
      const w = widths[i];
      if (Array.isArray(w) && w.length === 1) c.setAttribute('colwidth', [...w] as never); // an array, as the editor stores it
      c.insert(0, cellContent(doc, String(cells[i] ?? '')));
      return c;
    }));
    table.insert(at, [el]);
  });
  return at + 1;
}

export function deleteTableRow(doc: Y.Doc, tableId: string, row: number): void {
  doc.transact(() => {
    const table = tableOf(doc, tableId);
    const rows = rowsOf(table);
    if (!rows[row - 1]) throw new Error(`the table has ${rows.length} rows; row ${row} does not exist`);
    if (rows.length === 1) throw new Error('that is the only row; use delete_blocks to remove the table');
    table.delete(row - 1, 1);
  });
}
