import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { l27, l27All } from '../api';
import type { Booking, Customer, Tag, TimeTracking } from '../types';
import type { RatedBooking } from '../lib/feedbackModel';
import { fmtDateTime, fmtMoney, fmtTime } from '../format';
import { BookingActions } from '../components/BookingActions';
import { Icon } from '../components/Icon';
import { CallButton } from '../components/CallButton';
import { insights, rhythmLabel, summarySentence, visitStatus, type Insights, type Stage } from '../lib/customer360';
import { inbox, type Contact } from './api';
import { ago, displayIdentity } from './util';

const STALE = 15 * 60_000;
const TZ = 'America/New_York';

// Customer 360: what's happening now, who they are, how it's going. Two layouts:
// the compact panel beside a conversation, and the full customer page (`full`).
type Props = { contact: Contact; conversationId?: number; pinnedBookingId?: number | null; onInsert?: (text: string) => void; full?: boolean; actions?: ReactNode };

export function Customer360(props: Props) {
  const cid = props.contact.l27_customer_id;
  if (!cid) return <LinkToLaunch27 contact={props.contact} />;
  return <CustomerView cid={cid} {...props} />;
}

function useCustomerData(cid: number, contactId: number) {
  const customer = useQuery({ queryKey: ['customer', String(cid)], queryFn: () => l27<Customer>(`/v1/staff/customers/${cid}`), staleTime: STALE });
  const tags = useQuery({ queryKey: ['customer', String(cid), 'tags'], queryFn: () => l27<Tag[]>(`/v1/staff/customers/${cid}/tags`), staleTime: STALE });
  const addresses = useQuery({ queryKey: ['customer', String(cid), 'addresses'], queryFn: () => l27<Address[]>(`/v1/staff/customers/${cid}/addresses`), staleTime: STALE });
  const billing = useQuery({ queryKey: ['customer', String(cid), 'billing'], queryFn: () => l27<{ cards?: { id: string; brand: string; last4: string; exp_month: number; exp_year: number; is_default: boolean; is_deleted: boolean }[] }>(`/v1/staff/customers/${cid}/setup/billing`), staleTime: STALE });
  const upcoming = useQuery({ queryKey: ['customer', String(cid), '360', 'upcoming'], queryFn: () => l27<Booking[]>('/v1/staff/bookings', { customers: cid, options: 'not_completed', sort: 'asc', limit: 50 }), refetchInterval: 60_000 });
  const past = useQuery({ queryKey: ['customer', String(cid), '360', 'past'], queryFn: () => l27All<RatedBooking>('/v1/staff/bookings', { customers: cid, options: 'completed,exclude_forecasted', sort: 'desc' }), staleTime: STALE });
  const cancelled = useQuery({ queryKey: ['customer', String(cid), '360', 'cancelled'], queryFn: () => l27<{ count: number }>('/v1/staff/bookings/count', { customers: cid, filter: 'cancelled' }), staleTime: STALE });
  const contactFull = useQuery({ queryKey: ['inbox', 'contact', contactId], queryFn: () => inbox.contact(contactId), staleTime: 15_000 });
  return { customer, tags, addresses, billing, upcoming, past, cancelled, contactFull };
}

type Address = { id: number; address: string; city: string; state?: string; zip: string; preferred: boolean };

const initials = (name?: string | null) =>
  (name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');
const AVATAR = ['#FDE68A:#78350F', '#FECACA:#7F1D1D', '#DDD6FE:#4C1D95', '#BBF7D0:#14532D', '#FBCFE8:#831843', '#BAE6FD:#0C4A6E', '#FED7AA:#7C2D12'];
export function Avatar({ name, size = 36 }: { name?: string | null; size?: number }) {
  const [bg, fg] = AVATAR[[...(name || '')].reduce((s, c) => s + c.charCodeAt(0), 0) % AVATAR.length].split(':');
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.36), background: bg, color: fg }} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

const nameOf = (c?: Customer, fallback?: string | null) => (c ? [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company_name || '' : fallback || '');
const first = (s?: string | null) => (s || '').split(' ')[0];
const dayLabel = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' }) : '—');
const isToday = (iso?: string) => !!iso && new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ }) === new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const windowLabel = (b: Booking) => {
  const s = visitStatus(b);
  const a = fmtTime(new Date(s.windowStart).toISOString());
  return s.windowEnd > s.windowStart ? `${a}–${fmtTime(new Date(s.windowEnd).toISOString())}` : a;
};
const RATING = ['Unhappy', 'Okay', 'Happy'];
const TONE = ['neg', 'warn', 'ok'];
const compactMoney = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : fmtMoney(n));
const wholeMoney = (n: number) => fmtMoney(n).replace(/\.\d\d$/, '');

function CustomerView({ cid, contact, conversationId, pinnedBookingId, onInsert, full, actions }: Props & { cid: number }) {
  const data = useCustomerData(cid, contact.id);
  const c = data.customer.data;
  const ins = useMemo(() => insights(data.past.data || [], data.upcoming.data || []), [data.past.data, data.upcoming.data]);
  const loading = data.past.isLoading || data.upcoming.isLoading;
  const home = data.addresses.data?.find((a) => a.preferred) || data.addresses.data?.[0];
  const city = home?.city || c?.city || null;
  const summary = summarySentence(ins, { since: c?.created_at, city });
  const pinned = pinnedBookingId ? (data.upcoming.data || []).find((b) => b.id === pinnedBookingId) || null : null;
  const focus = pinned || ins.live;
  const name = nameOf(c, contact.name);

  if (!full) {
    return (
      <div className="rail">
        <section className="rail-block">
          <div className="rail-id">
            <Avatar name={name} size={44} />
            <div className="grow">
              <div className="rail-name">{name}</div>
              <div className="muted small">{[rhythmLabel(ins.rhythm), c?.created_at && `since ${new Date(c.created_at).getFullYear()}`, city].filter(Boolean).join(' · ')}</div>
            </div>
            <Link to={`/customers/${cid}`} className="small">Full profile</Link>
          </div>
          {(contact.identities.find((i) => i.kind === 'phone')?.value || c?.phone) && (
            <div className="rail-actions">
              <CallButton phone={contact.identities.find((i) => i.kind === 'phone')?.value || c?.phone} />
            </div>
          )}
          {!loading && (
            <p className="rail-summary">
              {summary.lead} {summary.emphasis && <strong>{summary.emphasis}</strong>}
            </p>
          )}
          {!!data.tags.data?.length && <div className="chips">{data.tags.data.slice(0, 4).map((t) => <span key={t.id} className="chip">{t.name}</span>)}</div>}
        </section>
        <section className="rail-block kpis3">
          <Kpi label="Lifetime" value={loading ? '…' : compactMoney(ins.spend)} />
          <Kpi label="Cleans" value={loading ? '…' : String(ins.completed)} />
          <Kpi label="Last rating" value={ins.lastRating ? RATING[ins.lastRating.feedback.rating] : '—'} tone={ins.lastRating ? TONE[ins.lastRating.feedback.rating] : undefined} />
        </section>
        <section className="rail-block">
          {focus ? (
            <VisitCard booking={focus} compact contact={contact} conversationId={conversationId} onInsert={onInsert} title={pinned ? `Pinned · #${focus.id}` : `Today's visit · #${focus.id}`} />
          ) : ins.state === 'between' && ins.next ? (
            <NextVisitCard booking={ins.next} compact conversationId={conversationId} />
          ) : ins.state === 'lapsed' ? (
            <NothingBookedCard ins={ins} compact />
          ) : (
            !loading && <div className="muted small">No visits yet.</div>
          )}
        </section>
        <HomeAccess customer={c} addresses={data.addresses.data} next={ins.next || ins.live || ins.last} compact />
        <section className="rail-block">
          <div className="eyebrow">Other conversations</div>
          <ConversationHistory contact={contact} currentId={conversationId} />
        </section>
      </div>
    );
  }

  const happyState = ins.unhappyRecently ? { label: 'Unhappy', cls: 'chip neg' } : ins.lastRating?.feedback.rating === 2 ? { label: 'Happy', cls: 'chip ok' } : null;
  return (
    <div className="c360">
      <section className="card c360-hero">
        <div className="c360-hero-top">
          <Avatar name={name} size={72} />
          <div className="c360-hero-main">
            <div className="c360-title">
              <h1>{name || 'Loading…'}</h1>
              {c?.company_name && <span className="chip">{c.company_name}</span>}
              {happyState && <span className={happyState.cls}>{happyState.label}</span>}
              {(ins.overdue || ins.unhappyRecently) && <span className="chip warn">At risk</span>}
              {c && c.active === false && <span className="chip neg">Inactive</span>}
            </div>
            {!loading && (
              <p className="c360-summary">
                {summary.lead} {summary.emphasis && <strong>{summary.emphasis}</strong>}
              </p>
            )}
            <div className="c360-ids">
              {contact.identities.map((i) => (
                <span key={i.id} className={i.opted_out ? 'id-line opted-out' : 'id-line'}>
                  <Icon name={i.kind === 'phone' ? 'sms' : 'email'} />
                  {displayIdentity(i.value)}
                  {i.opted_out && <span className="chip neg">STOP</span>}
                </span>
              ))}
              {home && (
                <span className="id-line">
                  <Icon name="home" />
                  {[home.address, home.city].filter(Boolean).join(', ')}
                </span>
              )}
            </div>
          </div>
          {actions && <div className="c360-actions">{actions}</div>}
        </div>
        <div className="c360-kpis">
          <Kpi big label="Lifetime spend" value={loading ? '…' : wholeMoney(ins.spend)} sub={c?.created_at ? `since ${new Date(c.created_at).toLocaleDateString('en-CA', { month: 'short', year: 'numeric' })}` : undefined} />
          <Kpi big label="Cleans" value={loading ? '…' : String(ins.completed)} sub={`${data.cancelled.data?.count ?? '…'} cancelled`} />
          <Kpi big label="Avg per clean" value={ins.avg ? wholeMoney(ins.avg) : '—'} sub={rhythmLabel(ins.rhythm) || undefined} />
          <div className="kpi">
            <div className="eyebrow">Last {ins.dots.length || 6} visits</div>
            <div className="dots" role="img" aria-label={`Recent ratings, oldest first: ${ins.dots.join(', ') || 'none'}`}>
              {ins.dots.map((d, i) => <span key={i} className={`dot-${d}`} />)}
            </div>
            <div className="muted small">
              {ins.dots.filter((d) => d === 'happy').length} happy · {ins.dots.filter((d) => d === 'none').length} not rated
            </div>
          </div>
          <Kpi big label="Outstanding" value={fmtMoney(ins.outstanding)} tone={ins.outstanding > 0 ? 'warn' : undefined} sub={ins.outstanding > 0 ? 'not yet collected' : 'all paid'} />
        </div>
      </section>

      <div className="c360-cols">
        <div className="c360-main">
          {focus ? (
            <section className="card state-card live">
              <VisitCard booking={focus} contact={contact} conversationId={conversationId} onInsert={onInsert} title={pinned ? 'Pinned visit' : 'Happening now'} cleanerStats={ins.cleaners.all} />
            </section>
          ) : ins.state === 'between' && ins.next ? (
            <div className="state-row">
              <section className="card state-card">
                <NextVisitCard booking={ins.next} conversationId={conversationId} preferred={ins.cleaners.preferred?.id} />
              </section>
              <SinceLast ins={ins} contact={data.contactFull.data} />
            </div>
          ) : ins.state === 'lapsed' ? (
            <div className="state-row">
              <section className="card state-card risk">
                <NothingBookedCard ins={ins} cid={cid} />
              </section>
              <WhatWeKnow ins={ins} contact={data.contactFull.data} hasCard={!!data.billing.data?.cards?.some((k) => !k.is_deleted)} />
            </div>
          ) : (
            !loading && (
              <section className="card state-card">
                <div className="eyebrow">New customer</div>
                <h2>No visits yet</h2>
                <p className="muted">Book their first clean to get started.</p>
                <Link className="button" to={`/bookings/new?customer=${cid}`}>New booking</Link>
              </section>
            )
          )}
          <Story past={data.past.data || []} contact={data.contactFull.data} customer={c} loading={data.past.isLoading} currentId={conversationId} />
        </div>

        <aside className="c360-side">
          <ComingUp upcoming={(data.upcoming.data || []).filter((b) => b.active !== false && b.id !== focus?.id)} />
          <Cleaners ins={ins} />
          <HomeAccess customer={c} addresses={data.addresses.data} next={ins.next || ins.live || ins.last} />
          <section className="card side-card">
            <h2>Money</h2>
            <dl className="kv2">
              <dt>Card</dt>
              <dd>{data.billing.data?.cards?.filter((k) => !k.is_deleted).map((k) => <div key={k.id}>{k.brand} ••{k.last4} · exp {k.exp_month}/{String(k.exp_year).slice(-2)}</div>) || (data.billing.isLoading ? '…' : 'None on file')}</dd>
              <dt>Outstanding</dt>
              <dd className="mono">{fmtMoney(ins.outstanding)}</dd>
              <dt>Avg per clean</dt>
              <dd className="mono">{ins.avg ? fmtMoney(ins.avg) : '—'}</dd>
            </dl>
          </section>
          {!!data.tags.data?.length && (
            <section className="card side-card">
              <h2>Tags</h2>
              <div className="chips">{data.tags.data.map((t) => <span key={t.id} className="chip">{t.name}</span>)}</div>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}

function Kpi({ label, value, sub, tone, big }: { label: string; value: string; sub?: string; tone?: string; big?: boolean }) {
  return (
    <div className="kpi">
      <div className="eyebrow">{label}</div>
      <div className={`kpi-value${big ? ' big' : ''}${tone ? ` ${tone}` : ''}`}>{value}</div>
      {sub && <div className="muted small">{sub}</div>}
    </div>
  );
}

const STAGES: { key: Stage; label: string }[] = [
  { key: 'booked', label: 'Booked' },
  { key: 'enroute', label: 'En route' },
  { key: 'arrived', label: 'Checked in' },
  { key: 'done', label: 'Checked out' },
];

export function Stepper({ booking, compact }: { booking: Booking; compact?: boolean }) {
  const s = visitStatus(booking);
  const idx = STAGES.findIndex((x) => x.key === s.stage);
  const times: Record<Stage, string | undefined> = {
    booked: booking.created_at ? dayLabel(booking.created_at) : undefined,
    enroute: s.enrouteAt && fmtTime(s.enrouteAt),
    arrived: s.checkinAt && fmtTime(s.checkinAt),
    done: s.checkoutAt && fmtTime(s.checkoutAt),
  };
  return (
    <ol className={compact ? 'stepper compact' : 'stepper'} aria-label="Visit progress">
      {STAGES.map((st, i) => (
        <li key={st.key} className={i < idx ? 'past' : i === idx ? 'current' : ''} aria-current={i === idx ? 'step' : undefined}>
          <span className="bar" />
          <span className="lbl">{st.label}</span>
          {!compact && <span className="t">{(i <= idx && times[st.key]) || '—'}</span>}
        </li>
      ))}
    </ol>
  );
}

function VisitCard({ booking, contact, conversationId, onInsert, title, compact, cleanerStats }: { booking: Booking; contact: Contact; conversationId?: number; onInsert?: (t: string) => void; title: string; compact?: boolean; cleanerStats?: Insights['cleaners']['all'] }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const b = booking;
  const s = visitStatus(b);
  const cleaner = b.teams?.[0];
  const stats = cleanerStats?.find((x) => x.id === cleaner?.id);
  const ret = conversationId ? `/inbox/${conversationId}` : '';
  const log = (text: string) => conversationId && inbox.addEvent(conversationId, text, { type: 'booking', booking_id: b.id }).then(() => queryClient.invalidateQueries({ queryKey: ['inbox', 'conversation', conversationId] }));
  const statusLine = s.stage === 'done' ? `Checked out ${fmtTime(s.checkoutAt)}` : s.stage === 'arrived' ? `Checked in ${fmtTime(s.checkinAt)}` : s.stage === 'enroute' ? `En route since ${fmtTime(s.enrouteAt)}` : 'Not en route yet';
  const who = first(cleaner?.title) || 'your cleaner';
  const update =
    s.stage === 'enroute' ? `Hi ${first(contact.name)}, ${who} is on the way now (left at ${fmtTime(s.enrouteAt)}). We'll text you the moment they arrive.`
    : s.stage === 'arrived' ? `Hi ${first(contact.name)}, ${who} arrived at ${fmtTime(s.checkinAt)} and is getting started.`
    : `Hi ${first(contact.name)}, quick update on today's visit: `;

  const messageCleaner = async () => {
    if (!cleaner?.id) return;
    setBusy(true);
    try {
      const person = await inbox.fromL27({ team_id: cleaner.id });
      const conv = await inbox.start({ contact_id: person.id, channel: 'sms', l27_booking_id: b.id });
      if (conversationId) await inbox.addEvent(conversationId, `Started a text with the cleaner about booking #${b.id}`, { type: 'linked', conversation_id: conv.id });
      navigate(`/inbox/${conv.id}`, { state: { prefill: `Hi ${first(person.name)}, quick check on your ${fmtTime(b.service_date)} visit at ${b.address?.street || b.address?.full_address || 'the client'}. ` } });
    } finally {
      setBusy(false);
    }
  };
  const updateCustomer = async () => {
    if (onInsert) return onInsert(update);
    setBusy(true);
    try {
      const conv = await inbox.start({ contact_id: contact.id, channel: 'sms', l27_booking_id: b.id });
      navigate(`/inbox/${conv.id}`, { state: { prefill: update } });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={compact ? 'visit compact' : 'visit'}>
      <div className="visit-head">
        <div className={compact ? 'eyebrow' : 'eyebrow accent'}>{title}</div>
        {!compact && (
          <h2>
            {isToday(b.service_date) ? 'Today' : dayLabel(b.service_date)}, {windowLabel(b)} · {b.services?.map((x) => x.name).join(', ')}
          </h2>
        )}
        {s.risk ? <span className="chip warn">{s.risk.label}</span> : s.stage !== 'booked' && <span className="chip accent">{STAGES.find((x) => x.key === s.stage)?.label}</span>}
      </div>
      <Stepper booking={b} compact={compact} />
      <div className="visit-who">
        <Avatar name={cleaner?.title || '?'} size={compact ? 32 : 40} />
        <div className="grow">
          <strong>{cleaner?.title || 'No cleaner assigned'}</strong>
          {!compact && stats && (
            <span className="muted">
              {' '}· {stats.visits} visit{stats.visits === 1 ? '' : 's'} for this customer{stats.unhappy ? `, ${stats.unhappy} unhappy` : stats.happy ? ', rated happy' : ''}
            </span>
          )}
          <div className="muted small">
            {statusLine} · window {windowLabel(b)}
            {!compact && (
              <>
                {' '}· <Link to={`/bookings/${b.id}`}>#{b.id}</Link> · {fmtMoney(b.summary?.total)}
              </>
            )}
          </div>
        </div>
      </div>
      <div className={compact ? 'visit-actions grid2' : 'visit-actions'}>
        {cleaner?.id && (
          <button type="button" className="secondary" disabled={busy} onClick={messageCleaner}>
            Text {first(cleaner.title)}
          </button>
        )}
        <button type="button" className="secondary" disabled={busy} onClick={updateCustomer}>
          {onInsert ? 'Draft an update' : `Text ${first(contact.name) || 'customer'} an update`}
        </button>
        <BookingActions booking={b} editLink={conversationId ? `/bookings/${b.id}/edit?conversation=${conversationId}&return=${encodeURIComponent(ret)}` : undefined} onDone={(x) => log(x)} />
      </div>
    </div>
  );
}

function NextVisitCard({ booking, compact, conversationId, preferred }: { booking: Booking; compact?: boolean; conversationId?: number; preferred?: number }) {
  const b = booking;
  const d = new Date(b.service_date || Date.now());
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86_400_000);
  const when = days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
  const ret = conversationId ? `/inbox/${conversationId}` : '';
  const cleaner = b.teams?.[0];
  return (
    <div className={compact ? 'visit compact' : 'visit'}>
      <div className="visit-head">
        <div className="eyebrow">Next visit</div>
        <span className="chip">{when}</span>
      </div>
      <div className="next-row">
        <div className="date-tile" aria-hidden="true">
          <span className="m">{d.toLocaleDateString('en-CA', { timeZone: TZ, month: 'short' }).replace('.', '').toUpperCase()}</span>
          <span className="d mono">{d.toLocaleDateString('en-CA', { timeZone: TZ, day: 'numeric' })}</span>
          <span className="w">{d.toLocaleDateString('en-CA', { timeZone: TZ, weekday: 'short' })}</span>
        </div>
        <div className="grow">
          <div className={compact ? 'strong' : 'next-title'}>
            {windowLabel(b)} · {b.services?.map((x) => x.name).join(', ')}
          </div>
          <div className="muted small">
            {cleaner?.title ? (
              <>
                {cleaner.title}
                {preferred && cleaner.id === preferred ? ' (preferred)' : ''}
              </>
            ) : (
              <span className="warn">No cleaner yet</span>
            )}
            {' · '}
            <span className="mono">{fmtMoney(b.summary?.total)}</span> · <Link to={`/bookings/${b.id}`}>#{b.id}</Link>
          </div>
          {b.customer_notes && !compact && <div className="small quote">Customer note: {b.customer_notes}</div>}
        </div>
      </div>
      {!compact && (
        <div className="visit-actions">
          <BookingActions booking={b} editLink={conversationId ? `/bookings/${b.id}/edit?conversation=${conversationId}&return=${encodeURIComponent(ret)}` : undefined} />
        </div>
      )}
    </div>
  );
}

function NothingBookedCard({ ins, compact, cid }: { ins: Insights; compact?: boolean; cid?: number }) {
  const weeks = Math.round((ins.daysSinceLast || 0) / 7);
  // Bars: their last visits, then the visits that would have happened since at their usual pace.
  const usual = ins.rhythm || 14;
  const missed = Math.min(6, Math.max(0, Math.floor((ins.daysSinceLast || 0) / usual)));
  return (
    <div className={compact ? 'visit compact' : 'visit'}>
      <div className="visit-head">
        <div className="eyebrow warn">Nothing booked</div>
        {ins.daysSinceLast !== null && <span className="chip warn">{ins.daysSinceLast} days since last clean</span>}
      </div>
      {!compact && <h2>{ins.overdue ? `Win them back: no visit in ${weeks} weeks` : 'No upcoming visits'}</h2>}
      {!compact && (
        <div className="rhythm" role="img" aria-label={`Recent visits, then ${missed} missed at their usual pace`}>
          {Array.from({ length: Math.max(1, 6 - missed) }).map((_, i, arr) => <span key={`v${i}`} className={i === arr.length - 1 ? 'bar last' : 'bar'} />)}
          {Array.from({ length: missed }).map((_, i) => <span key={`m${i}`} className="bar missed" />)}
          <span className="muted small">
            {rhythmLabel(ins.rhythm) || 'Recent visits'} · last visit {dayLabel(ins.last?.service_date)} · gaps where visits would have been
          </span>
        </div>
      )}
      {compact && (
        <div className="small">
          Last visit {dayLabel(ins.last?.service_date)}
          {ins.rhythm ? ` · usually ${rhythmLabel(ins.rhythm)?.toLowerCase()}` : ''}
        </div>
      )}
      {!compact && cid && (
        <div className="visit-actions">
          <Link className="button" to={`/bookings/new?customer=${cid}`}>Book their usual</Link>
        </div>
      )}
    </div>
  );
}

function SinceLast({ ins, contact }: { ins: Insights; contact?: Contact }) {
  const open = (contact?.conversations || []).filter((c) => c.status === 'open').length;
  const last = ins.last;
  const paid = last && !last.charges?.outstanding;
  return (
    <section className="card side-card checks">
      <div className="eyebrow">Since the last visit</div>
      {last?.feedback ? (
        <Check tone={TONE[last.feedback.rating]}>
          Rated {RATING[last.feedback.rating]}
          {last.feedback.comment ? `: "${last.feedback.comment}"` : ''}
        </Check>
      ) : (
        <Check tone="muted">Not rated</Check>
      )}
      {last && <Check tone={paid ? 'ok' : 'warn'}>{paid ? `Charged ${fmtMoney(last.summary?.total)}, paid` : `${fmtMoney(last.charges?.outstanding)} not collected`}</Check>}
      <Check tone={open ? 'warn' : 'ok'}>{open ? `${open} open conversation${open === 1 ? '' : 's'}` : 'No open conversations'}</Check>
      {ins.daysSinceLast !== null && <Check tone="muted">Last visit {ins.daysSinceLast === 0 ? 'today' : `${ins.daysSinceLast} day${ins.daysSinceLast === 1 ? '' : 's'} ago`}</Check>}
    </section>
  );
}

function WhatWeKnow({ ins, contact, hasCard }: { ins: Insights; contact?: Contact; hasCard: boolean }) {
  const lr = ins.lastRating;
  const ratedAt = lr?.feedback.rated_at || lr?.service_date;
  const followedUp = !!ratedAt && (contact?.conversations || []).some((c) => c.last_message_at > ratedAt);
  return (
    <section className="card side-card checks">
      <div className="eyebrow">What we know</div>
      {lr && (
        <Check tone={TONE[lr.feedback.rating]}>
          Last rating {RATING[lr.feedback.rating]}, {dayLabel(lr.service_date)}
          {lr.teams?.[0]?.title ? `, ${lr.teams[0].title}` : ''}
          {lr.feedback.comment ? `: "${lr.feedback.comment}"` : ''}
        </Check>
      )}
      {lr && lr.feedback.rating < 2 && <Check tone={followedUp ? 'ok' : 'warn'}>{followedUp ? 'We followed up after that rating' : 'No conversation with us since that rating'}</Check>}
      {ins.cleaners.preferred && (
        <Check tone="ok">
          Happy with {ins.cleaners.preferred.name} on {ins.cleaners.preferred.happy} visits: suggest them next time
        </Check>
      )}
      <Check tone={hasCard ? 'muted' : 'warn'}>
        {hasCard ? 'Card on file' : 'No card on file'}
        {ins.outstanding ? ` · ${fmtMoney(ins.outstanding)} owing` : ' · nothing owing'}
      </Check>
    </section>
  );
}

function Check({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <div className="check-line">
      <span className={`check-dot ${tone}`}>
        <Icon name={tone === 'ok' ? 'check' : tone === 'muted' ? 'clock' : 'alert'} size={13} />
      </span>
      <span>{children}</span>
    </div>
  );
}

type StoryKind = 'visit' | 'rating' | 'conversation' | 'money' | 'note';
interface StoryItem {
  key: string;
  at: string;
  kind: StoryKind;
  icon: string;
  title: ReactNode;
  sub: ReactNode;
  amount?: string;
  tone?: string;
}

function Story({ past, contact, customer, loading, currentId }: { past: RatedBooking[]; contact?: Contact; customer?: Customer; loading: boolean; currentId?: number }) {
  const [filter, setFilter] = useState<'all' | StoryKind>('all');
  const [shown, setShown] = useState(12);
  const items = useMemo(() => {
    const out: StoryItem[] = [];
    for (const b of past) {
      const who = b.teams?.map((t) => t.title).join(', ') || 'unassigned';
      const t: TimeTracking | undefined = b.time_tracking?.[0];
      const onSite = t?.checkin_at && t?.checkout_at ? Math.round((new Date(t.checkout_at).getTime() - new Date(t.checkin_at).getTime()) / 60_000) : null;
      out.push({
        key: `v${b.id}`,
        at: b.service_date || '',
        kind: 'visit',
        icon: 'calendar',
        title: (
          <>
            <strong>Visit</strong> · {b.services?.map((s) => s.name).join(', ')}
            {onSite ? ` · ${Math.floor(onSite / 60)}h ${String(onSite % 60).padStart(2, '0')}m on site` : ''}
          </>
        ),
        sub: (
          <>
            {fmtDateTime(b.service_date)} · {who} · <Link to={`/bookings/${b.id}`}>#{b.id}</Link>
          </>
        ),
        amount: fmtMoney(b.summary?.total),
      });
      if (b.feedback) {
        out.push({
          key: `r${b.id}`,
          at: b.feedback.rated_at || b.service_date || '',
          kind: 'rating',
          icon: 'star',
          tone: TONE[b.feedback.rating],
          title: (
            <>
              <strong>Rated {RATING[b.feedback.rating]}</strong>
              {b.feedback.comment ? ` · "${b.feedback.comment}"` : ''}
            </>
          ),
          sub: (
            <>
              {dayLabel(b.service_date)} visit · {who}
            </>
          ),
        });
      }
      for (const ch of b.charges?.charged || []) {
        const c = ch as { amount?: number; created_at?: string; card?: { brand?: string; last4?: string } };
        out.push({
          key: `c${b.id}-${c.created_at}`,
          at: c.created_at || b.service_date || '',
          kind: 'money',
          icon: 'money',
          title: (
            <>
              <strong>Charged</strong>
              {c.card?.last4 ? ` · ${c.card.brand || 'Card'} ••${c.card.last4}` : ''}
            </>
          ),
          sub: (
            <>
              {fmtDateTime(c.created_at || b.service_date)} · #{b.id}
            </>
          ),
          amount: fmtMoney(c.amount ?? b.summary?.total),
        });
      }
      if ((b.charges?.outstanding || 0) > 0) {
        out.push({ key: `o${b.id}`, at: b.service_date || '', kind: 'money', icon: 'money', tone: 'warn', title: <strong>Not yet collected</strong>, sub: <>{dayLabel(b.service_date)} visit · #{b.id}</>, amount: fmtMoney(b.charges?.outstanding) });
      }
    }
    for (const c of contact?.conversations || []) {
      out.push({
        key: `m${c.id}`,
        at: c.last_message_at,
        kind: 'conversation',
        icon: c.channel,
        tone: c.status === 'open' ? 'warn' : undefined,
        title: (
          <>
            <strong>{c.channel === 'email' ? 'Email' : c.channel === 'voice' ? 'Call' : 'Text'}</strong> · {c.subject || c.last_preview}
          </>
        ),
        sub: (
          <>
            {fmtDateTime(c.last_message_at)} · {c.status === 'done' ? c.disposition?.reason || 'done' : c.status}
            {c.id !== currentId && (
              <>
                {' '}· <Link to={`/inbox/${c.id}`}>Open</Link>
              </>
            )}
          </>
        ),
      });
    }
    if (customer?.notes) out.push({ key: 'note', at: '9999', kind: 'note', icon: 'note', title: <><strong>Customer notes</strong> · {customer.notes}</>, sub: 'Pinned from Launch27' });
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }, [past, contact, customer, currentId]);
  const rows = items.filter((i) => filter === 'all' || i.kind === filter);
  const FILTERS: { key: 'all' | StoryKind; label: string }[] = [
    { key: 'all', label: 'Everything' },
    { key: 'visit', label: 'Visits' },
    { key: 'conversation', label: 'Conversations' },
    { key: 'rating', label: 'Ratings' },
    { key: 'money', label: 'Money' },
  ];
  return (
    <section className="card story">
      <div className="story-head">
        <h2>Story</h2>
        <div className="filters" role="tablist" aria-label="Filter the story">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              role="tab"
              aria-selected={filter === f.key}
              type="button"
              className={filter === f.key ? 'pillbtn on' : 'pillbtn'}
              onClick={() => {
                setFilter(f.key);
                setShown(12);
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
      {loading && <div className="muted">Loading…</div>}
      {!loading && !rows.length && <div className="muted">Nothing yet.</div>}
      {rows.slice(0, shown).map((i) => (
        <div key={i.key} className="ev">
          <span className={`ev-dot ${i.kind}${i.tone ? ` ${i.tone}` : ''}`}>
            <Icon name={i.icon} />
          </span>
          <div className="grow">
            <div className="ev-title">{i.title}</div>
            <div className="muted small">{i.sub}</div>
          </div>
          {i.amount && <span className="mono ev-amt">{i.amount}</span>}
        </div>
      ))}
      {rows.length > shown && (
        <button type="button" className="secondary wide" onClick={() => setShown(shown + 25)}>
          Show earlier ({rows.length - shown} more)
        </button>
      )}
    </section>
  );
}

function ComingUp({ upcoming }: { upcoming: Booking[] }) {
  const [all, setAll] = useState(false);
  const rows = all ? upcoming : upcoming.slice(0, 3);
  return (
    <section className="card side-card">
      <h2>Coming up</h2>
      {!upcoming.length && <div className="muted small">Nothing booked.</div>}
      {rows.map((b) => (
        <Link key={b.id} to={`/bookings/${b.id}`} className="up-row">
          <span>
            {dayLabel(b.service_date)} · {fmtTime(b.service_date)}
          </span>
          <span className={b.teams?.length ? 'muted' : 'warn'}>{b.teams?.[0]?.title || 'No cleaner yet'}</span>
        </Link>
      ))}
      {upcoming.length > 3 && (
        <button type="button" className="link small" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `All ${upcoming.length} upcoming`}
        </button>
      )}
    </section>
  );
}

function Cleaners({ ins }: { ins: Insights }) {
  const { all, preferred, avoid } = ins.cleaners;
  if (!all.length) return null;
  return (
    <section className="card side-card">
      <h2>Cleaners</h2>
      {[...(preferred ? [preferred] : []), ...all.filter((c) => c.name !== preferred?.name)].slice(0, 4).map((c) => (
        <div key={c.name} className="cleaner-row">
          <Avatar name={c.name} size={34} />
          <div className="grow">
            <strong>{c.name}</strong>
            {preferred?.name === c.name && <span className="chip ok">preferred</span>}
            {avoid.some((a) => a.name === c.name) && <span className="chip neg">avoid</span>}
            <div className="muted small">
              {c.visits} visit{c.visits === 1 ? '' : 's'} · {c.happy} happy{c.unhappy ? ` · ${c.unhappy} unhappy` : ''}
            </div>
          </div>
        </div>
      ))}
      {!avoid.length && <div className="muted small">No cleaners to avoid.</div>}
    </section>
  );
}

function HomeAccess({ customer, addresses, next, compact }: { customer?: Customer; addresses?: Address[]; next: Booking | null; compact?: boolean }) {
  const fields = (next?.custom_fields || []).map((f) => ({ title: f.title, value: f.values?.map((v) => v.other || v.label).filter(Boolean).join(', ') })).filter((f) => f.value);
  const body = (
    <>
      {compact ? <div className="eyebrow">Home and access</div> : <h2>Home and access</h2>}
      {addresses?.map((a) => (
        <div key={a.id} className="access-line">
          <Icon name="home" />
          <span>
            {[a.address, a.city, a.zip].filter(Boolean).join(', ')} {a.preferred && addresses.length > 1 && <span className="chip">preferred</span>}
          </span>
        </div>
      ))}
      {fields.map((f) => (
        <div key={f.title} className="access-line">
          <Icon name="key" />
          <span>
            <span className="muted">{f.title?.replace(/\?$/, '')}:</span> {f.value}
          </span>
        </div>
      ))}
      {customer?.notes && <p className="pre small">{customer.notes}</p>}
      {next?.customer_notes && <p className="small quote">Visit note: {next.customer_notes}</p>}
    </>
  );
  return compact ? <section className="rail-block access">{body}</section> : <section className="card side-card access">{body}</section>;
}

export function trackingState(tt?: TimeTracking[]) {
  const t = tt?.[0];
  if (!t) return null;
  if (t.checkout_at) return { label: `Checked out ${fmtTime(t.checkout_at)}`, tone: 'ok' };
  if (t.checkin_at) return { label: `Checked in ${fmtTime(t.checkin_at)}`, tone: 'ok' };
  if (t.enroute_started_at) return { label: `En route since ${fmtTime(t.enroute_started_at)}`, tone: 'warn' };
  return null;
}

// Late = checked in after the arrival window closed (or not checked in once it has).
export function lateness(b: Booking, now = Date.now()) {
  if (!b.service_date) return null;
  const windowMin = Number(b.arrival_window) || 0;
  const latest = new Date(b.service_date).getTime() + windowMin * 60_000;
  const checkin = b.time_tracking?.[0]?.checkin_at;
  if (checkin) {
    const late = Math.round((new Date(checkin).getTime() - latest) / 60_000);
    return late > 0 ? late : 0;
  }
  return now > latest ? Math.round((now - latest) / 60_000) : null;
}

export function ConversationHistory({ contact, currentId }: { contact: Contact; currentId?: number }) {
  const full = useQuery({ queryKey: ['inbox', 'contact', contact.id], queryFn: () => inbox.contact(contact.id), staleTime: 15_000 });
  const rows = (full.data?.conversations || []).filter((c) => c.id !== currentId);
  if (full.isLoading) return <div className="muted small">Loading…</div>;
  if (!rows.length) return <div className="muted small">No other conversations.</div>;
  return (
    <div className="mini-list">
      {rows.slice(0, 12).map((c) => (
        <Link key={c.id} to={`/inbox/${c.id}`} className="mini-row link-row">
          <Icon name={c.channel} />
          <span className="clip">{c.subject || c.last_preview}</span>
          <span className="muted small">
            {c.disposition?.reason || c.status} · {ago(c.last_message_at)}
          </span>
        </Link>
      ))}
    </div>
  );
}

// Unlinked contact: find their Launch27 customer by phone, email or name.
function LinkToLaunch27({ contact }: { contact: Contact }) {
  const queryClient = useQueryClient();
  const seed = contact.identities.find((i) => i.kind === 'email')?.value || contact.identities[0]?.value.slice(-10) || contact.name || '';
  const [query, setQuery] = useState(seed);
  const results = useQuery({ queryKey: ['l27-customer-search', query], queryFn: () => l27<Customer[]>('/v1/staff/customers', { query, limit: 8 }), enabled: query.length >= 3 });
  const link = async (customerId: number, roles = contact.roles) => {
    await inbox.updateContact(contact.id, { l27_customer_id: customerId, roles: [...new Set([...roles, 'customer' as const])] });
    queryClient.invalidateQueries({ queryKey: ['inbox'] });
  };
  const label = contact.name || displayIdentity(contact.identities[0]?.value) || 'Unknown';
  return (
    <div className="rail">
      <section className="rail-block">
        <div className="rail-id">
          <Avatar name={label} size={44} />
          <div className="grow">
            <div className="rail-name">{label}</div>
            <div className="muted small">Not linked to a Launch27 customer yet</div>
          </div>
        </div>
        <p className="small muted">Find them to see bookings, money and ratings.</p>
        <label className="sr-only" htmlFor={`find-${contact.id}`}>
          Find a Launch27 customer
        </label>
        <input id={`find-${contact.id}`} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name, email or phone" className="full" />
        <div className="mini-list">
          {results.data?.map((c) => (
            <div key={c.id} className="mini-row">
              <span>{[c.first_name, c.last_name].filter(Boolean).join(' ')}</span>
              <span className="muted small">
                {c.email} {c.phone}
              </span>
              <button className="link small" onClick={() => link(c.id)}>
                Link
              </button>
            </div>
          ))}
          {results.data?.length === 0 && <div className="muted small">No Launch27 customer matches.</div>}
        </div>
      </section>
      <section className="rail-block">
        <div className="eyebrow">Conversations</div>
        <ConversationHistory contact={contact} />
      </section>
    </div>
  );
}
