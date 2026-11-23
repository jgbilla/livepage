// Insert a template's first tab at the cursor (the "/" menu's Templates section). New pages from a
// template are copied on the server; this copies into a page you already have open, in the browser:
// it reads the template over its own short-lived connection (so your access to it is checked as usual),
// fills in {{date}}, {{title}}... and gives HTML blocks, mind maps and footnotes fresh ids with their
// content copied, so the copy and the template never share state.
import type { Editor, JSONContent } from '@tiptap/core';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import {
  FIELD_RE, FOOTNOTE_NODE, HTML_NODE, MAIN_TAB, META, MIND_NODE, builtinValue, fragment, htmlCodeMap, htmlCodeText, listTabs, mindMapNodes, newId,
} from '@livepage/schema';
import { collabUrl } from '../config';

const pad = (n: number) => String(n).padStart(2, '0');

async function readTemplate(templateId: string): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({ url: collabUrl(), name: templateId, document: doc, token: 'session' });
  try {
    await new Promise<void>((resolve, reject) => {
      if (provider.isSynced) return resolve();
      const t = setTimeout(() => reject(new Error('The template did not load in time.')), 10_000);
      provider.on('synced', () => { clearTimeout(t); resolve(); });
      provider.on('authenticationFailed', () => { clearTimeout(t); reject(new Error('You cannot open that template.')); });
    });
    return doc;
  } finally {
    provider.destroy();
  }
}

export async function insertTemplate(editor: Editor, doc: Y.Doc, templateId: string): Promise<void> {
  const at = editor.state.selection.from;
  const src = await readTemplate(templateId);
  const firstTab = listTabs(src)[0]?.id ?? MAIN_TAB;
  const json = yXmlFragmentToProsemirrorJSON(fragment(src, firstTab)) as JSONContent;
  const d = new Date();
  const vars = {
    title: String(doc.getMap(META).get('title') ?? ''),
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };

  const copy = (n: JSONContent): JSONContent => {
    const out: JSONContent = { ...n, attrs: n.attrs ? { ...n.attrs } : undefined };
    if (n.type === 'text' && n.text) out.text = n.text.replace(FIELD_RE, (all, name) => builtinValue(name, vars) ?? all);
    if (n.type === HTML_NODE && n.attrs?.blockId) {
      const id = newId('html');
      const code = htmlCodeMap(src).get(String(n.attrs.blockId))?.toString() ?? '';
      doc.transact(() => htmlCodeText(doc, id).insert(0, code));
      out.attrs!.blockId = id;
    }
    if (n.type === MIND_NODE && n.attrs?.blockId) {
      const id = newId('mind');
      const nodes = [...mindMapNodes(src, String(n.attrs.blockId)).values()];
      doc.transact(() => { const m = mindMapNodes(doc, id); for (const x of nodes) m.set(x.id, { ...x }); });
      out.attrs!.blockId = id;
    }
    if (n.type === FOOTNOTE_NODE && n.attrs?.id) out.attrs!.id = newId('fn');
    if (n.content) out.content = n.content.map(copy);
    return out;
  };
  const content = (json.content ?? []).map(copy);
  src.destroy();
  if (!content.length || editor.isDestroyed) return;
  const pos = Math.min(at, editor.state.doc.content.size);
  // An empty line the template goes on is replaced rather than left above it.
  const $pos = editor.state.doc.resolve(pos);
  const emptyLine = $pos.parent.isTextblock && $pos.parent.content.size === 0 && $pos.depth > 0;
  const range = emptyLine ? { from: $pos.before(), to: $pos.after() } : pos;
  editor.chain().focus().insertContentAt(range, content).run();
}
