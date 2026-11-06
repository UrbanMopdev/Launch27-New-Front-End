// Commercial › one organization: its trend and every client it sends us.
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { Period } from '../reports/api';
import { Kpi, NotBuilt, PeriodPicker, weekLabel } from '../reports/ui';
import { commercialApi } from './api';
import { RhythmPill, clockOf, money, niceDate, useCommercialLocations } from './ui';

export function OrganizationPage() {
  const { key = '' } = useParams();
  const [period, setPeriod] = useState<Period>('13w');
  const locs = useCommercialLocations();
  const data = useQuery({ queryKey: ['commercial', 'org', key, period, locs], queryFn: () => commercialApi.organization(key, period, locs), enabled: !!locs, retry: false, placeholderData: (p) => p });
  const d = data.data;
  const maxV = Math.max(1, ...(d?.weeks || []).map((w) => w.visits));
  return (
    <div className="seg-page">
      <header className="page-header">
        <div className="seg-head">
          <span className="small muted"><Link to="/commercial/organizations">Commercial › Organizations</Link></span>
          <h1>{d?.name || 'Organization'}</h1>
          {d && <p className="muted">{d.kind_label}{d.program ? ' · follows the 4 weekly, 2 every two weeks, 1 monthly plan' : ''}{d.kind === 'program' && <> · <Link to="/commercial/programs">See patients and plan progress</Link></>}</p>}
        </div>
        <PeriodPicker value={period} onChange={setPeriod} />
      </header>
      {data.isError && <NotBuilt message={(data.error as Error).message} />}
      {d && (
        <>
          <div className="seg-stats">
            <Kpi label="Revenue" value={money(d.stats.revenue)} note={`${d.stats.visits} visits`} />
            <Kpi label="Clients" value={String(d.stats.clients)} note="different addresses cleaned" />
            <Kpi label="Booked ahead" value={String(d.stats.booked_ahead)} note={d.stats.unassigned_28d ? `${d.stats.unassigned_28d} with no cleaner in the next 4 weeks` : 'all have a cleaner for the next 4 weeks'} tone={d.stats.unassigned_28d ? 'warn' : undefined} />
            <Kpi label="Average per visit" value={money(d.stats.avg)} />
          </div>
          <section className="card">
            <div className="seg-section-head"><h2>Visits by week</h2><span className="muted small">last 26 weeks</span></div>
            <div className="com-weeks" role="img" aria-label="Visits per week over the last 26 weeks">
              {d.weeks.map((w) => (
                <div key={w.week} className="com-week" title={`Week of ${weekLabel(w.week)}: ${w.visits} visits, ${money(w.revenue)}`}>
                  <span style={{ height: `${(w.visits / maxV) * 100}%` }} />
                </div>
              ))}
            </div>
            <div className="com-weeks-axis muted small"><span>{weekLabel(d.weeks[0].week)}</span><span>{weekLabel(d.weeks[d.weeks.length - 1].week)}</span></div>
          </section>
          <section className="card flush">
            <div className="seg-table-head"><h2>Clients <span className="muted">· {d.clients.length}</span></h2><span className="muted small">One row per address this organization books</span></div>
            <div className="table-scroll">
              <table className="seg-table">
                <thead><tr><th>Client</th><th>Visits</th><th>Revenue</th><th>Rhythm</th><th>Usual cleaner</th><th>Last clean</th><th>Next clean</th></tr></thead>
                <tbody>
                  {d.clients.map((c) => (
                    <tr key={c.id}>
                      <td><b>{c.name}</b>{c.addr && c.addr !== c.name && <div className="muted small">{c.addr}</div>}</td>
                      <td>{c.visits}</td>
                      <td>{money(c.revenue)}</td>
                      <td><RhythmPill rhythm={c.rhythm} /></td>
                      <td>{c.cleaner || '—'}</td>
                      <td>{niceDate(c.last)}</td>
                      <td>{c.next ? <>{niceDate(c.next.date)} {clockOf(c.next.time)}{!c.next.cleaner && <span className="com-pill down"> No cleaner</span>}</> : <span className="com-pill flat">Nothing booked</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
