import { useMe } from '../hooks';

// A strip at the top of every page outside production, so nobody mistakes the dev or QA
// site for the real one. The server decides the environment; see docs/environments.md.
const LABEL: Record<string, string> = { development: 'DEVELOPMENT', staging: 'QA / STAGING' };

export function EnvBanner() {
  const me = useMe().data;
  if (!me?.env || me.env === 'production') return null;
  const notes = [me.l27Mode === 'mock' ? 'synthetic data' : 'live Launch27 data (read-only)', me.notificationsMode === 'live' ? 'notifications LIVE' : 'no customer notifications'];
  return (
    <div className={`env-banner env-${me.env}`} role="status">
      <strong>{LABEL[me.env] || me.env.toUpperCase()}</strong> · {notes.join(' · ')}
    </div>
  );
}
