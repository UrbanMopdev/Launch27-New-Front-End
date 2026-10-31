import { DragEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { l27, l27All, l27Write } from '../api';
import { useActiveTeams, useCanWrite, useLocations } from '../hooks';
import { fmtMoney, todayISO } from '../format';
import {
  bookingKey,
  buildBoard,
  fmtClock,
  isProjected,
  rankCandidates,
  workingWindow,
  type AvailabilityRow,
  type Block,
  type BlockStatus,
  type DispatchBooking,
  type DispatchTeam,
} from '../lib/dispatch';

// Dispatch board: one row per cleaner, the day's bookings as blocks on a timeline.
//   GET  /v1/staff/bookings?from=D&to=D                 (refreshes every minute)
//   GET  /v1/staff/teams?filter=active                  (cleaners)
//   GET  /v1/staff/teams/:id/availability               (working hours, cached)
//   POST /v1/staff/bookings/assign/teams                { booking_ids, teams: [{ id, hours, share }] }
// Assigning changes only that visit (not the rest of a recurring series).

const DAY_START = 7 * 60;
const DAY_END = 21 * 60;
const SPAN = DAY_END - DAY_START;
const HOURS = Array.from({ length: (DAY_END - DAY_START) / 60 + 1 }, (_, i) => DAY_START + i * 60);

const STATUS: Record<BlockStatus, { label: string; cls: string }> = {
  scheduled: { label: 'Scheduled', cls: 's-scheduled' },
  enroute: { label: 'En route', cls: 's-enroute' },
  onsite: { label: 'On site', cls: 's-onsite' },
  done: { label: 'Done', cls: 's-done' },
  late: { label: 'Late', cls: 's-late' },
  unassigned: { label: 'Unassigned', cls: 's-unassigned' },
};

const cleanName = (name = '') => name.replace(/^(\s*(\([^)]*\)|ON HOLD))+\s*/i, '') || name;
const pctLeft = (min: number) => `${((Math.max(min, DAY_START) - DAY_START) / SPAN) * 100}%`;
const pctWidth = (a: number, b: number) => `${((Math.min(b, DAY_END) - Math.max(a, DAY_START)) / SPAN) * 100}%`;

function shiftDay(date: string, days: number) {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('en-CA');
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

type TeamPayload = { id: number; hours: number; share: number };
type Pending = { booking: DispatchBooking; toTeam: DispatchTeam; fromTeamId: number | null };

export function DispatchPage() {
  const canWrite = useCanWrite();
  const queryClient = useQueryClient();
  const [date, setDate] = useState(todayISO());
  const [locationId, setLocationId] = useState<number | 'all' | null>(null);
  const [search, setSearch] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<{ key: string; teamId: number | null } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);
  const dragRef = useRef<{ booking: DispatchBooking; fromTeamId: number | null } | null>(null);
  const [dropRow, setDropRow] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const locations = useLocations();
  useEffect(() => {
    if (locationId === null && locations.data?.length) setLocationId((locations.data.find((l) => l.default) || locations.data[0]).id);
  }, [locations.data, locationId]);

  const bookingsQ = useQuery({
    queryKey: ['dispatch', date],
    queryFn: () => l27All<DispatchBooking>('/v1/staff/bookings', { from: date, to: date, sort: 'asc' }),
    refetchInterval: 60_000,
  });
  const teamsQ = useActiveTeams();
  const teams = useMemo(
    () => ((teamsQ.data || []) as unknown as DispatchTeam[]).filter((t) => locationId === 'all' || locationId === null || !t.locations?.length || t.locations.some((l) => l.id === locationId)),
    [teamsQ.data, locationId],
  );
  const availQ = useQuery({
    queryKey: ['availability', teams.map((t) => t.id).join(',')],
    queryFn: async () => {
      const rows = await mapLimit(teams, 8, (t) => l27<AvailabilityRow[]>(`/v1/staff/teams/${t.id}/availability`).catch(() => [] as AvailabilityRow[]));
      return new Map(teams.map((t, i) => [t.id, rows[i]]));
    },
    enabled: teams.length > 0,
    staleTime: 30 * 60_000,
  });
  const availability = availQ.data || new Map<number, AvailabilityRow[]>();

  const bookings = useMemo(
    () => (bookingsQ.data || []).filter((b) => b.active !== false && (locationId === 'all' || locationId === null || b.location?.id === locationId)),
    [bookingsQ.data, locationId],
  );
  const board = useMemo(() => buildBoard(bookings, availability, date, now), [bookings, availability, date, now]);

  const q = search.trim().toLowerCase();
  const matches = (b: DispatchBooking) => !q || [b.id, b.user?.name, b.address?.full_address, b.address?.city].join(' ').toLowerCase().includes(q);
  // Projected visits get their cleaner from the series once created, so they don't need dispatching yet.
  const unassigned = (board.get(null) || []).filter((bl) => !isProjected(bl.booking) && matches(bl.booking));
  const projectedUnassigned = (board.get(null) || []).filter((bl) => isProjected(bl.booking)).length;

  const rows = useMemo(() => {
    const list = teams
      .map((team) => {
        const blocks = board.get(team.id) || [];
        const win = workingWindow(availability.get(team.id), date);
        return { team, blocks, win, bookedMin: blocks.reduce((s, b) => s + (b.end - b.start), 0) };
      })
      .filter((r) => showAll || r.blocks.length || (r.win && r.win !== 'off'))
      .filter((r) => !q || cleanName(r.team.title).toLowerCase().includes(q) || r.blocks.some((b) => matches(b.booking)));
    // Busy cleaners first, then by first job time, then name.
    return list.sort((a, b) => (b.blocks.length ? 1 : 0) - (a.blocks.length ? 1 : 0) || (a.blocks[0]?.start ?? 9999) - (b.blocks[0]?.start ?? 9999) || cleanName(a.team.title).localeCompare(cleanName(b.team.title)));
  }, [teams, board, availability, date, showAll, q]);

  const stats = useMemo(() => {
    const all = [...board.values()].flat();
    const by = (s: BlockStatus) => all.filter((b) => b.status === s).length;
    const working = rows.filter((r) => r.win && r.win !== 'off');
    const availMin = working.reduce((s, r) => s + (r.win && r.win !== 'off' ? r.win.end - r.win.start : 0), 0);
    const bookedMin = rows.reduce((s, r) => s + r.bookedMin, 0);
    return {
      bookings: bookings.length,
      unassigned: all.filter((b) => b.status === 'unassigned' && !isProjected(b.booking)).length,
      late: by('late'),
      onsite: by('onsite') + by('enroute'),
      done: by('done'),
      conflicts: all.filter((b) => b.conflict).length,
      projected: all.filter((b) => isProjected(b.booking)).length,
      outside: all.filter((b) => b.outside).length,
      working: working.length,
      utilization: availMin ? bookedMin / availMin : 0,
      revenue: bookings.reduce((s, b) => s + (b.summary?.total || 0), 0),
    };
  }, [board, rows, bookings]);

  const isToday = date === todayISO();
  const nowMin = (() => {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(now));
    return (Number(parts.find((p) => p.type === 'hour')?.value) % 24) * 60 + Number(parts.find((p) => p.type === 'minute')?.value);
  })();

  const selectedBooking = selected ? bookings.find((b) => bookingKey(b) === selected.key) : undefined;

  // ---- Writing assignments ----
  const teamPayload = (b: DispatchBooking): TeamPayload[] => (b.teams || []).map((t) => ({ id: t.id, hours: t.hours || 0, share: t.share || 0 }));
  const perCleanerHours = (b: DispatchBooking, n: number) => {
    const existing = b.teams?.find((t) => t.hours)?.hours;
    if (existing) return existing;
    return b.duration ? Math.round((b.duration / 60 / n) * 100) / 100 : 0;
  };

  async function saveTeams(b: DispatchBooking, next: TeamPayload[], message: string) {
    setBusy(true);
    try {
      if (!b.id) throw new Error('Projected visits can only be assigned on their series in Launch27.');
      await l27Write('POST', '/v1/staff/bookings/assign/teams', { booking_ids: [b.id], teams: next });
      setToast({ ok: true, text: message });
      await queryClient.invalidateQueries({ queryKey: ['dispatch', date] });
    } catch (err) {
      setToast({ ok: false, text: `Couldn't save: ${(err as Error).message}` });
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  const assign = (b: DispatchBooking, to: DispatchTeam, mode: 'replace' | 'add', fromTeamId: number | null) => {
    const current = teamPayload(b);
    let next: TeamPayload[];
    if (mode === 'add' || !current.length) {
      next = [...current, { id: to.id, hours: perCleanerHours(b, current.length + 1), share: to.share || current[0]?.share || 0 }];
    } else {
      const from = fromTeamId ?? current[0]?.id;
      next = current.map((t) => (t.id === from ? { id: to.id, hours: t.hours || perCleanerHours(b, current.length), share: t.share || to.share || 0 } : t));
    }
    const verb = mode === 'add' ? 'added to' : 'assigned to';
    return saveTeams(b, next, `${cleanName(to.title)} ${verb} ${b.user?.name || `booking #${b.id}`} at ${fmtClock(localStart(b))}`);
  };
  const unassign = (b: DispatchBooking, teamId: number) =>
    saveTeams(
      b,
      teamPayload(b).filter((t) => t.id !== teamId),
      `${cleanName(b.teams?.find((t) => t.id === teamId)?.title)} removed from ${b.user?.name || `booking #${b.id}`}`,
    );

  // ---- Drag and drop (desktop) ----
  const onDragStart = (e: DragEvent, block: Block) => {
    if (!canWrite || isProjected(block.booking)) return e.preventDefault();
    dragRef.current = { booking: block.booking, fromTeamId: block.teamId };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', bookingKey(block.booking));
  };
  const onDrop = (e: DragEvent, team: DispatchTeam) => {
    e.preventDefault();
    setDropRow(null);
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || d.fromTeamId === team.id) return;
    if (d.booking.teams?.some((t) => t.id === team.id)) return;
    setPending({ booking: d.booking, toTeam: team, fromTeamId: d.fromTeamId });
  };

  const loading = bookingsQ.isLoading || teamsQ.isLoading;

  return (
    <div className="dispatch">
      <header className="page-header">
        <h1>Dispatch board</h1>
        <div className="filters dispatch-filters">
          <div className="day-nav">
            <button className="secondary" onClick={() => setDate(shiftDay(date, -1))} aria-label="Previous day">
              ‹
            </button>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            <button className="secondary" onClick={() => setDate(shiftDay(date, 1))} aria-label="Next day">
              ›
            </button>
            {!isToday && (
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
          <input placeholder="Find customer, cleaner, address…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <label className="check">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show cleaners who are off
          </label>
        </div>
      </header>

      <div className="dispatch-stats">
        <Stat label="Bookings" value={stats.bookings} sub={fmtMoney(stats.revenue).replace(/\.\d\d$/, '')} />
        <Stat label="Unassigned" value={stats.unassigned} tone={stats.unassigned ? 'bad' : 'good'} />
        <Stat label="Late" value={stats.late} tone={stats.late ? 'bad' : undefined} />
        <Stat label="On site / en route" value={stats.onsite} />
        <Stat label="Done" value={stats.done} />
        <Stat label="Double-booked" value={stats.conflicts} tone={stats.conflicts ? 'bad' : undefined} />
        <Stat label="Cleaners working" value={stats.working} sub={`${Math.round(stats.utilization * 100)}% booked`} />
      </div>

      {!canWrite && <div className="muted small">Read-only: editing is turned off on the server, so assignments can't be changed here.</div>}
      {loading && <div className="muted">Loading the day…</div>}
      {bookingsQ.error && <div className="error">{(bookingsQ.error as Error).message}</div>}

      {!loading && (
        <>
          <section className={`card tray ${unassigned.length ? 'has-items' : ''}`}>
            <div className="tray-head">
              <h2>
                Needs a cleaner <span className="muted count">({unassigned.length})</span>
              </h2>
              {projectedUnassigned > 0 && <span className="muted small">+ {projectedUnassigned} projected recurring visit{projectedUnassigned > 1 ? 's' : ''} without a cleaner (assign them on the series in Launch27)</span>}
              {canWrite && unassigned.length > 0 && <span className="muted small">Drag onto a cleaner's row, or tap to see suggestions.</span>}
            </div>
            {unassigned.length === 0 ? (
              <div className="muted small">Every booking has a cleaner. 🎉</div>
            ) : (
              <div className="tray-items">
                {unassigned.map((bl) => (
                  <button
                    key={bookingKey(bl.booking)}
                    className={`tray-card ${STATUS[bl.status].cls}`}
                    draggable={canWrite}
                    onDragStart={(e) => onDragStart(e, bl)}
                    onClick={() => setSelected({ key: bookingKey(bl.booking), teamId: null })}
                  >
                    <strong>{fmtClock(bl.start)}</strong> · {bl.booking.user?.name}
                    <span className="small muted">
                      {bl.booking.address?.city} · {bl.booking.services?.map((s) => s.name).join(', ')} · {((bl.end - bl.start) / 60).toFixed(1)}h
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>

          <div className="legend small dispatch-legend">
            {(['scheduled', 'enroute', 'onsite', 'done', 'late'] as BlockStatus[]).map((s) => (
              <span key={s} className={`legend-chip ${STATUS[s].cls}`}>
                {STATUS[s].label}
              </span>
            ))}
            <span className="legend-chip conflict">Double-booked</span>
            <span className="legend-chip outside">Outside their hours</span>
            <span className="legend-chip off-hours">Not working</span>
            {stats.projected > 0 && <span className="legend-chip projected">Projected recurring visit</span>}
          </div>

          <div className="timeline card">
            <div className="tl-row tl-head">
              <div className="tl-name">Cleaner</div>
              <div className="tl-track">
                {HOURS.map((h) => (
                  <span key={h} className="tl-hour" style={{ left: pctLeft(h) }}>
                    {fmtClock(h)}
                  </span>
                ))}
              </div>
            </div>
            {rows.length === 0 && <div className="muted small tl-empty">No cleaners working this day{locationId !== 'all' ? ' in this location' : ''}.</div>}
            {rows.map(({ team, blocks, win, bookedMin }) => (
              <div
                key={team.id}
                className={`tl-row ${dropRow === team.id ? 'drop' : ''}`}
                onDragOver={(e) => {
                  if (!canWrite || !dragRef.current) return;
                  e.preventDefault();
                  setDropRow(team.id);
                }}
                onDragLeave={() => setDropRow((r) => (r === team.id ? null : r))}
                onDrop={(e) => onDrop(e, team)}
              >
                <div className="tl-name">
                  <span className="dot" style={{ background: team.bg_color || '#ccc' }} />
                  <span className="tl-name-text">
                    {cleanName(team.title)}
                    <span className="muted small">
                      {win === 'off' ? 'Day off' : win ? `${fmtClock(win.start)}–${fmtClock(win.end)}` : 'No hours set'} · {blocks.length} job{blocks.length === 1 ? '' : 's'} · {(bookedMin / 60).toFixed(1)}h
                    </span>
                  </span>
                </div>
                <div className="tl-track">
                  {HOURS.map((h) => (
                    <span key={h} className="tl-grid" style={{ left: pctLeft(h) }} />
                  ))}
                  {win === 'off' && <span className="tl-off" style={{ left: 0, width: '100%' }} />}
                  {win && win !== 'off' && (
                    <>
                      {win.start > DAY_START && <span className="tl-off" style={{ left: 0, width: pctWidth(DAY_START, win.start) }} />}
                      {win.end < DAY_END && <span className="tl-off" style={{ left: pctLeft(win.end), width: pctWidth(win.end, DAY_END) }} />}
                    </>
                  )}
                  {isToday && nowMin > DAY_START && nowMin < DAY_END && <span className="tl-now" style={{ left: pctLeft(nowMin) }} />}
                  {blocks.map((bl) => (
                    <button
                      key={`${bookingKey(bl.booking)}-${team.id}`}
                      className={`tl-block ${STATUS[bl.status].cls} ${bl.conflict ? 'conflict' : ''} ${bl.outside ? 'outside' : ''} ${isProjected(bl.booking) ? 'projected' : ''} ${selected?.key === bookingKey(bl.booking) ? 'selected' : ''} ${q && !matches(bl.booking) ? 'dim' : ''}`}
                      style={{ left: pctLeft(bl.start), width: pctWidth(bl.start, bl.end) }}
                      draggable={canWrite && !isProjected(bl.booking)}
                      onDragStart={(e) => onDragStart(e, bl)}
                      onClick={() => setSelected({ key: bookingKey(bl.booking), teamId: team.id })}
                      title={`${fmtClock(bl.start)}–${fmtClock(bl.end)} · ${bl.booking.user?.name} · ${bl.booking.address?.full_address || ''}`}
                    >
                      <span className="tl-block-line">
                        <span className="tl-block-time">{fmtClock(bl.start)}</span> <span className="tl-block-name">{bl.booking.user?.name}</span>
                      </span>
                      <span className="tl-block-sub">
                        {bl.booking.address?.city} · {bl.booking.services?.[0]?.name}
                        {(bl.booking.teams?.length || 0) > 1 ? ` · +${(bl.booking.teams?.length || 1) - 1}` : ''}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {selectedBooking && (
        <BookingDrawer
          booking={selectedBooking}
          focusTeamId={selected!.teamId}
          teams={teams}
          board={board}
          availability={availability}
          date={date}
          canWrite={canWrite}
          busy={busy}
          onClose={() => setSelected(null)}
          onAssign={(team, mode) => assign(selectedBooking, team, mode, selected!.teamId)}
          onUnassign={(teamId) => unassign(selectedBooking, teamId)}
        />
      )}

      {pending && (
        <div className="modal-backdrop" onClick={() => !busy && setPending(null)}>
          <div className="card modal" onClick={(e) => e.stopPropagation()}>
            <h2>
              Give {pending.booking.user?.name}'s {fmtClock(localStart(pending.booking))} visit to {cleanName(pending.toTeam.title)}?
            </h2>
            {pending.fromTeamId !== null ? (
              <p>
                It's currently with <strong>{cleanName(pending.booking.teams?.find((t) => t.id === pending.fromTeamId)?.title)}</strong>.
              </p>
            ) : (
              <p>This booking doesn't have a cleaner yet.</p>
            )}
            <ConflictNote booking={pending.booking} team={pending.toTeam} board={board} availability={availability} date={date} />
            <p className="muted small">Only this visit changes, not the rest of a recurring series. Launch27 notifies the cleaner.</p>
            <div className="actions end">
              <button className="secondary" disabled={busy} onClick={() => setPending(null)}>
                Cancel
              </button>
              {pending.fromTeamId !== null && (
                <button className="secondary" disabled={busy} onClick={() => assign(pending.booking, pending.toTeam, 'add', pending.fromTeamId)}>
                  Add as 2nd cleaner
                </button>
              )}
              <button disabled={busy} onClick={() => assign(pending.booking, pending.toTeam, 'replace', pending.fromTeamId)}>
                {busy ? 'Saving…' : pending.fromTeamId !== null ? 'Move it' : 'Assign'}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className={`toast ${toast.ok ? 'ok' : 'bad'}`}>{toast.text}</div>}
    </div>
  );
}

function localStart(b: DispatchBooking) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(b.service_date));
  return (Number(parts.find((p) => p.type === 'hour')?.value) % 24) * 60 + Number(parts.find((p) => p.type === 'minute')?.value);
}

function Stat({ label, value, sub, tone }: { label: string; value: number | string; sub?: string; tone?: 'bad' | 'good' }) {
  return (
    <div className={`dstat ${tone || ''}`}>
      <div className="dstat-value">{value}</div>
      <div className="dstat-label">{label}</div>
      {sub && <div className="muted small">{sub}</div>}
    </div>
  );
}

function ConflictNote({ booking, team, board, availability, date }: { booking: DispatchBooking; team: DispatchTeam; board: Map<number | null, Block[]>; availability: Map<number, AvailabilityRow[]>; date: string }) {
  const c = rankCandidates({ ...booking, teams: [] }, [team], board, availability, date)[0];
  if (!c || c.fit === 'free') return <p className="ok small">✓ {cleanName(team.title)} is free then{c?.km != null ? ` · ${c.km.toFixed(1)} km away` : ''}.</p>;
  return <p className="warn small">⚠ {c.note}{c.km != null ? ` · ${c.km.toFixed(1)} km away` : ''}.</p>;
}

function BookingDrawer({
  booking: b,
  focusTeamId,
  teams,
  board,
  availability,
  date,
  canWrite,
  busy,
  onClose,
  onAssign,
  onUnassign,
}: {
  booking: DispatchBooking;
  focusTeamId: number | null;
  teams: DispatchTeam[];
  board: Map<number | null, Block[]>;
  availability: Map<number, AvailabilityRow[]>;
  date: string;
  canWrite: boolean;
  busy: boolean;
  onClose: () => void;
  onAssign: (team: DispatchTeam, mode: 'replace' | 'add') => void;
  onUnassign: (teamId: number) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const blocks = [...board.values()].flat().filter((x) => x.booking.id === b.id);
  const start = blocks[0]?.start ?? localStart(b);
  // Don't suggest accounts that aren't working cleaners (hiring/test placeholders, on hold).
  const suggestable = useMemo(() => teams.filter((t) => !/hiring|do not archive|\btest\b|on hold/i.test(t.title)), [teams]);
  const candidates = useMemo(() => rankCandidates(b, suggestable, board, availability, date), [b, suggestable, board, availability, date]);
  const shown = showAll ? candidates : candidates.slice(0, 6);
  const hasTeam = (b.teams?.length || 0) > 0;
  const projected = isProjected(b);
  canWrite = canWrite && !projected;
  const teamPhone = (id: number) => teams.find((t) => t.id === id)?.phone;
  const mapUrl = b.address?.full_address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(b.address.full_address)}` : null;

  return (
    <aside className="drawer dispatch-drawer">
      <div className="drawer-header">
        <h2>
          {fmtClock(start)} · {b.user?.name}
        </h2>
        <button className="link" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="small muted">
        {b.services?.map((s) => s.name).join(', ')} · {b.frequency?.name} · {fmtMoney(b.summary?.total)} · window {b.arrival_window ? `${b.arrival_window} min` : 'exact'}
      </div>
      <div className="drawer-links">
        {mapUrl && (
          <a href={mapUrl} target="_blank" rel="noreferrer" className="button secondary-link">
            📍 Map
          </a>
        )}
        {b.phone && (
          <a href={`tel:${b.phone}`} className="button secondary-link">
            📞 Call customer
          </a>
        )}
        {b.id && (
          <Link to={`/bookings/${b.id}`} className="button secondary-link">
            Open booking
          </Link>
        )}
      </div>
      {projected && (
        <p className="warn small">
          This is a projected visit of a recurring series — it isn't a booking yet. Its cleaner comes from the series; change it on the{' '}
          <Link to={`/bookings/${b.forecasted_from_booking!.id}`}>series' current booking</Link>.
        </p>
      )}
      <p className="small">{b.address?.full_address}</p>
      {(b.staff_notes || b.customer_notes) && (
        <div className="drawer-notes small">
          {b.staff_notes && (
            <p>
              <strong>Staff notes:</strong> {b.staff_notes}
            </p>
          )}
          {b.customer_notes && (
            <p>
              <strong>Customer notes:</strong> {b.customer_notes}
            </p>
          )}
        </div>
      )}

      <h3>Cleaners on this job</h3>
      {!hasTeam && <p className="warn small">Nobody assigned yet.</p>}
      {b.teams?.map((t) => {
        const bl = blocks.find((x) => x.teamId === t.id);
        return (
          <div key={t.id} className={`row-line ${focusTeamId === t.id ? 'focus' : ''}`}>
            <span>
              <strong>{cleanName(t.title)}</strong>{' '}
              {bl && <span className={`chip ${STATUS[bl.status].cls}`}>{STATUS[bl.status].label}</span>}
              {bl?.conflict && <span className="chip conflict">double-booked</span>}
              {bl?.outside && <span className="chip outside">outside hours</span>}
              <span className="muted small"> {t.hours ? `${t.hours}h` : ''}</span>
            </span>
            <span className="actions">
              {teamPhone(t.id) && (
                <a className="link small" href={`sms:${teamPhone(t.id)}`}>
                  Text
                </a>
              )}
              {canWrite && (
                <button className="link small danger-link" disabled={busy} onClick={() => onUnassign(t.id)}>
                  Remove
                </button>
              )}
            </span>
          </div>
        );
      })}

      {(
        <>
          <h3>{hasTeam ? 'Swap or add a cleaner' : 'Best cleaners for this job'}</h3>
          <p className="muted small">Free and working at {fmtClock(start)} first, then closest to the home.</p>
          <div className="candidates">
            {shown.map((c) => (
              <div key={c.team.id} className={`candidate fit-${c.fit}`}>
                <div>
                  <strong>{cleanName(c.team.title)}</strong>
                  <div className="small muted">
                    <span className={`fit fit-${c.fit}`}>{c.note}</span>
                    {c.km != null && ` · ${c.km.toFixed(1)} km`}
                  </div>
                </div>
                <div className="actions">
                  {canWrite && hasTeam && (
                    <button className="secondary small-btn" disabled={busy} onClick={() => onAssign(c.team, 'add')}>
                      Add
                    </button>
                  )}
                  {canWrite && (
                    <button className="small-btn" disabled={busy} onClick={() => onAssign(c.team, 'replace')}>
                      {hasTeam ? 'Swap in' : 'Assign'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
          {candidates.length > 6 && (
            <button className="link small" onClick={() => setShowAll(!showAll)}>
              {showAll ? 'Show fewer' : `Show all ${candidates.length} cleaners`}
            </button>
          )}
          <p className="muted small">{canWrite ? 'Changes only this visit. Launch27 notifies the cleaner.' : 'Editing is off, so these are suggestions only.'}</p>
        </>
      )}
    </aside>
  );
}
