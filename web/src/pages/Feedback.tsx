import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { l27, l27All } from '../api';
import { useLocations } from '../hooks';
import { fmtDateTime, fmtMoney, TIMEZONE } from '../format';
import {
  analyseDrivers,
  customersAtRisk,
  distinctiveWords,
  insights,
  isDissatisfied,
  scoreCleaners,
  themeStats,
  weeklyControl,
  type Driver,
  type RatedBooking,
} from '../lib/feedbackModel';
import { wilson } from '../lib/stats';

// Customer feedback analytics.
//   GET /v1/staff/bookings?options=with_feedback,exclude_forecasted&from&to   (current + previous period)
//   GET /v1/staff/bookings/count?options=completed,exclude_forecasted&from&to  (response rate)
// All statistics run in the browser (web/src/lib/feedbackModel.ts, web/src/lib/stats.ts).
// "Dissatisfied" = rated Okay or Unhappy; Launch27's stars (5 / 2.5 / 1) just mirror that rating.

const RATING = {
  2: { label: 'Happy', cls: 'ok', face: '🙂' },
  1: { label: 'Okay', cls: 'warn', face: '😐' },
  0: { label: 'Unhappy', cls: 'neg', face: '🙁' },
} as const;

const PRESETS = [
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
  { label: 'Last 6 months', days: 182 },
  { label: 'Last 12 months', days: 365 },
];
type Tab = 'overview' | 'drivers' | 'cleaners' | 'comments' | 'customers';
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Summary' },
  { id: 'drivers', label: 'What upsets customers' },
  { id: 'cleaners', label: 'Cleaners' },
  { id: 'comments', label: 'What customers say' },
  { id: 'customers', label: 'Customers to call' },
];

// Cleaner titles in Launch27 carry codes like "(1)(F)(FT)"; drop them for readability.
const cleanName = (name: string) => name.replace(/^(\s*(\([^)]*\)|ON HOLD))+\s*/i, '') || name;

function isoDay(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}
const pct = (x: number, digits = 0) => `${(x * 100).toFixed(digits)}%`;

export function FeedbackPage() {
  const [days, setDays] = useState(90);
  const [locationId, setLocationId] = useState<number | 'all'>('all');
  const [tab, setTab] = useState<Tab>('overview');
  const [math, setMath] = useState(() => {
    try {
      return localStorage.getItem('feedback:math') === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('feedback:math', math ? '1' : '0');
    } catch {
      /* private mode */
    }
  }, [math]);
  const from = isoDay(-(days - 1));
  const to = isoDay(0);
  const prevFrom = isoDay(-(2 * days - 1));
  const prevTo = isoDay(-days);

  const locations = useLocations();
  const cur = useQuery({
    queryKey: ['feedback', from, to],
    queryFn: () => l27All<RatedBooking>('/v1/staff/bookings', { options: 'with_feedback,exclude_forecasted', from, to, sort: 'desc' }),
  });
  const prev = useQuery({
    queryKey: ['feedback', prevFrom, prevTo],
    queryFn: () => l27All<RatedBooking>('/v1/staff/bookings', { options: 'with_feedback,exclude_forecasted', from: prevFrom, to: prevTo, sort: 'desc' }),
    enabled: !!cur.data,
  });
  const completed = useQuery({
    queryKey: ['completed-count', from, to],
    queryFn: () => l27<{ count: number }>('/v1/staff/bookings/count', { options: 'completed,exclude_forecasted', from, to }),
  });

  const inLoc = (r: RatedBooking) => !!r.feedback && (locationId === 'all' || r.location?.id === locationId);
  const rows = useMemo(() => (cur.data || []).filter(inLoc), [cur.data, locationId]);
  const prevRows = useMemo(() => (prev.data || []).filter(inLoc), [prev.data, locationId]);

  const a = useMemo(() => {
    if (!rows.length) return null;
    const { drivers, baseRate } = analyseDrivers(rows);
    const cleaners = scoreCleaners(rows, baseRate);
    const themes = themeStats(rows);
    const words = distinctiveWords(rows);
    const control = weeklyControl(rows);
    const atRisk = customersAtRisk(rows);
    return { drivers, baseRate, cleaners, themes, words, control, atRisk };
  }, [rows]);
  const ins = useMemo(
    () => (a ? insights({ rows, prev: prev.data ? prevRows : undefined, ...a, completed: locationId === 'all' ? completed.data?.count : undefined }) : []),
    [a, rows, prevRows, prev.data, completed.data, locationId],
  );

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
          <label className="check math-toggle">
            <input type="checkbox" checked={math} onChange={(e) => setMath(e.target.checked)} /> Show the math
          </label>
        </div>
      </header>

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={t.id === tab ? 'tab active' : 'tab'} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {cur.isLoading && <div className="muted">Loading ratings… (a year of data takes about 10 seconds)</div>}
      {cur.error && <div className="error">{(cur.error as Error).message}</div>}
      {cur.data && !a && <div className="muted">No ratings in this period.</div>}

      {a && tab === 'overview' && <Overview rows={rows} prevRows={prev.data ? prevRows : undefined} a={a} ins={ins} completed={locationId === 'all' ? completed.data?.count : undefined} from={from} to={to} onTab={setTab} math={math} />}
      {a && tab === 'drivers' && <Drivers drivers={a.drivers} baseRate={a.baseRate} n={rows.length} math={math} />}
      {a && tab === 'cleaners' && <Cleaners cleaners={a.cleaners} baseRate={a.baseRate} math={math} />}
      {a && tab === 'comments' && <Comments rows={rows} themes={a.themes} words={a.words} />}
      {a && tab === 'customers' && <Customers atRisk={a.atRisk} />}

      {a && math && (
        <p className="muted small method">
          Method: dissatisfied = rated Okay or Unhappy. Intervals are 95% Wilson; factor tests use two-proportion z-tests with Benjamini–Hochberg false-discovery control (q &lt; 0.1),
          confirmed by an L2-regularised logistic regression across all factors at once. Cleaner rates use empirical-Bayes (beta-binomial) shrinkage; "likely below average" means
          &gt;90% posterior probability. Comment words are ranked by weighted log-odds with an informative Dirichlet prior. Periods are by visit date.
        </p>
      )}
    </>
  );
}

interface Analysis {
  drivers: Driver[];
  baseRate: number;
  cleaners: ReturnType<typeof scoreCleaners>;
  themes: ReturnType<typeof themeStats>;
  words: ReturnType<typeof distinctiveWords>;
  control: ReturnType<typeof weeklyControl>;
  atRisk: ReturnType<typeof customersAtRisk>;
}

// ---------------- Overview ----------------

function Overview({ rows, prevRows, a, ins, completed, from, to, onTab, math }: { rows: RatedBooking[]; prevRows?: RatedBooking[]; a: Analysis; ins: ReturnType<typeof insights>; completed?: number; from: string; to: string; onTab: (t: Tab) => void; math: boolean }) {
  const happy = rows.filter((r) => r.feedback.rating === 2).length;
  const okay = rows.filter((r) => r.feedback.rating === 1).length;
  const unhappy = rows.filter((r) => r.feedback.rating === 0).length;
  const prevDis = prevRows?.length ? prevRows.filter(isDissatisfied).length / prevRows.length : null;
  const [lo, hi] = wilson(rows.filter(isDissatisfied).length, rows.length);
  const recurringRisk = a.atRisk.filter((c) => c.recurring);
  const change = prevDis === null ? null : a.baseRate - prevDis;
  const groups: { tone: 'bad' | 'info' | 'good'; title: string }[] = [
    { tone: 'bad', title: 'Act now' },
    { tone: 'info', title: 'Worth knowing' },
    { tone: 'good', title: 'Going well' },
  ];

  return (
    <>
      <div className="tiles">
        <Tile
          label="Not happy (okay or unhappy)"
          value={pct(a.baseRate)}
          sub={change === null ? `${rows.length} ratings` : `${change > 0 ? '▲ up' : '▼ down'} from ${pct(prevDis!)} last period${math ? ` · 95% CI ${pct(lo)}–${pct(hi)}` : ''}`}
          tone={change !== null && change > 0.01 ? 'neg' : 'ok'}
        />
        <Tile label="Happy customers" value={pct(happy / rows.length)} sub={`${happy} happy · ${okay} okay · ${unhappy} unhappy`} />
        <Tile label="Visits that get rated" value={completed ? pct(rows.length / completed) : '—'} sub={completed ? `${rows.length} of ${completed} visits · ${from} → ${to}` : `${rows.length} ratings`} />
        <Tile label="Business at risk (per year)" value={`$${Math.round(recurringRisk.reduce((s, c) => s + c.annual, 0) / 1000)}k`} sub={`${recurringRisk.length} regular customers to call`} tone={recurringRisk.length ? 'neg' : undefined} />
      </div>

      {groups.map((g) => {
        const list = ins.filter((i) => i.tone === g.tone);
        if (!list.length) return null;
        return (
          <section key={g.tone} className={`card insight-group ${g.tone}`}>
            <h2>{g.title}</h2>
            {list.map((i, n) => (
              <div key={n} className={`insight-card ${i.tone}`}>
                <div className="insight-title">{i.title}</div>
                {i.action && (
                  <div className="insight-action">
                    <strong>What to do:</strong> {i.action}
                  </div>
                )}
                {math && i.math && <div className="insight-math">{i.math}</div>}
                {i.tab && (
                  <button className="link small" onClick={() => onTab(i.tab!)}>
                    See the details →
                  </button>
                )}
              </div>
            ))}
          </section>
        );
      })}

      <section className="card">
        <h2>Week by week</h2>
        <ControlChart control={a.control} />
        <p className="muted small">
          Each dot is one week: the share of customers who weren't happy. A <span className="neg">red dot</span> means that week was unusually bad — worth asking what happened.
          {math && ' Dashed line: 3σ upper control limit (p-chart) for that week\'s sample size; dotted line: period average.'}
        </p>
      </section>
    </>
  );
}

function ControlChart({ control }: { control: ReturnType<typeof weeklyControl> }) {
  const W = 700;
  const H = 200;
  const pad = { l: 36, r: 10, t: 10, b: 28 };
  const weeks = control.weeks;
  if (weeks.length < 2) return <div className="muted small">Not enough weeks.</div>;
  const maxY = Math.min(1, Math.max(...weeks.map((w) => Math.max(w.rate, w.ucl))) * 1.1);
  const x = (i: number) => pad.l + (i / (weeks.length - 1)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / maxY) * (H - pad.t - pad.b);
  const ticks = [0, maxY / 2, maxY];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="control-chart" role="img">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="grid" />
          <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" className="axis">
            {pct(t)}
          </text>
        </g>
      ))}
      <line x1={pad.l} x2={W - pad.r} y1={y(control.pbar)} y2={y(control.pbar)} className="mean" />
      <polyline points={weeks.map((w, i) => `${x(i)},${y(w.ucl)}`).join(' ')} className="ucl" />
      <polyline points={weeks.map((w, i) => `${x(i)},${y(w.rate)}`).join(' ')} className="series" />
      {weeks.map((w, i) => (
        <circle key={w.week} cx={x(i)} cy={y(w.rate)} r={w.out ? 5 : 3.5} className={w.out ? 'pt out' : 'pt'}>
          <title>{`Week of ${w.week}: ${w.k}/${w.n} dissatisfied (${pct(w.rate)}); limit ${pct(w.ucl)}`}</title>
        </circle>
      ))}
      {weeks.map((w, i) =>
        i % Math.ceil(weeks.length / 8) === 0 ? (
          <text key={`l${w.week}`} x={x(i)} y={H - 8} textAnchor="middle" className="axis">
            {w.week.slice(5)}
          </text>
        ) : null,
      )}
    </svg>
  );
}

// ---------------- Drivers ----------------

const GROUP_ORDER = ['Extras', 'Service', 'Home', 'Frequency', 'Scheduling', 'Execution', 'Price', 'Location'];
const VERDICT: Record<Driver['verdict'], { label: string; cls: string; tip: string }> = {
  confirmed: { label: 'Real problem', cls: 'v-bad', tip: 'Holds up even after accounting for everything else about the visit' },
  raw: { label: "Looks bad, but it's something else", cls: 'v-raw', tip: 'The difference is real, but mostly explained by other things (e.g. one-time or bigger jobs)' },
  reference: { label: 'Comparison group', cls: 'v-ref', tip: 'Used as the point of comparison' },
  ns: { label: 'Not enough evidence', cls: 'v-ns', tip: 'Could be chance with this many ratings' },
};
const verdictOf = (d: Driver) => {
  if (d.rate < d.rateWithout && d.verdict === 'confirmed') return { label: 'Real strength', cls: 'v-confirmed', tip: VERDICT.confirmed.tip };
  if (d.rate < d.rateWithout && d.verdict === 'raw') return { label: "Looks good, but it's something else", cls: 'v-ns', tip: VERDICT.raw.tip };
  return VERDICT[d.verdict];
};

function Drivers({ drivers, baseRate, n, math }: { drivers: Driver[]; baseRate: number; n: number; math: boolean }) {
  const [onlySig, setOnlySig] = useState(false);
  const groups = GROUP_ORDER.map((g) => ({
    g,
    list: drivers.filter((d) => d.group === g && (!onlySig || d.verdict === 'confirmed' || d.verdict === 'raw')).sort((a, b) => b.ratio - a.ratio),
  })).filter((x) => x.list.length);
  const maxRate = Math.max(...drivers.map((d) => d.ci[1]), baseRate * 2, 0.3);

  return (
    <>
      <section className="card">
        <div className="row-line no-border">
          <h2>What makes customers unhappy</h2>
          <label className="check">
            <input type="checkbox" checked={onlySig} onChange={(e) => setOnlySig(e.target.checked)} /> Only clear findings
          </label>
        </div>
        <p className="muted small">
          For each part of a visit — an extra, the type of home, when it was booked, whether the cleaner was late — the % of customers who weren't happy. The grey line is the company average (
          <strong>{pct(baseRate)}</strong>). Red dots are worse than average, green better.
          {math && ` Bars show 95% Wilson intervals; ${n} ratings; factors need 12+ ratings. "Adj. odds" is from a logistic regression on all factors at once; verdicts use Benjamini–Hochberg q < 0.1 plus the adjusted CI.`}
        </p>
        <div className="legend small">
          <span className="verdict v-bad">Real problem — fix it</span>
          <span className="verdict v-confirmed">Real strength</span>
          <span className="verdict v-raw">Looks bad, but it's something else</span>
          <span className="verdict v-ns">Not enough evidence yet</span>
        </div>
      </section>

      {groups.map(({ g, list }) => (
        <section key={g} className="card">
          <h2>{g === 'Extras' ? 'Extras (add-ons)' : g}</h2>
          <div className="driver-table">
            <div className={`driver-row head ${math ? 'math' : ''}`}>
              <span>&nbsp;</span>
              <span>Not happy when included</span>
              <span className="num">Otherwise</span>
              {math && <span className="num">Raw</span>}
              {math && <span className="num">Adj. odds (95% CI)</span>}
              <span>What it means</span>
            </div>
            {list.map((d) => (
              <div key={d.key} className={`driver-row ${math ? 'math' : ''}`}>
                <span className="driver-label">
                  {d.label} <span className="muted small">{d.n} ratings</span>
                </span>
                <span className="rate-cell">
                  <span className="rate-bar">
                    <span className="ci" style={{ left: `${(d.ci[0] / maxRate) * 100}%`, width: `${((d.ci[1] - d.ci[0]) / maxRate) * 100}%` }} />
                    <span className={`pt ${d.rate > baseRate ? 'bad' : 'good'}`} style={{ left: `${(d.rate / maxRate) * 100}%` }} />
                    <span className="base" style={{ left: `${(baseRate / maxRate) * 100}%` }} />
                  </span>
                  <span className="small">{pct(d.rate)}</span>
                </span>
                <span className="num small" data-label="otherwise">{pct(d.rateWithout)}</span>
                {math && <span data-label="raw" className={`num small ${d.ratio > 1.2 ? 'neg' : d.ratio < 0.8 ? 'ok' : ''}`}>{Number.isFinite(d.ratio) ? `${d.ratio.toFixed(1)}×` : '—'}</span>}
                {math && <span className="num small" data-label="adj. odds">{d.adjOdds ? `${d.adjOdds.toFixed(2)} (${d.adjOddsCi![0].toFixed(2)}–${d.adjOddsCi![1].toFixed(2)})` : '—'}</span>}
                <span>
                  <span className={`verdict ${verdictOf(d).cls}`} title={`${verdictOf(d).tip}${math ? `. q=${d.qValue.toFixed(3)}` : ''}`}>
                    {verdictOf(d).label}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

// ---------------- Cleaners ----------------

function Cleaners({ cleaners, baseRate, math }: { cleaners: ReturnType<typeof scoreCleaners>; baseRate: number; math: boolean }) {
  const [minN, setMinN] = useState(5);
  const [view, setView] = useState<'all' | 'worse' | 'better'>('all');
  const list = cleaners.filter((c) => c.n >= minN && (view === 'all' || c.flag === view));
  const maxHi = Math.max(...cleaners.map((c) => c.hi), baseRate * 2, 0.3);
  return (
    <section className="card">
      <div className="row-line no-border">
        <div className="tabs inline">
          {(['all', 'worse', 'better'] as const).map((v) => (
            <button key={v} className={v === view ? 'tab active' : 'tab'} onClick={() => setView(v)}>
              {v === 'all' ? 'All cleaners' : v === 'worse' ? `Needs coaching (${cleaners.filter((c) => c.flag === 'worse').length})` : `Top performers (${cleaners.filter((c) => c.flag === 'better').length})`}
            </button>
          ))}
        </div>
        <label className="small muted">
          Min. ratings{' '}
          <select value={minN} onChange={(e) => setMinN(Number(e.target.value))}>
            {[1, 3, 5, 10, 20].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
      </div>
      <p className="muted small">
        Sorted by how often customers aren't happy, compared with the team average ({pct(baseRate)}, grey line). We take the number of ratings into account, so one bad review out of two doesn't
        make someone look terrible — a cleaner is only marked <strong>Needs coaching</strong> when the pattern is clear.
        {math && ' Adjusted rate = empirical-Bayes (beta-binomial) posterior mean; bar = 90% credible range; flagged when P(rate > average) > 90% with ≥5 ratings.'}
      </p>
      <div className="cards-on-mobile nested">
        <table>
          <thead>
            <tr>
              <th>Cleaner</th>
              <th className="num">Not happy</th>
              <th>Compared with the team</th>
              <th>{math ? 'P(worse)' : 'How sure'}</th>
              <th>Latest complaint</th>
            </tr>
          </thead>
          <tbody>
            {list.map((c) => (
              <tr key={c.id} className="static">
                <td data-label="Cleaner">
                  {cleanName(c.name)} {c.flag === 'worse' && <span className="verdict v-bad">needs coaching</span>}
                  {c.flag === 'better' && <span className="verdict v-confirmed">top performer</span>}
                </td>
                <td data-label="Not happy" className="num">
                  {c.k} of {c.n}
                </td>
                <td data-label="Compared with team">
                  <span className="rate-cell">
                    <span className="rate-bar">
                      <span className="ci" style={{ left: `${(c.lo / maxHi) * 100}%`, width: `${((c.hi - c.lo) / maxHi) * 100}%` }} />
                      <span className={`pt ${c.adjRate > baseRate ? 'bad' : 'good'}`} style={{ left: `${(c.adjRate / maxHi) * 100}%` }} />
                      <span className="base" style={{ left: `${(baseRate / maxHi) * 100}%` }} />
                    </span>
                    {math && <span className="small">{pct(c.adjRate)}</span>}
                  </span>
                </td>
                <td data-label={math ? 'P(worse)' : 'How sure'} className={c.probWorse > 0.9 ? 'neg' : c.probWorse < 0.1 ? 'ok' : 'muted'}>
                  {math ? pct(c.probWorse) : sureness(c)}
                </td>
                <td data-label="Comment">{c.lastComment ? <span className="clip" title={c.lastComment}>“{c.lastComment}”</span> : <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function sureness(c: ReturnType<typeof scoreCleaners>[number]) {
  if (c.flag === 'worse') return c.probWorse > 0.97 ? 'Very sure' : 'Fairly sure';
  if (c.flag === 'better') return c.probWorse < 0.03 ? 'Very sure' : 'Fairly sure';
  return c.n < 5 ? 'Too few ratings' : 'In line with team';
}

// ---------------- Comments ----------------

function Comments({ rows, themes, words }: { rows: RatedBooking[]; themes: ReturnType<typeof themeStats>; words: ReturnType<typeof distinctiveWords> }) {
  const navigate = useNavigate();
  const [view, setView] = useState<'all' | 0 | 1 | 2>('all');
  const [theme, setTheme] = useState<string | null>(null);
  const [shown, setShown] = useState(30);
  const themeRe = theme ? themes.find((t) => t.key === theme)?.re : null;
  const feed = useMemo(
    () =>
      rows
        .filter((r) => r.feedback.comment?.trim())
        .filter((r) => (view === 'all' || r.feedback.rating === view) && (!themeRe || themeRe.test(r.feedback.comment!)))
        .sort((a, b) => (b.feedback.rated_at || '').localeCompare(a.feedback.rated_at || '')),
    [rows, view, themeRe],
  );
  useEffect(() => setShown(30), [view, theme]);
  const counts = { 0: 0, 1: 0, 2: 0 } as Record<number, number>;
  for (const r of rows) if (r.feedback.comment?.trim()) counts[r.feedback.rating] += 1;
  const maxZ = Math.max(...words.complaints.map((w) => w.score), ...words.praise.map((w) => -w.score), 1);

  return (
    <>
      <div className="grid-2">
        <section className="card">
          <h2>What people complain about</h2>
          <p className="muted small">Out of every negative comment, how many mention each topic. Tap a topic to read those comments.</p>
          {themes
            .filter((t) => t.key !== 'praise')
            .map((t) => (
              <button key={t.key} className={`theme-row ${theme === t.key ? 'active' : ''}`} onClick={() => setTheme(theme === t.key ? null : t.key)}>
                <span className="theme-label">{t.label}</span>
                <span className="dist-bar">
                  <span className="bad" style={{ width: `${t.ofComplaints * 100}%` }} />
                </span>
                <span className="small muted">{pct(t.ofComplaints)}</span>
              </button>
            ))}
        </section>
        <section className="card">
          <h2>The words customers use</h2>
          <p className="muted small">Words that show up much more in unhappy comments than happy ones (and vice versa). Bigger = stronger signal.</p>
          <div className="word-cols">
            <div>
              <h3 className="neg">When unhappy</h3>
              {words.complaints.map((w) => (
                <span key={w.word} className="word neg" style={{ fontSize: `${12 + (w.score / maxZ) * 8}px` }} title={`${w.a} critical vs ${w.b} happy comments`}>
                  {w.word}
                </span>
              ))}
            </div>
            <div>
              <h3 className="ok">When happy</h3>
              {words.praise.map((w) => (
                <span key={w.word} className="word ok" style={{ fontSize: `${12 + (-w.score / maxZ) * 8}px` }} title={`${w.b} happy vs ${w.a} critical comments`}>
                  {w.word}
                </span>
              ))}
            </div>
          </div>
        </section>
      </div>

      <div className="page-header list-header">
        <h2>
          Comments <span className="muted count">({feed.length})</span>
          {theme && (
            <button className="link small" onClick={() => setTheme(null)}>
              {' '}
              clear theme ×
            </button>
          )}
        </h2>
      </div>
      <div className="tabs">
        {(['all', 0, 1, 2] as const).map((v) => (
          <button key={v} className={v === view ? 'tab active' : 'tab'} onClick={() => setView(v)}>
            {v === 'all' ? 'All' : `${RATING[v].face} ${RATING[v].label} (${counts[v]})`}
          </button>
        ))}
      </div>
      <div className="feed">
        {feed.slice(0, shown).map((r) => {
          const rt = RATING[r.feedback.rating] || RATING[1];
          return (
            <div key={r.id} className="card feed-item" onClick={() => navigate(`/bookings/${r.id}`)}>
              <div className="row-line no-border">
                <span className={`small ${rt.cls}`}>
                  {rt.face} {rt.label}
                </span>
                <span className="muted small">{fmtDateTime(r.feedback.rated_at)}</span>
              </div>
              <p className="pre feed-comment">“{r.feedback.comment!.trim()}”</p>
              <div className="muted small">
                {r.user?.id ? (
                  <Link to={`/customers/${r.user.id}`} onClick={(e) => e.stopPropagation()}>
                    {r.user.name}
                  </Link>
                ) : (
                  r.user?.name
                )}{' '}
                · {r.teams?.map((t) => t.title).join(', ') || 'Unassigned'} · {r.services?.map((s) => s.name).join(', ')} · {r.frequency?.name} · visit {fmtDateTime(r.service_date)}
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
  );
}

// ---------------- Customers ----------------

function Customers({ atRisk }: { atRisk: ReturnType<typeof customersAtRisk> }) {
  const [recurringOnly, setRecurringOnly] = useState(true);
  const list = atRisk.filter((c) => !recurringOnly || c.recurring);
  const total = list.reduce((s, c) => s + c.annual, 0);
  const download = () => {
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [
      ['Customer', 'Email', 'Phone', 'Frequency', 'Annual value', 'Latest rating', 'Rated at', 'Cleaner', 'Dissatisfied / ratings', 'Comment', 'Booking'].map(esc).join(','),
      ...list.map((c) =>
        [c.latest.user?.name, c.latest.user?.email, c.latest.phone, c.latest.frequency?.name, c.annual.toFixed(0), RATING[c.latest.feedback.rating].label, c.latest.feedback.rated_at, c.latest.teams?.map((t) => t.title).join('; '), `${c.dissatisfied}/${c.ratings}`, c.latest.feedback.comment, c.latest.id]
          .map(esc)
          .join(','),
      ),
    ];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    a.download = 'customers-to-follow-up.csv';
    a.click();
  };
  return (
    <section className="card">
      <div className="row-line no-border">
        <h2>
          Customers to call <span className="muted count">({list.length})</span>
        </h2>
        <div className="actions">
          <label className="check">
            <input type="checkbox" checked={recurringOnly} onChange={(e) => setRecurringOnly(e.target.checked)} /> Recurring only
          </label>
          <button className="secondary" onClick={download} disabled={!list.length}>
            Download CSV
          </button>
        </div>
      </div>
      <p className="muted small">
        Customers whose last rating was okay or unhappy, biggest accounts first — about <strong>{fmtMoney(total).replace(/\.\d\d$/, '')}</strong> a year of business. Call them, listen, and fix it;
        anyone unhappy more than once (red number) is most likely to leave.
      </p>
      <div className="cards-on-mobile nested">
        <table>
          <thead>
            <tr>
              <th>Customer</th>
              <th>Plan</th>
              <th className="num">Annual value</th>
              <th>Latest</th>
              <th className="num">Negative / ratings</th>
              <th>Comment</th>
            </tr>
          </thead>
          <tbody>
            {list.map((c) => (
              <tr key={c.latest.id} className="static">
                <td data-label="Customer">{c.latest.user?.id ? <Link to={`/customers/${c.latest.user.id}`}>{c.latest.user.name}</Link> : c.latest.user?.name}</td>
                <td data-label="Plan">{c.latest.frequency?.name}</td>
                <td data-label="Annual value" className="num">
                  {fmtMoney(c.annual).replace(/\.\d\d$/, '')}
                </td>
                <td data-label="Latest">
                  <Link to={`/bookings/${c.latest.id}`} className={RATING[c.latest.feedback.rating].cls}>
                    {RATING[c.latest.feedback.rating].face} {RATING[c.latest.feedback.rating].label}
                  </Link>{' '}
                  <span className="muted small">{fmtDateTime(c.latest.feedback.rated_at)}</span>
                </td>
                <td data-label="Negative / ratings" className={`num ${c.dissatisfied > 1 ? 'neg' : ''}`}>
                  {c.dissatisfied} / {c.ratings}
                </td>
                <td data-label="Comment">{c.latest.feedback.comment ? <span className="clip" title={c.latest.feedback.comment}>“{c.latest.feedback.comment}”</span> : <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
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
