import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { l27 } from '../api';
import type { Booking, BookingComment, Charge } from '../types';
import { BookingActions } from '../components/BookingActions';
import { CallButton } from '../components/CallButton';
import { Icon } from '../components/Icon';
import { Avatar, Stepper } from '../inbox/Customer360';
import { inbox } from '../inbox/api';
import { visitStatus } from '../lib/customer360';
import { fmtDateTime, fmtMoney, fmtTime } from '../format';

// Same data Launch27's /admin/bookings/:id/edit loads:
//   GET /v1/staff/bookings/:id
//   GET /v1/staff/bookings/:id/comments
//   GET /v1/staff/bookings/:id/recurring?mode=next
type Cancellation = { fee?: number; date?: string; reason?: string; cancelled_by?: { name?: string } };
const TZ = 'America/New_York';
const longDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : '—');
const shortDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' }) : '—');
const mins = (a?: string, b?: string) => (a && b ? Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60_000) : null);
const hm = (m: number | null) => (m === null ? '—' : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`);

export function BookingDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const booking = useQuery({ queryKey: ['booking', id], queryFn: () => l27<Booking>(`/v1/staff/bookings/${id}`), refetchInterval: 60_000 });
  const comments = useQuery({ queryKey: ['booking', id, 'comments'], queryFn: () => l27<BookingComment[] | null>(`/v1/staff/bookings/${id}/comments`) });
  const next = useQuery({ queryKey: ['booking', id, 'recurring'], queryFn: () => l27<Booking[] | null>(`/v1/staff/bookings/${id}/recurring`, { mode: 'next' }) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (booking.isLoading) return <div className="muted">Loading…</div>;
  if (booking.error) return <div className="error">{(booking.error as Error).message}</div>;
  const b = booking.data!;
  const s = b.summary || {};
  const cancellation = (b as Booking & { cancellation?: Cancellation }).cancellation;
  const status = visitStatus(b);
  const charges: (Charge & { kind: string })[] = (['charged', 'onhold', 'refunded', 'marked_paid'] as const).flatMap((kind) => (b.charges?.[kind] || []).map((c) => ({ ...c, kind })));
  const t = b.time_tracking?.[0];
  const onSite = mins(t?.checkin_at, t?.checkout_at);
  const booked = b.duration ? Math.round(b.duration) : null;
  const state = !b.active ? { label: 'Cancelled', cls: 'chip neg' } : b.completed ? { label: 'Completed', cls: 'chip ok' } : status.stage !== 'booked' ? { label: status.stage === 'done' ? 'Checked out' : status.stage === 'arrived' ? 'Checked in' : 'En route', cls: 'chip accent' } : { label: 'Upcoming', cls: 'chip' };
  const windowText = status.windowEnd > status.windowStart ? `${fmtTime(b.service_date)}–${fmtTime(new Date(status.windowEnd).toISOString())}` : fmtTime(b.service_date);
  const cleaner = b.teams?.[0];
  const firstName = (b.user?.name || '').split(' ')[0];

  const textPerson = async (who: 'customer' | 'cleaner') => {
    setBusy(true);
    setError(null);
    try {
      const person = who === 'customer' ? await inbox.fromL27({ customer_id: b.user!.id! }) : await inbox.fromL27({ team_id: cleaner!.id! });
      const conv = await inbox.start({ contact_id: person.id, channel: 'sms', l27_booking_id: b.id });
      const prefill = who === 'customer' ? `Hi ${firstName}, about your ${shortDate(b.service_date)} clean: ` : `Hi ${(person.name || '').split(' ')[0]}, about your ${shortDate(b.service_date)} ${fmtTime(b.service_date)} visit at ${b.address?.street || b.address?.full_address || 'the client'}: `;
      navigate(`/inbox/${conv.id}`, { state: { prefill } });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const di: NonNullable<Booking['discount_info']> = b.discount_info || {};
  const subtotal = r2((s.services || 0) + ((s as { pricing_parameters?: number }).pricing_parameters || 0) + (s.extras || 0));
  const items = (b.services || []).flatMap((svc) => [
    {
      key: `s${svc.id}`,
      label: svc.hourly ? `${svc.name} · ${hoursLabel(svc.hourly.minutes)} × ${svc.hourly.quantity} cleaner${svc.hourly.quantity === 1 ? '' : 's'}` : svc.name,
      amount: svc.price,
      main: true,
    },
    ...[...(svc.pricing_parameters || []), ...(svc.extras || [])].filter((i) => i.quantity > 0).map((i) => ({ key: `i${svc.id}-${i.id}-${i.name}`, label: `${i.name}${i.quantity > 1 ? ` × ${i.quantity}` : ''}`, amount: i.total, main: false })),
  ]);

  return (
    <div className="bk">
      <div className="crumbs small">
        <Link to="/bookings">Bookings</Link> / #{b.id}
      </div>

      <section className="card bk-hero">
        <div className="bk-hero-top">
          <div className="date-tile big" aria-hidden="true">
            <span className="m">{b.service_date ? new Date(b.service_date).toLocaleDateString('en-CA', { timeZone: TZ, month: 'short' }).replace('.', '').toUpperCase() : '—'}</span>
            <span className="d mono">{b.service_date ? new Date(b.service_date).toLocaleDateString('en-CA', { timeZone: TZ, day: 'numeric' }) : ''}</span>
            <span className="w">{b.service_date ? new Date(b.service_date).toLocaleDateString('en-CA', { timeZone: TZ, weekday: 'short' }) : ''}</span>
          </div>
          <div className="grow bk-hero-main">
            <div className="c360-title">
              <span className="eyebrow">Booking #{b.id}</span>
              <span className={state.cls}>{state.label}</span>
              {b.frequency?.name && <span className="chip">{b.frequency.name}</span>}
              {status.risk && b.active !== false && !b.completed && <span className="chip warn">{status.risk.label}</span>}
            </div>
            <h1>
              {longDate(b.service_date)} · {windowText}
            </h1>
            <p className="c360-summary">
              {b.services?.map((x) => x.name).join(', ')}
              {booked ? ` · ${hm(booked)} booked` : ''} · {b.address?.full_address || 'No address'}
            </p>
          </div>
          <div className="c360-actions">
            <BookingActions booking={b} />
          </div>
        </div>
        {cancellation && (
          <div className="bk-cancel">
            <Icon name="alert" /> <strong>Cancelled</strong> {fmtDateTime(cancellation.date)}
            {cancellation.cancelled_by?.name && ` by ${cancellation.cancelled_by.name}`} · fee {fmtMoney(cancellation.fee || 0)}
            {cancellation.reason && <span className="muted"> · “{cancellation.reason}”</span>}
          </div>
        )}
      </section>
      {error && <div className="error">{error}</div>}

      <div className="c360-cols">
        <div className="c360-main">
          {b.active !== false && (
            <section className={status.risk && !b.completed ? 'card state-card risk' : status.stage !== 'booked' && !b.completed ? 'card state-card live' : 'card state-card'}>
              <div className="visit">
                <div className="visit-head">
                  <div className="eyebrow accent">Visit progress</div>
                  {t?.distance != null && <span className="chip">{t.distance} km driven</span>}
                </div>
                <Stepper booking={b} />
                {(b.teams?.length ? b.teams : [{ id: undefined, title: undefined }]).map((team, i) => (
                  <div key={team.id ?? i} className="visit-who">
                    <Avatar name={team.title || '?'} size={40} />
                    <div className="grow">
                      <strong>{team.title || <span className="warn">No cleaner assigned</span>}</strong>
                      <div className="muted small">
                        Window {windowText}
                        {onSite !== null && <> · on site {hm(onSite)}{booked ? ` (booked ${hm(booked)})` : ''}</>}
                      </div>
                    </div>
                    {team.id && i === 0 && (
                      <button type="button" className="secondary" disabled={busy} onClick={() => textPerson('cleaner')}>
                        <Icon name="sms" /> Text {(team.title || '').split(' ')[0]}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="card story bk-receipt">
            <div className="story-head">
              <h2>What's booked</h2>
              <span className="muted small">{b.location?.name}</span>
            </div>
            {items.map((i) => (
              <div key={i.key} className={i.main ? 'rc-line main' : 'rc-line'}>
                <span>{i.label}</span>
                <span className="mono">{fmtMoney(i.amount)}</span>
              </div>
            ))}
            <div className="rc-sep" />
            <Line label="Subtotal" value={subtotal} />
            {!!di.frequency_amount && <Line label={frequencyLabel(b.frequency?.name)} value={-di.frequency_amount} />}
            {!!di.discount_amount && <Line label={`Code ${di.discount_code?.toUpperCase() || ''}`} value={-di.discount_amount} />}
            {/* Older bookings may carry a discount without the breakdown. */}
            {!di.frequency_amount && !di.discount_amount && !!s.discount && !di.giftcard_amount && <Line label="Discount" value={-s.discount} />}
            {!!s.adjustment && <Line label={`Adjustment${b.price_adjustment_comment ? ` (${b.price_adjustment_comment})` : ''}`} value={s.adjustment} />}
            <Line label="Before tax" value={s.revenue ?? 0} strong />
            {s.tax?.tax_amount !== undefined && <Line label={`HST ${s.tax?.tax_percent ?? ''}%`} value={s.tax.tax_amount} />}
            {!!s.tip && <Line label="Tip" value={s.tip} />}
            {!!di.giftcard_amount && <Line label="Gift card" value={-di.giftcard_amount} />}
            <div className="rc-line total">
              <span>Total</span>
              <span className="mono">{fmtMoney(s.total)}</span>
            </div>
            {s.revenue === 0 && !!s.adjustment && s.adjustment < 0 && <div className="muted small">The adjustment covers this visit (e.g. a prepaid plan), so nothing is charged.</div>}
            <div className="muted small">Paid by {b.payment_method_info?.text || '—'}</div>
          </section>

          <section className="card story">
            <div className="story-head">
              <h2>Payments</h2>
              {!!b.charges?.outstanding && <span className="chip warn">{fmtMoney(b.charges.outstanding)} not collected</span>}
            </div>
            {!charges.length && <div className="muted">No charges yet.</div>}
            {charges.map((c) => {
              const label = c.kind === 'refunded' && /^on hold\b/i.test(c.description || '') ? 'Hold released' : c.kind === 'charged' ? c.status || 'Charged' : c.kind === 'onhold' ? 'On hold' : c.kind === 'refunded' ? 'Refunded' : 'Marked paid';
              const tone = c.kind === 'charged' && !/fail|declin/i.test(c.status || '') ? 'ok' : c.kind === 'onhold' ? 'warn' : /fail|declin/i.test(c.status || '') ? 'neg' : '';
              return (
                <div key={`${c.kind}${c.id}`} className="ev">
                  <span className={`ev-dot money ${tone}`}>
                    <Icon name="money" />
                  </span>
                  <div className="grow">
                    <div className="ev-title">
                      <strong>{label}</strong> · {c.payment_method_info?.text || c.description}
                    </div>
                    <div className="muted small">{fmtDateTime(c.charged_date)}</div>
                  </div>
                  <span className="mono ev-amt">{fmtMoney(c.amount)}</span>
                </div>
              );
            })}
          </section>

          <section className="card story">
            <div className="story-head">
              <h2>Comments</h2>
            </div>
            {!comments.data?.length && <div className="muted">No comments.</div>}
            {comments.data?.map((c) => (
              <div key={c.id} className="ev">
                <span className="ev-dot note">
                  <Icon name="note" />
                </span>
                <div className="grow">
                  <div className="ev-title pre">{c.comment}</div>
                  <div className="muted small">
                    {c.author_type} · {fmtDateTime(c.created_at)}
                    {c.team_viewable && ' · cleaner can see'}
                    {c.customer_viewable && ' · customer can see'}
                  </div>
                </div>
              </div>
            ))}
          </section>
        </div>

        <aside className="c360-side">
          <section className="card side-card">
            <h2>Customer</h2>
            <div className="cleaner-row">
              <Avatar name={b.user?.name} size={40} />
              <div className="grow">
                {b.user?.id ? <Link to={`/customers/${b.user.id}`}><strong>{b.user.name}</strong></Link> : <strong>{b.user?.name || '—'}</strong>}
                <div className="muted small">{[b.user?.email, b.phone].filter(Boolean).join(' · ')}</div>
              </div>
            </div>
            <div className="visit-actions grid2" style={{ borderTop: 0, paddingTop: 0 }}>
              {b.user?.id && (
                <button type="button" className="secondary" disabled={busy} onClick={() => textPerson('customer')}>
                  <Icon name="sms" /> Text
                </button>
              )}
              <CallButton phone={b.phone} />
            </div>
            {b.user?.id && <Link to={`/customers/${b.user.id}`} className="small">Open customer 360</Link>}
          </section>

          <section className="card side-card access">
            <h2>Where and access</h2>
            {b.address?.full_address && (
              <div className="access-line">
                <Icon name="pin" />
                <span>
                  {b.address.full_address}{' '}
                  <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(b.address.full_address)}`} target="_blank" rel="noreferrer">
                    Map
                  </a>
                </span>
              </div>
            )}
            {b.custom_fields?.filter((cf) => cf.values?.length).map((cf) => (
              <div key={cf.title} className="access-line">
                <Icon name="key" />
                <span>
                  <span className="muted">{cf.title?.replace(/\?$/, '')}:</span> {cf.values?.map((v) => v.other || v.label || v.name || v.value).join(', ')}
                </span>
              </div>
            ))}
            {b.customer_notes && (
              <div>
                <div className="eyebrow">From the customer</div>
                <p className="pre small">{b.customer_notes}</p>
              </div>
            )}
            {b.staff_notes && (
              <div>
                <div className="eyebrow">Staff notes</div>
                <p className="pre small">{b.staff_notes}</p>
              </div>
            )}
          </section>

          {!!next.data?.length && (
            <section className="card side-card">
              <h2>Next in this series</h2>
              {next.data.slice(0, 5).map((n) => (
                <Link key={n.id} to={`/bookings/${n.id}`} className="up-row">
                  <span>
                    {shortDate(n.service_date)} · {fmtTime(n.service_date)}
                  </span>
                  <span className={n.teams?.length ? 'muted' : 'warn'}>{n.teams?.map((x) => x.title).join(', ') || 'No cleaner yet'}</span>
                </Link>
              ))}
            </section>
          )}

          <section className="card side-card">
            <h2>Details</h2>
            <dl className="kv2">
              <dt>Created</dt>
              <dd>
                {shortDate(b.created_at)}
                {b.created_by?.name ? ` by ${b.created_by.name}` : ''}
              </dd>
              <dt>Location</dt>
              <dd>{b.location?.name || '—'}</dd>
              <dt>Text alerts</dt>
              <dd>{b.sms_notifications === false ? 'Off' : 'On'}</dd>
            </dl>
          </section>
        </aside>
      </div>
    </div>
  );
}

// "Weekly - 15% off" -> "Weekly discount (15%)"
const frequencyLabel = (name?: string) => {
  const pct = name?.match(/(\d+)%/)?.[1];
  return `${(name || 'Frequency').replace(/\s*-?\s*\d+%\s*off/i, '').trim()} discount${pct ? ` (${pct}%)` : ''}`;
};
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const hoursLabel = (minutes: number) => `${Number.isInteger(minutes / 60) ? minutes / 60 : (minutes / 60).toFixed(1)} h`;

function Line({ label, value, strong }: { label: string; value?: number; strong?: boolean }) {
  return (
    <div className={strong ? 'rc-line sub strong' : 'rc-line sub'}>
      <span>{label}</span>
      <span className="mono">{fmtMoney(value)}</span>
    </div>
  );
}
