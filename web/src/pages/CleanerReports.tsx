import { useBrand } from '../brands/useBrand';
import { brandLabel } from '../brands/ui';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { reportsApi, money, pct, type CleanerReport, type CleanerRow, type Factor, type Grade, type Period, type RaiseReview, type Verdict } from '../reports/api';
import { Kpi, NotBuilt, PeriodPicker, ReportStatusLine, Spark, monthYear, weekLabel } from '../reports/ui';

type SortKey = 'name' | 'visits' | 'hours_per_week' | 'hours_filled' | 'on_time' | 'happy' | 'unhappy' | 'keeps' | 'reliability' | 'revenue' | 'earned' | 'raise';
const COLS: [SortKey, string][] = [['name', 'Cleaner'], ['raise', 'Raise'], ['visits', 'Visits'], ['hours_per_week', 'Hours / wk'], ['hours_filled', 'Hours filled'], ['on_time', 'On time'], ['happy', 'Happy'], ['unhappy', 'Unhappy'], ['keeps', 'Keeps clients'], ['reliability', 'Reliability'], ['revenue', 'Revenue'], ['earned', 'Earned']];
const ADMIN_COLS: SortKey[] = ['earned', 'raise'];

const sortValue = (r: CleanerRow, k: SortKey): number | string | null => {
  if (k === 'reliability') return r.reliability.issues + (r.reliability.no_shows ? 100 : 0);
  if (k === 'raise') return r.raise?.rank ?? -1;
  return r[k as keyof CleanerRow] as number | string | null;
};

export const fullDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const shortDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const stars = (s: number | null, n: number | null) => (s == null || !n ? null : `${s.toFixed(2)}★ (${n})`);

export function VerdictPill({ verdict, label }: { verdict: Verdict; label: string }) {
  return <span className={`rep-verdict v-${verdict}`}>{label}</span>;
}

export function CleanerReportsPage() {
  const [period, setPeriod] = useState<Period>('13w');
  const [scope, setScope] = useState<'active' | 'new' | 'flagged' | 'raise' | 'all'>('active');
  const [area, setArea] = useState<string>('');
  const [sort, setSort] = useState<SortKey>('visits');
  const [dir, setDir] = useState(-1);
  const brand = useBrand();
  const q = useQuery({ queryKey: ['reports', 'cleaners', period, brand.locationIds], queryFn: () => reportsApi.cleaners(period, brand.locationIds), retry: false, placeholderData: (p) => p });
  const r = q.data;
  const areas = useMemo(() => [...new Set((r?.rows || []).map((x) => x.area).filter(Boolean) as string[])].sort(), [r]);
  const rows = useMemo(() => {
    const list = (r?.rows || []).filter((x) => (scope === 'all' ? true : scope === 'new' ? x.is_new : scope === 'flagged' ? x.flags.length > 0 && x.assignable : scope === 'raise' ? x.raise?.verdict === 'ready' : x.assignable) && (!area || x.area === area));
    return list.sort((a, b) => {
      const av = sortValue(a, sort);
      const bv = sortValue(b, sort);
      if (typeof av === 'string' || typeof bv === 'string') return String(av).localeCompare(String(bv)) * dir;
      return ((av ?? -1) - (bv ?? -1)) * dir;
    });
  }, [r, scope, area, sort, dir]);
  const flagged = (r?.rows || []).filter((x) => x.assignable && x.flags.length).slice(0, 9);
  const cols = COLS.filter(([k]) => !ADMIN_COLS.includes(k) || r?.admin);
  const scopes = ([['active', 'Taking bookings'], ['new', 'New hires'], ['flagged', 'Has a flag'], ['raise', 'Raise ready'], ['all', 'Everyone with visits']] as const).filter(([k]) => k !== 'raise' || r?.admin);
  const logStart = r ? fullDate(r.change_log_start) : '';
  return (
    <div className="seg-page">
      <header className="page-header">
        <div className="seg-head">
          <span className="small muted">Reports</span>
          <h1>Cleaner reports{brand.view !== 'both' && <span className="muted"> · {brandLabel(brand.view)}</span>}</h1>
          <p className="muted">How each cleaner is doing: time, quality, reliability, keeping clients.{r?.admin ? ' Pay and raise readiness are shown to admins only.' : ''}</p>
          <ReportStatusLine />
        </div>
        <PeriodPicker value={period} onChange={setPeriod} />
      </header>
      {q.isError && <NotBuilt message={(q.error as Error).message} />}
      {r && (
        <>
          <div className="seg-stats">
            <Kpi label="Typical cleaner" value={`${r.team.median_visits ?? '—'} visits`} note={`in this period (busiest: ${r.team.max_visits})`} />
            <Kpi label="On time, team" value={pct(r.team.on_time, 1)} note={`${r.team.check_ins} check-ins`} />
            <Kpi label="Happy ratings, team" value={pct(r.team.happy)} note={`only ${pct(r.team.rated_share, 1)} of visits get rated`} />
            <Kpi label="Flagged" value={`${r.team.flagged} cleaner${r.team.flagged === 1 ? '' : 's'}`} note="worth a conversation" tone={r.team.flagged ? 'warn' : undefined} />
            {r.admin && <Kpi label="Raise ready" value={`${r.team.raise_ready ?? 0} cleaner${r.team.raise_ready === 1 ? '' : 's'}`} note="last 13 weeks, whatever the period" />}
            {r.admin && <Kpi label="Paid to cleaners" value={money(r.team.earned)} note={`on ${money(r.team.revenue)} revenue`} />}
          </div>

          {flagged.length > 0 && (
            <section className="card rep-card">
              <h2>Needs attention</h2>
              <div className="rep-flags">
                {flagged.map((c) => (
                  <Link key={c.id} to={`/reports/cleaners/${c.id}`} className="rep-flag">
                    <b>{c.name}</b>
                    {c.flags.map((f) => <span key={f.kind} className="small"><b className="warn">{f.label}:</b> {f.detail}</span>)}
                  </Link>
                ))}
              </div>
              {r.team.runs_long_median != null && <span className="muted small">"Runs long" is only flagged well above the team: the typical cleaner runs 15%+ over on {pct(r.team.runs_long_median)} of visits. If that's high for everyone, booked times are too short.</span>}
            </section>
          )}

          <div className="sch-bar">
            <div className="seg-filter">
              {scopes.map(([k, l]) => (
                <button key={k} className={scope === k ? 'chip-btn active' : 'chip-btn'} onClick={() => setScope(k)}>{l}</button>
              ))}
            </div>
            <label className="rep-area"><span className="sr-only">Area</span>
              <select value={area} onChange={(e) => setArea(e.target.value)}><option value="">All areas</option>{areas.map((a) => <option key={a} value={a}>{a}</option>)}</select>
            </label>
          </div>

          <section className="card flush">
            <div className="seg-table-head"><h2>Scorecard</h2><span className="muted small">{rows.length} cleaners · click a column to sort, a name for their report</span></div>
            <div className="table-scroll">
              <table className="seg-table rep-score">
                <thead>
                  <tr>
                    {cols.map(([k, l]) => (
                      <th key={k} className={k === 'name' ? '' : 'num'}>
                        <button className="rep-sort" onClick={() => { setDir(sort === k ? -dir : k === 'name' ? 1 : -1); setSort(k); }}>{l}{sort === k ? (dir < 0 ? ' ↓' : ' ↑') : ''}</button>
                        {k === 'raise' && <span className="rep-th-note">13 weeks</span>}
                        {k === 'reliability' && <span className="rep-th-note">issues</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <div className="sch-who">
                          <span className="sch-dot" style={{ background: c.color }} aria-hidden="true" />
                          <div>
                            <Link to={`/reports/cleaners/${c.id}`} className="seg-name">{c.name}</Link>
                            <div className="muted small">{[c.assignable ? (c.is_new ? 'New hire' : 'Active') : c.status_label, c.area, c.hours_type].filter(Boolean).join(' · ')}{c.flags.length ? ` · ${c.flags.length} flag${c.flags.length === 1 ? '' : 's'}` : ''}</div>
                          </div>
                        </div>
                      </td>
                      {r.admin && <td className="num">{c.raise ? <VerdictPill verdict={c.raise.verdict} label={c.raise.label} /> : '—'}</td>}
                      <td className="num">{c.visits}</td>
                      <td className="num">{c.hours_per_week ?? '—'}</td>
                      <td className={`num${c.hours_filled != null && c.hours_filled < 0.5 ? ' warn' : ''}`}>{pct(c.hours_filled)}</td>
                      <td className={`num${c.on_time != null && c.on_time < 0.9 ? ' warn' : ''}`}>{pct(c.on_time)}</td>
                      <td className="num">
                        {pct(c.happy)} <span className="muted small">of {c.rated}</span>
                        {stars(c.stars, c.ratings_count) && <div className="muted small" title="Launch27 star rating (all time)">{stars(c.stars, c.ratings_count)}</div>}
                      </td>
                      <td className={`num${c.unhappy >= 2 ? ' warn' : ''}`}>{c.unhappy}</td>
                      <td className={`num${c.keeps != null && c.keeps < 0.6 ? ' warn' : ''}`}>{c.clients_started ? pct(c.keeps) : '—'}</td>
                      <td className={`num${c.reliability.no_shows ? ' rep-bad' : c.reliability.issues ? ' warn' : ''}`} title={reliabilityTitle(c)}>
                        {c.reliability.issues}{c.reliability.no_shows ? <span className="small"> · {c.reliability.no_shows} no-show</span> : null}
                      </td>
                      <td className="num mono">{money(c.revenue)}</td>
                      {r.admin && <td className="num mono">{money(c.earned)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small sch-pad">
              Keeps clients = of the recurring clients they were the usual cleaner for at the start, how many still are. On time = checked in within the arrival window (+5 min); homemaking visits within 10 min of the start.
              {' '}Reliability = no-shows, cleaner cancellations under 72 h and missing check-ins/outs in the period; drops are counted from {logStart} (when this app started keeping the change log).
              {r.admin && ' Raise always uses the last 13 weeks, whatever period is picked above.'}
            </p>
          </section>
        </>
      )}
    </div>
  );
}

function reliabilityTitle(c: CleanerRow) {
  const r = c.reliability;
  if (r.no_shows == null) return `${r.missing_checks} missing check-ins/outs. Drops: not recorded for this period.`;
  return `${r.no_shows} no-shows, ${r.last_minute} last-minute, ${r.short_notice} short-notice, ${r.missing_checks} missing check-ins/outs${r.partial ? ` (drops since ${r.covers_from})` : ''}${r.uncoded ? `. ${r.uncoded} drop${r.uncoded === 1 ? '' : 's'} still need a reason.` : ''}`;
}

const GRADE_ICON: Record<Grade, string> = { ready: '✓', watch: '△', not_yet: '✗', neutral: '·' };
const ANCHOR: Record<string, string> = { ratings: '#ratings', 'time-tracking': '#timing', reliability: '#reliability', inbox: '#complaints' };

function rateLine(r: RaiseReview) {
  const rate = r.rate;
  if (!rate) return 'Rate not known';
  const cur = `Current rate $${rate.current.toFixed(2)}`;
  if (rate.previous != null && rate.changed_on) return `${cur} · last change $${rate.previous.toFixed(2)} → $${rate.current.toFixed(2)}, ${monthYear(rate.changed_on)}`;
  return `${cur} · since ${monthYear(rate.since)} · no change in the last 12 months`;
}

function FactorRow({ f }: { f: Factor }) {
  const label = f.key === 'rating' ? (f.uses === 'stars' ? 'L27 stars' : 'Rating') : f.label;
  const body = (
    <>
      <span className={`rep-grade g-${f.grade}`} aria-label={f.grade.replace('_', ' ')}>{GRADE_ICON[f.grade]}</span>
      <span><b>{label}</b> {f.value}{f.key === 'rating' && f.other ? <span className="muted small"> · other system: {f.other}</span> : null}</span>
    </>
  );
  const href = f.link ? ANCHOR[f.link] : null;
  return href ? <a className="rep-factor" href={href}>{body}</a> : <div className="rep-factor">{body}</div>;
}

function RaisePanel({ r, name }: { r: RaiseReview; name: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(r.summary);
      setCopied('Copied. Paste it in Slack.');
    } catch {
      setCopied('Your browser blocked the clipboard. Select the text below and copy it.');
    }
  };
  const order: Grade[] = ['ready', 'watch', 'not_yet', 'neutral'];
  const factors = [...r.factors].filter((f) => !(f.key === 'google' && f.grade === 'neutral' && f.value === '0')).sort((a, b) => order.indexOf(a.grade) - order.indexOf(b.grade));
  return (
    <section className={`card rep-raise v-${r.verdict}`} aria-label="Raise review">
      <div className="rep-raise-top">
        <h2>Raise review · <VerdictPill verdict={r.verdict} label={r.verdict === 'thin' ? 'Not enough data' : r.label} /></h2>
        <span className="muted small">13 weeks · {shortDate(r.from)} – {shortDate(r.to)} · admins only</span>
      </div>
      <div className="rep-raise-top">
        <span>{rateLine(r)}</span>
        {r.margin != null && <span>Margin on their visits <b>{pct(r.margin)}</b></span>}
      </div>
      {r.verdict === 'ladder' && r.ladder && <p className="rep-raise-note">Employee: on the ladder as <b>{r.ladder.role}</b>. {r.ladder.next ? <>Next step: <b>{r.ladder.next}</b>. </> : 'Top of the ladder. '}The factors below say whether they're ready for it. (Underlying: {r.underlying.replace('_', ' ')}.)</p>}
      {r.verdict === 'ceiling' && <p className="rep-raise-note">Already at the $25 ceiling, so there's no $ raise to decide. (Underlying: {r.underlying.replace('_', ' ')}.)</p>}
      {r.verdict === 'thin' && <p className="rep-raise-note">No verdict on thin data: {r.thin_reason}.</p>}
      {r.gates.length > 0 && <p className="rep-raise-note rep-bad">Blocked by {r.gates.join(' and ')}: reliability is the gate, whatever the ratings say.</p>}
      <div className="rep-factors">{factors.map((f) => <FactorRow key={f.key} f={f} />)}</div>
      {r.thin_ratings && <p className="muted small">Fewer than 1 in 5 visits get rated, so the rating can't carry a Ready on its own: it's left out when counting Ready factors ({r.ready_count} counted).</p>}
      {r.to_ready.length > 0 && !['ceiling'].includes(r.verdict) && <p><b>What would get to Ready:</b> {r.to_ready.join('; ')}.</p>}
      <div className="rep-raise-foot">
        <span>{r.re_review ? <>Re-review: <b>{fullDate(r.re_review)}</b></> : r.underlying === 'ready' ? 'Ready now: raise it with Kimmy for payroll.' : ''}</span>
        <button className="secondary" onClick={copy}>Copy summary for Slack</button>
      </div>
      {copied && <div className="small" role="status">{copied}</div>}
      {copied?.startsWith('Your browser') && <textarea className="rep-summary" readOnly value={r.summary} rows={4} aria-label={`Raise summary for ${name}`} />}
    </section>
  );
}

function ReliabilityCard({ r }: { r: CleanerReport }) {
  const rel = r.reliability;
  const [all, setAll] = useState(false);
  const shown = rel.incidents.filter((i) => all || i.kind !== 'late');
  const n = (x: number | null) => (x == null ? '—' : String(x));
  return (
    <section className="card rep-card" id="reliability">
      <h2>Reliability <span className="muted small">· every visit, not a sample</span></h2>
      <div className="rep-rel-counts">
        <div className={rel.no_shows ? 'rep-bad' : ''}><span className="muted small">No-shows</span><b>{n(rel.no_shows)}</b></div>
        <div><span className="muted small">Last-minute (&lt; 24 h)</span><b>{n(rel.last_minute)}</b></div>
        <div><span className="muted small">Short notice (24–72 h)</span><b>{n(rel.short_notice)}</b></div>
        <div><span className="muted small">Missing check-in/out</span><b>{rel.missing_checks}</b></div>
        <div><span className="muted small">Late arrivals</span><b>{rel.late}</b></div>
        <div><span className="muted small">Sick days</span><b>{n(rel.sick_days)}</b></div>
      </div>
      {rel.pattern && <p className="rep-raise-note rep-bad">Pattern: {rel.pattern}. Penalised even with notice.</p>}
      {rel.uncoded ? <p className="small warn">{rel.uncoded} time{rel.uncoded === 1 ? '' : 's'} taken off a visit without a reason yet. Pick one on the Changes card in Scheduling; until then it doesn't count either way.</p> : null}
      <div className="rep-strip" role="img" aria-label="Drops per week">
        {rel.weeks.map((w) => (
          <span key={w.week} className={`rep-wk${w.drops == null ? ' none' : w.drops ? ' bad' : ''}`} title={`Week of ${shortDate(w.week)}: ${w.drops == null ? 'drops not recorded (before the change log)' : `${w.drops} drop${w.drops === 1 ? '' : 's'}`}, ${w.missing} missing check-in/out`}>{w.drops == null ? '—' : w.drops || ''}</span>
        ))}
      </div>
      <span className="muted small">Weeks before {fullDate(r.change_log_start)} show "—": Launch27 hides cancelled bookings, so drops are only known from when this app started keeping its own change log. Only cleaner-initiated reasons count; a one-off sick day with notice isn't penalised.</span>
      <table className="rep-mini">
        <thead><tr><th>Date</th><th>Client</th><th>What</th><th>Reason</th></tr></thead>
        <tbody>
          {shown.slice(0, 60).map((i, k) => (
            <tr key={k} className={i.counted ? '' : 'muted'}>
              <td>{shortDate(i.date)}</td>
              <td>{i.customer || '—'}</td>
              <td>{i.label}{i.lead_hours != null && ['last_minute', 'short_notice', 'notice', 'uncoded', 'not_cleaner'].includes(i.kind) ? <span className="muted small"> · {i.lead_hours} h notice</span> : null}</td>
              <td>{i.reason || '—'}{i.note ? <span className="muted small"> · {i.note}</span> : null}</td>
            </tr>
          ))}
          {shown.length === 0 && <tr><td colSpan={4} className="muted">Nothing in this period.</td></tr>}
        </tbody>
      </table>
      {rel.late > 0 && <button className="link small" onClick={() => setAll(!all)}>{all ? 'Hide late arrivals' : `Show ${rel.late} late arrival${rel.late === 1 ? '' : 's'} too`}</button>}
    </section>
  );
}

function ReviewsCard({ r }: { r: CleanerReport }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ review_date: new Date().toISOString().slice(0, 10), reviewer: '', link: '', bonus_paid: false });
  const done = () => qc.invalidateQueries({ queryKey: ['reports'] });
  const add = useMutation({ mutationFn: () => reportsApi.addReview(r.cleaner.id, { ...form, link: form.link || null }), onSuccess: () => { setOpen(false); setForm({ ...form, reviewer: '', link: '' }); done(); } });
  const bonus = useMutation({ mutationFn: ({ id, paid }: { id: number; paid: boolean }) => reportsApi.updateReview(id, { bonus_paid: paid }), onSuccess: done });
  const del = useMutation({ mutationFn: (id: number) => reportsApi.deleteReview(id), onSuccess: done });
  return (
    <section className="card rep-card" id="reviews">
      <h2>Google reviews naming them</h2>
      {r.google_reviews.map((g) => (
        <div key={g.id} className="rep-drive">
          <span>{shortDate(g.date)} · {g.link ? <a href={g.link} target="_blank" rel="noreferrer">{g.reviewer}</a> : g.reviewer}</span>
          <span className="small">
            {r.admin ? <label><input type="checkbox" checked={g.bonus_paid} onChange={(e) => bonus.mutate({ id: g.id, paid: e.target.checked })} /> $10 bonus paid</label> : g.bonus_paid ? 'Bonus paid' : null}
            {r.admin && <button className="link small danger-link" onClick={() => del.mutate(g.id)}>Remove</button>}
          </span>
        </div>
      ))}
      {r.google_reviews.length === 0 && <p className="muted small">None recorded yet.</p>}
      {open ? (
        <form className="rep-review-form" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <label>Date<input type="date" required value={form.review_date} onChange={(e) => setForm({ ...form, review_date: e.target.value })} /></label>
          <label>Reviewer<input required value={form.reviewer} onChange={(e) => setForm({ ...form, reviewer: e.target.value })} /></label>
          <label>Link<input type="url" placeholder="https://" value={form.link} onChange={(e) => setForm({ ...form, link: e.target.value })} /></label>
          <label className="rep-check"><input type="checkbox" checked={form.bonus_paid} onChange={(e) => setForm({ ...form, bonus_paid: e.target.checked })} /> $10 bonus paid</label>
          <div className="rep-head-actions"><button type="submit" disabled={add.isPending}>Add review</button><button type="button" className="secondary" onClick={() => setOpen(false)}>Cancel</button></div>
          {add.isError && <span className="error small">{(add.error as Error).message}</span>}
        </form>
      ) : (
        <button className="secondary" onClick={() => setOpen(true)}>Add Google review</button>
      )}
    </section>
  );
}

export function CleanerReportPage() {
  const { id } = useParams();
  const [period, setPeriod] = useState<Period>('13w');
  const q = useQuery({ queryKey: ['reports', 'cleaner', id, period], queryFn: () => reportsApi.cleaner(Number(id), period), retry: false, placeholderData: (p) => p });
  const r = q.data;
  if (q.isError) return <NotBuilt message={(q.error as Error).message} />;
  if (!r) return <p className="muted">Loading…</p>;
  const s = r.stats;
  const c = r.cleaner;
  const initials = c.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('');
  const lateN = r.last40.filter((x) => x.late).length;
  const starText = stars(c.stars, c.ratings_count);
  return (
    <div className="seg-page">
      <nav className="small muted"><Link to="/reports/cleaners">Cleaner reports</Link> / {c.name}</nav>
      <section className="card rep-head">
        <div className="sch-who">
          <span className="rep-avatar" style={{ background: c.color }} aria-hidden="true">{initials}</span>
          <div>
            <h1>{c.name}</h1>
            <div className="rep-tags">
              <span className="seg-trait">{c.status_label}</span>
              {c.area && <span className="seg-trait">{c.area}</span>}
              {c.hours_type && <span className="seg-trait">{c.hours_type}</span>}
              {c.tags.slice(0, 6).map((t) => <span key={t} className={c.restrictive.some((x) => x.tag === t) ? 'seg-trait rep-restrict' : 'seg-trait'} title={c.restrictive.find((x) => x.tag === t)?.kind}>{t}</span>)}
              {c.start_date && <span className="seg-trait">{c.start_known ? `Started ${monthYear(c.start_date)}` : `Working since at least ${monthYear(c.start_date)}`}</span>}
            </div>
          </div>
        </div>
        <div className="rep-head-actions">
          <PeriodPicker value={period} onChange={setPeriod} />
          <Link className="button secondary-link" to={`/cleaners/${c.id}`}>Profile</Link>
          <Link className="button secondary-link" to={`/schedule/cleaner/${c.id}`}>Open plan</Link>
        </div>
      </section>
      {r.raise && <RaisePanel r={r.raise} name={c.name} />}
      {r.flags.length > 0 && (
        <div className="rep-note"><b className="warn">Worth a conversation:</b> {r.flags.map((f) => f.detail).join(' · ')}.</div>
      )}
      <div className="seg-stats">
        <div className="card seg-stat"><span className="muted small">Visits</span><span className="seg-stat-value">{s.visits}</span><Spark values={(() => { const m = Math.max(...r.series.map((w) => w.visits), 1); return r.series.map((w) => w.visits / m); })()} /><span className="small">{s.hours_per_week ?? '—'} hours a week</span></div>
        <div className="card seg-stat"><span className="muted small">Hours filled</span><span className="seg-stat-value">{pct(s.hours_filled)}</span><span className="small">{s.booked_next4 != null ? `${s.booked_next4}h of ${s.capacity_next4}h a week, next 4 weeks` : 'not in the planner'}</span></div>
        <div className="card seg-stat"><span className="muted small">On time</span><span className={s.on_time != null && s.on_time < 0.9 ? 'seg-stat-value rep-warn' : 'seg-stat-value'}>{pct(s.on_time)}</span><Spark values={r.series.map((w) => w.on_time)} warn={s.on_time != null && s.on_time < 0.9} /><span className="small">{s.late_avg ? `late ones by ${s.late_avg} min` : 'no late check-ins'}</span></div>
        <div className="card seg-stat"><span className="muted small">Happy ratings</span><span className="seg-stat-value">{pct(s.happy)}</span><Spark values={r.series.map((w) => w.happy)} /><span className="small">{s.rated} rated · {s.unhappy} unhappy{starText ? <><br />Launch27 stars: {starText}</> : null}</span></div>
        <div className="card seg-stat"><span className="muted small">Finished early</span><span className={s.finished_early != null && s.finished_early > 0.2 ? 'seg-stat-value rep-warn' : 'seg-stat-value'}>{s.residential ? pct(s.finished_early) : '—'}</span><span className="small">{s.residential ? `${s.early_n} of ${s.residential} residential cleans, 30+ min under` : 'no residential solo cleans'}</span></div>
        <div className="card seg-stat"><span className="muted small">Keeps clients</span><span className="seg-stat-value">{s.clients_started ? pct(s.keeps) : '—'}</span><span className="small">{s.clients_started ? `of ${s.clients_started} regular clients` : 'no regular clients at the start'}</span></div>
        <div className="card seg-stat"><span className="muted small">Drive per visit</span><span className="seg-stat-value">{s.km_per_visit == null ? '—' : `${s.km_per_visit} km`}</span><span className="small">taps en route on {pct(s.enroute)} of visits</span></div>
      </div>
      <p className="muted small">Two rating systems: Happy % is this app's count of 😊/😐/☹ ratings in the period; Launch27 stars are all-time, as on Teams. They can disagree. The raise verdict uses whichever is better and says which.</p>

      <div className="seg-two">
        <ReliabilityCard r={r} />
        <div className="rep-side">
          <section className="card rep-card" id="complaints">
            <h2>Complaints and re-cleans</h2>
            {r.complaints.map((x) => (
              <div key={x.id} className="rep-drive">
                <Link to={`/inbox/${x.id}`}>{shortDate(x.date)} · {x.subject || `Conversation #${x.id}`}</Link>
                <span className="small">{x.outcome || 'pending'}{x.status ? ` · ${x.status}` : ''}</span>
              </div>
            ))}
            {r.complaints.length === 0 && <p className="muted small">None in this period.</p>}
            <span className="muted small">From Inbox conversations marked as a complaint with this cleaner set. Set the Cleaner on a conversation to have it count here.</span>
          </section>
          <ReviewsCard r={r} />
        </div>
      </div>

      <div className="seg-two">
        <section className="card flush">
          <div className="seg-table-head"><h2>Regular clients</h2><span className="muted small">{c.name.split(' ')[0]} is their usual cleaner</span></div>
          <div className="table-scroll">
            <table className="seg-table">
              <thead><tr><th>Client</th><th>Rhythm</th><th>Together since</th><th>Last rating</th></tr></thead>
              <tbody>
                {r.clients.map((x) => (
                  <tr key={x.customer_id}>
                    <td>{x.customer_id > 0 ? <Link to={`/customers/${x.customer_id}`} className="seg-name">{x.customer}</Link> : <b>{x.customer}</b>}</td>
                    <td className="small">{x.rhythm}</td>
                    <td className="small">{x.since ? monthYear(x.since) : '—'} · {x.cleans} cleans</td>
                    <td className="small">{x.last_rating ? <span className={x.last_rating.r === 0 ? 'warn' : x.last_rating.r === 2 ? 'ok' : ''}>{x.last_rating.r === 2 ? 'Happy' : x.last_rating.r === 0 ? 'Unhappy' : 'OK'}{x.last_rating.comment ? ` · "${x.last_rating.comment}"` : ''}</span> : <span className="muted">Not rated</span>}</td>
                  </tr>
                ))}
                {r.clients.length === 0 && <tr><td colSpan={4} className="muted seg-none-row">No regular clients right now.</td></tr>}
              </tbody>
            </table>
          </div>
          {r.lost.length > 0 && <p className="small sch-pad">Moved away in this period: <b>{r.lost.length}</b> ({r.lost.filter((l) => l.to).length} to another cleaner, {r.lost.filter((l) => l.stopped).length} stopped booking).</p>}
        </section>
        <div className="rep-side">
          <section className="card rep-card" id="ratings">
            <h2>Recent ratings</h2>
            {r.ratings.map((x, i) => (
              <div key={i} className="rep-rating"><span className={x.r === 0 ? 'warn' : x.r === 2 ? 'ok' : ''}><b>{x.r === 2 ? 'Happy' : x.r === 0 ? 'Unhappy' : 'OK'}</b> · {weekLabel(x.date)} · {x.customer}</span>{x.comment && <span className="small">"{x.comment}"</span>}</div>
            ))}
            {r.ratings.length === 0 && <p className="muted small">No ratings yet.</p>}
          </section>
          {r.admin && (
            <section className="card rep-card">
              <h2>Pay <span className="muted small">· admins only</span></h2>
              <div className="rep-pair">
                <div><span className="muted small">Earned this period</span><b>{money(s.earned)}</b></div>
                <div><span className="muted small">Per hour on site</span><b>{s.per_hour != null ? `$${s.per_hour}` : '—'}</b></div>
              </div>
              <span className="muted small">From Launch27's team payments on each booking.{s.margin != null ? ` Margin on their visits (homemaking left out): ${pct(s.margin)}.` : ''}</span>
            </section>
          )}
        </div>
      </div>

      <section className="card rep-card" id="timing">
        <h2>Punctuality and timing, last {r.last40.length} visits</h2>
        <div className="rep-strip" role="img" aria-label={`Last ${r.last40.length} visits: ${lateN} late, ${r.last40.filter((x) => x.long).length} ran 15% or more over booked time, ${r.last40.filter((x) => x.early).length} finished 30+ min early`}>
          {r.last40.map((x, i) => <span key={i} className={`rep-cell${x.late ? ' late' : ''}${x.long ? ' long' : ''}${x.early ? ' early' : ''}`} title={`${weekLabel(x.date)} · ${x.customer}${x.late ? ` · ${x.late} min late` : ' · on time'}${x.long ? ' · ran long' : ''}${x.early ? ' · finished early' : ''}`} />)}
        </div>
        <div className="sch-legend rep-legend">
          <span><i className="rep-cell" />On time</span>
          <span><i className="rep-cell late" />Late</span>
          <span><i className="rep-cell long" />Ran 15%+ over booked time</span>
          <span><i className="rep-cell early" />Finished 30+ min early</span>
        </div>
        {r.team.runs_long_median != null && <span className="muted small">Running long is neutral for raises (thorough). The team runs long on {pct(r.team.runs_long_median)} of visits; finishing early on residential cleans is the quality risk.</span>}
        {r.finished_early.length > 0 && (
          <details>
            <summary className="small">Finished early in this period ({r.finished_early.length})</summary>
            <table className="rep-mini">
              <thead><tr><th>Date</th><th>Client</th><th className="num">Under booked</th></tr></thead>
              <tbody>{r.finished_early.map((x) => <tr key={x.visit_id}><td>{shortDate(x.date)}</td><td>{x.customer}</td><td className="num">{x.short_min} min</td></tr>)}</tbody>
            </table>
          </details>
        )}
        <Link className="small" to="/time-tracking">Open Time tracking</Link>
      </section>
    </div>
  );
}
