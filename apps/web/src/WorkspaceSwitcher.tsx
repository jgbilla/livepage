// The workspace switcher at the top of the sidebar, like Slack's: this workspace's name, and a
// menu of your other Livepage workspaces (each its own copy at its own address). Picking one
// opens it where you left off there; you stay signed in to each one separately.
import { useEffect, useRef, useState } from 'react';
import { Icon } from './design/Icon';
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
import {
  acceptOffer, declineOffer, guessName, HERE, hostOf, hrefFor, initialOf, nextColor, onSwitchClick, opensNewWindow, preconnect, removeLink, saveLink,
  toOrigin, useWorkspaceLinks, type WsLink,
} from './workspaceLinks';

/** A workspace's tile: its icon (or first letter) on its color. This workspace, unnamed, is the Livepage mark. */
export function WsTile({ link, size = 22 }: { link: Pick<WsLink, 'name' | 'icon' | 'color'> | null; size?: number }) {
  if (!link) return <span className="brand-mark" aria-hidden="true" style={size !== 22 ? { width: size, height: size } : undefined} />;
  const emoji = !!link.icon && !/^[\p{L}\p{N}]/u.test(link.icon);
  return (
    <span className={`ws-tile ${emoji ? 'ws-tile-emoji' : ''}`} aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.round(size * (emoji ? 0.62 : 0.5)), background: emoji ? undefined : `var(--lp-person-${link.color || 1})` }}>
      {link.icon || initialOf(link.name)}
    </span>
  );
}

export function WorkspaceMenuButton() {
  const { self, others, all } = useWorkspaceLinks();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<WsLink | 'new' | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const name = self?.name ?? 'Livepage';

  useEffect(() => {
    if (!open) return;
    preconnect(others.map((o) => o.url));
    const close = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    addEventListener('pointerdown', close);
    addEventListener('keydown', esc, true);
    return () => { removeEventListener('pointerdown', close); removeEventListener('keydown', esc, true); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // This workspace first, then the others in the order you added them.
  const rows = [self ?? null, ...others];
  const newWindow = opensNewWindow();
  return (
    <div className="ws-switch" ref={ref}>
      <button type="button" className="ws-current" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        title={others.length ? 'Switch workspace' : 'Workspaces'}>
        <WsTile link={self} />
        <span className="ws-current-name">{name}</span>
        <Icon name="chevron-down" className="ws-current-chev" />
      </button>
      {open && (
        <div className="menu ws-menu" role="menu" aria-label="Workspaces">
          <div className="ws-menu-label">Workspaces</div>
          {rows.map((l) => {
            const here = !l || l.url === HERE;
            const url = l?.url ?? HERE;
            const label = l?.name ?? 'Livepage';
            return (
              <div key={url} className={`ws-row ${here ? 'ws-row-here' : ''}`}>
                {here ? (
                  <button type="button" role="menuitem" className="ws-row-main" aria-current="true" onClick={() => setOpen(false)}>
                    <WsTile link={l} size={28} />
                    <span className="ws-row-text"><span className="ws-row-name">{label}</span><span className="ws-row-host">{hostOf(url)}</span></span>
                    <Icon name="check" className="ws-row-check" label="This workspace" />
                  </button>
                ) : (
                  <a role="menuitem" className="ws-row-main" href={hrefFor(url)}
                    onClick={(e) => { setOpen(false); onSwitchClick(e, url); }} title={newWindow ? `Open ${label} in its own window` : `Switch to ${label}`}>
                    <WsTile link={l} size={28} />
                    <span className="ws-row-text"><span className="ws-row-name">{label}</span><span className="ws-row-host">{hostOf(url)}</span></span>
                    {newWindow && <Icon name="external" className="ws-row-check" />}
                  </a>
                )}
                <button type="button" className="sb-mini ws-row-edit" aria-label={`Edit ${label}`} title="Name, icon and color"
                  onClick={() => { setOpen(false); setDialog(l ?? { url: HERE, name: guessName(HERE), color: nextColor(), at: 0 }); }}>
                  <Icon name="pencil" />
                </button>
              </div>
            );
          })}
          <div className="menu-sep" />
          <button type="button" role="menuitem" onClick={() => { setOpen(false); setDialog('new'); }}>
            <Icon name="plus" /><span>Add a workspace</span>
            <span className="menu-hint">{all.length > 1 ? 'Another Livepage copy you use' : 'Switch between your Livepage copies, like personal and work'}</span>
          </button>
          {others.length > 0 && <p className="ws-menu-foot">Each workspace opens where you left off and keeps its own sign-in.<span className="ws-kbd-hint"> Find one by name with {isMac ? '⌘K' : 'Ctrl K'}.</span></p>}
        </div>
      )}
      {dialog && <WorkspaceDialog link={dialog === 'new' ? null : dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}

const COLORS = [1, 2, 3, 4, 5, 6, 7];

/** Add a workspace by its address, or change one's name, icon and color. */
function WorkspaceDialog({ link, onClose }: { link: WsLink | null; onClose: () => void }) {
  const { self, all } = useWorkspaceLinks();
  const adding = !link;
  const isHere = link?.url === HERE;
  const [address, setAddress] = useState('');
  const [name, setName] = useState(link?.name ?? '');
  const [nameEdited, setNameEdited] = useState(!adding);
  const [icon, setIcon] = useState(link?.icon ?? '');
  const [color, setColor] = useState(link?.color || nextColor());
  // Adding your first other workspace: name this one too, so the two are easy to tell apart.
  const nameSelf = adding && !self;
  const [selfName, setSelfName] = useState(() => guessName(HERE));
  const [error, setError] = useState<string | null>(null);

  const origin = adding ? toOrigin(address) : link.url;
  useEffect(() => { if (adding && !nameEdited) setName(origin ? guessName(origin) : ''); }, [origin, adding, nameEdited]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', esc);
    return () => removeEventListener('keydown', esc);
  }, [onClose]);

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (!origin) return setError('Enter the address of a Livepage, like work-livepage.onrender.com.');
    if (adding && origin === HERE) return setError('That is this workspace.');
    if (adding && all.some((l) => l.url === origin)) return setError('That workspace is already in your list.');
    if (nameSelf) {
      const used = new Set([color, ...all.map((l) => l.color)]);
      saveLink({ url: HERE, name: selfName.trim() || guessName(HERE), color: COLORS.find((c) => !used.has(c)) ?? (color % 7) + 1 });
    }
    saveLink({ url: origin, name: name.trim() || guessName(origin), icon, color });
    onClose();
  };
  const remove = () => {
    if (!link) return;
    if (!confirm(`Remove ${link.name} from your workspaces? Nothing in it changes; you can add it again any time.`)) return;
    removeLink(link.url);
    onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="modal ws-dialog" onSubmit={save} aria-label={adding ? 'Add a workspace' : `Edit ${link.name}`}>
        <h2>{adding ? 'Add a workspace' : isHere ? 'This workspace' : `Edit ${link.name}`}</h2>
        <p className="muted small">
          {adding
            ? 'Another copy of Livepage you use, like the one for work. You can then switch to it from here, and you stay signed in to each one.'
            : isHere ? `How ${hostOf(HERE)} shows in your switcher, here and in your other workspaces.` : hostOf(link.url)}
        </p>
        {adding && (
          <label className="field">Address
            <input autoFocus inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} value={address}
              onChange={(e) => { setAddress(e.target.value); setError(null); }} placeholder="work-livepage.onrender.com" />
          </label>
        )}
        <div className="ws-dialog-row">
          <label className="field ws-dialog-name">Name
            <input autoFocus={!adding} value={name} maxLength={40} placeholder={origin ? guessName(origin) : 'Work'}
              onChange={(e) => { setName(e.target.value); setNameEdited(true); }} />
          </label>
          <label className="field ws-dialog-icon">Icon
            <input value={icon} maxLength={8} placeholder={initialOf(name || (origin ? guessName(origin) : 'W'))} aria-describedby="ws-icon-hint"
              onChange={(e) => setIcon([...e.target.value.trim()].slice(0, 2).join(''))} />
          </label>
        </div>
        <p className="muted small ws-hint" id="ws-icon-hint">Leave the icon empty to use the first letter, or type an emoji.</p>
        <div className="ws-colors" role="radiogroup" aria-label="Color">
          {COLORS.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={`Color ${c}`}
              className={`ws-swatch ${color === c ? 'on' : ''}`} style={{ background: `var(--lp-person-${c})` }} onClick={() => setColor(c)} />
          ))}
          <span className="ws-preview"><WsTile link={{ name: name || (origin ? guessName(origin) : 'W'), icon, color }} size={32} /></span>
        </div>
        {nameSelf && (
          <label className="field">And this workspace ({hostOf(HERE)}) is called
            <input value={selfName} maxLength={40} onChange={(e) => setSelfName(e.target.value)} placeholder="Personal" />
          </label>
        )}
        {error && <p className="form-error">{error}</p>}
        <div className="row modal-buttons">
          {!adding && !isHere && <button type="button" className="danger" onClick={remove}><Icon name="trash" />Remove</button>}
          <span className="spacer" />
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={adding && !address.trim()}>{adding ? 'Add workspace' : 'Save'}</button>
        </div>
      </form>
    </div>
  );
}

/** You just came here from a workspace this one doesn't list yet: offer to add it, so you can switch back. */
export function WorkspaceOffer() {
  const { offer } = useWorkspaceLinks();
  if (!offer) return null;
  return (
    <div className="pwa-card ws-offer" role="status">
      <WsTile link={offer} size={32} />
      <div className="pwa-card-text">
        <strong>Switch back to {offer.name} from here?</strong>
        <span>Adds {hostOf(offer.url)} to this workspace's switcher.</span>
      </div>
      <button type="button" className="primary" onClick={acceptOffer}>Add</button>
      <button type="button" className="ghost pwa-card-close" aria-label="Not now" title="Not now" onClick={declineOffer}><Icon name="x" /></button>
    </div>
  );
}
