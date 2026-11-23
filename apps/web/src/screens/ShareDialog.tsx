import { useEffect, useState } from 'react';
import { api, type Role } from '../api';

type Member = { id: string; name: string; email: string; role: Role };
type ShareLink = { token: string; role: Role; created_at: string };
const ROLES: Exclude<Role, 'owner'>[] = ['editor', 'commenter', 'viewer'];
const linkFor = (token: string) => `${location.origin}/s/${token}`;

export function ShareDialog({ pageId, onClose }: { pageId: string; onClose: () => void }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [role, setRole] = useState<Exclude<Role, 'owner'>>('editor');
  const [copied, setCopied] = useState<string | null>(null);

  const load = async () => {
    const [m, l] = await Promise.all([
      api<{ members: Member[] }>(`/pages/${pageId}/members`),
      api<{ links: ShareLink[] }>(`/pages/${pageId}/share-links`),
    ]);
    setMembers(m.members);
    setLinks(l.links);
  };
  useEffect(() => { void load(); }, [pageId]);

  const copy = async (token: string) => {
    try { await navigator.clipboard.writeText(linkFor(token)); } catch {}
    setCopied(token);
  };
  const createLink = async () => {
    const { token } = await api<{ token: string }>(`/pages/${pageId}/share-links`, { body: { role } });
    await load();
    await copy(token);
  };
  const revoke = async (token: string) => { await api(`/pages/${pageId}/share-links/${token}`, { method: 'DELETE' }); void load(); };
  const changeRole = async (userId: string, next: string) => {
    const r = await api<{ members: Member[] }>(`/pages/${pageId}/members/${userId}`, { method: 'PUT', body: { role: next === 'remove' ? null : next } });
    setMembers(r.members);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="Share page" onClick={(e) => e.stopPropagation()}>
        <div className="home-head">
          <h2>Share</h2>
          <button type="button" className="ghost" onClick={onClose} aria-label="Close">×</button>
        </div>

        <h3>Invite with a link</h3>
        <p className="muted small">Anyone with the link who signs in gets this access.</p>
        <div className="row">
          <select value={role} onChange={(e) => setRole(e.target.value as typeof role)} aria-label="Access for link">
            {ROLES.map((r) => <option key={r} value={r}>{r === 'editor' ? 'Can edit' : r === 'commenter' ? 'Can comment' : 'Can view'}</option>)}
          </select>
          <button type="button" className="primary" onClick={createLink}>Create link</button>
        </div>
        <ul className="share-links">
          {links.map((l) => (
            <li key={l.token}>
              <code className="share-url">{linkFor(l.token)}</code>
              <span className="muted small">{l.role}</span>
              <button type="button" onClick={() => copy(l.token)}>{copied === l.token ? 'Copied' : 'Copy'}</button>
              <button type="button" className="ghost" onClick={() => revoke(l.token)}>Turn off</button>
            </li>
          ))}
        </ul>

        <h3>People with access</h3>
        <ul className="members">
          {members.map((m) => (
            <li key={m.id}>
              <span>{m.name} <span className="muted small">{m.email}</span></span>
              {m.role === 'owner' ? (
                <span className="muted small">owner</span>
              ) : (
                <select value={m.role} onChange={(e) => changeRole(m.id, e.target.value)} aria-label={`Access for ${m.name}`}>
                  {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  <option value="remove">Remove</option>
                </select>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
