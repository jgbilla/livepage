import { useEffect, useState } from 'react';
import { api } from './api';
import { Link } from './router';
import { linkHref } from './editor/PageLink';
import { Icon } from './design/Icon';

type Backlink = { page: string; title: string; from_tab: string; from_tab_title: string; to_tab: string | null };

// "Linked from": pages you can open that link to this page. Refreshes when you come back to the tab,
// since links are indexed when the linking page is saved.
export function Backlinks({ pageId, tab }: { pageId: string; tab: string }) {
  const [links, setLinks] = useState<Backlink[]>([]);
  useEffect(() => {
    let live = true;
    const load = () => api<{ backlinks: Backlink[] }>(`/pages/${pageId}/backlinks`).then((r) => live && setLinks(r.backlinks)).catch(() => {});
    void load();
    addEventListener('focus', load);
    const t = setInterval(load, 20_000);
    return () => { live = false; removeEventListener('focus', load); clearInterval(t); };
  }, [pageId]);
  // One row per linking page/tab, even when it links here more than once.
  const rows = [...new Map(links.map((b) => [`${b.page}#${b.from_tab}`, b])).values()];
  const toThisTab = (b: Backlink) => links.some((l) => l.page === b.page && l.from_tab === b.from_tab && (l.to_tab ?? 'main') === tab);
  if (!rows.length) return null;
  return (
    <section className="backlinks" aria-label="Linked from">
      <h3 className="muted small">Linked from</h3>
      <ul>
        {rows.map((b, i) => (
          <li key={i}>
            <Link to={linkHref(b.page, b.from_tab)}><Icon name="corner-up-left" />{b.title || 'Untitled'}{b.from_tab_title ? ` › ${b.from_tab_title}` : ''}</Link>
            {tab !== 'main' && toThisTab(b) && <span className="muted small"> · links to this tab</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
