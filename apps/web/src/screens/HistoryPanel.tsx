// Version history drawer: every saved version of the page, who changed it (a person or an agent),
// what changed, and a button to bring the page back to that version.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, colorFor } from '../api';

type Author = { id: string; name: string; kind: 'human' | 'agent' };
type Version = {
  id: string; created_at: string; reason: 'baseline' | 'edit' | 'restore' | 'before-restore';
  authors: Author[]; summary: { added?: number; removed?: number; changed?: number; title?: boolean; words?: number };
  restored_from: string | null;
};
type Block = { id: string; tab: string; type: string; text: string; attrs: Record<string, unknown> };
type Word = { value: string; added?: boolean; removed?: boolean };
type Change =
  | { op: 'same' | 'added' | 'removed'; block: Block }
  | { op: 'changed'; block: Block; before: Block; words: Word[] };
type Diff = {
  title: { before: string; after: string } | null;
  tabs: { id: string; title: string; changes: Change[] }[];
  counts: { added: number; removed: number; changed: number };
};

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
function dayLabel(d: Date) {
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return dayFmt.format(d);
}

function AuthorChip({ a }: { a: Author }) {
  return (
    <span className={`vh-author vh-${a.kind}`} style={{ '--c': colorFor(a.id) } as React.CSSProperties}
      title={a.kind === 'agent' ? `${a.name} (agent)` : a.name}>
      {a.kind === 'agent' ? '✦' : '●'} {a.name}
    </span>
  );
}

function summaryText(v: Version) {
  const s = v.summary ?? {};
  const parts = [
    s.added ? `${s.added} added` : '',
    s.changed ? `${s.changed} edited` : '',
    s.removed ? `${s.removed} removed` : '',
    s.title ? 'title changed' : '',
  ].filter(Boolean);
  return parts.join(' · ') || 'no visible change';
}

function reasonText(v: Version, byId: Map<string, Version>) {
  if (v.reason === 'baseline') return 'Earliest saved version';
  if (v.reason === 'before-restore') return 'Saved before a restore';
  if (v.reason === 'restore') {
    const from = v.restored_from ? byId.get(v.restored_from) : null;
    return from ? `Restored the version from ${timeFmt.format(new Date(from.created_at))}` : 'Restored an earlier version';
  }
  return null;
}

function BlockBody({ b, words }: { b: Block; words?: Word[] }) {
  const content = words
    ? words.map((w, i) => <span key={i} className={w.added ? 'vh-ins' : w.removed ? 'vh-del' : undefined}>{w.value}</span>)
    : b.text;
  if (b.type === 'heading') {
    const level = Math.min(Math.max(Number(b.attrs.level) || 2, 1), 3);
    return <div className={`vh-h vh-h${level}`}>{content || <em className="muted">Empty heading</em>}</div>;
  }
  if (b.type === 'htmlBlock' || b.type === 'mindMap' || b.type === 'table' || b.type === 'codeBlock') {
    const label = b.type === 'htmlBlock' ? `HTML block${b.attrs.title ? `: ${b.attrs.title}` : ''}`
      : b.type === 'mindMap' ? `Mind map${b.attrs.title ? `: ${b.attrs.title}` : ''}` : b.type === 'table' ? 'Table' : 'Code';
    return (
      <div className="vh-rich">
        <div className="vh-rich-label">{label}</div>
        <pre>{content}</pre>
      </div>
    );
  }
  if (b.type === 'horizontalRule') return <hr />;
  return <div className="vh-p">{content || <span className="muted">Empty line</span>}</div>;
}

type Mode = 'previous' | 'current';
const LABELS: Record<Mode, Record<'added' | 'removed' | 'changed', string>> = {
  previous: { added: 'Added', removed: 'Removed', changed: 'Edited' },
  current: { added: 'Comes back', removed: 'Goes away', changed: 'Changes' },
};

function DiffView({ diff, mode }: { diff: Diff; mode: Mode }) {
  const multiTab = diff.tabs.length > 1;
  const nothing = !diff.title && diff.counts.added + diff.counts.removed + diff.counts.changed === 0;
  return (
    <div className="vh-diff">
      {diff.title && (
        <div className="vh-block vh-changed">
          <div className="vh-op">Title</div>
          <div className="vh-h vh-h1"><span className="vh-del">{diff.title.before || 'Untitled'}</span> <span className="vh-ins">{diff.title.after || 'Untitled'}</span></div>
        </div>
      )}
      {nothing && <p className="muted">No visible changes.</p>}
      {diff.tabs.map((t) => (
        <section key={t.id}>
          {multiTab && <h4 className="vh-tab">{t.title}</h4>}
          <Changes changes={t.changes} mode={mode} />
        </section>
      ))}
    </div>
  );
}

/** Changed blocks in full; long runs of unchanged blocks fold into one "unchanged" line. */
function Changes({ changes, mode }: { changes: Change[]; mode: Mode }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const out: React.ReactNode[] = [];
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    if (c.op === 'same') {
      let j = i;
      while (j < changes.length && changes[j].op === 'same') j++;
      const run = changes.slice(i, j);
      const start = i;
      if (run.length > 2 && !open.has(start)) {
        out.push(
          <button key={`f${i}`} type="button" className="vh-fold" onClick={() => setOpen(new Set(open).add(start))}>
            {run.length} unchanged blocks
          </button>,
        );
      } else {
        run.forEach((r, k) => out.push(<div key={`s${i + k}`} className="vh-block vh-same"><BlockBody b={r.block} /></div>));
      }
      i = j - 1;
      continue;
    }
    out.push(
      <div key={i} className={`vh-block vh-${c.op}`}>
        <div className="vh-op">{LABELS[mode][c.op]}</div>
        <BlockBody b={c.block} words={c.op === 'changed' ? c.words : undefined} />
      </div>,
    );
  }
  return <>{out}</>;
}

export function HistoryPanel({ pageId, canRestore, onClose }: { pageId: string; canRestore: boolean; onClose: () => void }) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [compare, setCompare] = useState<Mode>('previous');
  const [diff, setDiff] = useState<Diff | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ versions: Version[] }>(`/pages/${pageId}/versions`);
      setVersions(r.versions);
      setSelected((s) => s ?? r.versions[0]?.id ?? null);
    } catch (e) { setError((e as Error).message); }
  }, [pageId]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!selected) return;
    let live = true;
    setLoadingDiff(true);
    setConfirming(false);
    api<{ diff: Diff }>(`/pages/${pageId}/versions/${selected}?compare=${compare}`)
      .then((r) => live && setDiff(r.diff))
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoadingDiff(false));
    return () => { live = false; };
  }, [pageId, selected, compare]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const byId = useMemo(() => new Map((versions ?? []).map((v) => [v.id, v])), [versions]);
  const groups = useMemo(() => {
    const g: { day: string; items: Version[] }[] = [];
    (versions ?? []).forEach((v) => {
      const day = dayLabel(new Date(v.created_at));
      if (g.at(-1)?.day !== day) g.push({ day, items: [] });
      g.at(-1)!.items.push(v);
    });
    return g;
  }, [versions]);
  const current = selected ? byId.get(selected) : undefined;
  const isLatest = !!versions?.length && versions[0].id === selected;

  const restore = async () => {
    if (!current) return;
    setRestoring(true);
    try {
      await api(`/pages/${pageId}/versions/${current.id}/restore`, { method: 'POST' });
      setNotice(`Page restored to the version from ${timeFmt.format(new Date(current.created_at))}. The restore is saved in history too, so you can undo it.`);
      setSelected(null);
      setCompare('previous');
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setRestoring(false); setConfirming(false); }
  };

  return (
    <div className="vh-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="vh" role="dialog" aria-label="Version history">
        <header className="vh-head">
          <h2>Version history</h2>
          <span className="spacer" />
          <button type="button" className="ghost" onClick={() => void load()} title="Refresh">Refresh</button>
          <button type="button" className="ghost" onClick={onClose} aria-label="Close">✕</button>
        </header>
        {error && <p className="form-error vh-pad">{error}</p>}
        {notice && <p className="vh-notice vh-pad">{notice}</p>}
        <div className="vh-body">
          <ol className="vh-list">
            {versions === null && <li className="muted vh-pad">Loading…</li>}
            {versions?.length === 0 && (
              <li className="muted vh-pad">No versions yet. A version is saved a few minutes after each round of edits, and whenever an agent starts or stops editing.</li>
            )}
            {groups.map((g) => (
              <li key={g.day}>
                <div className="vh-day">{g.day}</div>
                <ol>
                  {g.items.map((v, i) => {
                    const note = reasonText(v, byId);
                    return (
                      <li key={v.id}>
                        <button type="button" className={`vh-item ${v.id === selected ? 'vh-sel' : ''}`} onClick={() => { setSelected(v.id); setNotice(null); }}>
                          <span className="vh-time">
                            {timeFmt.format(new Date(v.created_at))}
                            {g === groups[0] && i === 0 && <span className="vh-tag">Latest</span>}
                          </span>
                          <span className="vh-authors">
                            {v.authors.length ? v.authors.map((a) => <AuthorChip key={`${a.kind}${a.id}${a.name}`} a={a} />) : <span className="muted small">—</span>}
                          </span>
                          {note && <span className="vh-note">{note}</span>}
                          <span className="vh-sum">{summaryText(v)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </li>
            ))}
          </ol>
          <section className="vh-main">
            {current && (
              <>
                <div className="vh-main-head">
                  <div className="vh-seg" role="tablist">
                    <button type="button" role="tab" aria-selected={compare === 'previous'} className={compare === 'previous' ? 'on' : ''} onClick={() => setCompare('previous')}>
                      Changes in this version
                    </button>
                    <button type="button" role="tab" aria-selected={compare === 'current'} className={compare === 'current' ? 'on' : ''} onClick={() => setCompare('current')}>
                      Compare with the page now
                    </button>
                  </div>
                  <span className="spacer" />
                  {canRestore && !isLatest && (confirming ? (
                    <span className="vh-confirm">
                      <span className="small">Replace the page with this version?</span>
                      <button type="button" className="primary" disabled={restoring} onClick={() => void restore()}>{restoring ? 'Restoring…' : 'Restore'}</button>
                      <button type="button" className="ghost" onClick={() => setConfirming(false)}>Cancel</button>
                    </span>
                  ) : (
                    <button type="button" className="primary" onClick={() => setConfirming(true)}>Restore this version</button>
                  ))}
                </div>
                <p className="muted small vh-explain">
                  {compare === 'previous'
                    ? 'What changed between the version before this one and this one.'
                    : 'What restoring would do: red is on the page now and would go, green would come back.'}
                </p>
                {loadingDiff && !diff ? <p className="muted">Loading…</p> : diff && <DiffView diff={diff} mode={compare} />}
              </>
            )}
          </section>
        </div>
      </aside>
    </div>
  );
}
