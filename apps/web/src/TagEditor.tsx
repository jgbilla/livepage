import { useEffect, useState } from 'react';
import { Link } from './router';
import { cleanTag, setTags, useWorkspace } from './workspace';
import { Icon } from './design/Icon';

// Tags under the page title. Everyone with access sees the same tags; editors can change them.
export function TagEditor({ pageId, initial, readOnly }: { pageId: string; initial: string[]; readOnly: boolean }) {
  const ws = useWorkspace();
  const [tags, setLocal] = useState(initial);
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);
  // Pick up changes made elsewhere (an agent, another tab) when the workspace reloads.
  const fromWs = ws?.pages.find((p) => p.id === pageId)?.tags;
  useEffect(() => { if (fromWs) setLocal(fromWs); }, [fromWs?.join(',')]);

  const commit = async (next: string[]) => { setLocal(next); setLocal(await setTags(pageId, next)); };
  const add = () => {
    const t = cleanTag(draft);
    setDraft('');
    if (t && !tags.includes(t)) void commit([...tags, t]);
  };
  const suggestions = draft ? (ws?.tags ?? []).map((t) => t.tag).filter((t) => t.startsWith(cleanTag(draft)) && !tags.includes(t)).slice(0, 6) : [];

  if (readOnly && !tags.length) return null;
  return (
    <div className="tag-row">
      {tags.map((t) => (
        <span key={t} className="chip">
          <Link to={`/tag/${encodeURIComponent(t)}`}>#{t}</Link>
          {!readOnly && <button type="button" className="chip-x" aria-label={`Remove tag ${t}`} onClick={() => void commit(tags.filter((x) => x !== t))}><Icon name="x" /></button>}
        </span>
      ))}
      {!readOnly && (adding ? (
        <span className="chip-add">
          <input
            autoFocus className="chip-input" value={draft} placeholder="tag" list={`tags-${pageId}`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); }
              if (e.key === 'Escape') { setDraft(''); setAdding(false); }
              if (e.key === 'Backspace' && !draft && tags.length) void commit(tags.slice(0, -1));
            }}
            onBlur={() => { add(); setAdding(false); }}
          />
          <datalist id={`tags-${pageId}`}>{suggestions.map((s) => <option key={s} value={s} />)}</datalist>
        </span>
      ) : (
        <button type="button" className="chip-new" onClick={() => setAdding(true)}>{tags.length ? '+' : '+ Add tag'}</button>
      ))}
    </div>
  );
}
