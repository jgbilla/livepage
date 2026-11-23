// A live agent participant. It joins a page over the same WebSocket protocol as a browser,
// so it has presence (a named caret) and its edits stream in as it types.
// Any model can drive it: the MCP server (mcp.ts) and the demo (demo.ts) both use it.
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import WebSocket from 'ws';
import * as Y from 'yjs';
import {
  appendHeading, fragment, htmlCodeText, insertHtmlBlock, listBlocks, makeParagraph, pageAsMarkdown, setHtmlCode,
} from '@livepage/schema';

export type AgentOptions = { url?: string; page: string; name?: string; color?: string; token?: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class LiveAgent {
  readonly doc = new Y.Doc();
  readonly provider: HocuspocusProvider;
  private socket: HocuspocusProviderWebsocket;

  private constructor(opts: AgentOptions) {
    this.socket = new HocuspocusProviderWebsocket({
      url: opts.url ?? process.env.LIVEPAGE_URL ?? 'ws://localhost:1234',
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
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out connecting to the collab server')), 10_000);
      agent.provider.on('synced', () => { clearTimeout(t); resolve(); });
    });
    return agent;
  }

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
    this.doc.transact(() => { const f = fragment(this.doc); f.insert(f.length, [el]); });
    for (let i = 0; i < content.length; i++) {
      text.insert(i, content[i]);
      this.setCaret(text, i + 1);
      await sleep(1000 / cps);
    }
  }

  addHeading(content: string, level = 2) { appendHeading(this.doc, content, level); }

  /** Insert an HTML block. With `typeCode`, the code streams in like the agent is writing it. */
  async insertHtml(code: string, opts: { title?: string; typeCode?: boolean; cps?: number } = {}): Promise<string> {
    if (!opts.typeCode) return insertHtmlBlock(this.doc, code, opts);
    const id = insertHtmlBlock(this.doc, '', opts);
    const t = htmlCodeText(this.doc, id);
    const chunk = 6;
    for (let i = 0; i < code.length; i += chunk) {
      t.insert(i, code.slice(i, i + chunk));
      await sleep((1000 / (opts.cps ?? 240)) * chunk);
    }
    return id;
  }

  updateHtml(blockId: string, code: string) { setHtmlCode(this.doc, blockId, code); }

  async disconnect() {
    this.provider.setAwarenessField('cursor', null);
    await sleep(200); // let the last updates flush
    this.provider.destroy();
    this.socket.destroy();
  }
}
