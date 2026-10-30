import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { l27 } from '../api';
import type { Booking, Customer, Tag } from '../types';
import { fmtDateTime, fmtMoney } from '../format';
import { customerName } from './Customers';
import { CustomerEditor } from '../components/CustomerEditor';
import { useCanWrite } from '../hooks';

// Booking tabs on Launch27's customer page, with the exact params it sends.
const BOOKING_TABS = [
  { label: 'Upcoming', params: { options: 'not_completed', sort: 'asc' } },
  { label: 'Past', params: { options: 'completed,exclude_forecasted' } },
  { label: 'Cancelled', params: { filter: 'cancelled' } },
  { label: 'With feedback', params: { options: 'with_feedback,exclude_forecasted' } },
];
const PAGE = 25;

// Same data Launch27's /admin/customers/:id/edit loads:
//   GET /v1/staff/customers/:id, /phones, /addresses, /tags
//   GET /v1/staff/bookings?customers=:id&... (+ /count) per tab
export function CustomerDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [tab, setTab] = useState(0);
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState(false);
  const canWrite = useCanWrite();

  const customer = useQuery({ queryKey: ['customer', id], queryFn: () => l27<Customer>(`/v1/staff/customers/${id}`) });
  const phones = useQuery({ queryKey: ['customer', id, 'phones'], queryFn: () => l27<{ id: number; phone: string; label: string | null; preferred: boolean }[]>(`/v1/staff/customers/${id}/phones`) });
  const addresses = useQuery({ queryKey: ['customer', id, 'addresses'], queryFn: () => l27<{ id: number; address: string; city: string; state: string; zip: string; preferred: boolean }[]>(`/v1/staff/customers/${id}/addresses`) });
  const tags = useQuery({ queryKey: ['customer', id, 'tags'], queryFn: () => l27<Tag[]>(`/v1/staff/customers/${id}/tags`) });

  const params = { customers: id, ...BOOKING_TABS[tab].params };
  const bookings = useQuery({
    queryKey: ['customer', id, 'bookings', tab, page],
    queryFn: () => l27<Booking[]>('/v1/staff/bookings', { ...params, limit: PAGE, offset: page * PAGE }),
  });
  const counts = useQuery({
    queryKey: ['customer', id, 'booking-counts'],
    queryFn: () => Promise.all(BOOKING_TABS.map((t) => l27<{ count: number }>('/v1/staff/bookings/count', { customers: id, ...t.params }).then((r) => r.count))),
  });

  if (customer.isLoading) return <div className="muted">Loading…</div>;
  if (customer.error) return <div className="error">{(customer.error as Error).message}</div>;
  const c = customer.data!;
  const total = counts.data?.[tab] ?? 0;

  return (
    <>
      <header className="page-header">
        <div>
          <div className="muted small">
            <Link to="/customers">Customers</Link> /
          </div>
          <h1>
            {customerName(c)} {!c.active && <span className="badge danger">inactive</span>}
          </h1>
        </div>
        {canWrite && !editing && (
          <div className="actions">
            <button type="button" className="secondary" onClick={() => setEditing(true)}>
              Edit customer
            </button>
            <Link to={`/bookings/new?customer=${c.id}`} className="button">
              New booking
            </Link>
          </div>
        )}
      </header>

      {editing && <CustomerEditor customer={c} onDone={() => setEditing(false)} />}

      <div className="grid-2">
        <section className="card">
          <h2>Contact</h2>
          <dl className="kv">
            {c.company_name && (
              <>
                <dt>Company</dt>
                <dd>{c.company_name}</dd>
              </>
            )}
            <dt>Email</dt>
            <dd>{c.email || '—'}</dd>
            <dt>Phones</dt>
            <dd>{phones.data?.map((p) => <div key={p.id}>{p.phone} {p.label && <span className="muted small">({p.label})</span>}</div>) || c.phone || '—'}</dd>
            <dt>Referral code</dt>
            <dd>{c.referral_code || '—'}</dd>
            <dt>Customer since</dt>
            <dd>{fmtDateTime(c.created_at)}</dd>
            <dt>Tags</dt>
            <dd>{tags.data?.length ? tags.data.map((t) => <span key={t.id} className="pill">{t.name}</span>) : '—'}</dd>
          </dl>
        </section>
        <section className="card">
          <h2>Addresses</h2>
          {addresses.data?.map((a) => (
            <div key={a.id} className="row-line">
              <span>{[a.address, a.city, a.state, a.zip].filter(Boolean).join(', ')}</span>
              {a.preferred && <span className="pill">preferred</span>}
            </div>
          )) || <div className="muted small">{[c.address, c.city, c.state, c.zip].filter(Boolean).join(', ') || '—'}</div>}
          {c.notes && (
            <>
              <h3>Notes</h3>
              <p className="pre">{c.notes}</p>
            </>
          )}
        </section>
      </div>

      <div className="tabs">
        {BOOKING_TABS.map((t, i) => (
          <button key={t.label} className={i === tab ? 'tab active' : 'tab'} onClick={() => { setTab(i); setPage(0); }}>
            {t.label} {counts.data && <span className="muted">({counts.data[i]})</span>}
          </button>
        ))}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Service</th>
              <th>Frequency</th>
              <th>Team</th>
              <th className="num">Total</th>
            </tr>
          </thead>
          <tbody>
            {bookings.isLoading && (
              <tr>
                <td colSpan={5} className="muted">Loading…</td>
              </tr>
            )}
            {bookings.data?.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">No bookings.</td>
              </tr>
            )}
            {bookings.data?.map((b) => (
              <tr key={b.id} onClick={() => navigate(`/bookings/${b.id}`)}>
                <td>{fmtDateTime(b.service_date)}</td>
                <td>{b.services?.map((s) => s.name).join(', ') || '—'}</td>
                <td>{b.frequency?.name || '—'}</td>
                <td>{b.teams?.map((t) => t.title).join(', ') || <span className="warn">Unassigned</span>}</td>
                <td className="num">{fmtMoney(b.summary?.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {total > PAGE && (
        <div className="pager">
          <button disabled={page === 0} onClick={() => setPage(page - 1)}>‹ Prev</button>
          <span className="muted small">Page {page + 1} of {Math.ceil(total / PAGE)}</span>
          <button disabled={(page + 1) * PAGE >= total} onClick={() => setPage(page + 1)}>Next ›</button>
        </div>
      )}
    </>
  );
}
