import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { l27 } from '../api';
import { BarChart } from '../components/BarChart';
import { fmtMoney, TIMEZONE } from '../format';

type Series = [string, number | string][];
type Trend = Record<string, number>;

interface DashboardReport {
  sales: {
    total_revenue: number;
    repeat_customers: { recurring_revenue: number; one_time_revenue: number; recurring_revenue_percent: number };
    new_customers: { revenue: number; revenue_percent: number };
    revenue_data: Record<string, Series>;
  };
  bookings: {
    total_count: number;
    repeat_customers: { recurring_count: number; one_time_count: number; recurring_count_percent: number };
    new_customers: { count: number; count_percent: number };
    active_bookings_customers_count: number;
    recurring_bookings_customers_count: number;
    bookings_data: Record<string, Series>;
    total_Estduration: number;
    total_timeReported: number;
    total_timecredited: number;
    total_timetravel: number;
  };
  customers: { count: number; recurring_count: number; recurring_percent: number };
  churn_data: Series;
  extra_data: Series;
  trends_data: { day: Trend; week: Trend; month: Trend; year: Trend };
}

function isoDaysAgo(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

// GET /v1/staff/reports/dashboard?from&to (same call as Launch27's /admin/dashboard)
export function DashboardPage() {
  const [from, setFrom] = useState(isoDaysAgo(30));
  const [to, setTo] = useState(isoDaysAgo(0));
  const report = useQuery({
    queryKey: ['dashboard', from, to],
    queryFn: () => l27<DashboardReport>('/v1/staff/reports/dashboard', { from, to }),
  });
  const d = report.data;

  return (
    <>
      <header className="page-header">
        <h1>Dashboard</h1>
        <div className="filters">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </div>
      </header>
      {report.isLoading && <div className="muted">Loading…</div>}
      {report.error && <div className="error">{(report.error as Error).message}</div>}
      {d && (
        <>
          <div className="tiles">
            <Tile label="Revenue" value={fmtMoney(d.sales.total_revenue)} sub={`${d.sales.repeat_customers.recurring_revenue_percent}% recurring`} />
            <Tile label="Bookings" value={d.bookings.total_count.toLocaleString()} sub={`${d.bookings.new_customers.count} from new customers`} />
            <Tile label="Avg. booking" value={fmtMoney(d.bookings.total_count ? d.sales.total_revenue / d.bookings.total_count : 0)} />
            <Tile label="Active customers" value={d.bookings.active_bookings_customers_count.toLocaleString()} sub={`${d.bookings.recurring_bookings_customers_count} recurring`} />
            <Tile label="Hours (est. / reported)" value={`${d.bookings.total_Estduration.toLocaleString()} / ${d.bookings.total_timeReported.toLocaleString()}`} />
          </div>

          <div className="grid-2">
            <section className="card">
              <h2>Revenue by day</h2>
              <BarChart series={d.sales.revenue_data.day} format={fmtMoney} />
            </section>
            <section className="card">
              <h2>Bookings by day</h2>
              <BarChart series={d.bookings.bookings_data.day} />
            </section>
          </div>

          <section className="card">
            <h2>Trends (current vs previous period)</h2>
            <table>
              <thead>
                <tr>
                  <th>Period</th>
                  <th className="num">Bookings</th>
                  <th className="num">Sales</th>
                  <th className="num">Avg. revenue</th>
                </tr>
              </thead>
              <tbody>
                {(['day', 'week', 'month', 'year'] as const).map((p) => {
                  const t = d.trends_data[p];
                  return (
                    <tr key={p} className="static">
                      <td>{p[0].toUpperCase() + p.slice(1)}</td>
                      <td className="num">
                        {t.bookings_current.toLocaleString()} <Change v={t.bookings_change} />
                      </td>
                      <td className="num">
                        {fmtMoney(t.sales_current)} <Change v={t.sales_change} />
                      </td>
                      <td className="num">
                        {fmtMoney(t.avg_revenue_current)} <Change v={t.avg_revenue_change} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        </>
      )}
    </>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card tile">
      <div className="muted small">{label}</div>
      <div className="tile-value">{value}</div>
      {sub && <div className="muted small">{sub}</div>}
    </div>
  );
}

function Change({ v }: { v: number }) {
  return <span className={`small ${v >= 0 ? 'ok' : 'neg'}`}>{v >= 0 ? '▲' : '▼'} {Math.abs(v).toFixed(1)}%</span>;
}
