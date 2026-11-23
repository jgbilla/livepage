import { useEffect, useState } from 'react';
import { api, type Me } from '../api';
import { collabUrl } from '../config';
import { Link } from '../router';
import { SidebarToggle } from '../Sidebar';
import { newPage, openToday, titleOf, useWorkspace } from '../workspace';

export function HomeScreen({ me }: { me: Me }) {
  const ws = useWorkspace();
  const pages = ws ? [...ws.pages].sort((a, b) => +new Date(b.updated_at) - +new Date(a.updated_at)).slice(0, 30) : null;
  useEffect(() => { document.title = 'Livepage'; }, []);

  return (
    <div className="shell">
      <header className="topbar">
        <SidebarToggle />
        <span className="spacer" />
        <span className="muted">{me.name}</span>
      </header>
      <main className="home">
        <div className="home-head">
          <h1>Recent pages</h1>
          <span className="row">
            <button type="button" onClick={() => void openToday()}>☀ Today</button>
            <button type="button" className="primary" onClick={() => void newPage(null)}>+ New page</button>
          </span>
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
                  <span className="page-title">{titleOf(p) || 'Untitled'}</span>
                  <span className="muted small">
                    {p.path && <>{p.path} · </>}
                    {p.role === 'owner' ? 'Yours' : `${p.owner_name} · ${p.role}`} · {new Date(p.updated_at).toLocaleDateString()}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
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
