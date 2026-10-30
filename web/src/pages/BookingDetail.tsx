import { Fragment } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { l27 } from '../api';
import type { Booking, BookingComment, Charge } from '../types';
import { fmtDateTime, fmtMoney, fmtTime } from '../format';

// Same data Launch27's /admin/bookings/:id/edit loads:
//   GET /v1/staff/bookings/:id
//   GET /v1/staff/bookings/:id/comments
//   GET /v1/staff/bookings/:id/recurring?mode=next
export function BookingDetailPage() {
  const { id } = useParams();
  const booking = useQuery({ queryKey: ['booking', id], queryFn: () => l27<Booking>(`/v1/staff/bookings/${id}`) });
  const comments = useQuery({ queryKey: ['booking', id, 'comments'], queryFn: () => l27<BookingComment[] | null>(`/v1/staff/bookings/${id}/comments`) });
  const next = useQuery({ queryKey: ['booking', id, 'recurring'], queryFn: () => l27<Booking[] | null>(`/v1/staff/bookings/${id}/recurring`, { mode: 'next' }) });

  if (booking.isLoading) return <div className="muted">Loading…</div>;
  if (booking.error) return <div className="error">{(booking.error as Error).message}</div>;
  const b = booking.data!;
  const s = b.summary || {};
  const charges: (Charge & { kind: string })[] = (['charged', 'onhold', 'refunded', 'marked_paid'] as const).flatMap((kind) => (b.charges?.[kind] || []).map((c) => ({ ...c, kind })));

  return (
    <>
      <header className="page-header">
        <div>
          <div className="muted small">
            <Link to="/bookings">Bookings</Link> /
          </div>
          <h1>
            Booking #{b.id} {!b.active && <span className="badge danger">cancelled</span>}
            {b.completed && <span className="badge">completed</span>}
          </h1>
        </div>
      </header>

      <div className="grid-2">
        <section className="card">
          <h2>When & where</h2>
          <dl className="kv">
            <dt>Date</dt>
            <dd>{fmtDateTime(b.service_date)}</dd>
            <dt>Arrival window</dt>
            <dd>{b.arrival_window ? `${b.arrival_window} min` : '—'}</dd>
            <dt>Duration</dt>
            <dd>{b.duration ? `${(b.duration / 60).toFixed(1)} h` : '—'}</dd>
            <dt>Frequency</dt>
            <dd>{b.frequency?.name || '—'}</dd>
            <dt>Location</dt>
            <dd>{b.location?.name || '—'}</dd>
            <dt>Address</dt>
            <dd>{b.address?.full_address || '—'}</dd>
            <dt>Team</dt>
            <dd>{b.teams?.length ? b.teams.map((t) => t.title).join(', ') : <span className="warn">Unassigned</span>}</dd>
          </dl>
        </section>

        <section className="card">
          <h2>Customer</h2>
          <dl className="kv">
            <dt>Name</dt>
            <dd>{b.user?.id ? <Link to={`/customers/${b.user.id}`}>{b.user.name}</Link> : b.user?.name || '—'}</dd>
            <dt>Email</dt>
            <dd>{b.user?.email || '—'}</dd>
            <dt>Phone</dt>
            <dd>{b.phone || '—'}</dd>
            <dt>Payment</dt>
            <dd>{b.payment_method_info?.text || '—'}</dd>
            <dt>Created</dt>
            <dd>
              {fmtDateTime(b.created_at)}
              {b.created_by?.name && ` by ${b.created_by.name}`}
            </dd>
          </dl>
        </section>
      </div>

      <div className="grid-2">
        <section className="card">
          <h2>Services</h2>
          <table>
            <tbody>
              {b.services?.map((svc) => (
                <Fragment key={svc.id}>
                  <tr className="static">
                    <td>
                      <strong>{svc.name}</strong>
                    </td>
                    <td className="num">{fmtMoney(svc.price)}</td>
                  </tr>
                  {[...(svc.pricing_parameters || []), ...(svc.extras || [])].filter((item) => item.quantity > 0).map((item) => (
                    <tr key={`i${svc.id}-${item.id}-${item.name}`} className="static">
                      <td className="indent">
                        {item.name} {item.quantity > 1 && `× ${item.quantity}`}
                      </td>
                      <td className="num">{fmtMoney(item.total)}</td>
                    </tr>
                  ))}
                </Fragment>
              ))}
              <Line label="Discount" value={s.discount ? -s.discount : undefined} />
              <Line label={`Adjustment${b.price_adjustment_comment ? ` (${b.price_adjustment_comment})` : ''}`} value={s.adjustment || undefined} />
              <Line label={`Tax ${s.tax?.tax_percent ?? ''}%`} value={s.tax?.tax_amount} />
              <Line label="Tip" value={s.tip || undefined} />
              <tr className="static total">
                <td>Total</td>
                <td className="num">{fmtMoney(s.total)}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section className="card">
          <h2>Time tracking</h2>
          {!b.time_tracking?.length && <div className="muted small">No time tracked.</div>}
          {b.time_tracking?.map((t, i) => (
            <dl className="kv" key={t.id ?? i}>
              <dt>Team</dt>
              <dd>
                {t.team?.title || '—'} <span className="muted small">({t.state})</span>
              </dd>
              <dt>En route</dt>
              <dd>
                {fmtTime(t.enroute_started_at)} → {fmtTime(t.enroute_finished_at)}
              </dd>
              <dt>Checked in / out</dt>
              <dd>
                {fmtTime(t.checkin_at)} → {fmtTime(t.checkout_at)}
              </dd>
              {t.distance != null && (
                <>
                  <dt>Distance</dt>
                  <dd>{t.distance} km</dd>
                </>
              )}
            </dl>
          ))}

          <h2 className="spaced">Charges</h2>
          {!charges.length && <div className="muted small">No charges.</div>}
          {charges.map((c) => (
            <div key={`${c.kind}${c.id}`} className="small row-line">
              <span>
                {fmtDateTime(c.charged_date)} · {c.payment_method_info?.text || c.description} <span className="pill">{c.kind === 'charged' ? c.status : c.kind}</span>
              </span>
              <span>{fmtMoney(c.amount)}</span>
            </div>
          ))}
          {!!b.charges?.outstanding && <div className="warn small">Outstanding: {fmtMoney(b.charges.outstanding)}</div>}
        </section>
      </div>

      <div className="grid-2">
        <section className="card">
          <h2>Notes</h2>
          <h3>Staff notes</h3>
          <p className="pre">{b.staff_notes || <span className="muted">—</span>}</p>
          <h3>Customer notes</h3>
          <p className="pre">{b.customer_notes || <span className="muted">—</span>}</p>
          {b.custom_fields?.filter((cf) => cf.values?.length).map((cf) => (
            <div key={cf.title}>
              <h3>{cf.title}</h3>
              <p>{cf.values?.map((v) => v.other || v.label || v.name || v.value).join(', ')}</p>
            </div>
          ))}
        </section>

        <section className="card">
          <h2>Comments</h2>
          {!comments.data?.length && <div className="muted small">No comments.</div>}
          {comments.data?.map((c) => (
            <div key={c.id} className="comment">
              <div className="muted small">
                {c.author_type} · {fmtDateTime(c.created_at)}
                {c.team_viewable && ' · team can see'}
                {c.customer_viewable && ' · customer can see'}
              </div>
              <div className="pre">{c.comment}</div>
            </div>
          ))}

          {!!next.data?.length && (
            <>
              <h2 className="spaced">Next in series</h2>
              {next.data.slice(0, 5).map((n) => (
                <div key={n.id} className="small row-line">
                  <Link to={`/bookings/${n.id}`}>{fmtDateTime(n.service_date)}</Link>
                  <span>{n.teams?.map((t) => t.title).join(', ') || 'Unassigned'}</span>
                </div>
              ))}
            </>
          )}
        </section>
      </div>
    </>
  );
}

function Line({ label, value }: { label: string; value?: number }) {
  if (value === undefined) return null;
  return (
    <tr className="static">
      <td className="muted">{label}</td>
      <td className="num">{fmtMoney(value)}</td>
    </tr>
  );
}
