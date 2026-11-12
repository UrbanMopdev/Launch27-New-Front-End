import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useBrand } from '../brands/useBrand';
import { BrandPill, brandLabel } from '../brands/ui';
import { segmentsApi } from '../segments/api';
import { scheduleApi, type Candidate, type Change, type ChangeKind, type Overview, type Series, type Slot, type Visit } from '../schedule/api';
import { FreqPill, Reasons, ScheduleStatus, niceDate, CleanerDot } from '../schedule/ui';
import { CrewTab } from '../crew/CrewTab';
import { useMe } from '../hooks';

type Tab = 'changes' | 'capacity' | 'continuity' | 'find' | 'crew';
const BASE_TABS: [Tab, string][] = [['changes', 'Changes to handle'], ['capacity', 'Capacity'], ['continuity', 'Same cleaner'], ['find', 'Find a slot']];
// Crew Planner: admins and the planner only (the server says who, in /auth/me features).
const CREW_TAB: [Tab, string] = ['crew', 'Crew Planner'];

export function SchedulingPage() {
  const [params, setParams] = useSearchParams();
  const me = useMe();
  const TABS = me.data?.features?.crewPlanner ? [...BASE_TABS, CREW_TAB] : BASE_TABS;
  // Old links to the separate "Needs a cleaner" tab open that filter in Changes to handle.
  const asked = params.get('tab');
  const tab = (TABS.some(([t]) => t === asked) ? asked : 'changes') as Tab;
  const initialKind = asked === 'unassigned' ? 'unassigned' : (params.get('kind') as ChangeKind | null);
  const go = (t: Tab) => {
    const next = new URLSearchParams(params);
    next.set('tab', t);
    setParams(next, { replace: true });
  };
  const brand = useBrand();
  const overview = useQuery({ queryKey: ['schedule', 'overview', brand.locationIds], queryFn: () => scheduleApi.overview(brand.locationIds), retry: false, refetchInterval: 120_000, placeholderData: (prev) => prev });
  const changesQ = useQuery({ queryKey: ['schedule', 'changes'], queryFn: scheduleApi.changes, refetchInterval: 60_000, enabled: overview.isSuccess });
  const openChanges = changesQ.data ? changesQ.data.items.filter((c) => changeInView(brand, c)).length : overview.data?.counts.open_changes;
  return (
    <div className="sch-page">
      <header className="page-header">
        <div className="seg-head">
          <h1>Scheduling planner</h1>
          <p className="muted">Keep recurring clients with the same cleaner, fill the gaps, keep drives short. The app suggests; you confirm.</p>
          <ScheduleStatus />
          {brand.view !== 'both' && <p className="brand-scope"><span className={`brand-pill ${brand.view}`}>{brandLabel(brand.view)}</span> Only this brand's cleaners, visits and changes. Switch brands in the menu.</p>}
        </div>
      </header>
      <div className="tabs">
        {TABS.map(([t, label]) => (
          <button key={t} className={tab === t ? 'tab active' : 'tab'} onClick={() => go(t)}>
            {label}
            {t === 'changes' && openChanges ? <span className="sch-count">{openChanges}</span> : null}
          </button>
        ))}
      </div>
      {overview.isError && <NotLoaded message={(overview.error as Error).message} />}
      {overview.data && (
        <>
          {tab === 'changes' && <ChangesTab initialKind={initialKind} />}
          {tab === 'capacity' && <CapacityTab data={overview.data} />}
          {tab === 'continuity' && <ContinuityTab />}
          {tab === 'crew' && <CrewTab />}
          {tab === 'find' && <FindFromLink customerId={Number(params.get('customer')) || null} name={params.get('name')} reschedule={rescheduleFrom(params)} />}
        </>
      )}
    </div>
  );
}

// "Find the best slot" from a booking brings the client along.
export interface Reschedule { bookingId: number; next: string; hours?: number; kind?: Visit['kind']; current?: string }
function rescheduleFrom(params: URLSearchParams): Reschedule | undefined {
  const bookingId = Number(params.get('booking'));
  const next = params.get('next') || '';
  if (!bookingId || !next.startsWith('/bookings/')) return undefined; // only ever back to a booking form
  const kind = params.get('freq');
  return { bookingId, next, hours: Number(params.get('hours')) || undefined, kind: (['weekly', 'bi', 'monthly', 'one'].includes(kind || '') ? kind : undefined) as Visit['kind'] | undefined, current: params.get('current') || undefined };
}
function FindFromLink({ customerId, reschedule, name }: { customerId: number | null; reschedule?: Reschedule; name?: string | null }) {
  // Partner clients (negative ids, one per address) aren't customers in Launch27: the link names them.
  const cust = useQuery({ queryKey: ['segments', 'customer', customerId], queryFn: () => segmentsApi.customer(customerId!), enabled: !!customerId && customerId > 0, retry: false });
  if (customerId && cust.isLoading) return <p className="muted">Loading…</p>;
  const preset = customerId ? { id: customerId, name: cust.data?.name || name || `Customer #${customerId}` } : undefined;
  return <FindSlotTab key={`${customerId || 0}-${reschedule?.bookingId || 0}`} presetCustomer={preset} reschedule={reschedule} />;
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
    mutationFn: ({ keys, cleaner, recommended }: { keys: string[]; cleaner: number; recommended?: boolean }) => scheduleApi.assign(keys, cleaner, recommended),
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
  unassigned: 'Needs a cleaner',
  double_booked: 'Clash',
  outside_hours: 'Outside hours',
  cleaner_unavailable: 'Cleaner unavailable',
  different_cleaner: 'Usual cleaner free',
  moved: 'Moved',
  cancelled: 'Cancelled',
  cleaner_changed: 'Cleaner changed',
  availability: 'Hours changed',
};
const KIND_ORDER: ChangeKind[] = ['unassigned', 'cleaner_unavailable', 'double_booked', 'outside_hours', 'moved', 'cancelled', 'cleaner_changed', 'availability', 'different_cleaner'];
const first = (name?: string | null) => String(name || '').split(' ')[0] || 'them';
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// One plain sentence for what is happening, one for why it matters.
export function explain(c: Change): { headline: string; why: string } {
  const v = c.visit;
  const client = c.client?.name || v?.customer || 'A client';
  const cl = c.cleaner;
  const d = c.detail;
  const when = v ? `${v.time}–${v.end}` : '';
  switch (c.kind) {
    case 'unassigned':
      return c.series && c.series.count > 1
        ? { headline: `No cleaner yet for ${client}'s ${v?.freq.toLowerCase() || ''} cleans`, why: `${c.series.when}, ${c.series.count} visits from ${niceDate(c.series.first)} to ${niceDate(c.series.last)}. One cleaner for all of them keeps it consistent.` }
        : { headline: `No cleaner yet for ${client}`, why: `${v ? `${v.freq} clean, ${when}.` : ''} Someone needs to be assigned.` };
    case 'outside_hours':
      return {
        headline: `${client}'s clean is outside ${first(cl?.name)}'s working hours`,
        why: cl?.working ? `${cl.name} works ${cl.hours} that day, but this clean runs ${when}.` : `${cl?.name || 'The cleaner'} doesn't work on ${v ? WEEKDAY[new Date(`${v.date}T12:00:00Z`).getUTCDay()] : 'that day'}s.`,
      };
    case 'double_booked':
      return { headline: `${first(cl?.name)} is booked for two cleans at the same time`, why: `${client} (${when}) overlaps with ${list(d.with || []) || 'another clean'}.` };
    case 'cleaner_unavailable':
      return { headline: `${first(cl?.name)} can't do ${client}'s clean`, why: `${cl?.name || 'The cleaner'} is ${d.why || 'unavailable'}, so this clean needs someone else.` };
    case 'different_cleaner':
      return {
        headline: `${client}'s usual cleaner is free for this visit`,
        why: `It's booked with ${list(d.booked || []) || 'someone else'}. ${c.client?.main ? `${c.client.main.name} did ${c.client.main.visits} of their last ${c.client.main.of} visits and is free then.` : ''}`,
      };
    case 'moved':
      return { headline: `${client}'s clean was moved`, why: `From ${d.from_label} to ${d.to_label}.` };
    case 'cancelled':
      return { headline: `${client} cancelled a clean`, why: `${d.when_label || ''}${cl ? `. ${cl.name} now has ${Math.round(((d.duration as number) || 0) / 6) / 10}h free.` : '.'}` };
    case 'cleaner_changed': {
      const wasUsual = c.client?.main && (d.from_names || []).includes(c.client.main.name);
      return { headline: `${client}'s cleaner was changed`, why: `${list(d.from_names || []) || 'No one'} → ${list(d.to_names || []) || 'no one'}.${wasUsual ? ' That was their usual cleaner.' : ''}` };
    }
    case 'availability': {
      const n = d.affected_visits?.length || 0;
      return { headline: c.title.split(':')[0], why: n ? `${n} upcoming clean${n === 1 ? ' no longer fits' : 's no longer fit'}. Each one is listed below.` : 'No upcoming cleans are affected.' };
    }
    default:
      return { headline: c.title, why: '' };
  }
}

function dayHeading(c: Change) {
  if (c.days_away === null || !c.due) return 'No date';
  if (c.days_away <= 0) return `Today · ${niceDate(c.due)}`;
  if (c.days_away === 1) return `Tomorrow · ${niceDate(c.due)}`;
  return niceDate(c.due);
}

function ChangesTab({ initialKind = null }: { initialKind?: ChangeKind | null }) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<ChangeKind | null>(initialKind);
  const [bulk, setBulk] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const changes = useQuery({ queryKey: ['schedule', 'changes'], queryFn: scheduleApi.changes, refetchInterval: 60_000 });
  const resolve = useMutation({ mutationFn: ({ id, r }: { id: number; r: 'fixed' | 'dismissed' }) => scheduleApi.resolve(id, r), onSuccess: () => queryClient.invalidateQueries({ queryKey: ['schedule'] }) });
  const assign = useAssign(setToast);
  const brand = useBrand();
  const items = useMemo(() => (changes.data?.items || []).filter((c) => changeInView(brand, c)), [changes.data, brand]);
  const byKind = useMemo(() => {
    const m = new Map<ChangeKind, number>();
    for (const i of items) m.set(i.kind, (m.get(i.kind) || 0) + 1);
    return KIND_ORDER.filter((k) => m.has(k)).map((k) => [k, m.get(k)!] as const);
  }, [items]);
  const shown = items.filter((i) => !kind || i.kind === kind).slice(0, 60);
  const groups: { heading: string; urgent: boolean; items: Change[] }[] = [];
  for (const c of shown) {
    const h = dayHeading(c);
    const g = groups.find((x) => x.heading === h);
    if (g) g.items.push(c);
    else groups.push({ heading: h, urgent: c.urgent, items: [c] });
  }
  return (
    <div className="sch-tab">
      <p className="muted sch-intro">Each card says what's happening, what the client wants, and the one thing we recommend. Nothing changes until you click.</p>
      <div className="seg-filter">
        <button className={!kind ? 'chip-btn active' : 'chip-btn'} onClick={() => setKind(null)}>All <span className="seg-chip-count">{items.length}</span></button>
        {byKind.map(([k, n]) => (
          <button key={k} className={kind === k ? 'chip-btn active' : 'chip-btn'} onClick={() => setKind(kind === k ? null : k)}>{KIND_LABEL[k]} <span className="seg-chip-count">{n}</span></button>
        ))}
      </div>
      {kind === 'unassigned' && shown.length > 1 && (
        <div className="sch-bar">
          <span className="muted small">Every visit without a cleaner in the next 8 weeks, one card per series.</span>
          <button className={bulk ? 'secondary' : ''} onClick={() => setBulk(!bulk)}>{bulk ? 'Back to the cards' : 'Suggest for all'}</button>
        </div>
      )}
      {toast && <div className="sch-toast" role="status">{toast} <button className="link" onClick={() => setToast(null)}>OK</button></div>}
      {assign.isError && <div className="error">{(assign.error as Error).message}</div>}
      {kind === 'unassigned' && bulk ? <BulkFromApi onDone={(m) => { setToast(m); setBulk(false); }} /> : null}
      {changes.data && shown.length === 0 && <div className="card muted">All clear. New changes appear here within a few minutes of happening in Launch27.</div>}
      {!(kind === 'unassigned' && bulk) && groups.map((g) => (
        <section key={g.heading} className="sch-day">
          <h2 className={g.urgent ? 'sch-day-head urgent' : 'sch-day-head'}>{g.heading}<span className="muted small"> · {g.items.length} to handle</span></h2>
          <div className="sch-list">
            {g.items.map((c) => <ChangeCard key={c.id} c={c} onResolve={(r) => resolve.mutate({ id: c.id, r })} onAssign={(cleaner, recommended) => c.visit && assign.mutate({ keys: c.series?.visit_keys || [c.visit.key], cleaner, recommended })} busy={assign.isPending || resolve.isPending} />)}
          </div>
        </section>
      ))}
      {items.filter((i) => !kind || i.kind === kind).length > 60 && <p className="muted small">Showing the first 60, soonest first. Use the filters to narrow down.</p>}
    </div>
  );
}

const REC_LABEL: Partial<Record<ChangeKind, string>> = {
  unassigned: 'Recommended cleaner',
  double_booked: 'Recommended: move this clean to',
  outside_hours: 'Recommended: move this clean to',
  cleaner_unavailable: 'Recommended: move this clean to',
  different_cleaner: 'Recommended: back to their usual cleaner',
  moved: 'Recommended cleaner at the new time',
  cleaner_changed: 'Recommended cleaner',
};

function ClientWants({ client }: { client: Change['client'] }) {
  if (!client) return null;
  const p = client.prefs;
  const chips: { text: string; tone: 'good' | 'warn' | 'neutral' }[] = [];
  if (p.female_only) chips.push({ text: 'Female cleaner only', tone: 'warn' });
  else if (p.prefers_female) chips.push({ text: 'Prefers a female cleaner', tone: 'neutral' });
  if (p.prefers_male) chips.push({ text: 'Prefers a male cleaner', tone: 'neutral' });
  if (p.consistent) chips.push({ text: 'Wants the same cleaner every time', tone: 'neutral' });
  for (const n of p.prefers) chips.push({ text: `Asks for ${n}`, tone: 'good' });
  for (const n of p.avoid) chips.push({ text: `Never send ${n}`, tone: 'warn' });
  return (
    <div className="sch-wants">
      <span className="eyebrow">What the client wants</span>
      <div className="sch-wants-row">
        <span className="muted small">Usual cleaner</span>
        <b>{client.main ? `${client.main.name}` : 'None yet'}</b>
        {client.main && <span className="muted small">{client.main.visits} of their last {client.main.of} visits{client.main.available ? '' : ' · not taking bookings now'}</span>}
      </div>
      {chips.length > 0 ? <div className="sch-reasons">{chips.map((x) => <span key={x.text} className={`sch-reason t-${x.tone}`}>{x.text}</span>)}</div> : <span className="muted small">No cleaner preferences on file.</span>}
      {client.notes.length > 0 && <div className="small sch-notes">Notes: {client.notes.join(' · ')}</div>}
    </div>
  );
}

function ChangeCard({ c, onResolve, onAssign, busy }: { c: Change; onResolve: (r: 'fixed' | 'dismissed') => void; onAssign: (cleaner: number, recommended?: boolean) => void; busy: boolean }) {
  const [more, setMore] = useState(false);
  const v = c.visit;
  const { headline, why } = explain(c);
  const [rec, ...others] = c.suggestions;
  const verb = c.kind === 'different_cleaner' ? 'Move back to' : 'Give to';
  const brand = useBrand();
  const cardBrand = v ? brand.brandOf(v.location_id) : c.cleaner ? brand.cleanerBrands(c.cleaner.location_ids)[0] ?? null : null;
  return (
    <article className={c.urgent ? 'card sch-change urgent' : 'card sch-change'}>
      <div className="sch-change-top">
        <BrandPill brand={cardBrand} />
        <span className={`sch-kind k-${c.kind}`}>{KIND_LABEL[c.kind]}</span>
        {c.urgent && <span className="sch-due urgent">Within 48 hours</span>}
      </div>
      <h3 className="sch-headline">{headline}</h3>
      {why && <p className="sch-why-line">{why}</p>}
      {v && (
        <div className="sch-visit-strip">
          <span><b>{niceDate(v.date)}</b> · {v.time}–{v.end}</span>
          <span>{Math.round((v.duration / 60) * 10) / 10}h</span>
          <FreqPill visit={v} />
          {v.area && <span>{v.area}</span>}
          <span>Cleaner: <b>{v.cleaners.length ? v.cleaners.map((x) => x.name).join(' & ') : 'none'}</b></span>
        </div>
      )}
      {c.kind === 'availability' && (c.detail.affected_visits || []).length > 0 && (
        <ul className="sch-affected">
          {(c.detail.affected_visits || []).map((a) => <li key={a.key}>{niceDate(a.date)} · {a.time} · {a.customer} <FreqPill visit={a} /></li>)}
        </ul>
      )}
      <div className="sch-change-body">
        <ClientWants client={c.client} />
        {rec ? (
          <div className="sch-rec">
            <span className="eyebrow accent">{REC_LABEL[c.kind] || 'Recommended'}</span>
            <div className="sch-who"><CleanerDot color={rec.color} /><b className="sch-rec-name">{rec.name}</b></div>
            <Reasons reasons={rec.reasons} />
            <button disabled={busy} onClick={() => onAssign(rec.cleaner_id, true)}>{c.series && c.series.count > 1 ? `Give all ${c.series.count - c.series.projected} to ${first(rec.name)}` : `${verb} ${first(rec.name)}`}{v?.projected && !c.series ? ' (in Launch27)' : ''}</button>
            {c.series && c.series.projected > 0 && <span className="muted small">{c.series.projected} projected visit{c.series.projected === 1 ? '' : 's'} follow the series in Launch27.</span>}
            {others.length > 0 && <button className="link small" onClick={() => setMore(!more)}>{more ? 'Hide other options' : `Other options (${others.length})`}</button>}
            {more && <div className="sch-cands">{others.map((o) => <CandidateRow key={o.cleaner_id} c={o} busy={busy} onAssign={() => onAssign(o.cleaner_id)} label={`${verb} ${first(o.name)}`} />)}</div>}
          </div>
        ) : c.kind === 'moved' ? (
          <div className="sch-rec">
            <span className="eyebrow accent">Is this a one-off?</span>
            <p className="small">A one-off leaves their usual day and time alone. If it's their new usual time, change the series so future visits follow.</p>
            <div className="sch-actions">
              <button disabled={busy} onClick={() => onResolve('fixed')}>Just this visit</button>
              {v?.id && <Link className="button secondary-link" to={`/bookings/${v.id}/edit`}>From now on: edit series</Link>}
            </div>
          </div>
        ) : ['unassigned', 'cleaner_unavailable', 'double_booked', 'outside_hours'].includes(c.kind) ? (
          <div className="sch-rec empty">
            <span className="eyebrow">Recommended</span>
            <p className="small">{c.kind === 'unassigned' ? 'Nobody is free at this time.' : 'Nobody else is free at this time.'} Call the client to offer another time: <Link to={`/schedule?tab=find${c.client ? `&customer=${c.client.id}` : ''}`}>find a slot</Link>.</p>
          </div>
        ) : (
          <div className="sch-rec empty">
            <span className="eyebrow">Recommended</span>
            <p className="small">{c.kind === 'cancelled' ? 'Nothing to fix. Use the free time for an unassigned visit nearby (see Needs a cleaner).' : 'Check it looks right, then mark it handled.'}</p>
          </div>
        )}
      </div>
      <div className="sch-footer">
        {v?.id && <Link to={`/bookings/${v.id}`}>Open booking</Link>}
        {c.client && c.client.id > 0 && <Link to={`/customers/${c.client.id}`}>Client profile</Link>}
        <span className="sch-footer-right">
          <button className="secondary" disabled={busy} onClick={() => onResolve('fixed')}>Handled</button>
          <button className="link" disabled={busy} onClick={() => onResolve('dismissed')}>Dismiss</button>
        </span>
      </div>
    </article>
  );
}

// ---------- bulk: a cleaner for every unassigned series ----------
function BulkFromApi({ onDone }: { onDone: (msg: string) => void }) {
  const data = useQuery({ queryKey: ['schedule', 'unassigned'], queryFn: scheduleApi.unassigned });
  if (!data.data) return <p className="muted">Loading…</p>;
  return <BulkAssign series={data.data.series} onDone={onDone} />;
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
  const brand = useBrand();
  const rows = data.rows.filter((r) => brand.showCleaner(r.location_ids) && (showAll || r.assignable) && (!area || r.area === area) && (!q || r.name.toLowerCase().includes(q.toLowerCase())) && (!room || r.weeks.slice(0, 4).some((w) => w.capacity - w.booked >= 4)));
  const hidden = data.rows.filter((r) => brand.showCleaner(r.location_ids) && !r.assignable).length;
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
                {data.unassigned.map((h, i) => <td key={i} className="c"><Link to="/schedule?tab=changes&kind=unassigned" className="sch-unassigned-cell">{h}h</Link></td>)}
              </tr>
              {rows.map((r) => (
                <tr key={r.id} className={r.assignable ? '' : 'sch-muted'}>
                  <td>
                    <div className="sch-who">
                      <CleanerDot color={r.color} />
                      <div>
                        <Link to={`/schedule/cleaner/${r.id}`} className="seg-name">{r.name}</Link>{' '}
                        <CleanerBrand ids={r.location_ids} />
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
  const brand = useBrand();
  const data = useQuery({ queryKey: ['schedule', 'continuity', brand.locationIds], queryFn: () => scheduleApi.continuity(brand.locationIds) });
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
export function FindSlotTab({ presetCustomer, reschedule }: { presetCustomer?: { id: number; name: string }; reschedule?: Reschedule }) {
  const navigate = useNavigate();
  const [customer, setCustomer] = useState<{ id: number; name: string } | null>(presetCustomer || null);
  const [q, setQ] = useState('');
  const [hours, setHours] = useState(reschedule?.hours || 3);
  // Rescheduling starts with "just this visit" (one-time); pick the rhythm to move this and future visits.
  const [kind, setKind] = useState<Visit['kind']>(reschedule ? 'one' : 'bi');
  const [from, setFrom] = useState('');
  const [days, setDays] = useState<number[]>([]);
  const [time, setTime] = useState<'any' | 'am' | 'pm'>('any');
  // Asked when a client is picked (e.g. rescheduling): their usual cleaner only, or anyone.
  const [who, setWho] = useState<'same' | 'any' | null>(null);
  const search = useQuery({ queryKey: ['schedule', 'customer-search', q], queryFn: () => segmentsApi.customers({ q, limit: 6 }), enabled: q.trim().length >= 2 && !customer });
  const slots = useMutation({ mutationFn: (override?: 'same' | 'any') => scheduleApi.findSlots({ customer_id: customer?.id, duration: Math.round(hours * 60), kind, from: from || undefined, weekdays: days.length ? days : undefined, earliest: time === 'pm' ? 12 * 60 : 0, latest: time === 'am' ? 12 * 60 + 30 : 24 * 60, cleaner: (override ?? who) === 'same' ? 'same' : 'any', booking_id: reschedule?.bookingId }) });
  const needWho = !!customer && !who;
  const anyInstead = () => { setWho('any'); slots.mutate('any'); };
  const moveTo = (s: Slot) => {
    const [path, qs] = reschedule!.next.split('?');
    const q = new URLSearchParams(qs || '');
    q.set('date', s.date);
    q.set('time', `${String(Math.floor(s.start / 60)).padStart(2, '0')}:${String(s.start % 60).padStart(2, '0')}`);
    q.set('team', String(s.cleaner.id));
    if (kind !== 'one' && reschedule!.kind && reschedule!.kind !== 'one') q.set('future', '1'); else q.delete('future');
    navigate(`${path}?${q.toString()}`);
  };
  const book = (s: Slot) => navigate(`/bookings/new?${new URLSearchParams({ ...(customer ? { customer: String(customer.id) } : {}), date: s.date, time: `${String(Math.floor(s.start / 60)).padStart(2, '0')}:${String(s.start % 60).padStart(2, '0')}`, team: String(s.cleaner.id), freq: kind })}`);
  return (
    <div className="sch-tab sch-find">
      <section className="card sch-find-form">
        <h2>{reschedule ? `Reschedule booking #${reschedule.bookingId}` : 'Find the best slot'}</h2>
        {reschedule && <p className="muted small">{reschedule.current ? `Now ${niceDate(reschedule.current.slice(0, 10))}. ` : ''}Pick a new time; you'll confirm the change on the booking before anything is saved.{reschedule.kind && reschedule.kind !== 'one' ? ' One-time moves just this visit; choose their rhythm to move this and future visits.' : ''}</p>}
        <label>Client
          {customer ? (
            <span className="sch-picked">{customer.name} <button className="link" onClick={() => { setCustomer(null); setWho(null); }}>change</button></span>
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
        {customer && (
          <div className="sch-who-ask" role="group" aria-label="Cleaner preference">
            <span className="small seg-traits-label">Ask {customer.name.split(' ')[0]}: keep their usual cleaner, or any cleaner?</span>
            <button className={who === 'same' ? 'chip-btn active' : 'chip-btn'} aria-pressed={who === 'same'} onClick={() => setWho('same')}>Usual cleaner only</button>
            <button className={who === 'any' ? 'chip-btn active' : 'chip-btn'} aria-pressed={who === 'any'} onClick={() => setWho('any')}>Any cleaner</button>
          </div>
        )}
        <button disabled={slots.isPending || needWho} onClick={() => slots.mutate(undefined)}>{slots.isPending ? 'Looking…' : 'Find slots'}</button>
        {needWho && <p className="muted small">Ask the client whether they want their usual cleaner before searching.</p>}
        {!customer && <p className="muted small">Without a client, distance can't be used. Pick the client for the best match.</p>}
      </section>
      {slots.isError && <div className="error">{(slots.error as Error).message}</div>}
      {slots.data && (
        <section className="sch-list">
          <p className="muted small">
            {slots.data.cleaner === 'same' ? (
              slots.data.slots.length
                ? `Only ${slots.data.customer?.main} (usual cleaner), as the client asked.${slots.data.kind !== 'one' ? ' Recurring slots are free on every date for the next 8 weeks.' : ''}`
                : `${slots.data.customer?.main} (usual cleaner) isn't free for that. Try other days or times to keep them${slots.data.any_count ? `, or offer another cleaner: ${slots.data.any_count} slot${slots.data.any_count === 1 ? '' : 's'} open.` : '. No other cleaner is free either.'}`
            ) : (
              <>
                {slots.data.no_usual && `${slots.data.customer?.name || 'This client'} has no usual cleaner yet, so these are open to any cleaner. `}
                {slots.data.slots.length ? `Best ${slots.data.frequency.toLowerCase()} slots. Recurring slots are free on every date for the next 8 weeks.` : 'No cleaner is free for that. Try other days, a shorter clean, or a later start date.'}
                {slots.data.customer?.main && (slots.data.slots.some((x) => x.cleaner.name === slots.data!.customer!.main)
                  ? ` ${slots.data.customer.main} (usual cleaner) is ranked first where free.`
                  : ` ${slots.data.customer.main} (usual cleaner) isn't free at those times: try other days or times to keep them.`)}
              </>
            )}
          </p>
          {slots.data.cleaner === 'same' && !slots.data.slots.length && !!slots.data.any_count && (
            <button className="secondary sch-any-instead" onClick={anyInstead}>Show slots with any cleaner</button>
          )}
          {slots.data.slots.map((s) => (
            <article key={`${s.cleaner.id}-${s.date}`} className="card sch-slot">
              <div className="sch-slot-when">
                <b>{niceDate(s.date)} · {s.time}–{s.end}</b>
                <span className="muted small">{s.repeats > 1 ? `Repeats ${s.repeats} times in 8 weeks · weeks ${s.weeks.split('').join('/')}` : 'One visit'}</span>
              </div>
              <div className="sch-who"><CleanerDot color={s.cleaner.color} /><Link to={`/schedule/cleaner/${s.cleaner.id}`} className="seg-name">{s.cleaner.name}</Link>{s.cleaner.is_new && <span className="seg-trait">New hire</span>}</div>
              <Reasons reasons={s.reasons} />
              {reschedule ? <button onClick={() => moveTo(s)}>Move to this slot</button> : <button onClick={() => book(s)}>Book this slot</button>}
            </article>
          ))}
        </section>
      )}
    </div>
  );
}


// A change belongs to the brand of its visit's location, or of the cleaner when there is no visit.
function changeInView(brand: ReturnType<typeof useBrand>, c: Change) {
  if (c.visit) return brand.showLocation(c.visit.location_id);
  if (c.cleaner) return brand.showCleaner(c.cleaner.location_ids);
  return true;
}

function CleanerBrand({ ids }: { ids?: number[] }) {
  const brand = useBrand();
  const b = brand.cleanerBrands(ids);
  return <BrandPill brand={b[0] ?? null} shared={b.length > 1} />;
}
