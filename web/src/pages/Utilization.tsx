// Utilization (read-only report; everyone can see it): of the hours cleaners have open,
// how much is already spoken for (assigned, unassigned, travel) and how much is left to book.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useBrand } from '../brands/useBrand';
import { brandLabel } from '../brands/ui';
import { reportsApi, pct, type DataFlag, type UtilFigures, type UtilizationReport } from '../reports/api';
import { weekLabel } from '../reports/ui';

const AREAS = ['Central', 'North', 'South', 'East', 'West'];
// Fixed colour per area (validated for colour-blind separation); lines are also labelled.
const AREA_COLOR: Record<string, string> = { Central: '#2a78d6', North: '#eb6834', South: '#1baf7a', East: '#eda100', West: '#e87ba4' };
// The parts of the hours: same colours everywhere on the page.
const PART = { assigned: '#2a78d6', unassigned: '#eb6834', not_taking: '#e87ba4', travel: '#eda100' };

const h = (n: number | null | undefined) => (n == null ? '—' : `${n.toLocaleString('en-CA', { maximumFractionDigits: 1 })} h`);
const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T12:00:00`);
  x.setDate(x.getDate() + n);
  return iso(x);
};
const dayName = (d: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' }) => new Date(`${d}T12:00:00`).toLocaleDateString('en-CA', opts);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00`) - Date.parse(`${a}T12:00:00`)) / 86_400_000) + 1;

export function UtilizationPage() {
  const brand = useBrand();
  // null = the server's default (its today … 6 days later, Toronto time).
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [area, setArea] = useState<string | null>(null);
  const [tab, setTab] = useState<'report' | 'check'>('report');
  const q = useQuery({
    queryKey: ['reports', 'utilization', range?.from, range?.to, brand.locationIds],
    queryFn: () => reportsApi.utilization(range?.from ?? null, range?.to ?? null, brand.locationIds),
    retry: false,
    placeholderData: (p) => p,
  });
  const r = q.data;
  return (
    <div className="seg-page">
      <header className="page-header ut-header">
        <div className="seg-head">
          <span className="small muted">Reports</span>
          <h1>Utilization{brand.view !== 'both' && <span className="muted"> · {brandLabel(brand.view)}</span>}</h1>
          <p className="muted">How much of our cleaners' open time is already spoken for, and how much is left to book. Monday to Saturday.</p>
        </div>
        {r && <RangePicker value={range || { from: r.from, to: r.to }} onChange={setRange} today={r.today} maxTo={r.max_to} />}
      </header>
      <div className="ut-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'report'} className={tab === 'report' ? 'active' : ''} onClick={() => setTab('report')}>Utilization</button>
        <button role="tab" aria-selected={tab === 'check'} className={tab === 'check' ? 'active' : ''} onClick={() => setTab('check')}>
          Data check{r && issues(r) > 0 && <span className="ut-badge">{issues(r)}</span>}
        </button>
      </div>
      <div className="ut-areas" role="group" aria-label="Area">
        {[null, ...AREAS].map((a) => (
          <button key={a || 'all'} className={area === a ? 'active' : ''} aria-pressed={area === a} onClick={() => setArea(a)}>
            {a && <span className="seg-swatch" style={{ background: AREA_COLOR[a] }} />}
            {a ? `${a} Ottawa` : 'All areas'}
          </button>
        ))}
      </div>
      {q.isError && (
        <section className="card seg-empty">
          <h2>Utilization isn't available</h2>
          <p className="muted">{(q.error as Error).message}</p>
        </section>
      )}
      {r && (tab === 'report' ? <Report r={r} area={area} setArea={setArea} /> : <DataCheckView r={r} area={area} />)}
    </div>
  );
}

const issues = (r: UtilizationReport) => r.data_check.cleaners.filter((c) => c.flags.length).length;

// ---------- data check: what the report knows from Launch27, per cleaner ----------
const FLAG_HELP: Record<DataFlag, string> = {
  refused: "Launch27 didn't hand over their hours. Usually the login the planner used isn't allowed to read Team Availability, or Launch27 got too many requests at once. Their available hours count as 0 until fixed.",
  booked_no_hours: 'They have bookings in these dates but 0 available hours, so their bookings push the area "over". Check their Team Availability in Launch27.',
  booked_not_taking: 'Their title code says they are not taking bookings ((3), (X), On hold or no code), yet they have bookings. Either the code or the bookings need updating.',
  no_hours: 'Launch27 answered, but no weekly hours are set for them.',
  no_home: "Their Launch27 profile has no map location (usually a missing or incomplete home address), so their area shows as Unknown.",
};
function DataCheckView({ r, area }: { r: UtilizationReport; area: string | null }) {
  const dc = r.data_check;
  const [only, setOnly] = useState<DataFlag | null>(null);
  const rows = dc.cleaners.filter((c) => (!area || c.area === area) && (!only || c.flags.some((f) => f.kind === only)));
  const flagged = dc.cleaners.filter((c) => c.flags.length).length;
  const when = dc.refreshed_at ? new Date(dc.refreshed_at).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  return (
    <>
      <section className="card ut-summary">
        <span className="muted small">{dayName(r.from)} – {dayName(r.to)}{area ? ` · ${area} Ottawa` : ''}</span>
        <span className={`ut-big${flagged ? ' warn' : ''}`}>{flagged ? `${flagged} ${flagged === 1 ? 'cleaner needs' : 'cleaners need'} a look` : 'No data problems found'}</span>
        <span className="ut-sub">
          Cleaners' hours were last read from Launch27 on <b>{when}</b>{dc.read_by === 'sync' ? ' by the automatic sync login' : dc.read_by === 'person' ? " with the login of someone who opened the planner (production has no sync login set up yet, so it refreshes only when the planner is open)" : ''}.
          {' '}To re-read now: Scheduling planner → Refresh now.
        </span>
        <div className="ut-flagchips">
          {(Object.keys(dc.labels) as DataFlag[]).map((k) => (
            <button key={k} className={`ut-flagchip${only === k ? ' active' : ''}${dc.counts[k] ? ' has' : ''}`} onClick={() => setOnly(only === k ? null : k)} title={FLAG_HELP[k]}>
              <b>{dc.counts[k]}</b> {dc.labels[k]}
            </button>
          ))}
        </div>
        {only && <p className="small muted ut-flaghelp">{FLAG_HELP[only]}</p>}
      </section>
      <section className="card flush">
        <div className="seg-table-head"><h2>By cleaner{area && ` · ${area}`}</h2><span className="muted small">Cleaners taking bookings, plus anyone else with bookings in these dates. Problems first.</span></div>
        <div className="table-scroll">
          <table className="seg-table">
            <thead><tr><th>Cleaner</th><th>What to check</th><th>Status</th><th>Area</th><th className="num">Weekly hours in Launch27</th><th className="num">Available</th><th className="num">Booked</th></tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.cleaner_id}>
                  <td><Link to={`/schedule/cleaner/${c.cleaner_id}`} className="seg-name">{c.name}</Link></td>
                  <td>
                    {c.flags.length === 0 ? <span className="ut-tick ok">✓ looks fine</span> : (
                      <ul className="ut-flags">
                        {c.flags.map((f) => <li key={f.kind}>{f.kind === 'refused' && c.availability_error ? c.availability_error : f.label}</li>)}
                      </ul>
                    )}
                  </td>
                  <td className={c.taking ? '' : 'warn'}>{c.status_label || '—'}{!c.taking && <span className="muted small"> · not taking</span>}</td>
                  <td className={c.home_location ? 'muted' : 'warn'}>{c.home_location ? c.area : 'Unknown · no home location'}</td>
                  <td className="num">{c.availability_error ? <span className="warn">—</span> : c.weekly_hours ? h(c.weekly_hours) : <span className="warn">none set</span>}{c.dated_rows > 0 && <span className="muted small"> · {c.dated_rows} date changes</span>}</td>
                  <td className="num">{h(c.available_h)}</td>
                  <td className="num">{h(c.booked_h)}<span className="muted small"> · {c.visits} {c.visits === 1 ? 'visit' : 'visits'}</span></td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={7} className="muted">Nothing to show.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

// ---------- date range: presets + a calendar (click a start and an end, or drag) ----------
function RangePicker({ value, onChange, today: t, maxTo }: { value: { from: string; to: string }; onChange: (v: { from: string; to: string }) => void; today: string; maxTo: string }) {
  const [open, setOpen] = useState(false);
  const presets = [1, 2, 4, 8].map((w) => ({ label: `${w} ${w === 1 ? 'week' : 'weeks'}`, from: t, to: addDays(t, w * 7 - 1) > maxTo ? maxTo : addDays(t, w * 7 - 1) }));
  const active = presets.find((p) => p.from === value.from && p.to === value.to);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const n = daysBetween(value.from, value.to);
  return (
    <div className="ut-range" ref={ref}>
      <div className="seg-period" role="group" aria-label="Dates">
        <span className="ut-next muted small">Next</span>
        {presets.map((p) => (
          <button key={p.label} className={active === p ? 'active' : ''} aria-pressed={active === p} onClick={() => { onChange({ from: p.from, to: p.to }); setOpen(false); }}>{p.label}</button>
        ))}
        <button className={!active ? 'active ut-cal-btn' : 'ut-cal-btn'} aria-expanded={open} onClick={() => setOpen(!open)}>
          📅 {value.from === value.to ? dayName(value.from) : `${dayName(value.from, { month: 'short', day: 'numeric' })} – ${dayName(value.to, { month: 'short', day: 'numeric' })}`}
          <span className="muted"> · {n} {n === 1 ? 'day' : 'days'}</span>
        </button>
      </div>
      {open && <Calendar value={value} min={t} max={maxTo} onChange={(v, done) => { onChange(v); if (done) setOpen(false); }} />}
    </div>
  );
}

function Calendar({ value, min, max, onChange }: { value: { from: string; to: string }; min: string; max: string; onChange: (v: { from: string; to: string }, done: boolean) => void }) {
  const [month, setMonth] = useState(() => value.from.slice(0, 7));
  const [anchor, setAnchor] = useState<string | null>(null); // first click / drag start
  const [hover, setHover] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const first = new Date(`${month}-01T12:00:00`);
  const startPad = (first.getDay() + 6) % 7; // Monday first
  const daysIn = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const cells = [...Array(startPad).fill(null), ...Array.from({ length: daysIn }, (_, i) => `${month}-${pad(i + 1)}`)];
  const shift = (k: number) => {
    const d = new Date(first);
    d.setMonth(d.getMonth() + k);
    setMonth(iso(d).slice(0, 7));
  };
  const lo = anchor && hover ? (anchor < hover ? anchor : hover) : value.from;
  const hi = anchor && hover ? (anchor < hover ? hover : anchor) : value.to;
  const finish = (a: string, b: string) => {
    onChange(a <= b ? { from: a, to: b } : { from: b, to: a }, true);
    setAnchor(null);
    setHover(null);
    setDragging(false);
  };
  const canPrev = month > min.slice(0, 7);
  const canNext = month < max.slice(0, 7);
  return (
    <div className="ut-cal card" onMouseLeave={() => dragging && anchor && hover && finish(anchor, hover)}>
      <div className="ut-cal-head">
        <button className="icon-button" disabled={!canPrev} onClick={() => shift(-1)} aria-label="Previous month">‹</button>
        <b>{first.toLocaleDateString('en-CA', { month: 'long', year: 'numeric' })}</b>
        <button className="icon-button" disabled={!canNext} onClick={() => shift(1)} aria-label="Next month">›</button>
      </div>
      <div className="ut-cal-grid">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <span key={d} className="ut-cal-dow">{d}</span>)}
        {cells.map((d, i) => {
          if (!d) return <span key={`p${i}`} />;
          const off = d < min || d > max;
          const sel = d >= lo && d <= hi;
          const sun = new Date(`${d}T12:00:00`).getDay() === 0;
          return (
            <button
              key={d}
              disabled={off}
              className={`ut-cal-day${sel ? ' sel' : ''}${d === lo || d === hi ? ' end' : ''}${sun ? ' sun' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); setAnchor(d); setHover(d); setDragging(true); }}
              onMouseEnter={() => anchor && setHover(d)}
              onMouseUp={() => {
                if (!anchor) return;
                if (dragging && d !== anchor) finish(anchor, d);
                else setDragging(false); // a click: wait for the end date
              }}
              onClick={() => { if (anchor && !dragging && d !== anchor) finish(anchor, d); }}
              onDoubleClick={() => finish(d, d)}
            >
              {Number(d.slice(8))}
            </button>
          );
        })}
      </div>
      <p className="small muted ut-cal-help">{anchor ? 'Now pick the last day (or double-click for one day).' : 'Click the first day and then the last, or drag across. Sundays are left out of the numbers.'}</p>
    </div>
  );
}

// ---------- report ----------
function Report({ r, area, setArea }: { r: UtilizationReport; area: string | null; setArea: (a: string | null) => void }) {
  const a = area ? r.areas.find((x) => x.area === area) : null;
  const f: UtilFigures = a || r.totals;
  const cleaners = area ? r.cleaners.filter((c) => c.area === area) : r.cleaners;
  const days = r.by_day.map((d) => ({ date: d.date, ...(area ? d.areas[area] : d) }));
  return (
    <>
      <Summary r={r} f={f} area={area} />
      <section className="card flush">
        <div className="seg-table-head"><h2>By area</h2><span className="muted small">Cleaners by home address; unassigned visits by the client's address. "Room for" = about how many more typical bookings fit. Click a row to focus on it.</span></div>
        <div className="table-scroll">
          <table className="seg-table">
            <thead><tr><th>Area</th><th className="num">Cleaners</th><th className="num">Customers</th><th className="num">Available</th><th className="num">Assigned</th><th className="num">Unassigned</th><th className="num">Travel</th><th className="num">Left to book</th><th>Utilization</th><th className="num">Room for</th></tr></thead>
            <tbody>
              {r.areas.map((x) => (
                <tr key={x.area} className={`clickable${area === x.area ? ' ut-row-on' : ''}`} onClick={() => setArea(area === x.area ? null : x.area)}>
                  <td><span className="seg-swatch" style={{ background: AREA_COLOR[x.area] || '#94a3b8' }} /> {x.area}</td>
                  <td className="num">{x.cleaners}</td>
                  <td className="num">{x.customers}</td>
                  <td className="num">{h(x.available_h)}</td>
                  <td className="num">{h(x.assigned_h)}</td>
                  <td className="num">{h(x.unassigned_h)}{x.unassigned_visits ? <span className="muted small"> · {x.unassigned_visits}</span> : null}</td>
                  <td className="num">{h(x.travel_h)}</td>
                  <td className={`num${x.left_h < 0 ? ' warn' : ''}`}><b>{x.left_h < 0 ? `over by ${h(-x.left_h)}` : h(x.left_h)}</b></td>
                  <td><UtilBar u={x.utilization} /></td>
                  <td className="num">{x.room_bookings ? `≈ ${x.room_bookings}` : '—'}</td>
                </tr>
              ))}
              <tr className="ut-total">
                <td>All areas</td><td className="num">{r.totals.cleaners}</td><td className="num">{r.totals.customers}</td><td className="num">{h(r.totals.available_h)}</td><td className="num">{h(r.totals.assigned_h)}</td><td className="num">{h(r.totals.unassigned_h)}</td><td className="num">{h(r.totals.travel_h)}</td>
                <td className="num"><b>{h(r.totals.left_h)}</b></td><td><UtilBar u={r.totals.utilization} /></td><td className="num">{r.totals.room_bookings ? `≈ ${r.totals.room_bookings}` : '—'}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="card flush">
        <div className="seg-table-head"><h2>By day{area && ` · ${area}`}</h2><span className="muted small">Some days fill up before others: book into the days with hours left.</span></div>
        <div className="table-scroll ut-days">
          <table className="seg-table compact">
            <thead><tr><th>Day</th><th className="num">Available</th><th className="num">Spoken for</th><th className="num">Left to book</th><th>Utilization</th><th className="num">Room for</th></tr></thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.date}>
                  <td>{dayName(d.date)}</td>
                  <td className="num">{h(d.available_h)}</td>
                  <td className="num">{h(d.spoken_h)}</td>
                  <td className={`num${d.left_h < 0 ? ' warn' : ''}`}><b>{d.left_h < 0 ? `over by ${h(-d.left_h)}` : h(d.left_h)}</b></td>
                  <td><UtilBar u={d.utilization} /></td>
                  <td className="num">{d.room_bookings ? `≈ ${d.room_bookings}` : '—'}</td>
                </tr>
              ))}
              {days.length === 0 && <tr><td colSpan={6} className="muted">No Monday–Saturday in these dates.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card flush">
        <div className="seg-table-head"><h2>By cleaner{area && ` · ${area}`}</h2><span className="muted small">Fullest first. "If they left" = their booked + travel hours ÷ their area's hours left; over 100% means the area couldn't absorb their work.</span></div>
        <div className="table-scroll">
          <table className="seg-table">
            <thead><tr><th>Cleaner</th><th>Area</th><th className="num">Available</th><th className="num">Assigned</th><th className="num">Travel</th><th className="num">Left to book</th><th>Utilization</th><th className="num">If they left</th></tr></thead>
            <tbody>
              {cleaners.map((x) => (
                <tr key={x.cleaner_id}>
                  <td><Link to={`/reports/cleaners/${x.cleaner_id}`} className="seg-name">{x.name}</Link>{x.status_label && x.status_label !== 'Active' && <span className="seg-trait">{x.status_label}</span>}</td>
                  <td className="muted">{x.area}</td>
                  <td className="num">{h(x.available_h)}</td>
                  <td className="num">{h(x.assigned_h)}<span className="muted small"> · {x.visits} {x.visits === 1 ? 'visit' : 'visits'}</span></td>
                  <td className="num">{h(x.travel_h)}{x.travel_per_visit_min != null && <span className="muted small"> · {x.travel_per_visit_min} min each</span>}</td>
                  <td className={`num${x.left_h < 0 ? ' warn' : ''}`}>{x.left_h < 0 ? `over by ${h(-x.left_h)}` : h(x.left_h)}</td>
                  <td><UtilBar u={x.utilization} /></td>
                  <td className="num">{x.area_short ? <span className="warn">area has no room</span> : x.if_left != null && x.if_left > 1 ? <span className="warn">{pct(x.if_left)}</span> : pct(x.if_left)}</td>
                </tr>
              ))}
              {cleaners.length === 0 && <tr><td colSpan={8} className="muted">No cleaners taking bookings here.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card seg-chart-card">
        <div className="seg-section-head"><h2>Utilization by week</h2><span className="muted small">Next {r.trend.length} weeks{area ? ` · ${area} against all areas` : ', by area'}</span></div>
        <TrendChart r={r} area={area} />
      </section>

      <Reconcile r={r} />
    </>
  );
}

// The headline: plain-English sentence, the simple math, one bar.
function Summary({ r, f, area }: { r: UtilizationReport; f: UtilFigures; area: string | null }) {
  const over = f.left_h < 0;
  const parts = [
    { key: 'assigned', label: 'Assigned', value: f.assigned_h, color: PART.assigned },
    { key: 'unassigned', label: 'Unassigned', value: f.unassigned_h, color: PART.unassigned },
    ...(f.not_taking_h ? [{ key: 'not_taking', label: 'On cleaners not taking bookings', value: f.not_taking_h, color: PART.not_taking }] : []),
    { key: 'travel', label: 'Travel (est.)', value: f.travel_h, color: PART.travel },
  ];
  const scale = Math.max(f.available_h, f.spoken_h, 1);
  const when = r.from === r.to ? dayName(r.from, { weekday: 'long', month: 'short', day: 'numeric' }) : `${dayName(r.from)} – ${dayName(r.to)}`;
  return (
    <section className="card ut-summary">
      <span className="muted small">{when} · {area ? `${area} Ottawa` : 'All areas'}</span>
      <div className="ut-headline">
        <div>
          <span className={`ut-big${over ? ' warn' : ''}`}>{over ? `Over by ${h(-f.left_h)}` : `${h(f.left_h)} left to book`}</span>
          <span className="ut-sub">
            {over
              ? 'More work is booked than cleaners have open hours.'
              : f.room_bookings
                ? <>Room for about <b>{f.room_bookings} more bookings</b> (a typical {h(f.typical_booking_h)} visit plus about {r.avg_leg_min} min of driving).</>
                : 'No room for another typical booking.'}
          </span>
        </div>
        <div className="ut-util">
          <span className="ut-big">{pct(f.utilization)}</span>
          <span className="ut-sub">utilized: {h(f.spoken_h)} of {h(f.available_h)} spoken for</span>
        </div>
      </div>
      <div className="ut-math" aria-label="How the hours add up">
        <MathTile label="Available to assign" value={h(f.available_h)} note={f.closed_h ? `after ${h(f.closed_h)} of closed dates` : 'cleaners taking bookings'} />
        <span className="ut-op">−</span>
        <MathTile label="Assigned" value={h(f.assigned_h)} color={PART.assigned} />
        <span className="ut-op">−</span>
        <MathTile label="Unassigned" value={h(f.unassigned_h)} note={`${f.unassigned_visits} ${f.unassigned_visits === 1 ? 'visit' : 'visits'} · sales-to-ops handoff gap`} color={PART.unassigned} />
        {!!f.not_taking_h && <><span className="ut-op">−</span><MathTile label="On cleaners not taking bookings" value={h(f.not_taking_h)} note={`${f.not_taking_visits} ${f.not_taking_visits === 1 ? 'visit' : 'visits'} to move`} color={PART.not_taking} /></>}
        <span className="ut-op">−</span>
        <MathTile label="Travel (est.)" value={h(f.travel_h)} note="each cleaner's route, home and back" color={PART.travel} />
        <span className="ut-op">=</span>
        <MathTile label="Left to book" value={over ? `−${h(-f.left_h)}` : h(f.left_h)} strong />
      </div>
      <div className="ut-bar" role="img" aria-label={`${pct(f.utilization)} of available hours spoken for`}>
        {parts.map((p) => p.value > 0 && <span key={p.key} title={`${p.label}: ${h(p.value)}`} style={{ width: `${(p.value / scale) * 100}%`, background: p.color }} />)}
        {!over && f.left_h > 0 && <span className="ut-bar-left" title={`Left to book: ${h(f.left_h)}`} style={{ width: `${(f.left_h / scale) * 100}%` }} />}
      </div>
      <ul className="ut-legend small">
        {parts.map((p) => <li key={p.key}><span className="seg-swatch" style={{ background: p.color }} />{p.label}</li>)}
        <li><span className="seg-swatch ut-swatch-left" />Left to book</li>
      </ul>
    </section>
  );
}

function MathTile({ label, value, note, color, strong }: { label: string; value: string; note?: string; color?: string; strong?: boolean }) {
  return (
    <div className={`ut-tile${strong ? ' strong' : ''}`}>
      <span className="muted small">{color && <span className="seg-swatch" style={{ background: color }} />} {label}</span>
      <b>{value}</b>
      {note && <span className="small muted">{note}</span>}
    </div>
  );
}

function UtilBar({ u }: { u: number | null }) {
  if (u == null) return <span className="muted">—</span>;
  return (
    <span className="ut-ubar">
      <span className="ut-ubar-track"><span className={u > 1 ? 'over' : ''} style={{ width: `${Math.min(u, 1) * 100}%` }} /></span>
      <span className="ut-ubar-val">{pct(u)}</span>
    </span>
  );
}

function Reconcile({ r }: { r: UtilizationReport }) {
  const k = r.reconcile;
  if (!k) return null;
  const tick = (ok: boolean) => (ok ? <span className="ut-tick ok">✓ ties</span> : <span className="ut-tick bad">✗ doesn't tie</span>);
  const allOk = k.capacity.ties && k.booked.ties && k.unassigned.ties;
  return (
    <details className="card rep-card ut-check">
      <summary><b>Check the numbers</b> <span className="muted small">· ties to Scheduling insights {allOk ? '✓' : '✗'}</span></summary>
      <p className="small muted">Scheduling insights' own figures, step by step to this page's. Hours use its window ({weekLabel(k.hours_from)} – {weekLabel(k.hours_to)}); visits use the dates picked above.</p>
      <div className="ut-recon">
        <div><span className="muted small">Available hours</span><span>{h(k.capacity.existing)} <span className="muted">− Sundays {h(k.capacity.sundays)} − closed dates {h(k.capacity.closed)} − other brand {h(k.capacity.other_brand)}{k.capacity.floor ? ` − overbooked days ${h(k.capacity.floor)}` : ''}</span> = <b>{h(k.capacity.result)}</b></span>{tick(k.capacity.ties)}</div>
        <div><span className="muted small">Assigned hours</span><span>{h(k.booked.existing)} <span className="muted">− Sundays {h(k.booked.sundays)} − other brand {h(k.booked.other_brand)}</span> = <b>{h(k.booked.result)}</b></span>{tick(k.booked.ties)}</div>
        <div><span className="muted small">"No cleaner yet" visits</span><span>{k.unassigned.existing} <span className="muted">− other brand {k.unassigned.other_brand} − Sundays {k.unassigned.sundays} − outside these dates {k.unassigned.outside}</span> = <b>{k.unassigned.result}</b></span>{tick(k.unassigned.ties)}</div>
      </div>
    </details>
  );
}

function TrendChart({ r, area }: { r: UtilizationReport; area: string | null }) {
  const [hover, setHover] = useState<number | null>(null);
  const pts = r.trend;
  const areas = r.areas.map((a) => a.area).filter((a) => pts.some((p) => p.areas[a] != null));
  type Pt = UtilizationReport['trend'][number];
  const series = useMemo(() => {
    const list = (area ? [area] : areas).map((a) => ({ key: a, color: AREA_COLOR[a] || '#94a3b8', width: 2, get: (p: Pt) => p.areas[a] }));
    return [...list, { key: 'All areas', color: '#111827', width: area ? 1.5 : 2.5, get: (p: Pt) => p.total }];
  }, [area, areas]);
  const vals = pts.flatMap((p) => series.map((s) => s.get(p))).filter((v): v is number => v != null);
  if (!pts.length || !vals.length) return <p className="muted small">No availability in the next weeks.</p>;
  const lo = Math.min(0, Math.floor(Math.min(...vals) * 5) / 5);
  const hi = Math.max(1.2, Math.ceil(Math.max(...vals) * 5) / 5);
  const W = 760, H = 260, L = 48, R = 92, T = 14, B = 28;
  const x = (i: number) => L + (i * (W - L - R)) / Math.max(pts.length - 1, 1);
  const y = (v: number) => T + ((hi - v) / (hi - lo)) * (H - T - B);
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / 0.2) * 0.2; v <= hi + 1e-9; v += 0.2) ticks.push(Math.round(v * 100) / 100);
  const ends = series.map((s) => ({ s, v: s.get(pts[pts.length - 1]) })).filter((e) => e.v != null).map((e) => ({ ...e, y: y(e.v as number) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
  const hp = hover != null ? pts[hover] : null;
  return (
    <div className="seg-chart">
      <ul className="ut-legend small">
        {series.map((s) => <li key={s.key}><span className="seg-swatch" style={{ background: s.color }} />{s.key}</li>)}
        <li><span className="ut-legend-dash" />Fully booked (100%)</li>
      </ul>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Utilization by week; all areas from ${pct(pts[0].total)} to ${pct(pts[pts.length - 1].total)}`} onMouseLeave={() => setHover(null)}>
        {ticks.map((v) => <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="seg-grid" /><text x={L - 8} y={y(v) + 4} textAnchor="end" className="seg-axis">{pct(v)}</text></g>)}
        <line x1={L} x2={W - R} y1={y(1)} y2={y(1)} stroke="#334155" strokeDasharray="5 5" strokeWidth="1.5" />
        {pts.map((p, i) => (i % 2 === 0 || i === pts.length - 1 ? <text key={p.week} x={x(i)} y={H - 8} textAnchor="middle" className="seg-axis">{weekLabel(p.week)}</text> : null))}
        {series.map((s) => <polyline key={s.key} points={pts.map((p, i) => (s.get(p) == null ? null : `${x(i)},${y(s.get(p) as number)}`)).filter(Boolean).join(' ')} fill="none" stroke={s.color} strokeWidth={s.width} strokeLinejoin="round" />)}
        {ends.map((e) => <text key={e.s.key} x={W - R + 8} y={e.y + 4} className="seg-axis">{e.s.key === 'All areas' ? 'All' : e.s.key} {pct(e.v)}</text>)}
        {hp && <line x1={x(hover!)} x2={x(hover!)} y1={T} y2={H - B} className="seg-crosshair" />}
        {hp && series.map((s) => (s.get(hp) == null ? null : <circle key={s.key} cx={x(hover!)} cy={y(s.get(hp) as number)} r={4.5} fill={s.color} stroke="#fff" strokeWidth={2} />))}
        {pts.map((p, i) => <rect key={`h${p.week}`} x={x(i) - (W - L - R) / pts.length / 2} y={T} width={(W - L - R) / pts.length} height={H - T - B} fill="transparent" onMouseEnter={() => setHover(i)} />)}
      </svg>
      {hp && (
        <div className="seg-tip" style={{ left: `${(x(hover!) / W) * 100}%` }}>
          <div className="muted small">Week of {weekLabel(hp.week)}{hover === 0 ? ' (from today)' : ''}</div>
          {series.map((s) => <div key={s.key} className="ut-tip-row"><span className="seg-swatch" style={{ background: s.color }} />{s.key}<b>{pct(s.get(hp))}</b></div>)}
        </div>
      )}
    </div>
  );
}
