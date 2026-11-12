// Commercial › Workforce plan: moving Commercial visits to the Commercial team.
// The Commercial lead's planner, on live Launch27 data: no exports or imports. Nothing here
// changes Launch27: people make each approved change there.
import { useMemo, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocations } from '../hooks';
import { useBrandsData } from '../brands/useBrand';
import { brandForLocation } from '../brands/rules';
import { ago, useInboxMe } from '../inbox/util';
import { clockOf, niceDate } from './ui';
import { workforceApi, type Action, type BlockType, type MoveStatus, type Plan, type Scope, type Slots, type Team } from './workforceApi';

type Tab = 'plan' | 'board' | 'slots' | 'team';
const TABS: [Tab, string][] = [['plan', 'Weekly plan'], ['board', 'Week board'], ['slots', 'Open slots'], ['team', 'Commercial team']];
const DAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const RHYTHM: Record<string, string> = { weekly: 'Weekly', bi: 'Every 2 weeks', tri: 'Every 3 weeks', monthly: 'Monthly', one: 'One-time' };
const STATUS: Record<MoveStatus, string> = { proposed: 'Proposed', approved: 'Approved', done: 'Done in Launch27', hold: 'On hold' };
const shift = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const shortDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const hrs = (m: number) => `${Math.round((m / 60) * 10) / 10} h`;
const when = (a: { weekday: number; start: number; duration: number; rhythm: string }) => `${DAY[a.weekday]} ${clockOf(a.start)} · ${hrs(a.duration)} · ${RHYTHM[a.rhythm] || a.rhythm}`;

/** The Commercial locations (whatever brand is being viewed), and which of them are Cornwall. */
function useCommercialScope(): Scope | null {
  const locations = useLocations();
  const brands = useBrandsData();
  return useMemo(() => {
    if (!locations.data || !brands.data) return null;
    const com = locations.data.filter((l) => brandForLocation(l.id, l.name, brands.data.overrides || {}) === 'commercial');
    return { locations: com.map((l) => l.id), cornwall: com.filter((l) => /cornwall/i.test(l.name)).map((l) => l.id) };
  }, [locations.data, brands.data]);
}

export function WorkforcePage() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some(([t]) => t === params.get('tab')) ? params.get('tab') : 'plan') as Tab;
  const week = params.get('week');
  const scope = useCommercialScope();
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) if (v) next.set(k, v); else next.delete(k);
    setParams(next, { replace: true });
  };
  const plan = useQuery({ queryKey: ['commercial', 'workforce', 'plan', scope, week], queryFn: () => workforceApi.plan(scope!, week), enabled: !!scope?.locations.length, retry: false, placeholderData: (p) => p, refetchInterval: 3 * 60_000 });
  const p = plan.data;
  return (
    <div className="seg-page">
      <header className="page-header">
        <div className="seg-head">
          <span className="small muted">Commercial</span>
          <h1>Workforce plan</h1>
          <p className="muted">Moving Commercial visits to the Commercial team: who should take each visit, where cover is missing, and which slots are open for partners. Read live from Launch27{p ? ` (updated ${ago(p.taken_at) === 'now' ? 'just now' : `${ago(p.taken_at)} ago`})` : ''}; every change is still made in Launch27.</p>
        </div>
        {(tab === 'plan' || tab === 'board') && p && (
          <div className="actions wf-week">
            <button type="button" className="secondary" aria-label="Previous week" onClick={() => set({ week: shift(p.week, -7) })}>‹</button>
            <button type="button" className="secondary" onClick={() => set({ week: null })}>This week</button>
            <button type="button" className="secondary" aria-label="Next week" onClick={() => set({ week: shift(p.week, 7) })}>›</button>
            <strong>{shortDate(p.week)} – {shortDate(p.week_end)}</strong>
          </div>
        )}
      </header>
      <div className="tabs">
        {TABS.map(([t, label]) => (
          <button key={t} className={tab === t ? 'tab active' : 'tab'} onClick={() => set({ tab: t === 'plan' ? null : t })}>{label}</button>
        ))}
      </div>
      {scope && !scope.locations.length && <div className="card">No location is marked Commercial yet. Set them under <Link to="/inbox-settings?tab=brands">Support settings → Brands</Link>.</div>}
      {plan.isError && <div className="card error">{(plan.error as Error).message}</div>}
      {!p && plan.isLoading && <div className="muted">Loading the plan…</div>}
      {scope && p && tab === 'plan' && <PlanTab plan={p} />}
      {scope && p && tab === 'board' && <BoardTab plan={p} />}
      {scope && scope.locations.length > 0 && tab === 'slots' && <SlotsTab scope={scope} />}
      {scope && scope.locations.length > 0 && tab === 'team' && <TeamTab scope={scope} />}
    </div>
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
const Client = ({ a }: { a: { account: string; client: string; addr: string | null; area: string | null; category: string } }) => (
  <>
    <strong>{a.account === a.client ? a.client : `${a.account} · ${a.client}`}</strong>
    <div className="muted small">{[a.addr, a.area].filter(Boolean).join(', ') || a.category}</div>
  </>
);

// ---------- weekly plan ----------
function PlanTab({ plan }: { plan: Plan }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const save = useMutation({
    mutationFn: ({ key, patch }: { key: string; patch: Parameters<typeof workforceApi.setMove>[1] }) => workforceApi.setMove(key, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['commercial', 'workforce'] }),
    onError: (e) => setError((e as Error).message),
  });
  const t = plan.totals;
  const by = (k: Action['kind']) => plan.actions.filter((a) => a.kind === k);
  const peak = Object.entries(plan.peak).sort((a, b) => DAY.indexOf(a[0]) - DAY.indexOf(b[0]));
  const StatusSelect = ({ a }: { a: Action }) => (
    <select value={a.state} aria-label="Status" onChange={(e) => save.mutate({ key: a.key, patch: { status: e.target.value as MoveStatus, ...(a.pick && e.target.value !== 'hold' ? { assignee_id: a.pick.id } : {}) } })}>
      {(Object.keys(STATUS) as MoveStatus[]).map((s) => <option key={s} value={s}>{STATUS[s]}</option>)}
    </select>
  );
  const copy = async () => {
    const lines = [`Commercial workforce plan · week of ${shortDate(plan.week)}`, ''];
    for (const a of by('move')) lines.push(`MOVE  ${a.account} · ${a.client} · ${when(a)} · from ${a.holders.map((h) => h.name).join(', ')} to ${a.pick?.name} (${STATUS[a.state]})`);
    for (const a of by('nocover')) lines.push(`NO COVER  ${a.account} · ${a.client} · ${when(a)} · stays with ${a.holders.map((h) => h.name).join(', ')}`);
    for (const u of plan.unassigned) lines.push(`NO CLEANER  ${u.account} · ${u.client} · ${when(u)} · ${u.dates.map(shortDate).join(', ')} · try ${u.commercial[0]?.name || u.others[0]?.name || 'nobody free'}`);
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setError('Could not copy. Your browser blocked the clipboard.');
    }
  };
  return (
    <>
      <div className="tiles">
        <Tile label="Commercial visits" value={String(t.visits)} sub={`${t.hours} cleaner hours`} />
        <Tile label="Already on the Commercial team" value={`${Math.round(t.on_team_share * 100)}%`} sub={`${t.team} cleaners on the team`} tone={t.on_team_share >= 0.9 ? 'ok' : undefined} />
        <Tile label="To move" value={String(t.move)} sub="a Commercial cleaner can take them" />
        <Tile label="No Commercial cover" value={String(t.nocover)} sub={t.nocover ? `${t.nocover_hours} hours a week` : 'everything is covered'} tone={t.nocover ? 'neg' : 'ok'} />
        <Tile label="Stay until the program ends" value={String(t.stay)} sub="transition-program clients" />
        <Tile label="Visits with no cleaner" value={String(t.unassigned)} tone={t.unassigned ? 'neg' : 'ok'} />
      </div>
      {error && <div className="error">{error}</div>}

      <section className="card no-pad">
        <div className="wf-head">
          <h2>Move to the Commercial team <span className="muted">· {by('move').length}</span></h2>
          <button type="button" className="secondary" onClick={copy}>{copied ? 'Copied' : 'Copy weekly plan'}</button>
        </div>
        {by('move').length ? (
          <div className="wf-scroll"><table>
            <thead><tr><th>Client</th><th>When</th><th>Now with</th><th>Move to</th><th>Status</th></tr></thead>
            <tbody>
              {by('move').map((a) => (
                <tr key={a.key}>
                  <td><Client a={a} /></td>
                  <td className="nowrap">{when(a)}<div className="muted small">{a.dates.map(shortDate).join(', ')}</div></td>
                  <td>{a.holders.map((h) => h.name).join(', ')}</td>
                  <td>
                    <select value={a.pick?.id ?? ''} aria-label="Move to" onChange={(e) => save.mutate({ key: a.key, patch: { assignee_id: Number(e.target.value) } })}>
                      {a.candidates.map((c) => <option key={c.id} value={c.id}>{c.name}{c.added_km != null ? ` · +${c.added_km} km` : ''}{c.served ? ' · knows the account' : ''}</option>)}
                    </select>
                  </td>
                  <td><StatusSelect a={a} /></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        ) : <p className="muted wf-empty">Nothing to move this week: every Commercial visit that can be on the Commercial team already is.</p>}
      </section>

      {by('nocover').length > 0 && (
        <section className="card no-pad">
          <div className="wf-head"><h2>No Commercial cover <span className="muted">· {by('nocover').length}</span></h2></div>
          <p className="muted small wf-note">No Commercial cleaner is free at these times, so they stay where they are for now.{peak.length ? ` To cover them all you would need, at the busiest moment: ${peak.map(([d, n]) => `${d} ${n}`).join(', ')} more cleaner${peak.some(([, n]) => n > 1) ? 's' : ''}.` : ''}</p>
          <div className="wf-scroll"><table>
            <thead><tr><th>Client</th><th>When</th><th>Stays with</th><th>Status</th></tr></thead>
            <tbody>{by('nocover').map((a) => <tr key={a.key}><td><Client a={a} /></td><td className="nowrap">{when(a)}</td><td>{a.holders.map((h) => h.name).join(', ')}</td><td><StatusSelect a={a} /></td></tr>)}</tbody>
          </table></div>
        </section>
      )}

      {by('stay').length > 0 && (
        <section className="card no-pad">
          <div className="wf-head"><h2>Stay until the program ends <span className="muted">· {by('stay').length}</span></h2></div>
          <p className="muted small wf-note">Transition-program clients keep their cleaner until they finish. Enter an end date and the visit is planned like the others from then on.</p>
          <div className="wf-scroll"><table>
            <thead><tr><th>Client</th><th>When</th><th>Stays with</th><th>Program ends</th></tr></thead>
            <tbody>
              {by('stay').map((a) => (
                <tr key={a.key}>
                  <td><Client a={a} /></td><td className="nowrap">{when(a)}</td><td>{a.holders.map((h) => h.name).join(', ')}</td>
                  <td><input type="date" aria-label="Program ends" defaultValue={a.end || ''} onBlur={(e) => e.target.value !== (a.end || '') && save.mutate({ key: a.key, patch: { ends_on: e.target.value || null } })} /></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </section>
      )}

      {by('hold').length > 0 && (
        <section className="card no-pad">
          <div className="wf-head"><h2>On hold <span className="muted">· {by('hold').length}</span></h2></div>
          <div className="wf-scroll"><table>
            <thead><tr><th>Client</th><th>When</th><th>With</th><th>Status</th></tr></thead>
            <tbody>{by('hold').map((a) => <tr key={a.key}><td><Client a={a} /></td><td className="nowrap">{when(a)}</td><td>{a.holders.map((h) => h.name).join(', ')}</td><td><StatusSelect a={a} /></td></tr>)}</tbody>
          </table></div>
        </section>
      )}

      <section className="card no-pad">
        <div className="wf-head"><h2>Visits with no cleaner <span className="muted">· {plan.unassigned.length}</span></h2><Link to="/schedule?tab=changes" className="small">Assign in the planner</Link></div>
        {plan.unassigned.length ? (
          <div className="wf-scroll"><table>
            <thead><tr><th>Client</th><th>When</th><th>Who could take it</th></tr></thead>
            <tbody>
              {plan.unassigned.map((u) => (
                <tr key={u.key}>
                  <td><Client a={u} /></td>
                  <td className="nowrap">{when(u)}<div className="muted small">{u.dates.map(shortDate).join(', ')}</div></td>
                  <td>
                    {u.commercial.map((c) => <div key={c.id}>{c.name}{c.near ? <span className="muted small"> · {c.near.km} km from {c.near.label}, {c.near.before ? 'ending' : 'starting'} {clockOf(c.near.time)}</span> : <span className="muted small"> · no other visit that day</span>}</div>)}
                    {!u.commercial.length && u.others.map((c) => <div key={c.id}>{c.name} <span className="chip warn">not on the Commercial team</span></div>)}
                    {!u.commercial.length && !u.others.length && <span className="neg">Nobody is free</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        ) : <p className="muted wf-empty">Every Commercial visit this week has a cleaner.</p>}
      </section>

      <section className="card no-pad">
        <div className="wf-head"><h2>The Commercial team's week</h2></div>
        <div className="wf-scroll"><table>
          <thead><tr><th>Cleaner</th><th>Hours in Launch27</th><th>Commercial</th><th>Residential</th><th>Planned moves</th><th>Load</th><th>Driving</th></tr></thead>
          <tbody>
            {plan.load.map((c) => {
              const used = c.commercial_hours + c.residential_hours + c.planned_hours;
              const full = Math.max(c.available_hours, used, 1);
              return (
                <tr key={c.id}>
                  <td><Link to={`/schedule/cleaner/${c.id}`}>{c.name}</Link>{c.last_day && <div className="small warn">Last day {niceDate(c.last_day)}</div>}</td>
                  <td>{c.has_hours ? `${c.available_hours} h` : <span className="chip warn">No hours in Launch27</span>}</td>
                  <td>{c.commercial_hours} h</td>
                  <td>{c.residential_hours ? `${c.residential_hours} h` : '—'}</td>
                  <td>{c.planned_hours ? `+${c.planned_hours} h` : '—'}</td>
                  <td>
                    <div className="wf-bar" title={`${used} of ${c.available_hours} hours`}>
                      <span className="com" style={{ width: `${(c.commercial_hours / full) * 100}%` }} />
                      <span className="res" style={{ width: `${(c.residential_hours / full) * 100}%` }} />
                      <span className="in" style={{ width: `${(c.planned_hours / full) * 100}%` }} />
                    </div>
                    <span className={`small ${used > c.available_hours && c.has_hours ? 'neg' : 'muted'}`}>{Math.round((used / Math.max(c.available_hours, 1)) * 100)}%</span>
                  </td>
                  <td className="nowrap">{c.km_now} km{c.km_planned !== c.km_now ? ` → ${c.km_planned} km` : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
        {!plan.load.length && <p className="muted wf-empty">Nobody is on the Commercial team yet. Pick them under Commercial team.</p>}
      </section>

      <section className="card">
        <h2>Also this week</h2>
        <ul className="wf-also">
          {plan.off.map((o, i) => <li key={`o${i}`}><span className="chip warn">Needs cover</span> {o.cleaner.name} · {o.why.toLowerCase()} · {niceDate(o.date)} {clockOf(o.start)} · {o.label}</li>)}
          {plan.clashes.map((c, i) => <li key={`c${i}`}><span className="chip warn">Double-booked</span> {c.cleaner.name} · {niceDate(c.date)} {clockOf(c.start)} · {c.a} and {c.b}</li>)}
          {plan.tight.map((x, i) => <li key={`t${i}`}><span className="chip">Tight travel</span> {x.cleaner.name} · {niceDate(x.date)} · {x.gap} min between {x.from} and {x.to} ({x.km} km, about {x.need} min)</li>)}
          {t.residential_on_team > 0 && <li><span className="chip">Residential</span> {t.residential_on_team} Residential job{t.residential_on_team === 1 ? '' : 's'} ({t.residential_on_team_hours} h) still held by Commercial cleaners</li>}
          {!plan.off.length && !plan.clashes.length && !plan.tight.length && !t.residential_on_team && <li className="muted">Nothing else to flag.</li>}
        </ul>
      </section>
    </>
  );
}

// ---------- week board ----------
const BLOCK: Record<BlockType, string> = { com: 'Commercial visit', res: 'Residential job', in: 'Planned move in', out: 'Planned move out', stay: 'Stays until the program ends', nocover: 'No Commercial cover', off: 'On a day off or outside hours' };
function BoardTab({ plan }: { plan: Plan }) {
  const weekend = plan.board.some((r) => r.days.slice(5).some((d) => d.blocks.length)) || plan.no_cleaner.some((n) => new Date(`${n.date}T12:00:00Z`).getUTCDay() % 6 === 0);
  const n = weekend ? 7 : 5;
  const dates = Array.from({ length: n }, (_, i) => shift(plan.week, i));
  return (
    <>
      <div className="wf-legend">{(Object.keys(BLOCK) as BlockType[]).map((k) => <span key={k}><i className={`wf-dot ${k}`} /> {BLOCK[k]}</span>)}</div>
      <div className="card no-pad wf-scroll">
        <table className="wf-board">
          <thead><tr><th>Cleaner</th>{dates.map((d, i) => <th key={d}>{DAY[i]} <span className="muted">{shortDate(d)}</span></th>)}</tr></thead>
          <tbody>
            {plan.no_cleaner.length > 0 && (
              <tr className="wf-none">
                <th scope="row">No cleaner</th>
                {dates.map((d) => <td key={d}>{plan.no_cleaner.filter((x) => x.date === d).map((x, i) => <div key={i} className="wf-block nocover"><b>{clockOf(x.start)}</b> {x.label}{x.try && <span className="muted"> · try {x.try}</span>}</div>)}</td>)}
              </tr>
            )}
            {plan.board.map((r) => (
              <tr key={r.id}>
                <th scope="row"><Link to={`/schedule/cleaner/${r.id}`}>{r.name}</Link>{!r.commercial && <div className="muted small">not on the team</div>}</th>
                {r.days.slice(0, n).map((d) => (
                  <td key={d.date}>
                    <div className="muted small">{d.window ? `${clockOf(d.window[0])}–${clockOf(d.window[1])}` : 'Day off'}</div>
                    {d.blocks.map((b, i) => <div key={i} className={`wf-block ${b.type}`} title={BLOCK[b.type]}><b>{clockOf(b.start)}</b> {b.label}</div>)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------- open slots and partner files ----------
function SlotsTab({ scope }: { scope: Scope }) {
  const queryClient = useQueryClient();
  const me = useInboxMe();
  const lead = me.data?.role === 'admin' || me.data?.role === 'supervisor';
  const [find, setFind] = useState<{ postal: string; freq: number; day: number | null } | null>(null);
  const [form, setForm] = useState({ postal: '', freq: 1, day: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const slots = useQuery({ queryKey: ['commercial', 'workforce', 'slots', scope, find], queryFn: () => workforceApi.slots(scope, find || undefined), retry: false, placeholderData: (p) => p });
  const settings = useMutation({
    mutationFn: workforceApi.setSettings,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['commercial', 'workforce'] }),
    onError: (e) => setMsg((e as Error).message),
  });
  const download = async (partner: string) => {
    setMsg(null);
    try {
      await workforceApi.partnerFile(scope, partner);
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFind({ postal: form.postal.trim(), freq: form.freq, day: form.day === '' ? null : Number(form.day) });
  };
  const s: Slots | undefined = slots.data;
  const p = s?.partner;
  return (
    <>
      <section className="card">
        <h2>Find a slot for a new client</h2>
        <p className="muted small">Enter the client's postal code. Suggestions favour times when a Commercial cleaner already has a visit nearby.</p>
        <form className="actions wf-find" onSubmit={submit}>
          <label>Postal code<input value={form.postal} onChange={(e) => setForm({ ...form, postal: e.target.value })} placeholder="K1C 2B3" maxLength={7} required /></label>
          <label>How often<select value={form.freq} onChange={(e) => setForm({ ...form, freq: Number(e.target.value) })}><option value={1}>Every week</option><option value={2}>Every 2 weeks</option><option value={0}>One visit</option></select></label>
          <label>Day<select value={form.day} onChange={(e) => setForm({ ...form, day: e.target.value })}><option value="">Any weekday</option>{(s?.days || [0, 1, 2, 3, 4]).map((d) => <option key={d} value={d}>{DAYS[d]}</option>)}</select></label>
          <button type="submit">Suggest slots</button>
        </form>
        {slots.isError && <div className="error">{(slots.error as Error).message}</div>}
        {s?.suggestions && (
          <>
            <p className="small">{s.placed ? `${s.placed.fsa} · ${s.placed.name} · ${s.placed.area === 'C' ? 'Cornwall' : 'Ottawa'} team` : "We can't place that postal area on the map, so distance is ignored."}</p>
            {s.suggestions.length ? (
              <ol className="wf-sug">
                {s.suggestions.map((x, i) => (
                  <li key={i} className={i === 0 ? 'best' : ''}>
                    <strong>{x.freq === 0 ? `${niceDate(x.first)}, ${clockOf(x.start)}` : `${DAYS[x.day]}s, ${clockOf(x.start)}`}</strong> · {x.cleaner}
                    <div className="small">
                      {x.freq !== 0 && <>Starts {niceDate(x.first)}{x.freq === 2 ? ', every 2 weeks' : ', every week'} · </>}
                      {x.near ? `about ${Math.max(1, Math.round(x.near.km))} km from ${x.near.kind === 'R' ? 'a Residential job' : `${x.near.account}${x.near.addr ? ` (${x.near.addr})` : ''}`} ${x.near.before ? 'ending' : 'starting'} ${clockOf(x.near.time)}` : 'no other visit that day to compare with'}
                    </div>
                    <div className="small">
                      {x.missing.length ? <><span className="chip warn">Already booked {x.missing.map(shortDate).join(', ')}</span> cover needed those dates</> : x.freq !== 0 ? <span className="chip ok">Free every {x.freq === 2 ? 'second ' : ''}week shown</span> : null}
                      {x.tight && <> <span className="chip warn">Tight travel</span></>}
                    </div>
                  </li>
                ))}
              </ol>
            ) : <p className="muted">No open slot matches. Try another day or frequency.</p>}
          </>
        )}
      </section>

      {s && (
        <section className="card no-pad">
          <div className="wf-head"><h2>Open slots each week <span className="muted">· {s.weeks.length} weeks from {shortDate(s.weeks[0])}</span></h2></div>
          <p className="muted small wf-note">Each number is a Commercial cleaner free at that day and time in every week shown, so a weekly client can start right away. Hover for names.</p>
          <div className="wf-scroll"><table>
            <thead><tr><th>Time</th>{s.days.map((d) => <th key={d}>{DAYS[d]}</th>)}</tr></thead>
            <tbody>
              {s.slots.map((sl, si) => (
                <tr key={si}>
                  <th scope="row">{clockOf(sl[0])}</th>
                  {s.days.map((d, di) => {
                    const c = s.grid[si][di];
                    return (
                      <td key={d}>
                        {c.every_week.length ? <span title={c.every_week.join(', ')}><strong className="wf-n">{c.every_week.length}</strong> <span className="muted small">every week</span></span> : <span className="muted">—</span>}
                        {c.some_weeks.length > 0 && <div><span className="chip warn" title={c.some_weeks.map((x) => `${x.cleaner} (${x.free} of ${x.of})`).join(', ')}>+{c.some_weeks.length} some weeks</span></div>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table></div>
        </section>
      )}

      {p && (
        <section className="card">
          <h2>Partner availability files</h2>
          <p className="muted small">A page each partner can open by themselves to see open slots and try a new client's postal code. It's made from the live schedule the moment you download it, and holds only what the settings below allow. Residential jobs are never named.</p>
          <div className="actions">
            {Object.keys(p.accounts).map((name) => <button key={name} type="button" onClick={() => download(name)} disabled={!lead} title={lead ? undefined : 'Supervisors and admins only'}>Download {name} file</button>)}
          </div>
          {!lead && <p className="muted small">Only supervisors and admins can download partner files or change these settings.</p>}
          {msg && <div className="error">{msg}</div>}
          <div className="wf-settings">
            <label className="check"><input type="checkbox" checked={p.showNames} disabled={!lead} onChange={(e) => settings.mutate({ partner: { showNames: e.target.checked } })} /> Show cleaner names (off: "Cleaner A, B…")</label>
            <label className="check"><input type="checkbox" checked={p.showOwnAddresses} disabled={!lead} onChange={(e) => settings.mutate({ partner: { showOwnAddresses: e.target.checked } })} /> Show each partner their own clients' addresses</label>
            <label className="check"><input type="checkbox" checked={p.showOtherPartners} disabled={!lead} onChange={(e) => settings.mutate({ partner: { showOtherPartners: e.target.checked } })} /> Show other partners' client addresses</label>
            <label>Weeks shown <select value={p.weeks} disabled={!lead} onChange={(e) => settings.mutate({ partner: { weeks: Number(e.target.value) } })}>{[1, 2, 3, 4, 5, 6, 7].map((w) => <option key={w} value={w}>{w}</option>)}</select></label>
            <label>Booking contact shown to partners <input defaultValue={p.contact} disabled={!lead} placeholder="name, phone or email" onBlur={(e) => e.target.value !== p.contact && settings.mutate({ partner: { contact: e.target.value } })} /></label>
          </div>
          <table className="wf-accounts">
            <thead><tr><th>Partner</th><th>Their accounts</th></tr></thead>
            <tbody>{Object.entries(p.accounts).map(([name, list]) => <tr key={name}><td>{name}</td><td>{list.join(', ')}</td></tr>)}</tbody>
          </table>
        </section>
      )}
    </>
  );
}

// ---------- Commercial team ----------
function TeamTab({ scope }: { scope: Scope }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const team = useQuery({ queryKey: ['commercial', 'workforce', 'team', scope], queryFn: () => workforceApi.team(scope), retry: false });
  const save = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Parameters<typeof workforceApi.setCleaner>[1] }) => workforceApi.setCleaner(id, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['commercial', 'workforce'] }),
    onError: (e) => setError((e as Error).message),
  });
  const d: Team | undefined = team.data;
  if (team.isError) return <div className="card error">{(team.error as Error).message}</div>;
  if (!d) return <div className="muted">Loading…</div>;
  return (
    <section className="card no-pad">
      <div className="wf-head"><h2>Who is on the Commercial team</h2></div>
      <p className="muted small wf-note">Everyone with Commercial visits in the last 8 weeks or coming up. The app suggests the team from each cleaner's share of Commercial hours ({Math.round(d.threshold * 100)}% or more); you decide. Hours and days off come from Launch27.</p>
      {error && <div className="error">{error}</div>}
      <div className="wf-scroll"><table>
        <thead><tr><th>Cleaner</th><th>Commercial</th><th>Residential</th><th>Commercial share</th><th>On the Commercial team</th><th>Last working day</th></tr></thead>
        <tbody>
          {d.cleaners.map((c) => (
            <tr key={c.id}>
              <td><Link to={`/schedule/cleaner/${c.id}`}>{c.name}</Link>{!c.has_hours && <div><span className="chip warn">No hours in Launch27</span></div>}{!c.assignable && <div className="muted small">not being scheduled</div>}</td>
              <td>{c.commercial_hours} h<div className="muted small">{c.upcoming_commercial} upcoming · {c.accounts} account{c.accounts === 1 ? '' : 's'}</div></td>
              <td>{c.residential_hours} h</td>
              <td><div className="wf-bar"><span className="com" style={{ width: `${c.share * 100}%` }} /></div><span className="muted small">{Math.round(c.share * 100)}%</span></td>
              <td>
                <select value={c.ticked === null ? '' : c.ticked ? 'yes' : 'no'} aria-label={`Is ${c.name} on the Commercial team`} onChange={(e) => save.mutate({ id: c.id, patch: { commercial: e.target.value === '' ? null : e.target.value === 'yes' } })}>
                  <option value="">Suggested: {c.suggested ? 'yes' : 'no'}</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </td>
              <td><input type="date" aria-label="Last working day" defaultValue={c.last_day || ''} onBlur={(e) => e.target.value !== (c.last_day || '') && save.mutate({ id: c.id, patch: { last_day: e.target.value || null } })} /></td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </section>
  );
}
