// Guest identity until accounts land (SPEC.md "Accounts and permissions").
const COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#f08c00', '#0c8599', '#d6336c'];

export type Identity = { id: string; name: string; color: string };

export function getIdentity(): Identity {
  try {
    const saved = localStorage.getItem('livepage:identity');
    if (saved) return JSON.parse(saved);
  } catch {}
  const id = Math.random().toString(36).slice(2, 10);
  const me = { id, name: `Writer ${id.slice(0, 3)}`, color: COLORS[Math.floor(Math.random() * COLORS.length)] };
  try { localStorage.setItem('livepage:identity', JSON.stringify(me)); } catch {}
  return me;
}

export function saveIdentity(me: Identity) {
  try { localStorage.setItem('livepage:identity', JSON.stringify(me)); } catch {}
}
