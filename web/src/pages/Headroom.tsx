// Headroom (read-only report, limited to the logins in HEADROOM_EMAILS): how much room is left
// in cleaners' availability once booked work is placed, raw and after travel and fragments.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useBrand } from '../brands/useBrand';
import { brandLabel } from '../brands/ui';
import { reportsApi, pct, type HeadroomReport, type HeadroomStatus } from '../reports/api';
import { weekLabel } from '../reports/ui';

const WINDOWS = [1, 2, 4, 8];
// Categorical order for areas (validated for colour-blind separation); each line is also labelled.
const AREA_COLOR: Record<string, string> = { Central: '#2a78d6', North: '#eb6834', South: '#1baf7a', East: '#eda100', West: '#e87ba4' };
const h = (n: number | null | undefined) => (n == null ? '—' : `${n.toLocaleString('en-CA', { maximumFractionDigits: 1 })} h`);

export function HeadroomPage() {
  const [weeks, setWeeks] = useState(4);
  const brand = useBrand();
  const q = useQuery({ queryKey: ['reports', 'headroom', weeks, brand.locationIds], queryFn: () => reportsApi.headroom(weeks, brand.locationIds), retry: false, placeholderData: (p) => p });
  const r = q.data;
  return (
    <div className="seg-page">
      <header className="page-header">
        <div className="seg-head">
          <span className="small muted">Reports · only you can see this</span>
          <h1>Headroom{brand.view !== 'both' && <span className="muted"> · {brandLabel(brand.view)}</span>}</h1>
          <p className="muted">Room left in cleaners' availability once booked work is placed. Monday to Saturday; Sundays are left out everywhere.</p>
          {r && <span className="small muted">{weekLabel(r.from)} – {weekLabel(r.to)} · schedule copy from {r.taken_at ? new Date(r.taken_at).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' }) : '—'}</span>}
        </div>
        <div className="seg-period" role="group" aria-label="Window">
          {WINDOWS.map((w) => (
            <button key={w} className={weeks === w ? 'active' : ''} aria-pressed={weeks === w} onClick={() => setWeeks(w)}>Next {w} {w === 1 ? 'week' : 'weeks'}</button>
          ))}
        </div>
      </header>
      {q.isError && (
        <section className="card seg-empty">
          <h2>Headroom isn't available</h2>
          <p className="muted">{(q.error as Error).message}</p>
        </section>
      )}
      {r && <Report r={r} />}
    </div>
  );
}

function Status({ s, pctValue }: { s: HeadroomStatus; pctValue?: number | null }) {
  if (!s) return <span className="muted">—</span>;
  const label = s === 'red' ? 'RED' : s === 'amber' ? 'Tight' : 'OK';
  const icon = s === 'red' ? '▲' : s === 'amber' ? '●' : '✓';
  return <span className={`hr-status ${s}`}><span aria-hidden>{icon}</span> {label}{pctValue !== undefined && <> · {pct(pctValue)}</>}</span>;
}

function Report({ r }: { r: HeadroomReport }) {
  const t = r.totals;
  const c = r.config;
  return (
    <>
      <div className="seg-stats hr-stats">
        <Card label="Usable availability" value={h(t.available_h)} note={`cleaners taking bookings${t.closed_h ? ` · after ${h(t.closed_h)} of closed dates` : ''}`} />
        <Card label="Assigned" value={h(t.assigned_h)} note="booked time; two-cleaner jobs count for both" />
        <Card label="Unassigned" value={h(t.unassigned_h)} note={`${t.unassigned_visits} visits · the sales-to-ops handoff gap`} tone={t.unassigned_visits ? 'warn' : undefined} />
        <section className="card seg-stat">
          <span className="muted small">Headroom</span>
          <div className="hr-pair">
            <div><span className="small muted">Raw</span><b className="seg-stat-value small">{h(t.raw_h)}</b><span className="small">{pct(t.raw_pct)}</span></div>
            <div><span className="small muted">Adjusted</span><b className="seg-stat-value small">{h(t.adjusted_h)}</b><span className="small">{pct(t.adjusted_pct)}</span></div>
          </div>
        </section>
        <section className="card seg-stat">
          <span className="muted small">Status</span>
          <span className="seg-stat-value small"><Status s={t.status} /></span>
          <span className="small">adjusted · RED at {pct(c.red_at)} or less · raw is <Status s={t.raw_status} /></span>
        </section>
        <section className="card seg-stat">
          <span className="muted small">Cleaners : customers</span>
          <span className="seg-stat-value small">{r.ratio.cleaners} : {r.ratio.customers}</span>
          <span className="small">1 : {r.ratio.per_cleaner ?? '—'} · recurring only {r.ratio.cleaners} : {r.ratio.customers_recurring} (1 : {r.ratio.per_cleaner_recurring ?? '—'})</span>
        </section>
      </div>

      <div className="seg-two">
        <Waterfall r={r} />
        <section className="card rep-card">
          <h2>How it's worked out</h2>
          <ul className="hr-notes small">
            <li><b>Raw</b> = availability − assigned − unassigned{t.not_taking_h ? ' − work on cleaners not taking bookings' : ''}. This is the number to check by hand.</li>
            <li><b>Travel</b>: each cleaner's real route each day: home → 1st visit → … → last{c.travel_return_home ? ' → home' : ''}, timed by the planner's drive model. A missing map pin counts {c.travel_fallback_min} min. Unassigned visits count one average leg ({c.avg_leg_min} min).</li>
            <li><b>Fragments</b>: open stretches under {c.fragment_h} h left between visits and travel; too short to book.</li>
            <li><b>Availability</b>: Launch27 hours (that date's own hours when set), minus days off, days marked unavailable here and company closed dates (unless the cleaner set hours that day).</li>
          </ul>
          <TravelRef r={r} />
        </section>
      </div>

      <Reconcile r={r} />

      <section className="card flush">
        <div className="seg-table-head"><h2>By area</h2><span className="muted small">Cleaners by home base; unassigned visits and customers by the visit's address</span></div>
        <div className="table-scroll">
          <table className="seg-table">
            <thead><tr><th>Area</th><th className="num">Cleaners</th><th className="num">Customers</th><th className="num">Ratio</th><th className="num">Available</th><th className="num">Assigned</th><th className="num">Unassigned</th><th className="num">Raw headroom</th><th className="num">Adjusted headroom</th><th>Status</th></tr></thead>
            <tbody>
              {r.areas.map((a) => (
                <tr key={a.area}>
                  <td><span className="seg-swatch" style={{ background: AREA_COLOR[a.area] || '#94a3b8' }} /> {a.area}</td>
                  <td className="num">{a.cleaners}</td>
                  <td className="num">{a.customers}</td>
                  <td className="num">{a.customers_per_cleaner == null ? '—' : `1 : ${a.customers_per_cleaner}`}</td>
                  <td className="num">{h(a.available_h)}</td>
                  <td className="num">{h(a.assigned_h)}</td>
                  <td className="num">{h(a.unassigned_h)}{a.unassigned_visits ? <span className="muted small"> · {a.unassigned_visits}</span> : null}</td>
                  <td className="num">{pct(a.raw_pct)}<span className="muted small"> · {h(a.raw_h)}</span></td>
                  <td className="num">{pct(a.adjusted_pct)}<span className="muted small"> · {h(a.adjusted_h)}</span></td>
                  <td><Status s={a.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {r.areas.some((a) => !a.cleaners && (a.unassigned_h || a.assigned_h)) && <p className="small muted hr-foot">An area with work but no cleaner taking bookings shows no availability: its headroom is negative.</p>}
      </section>

      <section className="card flush">
        <div className="seg-table-head"><h2>By cleaner: key-person risk</h2><span className="muted small">"If they left" = their assigned hours ÷ their area's adjusted headroom. Over 100% pushes the area below zero.</span></div>
        <div className="table-scroll">
          <table className="seg-table">
            <thead><tr><th>Cleaner</th><th>Area</th><th className="num">Available</th><th className="num">Assigned</th><th className="num">Headroom</th><th className="num">Utilization</th><th className="num">If they left</th></tr></thead>
            <tbody>
              {r.cleaners.map((x) => (
                <tr key={x.cleaner_id}>
                  <td><Link to={`/reports/cleaners/${x.cleaner_id}`} className="seg-name">{x.name}</Link>{x.status_label && x.status_label !== 'Active' && <span className="seg-trait">{x.status_label}</span>}</td>
                  <td className="muted">{x.area}</td>
                  <td className="num">{h(x.available_h)}</td>
                  <td className="num">{h(x.assigned_h)}</td>
                  <td className={`num${x.headroom_h < 0 ? ' warn' : ''}`}>{h(x.headroom_h)}</td>
                  <td className="num">{pct(x.utilization)}</td>
                  <td className="num" title={x.if_left_raw == null ? undefined : `${pct(x.if_left_raw)} of raw headroom`}>
                    {x.area_negative ? <span className="hr-status red">area already negative</span> : x.if_left != null && x.if_left > 1 ? <span className="hr-status red">{pct(x.if_left)}</span> : pct(x.if_left)}
                  </td>
                </tr>
              ))}
              {r.cleaners.length === 0 && <tr><td colSpan={7} className="muted">No cleaners taking bookings in this view.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card seg-chart-card">
        <div className="seg-section-head"><h2>Adjusted headroom by week</h2><span className="muted small">Next {r.trend.length} weeks, by area · RED line at {pct(c.red_at)}</span></div>
        <TrendChart r={r} />
      </section>
    </>
  );
}

function Card({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: 'warn' }) {
  return (
    <section className="card seg-stat">
      <span className="muted small">{label}</span>
      <span className={tone === 'warn' ? 'seg-stat-value rep-warn' : 'seg-stat-value'}>{value}</span>
      {note && <span className="small">{note}</span>}
    </section>
  );
}

// Availability → − travel → − fragments → − assigned → − unassigned → = adjusted headroom.
function Waterfall({ r }: { r: HeadroomReport }) {
  const t = r.totals;
  const steps: { label: string; value: number; kind: 'total' | 'minus' | 'result' }[] = [
    { label: 'Usable availability', value: t.available_h, kind: 'total' },
    { label: 'Travel', value: t.travel_h, kind: 'minus' },
    { label: 'Fragments', value: t.fragments_h, kind: 'minus' },
    { label: 'Assigned', value: t.assigned_h, kind: 'minus' },
    { label: 'Unassigned', value: t.unassigned_h, kind: 'minus' },
    ...(t.not_taking_h ? [{ label: 'On cleaners not taking bookings', value: t.not_taking_h, kind: 'minus' as const }] : []),
    { label: 'Adjusted headroom', value: t.adjusted_h, kind: 'result' },
  ];
  const max = Math.max(t.available_h, 1);
  const min = Math.min(0, t.adjusted_h);
  const span = max - min;
  const x = (v: number) => ((v - min) / span) * 100;
  let run = t.available_h;
  return (
    <section className="card rep-card">
      <h2>Deduction waterfall</h2>
      <span className="muted small">Raw headroom skips travel and fragments: {h(t.raw_h)} ({pct(t.raw_pct)})</span>
      <div className="hr-fall">
        {steps.map((s) => {
          let from = 0, to = 0;
          if (s.kind === 'total') [from, to] = [0, s.value];
          else if (s.kind === 'minus') { from = run - s.value; to = run; run -= s.value; }
          else [from, to] = s.value >= 0 ? [0, s.value] : [s.value, 0];
          const left = x(Math.min(from, to));
          const width = Math.max(x(Math.max(from, to)) - left, 0.4);
          return (
            <div key={s.label} className="hr-fall-row" title={`${s.label}: ${s.kind === 'minus' ? '−' : ''}${h(s.value)}`}>
              <span className="hr-fall-label">{s.kind === 'minus' ? '− ' : s.kind === 'result' ? '= ' : ''}{s.label}</span>
              <div className="hr-fall-track">
                {min < 0 && <span className="hr-fall-zero" style={{ left: `${x(0)}%` }} />}
                <span className={`hr-fall-bar ${s.kind}${s.kind === 'result' ? ` ${t.status}` : ''}`} style={{ left: `${left}%`, width: `${width}%` }} />
              </div>
              <b className="hr-fall-value">{s.kind === 'minus' ? '−' : ''}{h(s.value)}</b>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TravelRef({ r }: { r: HeadroomReport }) {
  const tr = r.travel_reference;
  if (!tr) return null;
  return (
    <p className="seg-insight small">
      <b>Travel cross-check.</b> The route model averages <b>{r.config.avg_leg_min} min</b> a leg over the upcoming schedule ({tr.estimated.legs} legs).{' '}
      {tr.measured.visits
        ? <>Cleaners' own "en route" taps → check-in, past 13 weeks: typical <b>{tr.measured.median_min} min</b> (average {tr.measured.average_min}) over {tr.measured.visits} visits ({pct(tr.measured.share_tapped)} of checked-in visits tap). Those include the trip from home and waiting to start, so they read a little higher.</>
        : <>No "en route" taps to compare with yet (they come from the nightly report copy).</>}
    </p>
  );
}

function Reconcile({ r }: { r: HeadroomReport }) {
  const k = r.reconcile;
  if (!k) return null;
  const tick = (ok: boolean) => (ok ? <span className="hr-status green">✓ ties</span> : <span className="hr-status red">▲ doesn't tie</span>);
  return (
    <section className="card rep-card">
      <div className="seg-section-head"><h2>Ties to Scheduling insights</h2><span className="muted small">Its figures, step by step to this page's. Hours: its 4-week window. Visits: this page's {r.weeks}-week window.</span></div>
      <div className="hr-recon">
        <div>
          <span className="muted small">Available hours</span>
          <span>{h(k.capacity.existing)} <span className="muted">− Sundays {h(k.capacity.sundays)} − closed dates {h(k.capacity.closed)} − other brand {h(k.capacity.other_brand)}{k.capacity.floor ? ` − overbooked days ${h(k.capacity.floor)}` : ''}</span> = <b>{h(k.capacity.result)}</b></span>
          {tick(k.capacity.ties)}
        </div>
        <div>
          <span className="muted small">Assigned hours</span>
          <span>{h(k.booked.existing)} <span className="muted">− Sundays {h(k.booked.sundays)} − other brand {h(k.booked.other_brand)}</span> = <b>{h(k.booked.result)}</b></span>
          {tick(k.booked.ties)}
        </div>
        <div>
          <span className="muted small">"No cleaner yet" visits</span>
          <span>{k.unassigned.existing} <span className="muted">− other brand {k.unassigned.other_brand} − Sundays {k.unassigned.sundays} − after this window {k.unassigned.later}</span> = <b>{k.unassigned.result}</b></span>
          {tick(k.unassigned.ties)}
        </div>
      </div>
    </section>
  );
}

function TrendChart({ r }: { r: HeadroomReport }) {
  const [hover, setHover] = useState<number | null>(null);
  const pts = r.trend;
  const areas = r.areas.map((a) => a.area).filter((a) => pts.some((p) => p.areas[a] != null));
  const vals = pts.flatMap((p) => [p.total, ...areas.map((a) => p.areas[a])]).filter((v): v is number => v != null);
  if (!pts.length || !vals.length) return <p className="muted small">No availability in the next weeks.</p>;
  const lo = Math.min(0, Math.floor(Math.min(...vals) * 10) / 10);
  const hi = Math.max(0.4, Math.ceil(Math.max(...vals) * 10) / 10);
  const W = 760, H = 260, L = 48, R = 76, T = 14, B = 28;
  const x = (i: number) => L + (i * (W - L - R)) / Math.max(pts.length - 1, 1);
  const y = (v: number) => T + ((hi - v) / (hi - lo)) * (H - T - B);
  const step = hi - lo > 1 ? 0.4 : 0.2;
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);
  const series = [...areas.map((a) => ({ key: a, color: AREA_COLOR[a] || '#94a3b8', get: (p: HeadroomReport['trend'][number]) => p.areas[a] })), { key: 'All areas', color: '#111827', get: (p: HeadroomReport['trend'][number]) => p.total }];
  // End labels, nudged apart so they don't collide.
  const ends = series.map((s) => ({ s, v: s.get(pts[pts.length - 1]) })).filter((e) => e.v != null).map((e) => ({ ...e, y: y(e.v as number) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
  const hp = hover != null ? pts[hover] : null;
  const red = r.config.red_at;
  return (
    <div className="seg-chart">
      <ul className="hr-legend small">
        {series.map((s) => <li key={s.key}><span className="seg-swatch" style={{ background: s.color }} />{s.key}</li>)}
        <li><span className="hr-legend-dash" />RED at {pct(red)}</li>
      </ul>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Adjusted headroom by week and area; all areas from ${pct(pts[0].total)} to ${pct(pts[pts.length - 1].total)}`} onMouseLeave={() => setHover(null)}>
        {ticks.map((v) => (
          <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="seg-grid" /><text x={L - 8} y={y(v) + 4} textAnchor="end" className="seg-axis">{pct(v)}</text></g>
        ))}
        <line x1={L} x2={W - R} y1={y(red)} y2={y(red)} stroke="#b91c1c" strokeDasharray="5 5" strokeWidth="1.5" />
        {pts.map((p, i) => (i % 2 === 0 || i === pts.length - 1 ? <text key={p.week} x={x(i)} y={H - 8} textAnchor="middle" className="seg-axis">{weekLabel(p.week)}</text> : null))}
        {series.map((s) => {
          const segs = pts.map((p, i) => (s.get(p) == null ? null : `${x(i)},${y(s.get(p) as number)}`)).filter(Boolean);
          return <polyline key={s.key} points={segs.join(' ')} fill="none" stroke={s.color} strokeWidth={s.key === 'All areas' ? 2.5 : 2} strokeLinejoin="round" />;
        })}
        {ends.map((e) => <text key={e.s.key} x={W - R + 8} y={e.y + 4} className="seg-axis">{e.s.key === 'All areas' ? 'All' : e.s.key} {pct(e.v)}</text>)}
        {hp && <line x1={x(hover!)} x2={x(hover!)} y1={T} y2={H - B} className="seg-crosshair" />}
        {hp && series.map((s) => (s.get(hp) == null ? null : <circle key={s.key} cx={x(hover!)} cy={y(s.get(hp) as number)} r={4.5} fill={s.color} stroke="#fff" strokeWidth={2} />))}
        {pts.map((p, i) => <rect key={`h${p.week}`} x={x(i) - (W - L - R) / pts.length / 2} y={T} width={(W - L - R) / pts.length} height={H - T - B} fill="transparent" onMouseEnter={() => setHover(i)} />)}
      </svg>
      {hp && (
        <div className="seg-tip" style={{ left: `${(x(hover!) / W) * 100}%` }}>
          <div className="muted small">Week of {weekLabel(hp.week)}{hover === 0 ? ' (from today)' : ''}</div>
          {series.map((s) => <div key={s.key} className="hr-tip-row"><span className="seg-swatch" style={{ background: s.color }} />{s.key}<b>{pct(s.get(hp))}</b></div>)}
        </div>
      )}
    </div>
  );
}
