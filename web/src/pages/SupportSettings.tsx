// Support settings: one place for everything that decides where conversations go and
// who answers them. Grouped by what people are trying to do, with plain-language help.
import { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { inbox, type HistoryEntry, type SettingsEditors, type SlaPolicy, type User, type WorkspaceSettings } from '../inbox/api';
import { ago, useInboxMe, useMeta } from '../inbox/util';
import { DurationInput, Switch } from '../inbox/settingsUi';
import { formatMinutes } from '../lib/routingRules';
import { RulesEditor } from './RoutingRules';
import { AgentsSettings, HoursSettings, PoliciesSettings, QaCopySettings, QueuesSettings, StatusesSettings, TeamsSettings } from './WorkforceSettings';

type Tab = 'rules' | 'queues' | 'sla' | 'hours' | 'policies' | 'agents' | 'teams' | 'statuses' | 'canned' | 'history' | 'qa';

const SECTIONS: { title: string; items: { id: Tab; label: string; desc: string }[] }[] = [
  {
    title: 'Routing',
    items: [
      { id: 'rules', label: 'Routing rules', desc: 'Where new conversations go' },
      { id: 'queues', label: 'Queues', desc: 'How each queue hands out work' },
      { id: 'sla', label: 'Reply targets', desc: 'How quickly we answer' },
      { id: 'hours', label: 'Business hours', desc: 'When reply clocks run' },
      { id: 'policies', label: 'Routing policies', desc: 'Assigning, reopening, going offline' },
    ],
  },
  {
    title: 'People',
    items: [
      { id: 'agents', label: 'Agents', desc: 'Roles and how much each person takes' },
      { id: 'teams', label: 'Teams', desc: 'Who works which queues' },
      { id: 'statuses', label: 'Agent statuses', desc: 'Available, break, lunch…' },
    ],
  },
  {
    title: 'Replies',
    items: [{ id: 'canned', label: 'Saved replies', desc: 'Shortcuts for common answers' }],
  },
  {
    title: 'Activity',
    items: [
      { id: 'history', label: 'Change history', desc: 'Who changed what, and when' },
      { id: 'qa', label: 'QA data', desc: 'Anonymized copy of real data for QA' },
    ],
  },
];
const ALL = SECTIONS.flatMap((s) => s.items);

export function canEditSettings(me: User | undefined, settings: WorkspaceSettings | undefined) {
  if (!me) return false;
  if (me.role === 'admin') return true;
  const who: SettingsEditors = settings?.settings_editors || 'everyone';
  return who === 'everyone' || (who === 'supervisors' && me.role === 'supervisor');
}

export function InboxSettingsPage() {
  const me = useInboxMe();
  const wf = useQuery({ queryKey: ['inbox', 'workforce'], queryFn: inbox.workforce });
  const [params, setParams] = useSearchParams();
  const tab = (ALL.some((t) => t.id === params.get('tab')) ? params.get('tab') : 'rules') as Tab;
  const [rulesDirty, setRulesDirty] = useState(false);
  const onDirty = useCallback((d: boolean) => setRulesDirty(d), []);
  const isAdmin = me.data?.role === 'admin';
  const canEdit = canEditSettings(me.data, wf.data?.settings);
  const editors = wf.data?.settings.settings_editors || 'everyone';
  const current = ALL.find((t) => t.id === tab)!;

  const go = (t: Tab) => {
    if (t === tab) return;
    if (rulesDirty && !window.confirm('You have unsaved changes to the routing rules. Leave without saving?')) return;
    setRulesDirty(false);
    setParams({ tab: t });
  };

  return (
    <>
      <header className="page-header">
        <div>
          <h1>Support settings</h1>
          <p className="muted small settings-who">
            {!me.data || !wf.data
              ? ' '
              : canEdit
                ? editors === 'everyone'
                  ? 'Everyone on the team can change these. Changes apply right away and are listed in Change history.'
                  : 'You can change these settings. Changes apply right away and are listed in Change history.'
                : `View only: an admin has limited changes to ${editors === 'supervisors' ? 'supervisors and admins' : 'admins'}.`}
          </p>
        </div>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Support settings">
          {SECTIONS.map((s) => (
            <div key={s.title} className="settings-nav-group">
              <div className="settings-nav-title">{s.title}</div>
              {s.items.map((t) => (
                <button key={t.id} type="button" className={t.id === tab ? 'settings-nav-item active' : 'settings-nav-item'} aria-current={t.id === tab ? 'page' : undefined} onClick={() => go(t.id)}>
                  <span className="settings-nav-label">{t.label}</span>
                  <span className="settings-nav-desc">{t.desc}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="settings-body">
          <div className="settings-body-head">
            <h2>{current.label}</h2>
            <span className="muted small">{current.desc}</span>
          </div>
          {tab === 'rules' && <RulesEditor canEdit={canEdit} onDirtyChange={onDirty} />}
          {tab === 'queues' && <QueuesSettings canEdit={canEdit} isAdmin={isAdmin} />}
          {tab === 'sla' && <SlaEditor canEdit={canEdit} />}
          {tab === 'hours' && <HoursSettings canEdit={canEdit} />}
          {tab === 'policies' && <PoliciesSettings canEdit={canEdit} isAdmin={isAdmin} />}
          {tab === 'agents' && <AgentsSettings canEdit={canEdit} isAdmin={isAdmin} />}
          {tab === 'teams' && <TeamsSettings canEdit={isAdmin} />}
          {tab === 'statuses' && <StatusesSettings canEdit={canEdit} />}
          {tab === 'canned' && <CannedEditor canEdit={canEdit} />}
          {tab === 'history' && <HistoryPanel />}
          {tab === 'qa' && <QaCopySettings canEdit={isAdmin} />}
        </div>
      </div>
    </>
  );
}

// ---------- Reply targets ----------

function SlaEditor({ canEdit }: { canEdit: boolean }) {
  const meta = useMeta();
  if (meta.isLoading) return <div className="muted">Loading…</div>;
  return (
    <>
      <div className="ws-intro">
        <p className="muted small">
          How long a customer should wait for our first human reply. Routing rules and queues pick which target applies. Agents get a warning before a target is missed, and supervisors see misses on the Supervisor page. When “open hours only” is on, the clock pauses outside Business hours and on holidays; snoozing also pauses it.
        </p>
      </div>
      <div className="sla-list">
        {meta.data?.sla_policies.map((p) => <SlaRow key={p.id} policy={p} canEdit={canEdit} />)}
      </div>
    </>
  );
}

function SlaRow({ policy, canEdit }: { policy: SlaPolicy; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const [v, setV] = useState({ first: policy.first_response_minutes, warn: policy.warn_minutes, hours: policy.business_hours });
  const [state, setState] = useState<{ saving?: boolean; error?: string; saved?: boolean }>({});
  const dirty = v.first !== policy.first_response_minutes || v.warn !== policy.warn_minutes || v.hours !== policy.business_hours;
  const problem = !(v.first > 0) ? 'The target must be at least 1 minute.' : v.warn >= v.first ? 'The warning has to come before the target.' : null;
  const save = async () => {
    setState({ saving: true });
    try {
      await inbox.saveSla(policy.id, { first_response_minutes: v.first, warn_minutes: v.warn, business_hours: v.hours });
      await queryClient.invalidateQueries({ queryKey: ['inbox', 'meta'] });
      setState({ saved: true });
    } catch (err) {
      setState({ error: (err as Error).message });
    }
  };
  return (
    <section className="card sla-card">
      <div className="sla-name">
        <b>{policy.name}</b>
        <span className="muted small">Reply within {formatMinutes(v.first)}{v.hours ? ' of open hours' : ''}</span>
      </div>
      <label className="wf-field">
        First reply within
        <DurationInput label={`${policy.name} first reply target`} minutes={v.first} disabled={!canEdit} onChange={(m) => setV({ ...v, first: m ?? v.first })} />
      </label>
      <label className="wf-field">
        Warn the agent
        <span className="nowrap">
          <DurationInput label={`${policy.name} warning`} minutes={v.warn} disabled={!canEdit} onChange={(m) => setV({ ...v, warn: m ?? 0 })} /> before
        </span>
      </label>
      <div className="wf-field">
        Open hours only
        <Switch label="Count open hours only" checked={v.hours} disabled={!canEdit} onChange={(b) => setV({ ...v, hours: b })} />
      </div>
      <div className="sla-actions">
        {canEdit && dirty && (
          <>
            <button type="button" disabled={!!problem || state.saving} onClick={save}>{state.saving ? 'Saving…' : 'Save'}</button>
            <button type="button" className="link small" onClick={() => setV({ first: policy.first_response_minutes, warn: policy.warn_minutes, hours: policy.business_hours })}>Undo</button>
          </>
        )}
        {state.saved && !dirty && <span className="ok small">Saved</span>}
        {(problem || state.error) && <span className="error small">{problem || state.error}</span>}
      </div>
    </section>
  );
}

// ---------- Saved replies ----------

const BLANK = { id: undefined as number | undefined, shortcut: '', title: '', body: '' };

function CannedEditor({ canEdit }: { canEdit: boolean }) {
  const meta = useMeta();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(BLANK);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['inbox', 'meta'] });
  const save = async () => {
    setError(null);
    try {
      await inbox.saveCanned(draft);
      setDraft(BLANK);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const list = (meta.data?.canned || []).filter((c) => !q || `${c.shortcut} ${c.title} ${c.body}`.toLowerCase().includes(q.toLowerCase()));
  const taken = meta.data?.canned.some((c) => c.shortcut === draft.shortcut && c.id !== draft.id);
  return (
    <>
      <div className="ws-intro">
        <p className="muted small">Type <b>/</b> in the reply box to use these. <code>{'{{first_name}}'}</code> fills in the contact’s first name.</p>
        <input type="search" className="rules-search" placeholder="Find a saved reply…" aria-label="Find a saved reply" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="canned-layout">
        <section className="card no-pad">
          {list.map((c) => (
            <div key={c.id} className={draft.id === c.id ? 'canned-row editing' : 'canned-row'}>
              <div className="grow">
                <b>/{c.shortcut}</b> <span>{c.title}</span>
                <div className="small muted canned-body">{c.body}</div>
              </div>
              {canEdit && (
                <span className="actions">
                  <button type="button" className="link small" onClick={() => setDraft({ id: c.id, shortcut: c.shortcut, title: c.title, body: c.body })}>Edit</button>
                  <button type="button" className="link small danger-link" onClick={() => window.confirm(`Delete /${c.shortcut}?`) && inbox.deleteCanned(c.id).then(refresh)}>Delete</button>
                </span>
              )}
            </div>
          ))}
          {!list.length && <p className="muted small pad">{q ? 'Nothing matches.' : 'No saved replies yet.'}</p>}
        </section>
        {canEdit && (
          <section className="card wf-card canned-form">
            <h2>{draft.id ? `Edit /${draft.shortcut}` : 'New saved reply'}</h2>
            <label className="wf-field">
              Shortcut
              <span className="prefixed"><span>/</span><input value={draft.shortcut} placeholder="late" onChange={(e) => setDraft({ ...draft, shortcut: e.target.value.replace(/\W/g, '').toLowerCase() })} /></span>
              {taken && <span className="warn small">/{draft.shortcut} is already used.</span>}
            </label>
            <label className="wf-field">
              Title
              <input value={draft.title} placeholder="Cleaner running late" onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            </label>
            <label className="wf-field">
              Text
              <textarea rows={5} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
            </label>
            <div className="actions">
              <button type="button" disabled={!draft.shortcut || !draft.title || !draft.body || taken} onClick={save}>{draft.id ? 'Save changes' : 'Add saved reply'}</button>
              {draft !== BLANK && <button type="button" className="link small" onClick={() => setDraft(BLANK)}>Cancel</button>}
            </div>
            {error && <div className="error small">{error}</div>}
          </section>
        )}
      </div>
    </>
  );
}

// ---------- Change history ----------

const SETTING_LABEL: Record<string, string> = {
  default_capacity: 'default capacity',
  offline_returns_work: 'going offline hands work back',
  auto_offline_idle_minutes: 'idle agents go offline',
  pull_waiting_on_available: 'becoming available picks up work',
  assign_on_reply: 'replying assigns',
  reopen_to_previous_owner: 'reopened conversations go to previous owner',
  reopen_window_hours: 'reopen window',
  require_disposition: 'ask for reason and outcome',
  alert_on_long_away: 'alert on long statuses',
  settings_editors: 'who can change settings',
};
const QUEUE_FIELD: Record<string, string> = { routing_mode: 'routing', default_sla_id: 'reply target', schedule_id: 'hours', overflow_minutes: 'overflow time', overflow_queue_id: 'overflow queue', priority_boost: 'priority', restricted: 'private', name: 'name', description: 'description' };

function describeChange(h: HistoryEntry, names: { queue: (id: string | null) => string; user: (id: string | null) => string }): { what: string; detail?: string } {
  const d = h.detail || {};
  const list = (v: unknown) => (Array.isArray(v) ? v.join(', ') : '');
  switch (h.action) {
    case 'rules.replaced': {
      const bits = [list(d.added) && `added ${list(d.added)}`, list(d.changed) && `changed ${list(d.changed)}`, list(d.removed) && `removed ${list(d.removed)}`, d.reordered && 'changed the order'].filter(Boolean);
      return { what: 'updated the routing rules', detail: bits.join('; ') || undefined };
    }
    case 'settings.updated':
      return { what: 'changed routing policies', detail: Object.keys(d).map((k) => SETTING_LABEL[k] || k).join(', ') };
    case 'statuses.replaced':
      return { what: 'updated agent statuses' };
    case 'teams.replaced':
      return { what: 'updated teams' };
    case 'queue.created':
      return { what: `added the queue ${String(d.name || '')}` };
    case 'queue.updated':
      return { what: `changed the ${names.queue(h.object_id)} queue`, detail: Object.keys(d).map((k) => QUEUE_FIELD[k] || k).join(', ') };
    case 'schedule.saved':
      return { what: `saved business hours “${String(d.name || '')}”` };
    case 'canned.saved':
      return { what: `saved the reply /${String(d.shortcut || '')}` };
    case 'canned.deleted':
      return { what: `deleted the reply /${String(d.shortcut || '')}` };
    case 'sla.updated':
      return { what: `set “${String(d.name || '')}” to ${formatMinutes(Number(d.first_response_minutes))}` };
    case 'user.updated':
      return { what: `updated ${names.user(h.object_id)}`, detail: Object.entries(d).filter(([, v]) => v !== undefined && v !== null).map(([k]) => (k === 'team_ids' ? 'teams' : k === 'queue_ids' ? 'queues' : k)).join(', ') };
    default:
      return { what: h.action.replace(/[._]/g, ' ') };
  }
}

function HistoryPanel() {
  const history = useQuery({ queryKey: ['inbox', 'history'], queryFn: inbox.history });
  const wf = useQuery({ queryKey: ['inbox', 'workforce'], queryFn: inbox.workforce });
  if (history.isLoading) return <div className="muted">Loading…</div>;
  if (history.error) return <div className="error">{(history.error as Error).message}</div>;
  const names = {
    queue: (id: string | null) => wf.data?.queues.find((q) => String(q.id) === id)?.name || 'a',
    user: (id: string | null) => {
      const a = wf.data?.agents.find((x) => String(x.id) === id);
      return a ? a.name || a.email : 'an agent';
    },
  };
  return (
    <section className="card no-pad">
      <p className="muted small pad">The last 100 changes to support settings.</p>
      {history.data?.map((h) => {
        const c = describeChange(h, names);
        return (
          <div key={h.id} className="history-row">
            <span className="history-when small muted" title={new Date(h.created_at).toLocaleString('en-CA')}>{ago(h.created_at) === 'now' ? 'just now' : `${ago(h.created_at)} ago`}</span>
            <div className="grow">
              <b>{h.actor_name || h.actor_email || 'System'}</b> {c.what}
              {c.detail && <div className="small muted">{c.detail}</div>}
            </div>
          </div>
        );
      })}
      {!history.data?.length && <p className="muted small pad">No changes yet.</p>}
    </section>
  );
}
