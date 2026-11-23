// Highlights {{fields}} in a page, so blanks left by a template (for you or an agent) stand out.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

const FIELD = /\{\{\s*[^{}\n]{1,120}?\s*\}\}/g;
const BUILTIN = /^\{\{\s*(title|date|time|yesterday|tomorrow|weekday)(:[^}]*)?\s*\}\}$/i;

function decorate(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    for (const m of node.text.matchAll(FIELD)) {
      decos.push(Decoration.inline(pos + m.index!, pos + m.index! + m[0].length, {
        class: BUILTIN.test(m[0]) ? 'template-var' : 'template-field',
        title: BUILTIN.test(m[0]) ? 'Filled in when a page is made from this template' : 'A field to fill in (agents can fill it with fill_template_fields)',
      }));
    }
  });
  return DecorationSet.create(doc, decos);
}

export const TemplateFields = Extension.create({
  name: 'templateFields',
  addProseMirrorPlugins() {
    const key = new PluginKey('templateFields');
    return [new Plugin({
      key,
      state: {
        init: (_, { doc }) => decorate(doc),
        apply: (tr, old) => (tr.docChanged ? decorate(tr.doc) : old),
      },
      props: { decorations: (state) => key.getState(state) },
    })];
  },
});
