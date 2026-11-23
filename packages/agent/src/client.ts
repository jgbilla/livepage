// A live agent participant. It joins a page over the same WebSocket protocol as a browser,
// so it has presence (a named caret) and its edits stream in as it types.
// Any model can drive it: the MCP server (mcp.ts) and the demo (demo.ts) both use it.
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import WebSocket from 'ws';
import * as Y from 'yjs';
import {
  actionsMap, addMindNode, appendHeading, fragment, htmlCodeText, htmlSections, insertHtmlBlock, insertMindMap, insertTable,
  addTab, listBlocks, listTabs, makeParagraph, resolveTab, pageAsMarkdown, pendingActions, removeMindNode, setHtmlBlockStatus, setHtmlCode,
  setMindNodeText, updateAction, type BlockAction, type HtmlParts, type MindTree,
} from '@livepage/schema';

export type AgentOptions = { url?: string; page: string; name?: string; color?: string; token?: string };

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
    this.provider.setAwarenessField('user', { name: opts.name ?? 'Agent', color: opts.color ?? '#7048e8', kind: 'agent' });
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
  async typeParagraph(content: string, cps = 40) {
    const { el, text } = makeParagraph();
    this.doc.transact(() => { const f = fragment(this.doc, this.tab); f.insert(f.length, [el]); });
    for (let i = 0; i < content.length; i++) {
      text.insert(i, content[i]);
      this.setCaret(text, i + 1);
      await sleep(1000 / cps);
    }
  }

  addHeading(content: string, level = 2) { appendHeading(this.doc, content, level, this.tab); }

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
