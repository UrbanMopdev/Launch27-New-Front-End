import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { l27All } from '../api';
import { fmtDateTime, fmtTime, todayISO } from '../format';

// /admin/reports/team-time-tracking-logs replacement.
//   GET /v1/staff/bookings/time_tracking?filter=active&from&to  (all pages)
// Unlike /v1/staff/bookings, this endpoint nests each cleaner's clock-in/out under
// teams[].time_tracking, so a booking with two cleaners has two time records.

interface TeamTracking {
  id: number;
  state?: string;
  enroute_started_at?: string | null;
  enroute_finished_at?: string | null;
  checkin_at?: string | null;
  checkout_at?: string | null;
  distance?: number | null;
  distance_unit?: string;
  paused_at?: string | null;
  progress?: string[];
}

interface TrackingBooking {
  id: number;
  active: boolean;
  service_date: string;
  arrival_window?: number;
  user?: { name?: string };
  services?: { name: string }[];
  teams: { id: number; title: string; hours?: number; bg_color?: string; assigned?: boolean; time_tracking?: TeamTracking | null }[];
}

type Status = 'late' | 'not_started' | 'enroute' | 'onsite' | 'no_checkout' | 'done' | 'unassigned';

interface Visit {
  key: string;
  booking: TrackingBooking;
  team?: TrackingBooking['teams'][number];
  tt?: TeamTracking | null;
  status: Status;
  worked: number | null; // hours
  scheduled: number | null; // hours
}

const STATUS_LABEL: Record<Status, { label: string; cls: string }> = {
  late: { label: 'Late — not checked in', cls: 'neg' },
  not_started: { label: 'Not started', cls: 'muted' },
  enroute: { label: 'En route', cls: 'warn' },
  onsite: { label: 'On site', cls: 'ok' },
  no_checkout: { label: 'No check-out', cls: 'neg' },
  done: { label: 'Done', cls: '' },
  unassigned: { label: 'Unassigned', cls: 'warn' },
};

const TABS: { id: 'all' | Status | 'attention' | 'ran_long' | 'finished_early'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'attention', label: 'Needs attention' },
  { id: 'onsite', label: 'On site' },
  { id: 'done', label: 'Done' },
  { id: 'ran_long', label: 'Ran long' },
  { id: 'finished_early', label: 'Finished early' },
  { id: 'not_started', label: 'Not started' },
];

// Worked vs scheduled, for finished visits: more than 30 minutes either way.
const TOLERANCE_H = 0.5;
const ranLong = (v: Visit) => v.worked !== null && !!v.scheduled && v.worked > v.scheduled + TOLERANCE_H;
const finishedEarly = (v: Visit) => v.worked !== null && !!v.scheduled && v.worked < v.scheduled - TOLERANCE_H;

const NEEDS_ATTENTION: Status[] = ['late', 'no_checkout', 'unassigned'];

const hoursBetween = (a?: string | null, b?: string | null) => (a && b ? (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000 : null);
const fmtH = (h: number | null) => (h === null ? '—' : `${h.toFixed(1)} h`);

// Checked in but still no check-out an hour after the scheduled length: they probably forgot.
const NO_CHECKOUT_GRACE_H = 1;

function statusOf(b: TrackingBooking, tt: TeamTracking | null | undefined, hasTeam: boolean, scheduled: number | null): Status {
  if (!hasTeam) return 'unassigned';
  if (tt?.checkout_at) return 'done';
  if (tt?.checkin_at) {
    const elapsed = hoursBetween(tt.checkin_at, new Date().toISOString()) || 0;
    return elapsed > (scheduled || 4) + NO_CHECKOUT_GRACE_H ? 'no_checkout' : 'onsite';
  }
  if (tt?.enroute_started_at) return 'enroute';
  const windowEnds = new Date(b.service_date).getTime() + (b.arrival_window || 0) * 60_000;
  return Date.now() > windowEnds ? 'late' : 'not_started';
}

function toVisits(bookings: TrackingBooking[]): Visit[] {
  const visits: Visit[] = [];
  for (const b of bookings) {
    const teams = b.teams?.length ? b.teams : [undefined];
    for (const team of teams) {
      const tt = team?.time_tracking;
      visits.push({
        key: `${b.id}-${team?.id ?? 'none'}`,
        booking: b,
        team,
        tt,
        status: statusOf(b, tt, !!team, team?.hours ?? null),
        worked: hoursBetween(tt?.checkin_at, tt?.checkout_at),
        scheduled: team?.hours ?? null,
      });
    }
  }
  return visits.sort((a, b) => a.booking.service_date.localeCompare(b.booking.service_date) || (a.team?.title || '').localeCompare(b.team?.title || ''));
}

export function TimeTrackingPage() {
  const navigate = useNavigate();
  const [from, setFrom] = useState(todayISO());
  const [to, setTo] = useState(todayISO());
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('all');
  const [search, setSearch] = useState('');

  const data = useQuery({
    queryKey: ['time-tracking', from, to],
    queryFn: () => l27All<TrackingBooking>('/v1/staff/bookings/time_tracking', { filter: 'active', from, to }),
    // Keep "on site / late" current while the page is open.
    refetchInterval: from === todayISO() || to === todayISO() ? 60_000 : false,
  });
  useEffect(() => setTab('all'), [from, to]);

  const visits = useMemo(() => toVisits((data.data || []).filter((b) => b.active !== false)), [data.data]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: visits.length, attention: 0 };
    for (const v of visits) {
      c[v.status] = (c[v.status] || 0) + 1;
      if (NEEDS_ATTENTION.includes(v.status)) c.attention += 1;
      if (ranLong(v)) c.ran_long = (c.ran_long || 0) + 1;
      if (finishedEarly(v)) c.finished_early = (c.finished_early || 0) + 1;
    }
    return c;
  }, [visits]);
  const hours = useMemo(() => {
    const done = visits.filter((v) => v.worked !== null);
    return {
      worked: done.reduce((s, v) => s + (v.worked || 0), 0),
      scheduled: done.reduce((s, v) => s + (v.scheduled || 0), 0),
      overruns: done.filter(ranLong).length,
      short: done.filter(finishedEarly).length,
    };
  }, [visits]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matches = (v: Visit) => !q || [v.booking.id, v.booking.user?.name, v.team?.title].join(' ').toLowerCase().includes(q);
    const list = visits.filter((v) => {
      if (tab === 'attention' && !NEEDS_ATTENTION.includes(v.status)) return false;
      if (tab === 'ran_long') return ranLong(v) && matches(v);
      if (tab === 'finished_early') return finishedEarly(v) && matches(v);
      if (tab !== 'all' && tab !== 'attention' && v.status !== tab) return false;
      return matches(v);
    });
    // Biggest differences first on the over/under tabs.
    if (tab === 'ran_long') list.sort((a, b) => b.worked! - b.scheduled! - (a.worked! - a.scheduled!));
    if (tab === 'finished_early') list.sort((a, b) => a.worked! - a.scheduled! - (b.worked! - b.scheduled!));
    return list;
  }, [visits, tab, search]);

  return (
    <>
      <header className="page-header">
        <h1>Time tracking</h1>
        <div className="filters">
          <label>
            From
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            To
            <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </label>
          <input placeholder="Search customer, cleaner, booking #…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </header>

      {data.isLoading && <div className="muted">Loading…</div>}
      {data.error && <div className="error">{(data.error as Error).message}</div>}

      {data.data && (
        <>
          <div className="tiles">
            <Tile label="Cleaner visits" value={String(counts.all)} sub={`${data.data.filter((b) => b.active !== false).length} bookings`} />
            <Tile label="Done" value={String(counts.done || 0)} sub={`${counts.onsite || 0} on site now · ${counts.enroute || 0} en route`} />
            <Tile label="Needs attention" value={String(counts.attention)} sub={`${counts.late || 0} late · ${counts.no_checkout || 0} no check-out · ${counts.unassigned || 0} unassigned`} tone={counts.attention ? 'neg' : undefined} />
            <Tile
              label="Hours worked / scheduled"
              value={`${hours.worked.toFixed(1)} / ${hours.scheduled.toFixed(1)}`}
              sub={
                <>
                  <button type="button" className="link small" onClick={() => setTab('ran_long')}>
                    {hours.overruns} ran long
                  </button>{' '}
                  ·{' '}
                  <button type="button" className="link small" onClick={() => setTab('finished_early')}>
                    {hours.short} finished early
                  </button>{' '}
                  (±30 min)
                </>
              }
            />
          </div>

          <div className="tabs">
            {TABS.map((t) => (
              <button key={t.id} className={t.id === tab ? 'tab active' : 'tab'} onClick={() => setTab(t.id)}>
                {t.label} <span className="muted">({counts[t.id] || 0})</span>
              </button>
            ))}
          </div>

          <div className="table-wrap cards-on-mobile">
            <table>
              <thead>
                <tr>
                  <th>Booking</th>
                  <th>Customer</th>
                  <th>Cleaner</th>
                  <th>Status</th>
                  <th>En route</th>
                  <th>Check in</th>
                  <th>Check out</th>
                  <th className="num">Worked</th>
                  <th className="num">Scheduled</th>
                  <th className="num">Distance</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={10} className="muted">
                      Nothing here.
                    </td>
                  </tr>
                )}
                {rows.map((v) => {
                  const st = STATUS_LABEL[v.status];
                  const diff = v.worked !== null && v.scheduled ? v.worked - v.scheduled : null;
                  return (
                    <tr key={v.key} onClick={() => navigate(`/bookings/${v.booking.id}`)}>
                      <td data-label="Booking">{fmtDateTime(v.booking.service_date)}</td>
                      <td data-label="Customer">{v.booking.user?.name || '—'}</td>
                      <td data-label="Cleaner">
                        {v.team ? (
                          <>
                            <span className="dot" style={{ background: v.team.bg_color || '#ccc' }} />
                            {v.team.title}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td data-label="Status">
                        <span className={st.cls}>{st.label}</span>
                      </td>
                      <td data-label="En route">{fmtTime(v.tt?.enroute_started_at || undefined)}</td>
                      <td data-label="Check in">{fmtTime(v.tt?.checkin_at || undefined)}</td>
                      <td data-label="Check out">{fmtTime(v.tt?.checkout_at || undefined)}</td>
                      <td data-label="Worked" className="num">
                        {fmtH(v.worked)}
                        {diff !== null && Math.abs(diff) >= 0.5 && <span className={`small ${diff > 0 ? 'neg' : 'warn'}`}> {diff > 0 ? '+' : ''}{diff.toFixed(1)}</span>}
                      </td>
                      <td data-label="Scheduled" className="num">
                        {fmtH(v.scheduled)}
                      </td>
                      <td data-label="Distance" className="num">
                        {v.tt?.distance != null ? `${v.tt.distance.toFixed(1)} ${v.tt.distance_unit || 'km'}` : '—'}
                      </td>
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

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: React.ReactNode; tone?: 'neg' }) {
  return (
    <div className="card tile">
      <div className="muted small">{label}</div>
      <div className={`tile-value ${tone || ''}`}>{value}</div>
      {sub && <div className="muted small">{sub}</div>}
    </div>
  );
}
