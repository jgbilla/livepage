// Shared document model. The web editor, the collab server and agents all use this,
// so a page means the same thing to every participant.
//
// A page is ONE Y.Doc:
//   - XmlFragment "default"   the ProseMirror/TipTap block tree (paragraphs, headings, lists, htmlBlock nodes)
//   - Map "htmlCode"          blockId -> Y.Text holding that HTML block's source (so code is co-edited char by char)
//   - Map "comments"          commentId -> Y.Map (anchor, author, body, resolved)  [see SPEC.md, not wired in the UI yet]
//   - Map "meta"              title, icon, etc.
import * as Y from 'yjs';

export const FRAGMENT = 'default';
export const HTML_CODE = 'htmlCode';
export const COMMENTS = 'comments';
export const META = 'meta';
export const HTML_NODE = 'htmlBlock';

export const fragment = (doc: Y.Doc) => doc.getXmlFragment(FRAGMENT);
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
  return el.toArray().map((c) => textOf(c as Y.XmlElement | Y.XmlText)).join('');
}

export type BlockRow = {
  id: string;
  position: number;
  type: string;
  text: string;
  attrs: Record<string, unknown>;
};

/** Flatten the top-level blocks of a page. Used for the Postgres `blocks` projection and for agents reading the page. */
export function listBlocks(doc: Y.Doc): BlockRow[] {
  return fragment(doc)
    .toArray()
    .map((node, position) => {
      if (node instanceof Y.XmlText) {
        return { id: `pos_${position}`, position, type: 'text', text: node.toString(), attrs: {} };
      }
      const el = node as Y.XmlElement;
      const attrs = el.getAttributes() as Record<string, unknown>;
      const type = el.nodeName;
      const id = String(attrs.blockId ?? `pos_${position}`);
      const text = type === HTML_NODE ? (htmlCodeMap(doc).get(id)?.toString() ?? '') : textOf(el);
      return { id, position, type, text, attrs };
    });
}

/** A compact, model-friendly rendering of the page. */
export function pageAsMarkdown(doc: Y.Doc): string {
  return listBlocks(doc)
    .map((b) => {
      if (b.type === 'heading') return `${'#'.repeat(Number(b.attrs.level ?? 1))} ${b.text}`;
      if (b.type === HTML_NODE) return `<html-block id="${b.id}" title="${b.attrs.title ?? ''}">\n${b.text}\n</html-block>`;
      return b.text;
    })
    .join('\n\n');
}

export function makeParagraph(text = ''): { el: Y.XmlElement; text: Y.XmlText } {
  const el = new Y.XmlElement('paragraph');
  const t = new Y.XmlText();
  el.insert(0, [t]);
  if (text) t.insert(0, text);
  return { el, text: t };
}

export function appendHeading(doc: Y.Doc, text: string, level = 2): void {
  doc.transact(() => {
    const el = new Y.XmlElement('heading');
    el.setAttribute('level', level as unknown as string);
    const t = new Y.XmlText();
    el.insert(0, [t]);
    t.insert(0, text);
    const f = fragment(doc);
    f.insert(f.length, [el]);
  });
}

export function appendParagraph(doc: Y.Doc, text: string): void {
  doc.transact(() => {
    const f = fragment(doc);
    f.insert(f.length, [makeParagraph(text).el]);
  });
}

/** Insert an HTML/JS block. `index` defaults to the end of the page. Returns the block id. */
export function insertHtmlBlock(doc: Y.Doc, code: string, opts: { title?: string; index?: number } = {}): string {
  const blockId = newId('html');
  doc.transact(() => {
    htmlCodeText(doc, blockId).insert(0, code);
    const el = new Y.XmlElement(HTML_NODE);
    el.setAttribute('blockId', blockId);
    el.setAttribute('title', opts.title ?? '');
    const f = fragment(doc);
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
