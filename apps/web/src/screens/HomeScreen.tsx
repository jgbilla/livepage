import { useEffect, useState } from 'react';
import { api, type Me, type PageSummary } from '../api';
import { collabUrl } from '../config';
import { Link, navigate } from '../router';
import { AiSettings } from './AiSettings';

export function HomeScreen({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [pages, setPages] = useState<PageSummary[] | null>(null);

  useEffect(() => { api<{ pages: PageSummary[] }>('/pages').then((r) => setPages(r.pages)); }, []);

  const newPage = async () => {
    const { page } = await api<{ page: { id: string } }>('/pages', { body: { title: '' } });
    navigate(`/p/${page.id}`);
  };

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">Livepage</span>
        <span className="spacer" />
        <span className="muted">{me.name}</span>
        <button type="button" className="ghost" onClick={onLogout}>Log out</button>
      </header>
      <main className="home">
        <div className="home-head">
          <h1>Your pages</h1>
          <button type="button" className="primary" onClick={newPage}>+ New page</button>
        </div>
        {pages === null ? (
          <p className="muted">Loading…</p>
        ) : pages.length === 0 ? (
          <p className="muted">No pages yet. Create one, then share it or invite an agent.</p>
        ) : (
          <ul className="page-list">
            {pages.map((p) => (
              <li key={p.id}>
                <Link to={`/p/${p.id}`} className="page-row">
                  <span className="page-title">{p.title || 'Untitled'}</span>
                  <span className="muted small">
                    {p.role === 'owner' ? 'Yours' : `${p.owner_name} · ${p.role}`} · {new Date(p.updated_at).toLocaleDateString()}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <section className="tokens">
          <h2>AI assistant</h2>
          <p className="muted small">The “✦ Ask AI” button on every page uses this. Bring your own key for any provider, or point it at a local model.</p>
          <AiSettings />
        </section>
        <AgentTokens />
      </main>
    </div>
  );
}

type Token = { id: string; name: string; created_at: string; last_used_at: string | null };

// Agent tokens let any AI act on your pages with your access (MCP or HTTP).
function AgentTokens() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [fresh, setFresh] = useState<string | null>(null);
  const load = () => api<{ tokens: Token[] }>('/tokens').then((r) => setTokens(r.tokens));
  useEffect(() => { void load(); }, []);

  const create = async () => {
    const name = prompt('Name this agent (for example "Claude on my laptop")', 'My agent');
    if (!name) return;
    const r = await api<{ token: string }>('/tokens', { body: { name } });
    setFresh(r.token);
    void load();
  };
  const revoke = async (id: string) => { await api(`/tokens/${id}`, { method: 'DELETE' }); void load(); };

  return (
    <section className="tokens">
      <div className="home-head">
        <h2>Agents</h2>
        <button type="button" onClick={create}>+ Agent token</button>
      </div>
      <p className="muted small">An agent token lets an AI join your pages with your access, with its own name and cursor.</p>
      {fresh && (
        <div className="token-fresh">
          <p><b>Copy this token now.</b> It won't be shown again.</p>
          <code className="copy">{fresh}</code>
          <p className="small">Connect Claude Code (or any MCP client) from a clone of the repo:</p>
          <code className="copy">{`claude mcp add livepage -e LIVEPAGE_URL=${collabUrl()} -e AGENT_TOKEN=${fresh} -- pnpm --dir /path/to/livepage agent:mcp`}</code>
          <button type="button" className="link" onClick={() => setFresh(null)}>Done</button>
        </div>
      )}
      <ul className="token-list">
        {tokens.map((t) => (
          <li key={t.id}>
            <span>{t.name}</span>
            <span className="muted small">{t.last_used_at ? `last used ${new Date(t.last_used_at).toLocaleString()}` : 'never used'}</span>
            <button type="button" className="ghost" onClick={() => revoke(t.id)}>Revoke</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
