// Markdown in and out of a page, Obsidian-flavoured:
//   - frontmatter (title, tags, aliases)
//   - [[Page]] / [[Page#Heading|alias]] wiki links (Livepage links point at ids; export writes titles)
//   - #tags in text, [^1] footnotes, GFM tables, task lists, fenced code
//   - Livepage-only blocks round-trip through fenced code: ```livepage-html and ```livepage-mindmap
//   - extra tabs round-trip as sections that start with <!-- livepage-tab: Title -->
import * as Y from 'yjs';
import { Marked, type Token, type Tokens } from 'marked';
import {
  addTab, fragment, htmlCodeText, HTML_NODE, LINK_NODE, linkToken, listTabs, MAIN_TAB, makeLink, META, MIND_NODE,
  mindChildren, mindMapNodes, newId, addMindNode, type LinkTarget, type MindTree,
} from './index.ts';
import { citationLine, footnoteParts, inlineOf, isFootnote, makeFootnoteElement, plainText, type Run } from './walk.ts';

// ===========================================================================
// Export

export type ExportOptions = {
  /** How to write a link to another page or tab. Default: [[label]] or the raw [[p_id]] token. */
  link?: (t: LinkTarget) => string;
  /** Include frontmatter (title, tags). Default true. */
  frontmatter?: boolean;
  title?: string;
  tags?: string[];
  /** Extra frontmatter keys. */
  extra?: Record<string, string>;
};

const yamlString = (s: string) => (/^[\w][\w .,'()/-]*$/.test(s) && !/^(true|false|null|yes|no)$/i.test(s) ? s : JSON.stringify(s));

/** The whole page as a Markdown file. Extra tabs become <!-- livepage-tab --> sections, so import can rebuild them. */
export function pageToMarkdown(doc: Y.Doc, opts: ExportOptions = {}): string {
  const title = opts.title ?? String(doc.getMap(META).get('title') ?? '');
  const parts: string[] = [];
  if (opts.frontmatter !== false) {
    const fm = [`title: ${yamlString(title || 'Untitled')}`];
    if (opts.tags?.length) fm.push(`tags:\n${opts.tags.map((t) => `  - ${yamlString(t)}`).join('\n')}`);
    for (const [k, v] of Object.entries(opts.extra ?? {})) fm.push(`${k}: ${yamlString(v)}`);
    parts.push(`---\n${fm.join('\n')}\n---`);
  }
  const tabs = listTabs(doc);
  for (const t of tabs) {
    const body = tabToMarkdown(doc, t.id, opts);
    if (t.id === MAIN_TAB) { if (body) parts.push(body); continue; }
    parts.push(`<!-- livepage-tab: ${t.title.replace(/-->/g, '')} -->\n\n${body}`.trim());
  }
  return `${parts.join('\n\n').trim()}\n`;
}

/** One tab as Markdown, with its footnote definitions at the end. */
export function tabToMarkdown(doc: Y.Doc, tab: string = MAIN_TAB, opts: ExportOptions = {}): string {
  const ctx: Ctx = { doc, opts, notes: [] };
  const body = blocks(fragment(doc, tab).toArray() as Y.XmlElement[], ctx);
  const notes = ctx.notes.map((n, i) => `[^${i + 1}]: ${n}`).join('\n');
  return [body, notes].filter(Boolean).join('\n\n');
}

type Ctx = { doc: Y.Doc; opts: ExportOptions; notes: string[] };

/**
 * One block as Markdown, for agents that read and edit a page block by block. Footnotes in the block
 * are numbered from 1 and their definitions follow the block, so sending the same Markdown back keeps them.
 */
export function blockToMarkdown(doc: Y.Doc, node: Y.XmlElement | Y.XmlText, opts: ExportOptions = {}): string {
  const ctx: Ctx = { doc, opts, notes: [] };
  const body = block(node, ctx);
  const notes = ctx.notes.map((n, i) => `[^${i + 1}]: ${n}`).join('\n');
  return [body, notes].filter(Boolean).join('\n\n');
}

function blocks(nodes: (Y.XmlElement | Y.XmlText)[], ctx: Ctx): string {
  return nodes.map((n) => block(n, ctx)).filter((s) => s !== '').join('\n\n');
}

const indent = (s: string, pad: string) => s.split('\n').map((l, i) => (i === 0 || !l ? l : pad + l)).join('\n');

function block(node: Y.XmlElement | Y.XmlText, ctx: Ctx): string {
  if (node instanceof Y.XmlText) return escapeText(plainText(node));
  const el = node;
  const kids = () => el.toArray() as Y.XmlElement[];
  switch (el.nodeName) {
    case 'paragraph': return inline(el, ctx);
    case 'heading': return `${'#'.repeat(Math.min(6, Math.max(1, Number(el.getAttribute('level') ?? 1))))} ${inline(el, ctx)}`;
    case 'blockquote': return blocks(kids(), ctx).split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');
    case 'toggle': {
      // An Obsidian foldable callout: "> [!toggle] line", then the nested blocks as "> " lines.
      const [line, ...rest] = kids();
      const body = [`[!toggle] ${line ? block(line, ctx) : ''}`.trimEnd(), blocks(rest, ctx)].filter(Boolean).join('\n\n');
      return body.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');
    }
    case 'horizontalRule': return '---';
    case 'hardBreak': return '';
    case 'codeBlock': {
      const code = plainText(el);
      const fence = code.includes('```') ? '~~~~' : '```';
      return `${fence}${el.getAttribute('language') ?? ''}\n${code}\n${fence}`;
    }
    case 'bulletList':
    case 'orderedList':
    case 'taskList': {
      let n = Number(el.getAttribute('start') ?? 1) || 1;
      return kids().map((item) => {
        const marker = el.nodeName === 'orderedList' ? `${n++}.` : '-';
        const checked = item.nodeName === 'taskItem' ? (item.getAttribute('checked') ? '[x] ' : '[ ] ') : '';
        // A tight list: a nested list follows its item's text on the next line.
        const parts = (item.toArray() as Y.XmlElement[]).map((c) => ({ c, s: block(c, ctx) })).filter((x) => x.s !== '');
        const body = parts.map((x, i) => (i === 0 ? x.s : `${/List$/.test(x.c.nodeName) ? '\n' : '\n\n'}${x.s}`)).join('');
        return `${marker} ${checked}${indent(body, ' '.repeat(marker.length + 1))}`;
      }).join('\n');
    }
    case 'table': {
      const rows = kids().map((row) => (row.toArray() as Y.XmlElement[]).map((cell) =>
        (cell.toArray() as Y.XmlElement[]).map((p) => (p.nodeName === 'paragraph' || p.nodeName === 'heading' ? inline(p, ctx) : plainText(p)))
          .filter(Boolean).join('<br>').replace(/\|/g, '\\|').replace(/\n/g, ' ')));
      if (!rows.length) return '';
      const width = Math.max(...rows.map((r) => r.length));
      const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')];
      const line = (r: string[]) => `| ${pad(r).join(' | ')} |`;
      return [line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n');
    }
    case HTML_NODE: {
      const id = String(el.getAttribute('blockId') ?? '');
      const code = ctx.doc.getMap<Y.Text>('htmlCode').get(id)?.toString() ?? '';
      const title = String(el.getAttribute('title') ?? '');
      const fence = code.includes('```') ? '~~~~' : '```';
      return `${fence}livepage-html${title ? ` ${JSON.stringify(title)}` : ''}\n${code.replace(/\n$/, '')}\n${fence}`;
    }
    case MIND_NODE: {
      const id = String(el.getAttribute('blockId') ?? '');
      const nodes = [...mindMapNodes(ctx.doc, id).values()];
      const lines: string[] = [];
      const walk = (parent: string | null, depth: number) => {
        for (const n of mindChildren(nodes, parent)) { lines.push(`${'  '.repeat(depth)}- ${n.text}`); walk(n.id, depth + 1); }
      };
      walk(null, 0);
      const title = String(el.getAttribute('title') ?? '');
      return `\`\`\`livepage-mindmap${title ? ` ${JSON.stringify(title)}` : ''}\n${lines.join('\n')}\n\`\`\``;
    }
    default: {
      // Unknown block (from a newer version or an extension): keep its text.
      const inner = kids();
      if (inner.length && inner.every((c) => c instanceof Y.XmlElement)) return blocks(inner, ctx);
      return inline(el, ctx);
    }
  }
}

/** Markdown special characters in plain text. Kept minimal so exported files stay readable. */
function escapeText(s: string): string {
  return s.replace(/([\\`*_[\]<])/g, '\\$1').replace(/^(\s*)([#>+-]|\d+\.)(?=\s)/, '$1\\$2');
}

const MARK_ORDER = ['link', 'bold', 'italic', 'strike', 'underline', 'code'] as const;

function wrapRun(r: Run): string {
  if (!r.text) return '';
  const m = r.marks;
  if (m.code) {
    const ticks = r.text.includes('`') ? '``' : '`';
    let s = `${ticks}${ticks.length > 1 ? ' ' : ''}${r.text}${ticks.length > 1 ? ' ' : ''}${ticks}`;
    if (m.link?.href) s = `[${s}](${linkUrl(m.link.href)})`;
    return s;
  }
  // Keep spaces outside the markers: "** bold**" is not bold in Markdown.
  const lead = r.text.match(/^\s*/)![0];
  const trail = r.text.slice(lead.length).match(/\s*$/)![0];
  const core = r.text.slice(lead.length, r.text.length - trail.length);
  if (!core) return r.text;
  let s = escapeText(core);
  if (m.strike) s = `~~${s}~~`;
  if (m.italic) s = `*${s}*`;
  if (m.bold) s = `**${s}**`;
  if (m.underline) s = `<u>${s}</u>`;
  if (m.link?.href) s = `[${s}](${linkUrl(m.link.href)})`;
  return lead + s + trail;
}

const linkUrl = (href: string) => (/[\s()<>]/.test(href) ? `<${href.replace(/[<>]/g, encodeURIComponent)}>` : href);

/** Merge neighbouring runs with the same marks so "**a****b**" comes out as "**ab**". */
function mergeRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && JSON.stringify(last.marks) === JSON.stringify(r.marks)) last.text += r.text;
    else out.push({ text: r.text, marks: r.marks });
  }
  return out;
}

function inline(el: Y.XmlElement, ctx: Ctx): string {
  let out = '';
  for (const part of inlineOf(el)) {
    if (part.kind === 'text') { out += mergeRuns(part.runs).map(wrapRun).join(''); continue; }
    const child = part.el;
    if (child.nodeName === LINK_NODE) {
      const t = child.getAttributes() as LinkTarget;
      out += ctx.opts.link ? ctx.opts.link(t) : linkToken(t);
    } else if (isFootnote(child)) {
      ctx.notes.push(citationLine(footnoteParts(child), { title: (t) => `*${t}*`, url: (u) => `<${u}>` }).replace(/\n+/g, ' '));
      out += `[^${ctx.notes.length}]`;
    } else if (child.nodeName === 'hardBreak') {
      out += '\\\n';
    } else if (child.nodeName === 'image') {
      out += `![${child.getAttribute('alt') ?? ''}](${child.getAttribute('src') ?? ''})`;
    } else {
      out += inline(child, ctx);
    }
  }
  return out;
}

// ===========================================================================
// Import

export type Frontmatter = { title?: string; tags: string[]; aliases: string[]; data: Record<string, unknown> };

/** A small YAML subset: `key: value`, `key: [a, b]`, and `key:` followed by `  - item` lines. Enough for Obsidian notes. */
export function splitFrontmatter(md: string): { fm: Frontmatter; body: string } {
  const fm: Frontmatter = { tags: [], aliases: [], data: {} };
  const m = md.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { fm, body: md.replace(/^\uFEFF/, '') };
  const unquote = (v: string) => v.trim().replace(/^(["'])(.*)\1$/, '$2');
  let key: string | null = null;
  for (const line of m[1].split(/\r?\n/)) {
    const item = line.match(/^\s+-\s*(.*)$/);
    if (item && key) {
      const arr = Array.isArray(fm.data[key]) ? (fm.data[key] as unknown[]) : [];
      fm.data[key] = [...arr, unquote(item[1])];
      continue;
    }
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    key = kv[1].toLowerCase();
    const v = kv[2].trim();
    if (v.startsWith('[') && v.endsWith(']')) fm.data[key] = v.slice(1, -1).split(',').map(unquote).filter(Boolean);
    else fm.data[key] = v === '' ? [] : unquote(v);
  }
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(/[,\s]+/) : []).map((s) => s.trim()).filter(Boolean);
  fm.tags = list(fm.data.tags ?? fm.data.tag);
  fm.aliases = list(fm.data.aliases ?? fm.data.alias);
  if (typeof fm.data.title === 'string' && fm.data.title) fm.title = fm.data.title;
  return { fm, body: md.slice(m[0].length) };
}

export type WikiResolver = (target: string, heading: string | null) => LinkTarget | null;

export type ImportOptions = {
  /** Resolves [[Note]] / [[Note#Heading]] to a page. Unresolved links become plain text. */
  resolve?: WikiResolver;
};

export type ImportResult = { title: string | null; tags: string[]; aliases: string[]; linked: number; unresolved: string[] };

type Def = { note: string; url: string; title: string; author: string };

/** Pull out "[^id]: text" definitions (with indented continuation lines). */
function extractFootnotes(md: string): { body: string; defs: Map<string, Def> } {
  const defs = new Map<string, Def>();
  const lines = md.split('\n');
  const keep: string[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence && line.match(/^\[\^([^\]\s]+)\]:\s?(.*)$/);
    if (!m) { keep.push(line); continue; }
    let text = m[2];
    while (i + 1 < lines.length && /^( {2,}|\t)\S/.test(lines[i + 1])) text += ` ${lines[++i].trim()}`;
    defs.set(m[1], parseCitation(text.trim()));
  }
  return { body: keep.join('\n'), defs };
}

/** Undo citationLine: "note — Author, *Title*, <url>" -> parts. Anything else is all note. */
function parseCitation(text: string): Def {
  const out: Def = { note: text, url: '', title: '', author: '' };
  const dash = text.lastIndexOf(' — ');
  const urlOnly = text.match(/^(.*?)\s*<?(https?:\/\/[^\s>]+)>?\s*$/);
  if (dash > -1) {
    const cite = text.slice(dash + 3).split(/,\s*/);
    const url = cite.findIndex((c) => /^<?https?:\/\//.test(c));
    const title = cite.findIndex((c) => /^\*.+\*$/.test(c));
    if (url > -1 || title > -1) {
      out.note = text.slice(0, dash);
      if (url > -1) out.url = cite[url].replace(/^<|>$/g, '');
      if (title > -1) out.title = cite[title].replace(/^\*|\*$/g, '');
      out.author = cite.filter((_, i) => i !== url && i !== title).join(', ');
      return out;
    }
  }
  if (urlOnly && urlOnly[1]) { out.note = urlOnly[1].replace(/[\s,—-]+$/, ''); out.url = urlOnly[2]; }
  return out;
}

const wikiExtension = {
  name: 'wikilink',
  level: 'inline' as const,
  start: (src: string) => src.match(/!?\[\[/)?.index,
  tokenizer(src: string) {
    const m = src.match(/^!?\[\[([^\]\n]+?)\]\]/);
    if (!m) return undefined;
    const [target, alias] = m[1].split('|');
    const [page, heading] = target.split('#');
    return { type: 'wikilink', raw: m[0], page: page.trim(), heading: heading?.trim() || null, alias: alias?.trim() || null };
  },
};
const footnoteRefExtension = {
  name: 'footnoteRef',
  level: 'inline' as const,
  start: (src: string) => src.match(/\[\^/)?.index,
  tokenizer(src: string) {
    const m = src.match(/^\[\^([^\]\s]+)\]/);
    return m ? { type: 'footnoteRef', raw: m[0], id: m[1] } : undefined;
  },
};
const md = new Marked({ gfm: true, extensions: [wikiExtension, footnoteRefExtension] });

type Marks = Record<string, any>;
type Builder = { doc: Y.Doc; opts: ImportOptions; defs: Map<string, Def>; tags: Set<string>; linked: number; unresolved: Set<string> };

/** Children for a paragraph-like element from inline tokens: XmlTexts with marks, and link/footnote elements. */
function inlineNodes(tokens: Token[] | undefined, b: Builder): (Y.XmlText | Y.XmlElement)[] {
  const out: (Y.XmlText | Y.XmlElement)[] = [];
  let delta: { insert: string; attributes?: Marks }[] = [];
  const flush = () => {
    if (!delta.length) return;
    const t = new Y.XmlText();
    t.applyDelta(delta);
    out.push(t);
    delta = [];
  };
  const text = (s: string, marks: Marks) => {
    if (!s) return;
    for (const m of s.matchAll(/(?:^|\s)#([\p{L}_][\p{L}\p{N}_/-]*)/gu)) b.tags.add(m[1].toLowerCase());
    delta.push(Object.keys(marks).length ? { insert: s, attributes: { ...marks } } : { insert: s });
  };
  const walk = (toks: Token[] | undefined, marks: Marks) => {
    for (const t of toks ?? []) {
      switch (t.type) {
        case 'strong': walk((t as Tokens.Strong).tokens, { ...marks, bold: {} }); break;
        case 'em': walk((t as Tokens.Em).tokens, { ...marks, italic: {} }); break;
        case 'del': walk((t as Tokens.Del).tokens, { ...marks, strike: {} }); break;
        case 'codespan': text(decode((t as Tokens.Codespan).text), { ...marks, code: {} }); break;
        case 'br': flush(); out.push(new Y.XmlElement('hardBreak')); break;
        case 'link': {
          const l = t as Tokens.Link;
          const href = safeHref(l.href);
          walk(l.tokens, href ? { ...marks, link: { href, target: '_blank', rel: 'noopener noreferrer nofollow', class: null } } : marks);
          break;
        }
        case 'image': {
          const im = t as Tokens.Image;
          const href = safeHref(im.href);
          text(im.text || im.href, href ? { ...marks, link: { href, target: '_blank', rel: 'noopener noreferrer nofollow', class: null } } : marks);
          break;
        }
        case 'wikilink': {
          const w = t as unknown as { page: string; heading: string | null; alias: string | null; raw: string };
          const target = /^p_[\w-]{8,40}$/.test(w.page) ? { page: w.page, tab: w.heading } : b.opts.resolve?.(w.page, w.heading) ?? null;
          const name = w.page.split('/').pop() || w.page;
          if (target) {
            flush();
            out.push(makeLink({ ...target, label: w.alias ?? (w.heading ? `${name} › ${w.heading}` : name) }));
            b.linked++;
          } else {
            if (w.page) b.unresolved.add(w.page);
            text(w.alias ?? (w.heading ? `${name} › ${w.heading}` : name), marks);
          }
          break;
        }
        case 'footnoteRef': {
          const def = b.defs.get((t as unknown as { id: string }).id);
          if (def) { flush(); out.push(makeFootnoteElement({ ...def, url: /^(https?:\/\/|mailto:)/i.test(def.url) ? def.url : '' })); }
          else text(t.raw, marks);
          break;
        }
        case 'escape': text((t as Tokens.Escape).text, marks); break;
        case 'html': {
          const raw = (t as Tokens.HTML).raw;
          if (/^<br\s*\/?>$/i.test(raw)) { flush(); out.push(new Y.XmlElement('hardBreak')); }
          else if (/^<\/?u>$/i.test(raw)) { if (raw[1] === '/') delete marks.underline; else marks.underline = {}; }
          else if (!/^<!--/.test(raw)) text(raw, marks);
          break;
        }
        case 'text': {
          const tt = t as Tokens.Text;
          if (tt.tokens?.length) walk(tt.tokens, marks);
          else text(decode(tt.text), marks);
          break;
        }
        default:
          if ('tokens' in t && Array.isArray((t as any).tokens)) walk((t as any).tokens, marks);
          else if ('text' in t) text(decode(String((t as any).text)), marks);
      }
    }
  };
  walk(tokens, {});
  flush();
  return out;
}

const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" } as Record<string, string>)[e]);
/**
 * Only web and mail links, in-page anchors and paths on this site. A javascript: href never
 * reaches the page, and neither does "//other.site" or "/\\other.site", which browsers treat
 * as links to another site.
 */
export const safeHref = (href: string) => {
  const h = href.trim();
  if (/^[/\\][/\\]/.test(h)) return null;
  return /^(https?:|mailto:|#|\/)/i.test(h) ? h : null;
};

function elementWith(name: string, children: (Y.XmlText | Y.XmlElement)[], attrs: Record<string, unknown> = {}): Y.XmlElement {
  const el = new Y.XmlElement(name);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, v as string);
  if (children.length) el.insert(0, children);
  return el;
}
const paragraph = (tokens: Token[] | undefined, b: Builder) => elementWith('paragraph', inlineNodes(tokens, b));

function blockNodes(tokens: Token[], b: Builder): Y.XmlElement[] {
  const out: Y.XmlElement[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'space': case 'def': break;
      case 'heading': {
        const h = t as Tokens.Heading;
        out.push(elementWith('heading', inlineNodes(h.tokens, b), { level: h.depth }));
        break;
      }
      case 'paragraph': out.push(paragraph((t as Tokens.Paragraph).tokens, b)); break;
      case 'text': out.push(paragraph((t as Tokens.Text).tokens ?? [{ type: 'text', raw: t.raw, text: (t as Tokens.Text).text } as Token], b)); break;
      case 'blockquote': {
        const q = t as Tokens.Blockquote;
        // "> [!toggle] line" (an Obsidian foldable callout) is a toggle line: its first line, then what is nested under it.
        const m = q.text.match(TOGGLE_CALLOUT);
        if (m) {
          const [line, ...rest] = q.text.slice(m[0].length).split('\n');
          const head = blockNodes(md.lexer(line.trim()), b).find((e) => e.nodeName === 'paragraph') ?? new Y.XmlElement('paragraph');
          out.push(elementWith('toggle', [head, ...blockNodes(md.lexer(rest.join('\n')), b)]));
          break;
        }
        out.push(elementWith('blockquote', ensureBlocks(blockNodes(q.tokens, b))));
        break;
      }
      case 'hr': out.push(new Y.XmlElement('horizontalRule')); break;
      case 'code': {
        const c = t as Tokens.Code;
        const [lang, ...rest] = (c.lang ?? '').split(/\s+/);
        if (lang === 'livepage-html') { out.push(htmlBlock(b.doc, c.text, titleArg(rest))); break; }
        if (lang === 'livepage-mindmap') { out.push(mindMapBlock(b.doc, c.text, titleArg(rest))); break; }
        const t2 = new Y.XmlText();
        if (c.text) t2.insert(0, c.text);
        out.push(elementWith('codeBlock', [t2], { language: lang || null }));
        break;
      }
      case 'list': {
        const l = t as Tokens.List;
        // TipTap's StarterKit has no task list, so tasks keep their box as text.
        const items = l.items.map((it) => {
          const inner = ensureBlocks(blockNodes(it.tokens.filter((x) => x.type !== 'checkbox'), b));
          if (it.task) {
            const first = inner[0];
            const box = new Y.XmlText();
            box.insert(0, it.checked ? '☑ ' : '☐ ');
            if (first?.nodeName === 'paragraph') first.insert(0, [box]);
          }
          return elementWith('listItem', inner);
        });
        out.push(elementWith(l.ordered ? 'orderedList' : 'bulletList', items, l.ordered && l.start !== 1 && l.start !== '' ? { start: Number(l.start) } : {}));
        break;
      }
      case 'table': {
        const tb = t as Tokens.Table;
        const cell = (c: Tokens.TableCell, header: boolean) => elementWith(header ? 'tableHeader' : 'tableCell', [paragraph(c.tokens, b)]);
        const rows = [
          elementWith('tableRow', tb.header.map((c) => cell(c, true))),
          ...tb.rows.map((r) => elementWith('tableRow', r.map((c) => cell(c, false)))),
        ];
        out.push(elementWith('table', rows));
        break;
      }
      case 'html': {
        const raw = (t as Tokens.HTML).text.trim();
        if (!raw || /^<!--[\s\S]*-->$/.test(raw)) break;
        // Raw HTML runs as a live block, in the sandbox like every other HTML block.
        out.push(htmlBlock(b.doc, raw, ''));
        break;
      }
      default:
        if ('tokens' in t && Array.isArray((t as any).tokens)) out.push(paragraph((t as any).tokens, b));
        else if ('text' in t && String((t as any).text).trim()) out.push(paragraph([{ type: 'text', raw: (t as any).text, text: (t as any).text } as Token], b));
    }
  }
  return out;
}

const TOGGLE_CALLOUT = /^\[!toggle\][+-]?[ \t]*/i;
const ensureBlocks = (els: Y.XmlElement[]) => (els.length ? els : [new Y.XmlElement('paragraph')]);
function titleArg(rest: string[]): string {
  const s = rest.join(' ').trim();
  try { return s.startsWith('"') ? JSON.parse(s) : s; } catch { return s; }
}

function htmlBlock(doc: Y.Doc, code: string, title: string): Y.XmlElement {
  const blockId = newId('html');
  htmlCodeText(doc, blockId).insert(0, code);
  return elementWith(HTML_NODE, [], { blockId, title, status: 'ready', initialHeight: 160, placeholders: '[]' });
}

function mindMapBlock(doc: Y.Doc, outline: string, title: string): Y.XmlElement {
  const blockId = newId('mind');
  const stack: { depth: number; id: string | null }[] = [{ depth: -1, id: null }];
  for (const line of outline.split('\n')) {
    const m = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (!m) continue;
    const depth = m[1].replace(/\t/g, '  ').length;
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
    const id = addMindNode(doc, blockId, stack[stack.length - 1].id, m[2].trim());
    stack.push({ depth, id });
  }
  if (!mindMapNodes(doc, blockId).size) addMindNode(doc, blockId, null, title || 'Idea');
  return elementWith(MIND_NODE, [], { blockId, title });
}

/**
 * Markdown as new, not yet inserted blocks for `doc` (the data of HTML blocks and mind maps is written
 * to the doc's maps right away). [^1] footnotes need their definitions in the same text.
 */
export function markdownToBlocks(doc: Y.Doc, markdown: string, opts: ImportOptions = {}): Y.XmlElement[] {
  const { body: rest, defs } = extractFootnotes(markdown.replace(/\r\n?/g, '\n'));
  const b: Builder = { doc, opts, defs, tags: new Set(), linked: 0, unresolved: new Set() };
  return blockNodes(md.lexer(rest), b);
}

/**
 * Write Markdown into a page: appends to the main tab, and a <!-- livepage-tab: Title --> line
 * starts a new tab. Call on an empty page for a clean import.
 */
export function importMarkdown(doc: Y.Doc, markdown: string, opts: ImportOptions = {}): ImportResult {
  const { fm, body } = splitFrontmatter(markdown.replace(/\r\n?/g, '\n'));
  const { body: rest, defs } = extractFootnotes(body);
  const b: Builder = { doc, opts, defs, tags: new Set(fm.tags.map((t) => t.replace(/^#/, '').toLowerCase())), linked: 0, unresolved: new Set() };
  const sections = rest.split(/^<!--\s*livepage-tab:\s*(.*?)\s*-->[ \t]*$/m);
  doc.transact(() => {
    for (let i = 0; i < sections.length; i += 2) {
      const tab = i === 0 ? MAIN_TAB : addTab(doc, sections[i - 1] || 'Untitled');
      const els = blockNodes(md.lexer(sections[i]), b);
      if (!els.length) continue;
      const f = fragment(doc, tab);
      f.insert(f.length, els);
    }
    if (fm.title) doc.getMap(META).set('title', fm.title.slice(0, 200));
  });
  return { title: fm.title ?? null, tags: [...b.tags], aliases: fm.aliases, linked: b.linked, unresolved: [...b.unresolved] };
}

export type { MindTree };
