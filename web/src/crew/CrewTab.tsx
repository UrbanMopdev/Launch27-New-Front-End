// Crew Planner (Scheduling planner → Crew Planner). Part 1: the reference data Grace keeps:
// preferences to review, client preferences, cleaners, areas, and the starting data.
// The weekly planning steps come next. docs/crew-planner.md
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { segmentsApi } from '../segments/api';
import {
  EMPLOYMENT_LABEL, JOB_LABEL, NAMES_CLEANERS, PREF_LABEL, ROLE_LABEL, SOURCE_LABEL, STATUS_LABEL, crewApi,
  type CrewCleaner, type CrewRole, type Employment, type JobType, type PlannerStatus, type Pref, type PrefSource, type PrefType, type SeedReport,
} from './api';

type View = 'review' | 'prefs' | 'cleaners' | 'areas' | 'setup' | 'plan' | 'help';
const VIEWS: [View, string][] = [['plan', 'Plan the week'], ['review', 'Preferences to review'], ['prefs', 'Client preferences'], ['cleaners', 'Cleaners'], ['areas', 'Areas'], ['setup', 'Setup'], ['help', 'How it works']];

export function CrewTab() {
  const [params, setParams] = useSearchParams();
  const asked = params.get('crew');
  const view = (VIEWS.some(([v]) => v === asked) ? asked : 'review') as View;
  const go = (v: View) => {
    const next = new URLSearchParams(params);
    next.set('crew', v);
    setParams(next, { replace: true });
  };
  const status = useQuery({ queryKey: ['crew', 'status'], queryFn: crewApi.status, refetchInterval: 60_000 });
  const s = status.data;
  return (
    <div className="sch-tab crew">
      <p className="muted small crew-intro">
        Build the employee crews' week here. The planner trusts what's on these pages over Launch27, and it never changes anything in Launch27: you apply the plan there yourself.{' '}
        <button className="link" onClick={() => go('help')}>How it works</button>
      </p>
      <div className="chips crew-views">
        {VIEWS.map(([v, label]) => (
          <button key={v} className={view === v ? 'chip-btn active' : 'chip-btn'} onClick={() => go(v)}>
            {label}
            {v === 'review' && s?.counts.pending ? <span className="sch-count">{s.counts.pending}</span> : null}
          </button>
        ))}
      </div>
      {status.isError && <div className="error">{(status.error as Error).message}</div>}
      {view === 'plan' && <PlanSoon />}
      {view === 'review' && <ReviewQueue />}
      {view === 'prefs' && <ClientPrefs />}
      {view === 'cleaners' && <Cleaners admin={!!s?.admin} />}
      {view === 'areas' && <Areas />}
      {view === 'setup' && <Setup admin={!!s?.admin} />}
      {view === 'help' && <Help />}
    </div>
  );
}

// Plain-English rules for Grace (same as docs/crew-planner.md).
function Help() {
  return (
    <section className="card crew-help">
      <h2>How the Crew Planner works</h2>
      <h3>What it trusts</h3>
      <ul>
        <li><b>Client preferences</b> on this page, not Launch27's tags or notes. It reads Launch27 after every refresh and lists what it finds under <b>Preferences to review</b>. Nothing there counts until you confirm it.</li>
        <li><b>Cleaners</b> on this page: who's protected, who to take bookings from first, who's on hold or has left, and who's on a crew. Gender and tier come from the Launch27 name codes, like (1)(F), until you change them here.</li>
        <li>It never changes anything in Launch27. You apply the plan there yourself.</li>
      </ul>
      <h3>The preferences</h3>
      <ul>
        <li><b>Prefers</b> a cleaner: the visit only goes to a crew that includes them. A second name means "if the first isn't available".</li>
        <li><b>Never send</b> a cleaner. <b>Female cleaner only</b>: never a crew with a man on it. <b>No trainees</b>: never a crew with a trainee.</li>
        <li><b>Same cleaner every time</b>. <b>Don't move the time</b>: the visit keeps its start time.</li>
        <li><b>Hold: unpaid balance</b>: not scheduled, flagged for you. <b>Cancelling</b>: scheduled as tentative and not counted in hours until you say so.</li>
      </ul>
      <h3>Suggestions from visit history</h3>
      <p>When the same cleaner did at least 3 visits and more than half of a client's visits, it suggests them as the client's preferred cleaner. Clients of someone who left or is on hold aren't suggested: the plan finds them a new regular.</p>
      <h3>Only Residential Ottawa</h3>
      <p>Commercial, Cornwall, Carefor, QCH, Bruyère, OWCS and homemaking visits are never touched.</p>
      <h3>Coming next: planning the week</h3>
      <p>Pick the crews, clear a short "fix first" list, generate, adjust (drag, lock, regenerate), then approve and copy the Launch27 change list, client heads-ups and a Slack message. Crews leave 34 Westwood at 8:30, first stop 9:00 to 9:30, back by 5:30, with a 30-minute lunch. Nobody goes over 44 paid hours a week (drive time counts, lunch doesn't).</p>
    </section>
  );
}

function PlanSoon() {
  return (
    <section className="card">
      <h2>Plan the week</h2>
      <p>Coming in the next update: pick the week and the crews, clear the "fix first" list, generate the plan, adjust it, then approve and copy the change list for Launch27 and Slack.</p>
      <p className="muted small">Get ready now: check the cleaners (protected, low performers, who's on hold or has left), and clear the preferences to review. The plan only follows confirmed preferences.</p>
    </section>
  );
}

const what = (p: Pref) => `${PREF_LABEL[p.type]}${p.cleaners.length ? ` ${p.cleaners.map((c) => c.name).join(p.type === 'PREF_CLEANER' && p.cleaners.length > 1 ? ', then ' : ' or ')}` : ''}`;

function useCleaners() {
  return useQuery({ queryKey: ['crew', 'cleaners'], queryFn: crewApi.cleaners, staleTime: 60_000 });
}

function CleanerPicker({ value, onChange, max = 2 }: { value: number[]; onChange: (ids: number[]) => void; max?: number }) {
  const cleaners = useCleaners();
  const list = (cleaners.data?.cleaners || []).filter((c) => c.in_launch27);
  const slots = Array.from({ length: Math.min(max, value.length + 1) }, (_, i) => i);
  return (
    <span className="crew-picker">
      {slots.map((i) => (
        <select key={i} value={value[i] ?? ''} aria-label={i ? 'Then' : 'Cleaner'} onChange={(e) => {
          const next = [...value];
          if (e.target.value) next[i] = Number(e.target.value); else next.splice(i, 1);
          onChange(next.filter(Boolean));
        }}>
          <option value="">{i ? 'then… (optional)' : 'Pick a cleaner'}</option>
          {list.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      ))}
    </span>
  );
}

// ---------- preferences to review ----------
function ReviewQueue() {
  const qc = useQueryClient();
  const [source, setSource] = useState<PrefSource | ''>('');
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [fixing, setFixing] = useState<{ id: number; ids: number[] } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const data = useQuery({ queryKey: ['crew', 'prefs', 'pending', source], queryFn: () => crewApi.prefs({ status: 'pending', source: source || null }) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['crew'] });
  const act = useMutation({ mutationFn: (a: { id: number; action: 'confirm' | 'reject'; cleaner_ids?: number[] }) => crewApi.prefAction(a.id, a.action, a.cleaner_ids ? { cleaner_ids: a.cleaner_ids } : {}), onSuccess: () => { setFixing(null); refresh(); } });
  const bulk = useMutation({
    mutationFn: (action: 'confirm' | 'reject') => crewApi.bulk([...picked], action),
    onSuccess: (r, action) => {
      setPicked(new Set());
      setMsg(`${action === 'confirm' ? 'Confirmed' : 'Rejected'} ${r.done}.${r.skipped.length ? ` ${r.skipped.length} need a cleaner picked first.` : ''}`);
      refresh();
    },
  });
  const scan = useMutation({ mutationFn: crewApi.scan, onSuccess: (r) => { setMsg(r.created ? `Found ${r.created} new to review.` : 'Nothing new in Launch27.'); refresh(); } });
  const prefs = data.data?.prefs || [];
  const toggle = (id: number) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allPicked = prefs.length > 0 && prefs.every((p) => picked.has(p.id));
  return (
    <section className="card flush">
      <div className="seg-table-head">
        <h2>Preferences to review</h2>
        <span className="muted small">Found in Launch27 tags, notes and visit history. The plan follows them only once you confirm.</span>
      </div>
      <div className="filters crew-pad">
        <label>From
          <select value={source} onChange={(e) => { setSource(e.target.value as PrefSource | ''); setPicked(new Set()); }}>
            <option value="">Everywhere</option>
            {(Object.keys(SOURCE_LABEL) as PrefSource[]).map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
          </select>
        </label>
        <button className="secondary" disabled={!picked.size || bulk.isPending} onClick={() => bulk.mutate('confirm')}>Confirm {picked.size || ''}</button>
        <button className="secondary" disabled={!picked.size || bulk.isPending} onClick={() => bulk.mutate('reject')}>Reject {picked.size || ''}</button>
        <button className="link" disabled={scan.isPending} onClick={() => scan.mutate()}>{scan.isPending ? 'Checking…' : 'Check Launch27 for new ones'}</button>
        {msg && <span className="small" role="status">{msg}</span>}
      </div>
      {(act.error || bulk.error || scan.error) && <div className="error crew-pad">{((act.error || bulk.error || scan.error) as Error).message}</div>}
      <div className="table-scroll">
        <table className="seg-table">
          <thead><tr>
            <th><input type="checkbox" aria-label="Pick all" checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(prefs.map((p) => p.id)))} /></th>
            <th>Client</th><th>Preference</th><th>Where it came from</th><th />
          </tr></thead>
          <tbody>
            {prefs.map((p) => (
              <tr key={p.id}>
                <td><input type="checkbox" aria-label={`Pick ${p.client_name}`} checked={picked.has(p.id)} onChange={() => toggle(p.id)} /></td>
                <td><b>{p.client_name || `Client ${p.client_id}`}</b></td>
                <td>
                  {fixing?.id === p.id ? (
                    <span className="crew-fix">{PREF_LABEL[p.type]} <CleanerPicker value={fixing.ids} onChange={(ids) => setFixing({ id: p.id, ids })} /></span>
                  ) : what(p)}
                  {p.note && <div className="muted small">{p.note}</div>}
                </td>
                <td className="small"><span className="pill">{SOURCE_LABEL[p.source]}</span>{p.source_text && <div className="muted">“{p.source_text}”</div>}</td>
                <td className="crew-actions">
                  {fixing?.id === p.id ? (
                    <>
                      <button disabled={!fixing.ids.length || act.isPending} onClick={() => act.mutate({ id: p.id, action: 'confirm', cleaner_ids: fixing.ids })}>Confirm</button>
                      <button className="link" onClick={() => setFixing(null)}>Cancel</button>
                    </>
                  ) : (
                    <>
                      {NAMES_CLEANERS.includes(p.type) && !p.cleaners.length
                        ? <button onClick={() => setFixing({ id: p.id, ids: [] })}>Pick cleaner</button>
                        : <button disabled={act.isPending} onClick={() => act.mutate({ id: p.id, action: 'confirm' })}>Confirm</button>}
                      {NAMES_CLEANERS.includes(p.type) && p.cleaners.length > 0 && <button className="link" onClick={() => setFixing({ id: p.id, ids: p.cleaners.map((c) => c.id) })}>Change</button>}
                      <button className="secondary" disabled={act.isPending} onClick={() => act.mutate({ id: p.id, action: 'reject' })}>Reject</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {data.isSuccess && !prefs.length && <tr><td colSpan={5} className="muted seg-none-row">Nothing to review.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------- client preferences (the source of truth) ----------
function ClientPrefs() {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [showOff, setShowOff] = useState(false);
  const [adding, setAdding] = useState(false);
  const data = useQuery({ queryKey: ['crew', 'prefs', 'confirmed', q], queryFn: () => crewApi.prefs({ status: 'confirmed', q: q.trim() || null }) });
  const act = useMutation({ mutationFn: (a: { id: number; action: 'deactivate' | 'reactivate' }) => crewApi.prefAction(a.id, a.action), onSuccess: () => qc.invalidateQueries({ queryKey: ['crew'] }) });
  const rows = (data.data?.prefs || []).filter((p) => showOff || p.active);
  return (
    <section className="card flush">
      <div className="seg-table-head">
        <h2>Client preferences</h2>
        <span className="muted small">Confirmed: the plan always follows these.</span>
      </div>
      <div className="filters crew-pad">
        <input placeholder="Search client or note" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="check"><input type="checkbox" checked={showOff} onChange={(e) => setShowOff(e.target.checked)} /> Show turned off</label>
        <button onClick={() => setAdding(!adding)}>{adding ? 'Close' : 'Add a preference'}</button>
      </div>
      {adding && <AddPref onDone={() => setAdding(false)} />}
      {act.error && <div className="error crew-pad">{(act.error as Error).message}</div>}
      <div className="table-scroll">
        <table className="seg-table">
          <thead><tr><th>Client</th><th>Preference</th><th>From</th><th>Confirmed</th><th /></tr></thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} className={p.active ? '' : 'muted'}>
                <td><b>{p.client_name || `Client ${p.client_id}`}</b></td>
                <td>{what(p)}{p.note && <div className="muted small">{p.note}</div>}</td>
                <td className="small">{SOURCE_LABEL[p.source]}</td>
                <td className="small">{p.confirmed_by || '—'}{p.confirmed_at && <div className="muted">{new Date(p.confirmed_at).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}</div>}</td>
                <td>{p.active
                  ? <button className="link" onClick={() => act.mutate({ id: p.id, action: 'deactivate' })}>Turn off</button>
                  : <button className="link" onClick={() => act.mutate({ id: p.id, action: 'reactivate' })}>Turn back on</button>}</td>
              </tr>
            ))}
            {data.isSuccess && !rows.length && <tr><td colSpan={5} className="muted seg-none-row">No confirmed preferences yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AddPref({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [client, setClient] = useState<{ id: number; name: string } | null>(null);
  const [type, setType] = useState<PrefType>('PREF_CLEANER');
  const [ids, setIds] = useState<number[]>([]);
  const [note, setNote] = useState('');
  const search = useQuery({ queryKey: ['crew', 'client-search', q], queryFn: () => segmentsApi.customers({ q, limit: 6 }), enabled: q.trim().length >= 2 && !client });
  const save = useMutation({
    mutationFn: () => crewApi.addPref({ client_id: client!.id, client_name: client!.name, type, cleaner_ids: NAMES_CLEANERS.includes(type) ? ids : [], note: note.trim() || null }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['crew'] }); onDone(); },
  });
  const needsCleaner = NAMES_CLEANERS.includes(type);
  return (
    <div className="crew-pad crew-add">
      <div className="filters">
        {client ? (
          <span><b>{client.name}</b> <button className="link" onClick={() => setClient(null)}>change</button></span>
        ) : (
          <span className="crew-search">
            <input placeholder="Client name" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
            {(search.data?.rows || []).length > 0 && (
              <span className="crew-results">
                {search.data!.rows.map((r) => <button key={r.customer_id} className="secondary" onClick={() => setClient({ id: r.customer_id, name: r.name || `Client ${r.customer_id}` })}>{r.name}<span className="muted small"> {r.city}</span></button>)}
              </span>
            )}
          </span>
        )}
        <select value={type} onChange={(e) => setType(e.target.value as PrefType)} aria-label="Preference">
          {(Object.keys(PREF_LABEL) as PrefType[]).map((t) => <option key={t} value={t}>{PREF_LABEL[t]}</option>)}
        </select>
        {needsCleaner && <CleanerPicker value={ids} onChange={setIds} max={type === 'PREF_CLEANER' ? 2 : 1} />}
        <input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button disabled={!client || (needsCleaner && !ids.length) || save.isPending} onClick={() => save.mutate()}>Save</button>
      </div>
      {type === 'PREF_CLEANER' && <p className="muted small">Pick a second cleaner for "if the first isn't available".</p>}
      {save.error && <div className="error">{(save.error as Error).message}</div>}
    </div>
  );
}

// ---------- cleaners ----------
function Cleaners({ admin }: { admin: boolean }) {
  const qc = useQueryClient();
  const data = useCleaners();
  const [q, setQ] = useState('');
  const [onlyMarked, setOnlyMarked] = useState(false);
  const save = useMutation({
    mutationFn: (a: { id: number; patch: Partial<CrewCleaner> }) => crewApi.saveCleaner(a.id, a.patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crew', 'cleaners'] }),
  });
  const rows = useMemo(() => (data.data?.cleaners || []).filter((c) => (!q.trim() || c.name.toLowerCase().includes(q.trim().toLowerCase())) && (!onlyMarked || c.has_profile)), [data.data, q, onlyMarked]);
  const set = (c: CrewCleaner, patch: Partial<CrewCleaner>) => save.mutate({ id: c.id, patch });
  return (
    <section className="card flush">
      <div className="seg-table-head">
        <h2>Cleaners</h2>
        <span className="muted small">Gender and tier come from Launch27's name codes until you change them here. Tier, low performer{admin ? ' and rating' : ''} are never shown to cleaners or in exports.</span>
      </div>
      <div className="filters crew-pad">
        <input placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="check"><input type="checkbox" checked={onlyMarked} onChange={(e) => setOnlyMarked(e.target.checked)} /> Only ones set up here</label>
        {save.isPending && <span className="muted small">Saving…</span>}
      </div>
      {save.error && <div className="error crew-pad">{(save.error as Error).message}</div>}
      <div className="table-scroll">
        <table className="seg-table crew-cleaners">
          <thead><tr>
            <th>Cleaner</th><th>Planner status</th><th>Protected</th><th>Take from first</th><th>Tier</th><th>Gender</th><th>Employment</th><th>Crew role</th><th>Mainly</th>{admin && <th>Rating %</th>}
          </tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td>
                  <b>{c.name}</b>
                  <div className="muted small">{c.in_launch27 ? `Launch27: ${c.l27_status_label}` : 'Not in Launch27 now'}{c.aliases.length ? ` · also ${c.aliases.join(', ')}` : ''}</div>
                  {c.note && <div className="small">{c.note}</div>}
                </td>
                <td>
                  <select value={c.status} aria-label="Planner status" onChange={(e) => set(c, { status: e.target.value as PlannerStatus })}>
                    {(Object.keys(STATUS_LABEL) as PlannerStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                  </select>
                </td>
                <td><input type="checkbox" aria-label="Protected" checked={c.protected} onChange={(e) => set(c, { protected: e.target.checked })} /></td>
                <td><input type="checkbox" aria-label="Low performer" checked={c.low_performer} onChange={(e) => set(c, { low_performer: e.target.checked })} /></td>
                <td>
                  <select value={c.tier ?? ''} aria-label="Tier" onChange={(e) => set(c, { tier: (e.target.value ? Number(e.target.value) : null) as CrewCleaner['tier'] })}>
                    <option value="">—</option><option value="1">1</option><option value="2">2</option><option value="3">3</option>
                  </select>
                  {c.tier_from === 'launch27' && <span className="muted small"> L27</span>}
                </td>
                <td>
                  <select value={c.gender ?? ''} aria-label="Gender" onChange={(e) => set(c, { gender: (e.target.value || null) as CrewCleaner['gender'] })}>
                    <option value="">—</option><option value="F">F</option><option value="M">M</option>
                  </select>
                  {c.gender_from === 'launch27' && <span className="muted small"> L27</span>}
                </td>
                <td>
                  <select value={c.employment} aria-label="Employment" onChange={(e) => set(c, { employment: e.target.value as Employment })}>
                    {(Object.keys(EMPLOYMENT_LABEL) as Employment[]).map((s) => <option key={s} value={s}>{EMPLOYMENT_LABEL[s]}</option>)}
                  </select>
                </td>
                <td>
                  <select value={c.crew_role} aria-label="Crew role" onChange={(e) => set(c, { crew_role: e.target.value as CrewRole })}>
                    {(Object.keys(ROLE_LABEL) as CrewRole[]).map((s) => <option key={s} value={s}>{ROLE_LABEL[s]}</option>)}
                  </select>
                </td>
                <td>
                  <span className="crew-jobs">
                    {(Object.keys(JOB_LABEL) as JobType[]).map((j) => {
                      const on = c.prefers_job_types.includes(j);
                      return <button key={j} className={on ? 'crew-job on' : 'crew-job'} aria-pressed={on} onClick={() => set(c, { prefers_job_types: on ? c.prefers_job_types.filter((x) => x !== j) : [...c.prefers_job_types, j] })}>{JOB_LABEL[j]}</button>;
                    })}
                  </span>
                </td>
                {admin && <td><RatingInput value={c.rating_pct ?? null} onSave={(v) => set(c, { rating_pct: v })} /></td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RatingInput({ value, onSave }: { value: number | null; onSave: (v: number | null) => void }) {
  const [v, setV] = useState(value == null ? '' : String(value));
  return <input className="qty" inputMode="decimal" aria-label="Rating %" value={v} onChange={(e) => setV(e.target.value)} onBlur={() => { if (v !== (value == null ? '' : String(value))) onSave(v === '' ? null : Number(v)); }} />;
}

// ---------- areas ----------
function Areas() {
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ['crew', 'areas'], queryFn: crewApi.areas });
  const [fsa, setFsa] = useState('');
  const [cluster, setCluster] = useState('');
  const save = useMutation({ mutationFn: (a: { fsa: string; cluster: string | null }) => crewApi.saveArea(a.fsa, a.cluster), onSuccess: () => { setFsa(''); qc.invalidateQueries({ queryKey: ['crew', 'areas'] }); } });
  const groups = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const r of data.data?.clusters || []) m.set(r.cluster, [...(m.get(r.cluster) || []), r.fsa]);
    return [...m.entries()];
  }, [data.data]);
  return (
    <section className="card">
      <h2>Areas</h2>
      <p className="muted small">The first three characters of the postal code. The plan tries to keep each crew-day inside one area.</p>
      <div className="crew-areas">
        {groups.map(([name, fsas]) => (
          <div key={name} className="crew-area">
            <b>{name}</b>
            <div className="chips">{fsas.map((f) => <span key={f} className="chip">{f} <button className="link" aria-label={`Remove ${f}`} onClick={() => save.mutate({ fsa: f, cluster: null })}>×</button></span>)}</div>
          </div>
        ))}
      </div>
      <div className="filters">
        <input placeholder="e.g. K2G" value={fsa} maxLength={3} onChange={(e) => setFsa(e.target.value.toUpperCase())} aria-label="Postal-code area" />
        <input list="crew-area-names" placeholder="Area" value={cluster} onChange={(e) => setCluster(e.target.value)} aria-label="Area name" />
        <datalist id="crew-area-names">{(data.data?.names || []).map((n) => <option key={n} value={n} />)}</datalist>
        <button disabled={fsa.length !== 3 || !cluster.trim() || save.isPending} onClick={() => save.mutate({ fsa, cluster: cluster.trim() })}>Save</button>
      </div>
      {save.error && <div className="error">{(save.error as Error).message}</div>}
    </section>
  );
}

// ---------- setup: the starting data ----------
function Setup({ admin }: { admin: boolean }) {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['crew', 'status'], queryFn: crewApi.status });
  const [fresh, setFresh] = useState<SeedReport | null>(null);
  const load = useMutation({ mutationFn: crewApi.loadSeed, onSuccess: (r) => { setFresh(r); qc.invalidateQueries({ queryKey: ['crew'] }); } });
  const report = fresh || status.data?.seed?.report || null;
  const s = status.data;
  return (
    <section className="card">
      <h2>Setup</h2>
      <ul className="small">
        <li><b>Drive times:</b> estimated from map distance (Google drive times can be switched on later).</li>
        <li><b>Launch27 copy:</b> {s?.snapshot_at ? `from ${new Date(s.snapshot_at).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })}` : 'not loaded yet'} (read-only).</li>
        <li><b>Set up so far:</b> {s ? `${s.counts.profiles} cleaners, ${s.counts.confirmed} confirmed preferences, ${s.counts.pending} to review, ${s.counts.areas} postal-code areas` : '…'}</li>
      </ul>
      <h3>Starting data</h3>
      <p className="small">The protected cleaners, who's on hold or has left, low performers, crew members and the preferences Grace has already confirmed. Loading it again only fills in what's missing: it never undoes a change made here.</p>
      {admin ? (
        <button disabled={load.isPending} onClick={() => load.mutate()}>{load.isPending ? 'Loading…' : s?.seed ? 'Load again' : 'Load starting data'}</button>
      ) : <p className="muted small">An admin loads it.</p>}
      {s?.seed && !fresh && <p className="muted small">Last loaded {new Date(s.seed.run_at).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })}{s.seed.run_by ? ` by ${s.seed.run_by}` : ''}.</p>}
      {load.error && <div className="error">{(load.error as Error).message}</div>}
      {report && <SeedResult r={report} />}
    </section>
  );
}

function SeedResult({ r }: { r: SeedReport }) {
  const list = (title: string, all: string[], tone = '') => {
    const items = [...new Set(all)];
    return items.length ? <div className={`crew-seed ${tone}`}><b>{title} ({items.length})</b><ul className="small">{items.map((x) => <li key={x}>{x}</li>)}</ul></div> : null;
  };
  return (
    <div className="crew-seed-report">
      {r.needs_decision.map((d) => <div key={d.what} className="notice"><b>Needs your decision: {d.what}.</b> {d.why}</div>)}
      {list('Cleaners not found in Launch27', r.cleaners.unmatched, 'warn')}
      {list('Cleaner names that match more than one person', r.cleaners.ambiguous.map((a) => `${a.name}: ${a.matches.join(', ')}`), 'warn')}
      {list('Clients not found (check the spelling in Launch27, then load again)', r.prefs.unmatched_clients, 'warn')}
      {list('Client names that match more than one client', r.prefs.ambiguous_clients.map((a) => `${a.client} (${a.matches})`), 'warn')}
      {list('Preferences waiting for you to pick the cleaner (in Preferences to review)', r.prefs.needs_cleaner, 'warn')}
      {list('Cleaners set up', r.cleaners.set)}
      {list('Preferences added', r.prefs.added)}
      {list('Already there, left as they are', [...r.cleaners.already, ...r.prefs.already])}
    </div>
  );
}
