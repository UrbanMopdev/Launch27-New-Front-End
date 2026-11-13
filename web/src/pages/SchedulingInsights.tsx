import { useBrand } from '../brands/useBrand';
import { brandLabel } from '../brands/ui';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { reportsApi, pct, type Period, type SchedulingReport } from '../reports/api';
import { Kpi, NotBuilt, PeriodPicker, ReportStatusLine, weekLabel } from '../reports/ui';

const GOAL = 0.85;

export function SchedulingInsightsPage() {
  const [period, setPeriod] = useState<Period>('13w');
  const brand = useBrand();
  const q = useQuery({ queryKey: ['reports', 'scheduling', period, brand.locationIds], queryFn: () => reportsApi.scheduling(period, brand.locationIds), retry: false, placeholderData: (p) => p });
  const r = q.data;
  return (
    <div className="seg-page">
      <header className="page-header">
        <div className="seg-head">
          <span className="small muted">Reports</span>
          <h1>Scheduling insights{brand.view !== 'both' && <span className="muted"> · {brandLabel(brand.view)}</span>}</h1>
          <p className="muted">Same cleaner, full weeks, on time, short drives.</p>
          <ReportStatusLine />
        </div>
        <PeriodPicker value={period} onChange={setPeriod} />
      </header>
      {q.isError && <NotBuilt message={(q.error as Error).message} />}
      {r && (
        <>
          <div className="seg-stats">
            <Kpi label="Same cleaner" value={pct(r.kpis.same_cleaner)} note={`of ${r.kpis.same_cleaner_visits} recurring visits · goal ${pct(GOAL)}`} tone={r.kpis.same_cleaner != null && r.kpis.same_cleaner < 0.7 ? 'warn' : undefined} />
            <Kpi label="On time" value={pct(r.kpis.on_time, 1)} note={r.kpis.late_avg ? `late ones by ${r.kpis.late_avg} min on average` : `${r.kpis.check_ins} check-ins`} />
            <Kpi label="Overtime" value={pct(r.kpis.ran_long, 1)} note="cleans 15%+ over booked time" />
            <Kpi label="Hours filled" value={pct(r.kpis.hours_filled)} note="booked of available, next 4 weeks" />
            <Kpi label="No cleaner yet" value={r.kpis.unassigned_visits == null ? '—' : String(r.kpis.unassigned_visits)} note="visits in the next 8 weeks" />
            <Kpi label="Drive per visit" value={r.kpis.km_per_visit == null ? '—' : `${r.kpis.km_per_visit} km`} note={`from "en route" taps (${pct(r.kpis.enroute)} of visits)`} />
          </div>

          <div className="seg-two">
            <section className="card seg-chart-card">
              <div className="seg-section-head"><h2>Same cleaner, week by week</h2><span className="muted small">Share of recurring visits done by the client's usual cleaner</span></div>
              <SameCleanerChart series={r.same_cleaner_series} />
            </section>
            <PlannerHealth p={r.planner} />
          </div>

          <div className="rep-three">
            <section className="card rep-card">
              <h2>Hours filled by area</h2>
              <span className="muted small">Booked ÷ available hours of cleaners taking bookings, next 4 weeks</span>
              {r.areas.map((a) => (
                <div key={a.area} className="seg-flow-row">
                  <div className="seg-flow-label"><span>{a.area}</span><b>{pct(a.filled)}</b></div>
                  <div className="seg-bar big"><span className={`seg-bar-fill ${a.filled != null && a.filled < 0.5 ? 'flow-loss' : 'flow-gain'}`} style={{ width: `${Math.min((a.filled || 0) * 100, 100)}%` }} /></div>
                </div>
              ))}
              {r.areas.length === 0 && <p className="muted small">Shows once the scheduling planner has loaded.</p>}
            </section>
            <section className="card rep-card">
              <h2>Lopsided weeks</h2>
              <span className="muted small">Cleaners whose A/C and B/D weeks differ by 8h or more. Moving a biweekly client evens them out.</span>
              <table className="rep-mini">
                <thead><tr><th>Cleaner</th><th className="num">A/C week</th><th className="num">B/D week</th><th /></tr></thead>
                <tbody>
                  {r.lopsided.map((l) => (
                    <tr key={l.cleaner_id}><td>{l.name}</td><td className="num">{l.ac}h</td><td className="num">{l.bd}h</td><td className="num"><Link to={`/schedule/cleaner/${l.cleaner_id}`}>Plan</Link></td></tr>
                  ))}
                  {r.lopsided.length === 0 && <tr><td colSpan={4} className="muted">Everyone's weeks are balanced.</td></tr>}
                </tbody>
              </table>
            </section>
            <section className="card rep-card">
              <div className="seg-section-head"><h2>Travel</h2><Link to="/routes" className="small">Day map →</Link></div>
              <div className="rep-pair">
                <div><span className="muted small">Per visit</span><b>{r.kpis.km_per_visit == null ? '—' : `${r.kpis.km_per_visit} km`}</b></div>
                <div><span className="muted small">Outside home area</span><b>{pct(r.kpis.outside_area)}</b></div>
              </div>
              <span className="small">Cleaners tap "en route" on {pct(r.kpis.enroute)} of visits; drive figures cover those.</span>
            </section>
          </div>

          <div className="seg-two">
            <section className="card flush">
              <div className="seg-table-head"><h2>Driving by cleaner</h2><span className="muted small">{weekLabel(r.from)} – {weekLabel(r.to)}</span></div>
              <div className="table-scroll">
                <table className="seg-table compact">
                  <thead><tr><th>Cleaner</th><th>Area</th><th className="num">Km per visit</th><th className="num">Outside home area</th><th className="num">Taps en route</th></tr></thead>
                  <tbody>
                    {r.driving.slice(0, 40).map((d) => (
                      <tr key={d.cleaner_id}>
                        <td><Link to={`/reports/cleaners/${d.cleaner_id}`} className="seg-name">{d.name}</Link></td>
                        <td className="muted">{d.area || '—'}</td>
                        <td className="num">{d.km_per_visit ?? '—'}</td>
                        <td className={`num${d.outside_area != null && d.outside_area > 0.25 ? ' warn' : ''}`}>{pct(d.outside_area)}</td>
                        <td className={`num${d.enroute != null && d.enroute < 0.3 ? ' warn' : ''}`}>{pct(d.enroute)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="card rep-card">
              <h2>Longest drives</h2>
              <span className="muted small">{weekLabel(r.from)} – {weekLabel(r.to)}</span>
              {r.longest_drives.map((d, i) => (
                <div key={i} className="rep-drive">
                  <span><b>{d.cleaner}</b> → {d.customer} · {weekLabel(d.date)}{d.area_out ? <span className="seg-trait">outside area</span> : null}</span>
                  <b className="warn">{d.km} km</b>
                </div>
              ))}
              {r.longest_drives.length === 0 && <p className="muted small">No drive distances yet: they come from cleaners tapping "en route".</p>}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

function SameCleanerChart({ series }: { series: SchedulingReport['same_cleaner_series'] }) {
  const [hover, setHover] = useState<number | null>(null);
  const pts = series.filter((s) => s.share != null);
  if (pts.length < 2) return <p className="muted small">Not enough recurring visits in this period.</p>;
  const W = 720, H = 220, L = 44, R = 16, T = 14, B = 28;
  const x = (i: number) => L + (i * (W - L - R)) / Math.max(pts.length - 1, 1);
  const y = (v: number) => T + (1 - v) * (H - T - B);
  const h = hover !== null ? pts[hover] : null;
  const labels = [0, Math.floor((pts.length - 1) / 2), pts.length - 1];
  return (
    <div className="seg-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Same cleaner share from ${pct(pts[0].share)} to ${pct(pts.at(-1)!.share)}, goal ${pct(GOAL)}`} onMouseLeave={() => setHover(null)}>
        {[0.3, 0.6, 0.9].map((v) => (
          <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="seg-grid" /><text x={L - 8} y={y(v) + 4} textAnchor="end" className="seg-axis">{pct(v)}</text></g>
        ))}
        <line x1={L} x2={W - R} y1={y(GOAL)} y2={y(GOAL)} stroke="#0f172a" strokeDasharray="5 5" strokeWidth="1.5" />
        <text x={W - R} y={y(GOAL) - 6} textAnchor="end" className="seg-axis rep-goal">Goal {pct(GOAL)}</text>
        {labels.map((i) => <text key={i} x={x(i)} y={H - 8} textAnchor="middle" className="seg-axis">{weekLabel(pts[i].week)}</text>)}
        <polyline points={pts.map((p, i) => `${x(i)},${y(p.share!)}`).join(' ')} className="seg-line" />
        {h && <line x1={x(hover!)} x2={x(hover!)} y1={T} y2={H - B} className="seg-crosshair" />}
        {pts.map((p, i) => <circle key={p.week} cx={x(i)} cy={y(p.share!)} r={hover === i ? 6 : 3.5} className="seg-dot" />)}
        {pts.map((p, i) => <rect key={`h${p.week}`} x={x(i) - (W - L - R) / pts.length / 2} y={T} width={(W - L - R) / pts.length} height={H - T - B} fill="transparent" onMouseEnter={() => setHover(i)} />)}
      </svg>
      {h && <div className="seg-tip" style={{ left: `${(x(hover!) / W) * 100}%` }}><b>{pct(h.share)}</b> same cleaner<div className="muted small">Week of {weekLabel(h.week)} · {h.visits} visits</div></div>}
    </div>
  );
}

function PlannerHealth({ p }: { p: SchedulingReport['planner'] }) {
  return (
    <section className="card rep-card">
      <h2>How the planner is doing</h2>
      <span className="muted small">Changes to handle raised in this period</span>
      <div className="rep-grid2">
        <div><span className="muted small">Raised</span><b>{p.raised}</b></div>
        <div><span className="muted small">Handled</span><b>{pct(p.handled_share)}</b></div>
        <div><span className="muted small">Typical time to handle</span><b>{p.median_hours == null ? '—' : `${p.median_hours} h`}</b></div>
        <div><span className="muted small">Fixed with the recommendation</span><b>{pct(p.recommended_share)}</b></div>
      </div>
      <span className="small">Open now: <b>{p.open}</b> · expired without being handled: <b>{p.expired}</b> · <Link to="/schedule">Changes to handle</Link></span>
    </section>
  );
}
