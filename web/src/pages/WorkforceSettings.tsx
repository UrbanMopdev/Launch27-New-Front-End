import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { inbox, type AgentStatus, type Capacity, type QueueSettings, type Schedule, type StatusKind, type Team, type Workforce, type WorkspaceSettings } from '../inbox/api';
import { useMeta } from '../inbox/util';

// Support settings for the workforce, modelled on Kustomer: agents (role, teams,
// capacity), teams, agent statuses (Available / Break / Lunch / Offline...), queues
// (routing mode, reply target, hours, overflow), business hours and routing policies.

const CH_LABEL = { email: 'Email', sms: 'Text', chat: 'Chat', voice: 'Calls' } as const;
const KIND_LABEL: Record<StatusKind, string> = { available: 'Available: gets new work', away: 'Away: no new work', offline: 'Offline: work returns to queues' };

function useWorkforce() {
  return useQuery({ queryKey: ['inbox', 'workforce'], queryFn: inbox.workforce });
}

function useSave() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    setSaved(false);
    try {
      await fn();
      await queryClient.invalidateQueries({ queryKey: ['inbox'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return { run, error, saved };
}

function Status({ error, saved }: { error: string | null; saved: boolean }) {
  return (
    <>
      {error && <div className="error small">{error}</div>}
      {saved && <span className="ok small">Saved</span>}
    </>
  );
}

function Loading({ q }: { q: ReturnType<typeof useWorkforce> }) {
  if (q.isLoading) return <div className="muted">Loading…</div>;
  if (q.error) return <div className="error">{(q.error as Error).message}</div>;
  return null;
}

// ---------- Agents ----------

export function AgentsSettings({ canEdit }: { canEdit: boolean }) {
  const wf = useWorkforce();
  const { run, error, saved } = useSave();
  if (!wf.data) return <Loading q={wf} />;
  const d = wf.data;
  const statusOf = (id: number | null) => d.statuses.find((s) => s.id === id);
  return (
    <section className="card no-pad">
      <div className="ws-intro">
        <p className="muted small">
          Who works the inbox, what they can do and how much they can take at once. People appear after they first sign in. Capacity is the most open conversations per channel before routing skips them; blank uses the workspace default ({d.channels.map((c) => `${CH_LABEL[c]} ${d.settings.default_capacity[c] ?? '∞'}`).join(', ')}).
        </p>
        <Status error={error} saved={saved} />
      </div>
      <div className="table-wrap flat">
        <table className="wf-table">
          <thead>
            <tr>
              <th>Person</th>
              <th>Role</th>
              <th>Teams</th>
              {d.channels.map((c) => (
                <th key={c} className="num small">{CH_LABEL[c]}</th>
              ))}
              <th>Active</th>
            </tr>
          </thead>
          <tbody>
            {d.agents.map((a) => {
              const st = statusOf(a.status_id);
              const capacity: Capacity = a.capacity || {};
              return (
                <tr key={a.id} className={a.active ? 'static' : 'static inactive'}>
                  <td>
                    <strong>{a.name || a.email}</strong>
                    <div className="muted small">
                      <span className="status-dot" style={{ background: st?.color || '#9aa3ad' }} /> {st?.name || 'No status'} · {a.email}
                    </div>
                  </td>
                  <td>
                    <select disabled={!canEdit} aria-label="Role" value={a.role} onChange={(e) => run(() => inbox.updateUser(a.id, { role: e.target.value }))}>
                      <option value="agent">Agent</option>
                      <option value="supervisor">Supervisor</option>
                      <option value="admin">Admin</option>
                    </select>
                  </td>
                  <td>
                    <div className="chips">
                      {d.teams.map((t) => {
                        const on = a.team_ids.map(Number).includes(Number(t.id));
                        return (
                          <button key={t.id} type="button" disabled={!canEdit} aria-pressed={on} className={on ? 'pillbtn on' : 'pillbtn'} onClick={() => run(() => inbox.updateUser(a.id, { team_ids: on ? a.team_ids.filter((x) => Number(x) !== Number(t.id)) : [...a.team_ids, t.id!] }))}>
                            {t.name}
                          </button>
                        );
                      })}
                    </div>
                  </td>
                  {d.channels.map((c) => (
                    <td key={c} className="num">
                      <input
                        className="cap-input"
                        type="number"
                        min={0}
                        max={99}
                        disabled={!canEdit}
                        aria-label={`${CH_LABEL[c]} capacity`}
                        placeholder={String(d.settings.default_capacity[c] ?? '')}
                        defaultValue={capacity[c] ?? ''}
                        onBlur={(e) => {
                          const v = e.target.value === '' ? undefined : Number(e.target.value);
                          if (v === capacity[c]) return;
                          const next = { ...capacity };
                          if (v === undefined) delete next[c];
                          else next[c] = v;
                          run(() => inbox.updateUser(a.id, { capacity: next }));
                        }}
                      />
                    </td>
                  ))}
                  <td>
                    <input type="checkbox" aria-label="Active" disabled={!canEdit} checked={a.active} onChange={(e) => run(() => inbox.updateUser(a.id, { active: e.target.checked }))} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted small pad">Inactive people keep their history but never receive routed work. Queue access comes from teams (Teams tab).</p>
    </section>
  );
}

// ---------- Teams ----------

export function TeamsSettings({ canEdit }: { canEdit: boolean }) {
  const wf = useWorkforce();
  const [teams, setTeams] = useState<Team[] | null>(null);
  const { run, error, saved } = useSave();
  if (!wf.data) return <Loading q={wf} />;
  const d = wf.data;
  const list = teams || d.teams.map((t) => ({ ...t, member_ids: t.member_ids.map(Number), queue_ids: t.queue_ids.map(Number) }));
  const update = (i: number, patch: Partial<Team>) => setTeams(list.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const toggle = (arr: number[], id: number) => (arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);
  return (
    <>
      <div className="ws-intro">
        <p className="muted small">Teams group agents and say which queues they work. Everyone on a team can receive that team's queues' conversations (when Available and under capacity).</p>
        <div className="actions">
          {canEdit && (
            <button type="button" className="secondary" onClick={() => setTeams([...list, { name: 'New team', description: '', lead_user_id: null, member_ids: [], queue_ids: [] }])}>
              + Add team
            </button>
          )}
          {canEdit && teams && (
            <button type="button" onClick={() => run(async () => { await inbox.saveTeams(list); setTeams(null); })}>
              Save teams
            </button>
          )}
          <Status error={error} saved={saved} />
        </div>
      </div>
      <div className="wf-grid">
        {list.map((t, i) => (
          <section key={t.id ?? `new${i}`} className="card wf-card">
            <div className="wf-card-head">
              <input className="wf-title-input" aria-label="Team name" disabled={!canEdit} value={t.name} onChange={(e) => update(i, { name: e.target.value })} />
              {canEdit && (
                <button type="button" className="link small" onClick={() => setTeams(list.filter((_, j) => j !== i))}>
                  Remove
                </button>
              )}
            </div>
            <input aria-label="Description" placeholder="What this team handles" disabled={!canEdit} value={t.description || ''} onChange={(e) => update(i, { description: e.target.value })} />
            <label className="wf-field">
              Team lead
              <select disabled={!canEdit} value={t.lead_user_id ?? ''} onChange={(e) => update(i, { lead_user_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">None</option>
                {d.agents.filter((a) => a.active).map((a) => <option key={a.id} value={a.id}>{a.name || a.email}</option>)}
              </select>
            </label>
            <div className="eyebrow">Works these queues</div>
            <div className="chips">
              {d.queues.map((q) => {
                const on = t.queue_ids.includes(Number(q.id));
                return (
                  <button key={q.id} type="button" disabled={!canEdit} aria-pressed={on} className={on ? 'pillbtn on' : 'pillbtn'} onClick={() => update(i, { queue_ids: toggle(t.queue_ids, Number(q.id)) })}>
                    {q.name}
                  </button>
                );
              })}
            </div>
            <div className="eyebrow">Members ({t.member_ids.length})</div>
            <div className="chips">
              {d.agents.filter((a) => a.active).map((a) => {
                const on = t.member_ids.includes(Number(a.id));
                return (
                  <button key={a.id} type="button" disabled={!canEdit} aria-pressed={on} className={on ? 'pillbtn on' : 'pillbtn'} onClick={() => update(i, { member_ids: toggle(t.member_ids, Number(a.id)) })}>
                    {a.name || a.email}
                  </button>
                );
              })}
              {!d.agents.length && <span className="muted small">Nobody has signed in yet.</span>}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}

// ---------- Agent statuses ----------

export function StatusesSettings({ canEdit }: { canEdit: boolean }) {
  const wf = useWorkforce();
  const [rows, setRows] = useState<Partial<AgentStatus>[] | null>(null);
  const { run, error, saved } = useSave();
  if (!wf.data) return <Loading q={wf} />;
  const list = rows || wf.data.statuses;
  const update = (i: number, patch: Partial<AgentStatus>) => setRows(list.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, by: number) => {
    const next = [...list];
    const [x] = next.splice(i, 1);
    next.splice(i + by, 0, x);
    setRows(next);
  };
  return (
    <>
      <div className="ws-intro">
        <p className="muted small">
          The statuses agents choose from (Kustomer's Available / Busy / Offline plus custom away reasons). Only <b>Available</b> statuses receive new conversations. <b>Away</b> statuses can keep or hand back the agent's open work, and a time limit tells supervisors when a break runs long. <b>Offline</b> hands work back (see Routing policies).
        </p>
        <div className="actions">
          {canEdit && (
            <button type="button" className="secondary" onClick={() => setRows([...list.slice(0, -1), { name: 'New status', kind: 'away', color: '#6366f1', keeps_work: true, max_minutes: null, selectable: true }, list[list.length - 1]])}>
              + Add status
            </button>
          )}
          {canEdit && rows && (
            <button type="button" onClick={() => run(async () => { await inbox.saveStatuses(list); setRows(null); })}>
              Save statuses
            </button>
          )}
          <Status error={error} saved={saved} />
        </div>
      </div>
      <section className="card no-pad">
        <div className="table-wrap flat">
          <table className="wf-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Type</th>
                <th>Open work</th>
                <th className="num">Time limit</th>
                <th>Agents can pick</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((s, i) => (
                <tr key={s.id ?? `n${i}`} className="static">
                  <td>
                    <span className="status-name">
                      <input type="color" aria-label="Colour" disabled={!canEdit} value={s.color || '#6b7280'} onChange={(e) => update(i, { color: e.target.value })} />
                      <input aria-label="Status name" disabled={!canEdit} value={s.name || ''} onChange={(e) => update(i, { name: e.target.value })} />
                    </span>
                    {!!s.in_use && <div className="muted small">{s.in_use} agent{s.in_use === 1 ? '' : 's'} now</div>}
                  </td>
                  <td>
                    <select aria-label="Type" disabled={!canEdit} value={s.kind} onChange={(e) => update(i, { kind: e.target.value as StatusKind })}>
                      {(Object.keys(KIND_LABEL) as StatusKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                    </select>
                  </td>
                  <td>
                    {s.kind === 'away' ? (
                      <select aria-label="Open work" disabled={!canEdit} value={s.keeps_work === false ? 'return' : 'keep'} onChange={(e) => update(i, { keeps_work: e.target.value === 'keep' })}>
                        <option value="keep">Keeps it</option>
                        <option value="return">Returns it to queues</option>
                      </select>
                    ) : (
                      <span className="muted small">{s.kind === 'available' ? 'Keeps it' : 'Returns it'}</span>
                    )}
                  </td>
                  <td className="num">
                    {s.kind === 'away' ? (
                      <span className="nowrap">
                        <input className="cap-input" type="number" min={1} aria-label="Time limit in minutes" disabled={!canEdit} placeholder="none" value={s.max_minutes ?? ''} onChange={(e) => update(i, { max_minutes: e.target.value ? Number(e.target.value) : null })} /> min
                      </span>
                    ) : (
                      <span className="muted small">—</span>
                    )}
                  </td>
                  <td>
                    <input type="checkbox" aria-label="Agents can pick" disabled={!canEdit} checked={s.selectable !== false} onChange={(e) => update(i, { selectable: e.target.checked })} />
                  </td>
                  <td className="nowrap">
                    {canEdit && (
                      <>
                        <button type="button" className="link small" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</button>{' '}
                        <button type="button" className="link small" disabled={i === list.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</button>{' '}
                        <button type="button" className="link small" onClick={() => setRows(list.filter((_, j) => j !== i))}>Remove</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small pad">Removing a status signs anyone on it out. Keep at least one Available and one Offline status.</p>
      </section>
    </>
  );
}

// ---------- Queues ----------

export function QueuesSettings({ canEdit }: { canEdit: boolean }) {
  const wf = useWorkforce();
  const [newName, setNewName] = useState('');
  const { run, error, saved } = useSave();
  if (!wf.data) return <Loading q={wf} />;
  const d = wf.data;
  const save = (q: QueueSettings, patch: Partial<QueueSettings>) => run(() => inbox.updateQueue(q.id, patch));
  const teamsFor = (qid: number) => d.teams.filter((t) => t.queue_ids.map(Number).includes(Number(qid))).map((t) => t.name);
  return (
    <>
      <div className="ws-intro">
        <p className="muted small">
          How each queue hands out work. <b>Least busy</b> gives the next conversation to the available agent with the fewest open; <b>Round robin</b> takes turns; <b>Manual</b> never pushes (agents claim from the list). Overflow moves a conversation nobody has picked up to another queue.
        </p>
        <div className="actions">
          {canEdit && (
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (newName.trim()) run(async () => { await inbox.createQueue(newName.trim()); setNewName(''); });
              }}
            >
              <input aria-label="New queue name" placeholder="New queue name" value={newName} onChange={(e) => setNewName(e.target.value)} />
              <button type="submit" className="secondary">+ Add queue</button>
            </form>
          )}
          <Status error={error} saved={saved} />
        </div>
      </div>
      <section className="card no-pad">
        <div className="table-wrap flat">
          <table className="wf-table">
            <thead>
              <tr>
                <th>Queue</th>
                <th>Routing</th>
                <th>Reply target</th>
                <th>Hours</th>
                <th>Overflow</th>
                <th>Priority</th>
                <th>Private</th>
              </tr>
            </thead>
            <tbody>
              {d.queues.map((q) => (
                <tr key={q.id} className="static">
                  <td>
                    <strong>{q.name}</strong>
                    <div className="muted small">{teamsFor(q.id).join(', ') || 'No team: only direct members'}</div>
                  </td>
                  <td>
                    <select aria-label="Routing mode" disabled={!canEdit} value={q.routing_mode} onChange={(e) => save(q, { routing_mode: e.target.value as QueueSettings['routing_mode'] })}>
                      <option value="least_busy">Least busy</option>
                      <option value="round_robin">Round robin</option>
                      <option value="manual">Manual (claim)</option>
                    </select>
                  </td>
                  <td>
                    <select aria-label="Default reply target" disabled={!canEdit} value={q.default_sla_id ?? ''} onChange={(e) => save(q, { default_sla_id: e.target.value ? Number(e.target.value) : null })}>
                      <option value="">From routing rule</option>
                      {d.sla_policies.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </td>
                  <td>
                    <select aria-label="Business hours" disabled={!canEdit} value={q.schedule_id ?? ''} onChange={(e) => save(q, { schedule_id: e.target.value ? Number(e.target.value) : null })}>
                      <option value="">Default hours</option>
                      {d.schedules.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </td>
                  <td>
                    <span className="nowrap">
                      after{' '}
                      <input className="cap-input" type="number" min={1} aria-label="Overflow after minutes" disabled={!canEdit} placeholder="—" defaultValue={q.overflow_minutes ?? ''} onBlur={(e) => { const v = e.target.value ? Number(e.target.value) : null; if (v !== q.overflow_minutes) save(q, { overflow_minutes: v }); }} />{' '}
                      min to{' '}
                      <select aria-label="Overflow queue" disabled={!canEdit} value={q.overflow_queue_id ?? ''} onChange={(e) => save(q, { overflow_queue_id: e.target.value ? Number(e.target.value) : null })}>
                        <option value="">—</option>
                        {d.queues.filter((o) => o.id !== q.id).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                      </select>
                    </span>
                  </td>
                  <td>
                    <select aria-label="Priority boost" disabled={!canEdit} value={q.priority_boost} onChange={(e) => save(q, { priority_boost: Number(e.target.value) })}>
                      <option value={-2}>Much lower</option>
                      <option value={-1}>Lower</option>
                      <option value={0}>Normal</option>
                      <option value={1}>Higher</option>
                      <option value={2}>Much higher</option>
                    </select>
                  </td>
                  <td>
                    <input type="checkbox" aria-label="Private queue" disabled={!canEdit} checked={q.restricted} onChange={(e) => save(q, { restricted: e.target.checked })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small pad">Private queues are only visible to the people who work them (and admins). Routing rules decide which queue a conversation lands in (Routing rules tab).</p>
      </section>
    </>
  );
}

// ---------- Business hours ----------

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ZONES = ['America/Toronto', 'America/Vancouver', 'America/Edmonton', 'America/Winnipeg', 'America/Halifax'];

export function HoursSettings({ canEdit }: { canEdit: boolean }) {
  const wf = useWorkforce();
  const meta = useMeta();
  if (!wf.data) return <Loading q={wf} />;
  return (
    <>
      <div className="ws-intro">
        <p className="muted small">Reply targets only count open hours. Each queue uses the default schedule unless it picks another (Queues tab). Holidays close every schedule.</p>
      </div>
      <div className="wf-grid">
        {wf.data.schedules.map((s) => <ScheduleCard key={s.id} schedule={s} canEdit={canEdit} />)}
        {canEdit && <ScheduleCard schedule={{ name: '', time_zone: 'America/Toronto', week: { 1: ['09:00', '17:00'], 2: ['09:00', '17:00'], 3: ['09:00', '17:00'], 4: ['09:00', '17:00'], 5: ['09:00', '17:00'] }, is_default: false }} canEdit isNew />}
        <section className="card wf-card">
          <div className="eyebrow">Holidays (closed)</div>
          {meta.data?.holidays.map((h) => (
            <div key={h.day} className="up-row">
              <span>{new Date(`${h.day}T12:00:00`).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</span>
              <span className="muted">{h.name}</span>
            </div>
          ))}
        </section>
      </div>
    </>
  );
}

function ScheduleCard({ schedule, canEdit, isNew }: { schedule: Schedule; canEdit: boolean; isNew?: boolean }) {
  const [s, setS] = useState<Schedule>(schedule);
  const [dirty, setDirty] = useState(false);
  const { run, error, saved } = useSave();
  const set = (patch: Partial<Schedule>) => {
    setS({ ...s, ...patch });
    setDirty(true);
  };
  const setDay = (d: number, span: [string, string] | null) => set({ week: { ...s.week, [d]: span } });
  return (
    <section className="card wf-card">
      <div className="wf-card-head">
        <input className="wf-title-input" aria-label="Schedule name" placeholder={isNew ? 'New schedule name' : ''} disabled={!canEdit} value={s.name} onChange={(e) => set({ name: e.target.value })} />
        {s.is_default && !isNew && <span className="chip accent">Default</span>}
      </div>
      <label className="wf-field">
        Time zone
        <select disabled={!canEdit} value={s.time_zone} onChange={(e) => set({ time_zone: e.target.value })}>
          {ZONES.map((z) => <option key={z} value={z}>{z.replace('America/', '').replace('_', ' ')}</option>)}
        </select>
      </label>
      <div className="hours-grid">
        {DAYS.map((name, d) => {
          const span = s.week[d] || null;
          return (
            <div key={d} className="hours-row">
              <label className="check">
                <input type="checkbox" disabled={!canEdit} checked={!!span} onChange={(e) => setDay(d, e.target.checked ? ['09:00', '17:00'] : null)} /> {name.slice(0, 3)}
              </label>
              {span ? (
                <span className="nowrap">
                  <input type="time" aria-label={`${name} opens`} disabled={!canEdit} value={span[0]} onChange={(e) => setDay(d, [e.target.value, span[1]])} /> –{' '}
                  <input type="time" aria-label={`${name} closes`} disabled={!canEdit} value={span[1] === '24:00' ? '23:59' : span[1]} onChange={(e) => setDay(d, [span[0], e.target.value])} />
                </span>
              ) : (
                <span className="muted small">Closed</span>
              )}
            </div>
          );
        })}
      </div>
      {canEdit && (
        <div className="actions">
          {!s.is_default && !isNew && (
            <button type="button" className="secondary" onClick={() => run(() => inbox.saveSchedule({ ...s, is_default: true }))}>
              Make default
            </button>
          )}
          {(dirty || isNew) && (
            <button type="button" disabled={!s.name.trim()} onClick={() => run(async () => { await inbox.saveSchedule(s); setDirty(false); if (isNew) setS(schedule); })}>
              {isNew ? 'Add schedule' : 'Save'}
            </button>
          )}
          <Status error={error} saved={saved} />
        </div>
      )}
    </section>
  );
}

// ---------- Routing policies ----------

const POLICIES: { key: keyof WorkspaceSettings; label: string; help: string; kind: 'bool' | 'minutes' | 'hours' }[] = [
  { key: 'offline_returns_work', label: 'Going offline hands work back', help: "An agent's open and snoozed conversations return to their queues when they go Offline (Kustomer's default).", kind: 'bool' },
  { key: 'auto_offline_idle_minutes', label: 'Set idle agents offline after', help: 'Agents whose app has been closed this long (e.g. left without signing out) switch to Offline and their work goes back to the queues. 0 turns it off.', kind: 'minutes' },
  { key: 'pull_waiting_on_available', label: 'Becoming available picks up waiting work', help: 'Switching to Available assigns unassigned conversations from your queues, most urgent first.', kind: 'bool' },
  { key: 'assign_on_reply', label: 'Replying assigns the conversation to you', help: 'Answering an unassigned conversation makes you its owner.', kind: 'bool' },
  { key: 'reopen_to_previous_owner', label: 'Reopened conversations go back to who closed them', help: 'When a customer writes back to a done conversation, its last owner gets it if they are Available and it is within the window below.', kind: 'bool' },
  { key: 'reopen_window_hours', label: 'Reopen window', help: 'How long after "done" a reply goes back to the same agent.', kind: 'hours' },
  { key: 'require_disposition', label: 'Ask for reason and outcome when marking done', help: 'Audience, reason and outcome are required before a conversation can be marked done.', kind: 'bool' },
  { key: 'alert_on_long_away', label: 'Tell supervisors when a status runs long', help: "Supervisors are notified once when someone passes a status's time limit (e.g. a 15-minute break).", kind: 'bool' },
];

export function PoliciesSettings({ canEdit }: { canEdit: boolean }) {
  const wf = useWorkforce();
  const [draft, setDraft] = useState<Partial<WorkspaceSettings>>({});
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: () => inbox.saveSettings(draft),
    onSuccess: () => {
      setDraft({});
      queryClient.invalidateQueries({ queryKey: ['inbox'] });
    },
  });
  if (!wf.data) return <Loading q={wf} />;
  const d: Workforce = wf.data;
  const v = { ...d.settings, ...draft };
  const set = (patch: Partial<WorkspaceSettings>) => setDraft({ ...draft, ...patch });
  return (
    <section className="card wf-policies">
      {POLICIES.map((p) => (
        <div key={p.key} className="policy-row">
          <div className="grow">
            <div className="strong">{p.label}</div>
            <div className="muted small">{p.help}</div>
          </div>
          {p.kind === 'bool' ? (
            <label className="switch">
              <input type="checkbox" disabled={!canEdit} checked={!!v[p.key]} onChange={(e) => set({ [p.key]: e.target.checked } as Partial<WorkspaceSettings>)} />
              <span className="sr-only">{p.label}</span>
              <span className="switch-ui" aria-hidden="true" />
            </label>
          ) : (
            <span className="nowrap">
              <input className="cap-input" type="number" min={0} aria-label={p.label} disabled={!canEdit} value={Number(v[p.key])} onChange={(e) => set({ [p.key]: Number(e.target.value) } as Partial<WorkspaceSettings>)} /> {p.kind}
            </span>
          )}
        </div>
      ))}
      <div className="policy-row">
        <div className="grow">
          <div className="strong">Default capacity per agent</div>
          <div className="muted small">Most open conversations at once per channel, unless an agent has their own (Agents tab). Routing skips agents who are full.</div>
        </div>
        <span className="cap-row">
          {d.channels.map((c) => (
            <label key={c} className="small">
              {CH_LABEL[c]}
              <input className="cap-input" type="number" min={0} max={99} disabled={!canEdit} value={v.default_capacity[c] ?? ''} onChange={(e) => set({ default_capacity: { ...v.default_capacity, [c]: Number(e.target.value) } })} />
            </label>
          ))}
        </span>
      </div>
      {canEdit && (
        <div className="actions">
          <button type="button" disabled={!Object.keys(draft).length || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save policies'}
          </button>
          {save.error && <span className="error small">{(save.error as Error).message}</span>}
          {save.isSuccess && !Object.keys(draft).length && <span className="ok small">Saved</span>}
        </div>
      )}
    </section>
  );
}

// ---------- QA copy of real data ----------

export function QaCopySettings({ canEdit }: { canEdit: boolean }) {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ['inbox', 'qa-copy'], queryFn: inbox.qaCopy, refetchInterval: (q) => (q.state.data?.job?.state === 'running' ? 3000 : false) });
  const { run, error } = useSave();
  if (status.isLoading) return <div className="muted">Loading…</div>;
  if (status.error) return <div className="error">{(status.error as Error).message}</div>;
  const d = status.data!;
  const describe = (s: NonNullable<typeof d.current>) => `${s.bookings.toLocaleString()} bookings (${s.window.from} to ${s.window.to}), ${s.customers.toLocaleString()} customers, ${s.cleaners.toLocaleString()} cleaners, made ${new Date(s.created_at).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })}`;
  return (
    <section className="card wf-policies">
      <div className="policy-row">
        <div className="grow">
          <div className="strong">Anonymized copy of real data for QA</div>
          <div className="muted small">
            Production copies the last 60 and next 60 days of bookings with customers and cleaners, replaces every name, email, phone, street address, note and card number, checks that nothing personal is left, and sends only that copy to QA. Prices, services, extras, times and assignments stay real. QA checks it again before using it, and changes made in QA never reach Launch27.
          </div>
        </div>
      </div>
      {d.can_send && (
        <div className="policy-row">
          <div className="grow">
            {d.job?.state === 'running' && <div className="strong">Working: {d.job.step}…</div>}
            {d.job?.state === 'done' && d.job.summary && <div className="ok">Sent to QA: {describe(d.job.summary)}</div>}
            {d.job?.state === 'failed' && <div className="error small">Not sent: {d.job.error}</div>}
            {(!d.job || d.job.state === 'idle') && <div className="muted small">Takes a few minutes. Uses your Launch27 login to read the data.</div>}
          </div>
          {canEdit && (
            <button type="button" disabled={d.job?.state === 'running'} onClick={() => run(() => inbox.sendQaCopy())}>
              {d.job?.state === 'running' ? 'Copying…' : 'Send a fresh copy to QA'}
            </button>
          )}
        </div>
      )}
      {d.receiving && (
        <div className="policy-row">
          <div className="grow">
            {d.current ? <div><span className="strong">This QA site is showing the anonymized copy:</span> {describe(d.current)}</div> : <div className="muted">No copy yet: this site shows generated sample data. Send one from production (Support settings → QA data).</div>}
          </div>
          {canEdit && d.current && (
            <button type="button" className="secondary" onClick={() => run(async () => { await inbox.clearQaCopy(); queryClient.invalidateQueries(); })}>
              Go back to sample data
            </button>
          )}
        </div>
      )}
      {!d.can_send && !d.receiving && <p className="muted small">Not set up here. Production sends the copy and QA receives it; both need the same QA_SNAPSHOT_TOKEN (see docs/environments.md).</p>}
      {error && <div className="error small">{error}</div>}
    </section>
  );
}
