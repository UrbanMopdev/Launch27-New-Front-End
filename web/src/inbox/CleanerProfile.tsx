// Cleaner profile: their day, their week, their clients. Two layouts: the full page (contact
// page, Teams) and the compact panel beside a conversation.
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { l27 } from '../api';
import { CallButton } from '../components/CallButton';
import { scheduleApi, type CleanerProfileData } from '../schedule/api';
import { reportsApi } from '../reports/api';
import { FreqPill } from '../schedule/ui';
import type { Contact } from './api';
import { ConversationHistory } from './Customer360';
import { displayIdentity } from './util';

type Tracking = { enroute_started_at?: string | null; checkin_at?: string | null; checkout_at?: string | null };
type TrackingRow = { id: number; teams?: { id: number; time_tracking?: Tracking | null }[] };

const fmtClock = (iso?: string | null) => (iso ? new Date(iso).toLocaleTimeString('en-CA', { timeZone: 'America/Toronto', hour: 'numeric', minute: '2-digit' }) : '');
const pct = (x?: number | null) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const monthYear = (d?: string | null) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
const niceDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

function useCleanerData(tid: number) {
  const profile = useQuery({ queryKey: ['schedule', 'cleaner-profile', tid], queryFn: () => scheduleApi.cleanerProfile(tid), retry: false, refetchInterval: 120_000 });
  const report = useQuery({ queryKey: ['reports', 'cleaner', String(tid), '13w'], queryFn: () => reportsApi.cleaner(tid, '13w'), retry: false, staleTime: 10 * 60_000 });
  const today = profile.data?.today_date;
  // Live check-in/out for today comes straight from Launch27.
  const live = useQuery({
    queryKey: ['cleaner', tid, 'tracking', today],
    queryFn: () => l27<TrackingRow[]>('/v1/staff/bookings/time_tracking', { from: today!, to: today!, limit: 100 }),
    enabled: !!today,
    refetchInterval: 60_000,
  });
  const trackingFor = (bookingId: number | null): Tracking | null => {
    if (!bookingId) return null;
    const row = live.data?.find((r) => r.id === bookingId);
    return row?.teams?.find((t) => t.id === tid)?.time_tracking || null;
  };
  return { profile, report, trackingFor };
}

function statusOf(t: Tracking | null): { label: string; tone: 'done' | 'live' | 'enroute' | 'todo' } {
  if (t?.checkout_at) return { label: `Done · out ${fmtClock(t.checkout_at)}`, tone: 'done' };
  if (t?.checkin_at) return { label: `On site since ${fmtClock(t.checkin_at)}`, tone: 'live' };
  if (t?.enroute_started_at) return { label: `On the way since ${fmtClock(t.enroute_started_at)}`, tone: 'enroute' };
  return { label: 'Not started', tone: 'todo' };
}

function tagLabel(t: string) {
  const m = t.match(/max(?:imum)?\s*(?:of\s*)?(\d+)\s*min/i);
  if (m) return { text: `Max ${m[1]} min travel`, warn: true };
  if (/do not pair with/i.test(t)) return null; // shown under rules
  if (/without cleaner'?s confirmation/i.test(t)) return null;
  return { text: t, warn: false };
}

function NotInPlanner({ name }: { name: string }) {
  return <div className="card muted">{name} isn't in the planner's active list (on hold, off schedule or not ready), so there's no schedule to show.</div>;
}

// ---------- full page ----------
export function CleanerProfile({ tid, contact, onText, onEmail, editContact }: { tid: number; contact?: Contact; onText?: () => void; onEmail?: () => void; editContact?: ReactNode }) {
  const { profile, report, trackingFor } = useCleanerData(tid);
  const [editing, setEditing] = useState(false);
  const p = profile.data;
  const r = report.data;
  if (profile.isError) return <NotInPlanner name={contact?.name || 'This cleaner'} />;
  if (!p) return <p className="muted">Loading…</p>;
  const c = p.cleaner;
  const initials = c.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('');
  const nowVisit = p.today.find((v) => statusOf(trackingFor(v.id)).tone === 'live');
  const phone = contact?.identities.find((i) => i.kind === 'phone')?.value || c.phone;
  const email = contact?.identities.find((i) => i.kind === 'email')?.value;
  const tags = c.tags.map(tagLabel).filter(Boolean) as { text: string; warn: boolean }[];
  return (
    <div className="cp">
      <section className="card cp-hero">
        <div className="cp-hero-top">
          <div className="cp-who">
            <span className="cp-avatar" style={{ background: c.color }} aria-hidden="true">{initials}</span>
            <div className="cp-who-main">
              <div className="cp-title">
                <h1>{c.name}</h1>
                <span className={c.assignable ? 'cp-status ok' : 'cp-status off'}>{c.status_label}{nowVisit ? ' · on site now' : ''}</span>
              </div>
              <div className="cp-tags">
                <span className="cp-tag">{c.area}</span>
                {c.hours_type && <span className="cp-tag">{c.hours_type === 'PT' ? 'Part-time' : 'Full-time'}</span>}
                {c.is_new && <span className="cp-tag">New hire</span>}
                {tags.map((t) => <span key={t.text} className={t.warn ? 'cp-tag warn' : 'cp-tag'}>{t.text}</span>)}
              </div>
              <span className="muted small">{[phone && displayIdentity(phone), email, r?.cleaner.first_seen ? `working with us since at least ${monthYear(r.cleaner.first_seen)}` : null].filter(Boolean).join(' · ')}</span>
            </div>
          </div>
          <div className="cp-actions">
            {onText && <button onClick={onText}>Text</button>}
            <CallButton phone={phone} />
            {onEmail && <button className="secondary" onClick={onEmail}>Email</button>}
            <Link className="button secondary-link" to={`/schedule/cleaner/${c.id}`}>Plan</Link>
            <Link className="button secondary-link" to={`/reports/cleaners/${c.id}`}>Report</Link>
            {editContact && <button className="secondary" onClick={() => setEditing(!editing)} aria-expanded={editing}>Edit contact</button>}
          </div>
        </div>
        {editing && editContact && <div className="cp-edit">{editContact}</div>}
        <div className="cp-sum">
          <div><span className="eyebrow">This week</span><b>{p.week.booked_h}h <span className="muted small">of {p.week.capacity_h}h</span></b><span className="small">{Math.max(Math.round((p.week.capacity_h - p.week.booked_h) * 10) / 10, 0)}h open</span></div>
          <div><span className="eyebrow">On time</span><b>{pct(r?.stats.on_time)}</b><span className="small">{r ? `last 13 weeks · ${r.last40.filter((x) => x.late).length} late of last ${r.last40.length}` : 'reports not built yet'}</span></div>
          <div><span className="eyebrow">Ratings</span><b>{r?.stats.happy != null ? `${pct(r.stats.happy)} happy` : '—'}</b><span className="small">{r ? `${r.stats.rated} rated · ${r.stats.unhappy} unhappy` : ''}</span></div>
          <div><span className="eyebrow">Regular clients</span><b>{r ? r.clients.length : '—'}</b><span className="small">{r?.stats.clients_started ? `kept ${pct(r.stats.keeps)} this quarter` : ''}</span></div>
          <div><span className="eyebrow">Next 14 days</span><b>{p.next14.cleans} cleans</b><span className="small">{p.next14.hours}h booked</span></div>
        </div>
      </section>

      <div className="cp-cols">
        <div className="cp-main">
          <TodayCard p={p} trackingFor={trackingFor} />
          <WeekCard p={p} />
          {contact && (
            <section className="card cp-card">
              <div className="cp-card-head"><h2>Messages with {c.name.split(' ')[0]}</h2></div>
              <ConversationHistory contact={contact} />
            </section>
          )}
        </div>
        <aside className="cp-side">
          <HoursCard p={p} />
          {p.rules.length > 0 && (
            <section className="card cp-card">
              <h2>Rules to keep in mind</h2>
              <ul className="cp-rules">{p.rules.map((x) => <li key={x}>{x}</li>)}</ul>
            </section>
          )}
          <section className="card cp-card">
            <div className="cp-card-head"><h2>Regular clients{r ? ` · ${r.clients.length}` : ''}</h2>{r && <Link to={`/reports/cleaners/${c.id}`} className="small">All →</Link>}</div>
            {r?.clients.slice(0, 6).map((x) => (
              <div key={x.customer_id} className="cp-line"><span><Link to={`/customers/${x.customer_id}`} className="seg-name">{x.customer}</Link> · {x.rhythm}</span><span className="muted small">since {monthYear(x.since)}</span></div>
            ))}
            {r && r.clients.length === 0 && <p className="muted small">No regular clients right now.</p>}
            {!r && <p className="muted small">Shows once reports are built (overnight).</p>}
          </section>
          <section className="card cp-card">
            <h2>Latest ratings</h2>
            {r?.ratings.slice(0, 3).map((x, i) => (
              <div key={i} className="rep-rating"><span className={x.r === 0 ? 'warn' : x.r === 2 ? 'ok' : ''}><b>{x.r === 2 ? 'Happy' : x.r === 0 ? 'Unhappy' : 'OK'}</b> · {niceDay(x.date)} · {x.customer}</span>{x.comment && <span className="small">"{x.comment}"</span>}</div>
            ))}
            {(!r || r.ratings.length === 0) && <p className="muted small">No ratings yet.</p>}
          </section>
        </aside>
      </div>
    </div>
  );
}

function TodayCard({ p, trackingFor }: { p: CleanerProfileData; trackingFor: (id: number | null) => Tracking | null }) {
  const hours = Math.round(p.today.reduce((a, v) => a + v.duration, 0) / 6) / 10;
  return (
    <section className="card cp-card cp-today">
      <div className="cp-card-head">
        <h2>Today · {niceDay(p.today_date)}</h2>
        <span className="muted small">{p.today.length} clean{p.today.length === 1 ? '' : 's'}{p.today.length ? ` · ${hours}h · about ${p.today_drive_min} min driving · ` : ' · '}<Link to={`/routes?team=${p.cleaner.id}`}>Route map</Link></span>
      </div>
      {p.today.length === 0 && <p className="muted">No cleans today.</p>}
      <ol className="cp-day">
        {p.today.map((v) => {
          const st = statusOf(trackingFor(v.id));
          return (
            <li key={v.key} className={`cp-visit ${st.tone}`}>
              <b className="cp-time">{v.time}</b>
              <span className="cp-dot" aria-hidden="true" />
              <div className="cp-visit-main">
                {v.customer_id ? <Link to={`/customers/${v.customer_id}`} className="seg-name">{v.customer}</Link> : <b>{v.customer}</b>}
                <span className="muted small"><FreqPill visit={v} /> {Math.round((v.duration / 60) * 10) / 10}h{v.area ? ` · ${v.area}` : ''}{v.drive_before ? ` · ${v.drive_before} min drive` : ''}{v.note ? ` · ${v.note}` : ''}</span>
              </div>
              <span className="cp-badges">
                <span className={`cp-st ${st.tone}`}>{st.label}</span>
                {v.issues.map((i) => <span key={i} className="cp-st warn">{i}</span>)}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function WeekCard({ p }: { p: CleanerProfileData }) {
  return (
    <section className="card cp-card">
      <div className="cp-card-head"><h2>This week</h2><Link to={`/schedule/cleaner/${p.cleaner.id}`} className="small">Open 4-week plan →</Link></div>
      <div className="cp-week">
        {p.week.days.map((d) => (
          <div key={d.date} className="cp-weekday">
            <span className="small"><b>{d.day}</b></span>
            <div className={d.working && !d.unavailable ? 'cp-bar' : 'cp-bar off'} title={d.working ? `${d.booked_h}h booked of ${d.capacity_h}h` : 'Not working'}>
              {d.working && !d.unavailable && <div className={d.capacity_h && d.booked_h / d.capacity_h > 1 ? 'over' : d.capacity_h && d.booked_h / d.capacity_h < 0.6 ? 'low' : ''} style={{ height: `${Math.min(d.capacity_h ? (d.booked_h / d.capacity_h) * 100 : 0, 100)}%` }} />}
            </div>
            <span className="muted small">{d.unavailable ? 'Off (marked)' : d.working ? `${d.booked_h}/${d.capacity_h}h` : 'Off'}</span>
          </div>
        ))}
      </div>
      <span className="muted small">Bar = booked of working hours. Hatched = not working.</span>
    </section>
  );
}

function HoursCard({ p }: { p: CleanerProfileData }) {
  const queryClient = useQueryClient();
  const [day, setDay] = useState('');
  const [open, setOpen] = useState(false);
  const mark = useMutation({
    mutationFn: ({ d, on }: { d: string; on: boolean }) => scheduleApi.unavailable(p.cleaner.id, d, on),
    onSuccess: () => {
      setDay('');
      setOpen(false);
      queryClient.invalidateQueries({ queryKey: ['schedule'] });
    },
  });
  return (
    <section className="card cp-card">
      <div className="cp-card-head"><h2>Working hours</h2><button className="link small" onClick={() => setOpen(!open)}>Mark a day off</button></div>
      {p.hours.map((h) => <div key={h.days} className={h.label === 'Off' ? 'cp-line muted' : 'cp-line'}><span>{h.days}</span><b>{h.label}</b></div>)}
      {p.days_off.map((d) => (
        <div key={d} className="cp-line warn"><span>{niceDay(d)}</span><span>Off (marked) <button className="link small" disabled={mark.isPending} onClick={() => mark.mutate({ d, on: false })}>undo</button></span></div>
      ))}
      {open && (
        <div className="cp-off">
          <label><span className="sr-only">Day off</span><input type="date" min={p.today_date} value={day} onChange={(e) => setDay(e.target.value)} /></label>
          <button disabled={!day || mark.isPending} onClick={() => mark.mutate({ d: day, on: true })}>Mark off</button>
        </div>
      )}
      <span className="muted small">From Launch27. Days marked off here flag their visits in Changes to handle.</span>
    </section>
  );
}

// ---------- compact panel beside a conversation ----------
const QUICK = [
  { label: 'Thanks for the heads-up', text: 'Thanks for letting us know!' },
  { label: "Send today's addresses", build: (p: CleanerProfileData) => `Today's cleans: ${p.today.map((v) => `${v.time} ${v.customer}${v.area ? ` (${v.area})` : ''}`).join(', ')}.` },
  { label: 'Confirm tomorrow', text: 'Hi! Can you confirm you are all set for tomorrow? Thank you.' },
];
export function CleanerPanel({ tid, contact, onInsert }: { tid: number; contact: Contact; onInsert?: (text: string) => void }) {
  const { profile, report, trackingFor } = useCleanerData(tid);
  const p = profile.data;
  const r = report.data;
  if (profile.isError) return <div className="p360"><section className="p360-block"><h3>{contact.name}</h3><p className="small muted">Not in the planner's active list (on hold, off schedule or not ready).</p></section></div>;
  if (!p) return <div className="p360"><p className="muted small">Loading…</p></div>;
  const c = p.cleaner;
  const withStatus = p.today.map((v) => ({ v, st: statusOf(trackingFor(v.id)) }));
  const now = withStatus.find((x) => x.st.tone === 'live' || x.st.tone === 'enroute');
  const next = withStatus.find((x) => x.st.tone === 'todo' && x !== now);
  return (
    <div className="cpp">
      <section className="card cpp-card">
        <div className="cp-who">
          <span className="cp-avatar small" style={{ background: c.color }} aria-hidden="true">{c.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('')}</span>
          <div className="cp-who-main"><b>{c.name}</b><span className="muted small">Cleaner · {c.status_label} · {c.area}{c.hours_type ? ` · ${c.hours_type === 'PT' ? 'Part-time' : 'Full-time'}` : ''}</span></div>
          <Link to={`/contacts/${contact.id}`} className="small cpp-link">Profile →</Link>
        </div>
        <div className="cpp-now">
          <span className="eyebrow accent">Right now</span>
          {now ? <span><b>{now.st.tone === 'live' ? `On site at ${now.v.customer}` : `On the way to ${now.v.customer}`}</b> · {now.st.label.replace(/^On site |^On the way /, '')}</span> : <span><b>{p.today.length ? 'Between cleans' : 'No cleans today'}</b></span>}
          {next && <span className="muted small">Next: {next.v.time} {next.v.customer}{next.v.area ? `, ${next.v.area}` : ''}{next.v.drive_before ? ` (${next.v.drive_before} min drive)` : ''}</span>}
        </div>
      </section>
      {onInsert && (
        <section className="card cpp-card">
          <span className="eyebrow">Quick replies</span>
          <div className="cpp-quick">{QUICK.map((q) => <button key={q.label} className="chip-btn" onClick={() => onInsert(q.text ?? q.build!(p))}>{q.label}</button>)}</div>
          <span className="muted small">They drop into the reply box; nothing sends on its own.</span>
        </section>
      )}
      <section className="card cpp-card">
        <div className="cp-card-head"><span className="eyebrow">Today · {p.today.length} clean{p.today.length === 1 ? '' : 's'}</span><Link to={`/routes?team=${c.id}`} className="small">Route map</Link></div>
        {withStatus.map(({ v, st }) => (
          <div key={v.key} className="cp-line"><span><b>{v.time}</b> {v.customer}</span><span className={`cp-st ${v.issues.length ? 'warn' : st.tone}`}>{v.issues[0] || st.label}</span></div>
        ))}
        {p.today.length === 0 && <span className="muted small">No cleans today.</span>}
      </section>
      <section className="card cpp-card">
        <span className="eyebrow">This week</span>
        <div className="cp-week compact">
          {p.week.days.filter((d) => d.working || d.booked_h).map((d) => (
            <div key={d.date} className="cp-weekday"><div className="cp-bar"><div className={d.capacity_h && d.booked_h / d.capacity_h < 0.6 ? 'low' : ''} style={{ height: `${Math.min(d.capacity_h ? (d.booked_h / d.capacity_h) * 100 : 0, 100)}%` }} /></div><span className="small">{d.day}</span></div>
          ))}
        </div>
        <span className="small">{p.week.booked_h}h of {p.week.capacity_h}h booked</span>
      </section>
      <section className="card cpp-card cpp-nums">
        <div><span className="muted small">On time</span><b>{pct(r?.stats.on_time)}</b></div>
        <div><span className="muted small">Happy</span><b>{pct(r?.stats.happy)}</b></div>
        <div><span className="muted small">Regulars</span><b>{r ? r.clients.length : '—'}</b></div>
      </section>
      {(p.rules.length > 0 || p.days_off.length > 0) && (
        <section className="card cpp-card">
          <span className="eyebrow">Keep in mind</span>
          <span className="small">{[...p.rules, ...p.days_off.map((d) => `off ${niceDay(d)}`)].join(' · ')}</span>
        </section>
      )}
    </div>
  );
}
