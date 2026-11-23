import { useEffect, useState } from 'react';
import { api } from '../api';
import { navigate, Link } from '../router';

// Opening /s/<token> adds you to the page with the link's role, then opens it.
export function ShareScreen({ token }: { token: string }) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ pageId: string }>(`/share/${token}`, { body: {} })
      .then((r) => navigate(`/p/${r.pageId}`, true))
      .catch((e) => setError(e.message));
  }, [token]);
  return (
    <div className="center">
      {error ? <p>{error} <Link to="/">Go to your pages</Link></p> : <p className="muted">Opening the shared page…</p>}
    </div>
  );
}
