import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { segmentsApi, type Period, type SegmentId, type Trends } from '../segments/api';
import { SegmentPill, UpdatedLine, pct, shortDate } from '../segments/ui';

const PERIODS: [Period, string][] = [['30d', 'Last 30 days'], ['90d', '90 days'], ['12m', '12 months'], ['custom', 'Custom']];
const iso = (d: Date) => d.toISOString().slice(0, 10);

export function CustomerTrendsPage() {
  const [period, setPeriod] = useState<Period>('12m');
  const [from, setFrom] = useState(iso(new Date(Date.now() - 90 * 86_400_000)));
  const [to, setTo] = useState(iso(new Date()));
  const summary = useQuery({ queryKey: ['segments', 'summary'], queryFn: segmentsApi.summary });
  const trends = useQuery({ queryKey: ['segments', 'trends', period, period === 'custom' ? from : '', period === 'custom' ? to : ''], queryFn: () => segmentsApi.trends(period === 'custom' ? { period, from, to } : { period }), placeholderData: (p) => p });
  const t = trends.data;

  return (
    <div className="seg-page">
      <nav className="small muted"><Link to="/customers">Customers</Link> / Trends</nav>
      <header className="page-header">
        <div className="seg-head">
          <h1>How segments are changing</h1>
          <UpdatedLine summary={summary.data} />
        </div>
        <div className="seg-period-wrap">
          <div className="seg-period" role="group" aria-label="Time period">
            {PERIODS.map(([id, label]) => (
              <button key={id} className={period === id ? 'active' : ''} aria-pressed={period === id} onClick={() => setPeriod(id)}>{label}</button>
            ))}
          </div>
          {period === 'custom' && (
            <span className="seg-custom">
              <label><span className="sr-only">From</span><input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
              <span className="muted">to</span>
              <label><span className="sr-only">To</span><input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
            </span>
          )}
        </div>
      </header>

      {trends.isError && <div className="error">{(trends.error as Error).message}</div>}
      {t && t.series.length === 0 && <div className="card muted">Trends appear after the first update.</div>}
      {t && t.series.length > 0 && (
        <>
          <div className="seg-stats">
            <Kpi label="Recurring now" value={t.kpis.recurring.toLocaleString('en-CA')} note={`${t.kpis.recurring_change >= 0 ? '+' : '−'}${Math.abs(t.kpis.recurring_change)}${t.flow.start ? ` (${t.kpis.recurring_change >= 0 ? '+' : '−'}${Math.abs(Math.round((t.kpis.recurring_change / t.flow.start) * 100))}%)` : ''} since ${shortDate(t.series[0].day)}`} />
            <Kpi label="Joined a plan" value={String(t.kpis.joined)} note={`${t.flow.new} new, ${t.flow.converted} converted, ${t.flow.won_back} won back`} />
            <Kpi label="At risk saved" value={t.kpis.save_rate === null ? '—' : pct(t.kpis.save_rate)} note={`${t.kpis.saved} of ${t.kpis.to_risk} rebooked before lapsing`} />
            <Kpi label="First-timers who came back" value={t.first_timers.total ? pct((t.first_timers.repeat + t.first_timers.plan) / t.first_timers.total) : '—'} note={`${t.first_timers.repeat + t.first_timers.plan} of ${t.first_timers.total} booked again`} />
          </div>

          <div className="seg-two">
            <section className="card seg-chart-card">
              <div className="seg-section-head">
                <h2>Recurring customers</h2>
                <span className="muted small">Hover a point for the exact number</span>
              </div>
              <LineChart series={t.series} />
              {t.estimated_until && (
                <p className="muted small">Up to {shortDate(t.estimated_until)} the numbers are rebuilt from booking history (month ends). Launch27 hides cancelled bookings, so those are close estimates. After that, every change is recorded exactly.</p>
              )}
            </section>
            <section className="card seg-flow">
              <h2>Where the plan customers went</h2>
              <span className="muted small">{shortDate(t.series[0].day)} → {shortDate(t.series.at(-1)!.day)}</span>
              <FlowRows t={t} />
            </section>
          </div>

          <div className="seg-two">
            <section className="card flush">
              <div className="seg-table-head">
                <h2>Moves between segments</h2>
                <span className="muted small">{shortDate(t.from)} – {shortDate(t.to)}</span>
              </div>
              <div className="table-scroll">
                <table className="seg-table compact">
                  <thead><tr><th>From</th><th>To</th><th className="num">Customers</th></tr></thead>
                  <tbody>
                    {t.moves.map((m) => (
                      <tr key={`${m.from_segment}-${m.to_segment}`}>
                        <td><SegmentPill segment={m.from_segment} /></td>
                        <td><Link to={`/customers?segment=${m.to_segment}`}><SegmentPill segment={m.to_segment} /></Link></td>
                        <td className="num mono">{m.n}</td>
                      </tr>
                    ))}
                    {t.moves.length === 0 && <tr><td colSpan={3} className="muted seg-none-row">No moves in this period.</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="card seg-firsttimers">
              <h2>What happens to first-timers</h2>
              <span className="muted small">{t.first_timers.total.toLocaleString('en-CA')} new customers in this period</span>
              <FirstTimers t={t} />
            </section>
          </div>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="card seg-stat">
      <span className="muted small">{label}</span>
      <span className="seg-stat-value">{value}</span>
      <span className="small">{note}</span>
    </div>
  );
}

// One series (recurring), so no legend; hover shows the exact value.
function LineChart({ series }: { series: Trends['series'] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 760;
  const H = 230;
  const L = 44;
  const R = 16;
  const T = 16;
  const B = 30;
  const vals = series.map((p) => p.recurring);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const pad = Math.max(Math.round((hi - lo) * 0.15), 2);
  const y0 = Math.max(lo - pad, 0);
  const y1 = hi + pad;
  const t0 = Date.parse(series[0].day);
  const t1 = Date.parse(series.at(-1)!.day);
  const x = (day: string) => (t1 === t0 ? L + (W - L - R) / 2 : L + ((Date.parse(day) - t0) / (t1 - t0)) * (W - L - R));
  const y = (v: number) => T + (1 - (v - y0) / (y1 - y0 || 1)) * (H - T - B);
  const ticks = [y0, Math.round((y0 + y1) / 2), y1].map((v) => Math.round(v));
  const labelIdx = series.length <= 5 ? series.map((_, i) => i) : [0, Math.round((series.length - 1) / 3), Math.round(((series.length - 1) * 2) / 3), series.length - 1];
  const points = series.map((p) => `${x(p.day).toFixed(1)},${y(p.recurring).toFixed(1)}`).join(' ');
  const h = hover !== null ? series[hover] : null;
  return (
    <div className="seg-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Recurring customers: ${series[0].recurring} on ${shortDate(series[0].day)}, ${series.at(-1)!.recurring} on ${shortDate(series.at(-1)!.day)}`} onMouseLeave={() => setHover(null)}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="seg-grid" />
            <text x={L - 8} y={y(v) + 4} textAnchor="end" className="seg-axis">{v}</text>
          </g>
        ))}
        {labelIdx.map((i) => (
          <text key={i} x={x(series[i].day)} y={H - 8} textAnchor="middle" className="seg-axis">{shortDate(series[i].day)}</text>
        ))}
        <polyline points={points} className="seg-line" />
        {h && <line x1={x(h.day)} x2={x(h.day)} y1={T} y2={H - B} className="seg-crosshair" />}
        {series.map((p, i) => (
          <circle key={p.day} cx={x(p.day)} cy={y(p.recurring)} r={hover === i ? 6 : 4} className="seg-dot" />
        ))}
        {series.map((p, i) => {
          const prev = i ? x(series[i - 1].day) : L;
          const next = i < series.length - 1 ? x(series[i + 1].day) : W - R;
          const left = i ? (prev + x(p.day)) / 2 : L;
          const right = i < series.length - 1 ? (x(p.day) + next) / 2 : W - R;
          return <rect key={`h${p.day}`} x={left} y={T} width={Math.max(right - left, 1)} height={H - T - B} fill="transparent" onMouseEnter={() => setHover(i)} />;
        })}
      </svg>
      {h && (
        <div className="seg-tip" style={{ left: `${(x(h.day) / W) * 100}%` }}>
          <b>{h.recurring.toLocaleString('en-CA')}</b> recurring
          <div className="muted small">{shortDate(h.day)}{h.estimated ? ' · estimated' : ''}</div>
        </div>
      )}
    </div>
  );
}

function FlowRows({ t }: { t: Trends }) {
  const rows: [string, number, string][] = [
    [`Plan customers, ${shortDate(t.series[0].day)}`, t.flow.start, 'base'],
    ['+ New, straight onto a plan', t.flow.new, 'gain'],
    ['+ Converted from one-time', t.flow.converted, 'gain'],
    ['+ Won back after lapsing', t.flow.won_back, 'gain'],
    ['− Left (net of customers saved)', t.flow.left, 'loss'],
    ['Plan customers now', t.flow.end, 'end'],
  ];
  const max = Math.max(...rows.map((r) => r[1]), 1);
  return (
    <div className="seg-flow-rows">
      {rows.map(([label, v, kind]) => (
        <div key={label} className="seg-flow-row">
          <div className="seg-flow-label"><span>{label}</span><b className="mono">{v.toLocaleString('en-CA')}</b></div>
          <div className="seg-bar big"><span className={`seg-bar-fill flow-${kind}`} style={{ width: `${(v / max) * 100}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

function FirstTimers({ t }: { t: Trends }) {
  const f = t.first_timers;
  const parts: [string, number, SegmentId | 'none'][] = [
    ["Didn't book again (lapsed)", f.lapsed, 'none'],
    ['Still first-time', f.still, 'first'],
    ['Booked a second one-time', f.repeat, 'repeat'],
    ['Went onto a plan', f.plan, 'recurring'],
  ];
  const total = f.total || 1;
  return (
    <>
      <div className="seg-stack" role="img" aria-label={parts.map(([l, n]) => `${l}: ${n}`).join(', ')}>
        {parts.map(([l, n, k]) => n > 0 && <span key={l} className={`seg-stack-part seg-fill-${k}`} style={{ width: `${(n / total) * 100}%` }} title={`${l}: ${n}`} />)}
      </div>
      <ul className="seg-legend">
        {parts.map(([l, n, k]) => (
          <li key={l}><span className={`seg-swatch seg-fill-${k}`} />{l}<b>{n.toLocaleString('en-CA')} · {pct(n / total)}</b></li>
        ))}
      </ul>
      {f.total > 0 && <p className="small seg-insight">First-timers who never book a second clean are the biggest opening. A second-clean offer after a good rating is the first thing to try.</p>}
    </>
  );
}
