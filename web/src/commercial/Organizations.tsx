// Commercial › Organizations: the partners that send us their clients, ranked by revenue.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { Period } from '../reports/api';
import { Kpi, NotBuilt, PeriodPicker, ReportStatusLine } from '../reports/ui';
import { commercialApi } from './api';
import { RhythmPill, Trend, money, niceDate, pct0, useCommercialLocations } from './ui';

export function OrganizationsPage() {
  const [period, setPeriod] = useState<Period>('13w');
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'all' | 'partners'>('partners');
  const locs = useCommercialLocations();
  const data = useQuery({ queryKey: ['commercial', 'orgs', period, locs], queryFn: () => commercialApi.organizations(period, locs), enabled: !!locs, retry: false, placeholderData: (p) => p });
  const d = data.data;
  const rows = useMemo(() => (d?.rows || []).filter((r) => (kind === 'all' || r.kind === 'homemaking' || r.kind === 'program' || r.kind === 'after') && (!q || r.name.toLowerCase().includes(q.toLowerCase()))), [d, kind, q]);
  const maxShare = Math.max(0.01, ...rows.map((r) => r.share));
  return (
    <div className="seg-page">
      <header className="page-header">
        <div className="seg-head">
          <span className="small muted">Commercial</span>
          <h1>Organizations</h1>
          <p className="muted">The partners that send us their clients, and what each one brings. Commercial Ottawa and Cornwall, plus hospital programs wherever they were booked.</p>
          <ReportStatusLine />
        </div>
        <PeriodPicker value={period} onChange={setPeriod} />
      </header>
      {data.isError && <NotBuilt message={(data.error as Error).message} />}
      {d && (
        <>
          <div className="seg-stats">
            <Kpi label="Commercial revenue" value={money(d.totals.revenue)} note={`${d.totals.visits} visits`} />
            <Kpi label="From partners" value={pct0(d.totals.partner_share)} note="homemaking partners and hospital programs" />
            <Kpi label="Clients served" value={String(d.totals.clients)} note="each partner address counts as one client" />
            <Kpi label="No cleaner yet" value={String(d.totals.unassigned_28d)} note="visits in the next 4 weeks" tone={d.totals.unassigned_28d ? 'warn' : undefined} />
          </div>
          <section className="card flush">
            <div className="seg-table-head">
              <h2>Ranked by revenue</h2>
              <div className="com-tools">
                <div className="seg-filter">
                  <button className={kind === 'partners' ? 'chip-btn active' : 'chip-btn'} onClick={() => setKind('partners')}>Partners and programs</button>
                  <button className={kind === 'all' ? 'chip-btn active' : 'chip-btn'} onClick={() => setKind('all')}>All commercial accounts</button>
                </div>
                <input type="search" placeholder="Find an organization" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find an organization" />
              </div>
            </div>
            <div className="table-scroll">
              <table className="seg-table com-table">
                <thead><tr><th>Organization</th><th>Clients</th><th>Visits</th><th>Revenue</th><th>Trend</th><th>Rhythm</th><th>Same cleaner</th><th>No cleaner (4 wks)</th><th>Share</th><th>Next visit</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key}>
                      <td><Link to={`/commercial/organizations/${encodeURIComponent(r.key)}`} className="seg-name">{r.name}</Link><div className="muted small">{r.kind_label}</div></td>
                      <td>{r.clients}</td>
                      <td>{r.visits}</td>
                      <td>{money(r.revenue)}</td>
                      <td><Trend value={r.trend} /></td>
                      <td><RhythmPill rhythm={r.rhythm} /></td>
                      <td>{pct0(r.same_cleaner)}</td>
                      <td className={r.unassigned_28d ? 'warn' : ''}>{r.unassigned_28d || '—'}</td>
                      <td><span className="com-bar" aria-hidden="true"><span style={{ width: `${(r.share / maxShare) * 100}%` }} /></span> {pct0(r.share)}</td>
                      <td>{niceDate(r.next)}</td>
                    </tr>
                  ))}
                  {!rows.length && <tr><td colSpan={10} className="muted">No commercial visits in this period.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
          <p className="muted small">Same cleaner: share of clients who had one cleaner for every visit in the period. Trend: revenue against the period before.</p>
        </>
      )}
    </div>
  );
}
