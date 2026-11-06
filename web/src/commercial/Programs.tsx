// Commercial › Programs: hospital transition patients against the 4/2/1 plan.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Kpi, NotBuilt, ReportStatusLine } from '../reports/ui';
import { commercialApi, type Patient, type Program } from './api';
import { clockOf, niceDate, pct0 } from './ui';

const STAGE: Record<Patient['stage'], string> = { weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly' };
const monthLabel = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', timeZone: 'UTC' });

export function ProgramsPage() {
  const data = useQuery({ queryKey: ['commercial', 'programs'], queryFn: commercialApi.programs, retry: false });
  const [pick, setPick] = useState<string | null>(null);
  const d = data.data;
  const p = d?.programs.find((x) => x.code === pick) || d?.programs[0];
  return (
    <div className="seg-page">
      <header className="page-header">
        <div className="seg-head">
          <span className="small muted">Commercial</span>
          <h1>Hospital programs</h1>
          <p className="muted">Each patient gets 7 visits: 4 weekly, then 2 every two weeks, then 1 monthly. This page shows where every patient is, and flags visits that drift from the plan or aren't booked yet.</p>
          <ReportStatusLine />
        </div>
      </header>
      {data.isError && <NotBuilt message={(data.error as Error).message} />}
      {d && !d.programs.length && <div className="card muted">No hospital program visits found yet.</div>}
      {d && p && (
        <>
          <div className="seg-filter" role="tablist" aria-label="Program">
            {d.programs.map((x) => (
              <button key={x.code} role="tab" aria-selected={x.code === p.code} className={x.code === p.code ? 'chip-btn active' : 'chip-btn'} onClick={() => setPick(x.code)}>
                {x.name} <span className="seg-chip-count">{x.active}</span>
              </button>
            ))}
          </div>
          <ProgramView p={p} />
        </>
      )}
    </div>
  );
}

function ProgramView({ p }: { p: Program }) {
  const maxNew = Math.max(1, p.expected_per_month || 0, ...p.new_by_month.map((m) => m.patients));
  const needs = p.patients.filter((x) => x.state === 'active' && (x.unbooked || x.flags.some((f) => !f.past)));
  return (
    <>
      <div className="seg-stats">
        <Kpi label="Patients in the program now" value={String(p.active)} note={`${p.stages.weekly} weekly · ${p.stages.biweekly} every 2 weeks · ${p.stages.monthly} monthly`} />
        <Kpi label="Next visit not booked" value={String(p.unbooked)} note="due within a week or overdue" tone={p.unbooked ? 'warn' : undefined} />
        <Kpi label="Off the plan" value={String(p.off_plan)} note="a visit came sooner or later than planned" tone={p.off_plan ? 'warn' : undefined} />
        <Kpi label="Finished all 7 on plan" value={pct0(p.completed_share)} note={p.typical_visits ? `most patients get ${p.typical_visits} visits` : ''} />
      </div>
      <div className="seg-two">
        <section className="card">
          <div className="seg-section-head"><h2>New patients by month</h2>{p.expected_per_month ? <span className="muted small">agreed: about {p.expected_per_month} a month</span> : <span className="muted small">volume not agreed yet</span>}</div>
          <div className="com-months">
            {p.new_by_month.map((m) => (
              <div key={m.month} className="com-month">
                <span className="com-month-bar"><span style={{ height: `${(m.patients / maxNew) * 100}%` }} /></span>
                <b>{m.patients}</b>
                <span className="muted small">{monthLabel(m.month)}</span>
              </div>
            ))}
            {p.expected_per_month ? <span className="com-expected" style={{ bottom: `calc(${(p.expected_per_month / maxNew) * 100}% * 0.72 + 44px)` }} aria-hidden="true" /> : null}
          </div>
        </section>
        <section className="card">
          <div className="seg-section-head"><h2>Needs action</h2><span className="muted small">{needs.length} patients</span></div>
          {!needs.length && <p className="muted">Every patient's next visit is booked on plan.</p>}
          <ul className="com-actions">
            {needs.slice(0, 8).map((x) => (
              <li key={`${x.client}-${x.first}`}>
                <b>{x.name}</b> <span className="muted small">· visit {x.done} of 7 done</span>
                <div className="small">{x.unbooked ? `${x.next_label} visit due ${niceDate(x.next_planned)}, not booked` : `Visit ${x.flags.find((f) => !f.past)?.visit} is booked ${x.flags.find((f) => !f.past)?.gap} days after the one before; the plan says ${x.flags.find((f) => !f.past)?.planned}`}</div>
                <Link className="small" to={`/schedule?tab=find&customer=${x.client}&name=${encodeURIComponent(x.name)}`}>Find a slot</Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <section className="card flush">
        <div className="seg-table-head"><h2>Patients <span className="muted">· {p.patients.length}</span></h2><span className="muted small">In the program now, and those who finished in the last 60 days</span></div>
        <div className="table-scroll">
          <table className="seg-table">
            <thead><tr><th>Patient</th><th>Progress</th><th>Now</th><th>Next visit</th><th>Cleaner</th><th>Plan</th></tr></thead>
            <tbody>
              {p.patients.map((x) => (
                <tr key={`${x.client}-${x.first}`}>
                  <td><b>{x.name}</b>{x.addr && x.addr !== x.name && <div className="muted small">{x.addr}</div>}<div className="muted small">since {niceDate(x.first)}</div></td>
                  <td><Dots p={x} /></td>
                  <td>{x.state === 'active' ? <span className={`com-pill ${x.stage === 'weekly' ? 'wk' : x.stage === 'biweekly' ? 'bi' : 'mo'}`}>{STAGE[x.stage]}</span> : x.state === 'finished' ? <span className="com-pill flat">Finished</span> : <span className="com-pill down">Ended after {x.visits}</span>}</td>
                  <td>{x.next_booked ? <>{niceDate(x.next_booked.date)} {clockOf(x.next_booked.time)}{!x.next_booked.cleaner && <span className="com-pill down"> No cleaner</span>}</> : x.state === 'active' && x.next_planned ? <span className={x.unbooked ? 'warn' : 'muted'}>{x.next_label} due {niceDate(x.next_planned)}{x.unbooked ? ' · not booked' : ''}</span> : '—'}</td>
                  <td>{x.next_booked?.cleaner || x.cleaner || '—'}</td>
                  <td>{x.flags.length ? <span className="com-pill down" title={x.flags.map((f) => `Visit ${f.visit}: ${f.gap} days after the one before (plan: ${f.planned})`).join('\n')}>{x.flags.length} off plan</span> : <span className="com-pill flat">On plan</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

// 7 dots: done, booked, still to book.
function Dots({ p }: { p: Patient }) {
  const off = new Set(p.flags.map((f) => f.visit));
  return (
    <span className="com-dots" aria-label={`${p.done} of 7 visits done, ${p.booked} booked`}>
      {Array.from({ length: 7 }, (_, i) => {
        const n = i + 1;
        const cls = n <= p.done ? 'done' : n <= p.done + p.booked ? 'booked' : 'todo';
        return <span key={n} className={`com-dot ${cls}${off.has(n) ? ' off' : ''}`} title={`Visit ${n}${off.has(n) ? ' (off plan)' : ''}`} />;
      })}
      {p.extra > 0 && <span className="small muted"> +{p.extra}</span>}
    </span>
  );
}
