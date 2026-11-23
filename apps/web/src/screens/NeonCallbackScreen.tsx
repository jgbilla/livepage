import { useEffect, useState } from 'react';
import { finishNeonSignIn } from '../neonAuth';
import { Link, navigate } from '../router';

const safeNext = (raw: string | null) => (raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/');

export function NeonCallbackScreen({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const next = safeNext(new URLSearchParams(location.search).get('next'));
    finishNeonSignIn()
      .then(onSignedIn)
      .then(() => navigate(next, true))
      .catch((e) => setError(e.message));
  }, [onSignedIn]);
  return (
    <div className="center">
      {error ? <p>{error} <Link to="/login">Back to sign in</Link></p> : <p className="muted">Signing you in…</p>}
    </div>
  );
}
