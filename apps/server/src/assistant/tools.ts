// The assistant's page tools. Same abilities as external agents (packages/agent: MCP and HTTP),
// including the targeted edits (block ids, replace/insert/delete/move blocks, table cells; see schema/blocks.ts),
// plus one that only makes sense inside the app: placing new content after a given passage. Writes stream into the live doc while the model is
// still generating, with the assistant's own caret, so people watch it write.
import * as Y from 'yjs';
import type { LiveAgent } from '@livepage/agent/client';
import {
  addMindNode, addTab, fragment, htmlCodeText, htmlSections, insertHtmlBlock, insertMindMap, insertTable, makeParagraph,
  setHtmlBlockStatus, setHtmlCode, hitsToReplace, type MindTree,
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
    description: 'Read the whole page (all tabs): each block is a line "[block_id type]" followed by its Markdown. Mind maps show node ids; HTML blocks show their code. Call again after others may have edited; read_blocks reads just one section.',
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
    name: 'read_blocks',
    description: 'Read blocks with their ids: each block is a line "[block_id type]" followed by its Markdown. Pass section (a heading\'s block id) to read only that heading and what is under it, or from to start at a block. Use it for a fresh look at one part of the page before editing it.',
    parameters: {
      type: 'object',
      properties: {
        section: { type: 'string', description: 'A heading\'s block id: read that section only.' },
        from: { type: 'string', description: 'Start reading at this block id.' },
        limit: { type: 'integer', minimum: 1, maximum: 1000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'replace_text',
    description: 'Change words in place: replaces `find` (exact text now on the page, plain text without Markdown markers, within one paragraph, heading, list item or table cell) with `replace`, keeping the formatting, links and footnotes around it. The cheapest way to fix or reword something. If the text appears more than once, quote more words or pass block_id, occurrence or all. Use an empty `replace` to delete.',
    parameters: {
      type: 'object',
      properties: {
        find: { type: 'string', description: 'Exact text currently on the page.' },
        replace: { type: 'string', description: 'Words that stay the same keep their formatting and comments; inline Markdown (**bold**, `code`, [link](url)) sets formatting.' },
        block_id: { type: 'string', description: 'Only look inside this block.' },
        occurrence: { type: 'integer', minimum: 1, description: 'Which match to replace (1 = first) when there are several.' },
        all: { type: 'boolean', description: 'Replace every match.' },
      },
      required: ['find', 'replace'], additionalProperties: false,
    },
  },
  {
    name: 'replace_blocks',
    description: 'Rewrite one block, or a run of blocks (block_id through through_block_id, for example a whole section), with new Markdown: headings, **bold**, lists, tables, code fences, links. Everything else on the page is untouched. For a change of a few words use replace_text. Returns the new block ids.',
    parameters: {
      type: 'object',
      properties: { block_id: { type: 'string' }, through_block_id: { type: 'string', description: 'Last block of the run to replace (same tab).' }, markdown: { type: 'string' } },
      required: ['block_id', 'markdown'], additionalProperties: false,
    },
  },
  {
    name: 'insert_blocks',
    description: 'Insert new content, written as Markdown, right before or after a block (give one of before / after), or at the start or end of the current tab. Returns the new block ids.',
    parameters: {
      type: 'object',
      properties: {
        markdown: { type: 'string' },
        before: { type: 'string', description: 'Block id to insert before.' },
        after: { type: 'string', description: 'Block id to insert after.' },
        at: { type: 'string', enum: ['start', 'end'], description: 'Without before/after: start or end (default) of the current tab.' },
      },
      required: ['markdown'], additionalProperties: false,
    },
  },
  {
    name: 'delete_blocks',
    description: 'Delete one block, or a run of blocks (block_id through through_block_id). The person can bring it back from History.',
    parameters: {
      type: 'object',
      properties: { block_id: { type: 'string' }, through_block_id: { type: 'string' } },
      required: ['block_id'], additionalProperties: false,
    },
  },
  {
    name: 'move_blocks',
    description: 'Move one block, or a run of blocks such as a section, right before or after another block. Moved blocks get new ids, which are returned.',
    parameters: {
      type: 'object',
      properties: {
        block_id: { type: 'string' }, through_block_id: { type: 'string' },
        before: { type: 'string', description: 'Block id to move it before.' },
        after: { type: 'string', description: 'Block id to move it after.' },
      },
      required: ['block_id'], additionalProperties: false,
    },
  },
  {
    name: 'edit_table',
    description: 'Change a table that is already on the page without resending it. op "set_cell" needs row, column and text; "add_row" needs cells (and row to place it, otherwise it goes last); "delete_row" needs row. Rows and columns count from 1; row 1 is the header.',
    parameters: {
      type: 'object',
      properties: {
        block_id: { type: 'string', description: 'The table\'s block id.' },
        op: { type: 'string', enum: ['set_cell', 'add_row', 'delete_row'] },
        row: { type: 'integer', minimum: 1 },
        column: { type: 'integer', minimum: 1 },
        text: { type: 'string' },
        cells: { type: 'array', items: { type: 'string' } },
      },
      required: ['block_id', 'op'], additionalProperties: false,
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
    const opt = (k: string) => str(k) || undefined;
    switch (name) {
      case 'read_page': {
        const md = this.agent.readBlocks();
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
      case 'read_blocks':
        return this.agent.readBlocks({ tab: opt('section') || opt('from') ? undefined : this.tab, section: opt('section'), from: opt('from'), limit: Number(a.limit) || undefined }) || '(no blocks)';
      case 'replace_text': {
        const scope = { blockId: opt('block_id'), tab: opt('block_id') ? undefined : this.tab, occurrence: Number(a.occurrence) || undefined, all: a.all === true };
        // Models often get the case or the surrounding spaces slightly wrong: fall back to a looser match.
        let find = str('find');
        let matchCase = true;
        try { hitsToReplace(this.doc, find, scope); } catch (e) {
          if (!/is not on the page/.test((e as Error).message)) throw e;
          find = find.trim();
          matchCase = false;
        }
        const r = await this.agent.replaceText(find, str('replace'), { ...scope, matchCase });
        this.changes.push(r.replaced > 1 ? `Changed text in ${r.replaced} places` : str('replace') ? 'Rewrote text' : 'Deleted text');
        return `replaced ${r.replaced}`;
      }
      case 'replace_blocks': {
        const ids = this.agent.replaceBlocks(str('block_id'), str('markdown'), opt('through_block_id'));
        this.changes.push(opt('through_block_id') ? 'Rewrote a section' : 'Rewrote a block');
        return `replaced; new blocks: ${ids.join(', ')}`;
      }
      case 'insert_blocks': {
        const ids = this.agent.insertBlocks(str('markdown'), { before: opt('before'), after: opt('after'), at: a.at === 'start' ? 'start' : 'end', tab: this.tab });
        this.changes.push(`Added ${ids.length === 1 ? 'a block' : `${ids.length} blocks`}`);
        return `inserted ${ids.join(', ')}`;
      }
      case 'delete_blocks': {
        const n = this.agent.deleteBlocks(str('block_id'), opt('through_block_id'));
        this.changes.push(`Deleted ${n === 1 ? 'a block' : `${n} blocks`}`);
        return `deleted ${n}`;
      }
      case 'move_blocks': {
        if (!opt('before') && !opt('after')) throw new Error('Give before or after: the block id to move next to.');
        const ids = this.agent.moveBlocks(str('block_id'), { before: opt('before'), after: opt('after') }, opt('through_block_id'));
        this.changes.push(`Moved ${ids.length === 1 ? 'a block' : `${ids.length} blocks`}`);
        return `moved; new blocks: ${ids.join(', ')}`;
      }
      case 'edit_table': {
        const id = str('block_id');
        if (a.op === 'set_cell') this.agent.setTableCell(id, Number(a.row), Number(a.column), str('text'));
        else if (a.op === 'add_row') this.agent.addTableRow(id, Array.isArray(a.cells) ? a.cells.map(String) : [], Number(a.row) || null);
        else if (a.op === 'delete_row') this.agent.removeTableRow(id, Number(a.row));
        else throw new Error('op must be set_cell, add_row or delete_row');
        this.changes.push('Edited a table');
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
