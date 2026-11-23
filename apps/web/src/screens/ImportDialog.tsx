// Import Markdown files, a folder (an Obsidian vault) or a .zip of either, and export everything.
import { useState } from 'react';
import { strFromU8, unzipSync } from 'fflate';
import { api } from '../api';
import { Link } from '../router';
import { saveBlob } from '../PageMenu';
import { reloadWorkspace } from '../workspace';
import { Icon } from '../design/Icon';

type File2 = { path: string; content: string };
type Report = { pages: { id: string; title: string; path: string }[]; skipped: string[]; unresolved: string[] };

const isNote = (p: string) => /\.(md|markdown|txt)$/i.test(p) && !p.split('/').some((s) => s.startsWith('.') || s === '__MACOSX');

async function readAll(list: FileList): Promise<{ files: File2[]; skipped: number }> {
  const files: File2[] = [];
  let skipped = 0;
  for (const f of Array.from(list)) {
    const path = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    if (/\.zip$/i.test(f.name)) {
      const entries = unzipSync(new Uint8Array(await f.arrayBuffer()), { filter: (e) => isNote(e.name) });
      for (const [name, data] of Object.entries(entries)) files.push({ path: name, content: strFromU8(data) });
    } else if (isNote(path)) {
      files.push({ path, content: await f.text() });
    } else {
      skipped++;
    }
  }
  return { files, skipped };
}

export function ImportDialog({ onClose }: { onClose: () => void }) {
  const [into, setInto] = useState('Imported');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [other, setOther] = useState(0);

  const pick = async (list: FileList | null) => {
    if (!list?.length) return;
    setError(null); setReport(null);
    try {
      setBusy('Reading files…');
      const { files, skipped } = await readAll(list);
      setOther(skipped);
      if (!files.length) throw new Error('No Markdown (.md) files found there.');
      setBusy(`Importing ${files.length} page${files.length === 1 ? '' : 's'}…`);
      const r = await api<Report>('/import', { body: { files, into: into.trim() || undefined } });
      setReport(r);
      await reloadWorkspace();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const exportAll = async () => {
    setError(null); setBusy('Preparing your export…');
    try {
      const res = await fetch('/api/export', { credentials: 'same-origin' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Export failed');
      saveBlob(await res.blob(), `livepage-${new Date().toISOString().slice(0, 10)}.zip`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal import-dialog" role="dialog" aria-label="Import and export" onClick={(e) => e.stopPropagation()}>
        <div className="home-head">
          <h2>Import and export</h2>
          <button type="button" className="ghost icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>

        <h3>Import</h3>
        <p className="muted small">
          Markdown files, a folder such as an Obsidian vault, or a .zip of either. Folders become folders, frontmatter and #tags become tags,
          [[links]] between the files become page links, and [^1] footnotes become footnotes.
        </p>
        <label className="field">
          <span className="small">Put them in the folder</span>
          <input value={into} onChange={(e) => setInto(e.target.value)} placeholder="Top level" />
        </label>
        <div className="row import-picks">
          <label className="button-link">
            Choose files…
            <input type="file" multiple accept=".md,.markdown,.txt,.zip" hidden onChange={(e) => { void pick(e.target.files); e.target.value = ''; }} />
          </label>
          <label className="button-link">
            Choose a folder or vault…
            <input type="file" hidden {...({ webkitdirectory: '', directory: '' } as object)} onChange={(e) => { void pick(e.target.files); e.target.value = ''; }} />
          </label>
        </div>
        {busy && <p className="muted small">{busy}</p>}
        {error && <p className="form-error small">{error}</p>}
        {report && (
          <div className="import-report">
            <p><b>Imported {report.pages.length} page{report.pages.length === 1 ? '' : 's'}.</b>
              {(report.skipped.length + other) > 0 && <span className="muted small"> Skipped {report.skipped.length + other} other file{report.skipped.length + other === 1 ? '' : 's'} (images, settings).</span>}
            </p>
            {report.unresolved.length > 0 && <p className="muted small">Links to notes that were not in the import stay as plain text: {report.unresolved.slice(0, 8).join(', ')}{report.unresolved.length > 8 ? '…' : ''}</p>}
            <ul className="import-list">
              {report.pages.slice(0, 12).map((p) => (
                <li key={p.id} onClick={onClose}><Link to={`/p/${p.id}`}>{p.title || 'Untitled'}</Link> <span className="muted small">{p.path}</span></li>
              ))}
              {report.pages.length > 12 && <li className="muted small">…and {report.pages.length - 12} more in the sidebar</li>}
            </ul>
          </div>
        )}

        <h3>Export</h3>
        <p className="muted small">Every page you can open, as Markdown files in your folders (a .zip you can open as an Obsidian vault). To export one page as Markdown or PDF, use ⋯ on the page.</p>
        <button type="button" onClick={exportAll} disabled={!!busy}>⤓ Export everything (.zip)</button>
      </div>
    </div>
  );
}
