// The assistant's page tools. Same abilities as external agents (packages/agent: MCP and HTTP),
// plus two that only make sense inside the app: placing new content after a given passage,
// and rewriting existing text in place. Writes stream into the live doc while the model is
// still generating, with the assistant's own caret, so people watch it write.
import * as Y from 'yjs';
import type { LiveAgent } from '@livepage/agent/client';
import {
  addMindNode, addTab, fragment, htmlCodeText, htmlSections, insertHtmlBlock, insertMindMap, insertTable, makeParagraph,
  pageAsMarkdown, setHtmlBlockStatus, setHtmlCode, type MindTree,
} from '@livepage/schema';
import type { ToolDef } from './providers.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_READ = 120_000;

const afterText = {
  type: 'string',
  description: 'Optional. Put the new block right after the paragraph/heading containing this exact text. Omit to add at the end of the page.',
};

export const TOOLS: ToolDef[] = [
  {
    name: 'read_page',
    description: 'Read the current page (or all tabs) as markdown. Mind maps show node ids; HTML blocks show their id and code. Call again after others may have edited.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'write_paragraph',
    description: 'Write a paragraph of plain text. It appears live as you write it.',
    parameters: { type: 'object', properties: { after_text: afterText, text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  },
  {
    name: 'add_heading',
    description: 'Add a heading.',
    parameters: {
      type: 'object',
      properties: { after_text: afterText, text: { type: 'string' }, level: { type: 'integer', enum: [1, 2, 3] } },
      required: ['text'], additionalProperties: false,
    },
  },
  {
    name: 'replace_text',
    description: 'Rewrite existing text in place: replaces the first occurrence of `find` (must be within one paragraph, heading, list item or table cell) with `replace`. Use an empty `replace` to delete. Use this to edit, fix or rewrite what is already on the page.',
    parameters: {
      type: 'object',
      properties: { find: { type: 'string', description: 'Exact text currently on the page.' }, replace: { type: 'string' } },
      required: ['find', 'replace'], additionalProperties: false,
    },
  },
  {
    name: 'insert_table',
    description: 'Add a native, editable table. First row is the header. Prefer this over HTML for tabular data.',
    parameters: {
      type: 'object',
      properties: { after_text: afterText, rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, minItems: 1 } },
      required: ['rows'], additionalProperties: false,
    },
  },
  {
    name: 'insert_mind_map',
    description: 'Add a native, editable mind map from a tree of { text, children }.',
    parameters: {
      type: 'object',
      properties: {
        after_text: afterText,
        title: { type: 'string' },
        root: { $ref: '#/$defs/node' },
      },
      required: ['root'], additionalProperties: false,
      $defs: {
        node: {
          type: 'object',
          properties: { text: { type: 'string' }, children: { type: 'array', items: { $ref: '#/$defs/node' } } },
          required: ['text'],
        },
      },
    },
  },
  {
    name: 'add_mind_map_node',
    description: 'Add a node under an existing mind map node (block and node ids come from read_page).',
    parameters: {
      type: 'object',
      properties: { block_id: { type: 'string' }, parent_node_id: { type: 'string' }, text: { type: 'string' } },
      required: ['block_id', 'parent_node_id', 'text'], additionalProperties: false,
    },
  },
  {
    name: 'insert_custom_ui',
    description: 'Add a custom interactive block (animation, chart, diagram, widget, game). Runs in a sandboxed iframe: CDN scripts allowed, no network requests. Give css, then html, then js, in that order; people see it take shape as you write. Only use when native blocks cannot do it. Style it with the Livepage design tokens so it matches the page in light and dark: var(--lp-text), var(--lp-text-secondary), var(--lp-surface), var(--lp-border), var(--lp-accent), var(--lp-radius-lg), var(--lp-space-4), var(--lp-font-sans), var(--lp-shadow-2), and var(--lp-cat-1) to var(--lp-cat-8) for chart series; the block background is transparent over the page.',
    parameters: {
      type: 'object',
      properties: {
        after_text: afterText,
        title: { type: 'string' },
        initial_height: { type: 'integer', minimum: 40, maximum: 2000, description: 'Height in px to reserve while it streams.' },
        css: { type: 'string' },
        html: { type: 'string' },
        js: { type: 'string' },
      },
      required: ['html'], additionalProperties: false,
    },
  },
  {
    name: 'update_html_block',
    description: 'Replace the full code of an existing HTML / custom UI block (ids come from read_page).',
    parameters: { type: 'object', properties: { block_id: { type: 'string' }, code: { type: 'string' } }, required: ['block_id', 'code'], additionalProperties: false },
  },
  {
    name: 'add_tab',
    description: 'Add a tab to the page (each tab is its own scrolling document). New writes still go to the current tab.',
    parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false },
  },
];

// ---------------------------------------------------------------------------
// Finding text in the doc

type Hit = { top: number; text: Y.XmlText; offset: number };

function textsIn(node: Y.XmlElement | Y.XmlText | Y.XmlHook): Y.XmlText[] {
  if (node instanceof Y.XmlText) return [node];
  if (node instanceof Y.XmlElement) return node.toArray().flatMap((c) => textsIn(c as Y.XmlElement));
  return [];
}

const plain = (t: Y.XmlText) => (t.toDelta() as { insert: unknown }[]).map((op) => (typeof op.insert === 'string' ? op.insert : ' ')).join('');

function findText(doc: Y.Doc, tab: string, quote: string): Hit | null {
  const q = quote.trim();
  if (!q) return null;
  const top = fragment(doc, tab).toArray();
  for (const loose of [false, true]) {
    for (let i = 0; i < top.length; i++) {
      for (const t of textsIn(top[i] as Y.XmlElement)) {
        const s = plain(t);
        const at = loose ? s.toLowerCase().indexOf(q.toLowerCase()) : s.indexOf(q);
        if (at >= 0) return { top: i, text: t, offset: at };
      }
    }
  }
  return null;
}

/** Where a new top-level block goes: after the block containing `after`, else at the end. */
function placement(doc: Y.Doc, tab: string, after: unknown): number {
  const f = fragment(doc, tab);
  if (typeof after === 'string' && after.trim()) {
    const hit = findText(doc, tab, after);
    if (hit) return hit.top + 1;
  }
  return f.length;
}

// ---------------------------------------------------------------------------
// Partial JSON: read a string value out of tool arguments that are still streaming.

export function partialString(json: string, key: string): { value: string; done: boolean } | null {
  const m = new RegExp(`"${key}"\\s*:\\s*"`).exec(json);
  if (!m) return null;
  let i = m.index + m[0].length;
  let out = '';
  while (i < json.length) {
    const c = json[i];
    if (c === '"') return { value: out, done: true };
    if (c === '\\') {
      const n = json[i + 1];
      if (n === undefined) break;
      if (n === 'u') {
        const hex = json.slice(i + 2, i + 6);
        if (hex.length < 4) break;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      out += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' } as Record<string, string>)[n] ?? n;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return { value: out, done: false };
}

// ---------------------------------------------------------------------------
// The executor: one per run, bound to a live agent connection and a tab.

type Live = { kind: 'paragraph'; text: Y.XmlText; written: number } | { kind: 'ui'; blockId: string; code: string; lastFlush: number };

export class PageTools {
  private live = new Map<string, Live>();
  /** Short notes for the chat panel ("Wrote a paragraph"), in order. */
  readonly changes: string[] = [];

  constructor(private agent: LiveAgent, private tab: string) {}

  private get doc() { return this.agent.doc; }

  private caret(text: Y.XmlText, index: number) {
    const pos = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, index));
    this.agent.provider.setAwarenessField('cursor', { anchor: pos, head: pos });
  }

  private insertTop(index: number, el: Y.XmlElement) {
    this.doc.transact(() => { const f = fragment(this.doc, this.tab); f.insert(Math.min(index, f.length), [el]); });
  }

  /** Called as tool arguments stream in, so the page fills while the model writes. */
  onArgs(id: string, name: string, json: string) {
    if (name === 'write_paragraph') {
      const t = partialString(json, 'text');
      if (!t || !t.value) return;
      let s = this.live.get(id) as Extract<Live, { kind: 'paragraph' }> | undefined;
      if (!s) {
        const after = partialString(json, 'after_text');
        const { el, text } = makeParagraph();
        this.insertTop(placement(this.doc, this.tab, after?.done ? after.value : undefined), el);
        s = { kind: 'paragraph', text, written: 0 };
        this.live.set(id, s);
      }
      const add = t.value.slice(s.written);
      if (add) {
        s.text.insert(s.text.length, add);
        s.written = t.value.length;
        this.caret(s.text, s.text.length);
      }
    } else if (name === 'insert_custom_ui') {
      const html = partialString(json, 'html');
      let s = this.live.get(id) as Extract<Live, { kind: 'ui' }> | undefined;
      if (!s) {
        const title = partialString(json, 'title');
        const after = partialString(json, 'after_text');
        const h = /"initial_height"\s*:\s*(\d+)/.exec(json);
        const blockId = insertHtmlBlock(this.doc, '', {
          title: title?.done ? title.value : undefined,
          tab: this.tab,
          index: placement(this.doc, this.tab, after?.done ? after.value : undefined),
          status: 'streaming',
          initialHeight: h ? Math.min(2000, Math.max(40, Number(h[1]))) : 240,
          placeholders: ['Designing…', 'Styling…', 'Building the layout…'],
        });
        s = { kind: 'ui', blockId, code: '', lastFlush: 0 };
        this.live.set(id, s);
      }
      // Stream css then html (scripts run only once the block is complete). Throttled.
      if (Date.now() - s.lastFlush < 150) return;
      s.lastFlush = Date.now();
      const css = partialString(json, 'css')?.value ?? '';
      const code = htmlSections({ css, html: html?.value ?? '' }).join('');
      this.flushCode(s, code);
    }
  }

  private flushCode(s: Extract<Live, { kind: 'ui' }>, code: string) {
    if (code === s.code) return;
    if (code.startsWith(s.code)) htmlCodeText(this.doc, s.blockId).insert(s.code.length, code.slice(s.code.length));
    else setHtmlCode(this.doc, s.blockId, code);
    s.code = code;
  }

  /** Run a finished tool call. Returns the text the model sees as the result. */
  async run(id: string, name: string, a: Record<string, unknown>): Promise<string> {
    if (a.__invalid_json) throw new Error('Your tool arguments were not valid JSON. Send the call again.');
    const str = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '');
    switch (name) {
      case 'read_page': {
        const md = pageAsMarkdown(this.doc);
        return md.length > MAX_READ ? `${md.slice(0, MAX_READ)}\n\n(…page truncated)` : md || '(empty page)';
      }
      case 'write_paragraph': {
        const want = str('text');
        const s = this.live.get(id) as Extract<Live, { kind: 'paragraph' }> | undefined;
        if (s) {
          // Streamed already: make sure the final text is exact.
          const have = s.text.toString();
          if (have !== want && want.startsWith(have)) s.text.insert(s.text.length, want.slice(have.length));
          this.caret(s.text, s.text.length);
        } else {
          const { el, text } = makeParagraph();
          this.insertTop(placement(this.doc, this.tab, a.after_text), el);
          await this.typeInto(text, 0, want);
        }
        this.changes.push('Wrote a paragraph');
        return 'ok';
      }
      case 'add_heading': {
        const el = new Y.XmlElement('heading');
        const level = [1, 2, 3].includes(Number(a.level)) ? Number(a.level) : 2;
        el.setAttribute('level', level as unknown as string);
        const t = new Y.XmlText();
        el.insert(0, [t]);
        this.insertTop(placement(this.doc, this.tab, a.after_text), el);
        await this.typeInto(t, 0, str('text'));
        this.changes.push(`Added heading “${str('text').slice(0, 60)}”`);
        return 'ok';
      }
      case 'replace_text': {
        const hit = findText(this.doc, this.tab, str('find'));
        if (!hit) throw new Error('That text is not on the page (in this tab). Call read_page and quote it exactly, within one block.');
        const len = str('find').trim().length;
        this.doc.transact(() => hit.text.delete(hit.offset, len));
        this.caret(hit.text, hit.offset);
        await this.typeInto(hit.text, hit.offset, str('replace'));
        this.changes.push(str('replace') ? 'Rewrote text' : 'Deleted text');
        return 'ok';
      }
      case 'insert_table': {
        const rows = Array.isArray(a.rows) ? (a.rows as unknown[]).map((r) => (Array.isArray(r) ? r.map(String) : [String(r)])) : [];
        if (!rows.length) throw new Error('rows must be a non-empty array of arrays of strings');
        insertTable(this.doc, rows, { tab: this.tab, index: placement(this.doc, this.tab, a.after_text) });
        this.changes.push(`Added a table (${rows.length} rows)`);
        return 'ok';
      }
      case 'insert_mind_map': {
        const root = a.root as MindTree | undefined;
        if (!root || typeof root.text !== 'string') throw new Error('root.text is required');
        const blockId = insertMindMap(this.doc, root, { title: str('title') || undefined, tab: this.tab, index: placement(this.doc, this.tab, a.after_text) });
        this.changes.push('Added a mind map');
        return `inserted ${blockId}`;
      }
      case 'add_mind_map_node': {
        const nodeId = addMindNode(this.doc, str('block_id'), str('parent_node_id'), str('text'));
        this.changes.push('Grew a mind map');
        return `added ${nodeId}`;
      }
      case 'insert_custom_ui': {
        let s = this.live.get(id) as Extract<Live, { kind: 'ui' }> | undefined;
        if (!s) {
          const blockId = insertHtmlBlock(this.doc, '', {
            title: str('title') || undefined, tab: this.tab, index: placement(this.doc, this.tab, a.after_text),
            status: 'streaming', initialHeight: Number(a.initial_height) || 240, placeholders: ['Designing…'],
          });
          s = { kind: 'ui', blockId, code: '', lastFlush: 0 };
        } else if (str('title')) {
          this.doc.transact(() => {
            for (const n of fragment(this.doc, this.tab).toArray()) {
              if (n instanceof Y.XmlElement && n.getAttribute('blockId') === s!.blockId) n.setAttribute('title', str('title'));
            }
          });
        }
        // css + html are (mostly) on the page already; now the full code including the script.
        this.flushCode(s, htmlSections({ css: str('css'), html: str('html') }).join(''));
        await sleep(100);
        this.flushCode(s, htmlSections({ css: str('css'), html: str('html'), js: str('js') }).join(''));
        setHtmlBlockStatus(this.doc, s.blockId, 'ready');
        this.changes.push(`Built “${str('title') || 'custom block'}”`);
        return `inserted ${s.blockId}`;
      }
      case 'update_html_block': {
        setHtmlCode(this.doc, str('block_id'), str('code'));
        this.changes.push('Updated a custom block');
        return 'ok';
      }
      case 'add_tab': {
        const tabId = addTab(this.doc, str('title'));
        this.changes.push(`Added tab “${str('title')}”`);
        return `added tab ${tabId}`;
      }
      default:
        throw new Error(`Unknown tool ${name}`);
    }
  }

  /** Type text in quickly, in small chunks, so it reads as live writing without slowing the run. */
  private async typeInto(text: Y.XmlText, at: number, content: string) {
    const chunk = Math.max(3, Math.ceil(content.length / 60));
    for (let i = 0; i < content.length; i += chunk) {
      text.insert(at + i, content.slice(i, i + chunk));
      this.caret(text, at + Math.min(i + chunk, content.length));
      await sleep(16);
    }
  }

  /** If the run stopped mid-stream (error or stop), finish any half-built custom UI so it doesn't spin forever. */
  settle() {
    for (const s of this.live.values()) if (s.kind === 'ui') setHtmlBlockStatus(this.doc, s.blockId, 'ready');
    this.agent.provider.setAwarenessField('cursor', null);
  }
}
