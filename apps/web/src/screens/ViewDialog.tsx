import { useState } from 'react';
import { cleanTag, saveView, type TagCount, type View } from '../workspace';

// Create or edit a saved view: a name, some tags, and whether pages need any or all of them.
export function ViewDialog({ view, tags, onClose }: { view: View | null; tags: TagCount[]; onClose: (saved?: View) => void }) {
  const [name, setName] = useState(view?.name ?? '');
  const [picked, setPicked] = useState<string[]>(view?.tags ?? []);
  const [match, setMatch] = useState<'any' | 'all'>(view?.match ?? 'any');
  const [extra, setExtra] = useState('');
  const [error, setError] = useState<string | null>(null);

  const toggle = (t: string) => setPicked((p) => (p.includes(t) ? p.filter((x) => x !== t) : [...p, t]));
  const addExtra = () => {
    const t = cleanTag(extra);
    if (t && !picked.includes(t)) setPicked([...picked, t]);
    setExtra('');
  };
  const all = [...new Set([...tags.map((t) => t.tag), ...picked])].sort();

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try { onClose(await saveView({ id: view?.id, name: name.trim() || picked.join(' + '), tags: picked, match })); }
    catch (err) { setError((err as Error).message); }
  };

  return (
    <div className="modal-backdrop" onClick={() => onClose()}>
      <form className="modal view-dialog" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>{view ? 'Edit view' : 'New view'}</h2>
        <p className="muted small">A view lists every page you can open that has the tags you pick. It shows in your sidebar.</p>
        <label className="field">Name
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="For example: Writing" />
        </label>
        <h3>Tags</h3>
        <div className="tag-picker">
          {all.map((t) => (
            <button type="button" key={t} className={`chip ${picked.includes(t) ? 'chip-on' : ''}`} onClick={() => toggle(t)}>#{t}</button>
          ))}
          <input className="chip-input" value={extra} placeholder="+ another tag" onChange={(e) => setExtra(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addExtra(); } }} onBlur={addExtra} />
        </div>
        <h3>Show pages with</h3>
        <div className="row match-row">
          <label><input type="radio" checked={match === 'any'} onChange={() => setMatch('any')} /> any of these tags</label>
          <label><input type="radio" checked={match === 'all'} onChange={() => setMatch('all')} /> all of these tags</label>
        </div>
        {error && <p className="form-error">{error}</p>}
        <div className="row modal-buttons">
          <span className="spacer" />
          <button type="button" className="ghost" onClick={() => onClose()}>Cancel</button>
          <button type="submit" className="primary" disabled={!picked.length}>Save view</button>
        </div>
      </form>
    </div>
  );
}
