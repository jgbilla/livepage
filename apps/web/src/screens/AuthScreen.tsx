import { useState } from 'react';
import { api } from '../api';
import { appConfig } from '../config';

export function AuthScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const signupOpen = appConfig().signupOpen;
  const [mode, setMode] = useState<'login' | 'signup'>(location.pathname.startsWith('/s/') && signupOpen ? 'signup' : 'login');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api(`/auth/${mode}`, { body: Object.fromEntries(f) });
      onSignedIn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <h1 className="brand-lg">Livepage</h1>
        <p className="muted">
          {location.pathname.startsWith('/s/') ? 'Someone shared a page with you. ' : ''}
          {mode === 'login' ? 'Log in to your pages.' : 'Create your account.'}
        </p>
        {mode === 'signup' && <label>Name<input name="name" autoComplete="name" required maxLength={80} /></label>}
        <label>Email<input name="email" type="email" autoComplete="email" required /></label>
        <label>Password<input name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={8} /></label>
        {error && <div className="form-error" role="alert">{error}</div>}
        <button type="submit" className="primary" disabled={busy}>{mode === 'login' ? 'Log in' : 'Sign up'}</button>
        {signupOpen && (
          <button type="button" className="link" onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(null); }}>
            {mode === 'login' ? 'No account yet? Sign up' : 'Have an account? Log in'}
          </button>
        )}
      </form>
    </div>
  );
}
