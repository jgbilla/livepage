// Comment threads beside the page: anchored to text, a block, or the whole page, with replies,
// resolve, and @mentions of people and agents. Mentioned agents get the comment through
// get_mentions (MCP), GET /api/mentions, or their webhook, and answer in the thread.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { MENTION_RE, mentionToken, parseMentions, type CommentAnchor, type MentionTarget } from '@livepage/schema';
import { api, colorFor, type Me, type Role } from '../api';
import { resolveAnchor, type CommentStore } from '../editor/comments';

type Comment = {
  id: string; thread_id: string; body: string; author_id: string; author_name: string; author_kind: 'human' | 'agent';
  created_at: string; edited_at: string | null;
};
type Thread = Comment & { tab: string; anchor: CommentAnchor | null; resolved_at: string | null; resolved_by: string | null; replies: Comment[] };
type Mentionable = MentionTarget & { detail: string };

type Props = {
  pageId: string; tab: string; tabTitle: (id: string) => string; onSelectTab: (id: string) => void;
  provider: HocuspocusProvider; me: Me; role: Role; editor: Editor | null; store: CommentStore;
  pending: CommentAnchor | null; setPending: (a: CommentAnchor | null) => void;
  open: boolean; setOpen: (o: boolean) => void; onCount: (n: number) => void;
};

export function CommentsPanel(p: Props) {
  const { pageId, tab, provider, me, role, editor, store, pending, setPending, open, setOpen, onCount } = p;
  const [threads, setThreads] = useState<Thread[]>([]);
  const [people, setPeople] = useState<Mentionable[]>([]);
  const [filter, setFilter] = useState<'open' | 'resolved'>('open');
  const [active, setActive] = useState<string | null>(() => new URLSearchParams(location.search).get('comment'));
  const [error, setError] = useState<string | null>(null);
  const [, rerender] = useState(0);
  const canComment = role !== 'viewer';
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ threads: Thread[] }>(`/pages/${pageId}/comments`);
      setThreads(r.threads);
    } catch (e) { setError((e as Error).message); }
  }, [pageId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { api<{ mentionables: Mentionable[] }>(`/pages/${pageId}/mentionables`).then((r) => setPeople(r.mentionables)).catch(() => {}); }, [pageId]);

  // The server pings every open browser when comments change.
  useEffect(() => {
    const onStateless = ({ payload }: { payload: string }) => {
      try { if (JSON.parse(payload).type === 'comments') void load(); } catch { /* not ours */ }
    };
    const onSynced = () => void load();
    provider.on('stateless', onStateless);
    provider.on('synced', onSynced);
    return () => { provider.off('stateless', onStateless); provider.off('synced', onSynced); };
  }, [provider, load]);

  // Highlights in the editor follow the threads of this tab.
  useEffect(() => {
    store.set(threads.filter((t) => t.tab === tab).map((t) => ({ id: t.id, anchor: t.anchor, resolved: !!t.resolved_at })));
    onCount(threads.filter((t) => !t.resolved_at).length);
  }, [threads, tab, store, onCount]);
  useEffect(() => { store.activate(active); }, [active, store]);

  // Re-sort when the document changes (anchors move).
  useEffect(() => {
    if (!editor) return;
    let t: ReturnType<typeof setTimeout>;
    const onUpdate = () => { clearTimeout(t); t = setTimeout(() => rerender((n) => n + 1), 300); };
    editor.on('update', onUpdate);
    return () => { clearTimeout(t); editor.off('update', onUpdate); };
  }, [editor]);

  const focusThread = useCallback((id: string, fromEditor = false) => {
    setActive(id);
    setOpen(true);
    const t = threads.find((x) => x.id === id);
    if (t?.resolved_at) setFilter('resolved');
    else if (t) setFilter('open');
    if (t && t.tab !== tab) p.onSelectTab(t.tab);
    if (!fromEditor && editor && t) {
      const r = resolveAnchor(editor, t.anchor);
      if (r) {
        const top = editor.view.coordsAtPos(r.from).top + window.scrollY - 140;
        window.scrollTo({ top, behavior: 'smooth' });
      }
    }
    setTimeout(() => listRef.current?.querySelector(`[data-thread="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 50);
  }, [threads, tab, editor, setOpen, p]);

  useEffect(() => { store.onActivate = (id) => focusThread(id, true); }, [store, focusThread]);
  // Open the thread from a ?comment= link once threads load.
  const linked = useRef(new URLSearchParams(location.search).get('comment'));
  useEffect(() => {
    if (linked.current && threads.some((t) => t.id === linked.current)) { focusThread(linked.current); linked.current = null; }
  }, [threads, focusThread]);

  // Block toolbars ask for a comment through a window event.
  useEffect(() => {
    const onBlock = (e: Event) => {
      const d = (e as CustomEvent<{ blockId: string; title?: string }>).detail;
      if (!canComment || !d?.blockId) return;
      setPending({ kind: 'block', blockId: d.blockId, quote: d.title || undefined });
      setOpen(true);
    };
    window.addEventListener('livepage:comment-block', onBlock);
    return () => window.removeEventListener('livepage:comment-block', onBlock);
  }, [canComment, setPending, setOpen]);

  const position = (t: Thread) => {
    if (t.tab !== tab) return 1e9 + 1;
    if (!t.anchor || t.anchor.kind === 'page') return -1;
    const r = editor ? resolveAnchor(editor, t.anchor) : null;
    return r ? r.from : 1e9;
  };
  const shown = threads
    .filter((t) => (filter === 'open' ? !t.resolved_at : !!t.resolved_at))
    .map((t) => ({ t, pos: position(t) }))
    .sort((a, b) => a.pos - b.pos || a.t.created_at.localeCompare(b.t.created_at));
  const openCount = threads.filter((t) => !t.resolved_at).length;

  const submitNew = async (body: string) => {
    if (!pending) return;
    await api(`/pages/${pageId}/comments`, { body: { body, anchor: pending, tab } });
    setPending(null);
    setFilter('open');
    await load();
  };

  if (!open) return null;
  return (
    <aside className="comments" aria-label="Comments">
      <div className="comments-head">
        <b>Comments</b>
        <div className="seg">
          <button type="button" className={filter === 'open' ? 'on' : ''} onClick={() => setFilter('open')}>Open{openCount ? ` ${openCount}` : ''}</button>
          <button type="button" className={filter === 'resolved' ? 'on' : ''} onClick={() => setFilter('resolved')}>Resolved</button>
        </div>
        <button type="button" className="ghost" aria-label="Close comments" onClick={() => setOpen(false)}>✕</button>
      </div>
      {error && <p className="error small">{error}</p>}
      <div className="comments-list" ref={listRef}>
        {canComment && !pending && (
          <button type="button" className="comment-new" onClick={() => setPending({ kind: 'page' })}>+ Comment on the page</button>
        )}
        {pending && (
          <div className="thread thread-new">
            <AnchorLabel anchor={pending} />
            <Composer people={people} autoFocus placeholder="Add a comment. Type @ to mention someone or an agent." submitLabel="Comment"
              onSubmit={submitNew} onCancel={() => setPending(null)} />
          </div>
        )}
        {shown.length === 0 && !pending && (
          <p className="muted small comments-empty">
            {filter === 'open'
              ? canComment ? 'No open comments. Select text or a block, then press 💬 Comment. Mention an agent with @ to ask it for help.' : 'No comments yet.'
              : 'No resolved comments.'}
          </p>
        )}
        {shown.map(({ t, pos }) => (
          <ThreadCard key={t.id} thread={t} me={me} role={role} people={people} active={t.id === active}
            missing={t.tab === tab && t.anchor?.kind !== 'page' && pos === 1e9}
            otherTab={t.tab !== tab ? p.tabTitle(t.tab) : null}
            onFocus={() => focusThread(t.id)} pageId={pageId} reload={load} />
        ))}
      </div>
    </aside>
  );
}

function AnchorLabel({ anchor, missing }: { anchor: CommentAnchor | null; missing?: boolean }) {
  if (!anchor || anchor.kind === 'page') return <div className="anchor-label muted small">On the page</div>;
  if (anchor.kind === 'block') return <div className="anchor-label small">On block <b>{anchor.quote || anchor.blockId}</b>{missing && <span className="muted"> (removed)</span>}</div>;
  return <blockquote className={`anchor-quote ${missing ? 'missing' : ''}`}>{anchor.quote}{missing && <span className="muted small"> (text was deleted)</span>}</blockquote>;
}

function ThreadCard({ thread, me, role, people, active, missing, otherTab, onFocus, pageId, reload }: {
  thread: Thread; me: Me; role: Role; people: Mentionable[]; active: boolean; missing: boolean; otherTab: string | null;
  onFocus: () => void; pageId: string; reload: () => Promise<void>;
}) {
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const canComment = role !== 'viewer';
  const mine = (c: Comment) => c.author_id === me.id && c.author_kind === 'human';
  const resolve = async (resolved: boolean) => { await api(`/pages/${pageId}/comments/${thread.id}`, { method: 'PATCH', body: { resolved } }); await reload(); };
  const remove = async (c: Comment) => {
    if (!confirm(c.id === thread.id ? 'Delete this whole thread?' : 'Delete this reply?')) return;
    await api(`/pages/${pageId}/comments/${c.id}`, { method: 'DELETE' });
    await reload();
  };

  return (
    <div className={`thread ${active ? 'thread-active' : ''} ${thread.resolved_at ? 'thread-resolved' : ''}`} data-thread={thread.id}
      onClick={(e) => { if (!(e.target as HTMLElement).closest('button, textarea, a')) onFocus(); }}>
      {otherTab && <div className="muted small">In tab “{otherTab}”</div>}
      <AnchorLabel anchor={thread.anchor} missing={missing} />
      {[thread, ...thread.replies].map((c) => (
        <div key={c.id} className="comment">
          <div className="comment-meta">
            <span className="avatar" style={{ background: colorFor(c.author_id + c.author_kind) }}>{c.author_kind === 'agent' ? '✦' : c.author_name.slice(0, 1).toUpperCase()}</span>
            <b>{c.author_name}</b>{c.author_kind === 'agent' && <span className="badge">agent</span>}
            <span className="muted small" title={new Date(c.created_at).toLocaleString()}>{timeAgo(c.created_at)}{c.edited_at ? ' · edited' : ''}</span>
            <span className="spacer" />
            {mine(c) && editing !== c.id && <button type="button" className="ghost small" onClick={() => setEditing(c.id)}>Edit</button>}
            {(mine(c) || role === 'owner') && <button type="button" className="ghost small" onClick={() => remove(c)}>Delete</button>}
          </div>
          {editing === c.id ? (
            <Composer people={people} initial={c.body} submitLabel="Save" autoFocus
              onSubmit={async (body) => { await api(`/pages/${pageId}/comments/${c.id}`, { method: 'PATCH', body: { body } }); setEditing(null); await reload(); }}
              onCancel={() => setEditing(null)} />
          ) : (
            <div className="comment-body"><Body text={c.body} /></div>
          )}
        </div>
      ))}
      {thread.resolved_at && <div className="muted small">Resolved by {thread.resolved_by}</div>}
      {canComment && (
        <div className="thread-actions">
          {replying ? (
            <Composer people={people} autoFocus placeholder="Reply. Type @ to mention." submitLabel="Reply"
              onSubmit={async (body) => { await api(`/pages/${pageId}/comments/${thread.id}`, { body: { body } }); setReplying(false); await reload(); }}
              onCancel={() => setReplying(false)} />
          ) : (
            <>
              <button type="button" onClick={() => setReplying(true)}>Reply</button>
              {thread.resolved_at
                ? <button type="button" onClick={() => resolve(false)}>Reopen</button>
                : <button type="button" onClick={() => resolve(true)}>✓ Resolve</button>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** A comment body with @mentions shown as chips. */
function Body({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION_RE)) {
    parts.push(text.slice(last, m.index));
    parts.push(<span key={m.index} className={`mention mention-${m[2]}`}>@{m[1]}</span>);
    last = (m.index ?? 0) + m[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts.map((x, i) => <Fragment key={i}>{x}</Fragment>)}</>;
}

/**
 * Comment box with @mention autocomplete. People see "@Name" while typing; on submit each
 * chosen "@Name" becomes @[Name](kind:id) so the server knows exactly who was meant.
 */
function Composer({ people, initial = '', placeholder, submitLabel, autoFocus, onSubmit, onCancel }: {
  people: Mentionable[]; initial?: string; placeholder?: string; submitLabel: string; autoFocus?: boolean;
  onSubmit: (body: string) => Promise<void>; onCancel: () => void;
}) {
  const [text, setText] = useState(() => initial.replace(MENTION_RE, (_m, name) => `@${name}`));
  const [chosen, setChosen] = useState<MentionTarget[]>(() => parseMentions(initial));
  const [query, setQuery] = useState<{ q: string; at: number } | null>(null);
  const [pick, setPick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  const matches = useMemo(() => {
    if (!query) return [];
    const q = query.q.toLowerCase();
    return people.filter((m) => m.name.toLowerCase().includes(q)).slice(0, 6);
  }, [query, people]);

  const onChange = (value: string, caret: number) => {
    setText(value);
    const before = value.slice(0, caret);
    const m = before.match(/(^|\s)@([^\s@]{0,30})$/);
    setQuery(m ? { q: m[2], at: caret - m[2].length - 1 } : null);
    setPick(0);
  };

  const choose = (m: Mentionable) => {
    if (!query) return;
    const caret = ref.current?.selectionStart ?? text.length;
    const insert = `@${m.name} `;
    const next = text.slice(0, query.at) + insert + text.slice(caret);
    setText(next);
    setChosen((c) => (c.some((x) => x.kind === m.kind && x.id === m.id) ? c : [...c, { kind: m.kind, id: m.id, name: m.name }]));
    setQuery(null);
    requestAnimationFrame(() => { const pos = query.at + insert.length; ref.current?.focus(); ref.current?.setSelectionRange(pos, pos); });
  };

  const submit = async () => {
    let body = text.trim();
    if (!body || busy) return;
    // Longest names first so "@Claude Code" wins over "@Claude".
    for (const m of [...chosen].sort((a, b) => b.name.length - a.name.length)) {
      body = body.split(`@${m.name}`).join(`\u0000${chosen.indexOf(m)}\u0000`);
    }
    body = body.replace(/\u0000(\d+)\u0000/g, (_x, i) => mentionToken(chosen[Number(i)]));
    setBusy(true);
    setErr(null);
    try { await onSubmit(body); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="composer" onClick={(e) => e.stopPropagation()}>
      <textarea ref={ref} value={text} placeholder={placeholder} autoFocus={autoFocus} rows={2} maxLength={8000}
        onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
        onKeyDown={(e) => {
          if (matches.length && query) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setPick((i) => (i + 1) % matches.length); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); setPick((i) => (i - 1 + matches.length) % matches.length); return; }
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(matches[pick]); return; }
            if (e.key === 'Escape') { e.preventDefault(); setQuery(null); return; }
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); }
          if (e.key === 'Escape') onCancel();
        }} />
      {query && matches.length > 0 && (
        <ul className="mention-menu" role="listbox">
          {matches.map((m, i) => (
            <li key={`${m.kind}:${m.id}`} role="option" aria-selected={i === pick} className={i === pick ? 'on' : ''}
              onMouseDown={(e) => { e.preventDefault(); choose(m); }}>
              <span>{m.kind === 'agent' ? '✦ ' : ''}{m.name}</span><span className="muted small">{m.detail}</span>
            </li>
          ))}
        </ul>
      )}
      {query && matches.length === 0 && people.length > 0 && <div className="muted small">No one called “{query.q}” on this page.</div>}
      {err && <div className="error small">{err}</div>}
      <div className="composer-actions">
        <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
        <button type="button" className="primary" disabled={busy || !text.trim()} onClick={submit}>{submitLabel}</button>
      </div>
    </div>
  );
}

function timeAgo(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}
