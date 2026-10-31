import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { l27, l27All } from '../api';
import type { Booking, Team } from '../types';
import type { RatedBooking } from '../lib/feedbackModel';
import { fmtDateTime, fmtTime, todayISO } from '../format';
import type { Contact } from './api';
import { ConversationHistory, lateness, trackingState } from './Customer360';
import { displayIdentity } from './util';

const STALE = 10 * 60_000;
const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Cleaner 360: their day, their record, and everything we've said to them.
// Cleaners are "teams" in Launch27.
export function Cleaner360({ contact, conversationId, onInsert }: { contact: Contact; conversationId?: number; onInsert?: (text: string) => void }) {
  const tid = contact.l27_team_id;
  const today = todayISO();
  const team = useQuery({ queryKey: ['team', tid], queryFn: () => l27<Team>(`/v1/staff/teams/${tid}`), enabled: !!tid, staleTime: STALE });
  const day = useQuery({ queryKey: ['team', tid, 'today', today], queryFn: () => l27<Booking[]>('/v1/staff/bookings', { teams: tid!, from: today, to: today, sort: 'asc', limit: 30 }), enabled: !!tid, refetchInterval: 60_000 });
  const upcoming = useQuery({ queryKey: ['team', tid, 'next14'], queryFn: () => l27<{ count: number }>('/v1/staff/bookings/count', { teams: tid!, from: addDays(today, 1), to: addDays(today, 14) }), enabled: !!tid, staleTime: STALE });
  const availability = useQuery({ queryKey: ['team', tid, 'availability'], queryFn: () => l27<{ id: number; date: string | null; start_time: string | null; end_time: string | null; weekday: number | null; dayoff: boolean }[]>(`/v1/staff/teams/${tid}/availability`, { from: today, to: addDays(today, 14) }), enabled: !!tid, staleTime: STALE });
  const recent = useQuery({ queryKey: ['team', tid, 'recent30'], queryFn: () => l27All<RatedBooking>('/v1/staff/bookings', { teams: tid!, from: addDays(today, -30), to: today, options: 'completed,exclude_forecasted' }), enabled: !!tid, staleTime: STALE });
  const rated = useQuery({ queryKey: ['team', tid, 'rated'], queryFn: () => l27<RatedBooking[]>('/v1/staff/bookings', { teams: tid!, options: 'with_feedback,exclude_forecasted', sort: 'desc', limit: 40 }), enabled: !!tid, staleTime: STALE });

  const punctuality = useMemo(() => {
    const rows = (recent.data || []).filter((b) => b.time_tracking?.[0]?.checkin_at);
    const late = rows.map((b) => lateness(b) || 0).filter((m) => m > 10);
    const missing = (recent.data || []).filter((b) => !b.time_tracking?.[0]?.checkin_at).length;
    return { visits: recent.data?.length || 0, late: late.length, missing };
  }, [recent.data]);

  const quality = useMemo(() => {
    const rows = (rated.data || []).filter((b) => b.feedback);
    const happy = rows.filter((r) => r.feedback.rating === 2).length;
    return { n: rows.length, happyPct: rows.length ? Math.round((happy / rows.length) * 100) : null, unhappy: rows.filter((r) => r.feedback.rating === 0) };
  }, [rated.data]);

  if (!tid) {
    return (
      <div className="p360">
        <section className="p360-block">
          <h3>{contact.name}</h3>
          <p className="small muted">Marked as a cleaner but not linked to a Launch27 team. Open them from the Teams page to link.</p>
        </section>
      </div>
    );
  }
  const t = team.data;
  const weekly = (availability.data || []).filter((a) => a.weekday !== null && !a.date);
  const offDays = (availability.data || []).filter((a) => a.date && a.dayoff);

  return (
    <div className="p360">
      <section className="p360-block">
        <div className="p360-title">
          <div>
            <h3>
              <span className="dot" style={{ background: t?.bg_color || '#ccc' }} />
              {t ? [t.first_name, t.last_name].filter(Boolean).join(' ') || t.title : contact.name} <span className="badge">Cleaner</span>
            </h3>
            <div className="muted small">
              {t?.title}
              {t && !t.active && <span className="badge danger">inactive</span>}
              {t?.locations?.map((l) => <span key={l.id} className="pill">{l.name}</span>)}
            </div>
          </div>
          <Link to="/teams" className="small">Teams →</Link>
        </div>
        <div className="p360-ids">
          {contact.identities.map((i) => (
            <span key={i.id} className="pill">{i.kind === 'phone' ? '☎ ' : '✉ '}{displayIdentity(i.value)}</span>
          ))}
        </div>
        {!!t?.tags_info?.length && <div>{t.tags_info.map((tag) => <span key={tag.id} className="pill">{tag.name}</span>)}</div>}
      </section>

      <section className="p360-block health">
        <div className="stat"><div className="muted small">Rating</div><div className="stat-value">{t?.ratings_count ? `${t.stars ?? t.rating}★` : '—'}</div></div>
        <div className="stat"><div className="muted small">Happy (last 40)</div><div className="stat-value">{quality.happyPct === null ? '—' : `${quality.happyPct}%`}</div></div>
        <div className="stat"><div className="muted small">Late &gt;10m (30d)</div><div className={punctuality.late ? 'stat-value warn' : 'stat-value'}>{recent.isLoading ? '…' : `${punctuality.late}/${punctuality.visits}`}</div></div>
        <div className="stat"><div className="muted small">Next 14 days</div><div className="stat-value">{upcoming.data?.count ?? '…'}</div></div>
      </section>

      <section className="p360-block pinned">
        <h4>Today</h4>
        {day.isLoading && <div className="muted small">Loading…</div>}
        {day.data?.length === 0 && <div className="muted small">No bookings today.</div>}
        {day.data?.map((b) => {
          const tr = trackingState(b.time_tracking);
          const late = lateness(b);
          return (
            <div key={b.id} className="day-row">
              <div>
                <Link to={`/bookings/${b.id}`}>{fmtTime(b.service_date)}</Link> <span className="small">{b.user?.name}</span>
              </div>
              <div className="small muted">{b.address?.full_address}</div>
              <div className="small">
                {tr ? <span className={`pill ${tr.tone}`}>{tr.label}</span> : <span className="pill">Not started</span>}
                {late !== null && late > 0 && !b.time_tracking?.[0]?.checkout_at && <span className="pill late">{late} min past window</span>}
              </div>
            </div>
          );
        })}
        <Link to="/routes" className="small">Route map →</Link>
      </section>

      <section className="p360-block">
        <h4>Availability</h4>
        {weekly.length ? (
          <div className="small">{weekly.sort((a, b) => (a.weekday ?? 0) - (b.weekday ?? 0)).map((a) => `${WEEKDAYS[a.weekday ?? 0]} ${a.dayoff ? 'off' : `${a.start_time?.slice(0, 5)}–${a.end_time?.slice(0, 5)}`}`).join(' · ')}</div>
        ) : (
          <div className="small muted">{availability.isLoading ? 'Loading…' : 'No weekly hours set.'}</div>
        )}
        {!!offDays.length && <div className="small warn">Off: {offDays.map((a) => a.date).join(', ')}</div>}
      </section>

      <section className="p360-block">
        <h4>Quality</h4>
        {quality.unhappy.slice(0, 3).map((r) => (
          <div key={r.id} className="rating-line small">
            <span className="neg">Unhappy</span> <span className="muted">{fmtDateTime(r.service_date).split(',')[0]} · {r.user?.name}</span>
            {r.feedback.comment && <div className="quote">“{r.feedback.comment}”</div>}
          </div>
        ))}
        {!quality.unhappy.length && <div className="small muted">{rated.isLoading ? 'Loading…' : 'No unhappy ratings in the last 40.'}</div>}
        {punctuality.missing > 0 && <div className="small warn">{punctuality.missing} visit(s) in 30 days without a check-in</div>}
      </section>

      {onInsert && (
        <section className="p360-block">
          <h4>Quick texts</h4>
          <div className="actions small-actions">
            <button className="secondary" onClick={() => onInsert(`Hi ${t?.first_name || ''}, what's your ETA for your next booking? The client is asking.`)}>Ask for ETA</button>
            <button className="secondary" onClick={() => onInsert(`Hi ${t?.first_name || ''}, can you confirm you've arrived?`)}>Confirm arrival</button>
            <button className="secondary" onClick={() => onInsert(`Hi ${t?.first_name || ''}, are you available to pick up an extra booking?`)}>Offer a booking</button>
          </div>
        </section>
      )}

      <section className="p360-block">
        <h4>Conversations</h4>
        <ConversationHistory contact={contact} currentId={conversationId} />
      </section>
    </div>
  );
}
