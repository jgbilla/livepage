import { useEffect, useState } from 'react';
import { api, type Me } from '../api';
import { AiSettings } from './AiSettings';
import { Link } from '../router';
import { SidebarToggle } from '../Sidebar';
import { newPage, openToday, titleOf, useWorkspace } from '../workspace';
import { ConnectAgentDialog, ConnectSteps } from './ConnectAgent';
import { Icon } from '../design/Icon';
import { WakeDialog, type Wake } from './WakeDialog';

export function HomeScreen({ me }: { me: Me }) {
  const ws = useWorkspace();
  const pages = ws ? [...ws.pages].sort((a, b) => +new Date(b.updated_at) - +new Date(a.updated_at)).slice(0, 30) : null;

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
            <button type="button" onClick={() => void openToday()}><Icon name="today" />Today</button>
            <button type="button" className="primary" onClick={() => void newPage(null)}><Icon name="plus" />New page</button>
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
                  <span className="page-title"><Icon name={p.role === 'owner' ? 'file' : 'users'} />{titleOf(p) || 'Untitled'}</span>
                  <span className="muted small">
                    {p.path && <>{p.path} · </>}
                    {p.role === 'owner' ? 'Yours' : `${p.owner_name} · ${p.role}`} · {new Date(p.updated_at).toLocaleDateString()}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <Mentions />
        <section className="tokens">
          <h2>AI assistant</h2>
          <p className="muted small">The Ask AI button on every page uses this. Bring your own key for any provider, or point it at a local model.</p>
          <AiSettings />
        </section>
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
              <b>{m.author_name}</b>{m.author_kind === 'agent' && <> <span className="agent-tag">Agent</span></>} <span className="muted">on {m.page_title}</span>
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

type Token = { id: string; name: string; created_at: string; last_used_at: string | null; webhook_url: string | null; wake: Wake | null };

// Agent tokens let any AI act on your pages with your access (MCP or HTTP).
function AgentTokens() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [fresh, setFresh] = useState<{ token: string; name: string } | null>(null);
  const [connect, setConnect] = useState<Token | null>(null);
  const load = () => api<{ tokens: Token[] }>('/tokens').then((r) => setTokens(r.tokens));
  useEffect(() => { void load(); }, []);

  const create = async () => {
    const name = prompt('Name this agent (for example "Claude on my laptop")', 'My agent');
    if (!name) return;
    const r = await api<{ token: string }>('/tokens', { body: { name } });
    setFresh({ token: r.token, name });
    void load();
  };
  const rename = async (t: Token) => {
    const name = prompt('Name this agent. It shows on its avatar and cursor on your pages.', t.name);
    if (name === null || !name.trim() || name.trim() === t.name) return;
    try { await api(`/tokens/${t.id}`, { method: 'PATCH', body: { name: name.trim() } }); } catch (e) { alert((e as Error).message); }
    void load();
  };
  const revoke = async (id: string) => { await api(`/tokens/${id}`, { method: 'DELETE' }); void load(); };
  const [waking, setWaking] = useState<Token | null>(null);
  // A cloud agent: a new agent named Devin, then straight to setting up its wake.
  const connectDevin = async () => {
    const r = await api<{ id: string }>('/tokens', { body: { name: 'Devin' } });
    await load();
    setWaking({ id: r.id, name: 'Devin', created_at: new Date().toISOString(), last_used_at: null, webhook_url: null, wake: null });
  };
  const [secret, setSecret] = useState<{ name: string; secret: string } | null>(null);
  // Optional: Livepage POSTs to this URL whenever someone @mentions the agent in a comment.
  const webhook = async (t: Token) => {
    const url = prompt(`Webhook URL for "${t.name}". Livepage POSTs here whenever there is work for this agent: an Ask AI request, a task, or a comment that @mentions it. Leave empty to turn it off.`, t.webhook_url ?? 'https://');
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
        <span className="row home-head-actions">
          <button type="button" className="ghost" onClick={connectDevin} title="Start a Devin session whenever this agent gets work">Connect Devin</button>
          <button type="button" onClick={create}><Icon name="key" />Agent token</button>
        </span>
      </div>
      <p className="muted small">An agent token lets an AI join your pages with your access, with its own name and cursor. People can @mention it in comments.</p>
      {fresh && (
        <div className="token-fresh">
          <p><b>Copy this token now.</b> It won't be shown again.</p>
          <code className="copy">{fresh.token}</code>
          <p className="small">It's filled in below. Two steps and {fresh.name} picks up Ask AI requests, tasks and @mentions:</p>
          <ConnectSteps token={fresh.token} name={fresh.name} />
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
      {connect && <ConnectAgentDialog agent={connect} onClose={() => { setConnect(null); void load(); }} />}
      <ul className="token-list">
        {tokens.map((t) => (
          <li key={t.id}>
            <span className="token-name"><span className="avatar avatar-agent" aria-hidden="true"><Icon name="sparkles" size={12} /></span>{t.name}</span>
            <span className="muted small">{t.last_used_at ? `last used ${new Date(t.last_used_at).toLocaleString()}` : 'never used'}</span>
            <button type="button" className="ghost" title={t.webhook_url ?? 'Get a webhook call when there is work for this agent'} onClick={() => webhook(t)}>
              {t.webhook_url ? 'Webhook on' : 'Add webhook'}
            </button>
            <button type="button" className="ghost" onClick={() => setConnect(t)}>Connect</button>
            <button type="button" className="ghost" title={t.wake ? `Starts a ${t.wake.provider_label} session when it gets work` : 'Start a cloud agent session (Devin) when this agent gets work'} onClick={() => {
              if (!t.wake && !confirm(`Waking ${t.name} with Devin gives it a new token, so Devin's sessions can use it. Anything else using its current token will need the new one. Continue? (Or use Connect Devin to make a separate agent.)`)) return;
              setWaking(t);
            }}>
              {t.wake ? `Wakes ${t.wake.provider_label}` : 'Wake…'}
            </button>
            <button type="button" className="ghost" onClick={() => rename(t)}>Rename</button>
            <button type="button" className="ghost" onClick={() => revoke(t.id)}>Revoke</button>
          </li>
        ))}
      </ul>
      {waking && <WakeDialog token={waking} onClose={() => { setWaking(null); void load(); }} />}
    </section>
  );
}
