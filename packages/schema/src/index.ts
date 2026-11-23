// Shared document model. The web editor, the collab server and agents all use this,
// so a page means the same thing to every participant.
//
// A page is ONE Y.Doc:
//   - Map "tabs"              tabId -> { id, title, order }. Empty means one implicit tab ("main").
//   - XmlFragment per tab     the TipTap block tree of that tab: "default" for the main tab, "tab:<id>" for others
//                             (paragraphs, headings, lists, tables, htmlBlock and mindMap nodes, all mixed freely)
//   - Map "htmlCode"          blockId -> Y.Text holding that HTML block's source (so code is co-edited char by char)
//   - Map "comments"          commentId -> Y.Map (anchor, author, body, resolved)  [see SPEC.md, not wired in the UI yet]
//   - Map "meta"              title, icon, etc.
//   - Map "actions"           actionId -> BlockAction: values a user sent from an HTML block's controls to the agent
//
// Links to other pages or tabs are inline "pageLink" elements inside a paragraph (attrs page, tab, label).
// They point at ids, so they keep working when the target is renamed or moved.
import * as Y from 'yjs';

export const FRAGMENT = 'default';
export const HTML_CODE = 'htmlCode';
export const COMMENTS = 'comments';
export const META = 'meta';
export const HTML_NODE = 'htmlBlock';
export const ACTIONS = 'actions';

export const TABS = 'tabs';
export const MAIN_TAB = 'main';

// ---------------------------------------------------------------------------
// Tabs. Optional: a page with no entries in "tabs" has one implicit main tab and
// looks like a normal page. Each tab is its own block tree; block data maps
// (htmlCode, mindMaps, actions) are shared by the whole page and keyed by block id.

export type Tab = { id: string; title: string; order: number };

export const tabsMap = (doc: Y.Doc) => doc.getMap<Tab>(TABS);

export function fragmentName(tab: string = MAIN_TAB): string {
  return tab === MAIN_TAB ? FRAGMENT : `tab:${tab}`;
}

export const fragment = (doc: Y.Doc, tab: string = MAIN_TAB) => doc.getXmlFragment(fragmentName(tab));

/** Tabs in order. Always at least the main tab. */
export function listTabs(doc: Y.Doc): Tab[] {
  const tabs = [...tabsMap(doc).values()];
  if (!tabs.some((t) => t.id === MAIN_TAB)) tabs.push({ id: MAIN_TAB, title: 'Page', order: -1 });
  return tabs.sort((a, b) => a.order - b.order);
}

/** Accepts a tab id or a tab title (case-insensitive). Defaults to the main tab. */
export function resolveTab(doc: Y.Doc, idOrTitle?: string | null): string {
  if (!idOrTitle) return MAIN_TAB;
  const tabs = listTabs(doc);
  const hit = tabs.find((t) => t.id === idOrTitle) ?? tabs.find((t) => t.title.toLowerCase() === idOrTitle.toLowerCase());
  if (!hit) throw new Error(`no tab "${idOrTitle}" (tabs: ${tabs.map((t) => t.title).join(', ')})`);
  return hit.id;
}

export function addTab(doc: Y.Doc, title: string): string {
  const id = newId('tab');
  doc.transact(() => {
    const map = tabsMap(doc);
    // The first extra tab also writes the implicit main tab, so both show in the bar.
    if (!map.has(MAIN_TAB)) map.set(MAIN_TAB, { id: MAIN_TAB, title: 'Page', order: 0 });
    const max = Math.max(...[...map.values()].map((t) => t.order));
    map.set(id, { id, title: title || 'Untitled', order: max + 1 });
  });
  return id;
}

export function renameTab(doc: Y.Doc, id: string, title: string): void {
  const map = tabsMap(doc);
  const t = map.get(id) ?? (id === MAIN_TAB ? { id, title: 'Page', order: 0 } : undefined);
  if (t) map.set(id, { ...t, title: title || 'Untitled' });
}

/** Remove a tab and its blocks. The main tab cannot be removed. */
export function removeTab(doc: Y.Doc, id: string): void {
  if (id === MAIN_TAB) return;
  doc.transact(() => {
    const f = fragment(doc, id);
    f.delete(0, f.length);
    tabsMap(doc).delete(id);
  });
}
export const htmlCodeMap = (doc: Y.Doc) => doc.getMap<Y.Text>(HTML_CODE);

export function newId(prefix = 'b'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

/** Get (or lazily create) the shared code text for an HTML block. */
export function htmlCodeText(doc: Y.Doc, blockId: string): Y.Text {
  const map = htmlCodeMap(doc);
  let text = map.get(blockId);
  if (!text) {
    text = new Y.Text();
    map.set(blockId, text);
  }
  return text;
}

function textOf(el: Y.XmlElement | Y.XmlText): string {
  if (el instanceof Y.XmlText) return el.toString().replace(/<[^>]+>/g, '');
  if (el.nodeName === LINK_NODE) return linkToken(el.getAttributes() as LinkTarget);
  return el.toArray().map((c) => textOf(c as Y.XmlElement | Y.XmlText)).join('');
}

function tableAsMarkdown(table: Y.XmlElement): string {
  const rows = table.toArray().map((row) =>
    (row as Y.XmlElement).toArray().map((cell) => textOf(cell as Y.XmlElement).replace(/\|/g, '\\|')));
  if (!rows.length) return '';
  const line = (r: string[]) => `| ${r.join(' | ')} |`;
  return [line(rows[0]), line(rows[0].map(() => '---')), ...rows.slice(1).map(line)].join('\n');
}

export type BlockRow = {
  id: string;
  tab: string;
  position: number;
  type: string;
  text: string;
  attrs: Record<string, unknown>;
};

/** Flatten the top-level blocks of one tab, or of every tab when `tab` is omitted.
 *  Used for the Postgres `blocks` projection and for agents reading the page. */
export function listBlocks(doc: Y.Doc, tab?: string): BlockRow[] {
  const tabs = tab ? [tab] : listTabs(doc).map((t) => t.id);
  return tabs.flatMap((tabId) => fragment(doc, tabId)
    .toArray()
    .map((node, position) => {
      const fallback = `${tabId}:pos_${position}`;
      if (node instanceof Y.XmlText) {
        return { id: fallback, tab: tabId, position, type: 'text', text: node.toString(), attrs: {} };
      }
      const el = node as Y.XmlElement;
      const attrs = el.getAttributes() as Record<string, unknown>;
      const type = el.nodeName;
      const id = String(attrs.blockId ?? fallback);
      const text =
        type === HTML_NODE ? (htmlCodeMap(doc).get(id)?.toString() ?? '')
        : type === MIND_NODE ? mindMapAsOutline(doc, id)
        : type === 'table' ? tableAsMarkdown(el)
        : textOf(el);
      return { id, tab: tabId, position, type, text, attrs };
    }));
}

function blockAsMarkdown(b: BlockRow): string {
  if (b.type === 'heading') return `${'#'.repeat(Number(b.attrs.level ?? 1))} ${b.text}`;
  if (b.type === HTML_NODE) return `<html-block id="${b.id}" title="${b.attrs.title ?? ''}">\n${b.text}\n</html-block>`;
  if (b.type === MIND_NODE) return `<mind-map id="${b.id}" title="${b.attrs.title ?? ''}">\n${b.text}\n</mind-map>`;
  return b.text;
}

/** A compact, model-friendly rendering of the page. With several tabs, each tab is a <tab> section. */
export function pageAsMarkdown(doc: Y.Doc): string {
  const tabs = listTabs(doc);
  const render = (tab: string) => listBlocks(doc, tab).map(blockAsMarkdown).join('\n\n');
  if (tabs.length === 1) return render(tabs[0].id);
  return tabs.map((t) => `<tab id="${t.id}" title="${t.title}">\n${render(t.id)}\n</tab>`).join('\n\n');
}

export function makeParagraph(text = ''): { el: Y.XmlElement; text: Y.XmlText } {
  const el = new Y.XmlElement('paragraph');
  const t = new Y.XmlText();
  el.insert(0, [t]);
  if (text) t.insert(0, text);
  return { el, text: t };
}

export function appendHeading(doc: Y.Doc, text: string, level = 2, tab: string = MAIN_TAB): void {
  doc.transact(() => {
    const el = new Y.XmlElement('heading');
    el.setAttribute('level', level as unknown as string);
    const t = new Y.XmlText();
    el.insert(0, [t]);
    t.insert(0, text);
    const f = fragment(doc, tab);
    f.insert(f.length, [el]);
  });
}

export function appendParagraph(doc: Y.Doc, text: string, tab: string = MAIN_TAB): void {
  doc.transact(() => {
    const f = fragment(doc, tab);
    f.insert(f.length, [paragraphWithLinks(text)]);
  });
}

// ---------------------------------------------------------------------------
// Links between pages and tabs
//
// In text written by agents (and in what read_page returns) a link is written
//   [[p_abc123def]]            a page
//   [[p_abc123def#tab_x1]]     a tab of a page
//   [[p_abc123def|Label]]      with the text to show if the target cannot be opened
// The editor shows the target's current title, so renames never break a link.

export const LINK_NODE = 'pageLink';
export type LinkTarget = { page: string; tab?: string | null; label?: string | null };
export const LINK_RE = /\[\[(p_[\w-]{8,40})(?:#([\w-]{1,60}))?(?:\|([^\]\n]{0,200}))?\]\]/g;

export function linkToken(t: LinkTarget): string {
  return `[[${t.page}${t.tab && t.tab !== MAIN_TAB ? `#${t.tab}` : ''}${t.label ? `|${String(t.label).replace(/[\]|]/g, '')}` : ''}]]`;
}

/** Split text into plain strings and link targets. */
export function splitLinks(text: string): (string | LinkTarget)[] {
  const out: (string | LinkTarget)[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK_RE)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    out.push({ page: m[1], tab: m[2] ?? null, label: m[3] ?? null });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function makeLink(t: LinkTarget): Y.XmlElement {
  const el = new Y.XmlElement(LINK_NODE);
  el.setAttribute('page', t.page);
  if (t.tab && t.tab !== MAIN_TAB) el.setAttribute('tab', t.tab);
  if (t.label) el.setAttribute('label', String(t.label).slice(0, 200));
  return el;
}

/** A paragraph element from text that may contain [[...]] links. */
export function paragraphWithLinks(text: string): Y.XmlElement {
  const el = new Y.XmlElement('paragraph');
  const parts = splitLinks(text).map((p) => {
    if (typeof p !== 'string') return makeLink(p);
    const t = new Y.XmlText();
    t.insert(0, p);
    return t;
  });
  el.insert(0, parts.length ? parts : [new Y.XmlText()]);
  return el;
}

export type PageLinkRow = { fromTab: string; page: string; tab: string | null };

/** Every link on the page (all tabs), for the backlinks index. */
export function listLinks(doc: Y.Doc): PageLinkRow[] {
  const out: PageLinkRow[] = [];
  const walk = (node: Y.XmlElement | Y.XmlFragment | Y.XmlText, fromTab: string) => {
    if (node instanceof Y.XmlText) return;
    if (node instanceof Y.XmlElement && node.nodeName === LINK_NODE) {
      const page = node.getAttribute('page');
      if (page) out.push({ fromTab, page, tab: node.getAttribute('tab') || null });
      return;
    }
    node.toArray().forEach((c) => walk(c as Y.XmlElement, fromTab));
  };
  for (const t of listTabs(doc)) walk(fragment(doc, t.id), t.id);
  return out;
}

// ---------------------------------------------------------------------------
// HTML blocks
//
// Block attrs in the tree: blockId, title, status ('streaming' | 'ready'),
// initialHeight (px reserved before any code arrives), placeholders (JSON string[]
// shown while the block is being written). Code lives in the htmlCode map.

export type HtmlBlockStatus = 'streaming' | 'ready';

export type HtmlBlockOptions = {
  title?: string;
  tab?: string;
  index?: number;
  status?: HtmlBlockStatus;
  initialHeight?: number;
  placeholders?: string[];
};

/**
 * The parts of a custom UI, in the order an agent should stream them
 * (pattern borrowed from CopilotKit's OpenIntelligentUI): size and placeholder
 * first so the page reserves space, then CSS, then HTML so the block can be
 * previewed while it is written, and scripts last so they run once, on complete markup.
 */
export type HtmlParts = {
  initialHeight?: number;
  placeholders?: string[];
  css?: string;
  html?: string;
  js?: string;
};

/** The code sections in stream order. */
export function htmlSections(parts: HtmlParts): string[] {
  const out: string[] = [];
  if (parts.css) out.push(`<style>\n${parts.css.trim()}\n</style>\n`);
  if (parts.html) out.push(`${parts.html.trim()}\n`);
  if (parts.js) out.push(`<script>\n${parts.js.trim()}\n</script>\n`);
  return out;
}

export function findHtmlElement(doc: Y.Doc, blockId: string): Y.XmlElement | null {
  for (const tab of listTabs(doc)) {
    for (const node of fragment(doc, tab.id).toArray()) {
      if (node instanceof Y.XmlElement && node.nodeName === HTML_NODE && node.getAttribute('blockId') === blockId) return node;
    }
  }
  return null;
}

export function setHtmlBlockStatus(doc: Y.Doc, blockId: string, status: HtmlBlockStatus): void {
  findHtmlElement(doc, blockId)?.setAttribute('status', status);
}

/** Insert an HTML/JS block. `index` defaults to the end of the page. Returns the block id. */
export function insertHtmlBlock(doc: Y.Doc, code: string, opts: HtmlBlockOptions = {}): string {
  const blockId = newId('html');
  doc.transact(() => {
    htmlCodeText(doc, blockId).insert(0, code);
    const el = new Y.XmlElement(HTML_NODE);
    el.setAttribute('blockId', blockId);
    el.setAttribute('title', opts.title ?? '');
    el.setAttribute('status', opts.status ?? 'ready');
    el.setAttribute('initialHeight', (opts.initialHeight ?? 120) as unknown as string);
    el.setAttribute('placeholders', JSON.stringify(opts.placeholders ?? []));
    const f = fragment(doc, opts.tab);
    f.insert(Math.min(opts.index ?? f.length, f.length), [el]);
  });
  return blockId;
}

/** Replace an HTML block's code. */
export function setHtmlCode(doc: Y.Doc, blockId: string, code: string): void {
  doc.transact(() => {
    const t = htmlCodeText(doc, blockId);
    t.delete(0, t.length);
    t.insert(0, code);
  });
}

// ---------------------------------------------------------------------------
// Native components. An agent should prefer these over custom UI when they fit:
// they are editable, searchable and exportable like the rest of the page.

/** Append a table. The first row is the header unless header=false. */
export function insertTable(doc: Y.Doc, rows: string[][], opts: { header?: boolean; index?: number; tab?: string } = {}): void {
  const header = opts.header ?? true;
  doc.transact(() => {
    const table = new Y.XmlElement('table');
    const rowEls = rows.map((cells, r) => {
      const row = new Y.XmlElement('tableRow');
      row.insert(0, cells.map((cell) => {
        const c = new Y.XmlElement(header && r === 0 ? 'tableHeader' : 'tableCell');
        c.insert(0, [makeParagraph(String(cell)).el]);
        return c;
      }));
      return row;
    });
    table.insert(0, rowEls);
    const f = fragment(doc, opts.tab);
    f.insert(Math.min(opts.index ?? f.length, f.length), [table]);
  });
}

// ---------------------------------------------------------------------------
// Host bridge: actions sent from an HTML block's controls back to the agent.

export type BlockAction = {
  id: string;
  blockId: string;
  action: string;
  values: Record<string, unknown>;
  by: string;
  at: number;
  status: 'pending' | 'claimed' | 'done';
  note?: string;
};

export const actionsMap = (doc: Y.Doc) => doc.getMap<BlockAction>(ACTIONS);

export const ACTION_LIMITS = { nameMax: 64, valuesMaxBytes: 8192, perBlockPerSecond: 1 };

/** Validate untrusted input coming out of a sandboxed block. Returns null when it is not acceptable. */
export function validateAction(action: unknown, values: unknown): { action: string; values: Record<string, unknown> } | null {
  if (typeof action !== 'string' || !/^[\w.-]{1,64}$/.test(action)) return null;
  const v = values ?? {};
  if (typeof v !== 'object' || Array.isArray(v)) return null;
  let json: string;
  try { json = JSON.stringify(v); } catch { return null; }
  if (json.length > ACTION_LIMITS.valuesMaxBytes) return null;
  return { action, values: JSON.parse(json) };
}

export function pushAction(doc: Y.Doc, a: Omit<BlockAction, 'id' | 'at' | 'status'>): string {
  const id = newId('act');
  actionsMap(doc).set(id, { ...a, id, at: Date.now(), status: 'pending' });
  return id;
}

export function pendingActions(doc: Y.Doc): BlockAction[] {
  return [...actionsMap(doc).values()].filter((a) => a.status === 'pending').sort((x, y) => x.at - y.at);
}

export function updateAction(doc: Y.Doc, id: string, patch: Partial<Pick<BlockAction, 'status' | 'note'>>): void {
  const a = actionsMap(doc).get(id);
  if (a) actionsMap(doc).set(id, { ...a, ...patch });
}

// ---------------------------------------------------------------------------
// Mind maps. A native block (not sandboxed): nodes live in the doc so people and
// agents edit the same map, node by node, with the same live merging as text.
//   tree attrs:  mindMap { blockId, title }
//   data:        Map "mindMaps"  blockId -> Y.Map<nodeId, MindNode>

export const MIND_NODE = 'mindMap';
export const MIND_MAPS = 'mindMaps';

export type MindNode = { id: string; text: string; parent: string | null; order: number };
export type MindTree = { text: string; children?: MindTree[] };

export function mindMapNodes(doc: Y.Doc, blockId: string): Y.Map<MindNode> {
  const all = doc.getMap<Y.Map<MindNode>>(MIND_MAPS);
  let m = all.get(blockId);
  if (!m) {
    m = new Y.Map<MindNode>();
    all.set(blockId, m);
  }
  return m;
}

export function addMindNode(doc: Y.Doc, blockId: string, parent: string | null, text: string): string {
  const nodes = mindMapNodes(doc, blockId);
  const siblings = [...nodes.values()].filter((n) => n.parent === parent);
  const id = newId('n');
  nodes.set(id, { id, text, parent, order: siblings.length ? Math.max(...siblings.map((s) => s.order)) + 1 : 0 });
  return id;
}

export function setMindNodeText(doc: Y.Doc, blockId: string, nodeId: string, text: string): void {
  const nodes = mindMapNodes(doc, blockId);
  const n = nodes.get(nodeId);
  if (n) nodes.set(nodeId, { ...n, text });
}

export function removeMindNode(doc: Y.Doc, blockId: string, nodeId: string): void {
  const nodes = mindMapNodes(doc, blockId);
  doc.transact(() => {
    const drop = (id: string) => {
      for (const n of [...nodes.values()]) if (n.parent === id) drop(n.id);
      nodes.delete(id);
    };
    drop(nodeId);
  });
}

/** Children of a node, sorted. parent=null gives the root(s). */
export function mindChildren(nodes: Iterable<MindNode>, parent: string | null): MindNode[] {
  return [...nodes].filter((n) => n.parent === parent).sort((a, b) => a.order - b.order);
}

export function insertMindMap(doc: Y.Doc, tree: MindTree, opts: { title?: string; index?: number; tab?: string } = {}): string {
  const blockId = newId('mind');
  doc.transact(() => {
    const add = (t: MindTree, parent: string | null) => {
      const id = addMindNode(doc, blockId, parent, t.text);
      (t.children ?? []).forEach((c) => add(c, id));
    };
    add(tree, null);
    const el = new Y.XmlElement(MIND_NODE);
    el.setAttribute('blockId', blockId);
    el.setAttribute('title', opts.title ?? '');
    const f = fragment(doc, opts.tab);
    f.insert(Math.min(opts.index ?? f.length, f.length), [el]);
  });
  return blockId;
}

export function mindMapAsOutline(doc: Y.Doc, blockId: string): string {
  const nodes = [...mindMapNodes(doc, blockId).values()];
  const lines: string[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const n of mindChildren(nodes, parent)) {
      lines.push(`${'  '.repeat(depth)}- ${n.text} (node ${n.id})`);
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  return lines.join('\n');
}
