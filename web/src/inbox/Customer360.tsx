import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { l27, l27All } from '../api';
import type { Booking, Customer, Tag, TimeTracking } from '../types';
import type { RatedBooking } from '../lib/feedbackModel';
import { fmtDateTime, fmtMoney, fmtTime, todayISO } from '../format';
import { BookingActions } from '../components/BookingActions';
import { inbox, type Contact } from './api';
import { ago, displayIdentity } from './util';

const STALE = 15 * 60_000;

// Customer 360: who they are, what they've booked, how it's going, what we last said.
// Launch27 is the record for bookings and money; each block loads on its own so a slow
// call never blocks the conversation.
export function Customer360({ contact, conversationId, pinnedBookingId, onInsert }: { contact: Contact; conversationId?: number; pinnedBookingId?: number | null; onInsert?: (text: string) => void }) {
  const cid = contact.l27_customer_id;
  if (!cid) return <LinkToLaunch27 contact={contact} />;
  return <CustomerBlocks cid={cid} contact={contact} conversationId={conversationId} pinnedBookingId={pinnedBookingId} onInsert={onInsert} />;
}

function CustomerBlocks({ cid, contact, conversationId, pinnedBookingId, onInsert }: { cid: number; contact: Contact; conversationId?: number; pinnedBookingId?: number | null; onInsert?: (text: string) => void }) {
  const [tab, setTab] = useState<'upcoming' | 'past' | 'cancelled'>('upcoming');
  const customer = useQuery({ queryKey: ['customer', String(cid)], queryFn: () => l27<Customer>(`/v1/staff/customers/${cid}`), staleTime: STALE });
  const tags = useQuery({ queryKey: ['customer', String(cid), 'tags'], queryFn: () => l27<Tag[]>(`/v1/staff/customers/${cid}/tags`), staleTime: STALE });
  const addresses = useQuery({ queryKey: ['customer', String(cid), 'addresses'], queryFn: () => l27<{ id: number; address: string; city: string; state: string; zip: string; preferred: boolean }[]>(`/v1/staff/customers/${cid}/addresses`), staleTime: STALE });
  const billing = useQuery({ queryKey: ['customer', String(cid), 'billing'], queryFn: () => l27<{ cards?: { id: string; brand: string; last4: string; exp_month: number; exp_year: number; is_default: boolean; is_deleted: boolean }[] }>(`/v1/staff/customers/${cid}/setup/billing`), staleTime: STALE });
  const upcoming = useQuery({ queryKey: ['customer', String(cid), '360', 'upcoming'], queryFn: () => l27<Booking[]>('/v1/staff/bookings', { customers: cid, options: 'not_completed', sort: 'asc', limit: 10 }), staleTime: 60_000 });
  const past = useQuery({ queryKey: ['customer', String(cid), '360', 'past'], queryFn: () => l27All<RatedBooking>('/v1/staff/bookings', { customers: cid, options: 'completed,exclude_forecasted', sort: 'desc' }), staleTime: STALE });
  const cancelled = useQuery({ queryKey: ['customer', String(cid), '360', 'cancelled'], queryFn: () => l27<{ count: number }>('/v1/staff/bookings/count', { customers: cid, filter: 'cancelled' }), staleTime: STALE });
  const cancelledList = useQuery({ queryKey: ['customer', String(cid), '360', 'cancelled-list'], queryFn: () => l27<Booking[]>('/v1/staff/bookings', { customers: cid, filter: 'cancelled', sort: 'desc', limit: 10 }), enabled: tab === 'cancelled', staleTime: STALE });

  const health = useMemo(() => summarize(past.data || [], upcoming.data || [], cancelled.data?.count ?? 0), [past.data, upcoming.data, cancelled.data]);
  const pinnedId = pinnedBookingId || upcoming.data?.[0]?.id || null;
  const c = customer.data;

  return (
    <div className="p360">
      <section className="p360-block">
        <div className="p360-title">
          <div>
            <h3>{c ? [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company_name : contact.name}</h3>
            <div className="muted small">
              Customer since {c?.created_at ? new Date(c.created_at).getFullYear() : '…'}
              {c && !c.active && <span className="badge danger">inactive</span>}
              {c?.company_name && <> · {c.company_name}</>}
            </div>
          </div>
          <Link to={`/customers/${cid}`} className="small">Launch27 →</Link>
        </div>
        <div className="p360-ids">
          {contact.identities.map((i) => (
            <span key={i.id} className={i.opted_out ? 'pill opted-out' : 'pill'} title={i.opted_out ? 'Opted out of texts' : undefined}>
              {i.kind === 'phone' ? '☎ ' : '✉ '}
              {displayIdentity(i.value)}
              {i.opted_out && ' · STOP'}
            </span>
          ))}
        </div>
        {!!tags.data?.length && <div>{tags.data.map((t) => <span key={t.id} className="pill">{t.name}</span>)}</div>}
      </section>

      <section className="p360-block health">
        <Stat label="Type" value={health.recurring ? health.frequency || 'Recurring' : health.completed ? 'One-time' : 'New'} />
        <Stat label="Lifetime spend" value={past.isLoading ? '…' : fmtMoney(health.spend)} />
        <Stat label="Cleans" value={past.isLoading ? '…' : String(health.completed)} />
        <Stat label="Cancelled" value={cancelled.isLoading ? '…' : String(cancelled.data?.count ?? 0)} />
        <Stat label="Last rating" value={health.lastRating ?? '—'} tone={health.lastRatingTone} />
        {health.risk && <div className="risk">⚠ {health.risk}</div>}
      </section>

      {pinnedId && <PinnedBooking id={pinnedId} pinned={!!pinnedBookingId} contact={contact} conversationId={conversationId} onInsert={onInsert} />}

      <section className="p360-block">
        <div className="tabs compact">
          {(['upcoming', 'past', 'cancelled'] as const).map((t) => (
            <button key={t} className={tab === t ? 'tab active' : 'tab'} onClick={() => setTab(t)}>
              {t === 'upcoming' ? `Upcoming (${upcoming.data?.length ?? '…'})` : t === 'past' ? `Past (${health.completed})` : `Cancelled (${cancelled.data?.count ?? '…'})`}
            </button>
          ))}
        </div>
        <BookingList bookings={tab === 'upcoming' ? upcoming.data : tab === 'past' ? past.data?.slice(0, 10) : cancelledList.data} conversationId={conversationId} pinnedId={pinnedBookingId} />
      </section>

      <section className="p360-block">
        <h4>Quality</h4>
        {past.isLoading ? <div className="muted small">Loading…</div> : <Quality rows={(past.data || []).filter((b) => b.feedback)} />}
      </section>

      <section className="p360-block">
        <h4>Money</h4>
        <dl className="kv tight">
          <dt>Card</dt>
          <dd>{billing.data?.cards?.filter((k) => !k.is_deleted).map((k) => <div key={k.id}>{k.brand} ••{k.last4} exp {k.exp_month}/{String(k.exp_year).slice(-2)}{k.is_default && <span className="muted small"> default</span>}</div>) || (billing.isLoading ? '…' : 'None on file')}</dd>
          <dt>Outstanding</dt>
          <dd>{fmtMoney(health.outstanding)}</dd>
          <dt>Avg per clean</dt>
          <dd>{health.completed ? fmtMoney(health.spend / health.completed) : '—'}</dd>
        </dl>
      </section>

      <section className="p360-block">
        <h4>Home</h4>
        {addresses.data?.map((a) => (
          <div key={a.id} className="small">
            {[a.address, a.city, a.zip].filter(Boolean).join(', ')} {a.preferred && <span className="pill">preferred</span>}
          </div>
        ))}
        {c?.notes && <p className="pre small">{c.notes}</p>}
        {contact.lead_source && <div className="small muted">Lead source: {contact.lead_source}</div>}
      </section>

      <section className="p360-block">
        <h4>Conversations</h4>
        <ConversationHistory contact={contact} currentId={conversationId} />
      </section>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="stat">
      <div className="muted small">{label}</div>
      <div className={tone ? `stat-value ${tone}` : 'stat-value'}>{value}</div>
    </div>
  );
}

const RATING = ['Unhappy', 'Okay', 'Happy'];

export function summarize(past: RatedBooking[], upcoming: Booking[], cancelledCount: number) {
  const spend = past.reduce((s, b) => s + (b.summary?.total || 0), 0);
  const outstanding = [...past, ...upcoming].reduce((s, b) => s + (b.charges?.outstanding || 0), 0);
  const rated = past.filter((b) => b.feedback).sort((a, b) => String(b.feedback.rated_at || b.service_date).localeCompare(String(a.feedback.rated_at || a.service_date)));
  const last = rated[0]?.feedback;
  const freq = upcoming[0]?.frequency?.name || past[0]?.frequency?.name || '';
  const recurring = !!freq && !/one|once/i.test(freq);
  let risk: string | null = null;
  const recent = (iso?: string, days = 60) => !!iso && Date.now() - new Date(iso).getTime() < days * 86400_000;
  if (last && last.rating === 0 && recent(last.rated_at || rated[0]?.service_date)) risk = 'Unhappy rating in the last 60 days';
  else if (recurring && upcoming.length === 0 && past.length) risk = 'Recurring customer with nothing booked';
  else if (cancelledCount >= 3 && cancelledCount > past.length / 2) risk = 'Cancels often';
  return {
    spend,
    outstanding,
    completed: past.length,
    recurring,
    frequency: freq,
    lastRating: last ? RATING[last.rating] : null,
    lastRatingTone: last ? (last.rating === 2 ? 'ok' : last.rating === 1 ? 'warn' : 'neg') : undefined,
    risk,
  };
}

function Quality({ rows }: { rows: RatedBooking[] }) {
  if (!rows.length) return <div className="muted small">No ratings yet.</div>;
  // Cleaners this customer rated well or badly: the start of a preferred / avoid list.
  const byTeam = new Map<string, { good: number; bad: number }>();
  for (const r of rows) {
    for (const t of r.teams || []) {
      const e = byTeam.get(t.title || String(t.id)) || { good: 0, bad: 0 };
      if (r.feedback.rating === 2) e.good++;
      if (r.feedback.rating === 0) e.bad++;
      byTeam.set(t.title || String(t.id), e);
    }
  }
  const liked = [...byTeam].filter(([, v]) => v.good && !v.bad).map(([k]) => k);
  const avoid = [...byTeam].filter(([, v]) => v.bad).map(([k]) => k);
  return (
    <>
      {!!liked.length && <div className="small">👍 Rated well: {liked.join(', ')}</div>}
      {!!avoid.length && <div className="small neg">👎 Unhappy with: {avoid.join(', ')}</div>}
      {rows.slice(0, 4).map((r) => (
        <div key={r.id} className="rating-line small">
          <span className={r.feedback.rating === 2 ? 'ok' : r.feedback.rating === 1 ? 'warn' : 'neg'}>{RATING[r.feedback.rating]}</span>{' '}
          <span className="muted">{fmtDateTime(r.service_date).split(',')[0]} · {r.teams?.map((t) => t.title).join(', ')}</span>
          {r.feedback.comment && <div className="quote">“{r.feedback.comment}”</div>}
        </div>
      ))}
    </>
  );
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

function PinnedBooking({ id, pinned, contact, conversationId, onInsert }: { id: number; pinned: boolean; contact: Contact; conversationId?: number; onInsert?: (text: string) => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const booking = useQuery({ queryKey: ['booking', String(id)], queryFn: () => l27<Booking>(`/v1/staff/bookings/${id}`), refetchInterval: 60_000 });
  const [busy, setBusy] = useState(false);
  const b = booking.data;
  if (!b) return <section className="p360-block pinned"><div className="muted small">{booking.isLoading ? 'Loading booking…' : 'Booking not found'}</div></section>;
  const tracking = trackingState(b.time_tracking);
  const late = lateness(b);
  const isToday = b.service_date?.slice(0, 10) === todayISO();
  const ret = conversationId ? `/inbox/${conversationId}` : '';
  const log = (text: string) => conversationId && inbox.addEvent(conversationId, text, { type: 'booking', booking_id: b.id }).then(() => queryClient.invalidateQueries({ queryKey: ['inbox', 'conversation', conversationId] }));

  const messageCleaner = async (teamId?: number) => {
    if (!teamId) return;
    setBusy(true);
    try {
      const cleaner = await inbox.fromL27({ team_id: teamId });
      const conv = await inbox.start({ contact_id: cleaner.id, channel: 'sms', l27_booking_id: b.id });
      if (conversationId) await inbox.addEvent(conversationId, `Started a text with the cleaner about booking #${b.id}`, { type: 'linked', conversation_id: conv.id });
      navigate(`/inbox/${conv.id}`, { state: { prefill: `Hi ${cleaner.name?.split(' ')[0] || ''}, quick check on your ${fmtTime(b.service_date)} booking at ${b.address?.street || b.address?.full_address || 'the client'}: what's your ETA?` } });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="p360-block pinned">
      <div className="p360-title">
        <h4>
          {pinned ? '📌 ' : 'Next: '}
          <Link to={`/bookings/${b.id}`}>#{b.id}</Link> {fmtDateTime(b.service_date)}
        </h4>
        {!b.active && <span className="badge danger">cancelled</span>}
      </div>
      <div className="small">
        {b.services?.map((s) => s.name).join(', ')} · {b.frequency?.name} · {fmtMoney(b.summary?.total)}
        {b.arrival_window ? <span className="muted"> · {b.arrival_window} min window</span> : null}
      </div>
      <div className="small">
        Cleaner: {b.teams?.length ? b.teams.map((t) => t.title).join(', ') : <span className="warn">Unassigned</span>}
        {tracking && <span className={`pill ${tracking.tone}`}>{tracking.label}</span>}
        {isToday && late !== null && late > 0 && <span className="pill late">{late} min late</span>}
      </div>
      {b.address?.full_address && <div className="small muted">{b.address.full_address}</div>}
      {b.customer_notes && <div className="small quote">Customer note: {b.customer_notes}</div>}
      <div className="actions small-actions">
        {conversationId && !pinned && (
          <button type="button" className="secondary" onClick={() => inbox.patch(conversationId, { l27_booking_id: b.id }).then(() => queryClient.invalidateQueries({ queryKey: ['inbox'] }))}>
            Pin
          </button>
        )}
        {!!b.teams?.length && (
          <button type="button" className="secondary" disabled={busy} onClick={() => messageCleaner(b.teams![0].id)}>
            Text cleaner
          </button>
        )}
        {onInsert && (
          <button type="button" className="secondary" onClick={() => onInsert(`your ${b.services?.[0]?.name || 'cleaning'} on ${fmtDateTime(b.service_date)}`)}>
            Insert details
          </button>
        )}
        <BookingActions booking={b} editLink={conversationId ? `/bookings/${b.id}/edit?conversation=${conversationId}&return=${encodeURIComponent(ret)}` : undefined} onDone={(s) => log(s)} />
        <Link to={`/bookings/new?customer=${contact.l27_customer_id}${conversationId ? `&conversation=${conversationId}&return=${encodeURIComponent(ret)}` : ''}`} className="button secondary-link">
          New booking
        </Link>
      </div>
    </section>
  );
}

function BookingList({ bookings, conversationId, pinnedId }: { bookings?: Booking[]; conversationId?: number; pinnedId?: number | null }) {
  const queryClient = useQueryClient();
  if (!bookings) return <div className="muted small">Loading…</div>;
  if (!bookings.length) return <div className="muted small">None.</div>;
  return (
    <div className="mini-list">
      {bookings.map((b) => (
        <div key={b.id} className={b.id === pinnedId ? 'mini-row pinned-row' : 'mini-row'}>
          <Link to={`/bookings/${b.id}`}>{fmtDateTime(b.service_date)}</Link>
          <span className="muted small">{b.teams?.map((t) => t.title).join(', ') || 'unassigned'}</span>
          <span className="small">{fmtMoney(b.summary?.total)}</span>
          {conversationId && b.id !== pinnedId && (
            <button className="link small" onClick={() => inbox.patch(conversationId, { l27_booking_id: b.id }).then(() => queryClient.invalidateQueries({ queryKey: ['inbox'] }))}>
              pin
            </button>
          )}
        </div>
      ))}
    </div>
  );
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
          <span>{c.channel === 'email' ? '✉' : c.channel === 'sms' ? '💬' : c.channel === 'voice' ? '☎' : '🗨'}</span>
          <span className="clip">{c.subject || c.last_preview}</span>
          <span className="muted small">{c.disposition?.reason || c.status} · {ago(c.last_message_at)}</span>
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
  return (
    <div className="p360">
      <section className="p360-block">
        <h3>{contact.name || displayIdentity(contact.identities[0]?.value) || 'Unknown'}</h3>
        <p className="small muted">Not linked to a Launch27 customer yet. Find them to see bookings, money and ratings.</p>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name, email or phone" className="full" />
        <div className="mini-list">
          {results.data?.map((c) => (
            <div key={c.id} className="mini-row">
              <span>{[c.first_name, c.last_name].filter(Boolean).join(' ')}</span>
              <span className="muted small">{c.email} {c.phone}</span>
              <button className="link small" onClick={() => link(c.id)}>Link</button>
            </div>
          ))}
          {results.data?.length === 0 && <div className="muted small">No Launch27 customer matches.</div>}
        </div>
      </section>
      <section className="p360-block">
        <h4>Conversations</h4>
        <ConversationHistory contact={contact} />
      </section>
    </div>
  );
}
