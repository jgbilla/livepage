// Templates. Any page can be a template. A new page from a template starts as a copy of it
// (every tab and block, HTML blocks and mind maps included), then:
//   - built-in variables are filled in: {{title}} {{date}} {{time}} {{yesterday}} {{tomorrow}} {{weekday}}
//     ({{date:YYYY-MM-DD}} style formats work too, as in Obsidian)
//   - anything else in double braces, like {{Summary of yesterday}}, is a field left for a person or an
//     agent to fill in (fillFields / the fill_template_fields tool).
import * as Y from 'yjs';
import { ACTIONS, COMMENTS, listTabs, fragment, META } from './index.ts';
import { textNodes } from './walk.ts';

export const FIELD_RE = /\{\{\s*([^{}\n]{1,120}?)\s*\}\}/g;

export type TemplateVars = { title: string; date: string /* YYYY-MM-DD */; time?: string /* HH:mm */ };

function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

function formatDate(date: string, fmt: string): string {
  const [y, m, d] = date.split('-');
  const dt = new Date(Date.UTC(+y, +m - 1, +d));
  const weekday = dt.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  const month = dt.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  return fmt.replace(/YYYY|MMMM|MMM|MM|DD|dddd|ddd|D|M/g, (t) => ({
    YYYY: y, MM: m, DD: d, D: String(+d), M: String(+m), MMMM: month, MMM: month.slice(0, 3), dddd: weekday, ddd: weekday.slice(0, 3),
  } as Record<string, string>)[t]);
}

/** The value of a built-in variable, or null when it is a field to fill in later. */
export function builtinValue(name: string, v: TemplateVars): string | null {
  const [key, fmt] = name.split(/:(.*)/s).map((s) => s?.trim());
  const k = key.toLowerCase();
  const withFmt = (date: string) => (fmt ? formatDate(date, fmt) : date);
  if (k === 'title') return v.title;
  if (k === 'date') return withFmt(v.date);
  if (k === 'yesterday') return withFmt(shiftDate(v.date, -1));
  if (k === 'tomorrow') return withFmt(shiftDate(v.date, 1));
  if (k === 'weekday') return formatDate(v.date, 'dddd');
  if (k === 'time') return v.time ?? '';
  return null;
}

/** Replace {{...}} in every text of every tab. `value` returns the replacement, or null to leave it. Returns how many were replaced. */
export function replaceFields(doc: Y.Doc, value: (name: string) => string | null): number {
  let count = 0;
  doc.transact(() => {
    for (const tab of listTabs(doc)) {
      for (const t of textNodes(fragment(doc, tab.id))) {
        // Work from the end so earlier offsets stay valid. Fields never span formatting runs.
        const ops = t.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[];
        const hits: { at: number; len: number; text: string; attrs?: Record<string, unknown> }[] = [];
        let offset = 0;
        for (const op of ops) {
          if (typeof op.insert !== 'string') { offset += 1; continue; }
          for (const m of op.insert.matchAll(FIELD_RE)) {
            const v = value(m[1]);
            if (v !== null) hits.push({ at: offset + m.index!, len: m[0].length, text: v, attrs: op.attributes });
          }
          offset += op.insert.length;
        }
        for (const h of hits.reverse()) {
          t.delete(h.at, h.len);
          if (h.text) t.insert(h.at, h.text, h.attrs ?? {});
          count++;
        }
      }
    }
  });
  return count;
}

/** Fields still waiting to be filled in, in reading order, without duplicates. */
export function listFields(doc: Y.Doc): string[] {
  const out = new Set<string>();
  for (const tab of listTabs(doc)) {
    for (const t of textNodes(fragment(doc, tab.id))) for (const m of t.toString().replace(/<[^>]+>/g, '').matchAll(FIELD_RE)) out.add(m[1]);
  }
  return [...out];
}

/** Fill named fields: { "Summary of yesterday": "..." }. Names match case-insensitively. */
export function fillFields(doc: Y.Doc, fields: Record<string, string>): number {
  const byName = new Map(Object.entries(fields).map(([k, v]) => [k.trim().toLowerCase(), String(v)]));
  return replaceFields(doc, (name) => byName.get(name.trim().toLowerCase()) ?? null);
}

/**
 * Turn `target` (an empty, new page) into a copy of the template document, with built-in variables filled in.
 * Comments and pending block actions are not copied.
 */
export function applyTemplate(target: Y.Doc, templateState: Uint8Array, vars: TemplateVars): void {
  Y.applyUpdate(target, templateState);
  target.transact(() => {
    for (const name of [COMMENTS, ACTIONS]) {
      const m = target.getMap(name);
      for (const k of [...m.keys()]) m.delete(k);
    }
    const meta = target.getMap(META);
    meta.delete('template');
    meta.set('title', vars.title.slice(0, 200));
  });
  replaceFields(target, (name) => builtinValue(name, vars));
}
