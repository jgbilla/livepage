import { useState } from 'react';
import { Link } from '../router';
import { SidebarToggle } from '../Sidebar';
import { matchesTags, titleOf, useWorkspace, type View } from '../workspace';
import { ViewDialog } from './ViewDialog';

// The pages for one tag (/tag/:tag) or for a saved view (/view/:id).
export function ListScreen({ tag, viewId }: { tag?: string; viewId?: string }) {
  const ws = useWorkspace();
  const [editing, setEditing] = useState<View | null>(null);
  const view = viewId ? ws?.views.find((v) => v.id === viewId) : undefined;
  const want = view ? view.tags : tag ? [tag] : [];
  const match = view?.match ?? 'any';
  const pages = (ws?.pages ?? []).filter((p) => matchesTags(p.tags, want, match))
    .sort((a, b) => +new Date(b.updated_at) - +new Date(a.updated_at));

  return (
    <div className="shell">
      <header className="topbar"><SidebarToggle /><span className="spacer" /></header>
      <main className="home">
        {!ws ? <p className="muted">Loading…</p> : viewId && !view ? <p>This view no longer exists. <Link to="/">Home</Link></p> : (
          <>
            <div className="home-head">
              <h1>{view ? view.name : `#${tag}`}</h1>
              {view && <button type="button" onClick={() => setEditing(view)}>Edit view</button>}
            </div>
            {view && (
              <p className="muted small">
                Pages with {view.match === 'all' ? 'all' : 'any'} of {view.tags.map((t) => <span key={t} className="chip chip-static">#{t}</span>)}
              </p>
            )}
            {!pages.length ? <p className="muted">No pages have {want.length > 1 ? 'these tags' : 'this tag'} yet.</p> : (
              <ul className="page-list">
                {pages.map((p) => (
                  <li key={p.id}>
                    <Link to={`/p/${p.id}`} className="page-row">
                      <span className="page-title">{titleOf(p) || 'Untitled'}</span>
                      <span className="muted small">
                        {p.path && <>{p.path} · </>}{p.tags.map((t) => `#${t}`).join(' ')} · {new Date(p.updated_at).toLocaleDateString()}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </main>
      {editing && ws && <ViewDialog view={editing} tags={ws.tags} onClose={() => setEditing(null)} />}
    </div>
  );
}
