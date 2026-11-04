import { useBrand } from '../brands/useBrand';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { scheduleApi, type PlanCell } from '../schedule/api';
import { CleanerDot, FreqPill, ScheduleStatus, niceDate } from '../schedule/ui';

export function CleanerPlanPage() {
  const { id } = useParams();
  const cid = Number(id);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const plan = useQuery({ queryKey: ['schedule', 'plan', cid], queryFn: () => scheduleApi.plan(cid), retry: false });
  const brand = useBrand();
  const cleaners = useQuery({ queryKey: ['schedule', 'overview', null], queryFn: () => scheduleApi.overview(), retry: false });
  const [gap, setGap] = useState<{ date: string; start: number; end: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const unavailable = useMutation({
    mutationFn: ({ day, on }: { day: string; on: boolean }) => scheduleApi.unavailable(cid, day, on),
    onSuccess: (r) => {
      setToast(r.unavailable ? `${r.cleaner} marked unavailable on ${niceDate(r.day)}.${r.affected ? ` ${r.affected} visit${r.affected === 1 ? '' : 's'} added to Changes to handle.` : ''}` : `${r.cleaner} is available again on ${niceDate(r.day)}.`);
      queryClient.invalidateQueries({ queryKey: ['schedule'] });
    },
  });
  const p = plan.data;
  if (plan.isError) return <div className="error">{(plan.error as Error).message}</div>;
  if (!p) return <p className="muted">Loading…</p>;
  const maxWeek = Math.max(...p.weeks.map((w) => w.booked), 1);
  const others = (cleaners.data?.rows || []).filter((r) => r.assignable && brand.showCleaner(r.location_ids));
  return (
    <div className="sch-page">
      <nav className="small muted"><Link to="/schedule?tab=capacity">Scheduling</Link> / {p.cleaner.name}</nav>
      <header className="page-header">
        <div className="seg-head">
          <h1>{p.cleaner.name}'s plan</h1>
          <p className="muted">The next 4 weeks are one full cycle: weekly clients appear every week, biweekly every other week (A/C or B/D), monthly once.</p>
          <ScheduleStatus />
        </div>
        <label className="sch-switch">
          <span className="sr-only">Switch cleaner</span>
          <select value={cid} onChange={(e) => { setGap(null); navigate(`/schedule/cleaner/${e.target.value}`); }}>
            {others.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            {!others.some((r) => r.id === cid) && <option value={cid}>{p.cleaner.name}</option>}
          </select>
        </label>
      </header>

      <section className="card sch-plan-head">
        <div className="sch-who"><CleanerDot color={p.cleaner.color} /><div><b>{p.cleaner.name}</b><div className="muted small">{p.cleaner.status_label} · {p.cleaner.area}{p.cleaner.hours_type ? ` · ${p.cleaner.hours_type}` : ''}{p.cleaner.rules.transit ? ' · public transit' : ''}{p.cleaner.rules.maxTravelMin ? ` · max ${p.cleaner.rules.maxTravelMin} min travel` : ''}</div></div></div>
        <div><span className="muted small">Booked per week</span><b className="sch-big">{p.avg_booked}h <span className="muted small">of {p.cleaner.weekly_hours}h</span></b></div>
        <div className="sch-weekbars" aria-label="Hours by week of the cycle">
          {p.weeks.map((w) => (
            <span key={w.from} className="sch-weekbar"><span className="small">{w.booked}h</span><i style={{ height: `${Math.max((w.booked / maxWeek) * 34, 3)}px` }} className={w.capacity && w.booked / w.capacity > 0.9 ? 'full' : ''} /><b className="small">{w.cycle}</b></span>
          ))}
        </div>
        <div><span className="muted small">Their usual clients</span><b className="sch-big">{p.home_clients} <span className="muted small">of {p.clients} recurring</span></b></div>
        <div className="sch-hint">{p.hint}</div>
      </section>
      {toast && <div className="sch-toast" role="status">{toast} <button className="link" onClick={() => setToast(null)}>OK</button></div>}

      <div className="sch-plan-wrap">
        <section className="card flush sch-plan-grid-card">
          <div className="table-scroll">
            <div className="sch-plan-grid" style={{ gridTemplateColumns: `88px repeat(${p.days.length}, minmax(124px, 1fr))` }}>
              <div className="sch-gh" />
              {p.days.map((d) => <div key={d} className="sch-gh"><b>{d}</b></div>)}
              {p.weeks.map((w) => (
                <Row key={w.from} label={`Week ${w.cycle}`} sub={`${niceDate(w.from, true)} · ${w.booked}h`} cells={w.cells} selected={gap} onGap={(g) => setGap(g)} onUnavailable={(day, on) => unavailable.mutate({ day, on })} busy={unavailable.isPending} />
              ))}
            </div>
          </div>
          <div className="sch-legend">
            <span><i className="sch-freq f-weekly" />Weekly</span>
            <span><i className="sch-freq f-bi" />Biweekly</span>
            <span><i className="sch-freq f-monthly" />Monthly</span>
            <span><i className="sch-freq f-one" />One-time</span>
            <span><span className="sch-p">P</span>Prepaid</span>
            <span><i className="sch-gapkey" />Open time</span>
          </div>
        </section>
        <aside className="sch-side">{gap ? <GapPanel cleanerId={cid} gap={gap} onDone={setToast} /> : <div className="card muted">Click an open slot to see who could fill it.</div>}</aside>
      </div>
    </div>
  );
}

function Row({ label, sub, cells, selected, onGap, onUnavailable, busy }: { label: string; sub: string; cells: PlanCell[]; selected: { date: string; start: number } | null; onGap: (g: { date: string; start: number; end: number }) => void; onUnavailable: (day: string, on: boolean) => void; busy: boolean }) {
  return (
    <>
      <div className="sch-rh"><b>{label}</b><span className="muted small">{sub}</span></div>
      {cells.map((c) => (
        <div key={c.date} className={`sch-cell${c.off ? ' off' : ''}${c.past ? ' past' : ''}`}>
          <div className="sch-cell-head">
            <span className="small">{niceDate(c.date, true)}</span>
            {!c.past && (c.unavailable
              ? <button className="link small" disabled={busy} onClick={() => onUnavailable(c.date, false)}>Available again</button>
              : !c.off && <button className="link small" disabled={busy} onClick={() => onUnavailable(c.date, true)} title="Mark unavailable this day">Mark off</button>)}
          </div>
          {c.unavailable && <span className="small warn">Marked unavailable</span>}
          {c.visits.map((v) => (
            <Link key={v.key} to={v.id ? `/bookings/${v.id}` : '#'} className={`sch-visit f-${v.kind}`}>
              <span className="sch-visit-top"><b>{v.time}</b><FreqPill visit={v} /></span>
              <span className="sch-visit-name">{v.customer}</span>
              <span className="small muted">{Math.round((v.duration / 60) * 10) / 10}h{v.area ? ` · ${v.area}` : ''}</span>
            </Link>
          ))}
          {c.gaps.map((g) => (
            <button key={g.start} className={selected?.date === c.date && selected.start === g.start ? 'sch-gap on' : 'sch-gap'} onClick={() => onGap({ date: c.date, start: g.start, end: g.end })}>+ Open {g.label} · {g.hours}h</button>
          ))}
          {c.off && !c.visits.length && <span className="small muted">Not working</span>}
        </div>
      ))}
    </>
  );
}

function GapPanel({ cleanerId, gap, onDone }: { cleanerId: number; gap: { date: string; start: number; end: number }; onDone: (m: string) => void }) {
  const queryClient = useQueryClient();
  const data = useQuery({ queryKey: ['schedule', 'gap', cleanerId, gap.date, gap.start], queryFn: () => scheduleApi.gap(cleanerId, gap.date, gap.start, gap.end) });
  const assign = useMutation({
    mutationFn: (key: string) => scheduleApi.assign([key], cleanerId),
    onSuccess: (r) => {
      onDone(`Assigned to ${r.cleaner}.${r.confirm_first ? ` ${r.cleaner} asks to be called or texted to confirm.` : ''}`);
      queryClient.invalidateQueries({ queryKey: ['schedule'] });
    },
  });
  const d = data.data;
  return (
    <section className="card sch-gap-panel">
      <span className="eyebrow">Fill this gap</span>
      <b>{niceDate(gap.date)} · {d?.gap.label || '…'}</b>
      {d && d.options.length === 0 && <p className="muted small">Nothing unassigned fits here right now. New bookings in this area can use it: try <Link to="/schedule?tab=find">Find a slot</Link>.</p>}
      {d?.options.map((o) => (
        <div key={`${o.type}-${o.visit.key}`} className="sch-option">
          <b>{o.title}</b>
          <span className="small">{o.detail}{o.distance_km != null ? ` · ${o.distance_km} km away` : ''}</span>
          {o.action === 'assign'
            ? <button disabled={assign.isPending} onClick={() => assign.mutate(o.visit.key)}>Give it to this cleaner</button>
            : <span className="small muted">Contact the customer before moving their visit, then change it in the booking.</span>}
        </div>
      ))}
      {assign.isError && <div className="error small">{(assign.error as Error).message}</div>}
    </section>
  );
}
