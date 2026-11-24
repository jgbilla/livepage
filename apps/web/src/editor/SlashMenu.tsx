// The "/" menu, like Notion's. Type / at the start of a line or after a space, then a few letters
// to filter; arrow keys move, Enter or Tab picks, Escape closes. It lists every block the editor
// can insert (headings, lists, tables, mind maps, live HTML blocks, footnotes, page links,
// templates...) and page actions (comment, Ask AI). On touch screens the "+" button opens it too.
import { Icon, type IconName } from '../design/Icon';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type * as Y from 'yjs';
import { titleOf, useWorkspace } from '../workspace';
import { anchorFromSelection } from './comments';
import type { CommentAnchor } from '@livepage/schema';
import { insertTemplate } from './insertTemplate';

type MenuKeys = { onKey: ((e: KeyboardEvent) => boolean) | null };
const slashKey = new PluginKey('slashCommands');

/** Lets the open "/" menu take arrow keys, Enter, Tab and Escape before the editor does. */
export const SlashCommands = Extension.create<object, MenuKeys>({
  name: 'slashCommands',
  addStorage() { return { onKey: null }; },
  addProseMirrorPlugins() {
    const storage = this.storage;
    return [new Plugin({ key: slashKey, props: { handleKeyDown: (_view, event) => storage.onKey?.(event) ?? false } })];
  },
});

/** Open the menu at the cursor by typing a "/" (adds a space first when needed). Used by the "+" button. */
export function openSlashMenu(editor: Editor) {
  const { $from } = editor.state.selection;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
  editor.chain().focus().insertContent(before && !/\s$/.test(before) ? ' /' : '/').run();
}

export type SlashContext = {
  doc: Y.Doc;
  canComment: boolean;
  onComment?: (anchor: CommentAnchor) => void;
  onAskAi?: () => void;
};

type Command = {
  id: string;
  title: string;
  description: string;
  icon: IconName;
  group: string;
  /** Other words that find it: "h1", "ul", "todo", "hr"... */
  keywords: string[];
  /** Runs after the "/query" text is removed. */
  run: (editor: Editor) => void;
};

const today = () => new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

function baseCommands(ctx: SlashContext): Command[] {
  const c = (e: Editor) => e.chain().focus();
  const list: Command[] = [
    { id: 'text', group: 'Basic blocks', icon: 'text', title: 'Text', description: 'Plain writing', keywords: ['paragraph', 'p', 'plain'], run: (e) => c(e).setParagraph().run() },
    { id: 'h1', group: 'Basic blocks', icon: 'heading-1', title: 'Heading 1', description: 'Big section heading', keywords: ['h1', 'title', '#'], run: (e) => c(e).setHeading({ level: 1 }).run() },
    { id: 'h2', group: 'Basic blocks', icon: 'heading', title: 'Heading 2', description: 'Medium section heading', keywords: ['h2', 'subtitle', '##'], run: (e) => c(e).setHeading({ level: 2 }).run() },
    { id: 'h3', group: 'Basic blocks', icon: 'heading-3', title: 'Heading 3', description: 'Small section heading', keywords: ['h3', '###'], run: (e) => c(e).setHeading({ level: 3 }).run() },
    { id: 'toggle-h1', group: 'Basic blocks', icon: 'toggle', title: 'Toggle heading 1', description: 'Big heading you can collapse', keywords: ['toggle', 'collapse', 'collapsible', 'fold', 'h1', 'accordion', 'details'], run: (e) => c(e).setToggleHeading(1).run() },
    { id: 'toggle-h2', group: 'Basic blocks', icon: 'toggle', title: 'Toggle heading 2', description: 'Medium heading you can collapse', keywords: ['toggle', 'collapse', 'collapsible', 'fold', 'h2', 'accordion', 'details'], run: (e) => c(e).setToggleHeading(2).run() },
    { id: 'toggle-h3', group: 'Basic blocks', icon: 'toggle', title: 'Toggle heading 3', description: 'Small heading you can collapse', keywords: ['toggle', 'collapse', 'collapsible', 'fold', 'h3', 'accordion', 'details'], run: (e) => c(e).setToggleHeading(3).run() },
    { id: 'bullet', group: 'Basic blocks', icon: 'list', title: 'Bulleted list', description: 'A simple list with bullets', keywords: ['ul', 'unordered', 'list', 'bullets', '-'], run: (e) => c(e).toggleBulletList().run() },
    { id: 'numbered', group: 'Basic blocks', icon: 'list-ordered', title: 'Numbered list', description: 'A list with numbers', keywords: ['ol', 'ordered', 'list', 'numbers'], run: (e) => c(e).toggleOrderedList().run() },
    { id: 'todo', group: 'Basic blocks', icon: 'todo', title: 'To-do list', description: 'Track tasks with checkboxes', keywords: ['todo', 'task', 'checkbox', 'check', 'list', '[]'], run: (e) => c(e).toggleTaskList().run() },
    { id: 'quote', group: 'Basic blocks', icon: 'quote', title: 'Quote', description: 'Set off a quotation', keywords: ['blockquote', 'citation', '>'], run: (e) => c(e).toggleBlockquote().run() },
    { id: 'divider', group: 'Basic blocks', icon: 'divider', title: 'Divider', description: 'A line between sections', keywords: ['hr', 'rule', 'separator', 'line', '---'], run: (e) => c(e).setHorizontalRule().run() },
    { id: 'code', group: 'Basic blocks', icon: 'code', title: 'Code block', description: 'Code with syntax highlighting', keywords: ['code', 'snippet', 'pre', '```'], run: (e) => c(e).setCodeBlock().run() },
    { id: 'table', group: 'Basic blocks', icon: 'table', title: 'Table', description: 'A 3 × 3 table with a header row', keywords: ['grid', 'rows', 'columns', 'spreadsheet'], run: (e) => c(e).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
    { id: 'mindmap', group: 'Live blocks', icon: 'mind-map', title: 'Mind map', description: 'Branching ideas you and agents edit live', keywords: ['mind', 'map', 'brainstorm', 'tree', 'diagram'], run: (e) => c(e).insertMindMap().run() },
    { id: 'html', group: 'Live blocks', icon: 'html-block', title: 'HTML block', description: 'Custom UI, animations and charts in a sandbox', keywords: ['html', 'custom', 'ui', 'embed', 'widget', 'animation', 'js', 'javascript', 'iframe', 'artifact'], run: (e) => c(e).insertHtmlBlock().run() },
    { id: 'footnote', group: 'Inline', icon: 'footnote', title: 'Footnote', description: 'A numbered note at the bottom of the tab', keywords: ['fn', 'footnote', 'note', 'citation', 'source', 'reference'], run: (e) => c(e).insertFootnote().run() },
    { id: 'link', group: 'Inline', icon: 'arrow-up-right', title: 'Link to page', description: 'Link to a page or tab, like [[', keywords: ['link', 'page', 'mention', '[[', 'backlink', 'tab'], run: (e) => c(e).insertContent('[[').run() },
    { id: 'date', group: 'Inline', icon: 'calendar', title: "Today's date", description: today(), keywords: ['date', 'today', 'now'], run: (e) => c(e).insertContent(today() + ' ').run() },
  ];
  if (ctx.canComment && ctx.onComment) {
    const onComment = ctx.onComment;
    list.push({
      id: 'comment', group: 'Actions', icon: 'comment', title: 'Comment', description: 'Start a comment thread on this line', keywords: ['comment', 'discuss', 'note', 'feedback', 'mention', '@'],
      run: (e) => {
        // Comment on the line's text when it has some, else on the page.
        const { $from } = e.state.selection;
        if ($from.parent.textContent.trim()) {
          const start = $from.start();
          e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, start, start + $from.parent.content.size)));
        }
        onComment(anchorFromSelection(e) ?? { kind: 'page' });
      },
    });
  }
  if (ctx.onAskAi) {
    const onAskAi = ctx.onAskAi;
    list.push({ id: 'ai', group: 'Actions', icon: 'sparkles', title: 'Ask AI', description: 'Ask an AI or a connected agent to write here', keywords: ['ai', 'assistant', 'agent', 'claude', 'gpt', 'write', 'generate'], run: () => onAskAi() });
  }
  return list;
}

// Best match first: title prefix, word prefix, keyword prefix, then anywhere in the title.
function score(cmd: Command, q: string): number {
  if (!q) return 1;
  const t = cmd.title.toLowerCase();
  if (t.startsWith(q)) return 6;
  if (cmd.keywords.some((k) => k === q)) return 5;
  if (t.split(/[\s-]+/).some((w) => w.startsWith(q))) return 4;
  if (cmd.keywords.some((k) => k.startsWith(q))) return 3;
  if (t.includes(q)) return 2;
  if (cmd.description.toLowerCase().includes(q) && q.length > 2) return 1;
  return 0;
}

type Match = { from: number; to: number; query: string };

export function SlashMenu({ editor, ctx }: { editor: Editor; ctx: SlashContext }) {
  const ws = useWorkspace();
  const [match, setMatch] = useState<Match | null>(null);
  const [index, setIndex] = useState(0);
  const dismissed = useRef<number | null>(null);

  // Open while the text before the cursor is "/word" at the start of a line or after a space.
  useEffect(() => {
    const update = () => {
      const { state } = editor;
      const { $from, empty } = state.selection;
      if (!empty || !editor.isEditable || $from.parent.type.spec.code) return setMatch(null);
      const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
      const m = before.match(/(?:^|\s)\/([^\s/]{0,24})$/);
      if (!m) { dismissed.current = null; return setMatch(null); }
      const from = $from.pos - m[1].length - 1;
      if (dismissed.current === from) return setMatch(null);
      setMatch({ from, to: $from.pos, query: m[1] });
    };
    editor.on('transaction', update);
    const hide = () => setTimeout(() => { if (!editor.isFocused) setMatch(null); }, 150);
    editor.on('blur', hide);
    return () => { editor.off('transaction', update); editor.off('blur', hide); };
  }, [editor]);
  useEffect(() => setIndex(0), [match?.query]);

  const templates = useMemo(() => (ws?.pages ?? []).filter((p) => p.is_template)
    .map((p) => ({ id: p.id, title: titleOf(p) || 'Untitled template' })).sort((a, b) => a.title.localeCompare(b.title)), [ws]);

  const items = useMemo(() => {
    if (!match) return [];
    const q = match.query.toLowerCase();
    const all = baseCommands(ctx);
    for (const t of templates) {
      all.push({
        id: `tpl:${t.id}`, group: 'Templates', icon: 'template', title: t.title, description: 'Insert this template here',
        keywords: ['template', ...t.title.toLowerCase().split(/\s+/)],
        run: (e) => { void insertTemplate(e, ctx.doc, t.id).catch((err) => console.warn('template insert failed', err)); },
      });
    }
    if (!q) return all;
    return all.map((cmd, i) => ({ cmd, s: score(cmd, q), i })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.cmd);
  }, [match, ctx, templates]);

  const close = () => { if (match) dismissed.current = match.from; setMatch(null); };
  const pick = (cmd: Command) => {
    if (!match) return;
    editor.chain().focus().deleteRange({ from: match.from, to: match.to }).run();
    setMatch(null);
    cmd.run(editor);
  };

  const storage = (editor.storage as unknown as Record<string, MenuKeys>).slashCommands;
  useEffect(() => {
    if (!storage) return;
    storage.onKey = !match ? null : (e) => {
      if (e.key === 'Escape') { close(); return true; }
      if (!items.length) return false;
      if (e.key === 'ArrowDown') { setIndex((i) => (i + 1) % items.length); return true; }
      if (e.key === 'ArrowUp') { setIndex((i) => (i - 1 + items.length) % items.length); return true; }
      if (e.key === 'Enter' || e.key === 'Tab') { pick(items[Math.min(index, items.length - 1)]); return true; }
      return false;
    };
    return () => { storage.onKey = null; };
  });

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { listRef.current?.querySelector('.slash-item.active')?.scrollIntoView({ block: 'nearest' }); }, [index, match?.query]);

  // Place it under the cursor, or above when the screen (or the space over a phone keyboard) is short.
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!match) return setPos(null);
    let at = { left: 0, top: 0, bottom: 0 };
    try { at = editor.view.coordsAtPos(match.from); } catch { return; }
    const vv = window.visualViewport;
    const vw = document.documentElement.clientWidth;
    const viewTop = vv ? vv.offsetTop : 0;
    const viewBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
    const width = Math.min(320, vw - 16);
    const left = Math.max(8, Math.min(at.left, vw - width - 8));
    const below = viewBottom - at.bottom - 12;
    const above = at.top - viewTop - 12;
    if (below >= 220 || below >= above) setPos({ left, top: at.bottom + 4, maxHeight: Math.max(120, Math.min(360, below)), width });
    else setPos({ left, bottom: window.innerHeight - at.top + 4, maxHeight: Math.max(120, Math.min(360, above)), width });
  }, [match, editor, items.length]);

  if (!match || !pos) return null;
  let lastGroup = '';
  return (
    <div className="slash-menu" role="listbox" aria-label="Insert a block" ref={listRef}
      style={{ left: pos.left, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxHeight, width: pos.width }}
      onMouseDown={(e) => e.preventDefault()} onPointerDown={(e) => e.preventDefault()}>
      {items.length ? items.map((cmd, i) => {
        const head = !match.query && cmd.group !== lastGroup ? cmd.group : null;
        lastGroup = cmd.group;
        return (
          <div key={cmd.id}>
            {head && <div className="slash-group muted small">{head}</div>}
            <button type="button" role="option" aria-selected={i === index} className={`slash-item ${i === index ? 'active' : ''}`}
              onMouseEnter={() => setIndex(i)} onClick={() => pick(cmd)}>
              <span className={`slash-icon ${cmd.id === 'ai' ? 'agent' : ''}`} aria-hidden><Icon name={cmd.icon} /></span>
              <span className="slash-text">
                <span className="slash-title">{cmd.title}</span>
                <span className="slash-desc muted small">{cmd.description}</span>
              </span>
            </button>
          </div>
        );
      }) : <div className="slash-empty muted small">No results for “{match.query}”</div>}
    </div>
  );
}
