// The "⋯" menu on a page: template settings, export (Markdown, PDF) and publishing.
import { useEffect, useRef, useState } from 'react';
import { api, type Role } from './api';
import { reloadWorkspace } from './workspace';

type Props = {
  pageId: string;
  role: Role;
  title: string;
  isTemplate: boolean;
  publishedSlug: string | null;
  onChange: (patch: { isTemplate?: boolean; publishedSlug?: string | null }) => void;
};

export async function downloadMarkdown(pageId: string) {
  const res = await fetch(`/api/pages/${pageId}/export?format=md`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Export failed');
  const name = decodeURIComponent(res.headers.get('content-disposition')?.match(/filename\*=UTF-8''([^;]+)/)?.[1] ?? 'page.md');
  saveBlob(await res.blob(), name);
}

export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** PDF: the browser's own "Save as PDF", with a print stylesheet that leaves only the page. */
export function printPage(title: string) {
  const before = document.title;
  document.title = title || 'Untitled'; // browsers name the PDF after the document title
  document.body.classList.add('printing');
  const done = () => { document.title = before; document.body.classList.remove('printing'); removeEventListener('afterprint', done); };
  addEventListener('afterprint', done);
  setTimeout(() => window.print(), 50); // let HTML blocks settle their height first
}

export function PageMenu({ pageId, role, title, isTemplate, publishedSlug, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [dailyId, setDailyId] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const canEdit = role === 'owner' || role === 'editor';

  useEffect(() => {
    if (!open) return;
    api<{ daily_template_id: string | null }>('/templates').then((r) => setDailyId(r.daily_template_id)).catch(() => setDailyId(null));
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    addEventListener('mousedown', close);
    addEventListener('keydown', esc);
    return () => { removeEventListener('mousedown', close); removeEventListener('keydown', esc); };
  }, [open]);

  const run = (fn: () => Promise<unknown>) => async () => {
    setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); }
  };
  const toggleTemplate = run(async () => {
    await api(`/pages/${pageId}`, { method: 'PATCH', body: { template: !isTemplate } });
    onChange({ isTemplate: !isTemplate });
    if (isTemplate && dailyId === pageId) setDailyId(null);
    await reloadWorkspace();
  });
  const toggleDaily = run(async () => {
    const next = dailyId === pageId ? null : pageId;
    await api('/templates/daily', { method: 'PUT', body: { page_id: next } });
    setDailyId(next);
  });

  return (
    <div className="page-menu" ref={ref}>
      <button type="button" className="ghost" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} title="More">⋯</button>
      {open && (
        <div className="menu" role="menu">
          {canEdit && (
            <button type="button" role="menuitemcheckbox" aria-checked={isTemplate} onClick={toggleTemplate}>
              <span className="check">{isTemplate ? '✓' : ''}</span>Use as a template
              <span className="menu-hint">New pages can start as a copy. Use {'{{date}}'}, {'{{title}}'}, or {'{{Any field}}'} to fill in later.</span>
            </button>
          )}
          {isTemplate && (
            <button type="button" role="menuitemcheckbox" aria-checked={dailyId === pageId} onClick={toggleDaily} disabled={dailyId === undefined}>
              <span className="check">{dailyId === pageId ? '✓' : ''}</span>Use for my daily pages
              <span className="menu-hint">The ☀ Today page starts from this template.</span>
            </button>
          )}
          <div className="menu-sep" />
          <button type="button" role="menuitem" onClick={run(async () => { await downloadMarkdown(pageId); setOpen(false); })}>
            <span className="check">⤓</span>Export as Markdown
          </button>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); printPage(title); }}>
            <span className="check">⎙</span>Export as PDF
            <span className="menu-hint">Opens print; choose “Save as PDF”. Prints the open tab.</span>
          </button>
          {role === 'owner' && <>
            <div className="menu-sep" />
            <button type="button" role="menuitem" onClick={() => { setOpen(false); setPublishing(true); }}>
              <span className="check">◎</span>{publishedSlug ? 'Published to the web…' : 'Publish to the web…'}
            </button>
          </>}
          {error && <p className="form-error small">{error}</p>}
        </div>
      )}
      {publishing && <PublishDialog pageId={pageId} slug={publishedSlug} onClose={() => setPublishing(false)}
        onChange={(slug) => onChange({ publishedSlug: slug })} />}
    </div>
  );
}

function PublishDialog({ pageId, slug, onClose, onChange }: { pageId: string; slug: string | null; onClose: () => void; onChange: (slug: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = slug ? `${location.origin}/pub/${slug}` : null;
  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const publish = () => act(async () => { const r = await api<{ slug: string }>(`/pages/${pageId}/publish`, { body: {} }); onChange(r.slug); await reloadWorkspace(); });
  const unpublish = () => act(async () => { await api(`/pages/${pageId}/publish`, { method: 'DELETE' }); onChange(null); await reloadWorkspace(); });
  const copy = async () => { if (!url) return; try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* no clipboard */ } };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="Publish to the web" onClick={(e) => e.stopPropagation()}>
        <div className="home-head">
          <h2>Publish to the web</h2>
          <button type="button" className="ghost" onClick={onClose} aria-label="Close">×</button>
        </div>
        {url ? <>
          <p>This page is public. Anyone with the link can read it, without an account. It always shows the latest version, and its live HTML blocks keep running.</p>
          <div className="row publish-url">
            <code className="share-url">{url}</code>
            <button type="button" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
            <a className="button-link" href={url} target="_blank" rel="noopener">Open</a>
          </div>
          <p className="muted small">Links to your other pages work only if those pages are published too. Comments, people and edit history are never shown.</p>
          <div className="row modal-buttons">
            <span className="spacer" />
            <button type="button" className="danger" onClick={unpublish} disabled={busy}>Unpublish</button>
          </div>
        </> : <>
          <p>Turn this page into a clean, read-only web page that anyone with the link can read, without an account. Live HTML blocks keep running, safely sandboxed.</p>
          <p className="muted small">You can unpublish at any time; the link then stops working.</p>
          <div className="row modal-buttons">
            <span className="spacer" />
            <button type="button" className="ghost" onClick={onClose}>Cancel</button>
            <button type="button" className="primary" onClick={publish} disabled={busy}>Publish</button>
          </div>
        </>}
        {error && <p className="form-error small">{error}</p>}
      </div>
    </div>
  );
}
