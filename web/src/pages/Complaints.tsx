// Complaint playbook (Phase 1 of the Complaint Resolution Engine, Residential only).
// Playbook: what complaints we get, what we did, what kept clients and at what cost.
// Cases: every mined case with its journey, resolution, cost and outcome.
// Rules: the ladder, who approves what, the refund budget and cost assumptions.
// Open to everyone with a staff login; running updates and changing rules are admin only.
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useInboxMe } from '../inbox/util';
import { complaintsApi, CAUSE_BY_LABEL, ENDING_LABEL, OFFER_LABEL, RESPONSE_LABEL, OUTCOME_LABEL, RUNG_NAME, SOURCE_LABEL, TONE_LABEL, whatWeDid, type CaseRow, type CauseTally, type ClientRow, type Codebook, type ReviewItem, type ReviewTally, type Confidence, type ExcludedReason, type OutcomeStats, type Playbook, type Settings, type Status } from '../complaints/api';
import { Kpi } from '../reports/ui';
import { money, pct } from '../reports/api';

const CATEGORY_LABEL: Record<string, string> = {
  quality_missed: 'Quality: missed areas',
  quality_rushed: 'Quality: rushed / short time',
  punctuality: 'Late / no-show',
  cleaner_change: 'Cleaner change / consistency',
  scope_booking: 'Scope / booking error',
  communication: 'Communication',
  pricing_billing: 'Pricing / billing',
  property_condition: 'Property condition',
  damage: 'Damage / breakage',
  missing_item: 'Missing item / theft',
  conduct_safety: 'Cleaner conduct / safety',
  other: 'Other / unclear',
};
const catLabel = (k: string) => CATEGORY_LABEL[k] || k;
// Root causes (why it happened) come from the server's codebook, so the labels, definitions and
// "not this when" lines people check against live in one place.
function useCodebook() {
  return useQuery({ queryKey: ['complaints', 'codebook'], queryFn: complaintsApi.codebook, staleTime: Infinity, retry: false }).data;
}
const causeName = (cb: Codebook | undefined, k: string | null | undefined) => (!k ? 'Not set' : k === 'other' ? 'Other / not on the list' : k === 'unset' ? 'Not set yet' : cb?.causes.find((c) => c.key === k)?.label || k);
function CauseOptions({ cb, exclude = [] }: { cb: Codebook; exclude?: string[] }) {
  return (
    <>
      {cb.groups.map((g) => (
        <optgroup key={g.key} label={g.label}>
          {cb.causes.filter((c) => c.group === g.key && !exclude.includes(c.key)).map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </optgroup>
      ))}
    </>
  );
}
const conf = (c: Confidence, n: number) => <span className={`pill ${c === 'thin' || c === 'none' ? 'late' : ''}`} title={`${n} cases with a 60-day outcome`}>{c === 'none' ? 'no data' : `${c} · n=${n}`}</span>;
const day = (s: string | null) => (s ? new Date(s).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');

// Viewing and mining are separate. Viewing reads what's already stored for any date range,
// instantly. Mining ("Update from sources") reads Kustomer, Slack, info@ and Launch27 for the
// range shown, at most about 3 months at a time so a run stays around 10–15 minutes.
interface Period { from: string; to: string; days: number | null }
const QUICK_DAYS = [7, 14, 30, 60, 90, 180, 365];
const MAX_RUN_DAYS = 93;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDay(d);
};
const spanDays = (p: { from: string; to: string }) => Math.round((Date.parse(p.to) - Date.parse(p.from)) / 86_400_000) + 1;
const lastDays = (n: number, end: string): Period => ({ from: addDays(end, -(n - 1)), to: end, days: n });

export function ComplaintsPage() {
  const me = useInboxMe();
  const [tab, setTab] = useState<'playbook' | 'cases' | 'clients' | 'check' | 'rules'>('playbook');
  const [chosen, setChosen] = useState<Period | null>(null);
  const status = useQuery({ queryKey: ['complaints', 'status'], queryFn: complaintsApi.status, refetchInterval: (q) => (q.state.data?.running ? 5000 : false), retry: false });
  const isAdmin = me.data?.role === 'admin';
  const period = chosen || (status.data ? lastDays(90, status.data.window.to) : null);
  if (status.isError) {
    return (
      <div className="seg-page">
        <section className="card seg-empty">
          <h2>Complaint playbook isn't available</h2>
          <p className="muted">{(status.error as Error).message}.</p>
        </section>
      </div>
    );
  }
  return (
    <div className="seg-page">
      <header className="page-header">
        <div className="seg-head">
          <span className="small muted">Support · Residential</span>
          <h1>Complaint playbook</h1>
          <p className="muted">What our complaints are, what we did, and what actually kept clients at what cost. Phase 1: learning from history. Nothing here sends anything.</p>
        </div>
      </header>
      {status.data && period && <RunBar status={status.data} isAdmin={isAdmin} period={period} onPeriod={setChosen} />}
      <div className="tabs" role="tablist">
        {(['playbook', 'cases', 'clients', 'check', 'rules'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t === 'playbook' ? 'Playbook' : t === 'cases' ? 'Cases' : t === 'clients' ? 'Clients' : t === 'check' ? 'Check accuracy' : 'Rules & budget'}
          </button>
        ))}
      </div>
      {tab === 'playbook' && period && <PlaybookTab period={period} isAdmin={isAdmin} />}
      {tab === 'cases' && period && <CasesTab period={period} />}
      {tab === 'clients' && <ClientsTab />}
      {tab === 'check' && <CheckTab />}
      {tab === 'rules' && <RulesTab canEdit={isAdmin} />}
    </div>
  );
}

const RUN_LABEL: Record<string, { text: string; cls: string }> = {
  running: { text: 'Running', cls: '' },
  done: { text: 'Finished', cls: 'ok' },
  partial: { text: 'Finished with problems', cls: 'warn' },
  failed: { text: 'Failed', cls: 'neg' },
  interrupted: { text: 'Interrupted (the app restarted): run again for the rest', cls: 'warn' },
};
const clock = (s: string) => new Date(s).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });

function RunBar({ status, isAdmin, period, onPeriod }: { status: Status; isAdmin: boolean; period: Period; onPeriod: (p: Period) => void }) {
  const qc = useQueryClient();
  const run = useMutation({ mutationFn: () => complaintsApi.run({ from: period.from, to: period.to }), onSuccess: () => qc.invalidateQueries({ queryKey: ['complaints'] }) });
  const last = status.last_run;
  useEffect(() => {
    if (!status.running) qc.invalidateQueries({ queryKey: ['complaints', 'playbook'] });
  }, [status.running, qc]);
  const state = status.running ? 'running' : last?.status || null;
  const problems = (last?.log || []).filter((l) => l.level === 'error' || l.level === 'warn');
  const latest = last?.log?.[last.log.length - 1];
  const end = status.window.to;
  const tooLong = spanDays(period) > MAX_RUN_DAYS;
  // Is every day of the range shown inside a period that has been mined?
  const covered = (() => {
    let day0 = period.from;
    for (const m of [...status.mined].sort((a, b) => a.window_from.localeCompare(b.window_from))) {
      const f = m.window_from.slice(0, 10);
      const t = m.window_to.slice(0, 10);
      if (f <= day0 && t >= day0) day0 = addDays(t, 1);
    }
    return day0 > period.to;
  })();
  const setDate = (k: 'from' | 'to', v: string) => {
    if (!v) return;
    const next = { ...period, [k]: v, days: null };
    if (next.from <= next.to) onPeriod(next);
  };
  return (
    <section className="card">
      <div className="cmp-runbar">
        <div className="cmp-period">
          <div className="tabs inline" role="group" aria-label="Show the last">
            {QUICK_DAYS.map((n) => (
              <button key={n} className={`chip-btn ${period.days === n ? 'active' : ''}`} aria-pressed={period.days === n} onClick={() => onPeriod(lastDays(n, end))}>{n === 180 ? '6 months' : n === 365 ? '12 months' : `${n} days`}</button>
            ))}
          </div>
          <label className="cmp-date">From<input type="date" value={period.from} max={period.to} onChange={(e) => setDate('from', e.target.value)} /></label>
          <label className="cmp-date">To<input type="date" value={period.to} min={period.from} max={end} onChange={(e) => setDate('to', e.target.value)} /></label>
        </div>
        {isAdmin && (
          <button className="secondary" disabled={status.running || run.isPending || tooLong} title={tooLong ? 'Updates read at most about 3 months at a time. Pick 90 days or less, or set the dates to a 3-month block.' : 'Read Kustomer, Slack, info@ and Launch27 for the dates shown'} onClick={() => run.mutate()}>
            {status.running || run.isPending ? 'Updating…' : 'Update these dates now'}
          </button>
        )}
      </div>
      <div className={`cmp-note ${status.auto.enabled ? 'ok' : ''}`}>
        {status.auto.enabled ? (
          <>
            <b>Updates itself every day.</b>{' '}
            {status.auto.overnight ? 'It runs overnight.' : 'It runs the first time a supervisor or admin opens this page each day (there is no overnight Launch27 login yet).'}{' '}
            {status.auto.last_daily_update ? `Last daily update: ${day(status.auto.last_daily_update)} ${clock(status.auto.last_daily_update)}.` : 'No daily update has finished yet.'}{' '}
            {status.auto.next?.kind === 'history' ? `Still reading history automatically: next ${day(status.auto.next.from)} – ${day(status.auto.next.to)}, then older months back to ${status.auto.history_months} months.` : status.auto.next ? "Today's update is about to start." : `History is read back ${status.auto.history_months} months. Nothing waiting.`}
          </>
        ) : (
          <><b>Automatic updates are off.</b> Turn them on in Rules &amp; budget, or update dates by hand.</>
        )}
      </div>
      <p className="muted small">
        Showing {day(period.from)} – {day(period.to)} from what's already stored.{' '}
        {status.mined.length === 0 ? 'Nothing has been read from the sources yet.' : covered ? 'All of these dates have been read from the sources.' : <span className="warn">Some of these dates haven't been read from the sources yet, so they may be missing complaints.</span>}
        {isAdmin && tooLong ? ' To read more history, set the dates to a 3-month block and update it.' : ''}
      </p>
      {status.mined.length > 0 && (
        <p className="muted small">Read so far: {status.mined.map((m) => `${day(m.window_from)} – ${day(m.window_to)}`).filter((x, i, a) => a.indexOf(x) === i).join(' · ')}</p>
      )}
      {run.isError && <p className="neg small">Couldn't start the run: {(run.error as Error).message}</p>}
      {state && last && (
        <div className={`cmp-runstate ${RUN_LABEL[state]?.cls || ''}`} role="status" aria-live="polite">
          <b>{RUN_LABEL[state]?.text || state}</b>
          {status.running ? (
            <span> · {day(last.window_from)} – {day(last.window_to)} · started {clock(last.started_at)}{latest ? ` · ${latest.msg}` : ' · starting…'} · about 10–15 minutes for 3 months</span>
          ) : (
            <span> · {day(last.window_from)} – {day(last.window_to)} · ran {day(last.started_at)} {clock(last.started_at)}{last.finished_at ? `–${clock(last.finished_at)}` : ''}</span>
          )}
        </div>
      )}
      {!status.running && problems.length > 0 && (
        <ul className="small cmp-problems">{problems.map((l, i) => <li key={i} className={l.level === 'error' ? 'neg' : 'warn'}>{l.msg}</li>)}</ul>
      )}
      <ul className="cmp-sources small">
        {Object.entries(status.sources).map(([k, v]) => (
          <li key={k}>
            <span className={`dot ${/connected|on|synthetic/.test(v) && !/not /.test(v) ? 'ok' : 'warn'}`} />
            <b>{k === 'claude' ? 'Claude classification' : k[0].toUpperCase() + k.slice(1)}</b>: {v}
          </li>
        ))}
      </ul>
      {last?.log?.length ? (
        <details className="small" open={status.running}>
          <summary>Run log ({last.log.length} steps)</summary>
          <ul>{last.log.map((l, i) => <li key={i} className={l.level === 'error' ? 'neg' : l.level === 'warn' ? 'warn' : ''}>{clock(l.at)} · {l.msg}</li>)}</ul>
        </details>
      ) : null}
    </section>
  );
}

// ---- Traceable numbers: every figure opens the exact cases behind it ----
type Drill = { title: string; ids: number[]; why?: Record<number, string> };
type Open = (d: Drill) => void;
const EXCLUDED_SHORT: Record<ExcludedReason, string> = { too_recent: 'not yet 60 days', one_time: 'one-time', unmatched: 'unmatched', no_outcome: 'no outcome' };
const ESCALATED_TIP = 'Escalated: damage over $100, theft or a missing item, safety, misconduct, legal or chargeback. These go to the Office Manager and are never handled on the normal ladder.';

function Num({ ids, title, open, why, children }: { ids: number[]; title: string; open: Open; why?: Record<number, string>; children: React.ReactNode }) {
  if (!ids.length) return <>{children}</>;
  return <button type="button" className="rep-num" title="Show these cases" onClick={() => open({ title, ids, why })}>{children}</button>;
}

function RateCell({ s, k, name, open }: { s: OutcomeStats; k: 'saved' | 'partial' | 'lost'; name: string; open: Open }) {
  if (!s.decided) return <td className="muted">—</td>;
  const word = k === 'saved' ? 'saved' : k === 'partial' ? 'partly saved' : 'lost';
  return (
    <td>
      <b>{pct(s[k])}</b>{' '}
      <span className="small muted cmp-nd"><Num ids={s[`${k}_ids`]} title={`${name}: ${word}`} open={open}>{s[`${k}_n`]}</Num> of <Num ids={s.decided_ids} title={`${name}: cases with a known outcome (decided)`} open={open}>{s.decided}</Num> decided</span>
    </td>
  );
}

function ExcludedCell({ s, name, labels, open }: { s: OutcomeStats; name: string; labels: Record<ExcludedReason, string>; open: Open }) {
  if (!s.excluded_n) return <td className="muted">0</td>;
  const parts = Object.entries(s.excluded) as [ExcludedReason, number[]][];
  const why: Record<number, string> = {};
  for (const [r, list] of parts) for (const id of list) why[id] = labels[r];
  return (
    <td className="small">
      <Num ids={parts.flatMap(([, l]) => l)} title={`${name}: not counted in saved / lost`} why={why} open={open}>{s.excluded_n}</Num>
      {': '}
      {parts.map(([r, list], i) => <span key={r}>{i ? ', ' : ''}<Num ids={list} title={`${name}: ${labels[r]}`} why={why} open={open}>{list.length} {EXCLUDED_SHORT[r]}</Num></span>)}
    </td>
  );
}

function CostCell({ s, name, open }: { s: OutcomeStats; name: string; open: Open }) {
  if (!s.n) return <td className="muted">—</td>;
  return (
    <td>
      {money(s.avg_cost)} <span className="small muted cmp-nd">all <Num ids={s.ids} title={`${name}: every case (total cost ${money(s.total_cost)})`} open={open}>{s.n}</Num></span>
      {s.decided > 0 && <span className="small muted cmp-nd"><br />{money(s.avg_cost_decided)} on the <Num ids={s.decided_ids} title={`${name}: decided cases`} open={open}>{s.decided}</Num> decided</span>}
    </td>
  );
}

function StatCells({ s, name, labels, open }: { s: OutcomeStats; name: string; labels: Record<ExcludedReason, string>; open: Open }) {
  return (
    <>
      <RateCell s={s} k="saved" name={name} open={open} />
      <td className="small">{s.lost_n ? <><Num ids={s.lost_no_review_ids} title={`${name}: left, no 1–2★ review`} open={open}>{s.lost_no_review_n}</Num> of {s.lost_n} lost{s.lost_with_review_n ? <> · <Num ids={s.lost_with_review_ids} title={`${name}: left and posted a 1–2★ review`} open={open}>{s.lost_with_review_n}</Num> with a 1–2★ review</> : null}</> : <span className="muted">—</span>}</td>
      <RateCell s={s} k="lost" name={name} open={open} />
      <ExcludedCell s={s} name={name} labels={labels} open={open} />
      <CostCell s={s} name={name} open={open} />
      <td>{conf(s.confidence, s.decided)}</td>
    </>
  );
}
const STAT_HEADS = (
  <>
    <th title="Still booking 60+ days after the complaint, not gone within 90 days, and no 1–2★ review, as a share of decided cases">Saved</th>
    <th title="Of the clients we lost, how many left without posting a 1–2★ review. Leaving is lost either way; this shows which responses at least prevented a bad review. Only reviews matched to the complaint are counted.">Left, no bad review</th>
    <th title="Left within 90 days of the complaint (no visit for a full normal gap), or posted a 1–2★ review, as a share of decided cases">Lost</th>
    <th title="Cases with no saved / lost verdict, and why">Not counted</th>
    <th title="Average cost over every case, then over the decided cases the rates use">Avg cost</th>
    <th>Confidence</th>
  </>
);

function csvOf(rows: CaseRow[], why: Record<number, string> | undefined, cb: Codebook | undefined) {
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Case', 'Opened', 'Client', 'Booking', 'Service date', 'Cleaner', 'Client type', 'Service', 'Category', 'Root cause', 'Also a factor', 'Escalated', 'Tone', 'What we did', 'Cost', 'Outcome', 'Source', 'Link', ...(why ? ['Why not counted'] : [])];
  const lines = rows.map((c) => [c.id, c.opened_at.slice(0, 10), c.customer_name, c.l27_booking_id, c.service_date?.slice(0, 10), c.cleaner_name, c.client_type, c.service, catLabel(c.category), c.cause ? causeName(cb, c.cause) : '', (c.contributing_causes || []).map((k) => causeName(cb, k)).join('; '), c.hard_route, c.tone, whatWeDid(c.rungs), Number(c.total_cost).toFixed(2), outcomeOf(c) ? OUTCOME_LABEL[outcomeOf(c) as string] : '', SOURCE_LABEL[c.source] || c.source, c.original_url, ...(why ? [why[c.id]] : [])].map(esc).join(','));
  return [head.map(esc).join(','), ...lines].join('\n');
}

function DrillDialog({ drill, cases, loading, onClose }: { drill: Drill; cases: CaseRow[]; loading: boolean; onClose: () => void }) {
  const [openCase, setOpenCase] = useState<number | null>(null);
  const cb = useCodebook();
  const rows = useMemo(() => {
    const want = new Set(drill.ids);
    return cases.filter((c) => want.has(c.id)).sort((a, b) => b.opened_at.localeCompare(a.opened_at));
  }, [drill, cases]);
  const total = rows.reduce((s, c) => s + Number(c.total_cost), 0);
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csvOf(rows, drill.why, cb)], { type: 'text/csv' }));
    a.download = `complaints-${drill.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div className="modal-backdrop top" onClick={onClose}>
      <section className="card modal rep-drill" role="dialog" aria-label={drill.title} onClick={(e) => e.stopPropagation()}>
        <div className="cmp-runbar">
          <h2>{drill.title}</h2>
          <span><button className="secondary" onClick={download} disabled={!rows.length}>Download CSV</button>{' '}<button className="link" onClick={onClose}>Close</button></span>
        </div>
        <p className="muted small">
          {drill.ids.length} {drill.ids.length === 1 ? 'case' : 'cases'} · total cost {money(total)} · average {money(rows.length ? total / rows.length : null)}. Click a row for the full case.
          {!loading && rows.length !== drill.ids.length && <span className="warn"> {drill.ids.length - rows.length} could not be loaded.</span>}
        </p>
        {loading ? <p className="muted">Loading…</p> : (
          <div className="table-scroll">
            <table className="rep-drill-table cmp-cases">
              <thead><tr><th>Opened</th><th>Client</th><th>Booking</th><th>Cleaner</th><th>Category</th><th>Root cause</th><th>What we did</th><th>Cost</th><th>Outcome</th><th>Source</th>{drill.why && <th>Why not counted</th>}</tr></thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className={openCase === c.id ? 'selected' : ''} onClick={() => setOpenCase(c.id)}>
                    <td>{day(c.opened_at)}</td>
                    <td>{c.customer_name || <span className="muted">unmatched</span>}</td>
                    <td className="small">{c.l27_booking_id ? `#${c.l27_booking_id}` : '—'}{c.service_date ? ` · ${day(c.service_date)}` : ''}</td>
                    <td className="small">{c.cleaner_name || '—'}</td>
                    <td>{catLabel(c.category)}{c.hard_route && <span className="pill late" title={ESCALATED_TIP}>escalated</span>}</td>
                    <td className="small">{c.cause ? causeName(cb, c.cause) : <span className="muted">not set</span>}</td>
                    <td>{whatWeDid(c.rungs)}</td>
                    <td>{money(Number(c.total_cost))}</td>
                    <td>{outcomeOf(c) ? OUTCOME_LABEL[outcomeOf(c) as string] : '—'}</td>
                    <td className="small">{c.original_url ? <a href={c.original_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{SOURCE_LABEL[c.source] || c.source}</a> : <span className="muted">{SOURCE_LABEL[c.source] || c.source}</span>}</td>
                    {drill.why && <td className="small">{drill.why[c.id] || '—'}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {openCase && <CaseDetailCard id={openCase} onClose={() => setOpenCase(null)} />}
      </section>
    </div>
  );
}

function PlaybookTab({ period, isAdmin }: { period: Period; isAdmin: boolean }) {
  const q = useQuery({ queryKey: ['complaints', 'playbook', period.from, period.to], queryFn: () => complaintsApi.playbook({ from: period.from, to: period.to }), retry: false, placeholderData: (prev) => prev });
  const [drill, setDrill] = useState<Drill | null>(null);
  const cases = useQuery({ queryKey: ['complaints', 'cases', '', period.from, period.to], queryFn: () => complaintsApi.cases({ from: period.from, to: period.to }), retry: false, enabled: !!drill });
  const p = q.data;
  if (q.isLoading) return <p className="muted">Loading…</p>;
  if (q.isError) return <div className="error">{(q.error as Error).message}</div>;
  if (!p) return null;
  if (!p.totals.cases) return <section className="card seg-empty"><h2>No cases stored for these dates</h2><p className="muted">Pick other dates above, or update these dates from the sources.</p></section>;
  const open: Open = setDrill;
  const L = p.excluded_labels;
  const t = p.totals;
  const oneTime = p.taxonomy.filter((x) => x.one_time.n > 0);
  return (
    <>
      <div className="tiles">
        <Kpi label="Complaint cases" value={String(t.cases)} note={Object.entries(t.by_source).map(([k, v]) => `${SOURCE_LABEL[k] || k} ${v}`).join(' · ')} />
        <Kpi label="Recurring clients kept (60 days)" value={pct(t.saved)} note={`${t.saved_n} of ${t.decided} decided`} />
        <Kpi label="Recurring clients lost" value={pct(t.lost)} note={`${t.lost_n} of ${t.decided} decided`} tone={(t.lost || 0) > 0.3 ? 'warn' : undefined} />
        <Kpi label="One-time clients who booked again" value={pct(t.one_time.rebooked_120)} note={`${t.one_time.rebooked_120_n} of ${t.one_time.decided} within 120 days`} />
        <Kpi label="Total cost" value={money(t.total_cost)} note={`avg ${money(t.avg_cost)} over all ${t.n} cases`} />
        <Kpi label="Escalated" value={String(t.hard_routed)} note="damage / theft / safety / legal" />
        <Kpi label="First reply (median)" value={p.response.first_response_median_hours == null ? '—' : `${p.response.first_response_median_hours} h`} note={`${p.response.with_response_time} cases with reply times`} />
      </div>

      <section className="card">
        <h2>How the totals are counted</h2>
        <p className="muted small">Click any underlined number on this page to see the exact cases behind it and download them.</p>
        <table>
          <thead><tr><th>All complaints</th>{STAT_HEADS}<th title={ESCALATED_TIP}>Escalated</th></tr></thead>
          <tbody>
            <tr className="static">
              <td><Num ids={t.ids} title="All complaints in these dates" open={open}>{t.n}</Num> cases</td>
              <StatCells s={t} name="All complaints" labels={L} open={open} />
              <td><Num ids={t.hard_routed_ids} title="Escalated cases" open={open}>{t.hard_routed}</Num></td>
            </tr>
          </tbody>
        </table>
        {p.hard_routes.some((h) => h.n > 0) && <p className="small muted">Escalated by reason: {p.hard_routes.filter((h) => h.n > 0).map((h, i) => <span key={h.key}>{i ? ' · ' : ''}{h.label} <Num ids={h.ids} title={`Escalated: ${h.label}`} open={open}>{h.n}</Num></span>)}</p>}
      </section>

      <section className="card">
        <h2>Taxonomy: what comes up, what we did, what worked</h2>
        <p className="muted small">Saved, Partial and Lost are shares of <b>decided</b> cases: recurring clients matched in Launch27 whose complaint is at least 60 days old. Everything else is listed under Not counted, with the reason. Average cost is shown over every case, then over the same decided cases the rates use. One-time clients have their own table below.</p>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Category</th><th title="This category's cases as a share of every complaint in these dates">% of all complaints</th><th>We usually</th>{STAT_HEADS}<th title="The lowest-cost response whose save rate is within 10 points of the best one, among responses with at least 3 known outcomes. With fewer outcomes it shows the best we have seen and says so.">Cheapest that works</th></tr></thead>
            <tbody>
              {p.taxonomy.map((x) => {
                const name = catLabel(x.key);
                const c = x.cheapest_that_works;
                return (
                  <tr key={x.key} className="static">
                    <td>{name}{x.hard_routed ? <span className="pill late" title={ESCALATED_TIP}><Num ids={x.hard_routed_ids} title={`${name}: escalated`} open={open}>{x.hard_routed} escalated</Num></span> : null}</td>
                    <td>{pct(x.share)} <span className="small muted cmp-nd"><Num ids={x.ids} title={`${name}: every case`} open={open}>{x.n}</Num> of {x.total_n}</span></td>
                    <td>{x.typical_name || '—'}</td>
                    <StatCells s={x} name={name} labels={L} open={open} />
                    <td className="small">{c && !c.name ? <span className="muted">{c.reason}{c.usual ? `. We usually do: ${c.usual}` : ''}</span> : c ? <><b>{c.name}</b>, {c.grade} confidence: <Num ids={c.ids} title={`${name}: ${c.name}`} open={open}>{c.reason}</Num>{c.saved != null ? ` (${pct(c.saved)} saved, avg ${money(c.avg_cost)})` : ''}</> : <span className="muted">no cases</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <WhyItHappened p={p} open={open} labels={L} />

      <WhatWeOffered p={p} open={open} labels={L} />

      <Threats p={p} open={open} labels={L} />

      <GoogleReviews p={p} open={open} isAdmin={isAdmin} />

      <ValueTiers p={p} open={open} labels={L} />

      <section className="card">
        <h2>One-time clients: did they book again?</h2>
        <p className="muted small">One-time clients have no schedule to keep, so they are left out of Saved and Lost above. The question here is whether they booked again within 90 and 120 days of the complaint. Recleans and free visits don't count as booking again.</p>
        {oneTime.length === 0 ? <p className="muted">No one-time clients among these complaints.</p> : (
          <table>
            <thead><tr><th>Category</th><th>One-time cases</th><th>Booked again within 90 days</th><th>Booked again within 120 days</th><th>Too early to tell</th></tr></thead>
            <tbody>
              {[{ key: 'all', one_time: t.one_time }, ...oneTime].map((x) => {
                const o = x.one_time;
                const name = x.key === 'all' ? 'All one-time clients' : `${catLabel(x.key)}: one-time clients`;
                return (
                  <tr key={x.key} className="static">
                    <td>{x.key === 'all' ? <b>All categories</b> : catLabel(x.key)}</td>
                    <td><Num ids={o.ids} title={name} open={open}>{o.n}</Num></td>
                    <td>{o.decided_90 ? <><b>{pct(o.rebooked_90)}</b> <span className="small muted cmp-nd"><Num ids={o.rebooked_90_ids} title={`${name}, booked again within 90 days`} open={open}>{o.rebooked_90_n}</Num> of <Num ids={o.decided_90_ids} title={`${name}, at least 90 days old`} open={open}>{o.decided_90}</Num></span></> : <span className="muted">—</span>}</td>
                    <td>{o.decided ? <><b>{pct(o.rebooked_120)}</b> <span className="small muted cmp-nd"><Num ids={o.rebooked_120_ids} title={`${name}, booked again within 120 days`} open={open}>{o.rebooked_120_n}</Num> of <Num ids={o.decided_ids} title={`${name}, at least 120 days old`} open={open}>{o.decided}</Num></span></> : <span className="muted">—</span>}</td>
                    <td><Num ids={o.too_early_ids} title={`${name}, not yet 120 days old or unmatched`} open={open}>{o.too_early_ids.length}</Num></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>What we did: retention and real cost of each response</h2>
        <p className="muted small">Each case is counted at the biggest thing we gave. Refunds are grouped by size (we've actually given 20%, 30%, 40%, 50% and full). Escalated cases are left out (they're never on the ladder). Reclean cost includes the cleaner's pay, travel and the margin of the slot it used up.</p>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Response</th><th>Level</th><th>Cases</th>{STAT_HEADS}</tr></thead>
            <tbody>
              {p.ladder.map((r) => (
                <tr key={r.rung} className="static"><td><b>{r.name}</b></td><td className="muted small">{r.tier}</td><td><Num ids={r.ids} title={`${r.name}: every case`} open={open}>{r.n}</Num></td><StatCells s={r} name={r.name} labels={L} open={open} /></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <RecleanVsRefund p={p} open={open} />

      {p.root_causes && <RootCauses rc={p.root_causes} open={open} />}
      <Baseline b={p.baseline} open={open} />

      <section className="card">
        <h2>Data gaps and confidence</h2>
        <ul>{p.gaps.map((g, i) => <li key={i}>{g}</li>)}</ul>
      </section>
      {drill && <DrillDialog drill={drill} cases={cases.data || []} loading={cases.isLoading} onClose={() => setDrill(null)} />}
    </>
  );
}

// Root causes: the same view as the taxonomy, by why it happened instead of what was said.
// This is what the ranked responses per cause will be built on, once the causes are checked.
function WhyItHappened({ p, open, labels }: { p: Playbook; open: Open; labels: Record<ExcludedReason, string> }) {
  const rows = p.by_cause || [];
  if (!rows.length) return null;
  const unset = rows.find((r) => r.key === 'unset');
  const order = [...(p.cause_groups || []).map((g) => g.key), null];
  const groupName = (k: string | null) => p.cause_groups.find((g) => g.key === k)?.label || 'Everything else';
  return (
    <section className="card">
      <h2>Why it happened: root causes</h2>
      <p className="muted small">The category is what the client complained about; the root cause is why it happened. A complaint about missed areas can be caused by a cleaner who left. Each case counts once, under its root cause; "also a factor in" counts the cases where it contributed.{unset ? ` ${unset.n} ${unset.n === 1 ? 'case has' : 'cases have'} no root cause yet: older cases get one when their dates are updated again, or when someone checks them.` : ''}</p>
      <div className="cmp-arms">
        {p.cause_groups.map((g) => (
          <div className="cmp-arm" key={g.key}>
            <span className="small muted">{g.label}</span>
            <span className="cmp-arm-value"><Num ids={g.ids} title={`${g.label}: every case`} open={open}>{g.n}</Num></span>
            <span className="small muted">{pct(g.share)} of all complaints{g.decided ? ` · ${pct(g.saved)} kept (${g.saved_n} of ${g.decided})` : ''}</span>
          </div>
        ))}
      </div>
      <div className="table-scroll">
        <table>
          <thead><tr><th>Root cause</th><th title="This cause's cases as a share of every complaint in these dates">% of all complaints</th><th title="Cases where this was a contributing cause, not the root cause">Also a factor in</th><th>What clients complained about</th>{STAT_HEADS}<th title="The lowest-cost response whose save rate is within 10 points of the best one, among responses with at least 3 known outcomes.">Cheapest that works</th></tr></thead>
          <tbody>
            {order.map((gk) => {
              const list = rows.filter((r) => (r.group || null) === gk);
              if (!list.length) return null;
              return [
                <tr key={`g-${gk}`} className="static"><th colSpan={11}>{groupName(gk)}</th></tr>,
                ...list.map((x) => {
                  const c = x.cheapest_that_works;
                  return (
                    <tr key={x.key} className="static">
                      <td>{x.label}{x.set_by.human ? <span className="small muted"> · {x.set_by.human} checked</span> : null}</td>
                      <td>{pct(x.share)} <span className="small muted cmp-nd"><Num ids={x.ids} title={`${x.label}: every case`} open={open}>{x.n}</Num> of {x.total_n}</span></td>
                      <td>{x.contributing_n ? <Num ids={x.contributing_ids} title={`${x.label}: a contributing cause`} open={open}>{x.contributing_n}</Num> : <span className="muted">—</span>}</td>
                      <td className="small">{x.by_category.slice(0, 3).map((k, i) => <span key={k.key}>{i ? ', ' : ''}{catLabel(k.key)} <Num ids={k.ids} title={`${x.label} → ${catLabel(k.key)}`} open={open}>{k.n}</Num></span>)}{x.by_category.length > 3 ? ', …' : ''}</td>
                      <StatCells s={x} name={x.label} labels={labels} open={open} />
                      <td className="small">{c && !c.name ? <span className="muted">Not enough data: use the standard ladder</span> : c ? <><b>{c.name}</b>, {c.grade}: <Num ids={c.ids} title={`${x.label}: ${c.name}`} open={open}>{c.reason}</Num></> : <span className="muted">—</span>}</td>
                    </tr>
                  );
                }),
              ];
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// What we offered and how clients took it, read from the conversations themselves (the whole
// migrated Kustomer history and everything since). The raw material for ranking responses.
function WhatWeOffered({ p, open, labels }: { p: Playbook; open: Open; labels: Record<ExcludedReason, string> }) {
  const s = p.solutions;
  if (!s) return null;
  if (!s.enabled && !s.read) return null;
  const e = s.endings;
  const heard = e.satisfied.length + e.neutral.length + e.unhappy.length;
  return (
    <section className="card">
      <h2>What we offered, and how clients took it</h2>
      <p className="muted small">Read by Claude from each client's own conversations around the complaint (client messages, our replies and internal notes, names removed). Every update reads a few hundred more, newest first, until the whole history is done.{s.not_yet ? ` ${s.not_yet} of these cases haven't been read yet.` : ''}{s.no_thread ? <> <Num ids={s.no_thread_ids} title="No conversation on file" open={open}>{s.no_thread}</Num> have no conversation on file.</> : null}</p>
      <div className="cmp-arms">
        <div className="cmp-arm"><span className="small muted">Conversations read</span><span className="cmp-arm-value"><Num ids={s.read_ids} title="Cases whose conversation was read" open={open}>{s.read}</Num></span><span className="small muted">of {p.totals.cases} cases</span></div>
        <div className="cmp-arm"><span className="small muted">Client happy at the end</span><span className="cmp-arm-value">{pct(heard ? e.satisfied.length / heard : null)}</span><span className="small muted"><Num ids={e.satisfied} title="Happy at the end of the conversation" open={open}>{e.satisfied.length}</Num> of {heard} who wrote back · <Num ids={e.unhappy} title="Still unhappy at the end" open={open}>{e.unhappy.length}</Num> still unhappy</span></div>
        <div className="cmp-arm"><span className="small muted">Turned down our first offer</span><span className="cmp-arm-value"><Num ids={s.pushed_back_first_ids} title="Turned down or countered our first offer" open={open}>{s.pushed_back_first_ids.length}</Num></span><span className="small muted">declined it or asked for something else</span></div>
        <div className="cmp-arm"><span className="small muted">Said they'd leave</span><span className="cmp-arm-value"><Num ids={s.said_will_leave_ids} title="Said in the conversation they would leave" open={open}>{s.said_will_leave_ids.length}</Num></span><span className="small muted">in the conversation</span></div>
      </div>
      {s.offers.length === 0 ? <p className="muted">No conversations read for these dates yet.</p> : (
        <div className="table-scroll">
          <table>
            <thead><tr>
              <th>Offer</th>
              <th title="Clients who asked for this before we offered anything">Asked for</th>
              <th title="Cases where we offered it at some point">Offered</th>
              <th title="Of the times the client answered the offer, how often they took it">Taken</th>
              <th title="Cases where this is what was finally agreed or done">Final answer</th>
              <th title="Of those final answers, how the client sounded in their last message">Happy at the end</th>
              {STAT_HEADS}
            </tr></thead>
            <tbody>
              {s.offers.map((o) => (
                <tr key={o.key} className="static">
                  <td>{o.label}</td>
                  <td>{o.asked_for ? <Num ids={o.asked_for_ids} title={`Asked for: ${o.label}`} open={open}>{o.asked_for}</Num> : <span className="muted">—</span>}</td>
                  <td><Num ids={o.offered_ids} title={`Offered: ${o.label}`} open={open}>{o.offered}</Num></td>
                  <td>{o.accept_rate == null ? <span className="muted">—</span> : <><b>{pct(o.accept_rate)}</b> <span className="small muted cmp-nd"><Num ids={o.accepted_ids} title={`Took it: ${o.label}`} open={open}>{o.accepted}</Num> took it, <Num ids={o.pushed_back_ids} title={`Turned down: ${o.label}`} open={open}>{o.pushed_back}</Num> didn't</span></>}</td>
                  <td>{o.final.n ? <Num ids={o.final.ids} title={`Final answer: ${o.label}`} open={open}>{o.final.n}</Num> : <span className="muted">0</span>}</td>
                  <td>{o.ended_happy == null ? <span className="muted">—</span> : <><b>{pct(o.ended_happy)}</b> <span className="small muted cmp-nd"><Num ids={o.ended_happy_ids} title={`Happy at the end: ${o.label}`} open={open}>{o.ended_happy_n}</Num> of {o.ended_heard}</span></>}</td>
                  <StatCells s={o.final} name={`Final answer: ${o.label}`} labels={labels} open={open} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted">Saved / Lost and cost are for the cases where this was the final answer. An offer the client took also counts under "What we did" below.</p>
    </section>
  );
}

// Google reviews: imported from a Google Business Profile export and matched to complaints by
// the reviewer's full name and the dates. Shows which threats became reviews, and what we did first.
function GoogleReviews({ p, open, isAdmin }: { p: Playbook; open: Open; isAdmin: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['complaints', 'reviews'], queryFn: complaintsApi.reviews, retry: false });
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  const r = p.reviews;
  const s = q.data;
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setMsg(null);
    let read = 0;
    let added = 0;
    const bad: string[] = [];
    for (const f of Array.from(files)) {
      try {
        const out = await complaintsApi.importReviews(JSON.parse(await f.text()));
        read += out.read;
        added += out.added;
        if (!out.read) bad.push(f.name);
      } catch {
        bad.push(f.name);
      }
    }
    setBusy(false);
    setMsg(`${read} reviews read, ${added} new.${bad.length ? ` ${bad.length} ${bad.length === 1 ? 'file had' : 'files had'} no reviews (account files don't): ${bad.slice(0, 3).join(', ')}${bad.length > 3 ? '…' : ''}.` : ''} Outcomes pick up matched reviews on the next update.`);
    qc.invalidateQueries({ queryKey: ['complaints'] });
  };
  if (!r) return null;
  return (
    <section className="card">
      <h2>Google reviews</h2>
      <p className="muted small">Reviews from your Google Business Profile export, matched to the complaint they followed by the reviewer's full name and the dates (a complaint up to 60 days before the review). A matched 1–2★ review counts that client as lost. Reviews posted under initials, a first name only or a business name can't be matched. Reviews come in on their own each time the KPI scorecard reads Google, once Google is connected on the KPI page (Connect Google).</p>
      {r.imported === 0 ? <p className="muted">No reviews yet. They arrive on their own after Google is connected on the KPI page and the scorecard next refreshes.</p> : (
        <div className="cmp-arms">
          <div className="cmp-arm"><span className="small muted">Reviews imported</span><span className="cmp-arm-value">{r.imported}</span><span className="small muted">{day(r.first_at)} to {day(r.last_at)} · {r.imported_negative} at 1–2★</span></div>
          <div className="cmp-arm"><span className="small muted">Complaints followed by a 1–2★ review</span><span className="cmp-arm-value"><Num ids={r.low_ids} title="Complaints followed by a 1-2 star Google review" open={open}>{r.low_ids.length}</Num></span><span className="small muted"><Num ids={r.low_without_threat_ids} title="Low review with no threat first" open={open}>{r.low_without_threat_ids.length}</Num> gave no warning</span></div>
          <div className="cmp-arm"><span className="small muted">Threatened a review</span><span className="cmp-arm-value"><Num ids={r.threatened_ids} title="Threatened a public review" open={open}>{r.threatened_ids.length}</Num></span><span className="small muted"><Num ids={r.threatened_posted_ids} title="Threatened a review and posted 1-2 stars" open={open}>{r.threatened_posted_ids.length}</Num> posted 1–2★ · <Num ids={r.threatened_not_posted_ids} title="Threatened a review, none matched" open={open}>{r.threatened_not_posted_ids.length}</Num> didn't (that we can match)</span></div>
          <div className="cmp-arm"><span className="small muted">Complaints followed by 4–5★</span><span className="cmp-arm-value"><Num ids={r.high_ids} title="Complaints followed by a 4-5 star Google review" open={open}>{r.high_ids.length}</Num></span><span className="small muted">won back, publicly</span></div>
        </div>
      )}
      {r.low_by_response.length > 0 && <p className="small">What we had done before a 1–2★ review: {r.low_by_response.map((x, i) => <span key={x.response}>{i ? ' · ' : ''}{x.label} <Num ids={x.ids} title={`1-2 star review after: ${x.label}`} open={open}>{x.n}</Num></span>)}</p>}
      <div className="cmp-check-actions">
        {isAdmin && <label className="link">{busy ? 'Importing…' : 'Or import export files (reviews-….json)'}<input type="file" accept=".json,application/json" multiple hidden disabled={busy} onChange={(e) => { upload(e.target.files); e.target.value = ''; }} /></label>}
        {s && s.low.length > 0 && <button type="button" className="link" onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'} the {s.low.length} reviews at 3★ or under</button>}
      </div>
      {msg && <p className="small cmp-note">{msg}</p>}
      {show && s && (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Posted</th><th>Reviewer</th><th>Review</th><th>Stars</th><th>Matched to</th><th>We replied</th></tr></thead>
            <tbody>
              {s.low.map((x) => (
                <tr key={x.review_id} className="static">
                  <td>{day(x.created_at)}</td>
                  <td>{x.reviewer_name || '—'}</td>
                  <td className="small">{x.comment ? (x.comment.length > 240 ? `${x.comment.slice(0, 240)}…` : x.comment) : <span className="muted">no text</span>}</td>
                  <td>{x.stars}★</td>
                  <td className="small">{x.case_id ? <Num ids={[x.case_id]} title={`Complaint before ${x.reviewer_name || 'this'} review`} open={open}>{catLabel(x.case_category || 'other')} complaint, {day(x.case_opened_at)}</Num> : x.contact_id ? <span className="muted">a contact, no complaint on file</span> : <span className="muted">nobody</span>}</td>
                  <td>{x.replied ? 'Yes' : <span className="warn">No</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// Client value: do we lose our best clients more often, and what keeps them?
function ValueTiers({ p, open, labels }: { p: Playbook; open: Open; labels: Record<ExcludedReason, string> }) {
  const levels = (p.value_tiers || []).filter((t) => t.n > 0);
  if (!levels.length) return null;
  return (
    <SplitSection
      title="By client value"
      intro={<>The same responses, split by what the client's plan is worth in a year: their usual visit price times the visits a year their frequency means (Launch27). That is what's at stake when they complain; past spend says little, because most complaints come on a first or second clean. One-time clients have no plan and are shown apart. Losing a top plan costs many times what a refund does, so compare what kept those clients with what we usually do.{p.value_unknown_ids?.length ? <> <Num ids={p.value_unknown_ids} title="No Launch27 visits on file" open={open}>{p.value_unknown_ids.length}</Num> cases have no paid visit on file (not matched to a Launch27 client) and are left out.</> : null}</>}
      levels={levels.map((t) => ({ ...t, extra: t.avg_spend != null ? (t.key === 'one' ? `avg ${money(t.avg_spend)} a visit` : `avg plan ${money(t.avg_spend)} a year`) : '' }))}
      open={open}
      labels={labels}
    />
  );
}

// Threats: does giving more keep a client who threatens to leave or to post a review?
function Threats({ p, open, labels }: { p: Playbook; open: Open; labels: Record<ExcludedReason, string> }) {
  const levels = (p.threats || []).filter((t) => t.n > 0);
  if (!levels.some((t) => t.key !== 'none')) return null;
  return (
    <SplitSection
      title="When clients threaten to leave or post a review"
      intro="The same responses, split by how hard the client pushed. A threat is read from the complaint's tone, or from the client saying in the conversation that they'd leave. Compare a response's Saved rate under a threat with the same response under no threat: that is whether giving more actually keeps them. Which threats became real reviews is in Google reviews below."
      levels={levels}
      open={open}
      labels={labels}
    />
  );
}

type SplitLevel = OutcomeStats & { key: string; label: string; share: number | null; extra?: string; by_response: (OutcomeStats & { response: string; label: string })[] };
function SplitSection({ title, intro, levels, open, labels }: { title: string; intro: React.ReactNode; levels: SplitLevel[]; open: Open; labels: Record<ExcludedReason, string> }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      <p className="muted small">{intro}</p>
      <div className="cmp-arms">
        {levels.map((t) => (
          <div className="cmp-arm" key={t.key}>
            <span className="small muted">{t.label}</span>
            <span className="cmp-arm-value"><Num ids={t.ids} title={`${t.label}: every case`} open={open}>{t.n}</Num></span>
            <span className="small muted">{pct(t.share)} of complaints{t.extra ? ` · ${t.extra}` : ''}{t.decided ? ` · ${pct(t.saved)} kept (${t.saved_n} of ${t.decided}) · avg cost ${money(t.avg_cost)}` : ''}</span>
          </div>
        ))}
      </div>
      <div className="table-scroll">
        <table>
          <thead><tr><th>What we did</th><th>Cases</th>{STAT_HEADS}</tr></thead>
          <tbody>
            {levels.map((t) => [
              <tr key={`t-${t.key}`} className="static"><th colSpan={8}>{t.label}</th></tr>,
              ...t.by_response.map((r) => (
                <tr key={`${t.key}-${r.response}`} className="static">
                  <td>{r.label}</td>
                  <td><Num ids={r.ids} title={`${t.label}: ${r.label}`} open={open}>{r.n}</Num></td>
                  <StatCells s={r} name={`${t.label}: ${r.label}`} labels={labels} open={open} />
                </tr>
              )),
            ])}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RecleanVsRefund({ p, open }: { p: Playbook; open: Open }) {
  const t = p.reclean_vs_refund_total;
  const l = p.like_for_like;
  const arms = [
    { label: 'Reclean', s: t.reclean },
    { label: 'Refund', s: t.refund },
    { label: 'Neither (apology or credit)', s: t.neither },
  ];
  const any = t.reclean.n + t.refund.n > 0;
  const kept = (s: OutcomeStats, name: string) => (s.decided
    ? <><b>{pct(s.saved)}</b> <span className="small muted cmp-nd"><Num ids={s.saved_ids} title={`${name}: saved`} open={open}>{s.saved_n}</Num> of <Num ids={s.decided_ids} title={`${name}: decided`} open={open}>{s.decided}</Num></span></>
    : s.n ? <span className="muted">too early (<Num ids={s.ids} title={`${name}: every case`} open={open}>{s.n}</Num>)</span> : <span className="muted">—</span>);
  const cost = (s: OutcomeStats, name: string) => (s.n ? <>{money(s.avg_cost)} <span className="small muted cmp-nd">all <Num ids={s.ids} title={`${name}: every case (total cost ${money(s.total_cost)})`} open={open}>{s.n}</Num></span></> : <span className="muted">—</span>);
  return (
    <section className="card">
      <h2>Reclean vs refund</h2>
      {!any ? (
        <p className="muted">No recleans or refunds in these dates yet. This fills in once Kustomer and the finance channels have been read for the period.</p>
      ) : (
        <>
          <div className="cmp-arms">
            {arms.map((a) => (
              <div key={a.label} className="cmp-arm">
                <span className="muted small">{a.label}</span>
                <span className="cmp-arm-value">{a.s.decided ? pct(a.s.saved) : '—'}</span>
                <span className="small">recurring clients kept: <Num ids={a.s.saved_ids} title={`${a.label}: saved`} open={open}>{a.s.saved_n}</Num> of <Num ids={a.s.decided_ids} title={`${a.label}: decided`} open={open}>{a.s.decided}</Num> decided</span>
                <span className="muted small"><Num ids={a.s.ids} title={`${a.label}: every case`} open={open}>{a.s.n}</Num> cases · avg cost {money(a.s.avg_cost)} over all, {money(a.s.avg_cost_decided)} on the decided · {a.s.excluded_n} not counted</span>
              </div>
            ))}
          </div>
          <div className={`cmp-note ${l.reclean && l.refund && l.matched_pairs >= p.thin_threshold ? 'ok' : ''}`}>
            <b>Like for like.</b> Angrier clients tend to get refunds, which makes refunds look worse than they are. Comparing only similar complaints (same category, calm or heated, new or established client):{' '}
            {l.reclean && l.refund ? <>reclean kept <b>{pct(l.reclean.saved)}</b> (<Num ids={l.reclean.ids} title="Like for like: recleans compared" open={open}>{l.reclean.n} cases</Num>), refund kept <b>{pct(l.refund.saved)}</b> (<Num ids={l.refund.ids} title="Like for like: refunds compared" open={open}>{l.refund.n} cases</Num>), from {l.matched_pairs} comparable pair{l.matched_pairs === 1 ? '' : 's'} in {l.groups_compared} group{l.groups_compared === 1 ? '' : 's'}. {l.verdict}</> : <span className="muted">not enough similar cases yet to compare fairly. This fills in as more history is read.</span>}
          </div>
          {p.reclean_vs_refund.length > 0 && (
            <div className="table-scroll">
              <table>
                <thead><tr><th>Category</th><th>Reclean kept</th><th>Reclean cost</th><th>Refund kept</th><th>Refund cost</th><th>Neither kept</th><th>Read</th></tr></thead>
                <tbody>
                  {p.reclean_vs_refund.map((x) => (
                    <tr key={x.key} className="static">
                      <td>{catLabel(x.key)}</td>
                      <td>{kept(x.reclean, `${catLabel(x.key)}, reclean`)}</td>
                      <td>{cost(x.reclean, `${catLabel(x.key)}, reclean`)}</td>
                      <td>{kept(x.refund, `${catLabel(x.key)}, refund`)}</td>
                      <td>{cost(x.refund, `${catLabel(x.key)}, refund`)}</td>
                      <td>{kept(x.neither, `${catLabel(x.key)}, neither`)}</td>
                      <td className="small">{x.verdict}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function RootCauses({ rc, open }: { rc: NonNullable<Playbook['root_causes']>; open: Open }) {
  return (
    <section className="card">
      <h2>Pain points upstream: when complaints happen</h2>
      <p className="muted small">Complaints per 100 visits in each situation, against the overall {rc.base_rate_per_100} per 100 (<Num ids={rc.linked_ids} title="Complaints linked to a visit in these dates" open={open}>{rc.linked_complaints} complaints</Num> linked to one of {rc.visits.toLocaleString()} visits). Above 1.5× is worth fixing before the complaint happens. Visit counts come straight from Launch27 bookings and aren't listed case by case.</p>
      <table>
        <thead><tr><th>Situation at the visit</th><th>Complaints</th><th>Visits</th><th>Per 100</th><th>vs overall</th><th>Confidence</th></tr></thead>
        <tbody>
          {rc.rows.map((r) => (
            <tr key={r.key} className="static">
              <td>{r.label}</td>
              <td><Num ids={r.case_ids} title={`Complaints after: ${r.label.toLowerCase()}`} open={open}>{r.complaints}</Num></td>
              <td>{r.visits.toLocaleString()}</td>
              <td>{r.rate_per_100 == null ? '—' : <>{r.rate_per_100} <span className="small muted cmp-nd">{r.complaints} of {r.visits.toLocaleString()}</span></>}</td>
              <td className={(r.vs_base || 0) >= 1.5 ? 'neg' : ''}>{r.vs_base == null ? '—' : `${r.vs_base}×`}</td>
              <td>{conf(r.confidence, r.complaints)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Baseline({ b, open }: { b: Playbook['baseline']; open: Open }) {
  const max = Math.max(0.0001, ...b.months.map((m) => m.rate || 0));
  return (
    <section className="card">
      <h2>Refund budget baseline: complaint cost as a % of Residential revenue</h2>
      <p className="small">The average and target use <b>{b.included_months.length}</b> fully read {b.included_months.length === 1 ? 'month' : 'months'}{b.included_months.length ? ` (${b.included_months[0]} to ${b.included_months[b.included_months.length - 1]})` : ''}.{b.incomplete_months.length ? <span className="warn"> Left out, still being read from Kustomer and info@: {b.incomplete_months.join(', ')}.</span> : null}</p>
      <p className="muted small">Refunds + credits + recleans, by month, for every month of history whatever dates are selected above. Average {pct(b.average, 2)} · best {b.best ? `${b.best.month} ${pct(b.best.rate, 2)}` : '—'} · worst {b.worst ? `${b.worst.month} ${pct(b.worst.rate, 2)}` : '—'} · default target {pct(b.default_target, 2)} (20% below average).</p>
      <div className="cmp-bars" role="img" aria-label="Monthly complaint cost as a share of revenue">
        {b.months.map((m) => (
          <div key={m.month} className="cmp-bar" style={m.complete ? undefined : { opacity: 0.4 }} title={`${m.month}: ${pct(m.rate, 2)} (${money(m.cost)} of ${money(m.revenue)}, ${m.cases} cases)`}>
            <span style={{ height: `${((m.rate || 0) / max) * 100}%` }} />
            <small>{m.month.slice(5)}</small>
          </div>
        ))}
      </div>
      <div className="table-scroll">
        <table>
          <thead><tr><th>Month</th><th>Cost as % of revenue</th><th>Complaint cost</th><th>Refunds</th><th>Credits</th><th>Recleans</th><th>Revenue</th><th>Cases</th></tr></thead>
          <tbody>
            {b.months.map((m) => (
              <tr key={m.month} className="static">
                <td>{m.month}{!m.complete && <span className="pill late" title="Not every day of this month has been read from Kustomer and info@ yet, so it is left out of the average"> incomplete</span>}</td>
                <td><b>{pct(m.rate, 2)}</b> <span className="small muted cmp-nd">{money(m.cost)} of {money(m.revenue)}</span></td>
                <td>{money(m.cost)}</td><td>{money(m.refunds)}</td><td>{money(m.credits)}</td><td>{money(m.recleans)}</td>
                <td>{money(m.revenue)}</td>
                <td><Num ids={m.case_ids} title={`Complaints opened in ${m.month}`} open={open}>{m.cases}</Num></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small warn">{b.caveat}</p>
    </section>
  );
}

type SortKey = 'opened_at' | 'customer_name' | 'category' | 'cause' | 'service' | 'client_type' | 'tone' | 'did' | 'total_cost' | 'outcome' | 'source';
const TONE_ORDER = ['mild', 'frustrated', 'angry', 'threat_leave', 'threat_review'];
const outcomeOf = (c: CaseRow) => (c.client_type === 'one_time' ? c.outcome_120 : c.outcome_60);
function sortValue(c: CaseRow, k: SortKey): string | number {
  switch (k) {
    case 'total_cost': return Number(c.total_cost) || 0;
    case 'tone': return c.tone ? TONE_ORDER.indexOf(c.tone) : -1;
    case 'category': return catLabel(c.category);
    case 'cause': return c.cause || '~';
    case 'did': return whatWeDid(c.rungs);
    case 'outcome': return outcomeOf(c) || '';
    case 'source': return SOURCE_LABEL[c.source] || c.source;
    default: return String(c[k] ?? '');
  }
}

function CasesTab({ period }: { period: Period }) {
  const cb = useCodebook();
  const [category, setCategory] = useState('');
  const [cause, setCause] = useState('');
  const [source, setSource] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'opened_at', dir: -1 });
  const q = useQuery({ queryKey: ['complaints', 'cases', category, period.from, period.to], queryFn: () => complaintsApi.cases({ category: category || undefined, from: period.from, to: period.to }), retry: false });
  const all = useMemo(() => q.data || [], [q.data]);
  const sources = useMemo(() => [...new Set(all.map((c) => c.source))].sort(), [all]);
  const rows = useMemo(() => {
    const list = all.filter((c) => (!source || c.source === source) && (!cause || (cause === 'unset' ? !c.cause : c.cause === cause)));
    return list.sort((a, b) => {
      const x = sortValue(a, sort.key);
      const y = sortValue(b, sort.key);
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * sort.dir;
    });
  }, [all, source, cause, sort]);
  const Th = ({ k, children }: { k: SortKey; children: string }) => (
    <th aria-sort={sort.key === k ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button className="link cmp-sort" onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? (s.dir === 1 ? -1 : 1) : 1 }))}>{children}{sort.key === k ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</button>
    </th>
  );
  const cats = useMemo(() => Object.keys(CATEGORY_LABEL), []);
  return (
    <div className="cmp-cases">
      <section className="card no-pad">
        <div className="cmp-filter">
          <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
            <option value="">All categories</option>
            {cats.map((c) => <option key={c} value={c}>{catLabel(c)}</option>)}
          </select>
          <select value={cause} onChange={(e) => setCause(e.target.value)} aria-label="Root cause">
            <option value="">All root causes</option>
            {cb && <CauseOptions cb={cb} />}
            <option value="other">Other / not on the list</option>
            <option value="unset">Not set yet</option>
          </select>
          <select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Source">
            <option value="">All sources</option>
            {sources.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s] || s}</option>)}
          </select>
          <span className="muted small">{rows.length} cases · click a column heading to sort</span>
        </div>
        <div className="table-scroll">
          <table>
            <thead><tr><Th k="opened_at">Opened</Th><Th k="customer_name">Client</Th><Th k="client_type">Client type</Th><Th k="service">Service</Th><Th k="category">Category</Th><Th k="cause">Root cause</Th><Th k="tone">Tone</Th><Th k="did">What we did</Th><Th k="total_cost">Cost</Th><Th k="outcome">Outcome</Th><Th k="source">From</Th></tr></thead>
            <tbody>
              {rows.map((c: CaseRow) => (
                <tr key={c.id} className={open === c.id ? 'selected' : ''} onClick={() => setOpen(c.id)}>
                  <td>{day(c.opened_at)}</td>
                  <td>{c.customer_name || <span className="muted">unmatched</span>}</td>
                  <td>{c.client_type === 'one_time' ? 'One-time' : c.client_type === 'recurring' ? 'Recurring' : '—'}</td>
                  <td className="small">{c.service || '—'}</td>
                  <td>{catLabel(c.category)}{c.hard_route && <span className="pill late" title={ESCALATED_TIP}>escalated</span>}</td>
                  <td className="small">{c.cause ? causeName(cb, c.cause) : <span className="muted">not set</span>}</td>
                  <td>{c.tone ? TONE_LABEL[c.tone] : '—'}</td>
                  <td>{whatWeDid(c.rungs)}</td>
                  <td>{money(Number(c.total_cost))}</td>
                  <td>{outcomeOf(c) ? OUTCOME_LABEL[outcomeOf(c) as string] : '—'}</td>
                  <td className="small muted">{SOURCE_LABEL[c.source] || c.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {open && <CaseDetailCard id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function CaseDetailCard({ id, onClose }: { id: number; onClose: () => void }) {
  const qc = useQueryClient();
  const cb = useCodebook();
  const q = useQuery({ queryKey: ['complaints', 'case', id], queryFn: () => complaintsApi.case(id) });
  const fix = useMutation({ mutationFn: (category: string) => complaintsApi.reclassify(id, { category }), onSuccess: () => qc.invalidateQueries({ queryKey: ['complaints'] }) });
  const c = q.data;
  if (!c) return <section className="card">Loading…</section>;
  const j = c.journey;
  return (
    <section className="card cmp-detail">
      <div className="cmp-runbar"><h2>{c.customer_name || 'Unmatched client'} · {day(c.opened_at)}</h2><button className="link" onClick={onClose}>Close</button></div>
      {c.summary && <p>{c.summary}</p>}
      <dl className="kv">
        <dt>Category</dt>
        <dd>
          <select value={c.category} onChange={(e) => fix.mutate(e.target.value)} aria-label="Category">
            {Object.keys(CATEGORY_LABEL).map((k) => <option key={k} value={k}>{catLabel(k)}</option>)}
          </select>{' '}
          <span className="muted small">classified by {c.classified_by}</span>
        </dd>
        <dt>Root cause</dt>
        <dd>
          {c.cause ? causeName(cb, c.cause) : <span className="muted">not set yet</span>}
          {c.contributing_causes?.length ? <span className="small"> · also: {c.contributing_causes.map((k) => causeName(cb, k)).join(', ')}</span> : null}
          {c.cause_by && <span className="muted small"> · set by {CAUSE_BY_LABEL[c.cause_by] || c.cause_by}</span>}
          {c.cause_evidence && <><br /><span className="small">“{c.cause_evidence}”</span></>}
        </dd>
        <dt>Tone · severity</dt><dd>{c.tone ? TONE_LABEL[c.tone] : '—'} · {c.severity ?? '—'}/4</dd>
        {c.hard_route && (<><dt>Escalated</dt><dd className="neg">{c.hard_route.replace(/_/g, ' ')} → Office Manager</dd></>)}
        <dt>Areas</dt><dd>{c.areas_cited?.length ? c.areas_cited.join(', ') : '—'}</dd>
        <dt>Booking</dt><dd>{c.l27_booking_id ? `#${c.l27_booking_id}` : '—'} {c.service_date && `· cleaned ${day(c.service_date)}`}</dd>
        <dt>Service</dt><dd>{c.service || '—'} · {c.client_type === 'one_time' ? 'One-time client' : c.client_type === 'recurring' ? 'Recurring client' : 'client type unknown'}</dd>
        {c.source_status && (<><dt>Kustomer status</dt><dd>{c.source_status}</dd></>)}
        {c.also_seen_in.length > 0 && (<><dt>Also seen in</dt><dd>{c.also_seen_in.map((d) => SOURCE_LABEL[d.source] || d.source).join(', ')}</dd></>)}
      </dl>
      {j && (
        <>
          <h3>Before the complaint</h3>
          <dl className="kv">
            <dt>Client</dt><dd>{j.tenure_days ?? '—'} days · {j.cleans_total} cleans · {String(j.frequency || '—')} · {money(Number(j.spend_12m))} in 12 months</dd>
            <dt>Cleaner</dt><dd>{String(j.cleaner_name || '—')} ({j.cleaner_visits_before ?? '?'} visits before){j.cleaner_changed_last_visit ? ' · different from the visit before' : ''} · {j.distinct_cleaners_90d} {Number(j.distinct_cleaners_90d) === 1 ? 'cleaner' : 'cleaners'} in 90 days{j.regular_cleaner_name ? ` · regular: ${String(j.regular_cleaner_name)}${j.regular_cleaner_left ? `, stopped working with us${j.regular_cleaner_last_worked ? ` after ${day(String(j.regular_cleaner_last_worked))}` : ''}` : ''}` : ''}</dd>
            <dt>Signals</dt><dd>{j.prior_complaints} earlier {Number(j.prior_complaints) === 1 ? 'complaint' : 'complaints'} · {j.prior_unhappy_ratings} earlier unhappy {Number(j.prior_unhappy_ratings) === 1 ? 'rating' : 'ratings'} · {j.price_change_pct != null ? `price ${Number(j.price_change_pct) > 0 ? '+' : ''}${pct(Number(j.price_change_pct))}` : 'no price history'} · {j.days_since_last_clean ?? '—'} days since last clean</dd>
          </dl>
        </>
      )}
      {c.solution && c.solution.read_by === 'claude' && (
        <>
          <h3>From the conversation</h3>
          <dl className="kv">
            <dt>Asked for</dt><dd>{OFFER_LABEL[c.solution.asked_for || 'nothing_specific'] || c.solution.asked_for}</dd>
            <dt>We offered</dt>
            <dd>{c.solution.offers.length ? <ol className="cmp-offers">{c.solution.offers.map((o, i) => <li key={i}><b>{OFFER_LABEL[o.kind] || o.kind}</b>{o.pct != null ? ` ${o.pct}%` : ''}{o.amount != null ? ` ${money(o.amount)}` : ''}{o.detail ? <span className="muted"> · {o.detail}</span> : null} → {RESPONSE_LABEL[o.client_response] || o.client_response}</li>)}</ol> : <span className="muted">nothing</span>}</dd>
            <dt>Final answer</dt><dd>{c.solution.final_kind ? OFFER_LABEL[c.solution.final_kind] || c.solution.final_kind : 'nothing agreed'}{c.solution.final_detail ? <span className="muted"> · {c.solution.final_detail}</span> : null}</dd>
            <dt>Client at the end</dt><dd>{ENDING_LABEL[c.solution.client_end || 'unknown']}{c.solution.said_will_leave ? ' · said they would leave' : ''}{c.solution.said_will_stay ? ' · said they would stay' : ''}</dd>
            {c.solution.handling && (<><dt>How we handled it</dt><dd>{c.solution.handling}</dd></>)}
          </dl>
          <p className="small muted">Read from {c.solution.thread_messages} messages and notes on {day(c.solution.mined_at)}.</p>
        </>
      )}
      <h3>What we did</h3>
      {c.resolutions.length ? (
        <ul>{c.resolutions.map((r, i) => <li key={i}><b>{RUNG_NAME[r.rung || r.action] || r.action.replace(/_/g, ' ')}</b>{r.pct != null ? ` ${r.pct}%` : ''}{r.amount ? ` ${money(Number(r.amount))}` : ''}{r.decided_by ? ` · decided by ${r.decided_by}` : ''}{r.approved_by && r.approved_by !== r.decided_by ? ` · approved by ${r.approved_by}` : ''} <span className="muted small">({SOURCE_LABEL[r.source] || r.source})</span></li>)}</ul>
      ) : <p className="muted">No compensation found (apology only, or not recorded).</p>}
      <h3>Cost</h3>
      {c.costs.length ? <ul>{c.costs.map((k, i) => <li key={i}>{k.kind.replace(/_/g, ' ')}: {money(Number(k.amount))}{k.estimated ? <span className="muted small"> (estimated)</span> : ''}</li>)}</ul> : <p className="muted">$0</p>}
      <h3>Outcome</h3>
      <p>{c.outcomes.length ? c.outcomes.map((o) => `${o.day} days: ${OUTCOME_LABEL[o.outcome]}`).join(' · ') : 'Not linked to a Launch27 client, so no outcome.'}</p>
    </section>
  );
}

function ClientTable({ rows, extra, head }: { rows: ClientRow[]; head: string; extra: (r: ClientRow) => React.ReactNode }) {
  return (
    <div className="table-scroll">
      <table>
        <thead><tr><th>Client</th><th>Complaints (12 mo)</th><th>Last complaint</th><th>About</th><th>Cost to us</th><th>Now</th><th>{head}</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.l27_customer_id} className="static">
              <td>{r.name || `Client ${r.l27_customer_id}`}</td><td>{r.complaints}</td><td>{day(r.last_complaint)}</td><td>{catLabel(r.last_category)}</td><td>{money(r.total_cost)}</td>
              <td>{OUTCOME_LABEL[r.status] || r.status}</td><td className="small">{extra(r)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ClientsTab() {
  const q = useQuery({ queryKey: ['complaints', 'clients'], queryFn: complaintsApi.clients, retry: false });
  const c = q.data;
  if (q.isLoading) return <p className="muted">Loading…</p>;
  if (q.isError) return <div className="error">{(q.error as Error).message}</div>;
  if (!c) return null;
  return (
    <>
      <p className="muted small">Clients matched to Launch27, from every period mined so far (last 12 months). {c.clients_with_complaints} clients have at least one complaint.</p>
      <section className="card">
        <h2>At risk of leaving <span className="muted">· {c.at_risk.length}</span></h2>
        <p className="muted small">Complained in the last 60 days, still with us, and showing warning signs. Worth a personal call from the office.</p>
        {c.at_risk.length ? <ClientTable rows={c.at_risk} head="Why" extra={(r) => { const x = r as (typeof c.at_risk)[number]; return `${x.reasons.join(' · ')}${x.next_booking_on ? ` · next booking ${day(x.next_booking_on)}` : ''}`; }} /> : <p className="muted">Nobody flagged right now.</p>}
      </section>
      <section className="card">
        <h2>Repeat complainers <span className="muted">· {c.repeat.length}</span></h2>
        <p className="muted small">Two or more complaints in 12 months. The question the numbers answer: do they stay, and what do they cost us?</p>
        {c.repeat.length ? <ClientTable rows={c.repeat} head="Read" extra={(r) => { const x = r as (typeof c.repeat)[number]; return `${x.low_severity ? 'mostly minor issues' : 'serious issues'} · ${x.still_with_us ? 'still with us' : 'left'}`; }} /> : <p className="muted">None yet. This fills in as more periods are mined.</p>}
      </section>
      <section className="card">
        <h2>Escalates to a public review <span className="muted">· {c.review_mentions.length} mentioned one</span></h2>
        <p className="small warn">Google reviews aren't connected yet, so this lists clients who said they'd post a review, not reviews that were posted.</p>
        {c.review_mentions.length ? <ClientTable rows={c.review_mentions} head="Mentioned" extra={(r) => day((r as (typeof c.review_mentions)[number]).mentioned_on)} /> : <p className="muted">Nobody has mentioned a review in the periods mined.</p>}
      </section>
    </>
  );
}

// Check accuracy: a person looks at a random sample per category and says whether the
// engine's category was right. The answers fix the case and give a measured accuracy.
function AccuracyRows({ rows, label }: { rows: (ReviewTally & { waiting?: number })[]; label: (k: string) => string }) {
  return (
    <>
      {rows.map((r) => (
        <tr key={r.key}>
          <td>{label(r.key)}</td>
          <td className="num">{r.checked}</td>
          <td className="num">{r.accuracy == null ? '—' : pct(r.accuracy)}{r.checked > 0 && !r.enough && <span className="pill late" title="Too few checked to trust this number yet"> thin</span>}</td>
          <td className="num">{r.wrong_category}</td>
          <td className="num">{r.not_complaint}</td>
          <td className="num muted">{r.waiting ?? ''}</td>
        </tr>
      ))}
    </>
  );
}

type CheckAnswer = { verdict: 'correct' | 'wrong_category' | 'not_complaint'; category?: string; cause?: string; contributing?: string[] };

function CauseAccuracyRows({ rows, label }: { rows: CauseTally[]; label: (k: string) => string }) {
  return (
    <>
      {rows.map((r) => (
        <tr key={r.key}>
          <td>{label(r.key)}</td>
          <td className="num">{r.checked}</td>
          <td className="num">{r.accuracy == null ? '—' : pct(r.accuracy)}{r.checked > 0 && !r.enough && <span className="pill late" title="Too few checked to trust this number yet"> thin</span>}</td>
          <td className="num">{r.wrong}</td>
        </tr>
      ))}
    </>
  );
}

// The codebook people check against: the same definitions Claude is given.
function CodebookPanel({ cb }: { cb: Codebook }) {
  return (
    <details className="card cmp-codebook">
      <summary><b>Root-cause codebook</b> <span className="muted small">· what each cause means, with examples and when not to use it</span></summary>
      {cb.groups.map((g) => (
        <div key={g.key}>
          <h3>{g.label}</h3>
          <dl className="kv">
            {cb.causes.filter((c) => c.group === g.key).map((c) => (
              <div key={c.key} className="cmp-code">
                <dt>{c.label}</dt>
                <dd>{c.definition}<br /><span className="small muted">e.g. “{c.examples.join('” · “')}”</span><br /><span className="small">Not this when: {c.not_when}</span></dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
      <p className="small muted">None of these fit, or the client doesn't say why? Pick <b>Other / not on the list</b>. If the same "other" keeps coming up, it's a candidate for a new cause.</p>
    </details>
  );
}

function CheckTab() {
  const qc = useQueryClient();
  const cb = useCodebook();
  const [category, setCategory] = useState('');
  const [source, setSource] = useState('');
  const [cause, setCause] = useState('');
  const [done, setDone] = useState<number[]>([]);
  const q = useQuery({ queryKey: ['complaints', 'review', category, source, cause], queryFn: () => complaintsApi.review({ category: category || undefined, source: source || undefined, cause: cause || undefined }), retry: false, refetchOnWindowFocus: false });
  const send = useMutation({
    mutationFn: (v: CheckAnswer & { id: number }) => complaintsApi.submitReview(v.id, { verdict: v.verdict, category: v.category, cause: v.cause, contributing: v.contributing }),
    onSuccess: (r, v) => {
      setDone((d) => [...d, v.id]);
      qc.setQueryData(['complaints', 'review', category, source, cause], (old: typeof q.data) => (old ? { ...old, stats: r.stats } : old));
      for (const k of ['playbook', 'cases', 'clients']) qc.invalidateQueries({ queryKey: ['complaints', k] });
    },
  });
  if (q.isError) return <section className="card seg-empty"><p className="muted">{(q.error as Error).message}</p></section>;
  if (!q.data) return <section className="card">Loading…</section>;
  const { stats } = q.data;
  const queue = q.data.queue.filter((c) => !done.includes(c.id));
  const t = stats.total;
  const ct = stats.cause;
  return (
    <>
      <section className="card">
        <h2>How accurate is the sorting?</h2>
        <p className="muted small">Each check answers two questions: is the <b>category</b> (what the client complained about) right, and is the <b>root cause</b> (why it happened) right. Both are measured against what the engine said before you looked.</p>
        <div className="cmp-arms">
          <div className="cmp-arm"><span className="small muted">Checked by a person</span><span className="cmp-arm-value">{t.checked}</span><span className="small muted">{stats.waiting} not checked yet</span></div>
          <div className="cmp-arm"><span className="small muted">Category was right</span><span className="cmp-arm-value">{t.accuracy == null ? '—' : pct(t.accuracy)}</span><span className="small muted">{t.checked < stats.min_checks ? `Needs at least ${stats.min_checks} checks to mean anything` : `${t.correct} of ${t.checked}`}</span></div>
          <div className="cmp-arm"><span className="small muted">Wrong category</span><span className="cmp-arm-value">{t.wrong_category}</span><span className="small muted">Fixed when you pick the right one</span></div>
          <div className="cmp-arm"><span className="small muted">Not a complaint at all</span><span className="cmp-arm-value">{t.not_complaint}</span><span className="small muted">Taken out of the playbook</span></div>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>What the engine said</th><th className="num">Checked</th><th className="num">Right</th><th className="num">Wrong category</th><th className="num">Not a complaint</th><th className="num">Waiting</th></tr></thead>
            <tbody>
              <AccuracyRows rows={stats.by_category} label={catLabel} />
              {stats.by_source.length > 0 && <tr><th colSpan={6}>By where it came from</th></tr>}
              <AccuracyRows rows={stats.by_source} label={(k) => SOURCE_LABEL[k] || k} />
              {stats.by_classifier.length > 0 && <tr><th colSpan={6}>By who sorted it</th></tr>}
              <AccuracyRows rows={stats.by_classifier} label={(k) => (k === 'claude' ? 'Claude' : k === 'rules' ? 'Keyword rules' : k)} />
            </tbody>
          </table>
        </div>
        {stats.confusions.length > 0 && (
          <>
            <h3>Most common mix-ups</h3>
            <ul>{stats.confusions.map((c) => <li key={`${c.from}>${c.to}`}>{catLabel(c.from)} → should be <b>{catLabel(c.to)}</b> ({c.n})</li>)}</ul>
          </>
        )}
        <h3>Root causes</h3>
        <div className="cmp-arms">
          <div className="cmp-arm"><span className="small muted">Root causes checked</span><span className="cmp-arm-value">{ct.total.checked}</span><span className="small muted">checks from before root causes don't count here</span></div>
          <div className="cmp-arm"><span className="small muted">Root cause was right</span><span className="cmp-arm-value">{ct.total.accuracy == null ? '—' : pct(ct.total.accuracy)}</span><span className="small muted">{ct.total.checked < stats.min_checks ? `Needs at least ${stats.min_checks} checks to mean anything` : `${ct.total.correct} of ${ct.total.checked}`}</span></div>
        </div>
        {ct.total.checked > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Root cause the engine gave</th><th className="num">Checked</th><th className="num">Right</th><th className="num">Wrong</th></tr></thead>
              <tbody>
                <CauseAccuracyRows rows={ct.by_cause} label={(k) => (k === 'none' ? 'None given' : causeName(cb, k))} />
                <tr><th colSpan={4}>By who set it</th></tr>
                <CauseAccuracyRows rows={ct.by_setter} label={(k) => CAUSE_BY_LABEL[k] || k} />
              </tbody>
            </table>
          </div>
        )}
        {ct.confusions.length > 0 && (
          <>
            <h3>Most common root-cause mix-ups</h3>
            <ul>{ct.confusions.map((c) => <li key={`${c.from}>${c.to}`}>{c.from === 'none' ? 'None given' : causeName(cb, c.from)} → should be <b>{causeName(cb, c.to)}</b> ({c.n})</li>)}</ul>
          </>
        )}
      </section>
      {cb && <CodebookPanel cb={cb} />}
      <section className="card cmp-filter">
        <label className="cmp-date">Category
          <select value={category} onChange={(e) => { setCategory(e.target.value); setDone([]); }}>
            <option value="">All (20 random from each)</option>
            {Object.keys(CATEGORY_LABEL).map((k) => <option key={k} value={k}>{catLabel(k)}</option>)}
          </select>
        </label>
        <label className="cmp-date">Source
          <select value={source} onChange={(e) => { setSource(e.target.value); setDone([]); }}>
            <option value="">All sources</option>
            {['kustomer', 'gmail', 'launch27_rating', 'slack'].map((k) => <option key={k} value={k}>{SOURCE_LABEL[k]}</option>)}
          </select>
        </label>
        <label className="cmp-date">Root cause
          <select value={cause} onChange={(e) => { setCause(e.target.value); setDone([]); }}>
            <option value="">All root causes</option>
            {cb && <CauseOptions cb={cb} />}
            <option value="other">Other / not on the list</option>
          </select>
        </label>
        <span className="muted small">{queue.length} to check in this batch</span>
        <button className="link" onClick={() => { setDone([]); q.refetch(); }}>New batch</button>
      </section>
      {send.isError && <p className="cmp-note">{(send.error as Error).message}</p>}
      {queue.length === 0 && <section className="card seg-empty"><p className="muted">Nothing left to check here. Pick another category or source, or get a new batch.</p></section>}
      {cb && queue.slice(0, 10).map((c) => <CheckCard key={c.id} c={c} cb={cb} busy={send.isPending} onAnswer={(a) => send.mutate({ id: c.id, ...a })} />)}
      {queue.length > 10 && <p className="muted small">{queue.length - 10} more appear as you go.</p>}
    </>
  );
}

function CheckCard({ c, cb, busy, onAnswer }: { c: ReviewItem; cb: Codebook; busy: boolean; onAnswer: (a: CheckAnswer) => void }) {
  const [category, setCategory] = useState(c.category);
  const [cause, setCause] = useState(c.cause || '');
  const [also, setAlso] = useState<string[]>((c.contributing_causes || []).filter((k) => k !== c.cause).slice(0, 2));
  const def = cb.causes.find((x) => x.key === cause);
  const changedCategory = category !== c.category;
  const save = () => onAnswer({ verdict: changedCategory ? 'wrong_category' : 'correct', category: changedCategory ? category : undefined, cause, contributing: also.filter((k) => k && k !== cause) });
  const setAlsoAt = (i: number, v: string) => setAlso((a) => { const n = [...a]; n[i] = v; return n.filter(Boolean); });
  return (
    <section className="card cmp-check">
      <div className="cmp-runbar">
        <h3><span className="pill">{catLabel(c.category)}</span> {c.customer_name || 'Unmatched client'} · {day(c.opened_at)}</h3>
        <span className="muted small">{SOURCE_LABEL[c.source] || c.source} · sorted by {c.classified_by === 'claude' ? 'Claude' : 'keyword rules'}</span>
      </div>
      {c.text && <blockquote className="cmp-quote">{c.text}</blockquote>}
      {c.summary ? <p>{c.text ? <span className="muted small">Engine's summary: </span> : null}{c.summary}</p> : !c.text && <p className="muted">No text stored for this case{c.original_url ? ': open the email to check it' : ''}.</p>}
      <dl className="kv">
        {c.title && (<><dt>Subject</dt><dd>{c.title}</dd></>)}
        {c.source_status && (<><dt>Kustomer status</dt><dd>{c.source_status}</dd></>)}
        {c.rating != null && (<><dt>Rating</dt><dd>Unhappy rating in Launch27</dd></>)}
        <dt>Tone · severity</dt><dd>{c.tone ? TONE_LABEL[c.tone] : '—'} · {c.severity ?? '—'}/4{c.hard_route ? ` · hard route: ${c.hard_route.replace(/_/g, ' ')}` : ''}</dd>
        {c.areas_cited?.length > 0 && (<><dt>Areas</dt><dd>{c.areas_cited.join(', ')}</dd></>)}
        <dt>What we did</dt><dd>{whatWeDid(c.rungs)}{c.resolution_text ? ` · ${c.resolution_text}` : ''}</dd>
        <dt>Engine's root cause</dt>
        <dd>
          {c.cause ? <b>{causeName(cb, c.cause)}</b> : <span className="muted">none given</span>}
          {c.cause_by && <span className="muted small"> · by {CAUSE_BY_LABEL[c.cause_by] || c.cause_by}</span>}
          {c.cause_evidence && <><br /><span className="small">“{c.cause_evidence}”</span></>}
        </dd>
        <dt>From Launch27</dt>
        <dd>{c.facts.length ? c.facts.map((f) => <div key={f.cause} className="small">{f.text} <span className="muted">→ points at “{causeName(cb, f.cause)}”</span></div>) : <span className="muted small">Nothing that points at a cause{c.cleaner_name ? ` (cleaner: ${c.cleaner_name})` : ''}.</span>}</dd>
      </dl>
      <div className="cmp-check-grid">
        <label>What they complained about
          <select value={category} disabled={busy} onChange={(e) => setCategory(e.target.value)}>
            {Object.keys(CATEGORY_LABEL).map((k) => <option key={k} value={k}>{catLabel(k)}{k === c.category ? ' (engine)' : ''}</option>)}
          </select>
        </label>
        <label>Why it happened (root cause)
          <select value={cause} disabled={busy} onChange={(e) => { setCause(e.target.value); setAlso((a) => a.filter((k) => k !== e.target.value)); }}>
            <option value="">Pick one…</option>
            <CauseOptions cb={cb} />
            <option value="other">Other / not on the list</option>
          </select>
        </label>
        <label>Also a factor (optional)
          <span className="cmp-also">
            {[0, 1].map((i) => (
              <select key={i} value={also[i] || ''} disabled={busy || (i === 1 && !also[0])} onChange={(e) => setAlsoAt(i, e.target.value)} aria-label={`Contributing cause ${i + 1}`}>
                <option value="">—</option>
                <CauseOptions cb={cb} exclude={[cause, ...also.filter((_, j) => j !== i)]} />
              </select>
            ))}
          </span>
        </label>
      </div>
      {def && <p className="small cmp-def"><b>{def.label}:</b> {def.definition} <span className="muted">Not this when: {def.not_when}</span></p>}
      <div className="cmp-check-actions">
        <button disabled={busy || !cause} onClick={save} title={cause ? undefined : 'Pick the root cause first'}>{changedCategory ? 'Save: category fixed' : 'Save check'}</button>
        <button className="secondary" disabled={busy} onClick={() => onAnswer({ verdict: 'not_complaint' })}>Not a complaint</button>
        {c.original_url && <a href={c.original_url} target="_blank" rel="noreferrer" className="small">Open the email</a>}
      </div>
    </section>
  );
}

function RulesTab({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['complaints', 'settings'], queryFn: complaintsApi.settings });
  const pb = useQuery({ queryKey: ['complaints', 'playbook'], queryFn: () => complaintsApi.playbook(), retry: false });
  const users = useQuery({ queryKey: ['inbox', 'users'], queryFn: async () => (await fetch('/api/users', { credentials: 'same-origin' })).json() as Promise<{ email: string; name: string | null }[]> });
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => {
    if (q.data && !s) setS(q.data.settings);
  }, [q.data, s]);
  const save = useMutation({ mutationFn: (x: Settings) => complaintsApi.saveSettings(x), onSuccess: (r) => { setS(r.settings); qc.invalidateQueries({ queryKey: ['complaints'] }); } });
  if (!q.data || !s) return <p className="muted">Loading…</p>;
  const base = pb.data?.baseline;
  const target = s.budget.target_pct ?? base?.default_target ?? null;
  const set = (patch: Partial<Settings>) => setS({ ...s, ...patch });
  return (
    <fieldset disabled={!canEdit} className="cmp-rules">
      {!canEdit && <p className="muted small">Only admins can change these.</p>}
      <section className="card">
        <h2>Who approves what</h2>
        <label>Setup{' '}
          <select value={s.approval_preset} onChange={(e) => { const preset = e.target.value as Settings['approval_preset']; set({ approval_preset: preset, max_rung: {} }); }}>
            {Object.entries(q.data.presets).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </label>
        <table>
          <thead><tr><th>Role</th><th>Can approve up to</th></tr></thead>
          <tbody>
            {Object.entries(s.max_rung).map(([role, rung]) => (
              <tr key={role} className="static"><td>{role.replace('_', ' ')}</td><td>{q.data.rungs.find((r) => r.rung === rung)?.name}{role === 'owner' ? ' (only the owner can approve above 50%)' : ''}</td></tr>
            ))}
          </tbody>
        </table>
        <h3>Roles</h3>
        <p className="muted small">Everyone not listed is frontline. Office Manager is a role, so hard-routed cases follow whoever holds it.</p>
        <table>
          <tbody>
            {(users.data || []).map((u) => (
              <tr key={u.email} className="static">
                <td>{u.name || u.email}</td>
                <td>
                  <select value={s.roles[u.email.toLowerCase()] || 'frontline'} onChange={(e) => set({ roles: { ...s.roles, [u.email.toLowerCase()]: e.target.value } })}>
                    {['frontline', 'office_manager', 'gm', 'owner'].map((r) => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Refund budget</h2>
        <p className="muted small">Month-to-date refunds + credits + recleans as a share of month-to-date Residential revenue. Amber at 80% of target, red at 100% (banner + Slack DM to the owner). Frontline is never blocked, only flagged.</p>
        <label className="cmp-slider">
          Target: <b>{pct(target, 2)}</b>
          <input type="range" min={0} max={0.05} step={0.0005} value={target ?? 0} onChange={(e) => set({ budget: { ...s.budget, target_pct: Number(e.target.value) } })} />
        </label>
        {base && <p className="small">History: average {pct(base.average, 2)} · best {base.best ? pct(base.best.rate, 2) : '—'} · worst {base.worst ? pct(base.worst.rate, 2) : '—'} · default {pct(base.default_target, 2)}</p>}
        {s.budget.target_pct != null && <button className="link" onClick={() => set({ budget: { ...s.budget, target_pct: null } })}>Use the default (20% below average)</button>}
      </section>

      <section className="card">
        <h2>Cost assumptions</h2>
        <p className="muted small">Used when the real figure isn't in Launch27 (most recleans use the cleaner's actual pay for that visit).</p>
        <div className="grid-3">
          {([
            ['cleaner_hourly_default', 'Cleaner pay per hour ($)'],
            ['margin_per_hour_default', 'Gross margin per booked hour ($): the lost slot'],
            ['travel_per_visit', 'Travel per reclean visit ($)'],
            ['reclean_default_hours', 'Reclean hours when unknown'],
            ['reclean_spot_share', 'Spot reclean as a share of a full one'],
          ] as const).map(([k, label]) => (
            <label key={k}>{label}<input type="number" step="0.1" value={s.costs[k]} onChange={(e) => set({ costs: { ...s.costs, [k]: Number(e.target.value) } })} /></label>
          ))}
          <label>Credit expiry (days)<input type="number" value={s.credit_expiry_days} onChange={(e) => set({ credit_expiry_days: Number(e.target.value) })} /></label>
          <label>Keep this many months of history (1–12)<input type="number" min={1} max={12} value={s.auto.history_months} onChange={(e) => set({ auto: { ...s.auto, history_months: Number(e.target.value) } })} /></label>
          <label className="check"><input type="checkbox" checked={s.auto.enabled} onChange={(e) => set({ auto: { ...s.auto, enabled: e.target.checked } })} /> Update automatically every day</label>
        </div>
      </section>
      {canEdit && (
        <div className="actions end">
          {save.isError && <span className="error">{(save.error as Error).message}</span>}
          <button onClick={() => save.mutate(s)} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save rules'}</button>
        </div>
      )}
    </fieldset>
  );
}
