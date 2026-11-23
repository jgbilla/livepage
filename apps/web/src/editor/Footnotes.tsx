import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { safeUrl } from '@livepage/schema';
import { collectFootnotes, footnotePos, removeFootnoteById, setFootnoteAttrs, type FootnoteEntry } from './Footnote';
import { Icon } from '../design/Icon';

// Everything footnotes need around the editor: the numbered list at the bottom of the tab,
// the hover preview on each marker, and the small editor that opens when one is inserted.

function useFootnotes(editor: Editor): FootnoteEntry[] {
  const [list, setList] = useState(() => collectFootnotes(editor.state.doc));
  useEffect(() => {
    const update = () => setList(collectFootnotes(editor.state.doc));
    editor.on('transaction', update);
    update();
    return () => { editor.off('transaction', update); };
  }, [editor]);
  return list;
}

const isEmpty = (f: FootnoteEntry) => !f.note.trim() && !f.url.trim() && !f.title.trim() && !f.author.trim();

function flash(el: Element | null) {
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('fn-flash');
  void (el as HTMLElement).offsetWidth; // restart the animation
  el.classList.add('fn-flash');
}

/** Scroll to a footnote's marker in the text and select it. */
export function goToMarker(editor: Editor, id: string) {
  const pos = footnotePos(editor, id);
  if (pos == null) return;
  if (editor.isEditable) editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
  flash(editor.view.dom.querySelector(`[data-footnote-id="${CSS.escape(id)}"]`));
}

function Citation({ f }: { f: FootnoteEntry }) {
  const url = safeUrl(f.url);
  const parts = [f.author.trim(), f.title.trim()].filter(Boolean);
  if (!parts.length && !f.url.trim()) return null;
  return (
    <span className="fn-cite">
      {f.author.trim() && <span>{f.author.trim()}</span>}
      {f.author.trim() && (f.title.trim() || url) && ', '}
      {f.title.trim() && (url
        ? <a href={url} target="_blank" rel="noopener noreferrer nofollow"><i>{f.title.trim()}</i></a>
        : <i>{f.title.trim()}</i>)}
      {!f.title.trim() && url && <a href={url} target="_blank" rel="noopener noreferrer nofollow">{url.replace(/^https?:\/\//, '')}</a>}
      {!f.title.trim() && !url && f.url.trim() && <span className="muted">{f.url.trim()}</span>}
    </span>
  );
}

function FootnoteBody({ f }: { f: FootnoteEntry }) {
  return (
    <>
      {f.note.trim() && <span className="fn-note">{f.note}</span>}
      {f.note.trim() && (f.author || f.title || f.url) && ' '}
      <Citation f={f} />
      {isEmpty(f) && <span className="muted">Empty footnote</span>}
    </>
  );
}

function FootnoteForm({ editor, f, onDone, autoFocus }: { editor: Editor; f: FootnoteEntry; onDone: () => void; autoFocus?: boolean }) {
  const set = (k: 'note' | 'url' | 'title' | 'author') => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setFootnoteAttrs(editor, f.id, { [k]: e.target.value });
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); onDone(); }
  };
  const badUrl = f.url.trim() !== '' && !safeUrl(f.url);
  return (
    <div className="fn-form" onKeyDown={keys}>
      <textarea autoFocus={autoFocus} rows={2} placeholder="Footnote text (optional)" value={f.note} onChange={set('note')} />
      <div className="fn-form-row">
        <input placeholder="Author" value={f.author} onChange={set('author')} />
        <input placeholder="Title" value={f.title} onChange={set('title')} />
      </div>
      <input placeholder="https://source.example/article" value={f.url} onChange={set('url')} className={badUrl ? 'fn-bad' : ''} />
      {badUrl && <div className="fn-hint">Links must start with http:// or https://</div>}
      <div className="fn-form-row fn-form-actions">
        <button type="button" className="ghost" onClick={() => { removeFootnoteById(editor, f.id); onDone(); }}>Delete</button>
        <button type="button" className="primary" onClick={onDone}>Done</button>
      </div>
    </div>
  );
}

type Card = { id: string; mode: 'preview' | 'edit'; fresh?: boolean };

export function Footnotes({ editor, readOnly, editRequest }: { editor: Editor; readOnly: boolean; editRequest: { id: string; at: number } | null }) {
  const list = useFootnotes(editor);
  const [card, setCard] = useState<Card | null>(null);
  const [editingInList, setEditingInList] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const cardRef = useRef<HTMLDivElement>(null);
  const cardMode = useRef<Card | null>(null);
  cardMode.current = card;

  // A footnote was just inserted: open its editor next to the marker.
  useEffect(() => {
    if (editRequest && !readOnly) setCard({ id: editRequest.id, mode: 'edit', fresh: true });
  }, [editRequest, readOnly]);

  // Hover previews and click-to-jump on markers (event delegation on the editor).
  useEffect(() => {
    const root = editor.view.dom;
    const markerOf = (e: Event) => (e.target as HTMLElement).closest?.('.fn-ref') as HTMLElement | null;
    const over = (e: MouseEvent) => {
      const m = markerOf(e);
      if (!m || cardMode.current?.mode === 'edit') return;
      window.clearTimeout(hideTimer.current);
      setCard({ id: m.dataset.footnoteId!, mode: 'preview' });
    };
    const out = (e: MouseEvent) => {
      if (!markerOf(e) || cardMode.current?.mode === 'edit') return;
      hideTimer.current = window.setTimeout(() => setCard((c) => (c?.mode === 'preview' ? null : c)), 250);
    };
    const click = (e: MouseEvent) => {
      const m = markerOf(e);
      if (!m) return;
      e.preventDefault();
      e.stopPropagation();
      const id = m.dataset.footnoteId!;
      if (cardMode.current?.mode !== 'edit') setCard(null);
      flash(document.getElementById(`fn-${id}`));
    };
    root.addEventListener('mouseover', over);
    root.addEventListener('mouseout', out);
    root.addEventListener('click', click, true);
    return () => {
      root.removeEventListener('mouseover', over);
      root.removeEventListener('mouseout', out);
      root.removeEventListener('click', click, true);
    };
  }, [editor]);

  // Keep the card next to its marker.
  const current = card ? list.find((f) => f.id === card.id) : undefined;
  useLayoutEffect(() => {
    if (!card) return;
    const place = () => {
      const el = editor.view.dom.querySelector(`[data-footnote-id="${CSS.escape(card.id)}"]`);
      setAnchor(el ? el.getBoundingClientRect() : null);
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [card, list, editor]);

  // Close the edit card on an outside click.
  useEffect(() => {
    if (card?.mode !== 'edit') return;
    const down = (e: MouseEvent) => { if (!cardRef.current?.contains(e.target as Node)) closeCard(); };
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  });

  // The footnote went away (deleted here or by someone else).
  useEffect(() => { if (card && !current) setCard(null); }, [card, current]);

  function closeCard() {
    const c = cardMode.current;
    const f = c && list.find((x) => x.id === c.id);
    // A footnote inserted and closed without anything in it is dropped.
    if (c?.fresh && f && isEmpty(f)) removeFootnoteById(editor, f.id);
    setCard(null);
    if (!readOnly) editor.commands.focus();
  }

  return (
    <>
      {card && current && anchor && (
        <div
          ref={cardRef}
          className={`fn-card ${card.mode === 'edit' ? 'fn-card-edit' : ''}`}
          style={{ top: anchor.bottom + 6, left: Math.max(8, Math.min(anchor.left - 16, window.innerWidth - 348)) }}
          onMouseEnter={() => window.clearTimeout(hideTimer.current)}
          onMouseLeave={() => { if (card.mode === 'preview') setCard(null); }}
        >
          <div className="fn-card-head">
            <b>{current.n}</b>
            <span className="muted">Footnote</span>
          </div>
          {card.mode === 'edit'
            ? <FootnoteForm editor={editor} f={current} onDone={closeCard} autoFocus />
            : (
              <>
                <div className="fn-card-body"><FootnoteBody f={current} /></div>
                <div className="fn-card-actions">
                  <button type="button" className="link" onClick={() => { setCard(null); flash(document.getElementById(`fn-${current.id}`)); }}>Go to note <Icon name="arrow-down" /></button>
                  {!readOnly && <button type="button" className="link" onClick={() => setCard({ id: current.id, mode: 'edit' })}>Edit</button>}
                </div>
              </>
            )}
        </div>
      )}

      {list.length > 0 && (
        <section className="footnotes" aria-label="Footnotes">
          <h3>Footnotes</h3>
          <ol>
            {list.map((f) => (
              <li key={f.id} id={`fn-${f.id}`} value={f.n}>
                <button type="button" className="fn-back" title="Back to the text" aria-label={`Back to footnote ${f.n} in the text`}
                  onClick={() => goToMarker(editor, f.id)}><Icon name="corner-up-left" /></button>
                {editingInList === f.id && !readOnly
                  ? <FootnoteForm editor={editor} f={f} onDone={() => setEditingInList(null)} autoFocus />
                  : (
                    <span className="fn-item">
                      <FootnoteBody f={f} />
                      {!readOnly && <button type="button" className="link fn-edit" onClick={() => setEditingInList(f.id)}>Edit</button>}
                    </span>
                  )}
              </li>
            ))}
          </ol>
        </section>
      )}
    </>
  );
}
