import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { l27All } from '../api';
import type { Booking } from '../types';
import { fmtDateTime, fmtMoney, fmtTime, todayISO } from '../format';

// Filter values Launch27's own bookings page offers.
const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'unassigned', label: 'Unassigned' },
  { id: 'recurring', label: 'Recurring' },
  { id: 'new_customer', label: 'New customer' },
  { id: 'cancelled', label: 'Cancelled' },
];

// GET /v1/staff/bookings?filter=&from=&to=&sort=asc&limit=100&offset=  (all pages)
export function BookingsPage() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState('all');
  const [from, setFrom] = useState(todayISO());
  const [to, setTo] = useState(todayISO());
  const [search, setSearch] = useState('');

  const bookings = useQuery({
    queryKey: ['bookings', from, to, filter],
    queryFn: () => l27All<Booking>('/v1/staff/bookings', { filter, from, to, sort: 'asc' }),
  });

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = [...(bookings.data || [])].sort((a, b) => (a.service_date || '').localeCompare(b.service_date || ''));
    if (!q) return list;
    return list.filter((b) =>
      [b.id, b.user?.name, b.user?.email, b.address?.full_address, b.teams?.map((t) => t.title).join(' ')]
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [bookings.data, search]);

  const total = rows.reduce((sum, b) => sum + (b.summary?.total || 0), 0);

  return (
    <>
      <header className="page-header">
        <h1>Bookings</h1>
        <div className="filters">
          <label>
            From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            To <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </label>
          <input placeholder="Search customer, address, team…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </header>

      <div className="tabs">
        {FILTERS.map((f) => (
          <button key={f.id} className={f.id === filter ? 'tab active' : 'tab'} onClick={() => setFilter(f.id)}>
            {f.label}
          </button>
        ))}
      </div>

      {bookings.isLoading && <div className="muted">Loading bookings…</div>}
      {bookings.error && <div className="error">{(bookings.error as Error).message}</div>}

      {bookings.data && (
        <>
          <div className="muted small summary">
            {rows.length} bookings · {fmtMoney(total)} total
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Customer</th>
                  <th>Address</th>
                  <th>Service</th>
                  <th>Team</th>
                  <th>Status</th>
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => {
                  const tt = b.time_tracking?.[0];
                  return (
                    <tr key={b.id} onClick={() => navigate(`/bookings/${b.id}`)}>
                      <td>{fmtDateTime(b.service_date)}</td>
                      <td>
                        {b.user?.name || '—'}
                        {b.user?.is_new_customer && <span className="badge">new</span>}
                      </td>
                      <td>{b.address?.full_address || '—'}</td>
                      <td>{b.services?.[0]?.name || '—'}</td>
                      <td>{b.teams?.map((t) => t.title).join(', ') || <span className="warn">Unassigned</span>}</td>
                      <td>
                        <TrackingStatus tt={tt} />
                      </td>
                      <td className="num">{fmtMoney(b.summary?.total)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

    </>
  );
}

function TrackingStatus({ tt }: { tt?: Booking['time_tracking'] extends (infer T)[] | undefined ? T : never }) {
  if (!tt) return <span className="muted">—</span>;
  if (tt.checkout_at) return <span>Done {fmtTime(tt.checkout_at)}</span>;
  if (tt.checkin_at) return <span className="ok">In since {fmtTime(tt.checkin_at)}</span>;
  if (tt.enroute_started_at) return <span>En route {fmtTime(tt.enroute_started_at)}</span>;
  return <span className="muted">{tt.state || 'Scheduled'}</span>;
}
