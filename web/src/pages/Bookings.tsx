import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { l27All } from '../api';
import type { Booking } from '../types';
import { fmtDateTime, fmtMoney, fmtTime, todayISO } from '../format';

// Same request the check-in tracker makes: GET /v1/staff/bookings?from=&to=&limit=100&offset=
export function BookingsPage() {
  const [from, setFrom] = useState(todayISO());
  const [to, setTo] = useState(todayISO());
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Booking | null>(null);

  const bookings = useQuery({
    queryKey: ['bookings', from, to],
    queryFn: () => l27All<Booking>('/v1/staff/bookings', { from, to }),
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
                    <tr key={b.id} onClick={() => setSelected(b)} className={selected?.id === b.id ? 'selected' : ''}>
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

      {selected && <BookingDrawer booking={selected} onClose={() => setSelected(null)} />}
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

function BookingDrawer({ booking: b, onClose }: { booking: Booking; onClose: () => void }) {
  const fields: [string, React.ReactNode][] = [
    ['Booking #', b.id],
    ['Date', fmtDateTime(b.service_date)],
    ['Arrival window', b.arrival_window ?? '—'],
    ['Duration', b.duration ?? '—'],
    ['Frequency', b.frequency?.name || '—'],
    ['Location', b.location?.name || '—'],
    ['Customer', b.user?.name || '—'],
    ['Email', b.user?.email || '—'],
    ['Phone', b.phone || '—'],
    ['Address', b.address?.full_address || '—'],
    ['Payment', b.payment_method_info?.text || '—'],
    ['Revenue', fmtMoney(b.summary?.revenue)],
    ['Discount', fmtMoney(b.summary?.discount)],
    ['Tip', fmtMoney(b.summary?.tip)],
    ['Total', fmtMoney(b.summary?.total)],
    ['Created', `${fmtDateTime(b.created_at)}${b.created_by?.name ? ` by ${b.created_by.name}` : ''}`],
  ];
  for (const cf of b.custom_fields || []) {
    const v = cf.values?.[0];
    if (cf.title && v) fields.push([cf.title, v.label ?? v.value ?? '—']);
  }

  return (
    <aside className="drawer">
      <div className="drawer-header">
        <h2>Booking {b.id}</h2>
        <button className="link" onClick={onClose}>
          Close
        </button>
      </div>
      <dl>
        {fields.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {!!b.time_tracking?.length && (
        <>
          <h3>Time tracking</h3>
          {b.time_tracking.map((t, i) => (
            <div key={i} className="small">
              En route {fmtTime(t.enroute_started_at)} → {fmtTime(t.enroute_finished_at)} · In {fmtTime(t.checkin_at)} · Out {fmtTime(t.checkout_at)}
              {t.distance != null && ` · ${t.distance} km`}
            </div>
          ))}
        </>
      )}
      <details>
        <summary>Raw JSON</summary>
        <pre>{JSON.stringify(b, null, 2)}</pre>
      </details>
    </aside>
  );
}
