import { useEffect, useState } from 'react';
import { api, type Me, type PageSummary } from '../api';
import { collabUrl } from '../config';
import { Link, navigate } from '../router';

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
        <Mentions />
        <AgentTokens />
      </main>
    </div>
  );
}

type Mention = { id: string; page_id: string; page_title: string; thread_id: string; author_name: string; author_kind: string; text: string; quote: string | null; created_at: string };

// Comments where someone @mentioned you. Replying in the thread (or Dismiss) clears them.
function Mentions() {
  const [list, setList] = useState<Mention[]>([]);
  const load = () => api<{ mentions: Mention[] }>('/mentions').then((r) => setList(r.mentions)).catch(() => {});
  useEffect(() => { void load(); }, []);
  if (!list.length) return null;
  const dismiss = async (id: string) => { await api(`/mentions/${id}/done`, { method: 'POST' }); void load(); };
  return (
    <section className="mentions-inbox">
      <h2>Mentions</h2>
      <ul className="page-list">
        {list.map((m) => (
          <li key={m.id}>
            <Link to={`/p/${m.page_id}?comment=${m.thread_id}`}>
              <b>{m.author_name}</b>{m.author_kind === 'agent' ? ' ✦' : ''} <span className="muted">on {m.page_title}</span>
              <div className="small">{m.text}</div>
              {m.quote && <div className="muted small">“{m.quote}”</div>}
            </Link>
            <button type="button" className="ghost" onClick={() => dismiss(m.id)}>Dismiss</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

type Token = { id: string; name: string; created_at: string; last_used_at: string | null; webhook_url: string | null };

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
  const [secret, setSecret] = useState<{ name: string; secret: string } | null>(null);
  // Optional: Livepage POSTs to this URL whenever someone @mentions the agent in a comment.
  const webhook = async (t: Token) => {
    const url = prompt(`Webhook URL for "${t.name}". Livepage POSTs here when someone @mentions this agent in a comment. Leave empty to turn it off.`, t.webhook_url ?? 'https://');
    if (url === null) return;
    try {
      const r = await api<{ webhook_url: string | null; webhook_secret?: string }>(`/tokens/${t.id}`, { method: 'PATCH', body: { webhook_url: url.trim() === 'https://' ? '' : url.trim() } });
      setSecret(r.webhook_secret ? { name: t.name, secret: r.webhook_secret } : null);
    } catch (e) { alert((e as Error).message); }
    void load();
  };

  return (
    <section className="tokens">
      <div className="home-head">
        <h2>Agents</h2>
        <button type="button" onClick={create}>+ Agent token</button>
      </div>
      <p className="muted small">An agent token lets an AI join your pages with your access, with its own name and cursor. People can @mention it in comments.</p>
      {fresh && (
        <div className="token-fresh">
          <p><b>Copy this token now.</b> It won't be shown again.</p>
          <code className="copy">{fresh}</code>
          <p className="small">Connect Claude Code (or any MCP client) from a clone of the repo:</p>
          <code className="copy">{`claude mcp add livepage -e LIVEPAGE_URL=${collabUrl()} -e AGENT_TOKEN=${fresh} -- pnpm --dir /path/to/livepage agent:mcp`}</code>
          <button type="button" className="link" onClick={() => setFresh(null)}>Done</button>
        </div>
      )}
      {secret && (
        <div className="token-fresh">
          <p><b>Webhook for {secret.name} is on.</b> Each call is signed: check <code>x-livepage-signature</code> = <code>sha256=HMAC(secret, timestamp + "." + body)</code> with this secret.</p>
          <code className="copy">{secret.secret}</code>
          <button type="button" className="link" onClick={() => setSecret(null)}>Done</button>
        </div>
      )}
      <ul className="token-list">
        {tokens.map((t) => (
          <li key={t.id}>
            <span>{t.name}</span>
            <span className="muted small">{t.last_used_at ? `last used ${new Date(t.last_used_at).toLocaleString()}` : 'never used'}</span>
            <button type="button" className="ghost" title={t.webhook_url ?? 'Get a webhook call when this agent is @mentioned'} onClick={() => webhook(t)}>
              {t.webhook_url ? 'Webhook on' : 'Add webhook'}
            </button>
            <button type="button" className="ghost" onClick={() => revoke(t.id)}>Revoke</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
