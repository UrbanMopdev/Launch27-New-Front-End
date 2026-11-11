import { FormEvent, useEffect, useState } from 'react';
import { BrandLogo } from '../components/BrandLogo';
import { auth } from '../api';

const ENV: Record<string, { label: string; note: string }> = {
  development: { label: 'DEV', note: 'Development site: test data only, no customer messages.' },
  staging: { label: 'QA', note: 'QA site: a copy for testing, no customer messages.' },
  production: { label: 'PROD', note: 'Production: live UrbanMop data.' },
};

export function LoginPage({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Which site this is (DEV, QA or PROD), so nobody signs in to the wrong one.
  const [site, setSite] = useState<{ env: string; portal: string } | null>(null);
  useEffect(() => {
    fetch('/healthz')
      .then((r) => r.json())
      .then((j) => setSite({ env: String(j.env || ''), portal: String(j.portal || 'UrbanMop') }))
      .catch(() => setSite(null));
  }, []);
  const env = site ? ENV[site.env] || { label: site.env.toUpperCase(), note: '' } : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await auth.login(email, password);
      onLoggedIn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center">
      <form className="card login" onSubmit={submit}>
        <div className="login-head">
          <BrandLogo name={site?.portal || 'UrbanMop'} />
          {env && (
            <span className={`env-pill env-${site!.env}`} title={env.note}>
              {env.label}
            </span>
          )}
        </div>
        {env?.note && <p className={`env-note env-${site!.env}`}>{env.note}</p>}
        <h1>Sign in</h1>
        <p className="muted small">Use your Launch27 login.</p>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        {error && <div className="error">{error}</div>}
        <button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
