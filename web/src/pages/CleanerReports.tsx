import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { reportsApi, money, pct, type CleanerRow, type Period } from '../reports/api';
import { Kpi, NotBuilt, PeriodPicker, ReportStatusLine, Spark, monthYear, weekLabel } from '../reports/ui';

type SortKey = 'name' | 'visits' | 'hours_per_week' | 'hours_filled' | 'on_time' | 'happy' | 'unhappy' | 'keeps' | 'revenue' | 'earned';
const COLS: [SortKey, string][] = [['name', 'Cleaner'], ['visits', 'Visits'], ['hours_per_week', 'Hours / wk'], ['hours_filled', 'Hours filled'], ['on_time', 'On time'], ['happy', 'Happy'], ['unhappy', 'Unhappy'], ['keeps', 'Keeps clients'], ['revenue', 'Revenue'], ['earned', 'Earned']];

export function CleanerReportsPage() {
  const [period, setPeriod] = useState<Period>('13w');
  const [scope, setScope] = useState<'active' | 'new' | 'flagged' | 'all'>('active');
  const [area, setArea] = useState<string>('');
  const [sort, setSort] = useState<SortKey>('visits');
  const [dir, setDir] = useState(-1);
  const q = useQuery({ queryKey: ['reports', 'cleaners', period], queryFn: () => reportsApi.cleaners(period), retry: false, placeholderData: (p) => p });
  const r = q.data;
  const areas = useMemo(() => [...new Set((r?.rows || []).map((x) => x.area).filter(Boolean) as string[])].sort(), [r]);
  const rows = useMemo(() => {
    const list = (r?.rows || []).filter((x) => (scope === 'all' ? true : scope === 'new' ? x.is_new : scope === 'flagged' ? x.flags.length > 0 && x.assignable : x.assignable) && (!area || x.area === area));
    return list.sort((a, b) => {
      const av = a[sort as keyof CleanerRow];
      const bv = b[sort as keyof CleanerRow];
      if (typeof av === 'string' || typeof bv === 'string') return String(av).localeCompare(String(bv)) * dir;
      return (((av as number | null) ?? -1) - ((bv as number | null) ?? -1)) * dir;
    });
  }, [r, scope, area, sort, dir]);
  const flagged = (r?.rows || []).filter((x) => x.assignable && x.flags.length).slice(0, 9);
  const cols = COLS.filter(([k]) => k !== 'earned' || r?.admin);
  return (
    <div className="seg-page">
      <header className="page-header">
        <div className="seg-head">
          <span className="small muted">Reports</span>
          <h1>Cleaner reports</h1>
          <p className="muted">How each cleaner is doing: time, quality, keeping clients.{r?.admin ? ' Pay is shown to admins only.' : ''}</p>
          <ReportStatusLine />
        </div>
        <PeriodPicker value={period} onChange={setPeriod} />
      </header>
      {q.isError && <NotBuilt message={(q.error as Error).message} />}
      {r && (
        <>
          <div className="seg-stats">
            <Kpi label="Typical cleaner" value={`${r.team.median_visits ?? '—'} visits`} note={`in this period (busiest: ${r.team.max_visits})`} />
            <Kpi label="On time, team" value={pct(r.team.on_time, 1)} note={`${r.team.check_ins} check-ins`} />
            <Kpi label="Happy ratings, team" value={pct(r.team.happy)} note={`only ${pct(r.team.rated_share, 1)} of visits get rated`} />
            <Kpi label="Flagged" value={`${r.team.flagged} cleaner${r.team.flagged === 1 ? '' : 's'}`} note="worth a conversation" tone={r.team.flagged ? 'warn' : undefined} />
            {r.admin && <Kpi label="Paid to cleaners" value={money(r.team.earned)} note={`on ${money(r.team.revenue)} revenue`} />}
          </div>

          {flagged.length > 0 && (
            <section className="card rep-card">
              <h2>Needs attention</h2>
              <div className="rep-flags">
                {flagged.map((c) => (
                  <Link key={c.id} to={`/reports/cleaners/${c.id}`} className="rep-flag">
                    <b>{c.name}</b>
                    {c.flags.map((f) => <span key={f.kind} className="small"><b className="warn">{f.label}:</b> {f.detail}</span>)}
                  </Link>
                ))}
              </div>
            </section>
          )}

          <div className="sch-bar">
            <div className="seg-filter">
              {([['active', 'Taking bookings'], ['new', 'New hires'], ['flagged', 'Has a flag'], ['all', 'Everyone with visits']] as const).map(([k, l]) => (
                <button key={k} className={scope === k ? 'chip-btn active' : 'chip-btn'} onClick={() => setScope(k)}>{l}</button>
              ))}
            </div>
            <label className="rep-area"><span className="sr-only">Area</span>
              <select value={area} onChange={(e) => setArea(e.target.value)}><option value="">All areas</option>{areas.map((a) => <option key={a} value={a}>{a}</option>)}</select>
            </label>
          </div>

          <section className="card flush">
            <div className="seg-table-head"><h2>Scorecard</h2><span className="muted small">{rows.length} cleaners · click a column to sort, a name for their report</span></div>
            <div className="table-scroll">
              <table className="seg-table rep-score">
                <thead>
                  <tr>
                    {cols.map(([k, l]) => (
                      <th key={k} className={k === 'name' ? '' : 'num'}>
                        <button className="rep-sort" onClick={() => { setDir(sort === k ? -dir : k === 'name' ? 1 : -1); setSort(k); }}>{l}{sort === k ? (dir < 0 ? ' ↓' : ' ↑') : ''}</button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <div className="sch-who">
                          <span className="sch-dot" style={{ background: c.color }} aria-hidden="true" />
                          <div>
                            <Link to={`/reports/cleaners/${c.id}`} className="seg-name">{c.name}</Link>
                            <div className="muted small">{[c.assignable ? (c.is_new ? 'New hire' : 'Active') : c.status_label, c.area, c.hours_type].filter(Boolean).join(' · ')}{c.flags.length ? ` · ${c.flags.length} flag${c.flags.length === 1 ? '' : 's'}` : ''}</div>
                          </div>
                        </div>
                      </td>
                      <td className="num">{c.visits}</td>
                      <td className="num">{c.hours_per_week ?? '—'}</td>
                      <td className={`num${c.hours_filled != null && c.hours_filled < 0.5 ? ' warn' : ''}`}>{pct(c.hours_filled)}</td>
                      <td className={`num${c.on_time != null && c.on_time < 0.9 ? ' warn' : ''}`}>{pct(c.on_time)}</td>
                      <td className="num">{pct(c.happy)} <span className="muted small">of {c.rated}</span></td>
                      <td className={`num${c.unhappy >= 2 ? ' warn' : ''}`}>{c.unhappy}</td>
                      <td className={`num${c.keeps != null && c.keeps < 0.6 ? ' warn' : ''}`}>{c.clients_started ? pct(c.keeps) : '—'}</td>
                      <td className="num mono">{money(c.revenue)}</td>
                      {r.admin && <td className="num mono">{money(c.earned)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small sch-pad">Keeps clients = of the recurring clients they were the usual cleaner for at the start, how many still are. On time = checked in within the arrival window (+5 min).</p>
          </section>
        </>
      )}
    </div>
  );
}

export function CleanerReportPage() {
  const { id } = useParams();
  const [period, setPeriod] = useState<Period>('13w');
  const q = useQuery({ queryKey: ['reports', 'cleaner', id, period], queryFn: () => reportsApi.cleaner(Number(id), period), retry: false, placeholderData: (p) => p });
  const r = q.data;
  if (q.isError) return <NotBuilt message={(q.error as Error).message} />;
  if (!r) return <p className="muted">Loading…</p>;
  const s = r.stats;
  const c = r.cleaner;
  const initials = c.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('');
  const lateN = r.last40.filter((x) => x.late).length;
  return (
    <div className="seg-page">
      <nav className="small muted"><Link to="/reports/cleaners">Cleaner reports</Link> / {c.name}</nav>
      <section className="card rep-head">
        <div className="sch-who">
          <span className="rep-avatar" style={{ background: c.color }} aria-hidden="true">{initials}</span>
          <div>
            <h1>{c.name}</h1>
            <div className="rep-tags">
              <span className="seg-trait">{c.status_label}</span>
              {c.area && <span className="seg-trait">{c.area}</span>}
              {c.hours_type && <span className="seg-trait">{c.hours_type}</span>}
              {c.tags.slice(0, 6).map((t) => <span key={t} className="seg-trait">{t}</span>)}
              {c.first_seen && <span className="seg-trait">Working since at least {monthYear(c.first_seen)}</span>}
            </div>
          </div>
        </div>
        <div className="rep-head-actions">
          <PeriodPicker value={period} onChange={setPeriod} />
          <Link className="button secondary-link" to={`/cleaners/${c.id}`}>Profile</Link>
          <Link className="button secondary-link" to={`/schedule/cleaner/${c.id}`}>Open plan</Link>
        </div>
      </section>
      {r.flags.length > 0 && (
        <div className="rep-note"><b className="warn">Worth a conversation:</b> {r.flags.map((f) => f.detail).join(' · ')}.</div>
      )}
      <div className="seg-stats">
        <div className="card seg-stat"><span className="muted small">Visits</span><span className="seg-stat-value">{s.visits}</span><Spark values={(() => { const m = Math.max(...r.series.map((w) => w.visits), 1); return r.series.map((w) => w.visits / m); })()} /><span className="small">{s.hours_per_week ?? '—'} hours a week</span></div>
        <div className="card seg-stat"><span className="muted small">Hours filled</span><span className="seg-stat-value">{pct(s.hours_filled)}</span><span className="small">{s.booked_next4 != null ? `${s.booked_next4}h of ${s.capacity_next4}h a week, next 4 weeks` : 'not in the planner'}</span></div>
        <div className="card seg-stat"><span className="muted small">On time</span><span className={s.on_time != null && s.on_time < 0.9 ? 'seg-stat-value rep-warn' : 'seg-stat-value'}>{pct(s.on_time)}</span><Spark values={r.series.map((w) => w.on_time)} warn={s.on_time != null && s.on_time < 0.9} /><span className="small">{s.late_avg ? `late ones by ${s.late_avg} min` : 'no late check-ins'}</span></div>
        <div className="card seg-stat"><span className="muted small">Happy ratings</span><span className="seg-stat-value">{pct(s.happy)}</span><Spark values={r.series.map((w) => w.happy)} /><span className="small">{s.rated} rated · {s.unhappy} unhappy</span></div>
        <div className="card seg-stat"><span className="muted small">Keeps clients</span><span className="seg-stat-value">{s.clients_started ? pct(s.keeps) : '—'}</span><span className="small">{s.clients_started ? `of ${s.clients_started} regular clients` : 'no regular clients at the start'}</span></div>
        <div className="card seg-stat"><span className="muted small">Drive per visit</span><span className="seg-stat-value">{s.km_per_visit == null ? '—' : `${s.km_per_visit} km`}</span><span className="small">taps en route on {pct(s.enroute)} of visits</span></div>
      </div>

      <div className="seg-two">
        <section className="card flush">
          <div className="seg-table-head"><h2>Regular clients</h2><span className="muted small">{c.name.split(' ')[0]} is their usual cleaner</span></div>
          <div className="table-scroll">
            <table className="seg-table">
              <thead><tr><th>Client</th><th>Rhythm</th><th>Together since</th><th>Last rating</th></tr></thead>
              <tbody>
                {r.clients.map((x) => (
                  <tr key={x.customer_id}>
                    <td><Link to={`/customers/${x.customer_id}`} className="seg-name">{x.customer}</Link></td>
                    <td className="small">{x.rhythm}</td>
                    <td className="small">{x.since ? monthYear(x.since) : '—'} · {x.cleans} cleans</td>
                    <td className="small">{x.last_rating ? <span className={x.last_rating.r === 0 ? 'warn' : x.last_rating.r === 2 ? 'ok' : ''}>{x.last_rating.r === 2 ? 'Happy' : x.last_rating.r === 0 ? 'Unhappy' : 'OK'}{x.last_rating.comment ? ` · "${x.last_rating.comment}"` : ''}</span> : <span className="muted">Not rated</span>}</td>
                  </tr>
                ))}
                {r.clients.length === 0 && <tr><td colSpan={4} className="muted seg-none-row">No regular clients right now.</td></tr>}
              </tbody>
            </table>
          </div>
          {r.lost.length > 0 && <p className="small sch-pad">Moved away in this period: <b>{r.lost.length}</b> ({r.lost.filter((l) => l.to).length} to another cleaner, {r.lost.filter((l) => l.stopped).length} stopped booking).</p>}
        </section>
        <div className="rep-side">
          <section className="card rep-card">
            <h2>Recent ratings</h2>
            {r.ratings.map((x, i) => (
              <div key={i} className="rep-rating"><span className={x.r === 0 ? 'warn' : x.r === 2 ? 'ok' : ''}><b>{x.r === 2 ? 'Happy' : x.r === 0 ? 'Unhappy' : 'OK'}</b> · {weekLabel(x.date)} · {x.customer}</span>{x.comment && <span className="small">"{x.comment}"</span>}</div>
            ))}
            {r.ratings.length === 0 && <p className="muted small">No ratings yet.</p>}
          </section>
          {r.admin && (
            <section className="card rep-card">
              <h2>Pay <span className="muted small">· admins only</span></h2>
              <div className="rep-pair">
                <div><span className="muted small">Earned this period</span><b>{money(s.earned)}</b></div>
                <div><span className="muted small">Per hour on site</span><b>{s.per_hour != null ? `$${s.per_hour}` : '—'}</b></div>
              </div>
              <span className="muted small">From Launch27's team payments on each booking.</span>
            </section>
          )}
        </div>
      </div>

      <section className="card rep-card">
        <h2>Punctuality and timing, last {r.last40.length} visits</h2>
        <div className="rep-strip" role="img" aria-label={`Last ${r.last40.length} visits: ${lateN} late, ${r.last40.filter((x) => x.long).length} ran 15% or more over booked time`}>
          {r.last40.map((x, i) => <span key={i} className={`rep-cell${x.late ? ' late' : ''}${x.long ? ' long' : ''}`} title={`${weekLabel(x.date)} · ${x.customer}${x.late ? ` · ${x.late} min late` : ' · on time'}${x.long ? ' · ran long' : ''}`} />)}
        </div>
        <div className="sch-legend rep-legend">
          <span><i className="rep-cell" />On time</span>
          <span><i className="rep-cell late" />Late</span>
          <span><i className="rep-cell long" />Ran 15%+ over booked time</span>
        </div>
      </section>
    </div>
  );
}
