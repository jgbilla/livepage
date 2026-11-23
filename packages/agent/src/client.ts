// A live agent participant. It joins a page over the same WebSocket protocol as a browser,
// so it has presence (a named caret) and its edits stream in as it types.
// Any model can drive it: the MCP server (mcp.ts) and the demo (demo.ts) both use it.
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import WebSocket from 'ws';
import * as Y from 'yjs';
import {
  actionsMap, addMindNode, appendHeading, fragment, htmlCodeText, htmlSections, insertHtmlBlock, insertMindMap, insertTable,
  addTab, listBlocks, listTabs, makeParagraph, resolveTab, pageAsMarkdown, pendingActions, removeMindNode, setHtmlBlockStatus, setHtmlCode,
  setMindNodeText, splitLinks, makeLink, updateAction, insertFootnote, updateFootnote, removeFootnote, listFootnotes,
  blockIdOf, blocksAsText, deleteBlocks, deleteTableRow, findBlock, hitsToReplace, insertBlocks, insertTableRow, marksAt, moveBlocks,
  outlineAsText, pageOutline, readBlocks, replaceBlocks, setTableCell,
  type BlockAction, type FootnoteInput, type HtmlParts, type MindTree, type ReadBlocksOptions, type ReplaceOptions, type Where,
} from '@livepage/schema';

export type AgentOptions = {
  url?: string; page: string; token?: string;
  /** Shown on the agent's avatar and caret, e.g. "Claude Code". */
  name?: string;
  /** Stable id (e.g. the agent token's id) so two agents with the same name stay apart. */
  id?: string;
  color?: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class LiveAgent {
  readonly doc = new Y.Doc();
  readonly provider: HocuspocusProvider;
  private socket: HocuspocusProviderWebsocket;

  private constructor(opts: AgentOptions) {
    this.socket = new HocuspocusProviderWebsocket({
      url: opts.url ?? process.env.LIVEPAGE_URL ?? 'ws://localhost:1234/collab',
      WebSocketPolyfill: WebSocket,
    });
    this.provider = new HocuspocusProvider({
      websocketProvider: this.socket,
      name: opts.page,
      document: this.doc,
      token: opts.token ?? process.env.AGENT_TOKEN ?? 'dev-agent-token',
    });
    this.provider.attach();
    this.provider.setAwarenessField('user', { ...(opts.id ? { id: opts.id } : {}), name: opts.name ?? 'Agent', color: opts.color ?? '#6e56cf', kind: 'agent' });
  }

  static async connect(opts: AgentOptions): Promise<LiveAgent> {
    const agent = new LiveAgent(opts);
    try {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timed out connecting to the collab server')), 15_000);
        agent.provider.on('synced', () => { clearTimeout(t); resolve(); });
        agent.provider.on('authenticationFailed', () => { clearTimeout(t); reject(new Error(`no access to page ${opts.page} with this token`)); });
      });
    } catch (e) {
      agent.provider.destroy();
      agent.socket.destroy();
      throw e;
    }
    return agent;
  }

  /** Tab the agent writes to. Accepts a tab id or title; null = the main tab. */
  private tab = 'main';
  useTab(idOrTitle: string | null | undefined) {
    this.tab = resolveTab(this.doc, idOrTitle);
    this.provider.setAwarenessField('tab', this.tab); // shows our dot on that tab
    return this;
  }
  tabs() { return listTabs(this.doc); }
  addTab(title: string) { return addTab(this.doc, title); }

  read(): string { return pageAsMarkdown(this.doc); }
  blocks() { return listBlocks(this.doc); }

  /** Show our caret at an offset inside a text node. */
  private setCaret(text: Y.XmlText, index: number) {
    const pos = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, index));
    this.provider.setAwarenessField('cursor', { anchor: pos, head: pos });
  }

  /** Append a paragraph and type it out so people see the agent writing. cps = characters per second. */
  /** [[p_id]], [[p_id#tab_id]] and [[p_id|label]] become links to that page or tab. */
  async typeParagraph(content: string, cps = 40) {
    let { el, text } = makeParagraph();
    this.doc.transact(() => { const f = fragment(this.doc, this.tab); f.insert(f.length, [el]); });
    for (const part of splitLinks(content)) {
      if (typeof part !== 'string') {
        // A link is one inline element; typing continues in a new text run after it.
        const next = new Y.XmlText();
        this.doc.transact(() => el.insert(el.length, [makeLink(part), next]));
        text = next;
        await sleep(150);
        continue;
      }
      for (let i = 0; i < part.length; i++) {
        text.insert(text.length, part[i]);
        this.setCaret(text, text.length);
        await sleep(1000 / cps);
      }
    }
  }

  addHeading(content: string, level = 2) { appendHeading(this.doc, content, level, this.tab); }

  // ---- Targeted edits: change only the blocks or words that need changing (see schema/blocks.ts) ----

  /** A tab id for an id or title, or undefined when none was given (unlike useTab, which falls back to the main tab). */
  tabId(idOrTitle?: string | null) { return idOrTitle ? resolveTab(this.doc, idOrTitle) : undefined; }

  /** Headings per tab with block ids and section sizes: the cheap way to find where to edit. */
  outline(tab?: string | null) { return outlineAsText(pageOutline(this.doc, this.tabId(tab))); }

  /** Blocks with their ids as text: the whole page, a tab, one section (a heading's id) or a window from a block. */
  readBlocks(opts: ReadBlocksOptions = {}) { return blocksAsText(this.doc, readBlocks(this.doc, opts)); }

  /** Put our caret at the end of a block (and our dot on its tab), so people see where we are working. */
  private caretAtBlock(id: string | undefined) {
    const b = id ? findBlock(this.doc, id) : null;
    if (!b) return;
    this.provider.setAwarenessField('tab', b.tab);
    const last = (n: Y.XmlElement | Y.XmlText): Y.XmlText | null => {
      if (n instanceof Y.XmlText) return n;
      const kids = n.toArray();
      for (let i = kids.length - 1; i >= 0; i--) {
        const k = kids[i];
        const hit = k instanceof Y.XmlText || k instanceof Y.XmlElement ? last(k) : null;
        if (hit) return hit;
      }
      return null;
    };
    const t = last(b.node);
    if (t) this.setCaret(t, t.length);
  }

  /** Insert Markdown as new blocks before/after a block, or at the start/end of the current tab. Returns the new ids. */
  insertBlocks(markdown: string, where: Where = {}): string[] {
    const r = insertBlocks(this.doc, markdown, { ...where, tab: where.tab ?? this.tab });
    this.caretAtBlock(r.ids[r.ids.length - 1]);
    return r.ids;
  }

  /** Replace a block (or the run through `through`) with Markdown. Returns the new ids. */
  replaceBlocks(id: string, markdown: string, through?: string | null): string[] {
    const r = replaceBlocks(this.doc, id, markdown, through);
    this.caretAtBlock(r.ids[r.ids.length - 1]);
    return r.ids;
  }

  deleteBlocks(id: string, through?: string | null): number {
    const first = findBlock(this.doc, id);
    const n = deleteBlocks(this.doc, id, through);
    // Leave the caret just above where the deleted blocks were.
    if (first) {
      const nodes = fragment(this.doc, first.tab).toArray() as (Y.XmlElement | Y.XmlText)[];
      const near = nodes[Math.min(Math.max(0, first.index - 1), nodes.length - 1)];
      if (near) this.caretAtBlock(blockIdOf(near));
    }
    return n;
  }

  moveBlocks(id: string, where: Where, through?: string | null): string[] {
    const r = moveBlocks(this.doc, id, where, through);
    this.caretAtBlock(r.ids[r.ids.length - 1]);
    return r.ids;
  }

  /**
   * Find and replace inside text, in place. One replacement is typed out so people watch the edit happen;
   * several are applied together. Returns how many were replaced and in which blocks.
   */
  async replaceText(find: string, replace: string, opts: ReplaceOptions = {}): Promise<{ replaced: number; blocks: string[] }> {
    const hits = hitsToReplace(this.doc, find, opts);
    const typed = hits.length === 1 && replace.length <= 2000;
    // Last match first, so earlier offsets in the same text stay valid.
    for (const h of [...hits].reverse()) {
      const marks = marksAt(h.text, h.offset);
      this.provider.setAwarenessField('tab', h.tab);
      if (!typed) {
        this.doc.transact(() => { h.text.delete(h.offset, h.length); if (replace) h.text.insert(h.offset, replace, marks); });
        this.setCaret(h.text, h.offset + replace.length);
        continue;
      }
      h.text.delete(h.offset, h.length);
      this.setCaret(h.text, h.offset);
      // Anchor to the character before the edit, so typing lands in the right place if someone edits earlier text meanwhile.
      const anchor = Y.createRelativePositionFromTypeIndex(h.text, h.offset, -1);
      const chunk = Math.max(2, Math.ceil(replace.length / 40));
      for (let i = 0; i < replace.length; i += chunk) {
        const at = (Y.createAbsolutePositionFromRelativePosition(anchor, this.doc)?.index ?? h.offset) + i;
        h.text.insert(at, replace.slice(i, i + chunk), marks);
        this.setCaret(h.text, at + Math.min(chunk, replace.length - i));
        await sleep(20);
      }
    }
    return { replaced: hits.length, blocks: [...new Set(hits.map((h) => h.blockId))] };
  }

  setTableCell(tableId: string, row: number, column: number, text: string) { setTableCell(this.doc, tableId, row, column, text); this.caretAtBlock(tableId); }
  addTableRow(tableId: string, cells: string[], row?: number | null) { const at = insertTableRow(this.doc, tableId, cells, row); this.caretAtBlock(tableId); return at; }
  removeTableRow(tableId: string, row: number) { deleteTableRow(this.doc, tableId, row); this.caretAtBlock(tableId); }

  /** Insert an HTML block. With `typeCode`, the code streams in like the agent is writing it. */
  async insertHtml(code: string, opts: { title?: string; typeCode?: boolean; cps?: number } = {}): Promise<string> {
    if (!opts.typeCode) return insertHtmlBlock(this.doc, code, { ...opts, tab: this.tab });
    const id = insertHtmlBlock(this.doc, '', { ...opts, tab: this.tab });
    const t = htmlCodeText(this.doc, id);
    const chunk = 6;
    for (let i = 0; i < code.length; i += chunk) {
      t.insert(i, code.slice(i, i + chunk));
      await sleep((1000 / (opts.cps ?? 240)) * chunk);
    }
    return id;
  }

  updateHtml(blockId: string, code: string) { setHtmlCode(this.doc, blockId, code); }

  /**
   * Stream a custom UI block in the order people should see it (OpenIntelligentUI pattern):
   * reserved height and placeholder messages first, then CSS, then HTML (previewed live,
   * scripts stripped), then JS. The block switches to "ready" and runs its scripts at the end.
   */
  async streamUI(parts: HtmlParts & { title?: string }, opts: { cps?: number; chunk?: number } = {}): Promise<string> {
    const id = insertHtmlBlock(this.doc, '', {
      title: parts.title,
      tab: this.tab,
      status: 'streaming',
      initialHeight: parts.initialHeight ?? 200,
      placeholders: parts.placeholders ?? ['Designing…'],
    });
    const t = htmlCodeText(this.doc, id);
    const chunk = opts.chunk ?? 8;
    try {
      for (const section of htmlSections(parts)) {
        for (let i = 0; i < section.length; i += chunk) {
          t.insert(t.length, section.slice(i, i + chunk));
          await sleep((1000 / (opts.cps ?? 400)) * chunk);
        }
      }
    } finally {
      setHtmlBlockStatus(this.doc, id, 'ready');
    }
    return id;
  }

  /** Native table. Prefer this over custom UI for plain tabular data. */
  addTable(rows: string[][], header = true) { insertTable(this.doc, rows, { header, tab: this.tab }); }

  /** Native mind map. Returns the block id. */
  addMindMap(tree: MindTree, title?: string) { return insertMindMap(this.doc, tree, { title, tab: this.tab }); }
  addMindNode(blockId: string, parentNodeId: string, text: string) { return addMindNode(this.doc, blockId, parentNodeId, text); }
  editMindNode(blockId: string, nodeId: string, text: string) { setMindNodeText(this.doc, blockId, nodeId, text); }
  removeMindNode(blockId: string, nodeId: string) { removeMindNode(this.doc, blockId, nodeId); }

  // ---- Footnotes (how agents cite sources) ----

  /** Add a footnote after `afterText` (or at the end of the last paragraph). Returns its id and number. */
  addFootnote(input: FootnoteInput & { afterText?: string; last?: boolean }) { return insertFootnote(this.doc, { ...input, tab: this.tab }); }
  editFootnote(id: string, patch: FootnoteInput) { updateFootnote(this.doc, id, patch); }
  removeFootnote(id: string) { removeFootnote(this.doc, id); }
  footnotes() { return listFootnotes(this.doc, this.tab); }

  // ---- Host bridge: actions people send from block controls ----

  /** Pending actions, marked "claimed" so another agent instance won't take them too. */
  claimActions(): BlockAction[] {
    const list = pendingActions(this.doc);
    this.doc.transact(() => list.forEach((a) => updateAction(this.doc, a.id, { status: 'claimed' })));
    return list;
  }

  resolveAction(id: string, note?: string) { updateAction(this.doc, id, { status: 'done', note }); }

  /** Call `handler` for every new pending action. Returns an unsubscribe function. */
  onAction(handler: (a: BlockAction) => void | Promise<void>): () => void {
    const map = actionsMap(this.doc);
    const run = () => { for (const a of this.claimActions()) void handler(a); };
    map.observe(run);
    run();
    return () => map.unobserve(run);
  }

  /** Resolve when a pending action arrives, or with [] after timeoutMs. */
  waitForActions(timeoutMs: number): Promise<BlockAction[]> {
    const now = this.claimActions();
    if (now.length) return Promise.resolve(now);
    return new Promise((resolve) => {
      const map = actionsMap(this.doc);
      const done = (v: BlockAction[]) => { clearTimeout(t); map.unobserve(check); resolve(v); };
      const check = () => { const got = this.claimActions(); if (got.length) done(got); };
      const t = setTimeout(() => done([]), timeoutMs);
      map.observe(check);
    });
  }

  async disconnect() {
    this.provider.setAwarenessField('cursor', null);
    await sleep(200); // let the last updates flush
    this.provider.destroy();
    this.socket.destroy();
  }
}
