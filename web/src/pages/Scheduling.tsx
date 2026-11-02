import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { segmentsApi } from '../segments/api';
import { scheduleApi, type Candidate, type Change, type ChangeKind, type Overview, type Series, type Slot, type Visit } from '../schedule/api';
import { FreqPill, Reasons, ScheduleStatus, niceDate, CleanerDot } from '../schedule/ui';

type Tab = 'changes' | 'unassigned' | 'capacity' | 'continuity' | 'find';
const TABS: [Tab, string][] = [['changes', 'Changes to handle'], ['unassigned', 'Needs a cleaner'], ['capacity', 'Capacity'], ['continuity', 'Same cleaner'], ['find', 'Find a slot']];

export function SchedulingPage() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some(([t]) => t === params.get('tab')) ? params.get('tab') : 'changes') as Tab;
  const go = (t: Tab) => {
    const next = new URLSearchParams(params);
    next.set('tab', t);
    setParams(next, { replace: true });
  };
  const overview = useQuery({ queryKey: ['schedule', 'overview'], queryFn: scheduleApi.overview, retry: false, refetchInterval: 120_000 });
  const counts = overview.data?.counts;
  return (
    <div className="sch-page">
      <header className="page-header">
        <div className="seg-head">
          <h1>Scheduling planner</h1>
          <p className="muted">Keep recurring clients with the same cleaner, fill the gaps, keep drives short. The app suggests; you confirm.</p>
          <ScheduleStatus />
        </div>
      </header>
      <div className="tabs">
        {TABS.map(([t, label]) => (
          <button key={t} className={tab === t ? 'tab active' : 'tab'} onClick={() => go(t)}>
            {label}
            {t === 'changes' && counts?.open_changes ? <span className="sch-count">{counts.open_changes}</span> : null}
            {t === 'unassigned' && counts?.unassigned_visits ? <span className="sch-count warn">{counts.unassigned_visits}</span> : null}
          </button>
        ))}
      </div>
      {overview.isError && <NotLoaded message={(overview.error as Error).message} />}
      {overview.data && (
        <>
          {tab === 'changes' && <ChangesTab />}
          {tab === 'unassigned' && <UnassignedTab />}
          {tab === 'capacity' && <CapacityTab data={overview.data} />}
          {tab === 'continuity' && <ContinuityTab />}
          {tab === 'find' && <FindFromLink customerId={Number(params.get('customer')) || null} />}
        </>
      )}
    </div>
  );
}

// "Find the best slot" from a booking brings the client along.
function FindFromLink({ customerId }: { customerId: number | null }) {
  const cust = useQuery({ queryKey: ['segments', 'customer', customerId], queryFn: () => segmentsApi.customer(customerId!), enabled: !!customerId, retry: false });
  if (customerId && cust.isLoading) return <p className="muted">Loading…</p>;
  const preset = customerId ? { id: customerId, name: cust.data?.name || `Customer #${customerId}` } : undefined;
  return <FindSlotTab key={customerId || 0} presetCustomer={preset} />;
}

function NotLoaded({ message }: { message: string }) {
  const queryClient = useQueryClient();
  const refresh = useMutation({ mutationFn: scheduleApi.refresh, onSuccess: () => setTimeout(() => queryClient.invalidateQueries({ queryKey: ['schedule'] }), 4000) });
  return (
    <section className="card seg-empty">
      <h2>Schedule not loaded yet</h2>
      <p className="muted">{message}</p>
      <button disabled={refresh.isPending} onClick={() => refresh.mutate()}>Refresh now</button>
    </section>
  );
}

// ---------- shared: assign ----------
function useAssign(onDone?: (msg: string) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ keys, cleaner }: { keys: string[]; cleaner: number }) => scheduleApi.assign(keys, cleaner),
    onSuccess: (r) => {
      const parts = [`Assigned ${r.assigned} visit${r.assigned === 1 ? '' : 's'} to ${r.cleaner}.`];
      if (r.projected) parts.push(`${r.projected} projected visit${r.projected === 1 ? '' : 's'} follow the series in Launch27.`);
      if (r.confirm_first) parts.push(`${r.cleaner} asks to be called or texted to confirm.`);
      onDone?.(parts.join(' '));
      queryClient.invalidateQueries({ queryKey: ['schedule'] });
    },
  });
}

function CandidateRow({ c, onAssign, busy, label = 'Assign' }: { c: Candidate; onAssign: () => void; busy: boolean; label?: string }) {
  return (
    <div className="sch-cand">
      <div className="sch-cand-head">
        <CleanerDot color={c.color} />
        <Link to={`/schedule/cleaner/${c.cleaner_id}`} className="sch-cand-name">{c.name}</Link>
        <span className="sch-match" title="How well they fit"><span style={{ width: `${Math.round(c.score * 100)}%` }} /></span>
        <button className="secondary" disabled={busy} onClick={onAssign}>{label}</button>
      </div>
      <Reasons reasons={c.reasons} />
    </div>
  );
}

// ---------- changes ----------
const KIND_LABEL: Record<ChangeKind, string> = {
  moved: 'Moved',
  cancelled: 'Cancelled',
  cleaner_changed: 'Cleaner changed',
  availability: 'Availability changed',
  unassigned: 'No cleaner',
  outside_hours: 'Outside hours',
  double_booked: 'Double-booked',
  different_cleaner: 'Usual cleaner is free',
  cleaner_unavailable: "Cleaner can't take it",
};
function ChangesTab() {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<ChangeKind | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const changes = useQuery({ queryKey: ['schedule', 'changes'], queryFn: scheduleApi.changes, refetchInterval: 60_000 });
  const resolve = useMutation({ mutationFn: ({ id, r }: { id: number; r: 'fixed' | 'dismissed' }) => scheduleApi.resolve(id, r), onSuccess: () => queryClient.invalidateQueries({ queryKey: ['schedule'] }) });
  const assign = useAssign(setToast);
  const items = useMemo(() => changes.data?.items || [], [changes.data]);
  const byKind = useMemo(() => {
    const m = new Map<ChangeKind, number>();
    for (const i of items) m.set(i.kind, (m.get(i.kind) || 0) + 1);
    return m;
  }, [items]);
  const shown = items.filter((i) => !kind || i.kind === kind);
  return (
    <div className="sch-tab">
      <div className="seg-filter">
        <button className={!kind ? 'chip-btn active' : 'chip-btn'} onClick={() => setKind(null)}>All <span className="seg-chip-count">{items.length}</span></button>
        {[...byKind].map(([k, n]) => (
          <button key={k} className={kind === k ? 'chip-btn active' : 'chip-btn'} onClick={() => setKind(kind === k ? null : k)}>{KIND_LABEL[k]} <span className="seg-chip-count">{n}</span></button>
        ))}
      </div>
      {toast && <div className="sch-toast" role="status">{toast} <button className="link" onClick={() => setToast(null)}>OK</button></div>}
      {assign.isError && <div className="error">{(assign.error as Error).message}</div>}
      {changes.data && shown.length === 0 && <div className="card muted">Nothing to handle. Changes appear here as customers and cleaners change things in Launch27.</div>}
      <div className="sch-list">
        {shown.slice(0, 80).map((c) => <ChangeCard key={c.id} c={c} onResolve={(r) => resolve.mutate({ id: c.id, r })} onAssign={(cleaner) => c.visit && assign.mutate({ keys: [c.visit.key], cleaner })} busy={assign.isPending || resolve.isPending} />)}
      </div>
      {shown.length > 80 && <p className="muted small">Showing the first 80, soonest first.</p>}
    </div>
  );
}

function ChangeCard({ c, onResolve, onAssign, busy }: { c: Change; onResolve: (r: 'fixed' | 'dismissed') => void; onAssign: (cleaner: number) => void; busy: boolean }) {
  const v = c.visit;
  return (
    <article className={c.urgent ? 'card sch-change urgent' : 'card sch-change'}>
      <div className="sch-change-top">
        <span className={`sch-kind k-${c.kind}`}>{KIND_LABEL[c.kind]}</span>
        {c.due && <span className={c.urgent ? 'sch-due urgent' : 'sch-due'}>{c.urgent ? 'Within 48h · ' : ''}{niceDate(c.due)}</span>}
      </div>
      <b className="sch-change-title">{c.title}</b>
      {v && (
        <div className="muted small">
          <FreqPill visit={v} /> {v.duration / 60}h{v.area ? ` · ${v.area}` : ''}{v.cleaners.length ? ` · now: ${v.cleaners.map((x) => x.name).join(' & ')}` : ''}
        </div>
      )}
      {c.kind === 'moved' && (
        <p className="small sch-note">Is this a one-off, or their new usual time? A one-off leaves their usual slot alone. For a permanent change, edit the series.</p>
      )}
      {c.suggestions.length > 0 && (
        <div className="sch-cands">
          {c.suggestions.map((s) => <CandidateRow key={s.cleaner_id} c={s} busy={busy} onAssign={() => onAssign(s.cleaner_id)} label={v?.projected ? 'Assign (in Launch27)' : 'Assign'} />)}
        </div>
      )}
      <div className="sch-actions">
        {c.kind === 'moved' && <button className="secondary" disabled={busy} onClick={() => onResolve('fixed')}>Just this visit</button>}
        {c.kind === 'moved' && v?.id && <Link className="button secondary-link" to={`/bookings/${v.id}/edit`}>From now on: edit series</Link>}
        {v?.id && <Link className="button secondary-link" to={`/bookings/${v.id}`}>Open booking</Link>}
        {c.kind !== 'moved' && <button className="secondary" disabled={busy} onClick={() => onResolve('fixed')}>Mark handled</button>}
        <button className="link" disabled={busy} onClick={() => onResolve('dismissed')}>Dismiss</button>
      </div>
    </article>
  );
}

// ---------- needs a cleaner ----------
function UnassignedTab() {
  const [toast, setToast] = useState<string | null>(null);
  const [bulk, setBulk] = useState(false);
  const data = useQuery({ queryKey: ['schedule', 'unassigned'], queryFn: scheduleApi.unassigned });
  const assign = useAssign(setToast);
  const series = data.data?.series || [];
  return (
    <div className="sch-tab">
      <div className="sch-bar">
        <span className="muted">{data.data ? `${data.data.total_visits} visits without a cleaner, in ${data.data.total_series} series. One decision covers every visit in a series.` : 'Loading…'}</span>
        {series.length > 0 && <button onClick={() => setBulk(!bulk)}>{bulk ? 'Back to the list' : 'Suggest for all'}</button>}
      </div>
      {toast && <div className="sch-toast" role="status">{toast} <button className="link" onClick={() => setToast(null)}>OK</button></div>}
      {assign.isError && <div className="error">{(assign.error as Error).message}</div>}
      {bulk ? <BulkAssign series={series} onDone={(m) => { setToast(m); setBulk(false); }} /> : (
        <div className="sch-list">
          {series.map((s) => <SeriesCard key={s.key} s={s} busy={assign.isPending} onAssign={(cleaner) => assign.mutate({ keys: s.visits.map((v) => v.key), cleaner })} />)}
          {data.data && series.length === 0 && <div className="card muted">Every visit in the next 8 weeks has a cleaner.</div>}
        </div>
      )}
    </div>
  );
}

function SeriesCard({ s, onAssign, busy }: { s: Series; onAssign: (cleaner: number) => void; busy: boolean }) {
  return (
    <article className="card sch-series">
      <div className="sch-change-top">
        <b className="sch-change-title">{s.customer}</b>
        <FreqPill visit={{ kind: s.kind, freq: s.freq, prepaid: s.prepaid } as Visit} />
      </div>
      <div className="small">{s.when} · {s.duration / 60}h{s.area ? ` · ${s.area}` : ''} · {s.visits.length} visit{s.visits.length === 1 ? '' : 's'}{s.projected ? ` (${s.projected} projected)` : ''}</div>
      {s.why && <div className="small sch-why">{s.why}</div>}
      {s.candidates.length ? (
        <div className="sch-cands">
          {s.candidates.map((c) => <CandidateRow key={c.cleaner_id} c={c} busy={busy} onAssign={() => onAssign(c.cleaner_id)} label={s.visits.length > 1 ? `Assign all ${s.visits.length - s.projected}` : 'Assign'} />)}
        </div>
      ) : <p className="small warn">Nobody is free for these times. Try "Find a slot" to offer the client another time.</p>}
    </article>
  );
}

function BulkAssign({ series, onDone }: { series: Series[]; onDone: (msg: string) => void }) {
  const queryClient = useQueryClient();
  const withPick = series.filter((s) => s.candidates.length);
  const [picked, setPicked] = useState<Record<string, number | null>>(() => Object.fromEntries(withPick.map((s) => [s.key, s.candidates[0].cleaner_id])));
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = withPick.filter((s) => picked[s.key]);
  async function approve() {
    setWorking(true);
    setError(null);
    let visits = 0;
    try {
      for (const s of chosen) {
        const r = await scheduleApi.assign(s.visits.map((v) => v.key), picked[s.key]!);
        visits += r.assigned;
      }
      onDone(`Assigned ${visits} visits across ${chosen.length} series.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setWorking(false);
      queryClient.invalidateQueries({ queryKey: ['schedule'] });
    }
  }
  return (
    <section className="card flush">
      <div className="seg-table-head">
        <div><h2>Suggested cleaner for every series</h2><span className="muted small">Untick anything you'd rather handle yourself, or pick another cleaner. Nothing changes until you approve.</span></div>
        <button disabled={!chosen.length || working} onClick={approve}>{working ? 'Assigning…' : `Approve ${chosen.length}`}</button>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="table-scroll">
        <table className="seg-table">
          <thead><tr><th /><th>Client</th><th>When</th><th>Cleaner</th><th>Why</th></tr></thead>
          <tbody>
            {withPick.map((s) => {
              const cur = s.candidates.find((c) => c.cleaner_id === picked[s.key]) || s.candidates[0];
              return (
                <tr key={s.key}>
                  <td><input type="checkbox" aria-label={`Include ${s.customer}`} checked={!!picked[s.key]} onChange={(e) => setPicked({ ...picked, [s.key]: e.target.checked ? s.candidates[0].cleaner_id : null })} /></td>
                  <td><b>{s.customer}</b><div className="muted small">{s.freq} · {s.visits.length} visit{s.visits.length === 1 ? '' : 's'}</div></td>
                  <td className="small">{s.when}</td>
                  <td>
                    <select value={picked[s.key] ?? ''} disabled={!picked[s.key]} onChange={(e) => setPicked({ ...picked, [s.key]: Number(e.target.value) })} aria-label={`Cleaner for ${s.customer}`}>
                      {s.candidates.map((c) => <option key={c.cleaner_id} value={c.cleaner_id}>{c.name}</option>)}
                    </select>
                  </td>
                  <td><Reasons reasons={cur.reasons.slice(0, 3)} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {series.length > withPick.length && <p className="muted small sch-pad">{series.length - withPick.length} series have nobody free at their times: handle those from the list.</p>}
    </section>
  );
}

// ---------- capacity ----------
function CapacityTab({ data }: { data: Overview }) {
  const [area, setArea] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [room, setRoom] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const rows = data.rows.filter((r) => (showAll || r.assignable) && (!area || r.area === area) && (!q || r.name.toLowerCase().includes(q.toLowerCase())) && (!room || r.weeks.slice(0, 4).some((w) => w.capacity - w.booked >= 4)));
  const hidden = data.rows.filter((r) => !r.assignable).length;
  return (
    <div className="sch-tab">
      <div className="sch-bar">
        <div className="seg-filter">
          <button className={!area ? 'chip-btn active' : 'chip-btn'} onClick={() => setArea(null)}>All areas</button>
          {data.areas.map((a) => <button key={a} className={area === a ? 'chip-btn active' : 'chip-btn'} onClick={() => setArea(area === a ? null : a)}>{a}</button>)}
          <button className={room ? 'chip-btn active' : 'chip-btn'} onClick={() => setRoom(!room)}>Has room</button>
        </div>
        <label className="seg-search"><span className="sr-only">Search cleaners</span><input type="search" placeholder="Search cleaners" value={q} onChange={(e) => setQ(e.target.value)} /></label>
      </div>
      <section className="card flush">
        <div className="table-scroll">
          <table className="sch-cap">
            <thead>
              <tr>
                <th>Cleaner</th>
                {data.weeks.map((w) => <th key={w.from} className="c">{niceDate(w.from, true)}<div className="muted small">Week {w.cycle}</div></th>)}
              </tr>
            </thead>
            <tbody>
              <tr className="sch-unassigned-row">
                <td><b>Needs a cleaner</b><div className="small">Unassigned hours</div></td>
                {data.unassigned.map((h, i) => <td key={i} className="c"><Link to="/schedule?tab=unassigned" className="sch-unassigned-cell">{h}h</Link></td>)}
              </tr>
              {rows.map((r) => (
                <tr key={r.id} className={r.assignable ? '' : 'sch-muted'}>
                  <td>
                    <div className="sch-who">
                      <CleanerDot color={r.color} />
                      <div>
                        <Link to={`/schedule/cleaner/${r.id}`} className="seg-name">{r.name}</Link>
                        <div className="muted small">{r.area}{r.is_new ? ' · New hire' : ''}{!r.assignable ? ` · ${r.status_label}` : ''}{r.hours_type ? ` · ${r.hours_type}` : ''}</div>
                      </div>
                    </div>
                  </td>
                  {r.weeks.map((w, i) => {
                    const pct = w.capacity ? w.booked / w.capacity : w.booked ? 2 : 0;
                    const cls = !w.capacity && !w.booked ? 'off' : pct > 1 ? 'over' : pct >= 0.85 ? 'full' : pct >= 0.5 ? 'ok' : 'room';
                    return (
                      <td key={i} className="c">
                        <span className={`sch-heat ${cls}`} title={`${w.booked}h booked of ${w.capacity}h available`}>
                          <b>{w.booked}h</b>
                          <span>{!w.capacity && !w.booked ? 'off' : w.capacity - w.booked >= 0 ? `${Math.round((w.capacity - w.booked) * 10) / 10}h open` : `${Math.round((w.booked - w.capacity) * 10) / 10}h over`}</span>
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="sch-legend">
          <span><i className="sch-heat room" />Lots of room</span>
          <span><i className="sch-heat ok" />Healthy</span>
          <span><i className="sch-heat full" />Full</span>
          <span><i className="sch-heat over" />Over their hours</span>
          {hidden > 0 && <button className="link" onClick={() => setShowAll(!showAll)}>{showAll ? 'Hide' : 'Show'} {hidden} cleaner{hidden === 1 ? '' : 's'} not taking bookings</button>}
        </div>
      </section>
    </div>
  );
}

// ---------- continuity ----------
function ContinuityTab() {
  const [toast, setToast] = useState<string | null>(null);
  const data = useQuery({ queryKey: ['schedule', 'continuity'], queryFn: scheduleApi.continuity });
  const assign = useAssign(setToast);
  const d = data.data;
  if (!d) return null;
  return (
    <div className="sch-tab">
      <div className="seg-stats">
        <div className="card seg-stat"><span className="muted small">Visits with the client's main cleaner</span><span className="seg-stat-value">{d.visit_share === null ? '—' : `${Math.round(d.visit_share * 100)}%`}</span><span className="small">last 13 weeks</span></div>
        <div className="card seg-stat"><span className="muted small">Always the same cleaner</span><span className="seg-stat-value">{d.always} of {d.clients}</span><span className="small">{d.three_plus} had three or more cleaners</span></div>
        <div className="card seg-stat"><span className="muted small">Coming up with someone else</span><span className="seg-stat-value">{d.upcoming_count}</span><span className="small">next 4 weeks</span></div>
        <div className="card seg-stat"><span className="muted small">Recurring clients without a main cleaner</span><span className="seg-stat-value">{d.without_main}</span><span className="small">new or rotating</span></div>
      </div>
      {toast && <div className="sch-toast" role="status">{toast} <button className="link" onClick={() => setToast(null)}>OK</button></div>}
      {assign.isError && <div className="error">{(assign.error as Error).message}</div>}
      <section className="card flush">
        <div className="seg-table-head"><h2>Coming up with someone other than their main cleaner</h2><span className="muted small">Main cleaner = most of their last 6 visits</span></div>
        <div className="table-scroll">
          <table className="seg-table">
            <thead><tr><th>Visit</th><th>Client</th><th>Main cleaner</th><th>Booked with</th><th>Why</th><th /></tr></thead>
            <tbody>
              {d.upcoming.map((u) => (
                <tr key={u.visit.key}>
                  <td>{niceDate(u.visit.date)} · {u.visit.time}</td>
                  <td><b>{u.visit.customer}</b><div className="muted small">{u.visit.freq} · {u.history} of their last visits with {u.main.name}</div></td>
                  <td>{u.main.name}</td>
                  <td>{u.visit.cleaners.length ? u.visit.cleaners.map((c) => c.name).join(' & ') : <span className="warn">No one</span>}</td>
                  <td className="small">{u.why}</td>
                  <td>{u.main_free && <button disabled={assign.isPending} onClick={() => assign.mutate({ keys: [u.visit.key], cleaner: u.main.id })}>Back to {u.main.name.split(' ')[0]}</button>}</td>
                </tr>
              ))}
              {d.upcoming.length === 0 && <tr><td colSpan={6} className="muted seg-none-row">Every recurring visit in the next 4 weeks is with the client's main cleaner.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// ---------- find a slot ----------
const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat']] as const;
export function FindSlotTab({ presetCustomer }: { presetCustomer?: { id: number; name: string } }) {
  const navigate = useNavigate();
  const [customer, setCustomer] = useState<{ id: number; name: string } | null>(presetCustomer || null);
  const [q, setQ] = useState('');
  const [hours, setHours] = useState(3);
  const [kind, setKind] = useState<Visit['kind']>('bi');
  const [from, setFrom] = useState('');
  const [days, setDays] = useState<number[]>([]);
  const [time, setTime] = useState<'any' | 'am' | 'pm'>('any');
  const search = useQuery({ queryKey: ['schedule', 'customer-search', q], queryFn: () => segmentsApi.customers({ q, limit: 6 }), enabled: q.trim().length >= 2 && !customer });
  const slots = useMutation({ mutationFn: () => scheduleApi.findSlots({ customer_id: customer?.id, duration: Math.round(hours * 60), kind, from: from || undefined, weekdays: days.length ? days : undefined, earliest: time === 'pm' ? 12 * 60 : 0, latest: time === 'am' ? 12 * 60 + 30 : 24 * 60 }) });
  const book = (s: Slot) => navigate(`/bookings/new?${new URLSearchParams({ ...(customer ? { customer: String(customer.id) } : {}), date: s.date, time: `${String(Math.floor(s.start / 60)).padStart(2, '0')}:${String(s.start % 60).padStart(2, '0')}`, team: String(s.cleaner.id), freq: kind })}`);
  return (
    <div className="sch-tab sch-find">
      <section className="card sch-find-form">
        <h2>Find the best slot</h2>
        <label>Client
          {customer ? (
            <span className="sch-picked">{customer.name} <button className="link" onClick={() => setCustomer(null)}>change</button></span>
          ) : (
            <>
              <input type="search" placeholder="Search by name, email or phone (optional)" value={q} onChange={(e) => setQ(e.target.value)} />
              {search.data && search.data.rows.length > 0 && (
                <span className="sch-results">
                  {search.data.rows.map((r) => <button key={r.customer_id} className="chip-btn" onClick={() => { setCustomer({ id: r.customer_id, name: r.name || `#${r.customer_id}` }); setQ(''); }}>{r.name}</button>)}
                </span>
              )}
            </>
          )}
        </label>
        <div className="sch-find-grid">
          <label>How often
            <select value={kind} onChange={(e) => setKind(e.target.value as Visit['kind'])}>
              <option value="weekly">Weekly</option><option value="bi">Biweekly</option><option value="monthly">Monthly (every 4 weeks)</option><option value="one">One-time</option>
            </select>
          </label>
          <label>Length (hours)<input type="number" min={1} max={10} step={0.5} value={hours} onChange={(e) => setHours(Number(e.target.value))} /></label>
          <label>Starting from<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        </div>
        <div className="seg-filter">
          <span className="small seg-traits-label">Days</span>
          {DAYS.map(([d, l]) => <button key={d} className={days.includes(d) ? 'chip-btn active' : 'chip-btn'} onClick={() => setDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d])}>{l}</button>)}
          <span className="small seg-traits-label">Time</span>
          {(['any', 'am', 'pm'] as const).map((t) => <button key={t} className={time === t ? 'chip-btn active' : 'chip-btn'} onClick={() => setTime(t)}>{t === 'any' ? 'Any' : t === 'am' ? 'Morning' : 'Afternoon'}</button>)}
        </div>
        <button disabled={slots.isPending} onClick={() => slots.mutate()}>{slots.isPending ? 'Looking…' : 'Find slots'}</button>
        {!customer && <p className="muted small">Without a client, distance can't be used. Pick the client for the best match.</p>}
      </section>
      {slots.isError && <div className="error">{(slots.error as Error).message}</div>}
      {slots.data && (
        <section className="sch-list">
          <p className="muted small">
            {slots.data.slots.length ? `Best ${slots.data.frequency.toLowerCase()} slots. Recurring slots are free on every date for the next 8 weeks.` : 'No cleaner is free for that. Try other days, a shorter clean, or a later start date.'}
            {slots.data.customer?.main && (slots.data.slots.some((x) => x.cleaner.name === slots.data!.customer!.main)
              ? ` ${slots.data.customer.main} (usual cleaner) is ranked first where free.`
              : ` ${slots.data.customer.main} (usual cleaner) isn't free at those times: try other days or times to keep them.`)}
          </p>
          {slots.data.slots.map((s) => (
            <article key={`${s.cleaner.id}-${s.date}`} className="card sch-slot">
              <div className="sch-slot-when">
                <b>{niceDate(s.date)} · {s.time}–{s.end}</b>
                <span className="muted small">{s.repeats > 1 ? `Repeats ${s.repeats} times in 8 weeks · weeks ${s.weeks.split('').join('/')}` : 'One visit'}</span>
              </div>
              <div className="sch-who"><CleanerDot color={s.cleaner.color} /><Link to={`/schedule/cleaner/${s.cleaner.id}`} className="seg-name">{s.cleaner.name}</Link>{s.cleaner.is_new && <span className="seg-trait">New hire</span>}</div>
              <Reasons reasons={s.reasons} />
              <button onClick={() => book(s)}>Book this slot</button>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}

