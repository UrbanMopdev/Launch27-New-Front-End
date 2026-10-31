import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { l27, l27All } from '../api';
import { useLocations } from '../hooks';
import { BarChart } from '../components/BarChart';
import type { Booking } from '../types';
import { fmtDateTime, TIMEZONE } from '../format';

// Customer feedback metrics.
//   GET /v1/staff/bookings?options=with_feedback,exclude_forecasted&from&to  (all pages)
//     each booking carries feedback: { stars (0-5), rating (0 bad, 1 okay, 2 good), comment, rated_at }
//   GET /v1/staff/bookings/count?options=completed,exclude_forecasted&from&to  (for response rate)
// Launch27's own report (/v1/staff/reports/customer_feedbacks?group=team) only gives all-time
// per-cleaner totals, so everything here is computed from the individual ratings.

interface Feedback {
  stars: number;
  rating: 0 | 1 | 2;
  comment?: string | null;
  rated_at?: string;
}
type Rated = Booking & { feedback: Feedback; location_id?: number };

const RATING = {
  2: { label: 'Happy', cls: 'ok', face: '🙂' },
  1: { label: 'Okay', cls: 'warn', face: '😐' },
  0: { label: 'Unhappy', cls: 'neg', face: '🙁' },
} as const;

function isoDay(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}
const PRESETS = [
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
  { label: 'Last 12 months', days: 365 },
];

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const fmtStars = (n: number) => `${n.toFixed(2)}★`;

// Monday of the week, as YYYY-MM-DD
function weekOf(iso: string) {
  const d = new Date(iso);
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  return d.toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

interface Group {
  key: string;
  label: string;
  count: number;
  avgStars: number;
  happy: number;
  okay: number;
  unhappy: number;
  last?: Rated;
}

function groupBy(rows: Rated[], keyOf: (r: Rated) => { key: string; label: string }[]): Group[] {
  const map = new Map<string, { label: string; list: Rated[] }>();
  for (const r of rows) {
    for (const k of keyOf(r)) {
      const g = map.get(k.key) || { label: k.label, list: [] };
      g.list.push(r);
      map.set(k.key, g);
    }
  }
  return [...map.entries()].map(([key, { label, list }]) => {
    const sorted = [...list].sort((a, b) => (b.feedback.rated_at || '').localeCompare(a.feedback.rated_at || ''));
    return {
      key,
      label,
      count: list.length,
      avgStars: avg(list.map((r) => r.feedback.stars)),
      happy: list.filter((r) => r.feedback.rating === 2).length,
      okay: list.filter((r) => r.feedback.rating === 1).length,
      unhappy: list.filter((r) => r.feedback.rating === 0).length,
      last: sorted[0],
    };
  });
}

export function FeedbackPage() {
  const navigate = useNavigate();
  const [days, setDays] = useState(30);
  const from = isoDay(-(days - 1));
  const to = isoDay(0);
  const [locationId, setLocationId] = useState<number | 'all'>('all');
  const [view, setView] = useState<'all' | 0 | 1 | 2>('all');
  const [commentsOnly, setCommentsOnly] = useState(false);
  const [groupTab, setGroupTab] = useState<'cleaner' | 'service' | 'location'>('cleaner');
  const [minRatings, setMinRatings] = useState(3);
  const [shown, setShown] = useState(30);

  const locations = useLocations();
  const locationName = (id?: number) => locations.data?.find((l) => l.id === id)?.name || (id ? `Location ${id}` : '—');

  const rated = useQuery({
    queryKey: ['feedback', from, to],
    queryFn: () => l27All<Rated>('/v1/staff/bookings', { options: 'with_feedback,exclude_forecasted', from, to, sort: 'desc' }),
  });
  const completed = useQuery({
    queryKey: ['completed-count', from, to],
    queryFn: () => l27<{ count: number }>('/v1/staff/bookings/count', { options: 'completed,exclude_forecasted', from, to }),
  });

  const rows = useMemo(
    () => (rated.data || []).filter((r) => r.feedback && (locationId === 'all' || (r.location_id ?? r.location?.id) === locationId)),
    [rated.data, locationId],
  );
  useEffect(() => setShown(30), [from, locationId, view, commentsOnly]);

  const m = useMemo(() => {
    const stars = rows.map((r) => r.feedback.stars);
    const happy = rows.filter((r) => r.feedback.rating === 2).length;
    const okay = rows.filter((r) => r.feedback.rating === 1).length;
    const unhappy = rows.filter((r) => r.feedback.rating === 0).length;
    const withComment = rows.filter((r) => r.feedback.comment?.trim()).length;
    const bucket = (x: number) => Math.min(5, Math.max(1, Math.round(x)));
    const dist = [5, 4, 3, 2, 1].map((s) => ({ s, n: stars.filter((x) => bucket(x) === s).length }));
    return { count: rows.length, avgStars: avg(stars), happy, okay, unhappy, withComment, dist };
  }, [rows]);

  const weekly = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const r of rows) {
      const w = weekOf(r.feedback.rated_at || r.service_date || '');
      map.set(w, [...(map.get(w) || []), r.feedback.stars]);
    }
    const weeks = [...map.keys()].sort();
    return {
      stars: [['Week', 'Avg stars'], ...weeks.map((w) => [w, Number(avg(map.get(w)!).toFixed(2))])] as [string, number][],
      counts: [['Week', 'Ratings'], ...weeks.map((w) => [w, map.get(w)!.length])] as [string, number][],
    };
  }, [rows]);

  const groups = useMemo(() => {
    const byCleaner = groupBy(rows, (r) => (r.teams?.length ? r.teams.map((t) => ({ key: String(t.id), label: t.title || `Team ${t.id}` })) : [{ key: 'none', label: 'Unassigned' }]));
    const byService = groupBy(rows, (r) => (r.services || []).map((s) => ({ key: String(s.id), label: s.name })));
    const byLocation = groupBy(rows, (r) => [{ key: String(r.location_id ?? r.location?.id), label: r.location?.name || locationName(r.location_id) }]);
    const list = groupTab === 'cleaner' ? byCleaner : groupTab === 'service' ? byService : byLocation;
    return list.filter((g) => g.count >= (groupTab === 'cleaner' ? minRatings : 1)).sort((a, b) => a.avgStars - b.avgStars || b.unhappy - a.unhappy);
  }, [rows, groupTab, minRatings, locations.data]);

  const feed = useMemo(
    () =>
      rows
        .filter((r) => (view === 'all' || r.feedback.rating === view) && (!commentsOnly || r.feedback.comment?.trim()))
        .sort((a, b) => (b.feedback.rated_at || '').localeCompare(a.feedback.rated_at || '')),
    [rows, view, commentsOnly],
  );

  const responseRate = completed.data?.count ? (m.count / completed.data.count) * 100 : null;
  const pct = (n: number) => (m.count ? Math.round((n / m.count) * 100) : 0);

  return (
    <>
      <header className="page-header">
        <h1>Customer feedback</h1>
        <div className="filters">
          <label>
            Period
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {PRESETS.map((p) => (
                <option key={p.days} value={p.days}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Location
            <select value={locationId} onChange={(e) => setLocationId(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
              <option value="all">All locations</option>
              {locations.data?.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      {rated.isLoading && <div className="muted">Loading ratings…</div>}
      {rated.error && <div className="error">{(rated.error as Error).message}</div>}

      {rated.data && (
        <>
          <div className="tiles">
            <Tile label="Average rating" value={m.count ? fmtStars(m.avgStars) : '—'} sub={`${m.count} ratings · ${from} → ${to}`} />
            <Tile label="Happy customers" value={`${pct(m.happy)}%`} sub={`${m.happy} happy · ${m.okay} okay · ${m.unhappy} unhappy`} tone={pct(m.happy) >= 80 ? 'ok' : undefined} />
            <Tile
              label="Response rate"
              value={responseRate === null ? '—' : `${responseRate.toFixed(0)}%`}
              sub={completed.data ? `${m.count} of ${completed.data.count} completed visits rated${locationId !== 'all' ? ' (all locations)' : ''}` : undefined}
            />
            <Tile label="Unhappy — follow up" value={String(m.unhappy)} sub={`${m.withComment} ratings left a comment`} tone={m.unhappy ? 'neg' : undefined} />
          </div>

          <div className="grid-2">
            <section className="card">
              <h2>Average stars by week</h2>
              <BarChart series={weekly.stars} format={(n) => `${n.toFixed(2)}★`} height={130} min={3} />
              <div className="muted small">Scale 3★–5★. Hover a bar for the week and average.</div>
              <div className="muted small">Ratings per week: {weekly.counts.slice(1).map(([, n]) => n).join(' · ') || '—'}</div>
            </section>
            <section className="card">
              <h2>Star distribution</h2>
              {m.dist.map(({ s, n }) => (
                <div key={s} className="dist-row">
                  <span className="dist-label">{s}★</span>
                  <span className="dist-bar">
                    <span style={{ width: `${m.count ? (n / m.count) * 100 : 0}%` }} className={s >= 4 ? 'good' : s === 3 ? 'mid' : 'bad'} />
                  </span>
                  <span className="dist-n muted small">
                    {n} ({pct(n)}%)
                  </span>
                </div>
              ))}
            </section>
          </div>

          <section className="card">
            <div className="row-line no-border">
              <div className="tabs inline">
                {(['cleaner', 'service', 'location'] as const).map((g) => (
                  <button key={g} className={g === groupTab ? 'tab active' : 'tab'} onClick={() => setGroupTab(g)}>
                    By {g}
                  </button>
                ))}
              </div>
              {groupTab === 'cleaner' && (
                <label className="small muted">
                  Min. ratings{' '}
                  <select value={minRatings} onChange={(e) => setMinRatings(Number(e.target.value))}>
                    {[1, 3, 5, 10].map((n) => (
                      <option key={n}>{n}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <p className="muted small">Lowest-rated first.</p>
            <div className="cards-on-mobile nested">
              <table>
                <thead>
                  <tr>
                    <th>{groupTab === 'cleaner' ? 'Cleaner' : groupTab === 'service' ? 'Service' : 'Location'}</th>
                    <th className="num">Ratings</th>
                    <th className="num">Avg</th>
                    <th className="num">Happy / Okay / Unhappy</th>
                    <th>Latest comment</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.length === 0 && (
                    <tr>
                      <td colSpan={5} className="muted">
                        Not enough ratings.
                      </td>
                    </tr>
                  )}
                  {groups.map((g) => (
                    <tr key={g.key} className="static">
                      <td data-label={groupTab}>{g.label}</td>
                      <td data-label="Ratings" className="num">
                        {g.count}
                      </td>
                      <td data-label="Avg" className={`num ${g.avgStars < 4 ? 'neg' : ''}`}>
                        {fmtStars(g.avgStars)}
                      </td>
                      <td data-label="Happy / Okay / Unhappy" className="num">
                        {g.happy} / {g.okay} / <span className={g.unhappy ? 'neg' : ''}>{g.unhappy}</span>
                      </td>
                      <td data-label="Latest comment">
                        {g.last?.feedback.comment ? <span className="clip" title={g.last.feedback.comment}>“{g.last.feedback.comment}”</span> : <span className="muted">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <div className="page-header list-header">
            <h2>
              Ratings <span className="muted count">({feed.length})</span>
            </h2>
            <label className="check">
              <input type="checkbox" checked={commentsOnly} onChange={(e) => setCommentsOnly(e.target.checked)} /> With comments only
            </label>
          </div>
          <div className="tabs">
            {(['all', 0, 1, 2] as const).map((v) => (
              <button key={v} className={v === view ? 'tab active' : 'tab'} onClick={() => setView(v)}>
                {v === 'all' ? `All (${m.count})` : `${RATING[v].face} ${RATING[v].label} (${v === 2 ? m.happy : v === 1 ? m.okay : m.unhappy})`}
              </button>
            ))}
          </div>
          <div className="feed">
            {feed.length === 0 && <div className="muted">No ratings.</div>}
            {feed.slice(0, shown).map((r) => {
              const f = r.feedback;
              const rt = RATING[f.rating] || RATING[1];
              return (
                <div key={r.id} className="card feed-item" onClick={() => navigate(`/bookings/${r.id}`)}>
                  <div className="row-line no-border">
                    <span>
                      <span className={`stars ${rt.cls}`}>{'★'.repeat(Math.round(f.stars))}{'☆'.repeat(5 - Math.round(f.stars))}</span>{' '}
                      <span className={`small ${rt.cls}`}>{rt.label}</span>
                    </span>
                    <span className="muted small">{fmtDateTime(f.rated_at)}</span>
                  </div>
                  {f.comment?.trim() ? <p className="pre feed-comment">“{f.comment.trim()}”</p> : <p className="muted small">No comment</p>}
                  <div className="muted small">
                    {r.user?.id ? (
                      <Link to={`/customers/${r.user.id}`} onClick={(e) => e.stopPropagation()}>
                        {r.user.name}
                      </Link>
                    ) : (
                      r.user?.name
                    )}{' '}
                    · {r.teams?.map((t) => t.title).join(', ') || 'Unassigned'} · {r.services?.map((s) => s.name).join(', ')} · visit {fmtDateTime(r.service_date)} ·{' '}
                    {r.location?.name || locationName(r.location_id)}
                  </div>
                </div>
              );
            })}
          </div>
          {feed.length > shown && (
            <button type="button" className="secondary show-more" onClick={() => setShown(shown + 30)}>
              Show more ({feed.length - shown} left)
            </button>
          )}
        </>
      )}
    </>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'ok' | 'neg' }) {
  return (
    <div className="card tile">
      <div className="muted small">{label}</div>
      <div className={`tile-value ${tone || ''}`}>{value}</div>
      {sub && <div className="muted small">{sub}</div>}
    </div>
  );
}
