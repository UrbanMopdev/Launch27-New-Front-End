import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { l27All } from '../api';
import { useActiveTeams, useLocations } from '../hooks';
import { todayISO } from '../format';
import { fmtClock, type DispatchBooking, type DispatchTeam } from '../lib/dispatch';
import { AVG_KMH, buildRoutes, CHECKIN_TOLERANCE_KM, closerCleanerHints, fmtKm, fmtMin, ROAD_FACTOR, type CleanerRoute } from '../lib/routes';
import { RouteMap } from '../components/RouteMap';

// Routes & travel: each cleaner's day as home → job 1 → job 2 → … → home.
//   GET /v1/staff/bookings?from=D&to=D   (job addresses have coordinates; time tracking has check-in GPS)
//   GET /v1/staff/teams?filter=active   (cleaner home coordinates)

const cleanName = (name = '') => name.replace(/^(\s*(\([^)]*\)|ON HOLD))+\s*/i, '') || name;
const LONG_DAY_KM = 60;

function shiftDay(date: string, days: number) {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('en-CA');
}

export function RoutesPage() {
  const [date, setDate] = useState(todayISO());
  const [locationId, setLocationId] = useState<number | 'all' | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const locations = useLocations();
  useEffect(() => {
    if (locationId === null && locations.data?.length) setLocationId((locations.data.find((l) => l.default) || locations.data[0]).id);
  }, [locations.data, locationId]);
  useEffect(() => setSelected(null), [date, locationId]);

  const bookingsQ = useQuery({
    queryKey: ['dispatch', date],
    queryFn: () => l27All<DispatchBooking>('/v1/staff/bookings', { from: date, to: date, sort: 'asc' }),
  });
  const teamsQ = useActiveTeams();

  const routes = useMemo(() => {
    const bookings = (bookingsQ.data || []).filter((b) => locationId === 'all' || locationId === null || b.location?.id === locationId);
    return buildRoutes(bookings, (teamsQ.data || []) as unknown as DispatchTeam[]);
  }, [bookingsQ.data, teamsQ.data, locationId]);
  const q = search.trim().toLowerCase();
  const list = routes.filter((r) => !q || cleanName(r.team.title).toLowerCase().includes(q) || r.stops.some((s) => (s.booking.user?.name || '').toLowerCase().includes(q)));

  const stats = useMemo(() => {
    const stops = routes.flatMap((r) => r.stops);
    return {
      km: routes.reduce((s, r) => s + r.km, 0),
      minutes: routes.reduce((s, r) => s + r.minutes, 0),
      jobs: stops.length,
      cleaners: routes.length,
      longDays: routes.filter((r) => r.km >= LONG_DAY_KM),
      tight: routes.flatMap((r) => r.stops.filter((s) => s.tight).map((s) => ({ r, s }))),
      offsite: routes.flatMap((r) => r.stops.filter((s) => s.checkinOffKm !== null && s.checkinOffKm > CHECKIN_TOLERANCE_KM).map((s) => ({ r, s }))),
      noHome: routes.filter((r) => r.team.latitude == null),
    };
  }, [routes]);
  const hints = useMemo(() => closerCleanerHints(routes), [routes]);
  const onSelect = useCallback((id: number | null) => setSelected(id), []);
  const selectedRoute = routes.find((r) => r.team.id === selected) || null;

  return (
    <>
      <header className="page-header">
        <h1>Routes & travel</h1>
        <div className="filters dispatch-filters">
          <div className="day-nav">
            <button className="secondary" onClick={() => setDate(shiftDay(date, -1))} aria-label="Previous day">
              ‹
            </button>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            <button className="secondary" onClick={() => setDate(shiftDay(date, 1))} aria-label="Next day">
              ›
            </button>
            {date !== todayISO() && (
              <button className="secondary" onClick={() => setDate(todayISO())}>
                Today
              </button>
            )}
          </div>
          <select value={locationId ?? ''} onChange={(e) => setLocationId(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
            {locations.data?.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
            <option value="all">All locations</option>
          </select>
          <input placeholder="Find cleaner or customer…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </header>

      {(bookingsQ.isLoading || teamsQ.isLoading) && <div className="muted">Loading the day…</div>}
      {bookingsQ.error && <div className="error">{(bookingsQ.error as Error).message}</div>}

      {!bookingsQ.isLoading && (
        <>
          <div className="dispatch-stats">
            <Stat label="Driving (approx.)" value={fmtKm(stats.km)} sub={fmtMin(stats.minutes)} />
            <Stat label="Per job" value={stats.jobs ? fmtKm(stats.km / stats.jobs) : '—'} sub={`${stats.jobs} jobs · ${stats.cleaners} cleaners`} />
            <Stat label={`Long days (${LONG_DAY_KM}+ km)`} value={stats.longDays.length} tone={stats.longDays.length ? 'bad' : undefined} />
            <Stat label="Tight connections" value={stats.tight.length} sub="less time than the drive" tone={stats.tight.length ? 'bad' : undefined} />
            <Stat label="Closer cleaner available" value={hints.length} sub="first job of the day" tone={hints.length ? 'bad' : undefined} />
            <Stat label="Checked in away from address" value={stats.offsite.length} tone={stats.offsite.length ? 'bad' : undefined} />
          </div>

          <Insights stats={stats} hints={hints} onSelect={setSelected} />

          <div className="routes-layout">
            <section className="card map-card">
              <div className="row-line no-border">
                <h2>{selectedRoute ? `${cleanName(selectedRoute.team.title)}'s route` : 'All routes'}</h2>
                {selectedRoute && (
                  <button className="link small" onClick={() => setSelected(null)}>
                    Show everyone
                  </button>
                )}
              </div>
              <RouteMap routes={routes} selectedId={selected} onSelect={onSelect} />
              <p className="muted small">
                🏠 home · numbered stops in order · red ring = tight connection. Distances are estimates (straight line × {ROAD_FACTOR} for roads, ~{AVG_KMH} km/h); lines on the map are straight.
                {stats.noHome.length > 0 && ` ${stats.noHome.length} cleaner(s) have no home address, so their first and last legs are missing.`}
              </p>
            </section>

            <section className="card route-list">
              <h2>Cleaners by distance</h2>
              {list.length === 0 && <div className="muted small">No assigned jobs this day.</div>}
              {list.map((r) => (
                <RouteCard key={r.team.id} route={r} open={selected === r.team.id} onToggle={() => setSelected(selected === r.team.id ? null : r.team.id)} />
              ))}
            </section>
          </div>
        </>
      )}
    </>
  );
}

function Insights({ stats, hints, onSelect }: { stats: { longDays: CleanerRoute[]; tight: { r: CleanerRoute; s: CleanerRoute['stops'][number] }[]; offsite: { r: CleanerRoute; s: CleanerRoute['stops'][number] }[] }; hints: ReturnType<typeof closerCleanerHints>; onSelect: (id: number) => void }) {
  const cards: { tone: 'bad' | 'info'; title: string; action: string; id?: number }[] = [];
  for (const t of stats.tight.slice(0, 3))
    cards.push({
      tone: 'bad',
      title: `${cleanName(t.r.team.title)} has ${t.s.gapBefore! <= 0 ? 'no time' : `${t.s.gapBefore} min`} to get to ${t.s.booking.user?.name} at ${fmtClock(t.s.start)} — about a ${fmtMin(t.s.legIn.minutes)} drive.`,
      action: 'Move the start time, or give one of the jobs to a cleaner nearby, so they arrive on time.',
      id: t.r.team.id,
    });
  for (const h of hints.slice(0, 3))
    cards.push({
      tone: 'bad',
      title: `${cleanName(h.assigned.title)} drives ~${fmtKm(h.assignedKm)} to their first job (${h.booking.user?.name}); ${cleanName(h.alternative.title)} lives ~${fmtKm(h.alternativeKm)} away and is working that day.`,
      action: 'Consider swapping on the Dispatch board — less driving, fresher cleaners, earlier arrivals.',
      id: h.assigned.id,
    });
  if (stats.longDays.length)
    cards.push({
      tone: 'info',
      title: `${stats.longDays.length} cleaner${stats.longDays.length > 1 ? 's drive' : ' drives'} ${LONG_DAY_KM}+ km today: ${stats.longDays
        .slice(0, 3)
        .map((r) => `${cleanName(r.team.title)} (~${fmtKm(r.km)})`)
        .join(', ')}.`,
      action: 'Group their jobs by area on future days; long drives cost time, fuel and lateness.',
      id: stats.longDays[0].team.id,
    });
  for (const o of stats.offsite.slice(0, 2))
    cards.push({
      tone: 'info',
      title: `${cleanName(o.r.team.title)} checked in ${fmtKm(o.s.checkinOffKm)} from ${o.s.booking.user?.name}'s address.`,
      action: 'Could be a phone GPS glitch or checking in early from the car — worth a quick question if it repeats.',
      id: o.r.team.id,
    });
  const [all, setAll] = useState(false);
  if (!cards.length) return null;
  return (
    <section className="card insight-group">
      <h2>Worth a look</h2>
      {(all ? cards : cards.slice(0, 3)).map((c, i) => (
        <div key={i} className={`insight-card ${c.tone}`}>
          <div className="insight-title">{c.title}</div>
          <div className="insight-action">
            <strong>What to do:</strong> {c.action}
          </div>
          {c.id && (
            <button className="link small" onClick={() => onSelect(c.id!)}>
              Show on map →
            </button>
          )}
        </div>
      ))}
      {cards.length > 3 && (
        <button className="link small" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show ${cards.length - 3} more`}
        </button>
      )}
    </section>
  );
}

function RouteCard({ route: r, open, onToggle }: { route: CleanerRoute; open: boolean; onToggle: () => void }) {
  const flags = r.stops.filter((s) => s.tight).length;
  return (
    <div className={`route-card ${open ? 'open' : ''}`}>
      <button className="route-head" onClick={onToggle}>
        <span className="dot" style={{ background: r.team.bg_color || '#ccc' }} />
        <span className="route-name">
          <strong>{cleanName(r.team.title)}</strong>
          <span className="muted small">
            {r.stops.length} job{r.stops.length > 1 ? 's' : ''} · ~{fmtKm(r.km)} · {fmtMin(r.minutes)} driving{r.unknownLegs ? ` · ${r.unknownLegs} leg(s) unknown` : ''}
          </span>
        </span>
        {r.km >= LONG_DAY_KM && <span className="verdict v-raw">long day</span>}
        {flags > 0 && <span className="verdict v-bad">{flags} tight</span>}
      </button>
      {open && (
        <ol className="legs">
          {r.stops.map((s, i) => (
            <li key={`${s.booking.id}-${i}`}>
              <div className="leg-drive muted small">
                ↓ {s.legIn.from === 'Home' ? 'From home' : 'Drive'} · ~{fmtKm(s.legIn.km)} · {fmtMin(s.legIn.minutes)}
                {s.gapBefore !== null && <span className={s.tight ? 'neg' : ''}> · {s.gapBefore <= 0 ? 'no gap' : `${s.gapBefore} min between jobs`}</span>}
              </div>
              <div className="leg-stop">
                <span className="stop-num">{i + 1}</span>
                <span>
                  <strong>{fmtClock(s.start)}</strong>–{fmtClock(s.end)} ·{' '}
                  {s.booking.id ? <Link to={`/bookings/${s.booking.id}`}>{s.booking.user?.name}</Link> : s.booking.user?.name}
                  <div className="muted small">
                    {s.booking.address?.full_address}
                    {s.checkinOffKm !== null && s.checkinOffKm > CHECKIN_TOLERANCE_KM && <span className="warn"> · checked in {fmtKm(s.checkinOffKm)} away</span>}
                  </div>
                </span>
              </div>
            </li>
          ))}
          {r.legHome && (
            <li>
              <div className="leg-drive muted small">
                ↓ Home · ~{fmtKm(r.legHome.km)} · {fmtMin(r.legHome.minutes)}
              </div>
            </li>
          )}
        </ol>
      )}
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: number | string; sub?: string; tone?: 'bad' }) {
  return (
    <div className={`dstat ${tone || ''}`}>
      <div className="dstat-value">{value}</div>
      <div className="dstat-label">{label}</div>
      {sub && <div className="muted small">{sub}</div>}
    </div>
  );
}
