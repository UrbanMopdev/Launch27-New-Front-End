// Complaint Tracking: the office's complaint cases, as they were in Kustomer. Saved views on
// the left with live counts, a sortable list with bulk actions, and the complaint record
// (four panels and an internal comments thread). docs/complaint-tracker.md.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fmtDateTime } from '../format';
import { ago, useInboxMe } from '../inbox/util';
import { inbox } from '../inbox/api';
import { useActiveTeams } from '../hooks';
import { tracker, type ComplaintPatch, type ComplaintRecord, type Guidance, type Ranked, type TrackerField, type TrackerMeta } from '../tracker/api';

const useTrackerMeta = () => useQuery({ queryKey: ['tracker', 'meta'], queryFn: tracker.meta, staleTime: 5 * 60_000 });
const day = (v: unknown) => (v ? String(v).slice(0, 10) : '—');
const money = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : `$${Number(v).toLocaleString('en-CA', { maximumFractionDigits: 0 })}`);
const STATE_LABEL = { open: 'Open', snoozed: 'Snoozed', done: 'Done' } as const;

export function ComplaintTrackerPage() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const meta = useTrackerMeta();
  const counts = useQuery({ queryKey: ['tracker', 'counts'], queryFn: tracker.counts, refetchInterval: 20_000 });
  const slug = params.get('view') || 'for-review';
  if (meta.isLoading) return <div className="muted">Loading…</div>;
  if (meta.error || !meta.data) return <div className="error">{(meta.error as Error)?.message || 'Could not load the complaint tracker'}</div>;
  const current = meta.data.views.find((v) => v.slug === slug) || meta.data.views[0];
  return (
    <div className="ct">
      <aside className="ct-views" aria-label="Complaint searches">
        <div className="ct-views-title">Complaint Tracking</div>
        {meta.data.views.map((v) => (
          <Link key={v.slug} to={`/complaint-tracking?view=${v.slug}`} className={!id && v.slug === current.slug ? 'ct-view active' : 'ct-view'} title={v.name}>
            <span className="clip">{v.name}</span>
            {counts.data?.[v.slug] ? <span className="count">{counts.data[v.slug]}</span> : null}
          </Link>
        ))}
        <KustomerLoad meta={meta.data} />
        <MatchNames />
      </aside>
      <main className="ct-main">
        {id ? (
          <RecordView key={id} id={Number(id)} meta={meta.data} />
        ) : current.kind === 'conversations' ? (
          <PositiveFeedbackList name={current.name} />
        ) : (
          <ComplaintList meta={meta.data} view={current} sort={params.get('sort') || undefined} dir={params.get('dir') || undefined} onSort={(sort, dir) => setParams({ view: current.slug, sort, dir })} />
        )}
      </main>
    </div>
  );
}

// Admins bring recent complaints over from Kustomer (production only). Safe to run again:
// a complaint already changed here is left alone.
function KustomerLoad({ meta }: { meta: TrackerMeta }) {
  const me = useInboxMe();
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ['tracker', 'load'], queryFn: tracker.loadStatus, refetchInterval: (q) => (q.state.data?.running ? 3000 : false), enabled: meta.kustomer === 'connected' && me.data?.role === 'admin' });
  const start = useMutation({ mutationFn: tracker.startLoad, onSettled: () => queryClient.invalidateQueries({ queryKey: ['tracker', 'load'] }) });
  const s = status.data;
  useEffect(() => {
    if (s?.finished_at) queryClient.invalidateQueries({ queryKey: ['tracker'], predicate: (q) => q.queryKey[1] !== 'load' && q.queryKey[1] !== 'meta' });
  }, [s?.finished_at, queryClient]);
  if (meta.kustomer !== 'connected' || me.data?.role !== 'admin') return null;
  return (
    <div className="ct-load small">
      <button className="secondary small-btn" disabled={s?.running || start.isPending} onClick={() => start.mutate()}>{s?.running ? 'Loading from Kustomer…' : 'Load from Kustomer'}</button>
      <div className="muted">Last 30 days, plus every complaint still open. Read-only on Kustomer.</div>
      {start.error && <div className="error">{(start.error as Error).message}</div>}
      {s?.error && <div className="error">{s.error}</div>}
      {s?.result && !s.running && <div className="muted">Loaded {s.result.loaded} of {s.result.seen} ({s.result.kept_as_edited} left as edited here, {s.result.comments} comments{s.result.linked ? `; matched ${s.result.linked.cleaners} cleaner and ${s.result.linked.users} staff names` : ''}) {ago(s.finished_at)} ago.</div>}
    </div>
  );
}

function cell(r: ComplaintRecord, key: string) {
  const v = r[key];
  if (key === 'created_at') return fmtDateTime(r.created_at);
  if (key === 'ltv_of_client') return money(v);
  if (key === 'due_date' || key === 'original_service_date') return day(v);
  if (key === 'input_into_um_portal') return v ? String(v) : <span className="chip warn">To do</span>;
  if (key === 'proposed_solution' || key === 'complaint_notes') return <span className="ct-clip" title={v ? String(v) : undefined}>{v ? String(v) : '—'}</span>;
  return v === null || v === undefined || v === '' ? '—' : String(v);
}

function daysLeft(n: number | null) {
  if (n === null || n === undefined) return <span className="muted">No service date</span>;
  if (n < 0) return <span className="chip neg">Expired {-n}d ago</span>;
  if (n === 0) return <span className="chip neg">Last day</span>;
  return <span className={n <= 2 ? 'chip warn' : 'chip'}>{n} day{n === 1 ? '' : 's'} left</span>;
}

function ComplaintList({ meta, view, sort, dir, onSort }: { meta: TrackerMeta; view: TrackerMeta['views'][number]; sort?: string; dir?: string; onSort: (sort: string, dir: string) => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [creating, setCreating] = useState(false);
  const [bulkStatus, setBulkStatus] = useState('');
  const list = useQuery({ queryKey: ['tracker', 'list', view.slug, sort, dir, q], queryFn: () => tracker.list({ view: view.slug, sort, dir, q: q.trim() || undefined }), refetchInterval: 30_000, placeholderData: (prev) => prev });
  useEffect(() => setPicked(new Set()), [view.slug]);
  const rows = list.data?.rows || [];
  const portal = view.slug === 'um-portal-required';
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['tracker'], predicate: (qq) => qq.queryKey[1] !== 'meta' });
  const bulk = useMutation({
    mutationFn: (patch: ComplaintPatch) => tracker.bulk([...picked], patch),
    onSuccess: () => {
      setPicked(new Set());
      setBulkStatus('');
      refresh();
    },
  });
  const allPicked = rows.length > 0 && rows.every((r) => picked.has(r.id));
  const toggle = (id: number) => setPicked((p) => {
    const next = new Set(p);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const header = (key: string, label: string) => {
    const active = list.data?.sort === key;
    const next = active && list.data?.dir === 'asc' ? 'desc' : 'asc';
    return (
      <th key={key} aria-sort={active ? (list.data?.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
        <button type="button" className="ct-sort" onClick={() => onSort(key, next)}>{label}{active ? (list.data?.dir === 'asc' ? ' ▲' : ' ▼') : ''}</button>
      </th>
    );
  };
  return (
    <>
      <header className="page-header">
        <h1>{view.name} <span className="count">{rows.length}</span></h1>
        <div className="actions">
          <input type="search" placeholder="Search title, customer or cleaner" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search complaints" />
          <button onClick={() => setCreating(!creating)}>New complaint</button>
        </div>
      </header>
      {creating && <NewComplaint onCancel={() => setCreating(false)} onMade={(id) => navigate(`/complaint-tracking/${id}`)} />}
      {picked.size > 0 && (
        <div className="ct-bulk actions">
          <b>{picked.size} selected</b>
          <button className="secondary small-btn" disabled={bulk.isPending} onClick={() => bulk.mutate({ assigned_user_id: 'me' })}>Assign to me</button>
          <button className="secondary small-btn" disabled={bulk.isPending} onClick={() => bulk.mutate({ state: 'done' })}>Mark done</button>
          <select aria-label="Set status" value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value)}>
            <option value="">Set status…</option>
            {meta.statuses.map((s) => <option key={s}>{s}</option>)}
          </select>
          <button className="secondary small-btn" disabled={!bulkStatus || bulk.isPending} onClick={() => bulk.mutate({ status: bulkStatus })}>Apply</button>
          <button className="link small" onClick={() => setPicked(new Set())}>Clear</button>
          {bulk.error && <span className="error small">{(bulk.error as Error).message}</span>}
        </div>
      )}
      {list.error && <div className="error">{(list.error as Error).message}</div>}
      {portal && <p className="muted small">Ratings are entered in Launch27 (the UM Portal). Sorted by days left before the booking's rating link expires ({meta.rating_days} days after the visit).</p>}
      <div className="table-wrap">
        <table className="ct-table">
          <thead>
            <tr>
              <th className="ct-check"><input type="checkbox" aria-label="Select all" checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(rows.map((r) => r.id)))} /></th>
              {header('title', 'Complaint')}
              {portal && header('rating_days_left', 'Rating link')}
              {meta.columns.map((c) => header(c.key, c.label))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={picked.has(r.id) ? 'picked' : undefined}>
                <td className="ct-check"><input type="checkbox" aria-label={`Select ${r.title}`} checked={picked.has(r.id)} onChange={() => toggle(r.id)} /></td>
                <td>
                  <Link to={`/complaint-tracking/${r.id}`} className="ct-title">{r.title}</Link>
                  {r.state !== 'open' && <span className={`status-pill ${r.state}`}>{STATE_LABEL[r.state]}</span>}
                </td>
                {portal && <td>{daysLeft(r.rating_days_left)}</td>}
                {meta.columns.map((c) => <td key={c.key}>{cell(r, c.key)}</td>)}
              </tr>
            ))}
            {!rows.length && !list.isLoading && <tr><td colSpan={meta.columns.length + (portal ? 3 : 2)} className="muted">Nothing in this view.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function NewComplaint({ onCancel, onMade }: { onCancel: () => void; onMade: (id: number) => void }) {
  const [title, setTitle] = useState('');
  const [customer, setCustomer] = useState('');
  const [cleaner, setCleaner] = useState('');
  const [service, setService] = useState('');
  const make = useMutation({ mutationFn: () => tracker.create({ title, customer_name: customer, cleaner_name: cleaner, original_service_date: service || null }), onSuccess: (d) => onMade(d.record.id) });
  return (
    <div className="card ct-new">
      <div className="grid-3">
        <label>Title<input value={title} placeholder="Missed Areas : Cleaner name" onChange={(e) => setTitle(e.target.value)} autoFocus /></label>
        <label>Customer Name<input value={customer} onChange={(e) => setCustomer(e.target.value)} /></label>
        <label>Cleaner Name<input value={cleaner} onChange={(e) => setCleaner(e.target.value)} /></label>
        <label>Original Service Date<input type="date" value={service} onChange={(e) => setService(e.target.value)} /></label>
      </div>
      {make.error && <div className="error small">{(make.error as Error).message}</div>}
      <div className="actions end">
        <button className="secondary" onClick={onCancel}>Cancel</button>
        <button disabled={make.isPending || (!title.trim() && !customer.trim())} onClick={() => make.mutate()}>Create complaint</button>
      </div>
    </div>
  );
}

function PositiveFeedbackList({ name }: { name: string }) {
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: ['tracker', 'positive'], queryFn: tracker.positive, refetchInterval: 30_000 });
  const done = useMutation({ mutationFn: (id: number) => tracker.setPositive(id, 'done'), onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tracker'], predicate: (q) => q.queryKey[1] !== 'meta' }) });
  const rows = list.data || [];
  return (
    <>
      <header className="page-header">
        <h1>{name} <span className="count">{rows.length}</span></h1>
      </header>
      <p className="muted small">Conversations where a client praised a cleaner, waiting to be entered as a rating in Launch27 (the UM Portal). Mark one from its conversation with "Positive feedback".</p>
      {list.error && <div className="error">{(list.error as Error).message}</div>}
      <div className="table-wrap">
        <table className="ct-table">
          <thead><tr><th>Conversation</th><th>Customer</th><th>Cleaner</th><th>Assigned User</th><th>Marked by</th><th>Updated</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.conversation_id}>
                <td>
                  <Link to={`/inbox/${r.conversation_id}?view=all`} className="ct-title">{r.subject || `Conversation #${r.conversation_id}`}</Link>
                  <div className="muted small ct-clip">{r.last_preview || ''}</div>
                </td>
                <td>{r.contact_id ? <Link to={`/contacts/${r.contact_id}`}>{r.contact_name || 'Contact'}</Link> : '—'}</td>
                <td>{r.cleaner_name || '—'}</td>
                <td>{r.owner || '—'}</td>
                <td>{r.flagged_by || '—'}</td>
                <td>{r.last_message_at ? `${ago(r.last_message_at)} ago` : '—'}</td>
                <td><button className="secondary small-btn" disabled={done.isPending} onClick={() => done.mutate(r.conversation_id)}>Entered in UM Portal</button></td>
              </tr>
            ))}
            {!rows.length && !list.isLoading && <tr><td colSpan={7} className="muted">Nothing waiting.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

// One field: saves when you leave it (or pick, for a dropdown).
function FieldInput({ field, value, onSave }: { field: TrackerField; value: string | number | null | undefined; onSave: (v: string | null) => void }) {
  const initial = value === null || value === undefined ? '' : String(value);
  const [text, setText] = useState(initial);
  useEffect(() => setText(initial), [initial]);
  const commit = () => {
    if (text !== initial) onSave(text === '' ? null : text);
  };
  if (field.type === 'select') {
    // A value loaded from Kustomer that isn't one of today's options still shows.
    const options = initial && !field.options!.includes(initial) ? [initial, ...field.options!] : field.options!;
    return (
      <select value={initial} onChange={(e) => onSave(e.target.value || null)}>
        <option value="">—</option>
        {options.map((o) => <option key={o}>{o}</option>)}
      </select>
    );
  }
  if (field.type === 'long') return <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} />;
  return <input type={field.type === 'date' ? 'date' : 'text'} inputMode={field.type === 'number' ? 'decimal' : undefined} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />;
}

// Launch27 cleaner names as the office writes them (the conversation's Cleaner picker does the same).
const stripCodes = (t: string) => t.replace(/^\s*(on\s*hold\s*)?(\s*\([^)]*\))*\s*/i, '').trim() || t;

// A name that is a record: a Launch27 cleaner, a staff login, or a contact. A name typed in
// Kustomer that nobody matched yet still shows, marked "not linked", until someone picks.
function LinkedField({ field, record, meta, onSave }: { field: TrackerField; record: ComplaintRecord; meta: TrackerMeta; onSave: (p: ComplaintPatch) => void }) {
  const name = record[field.key] ? String(record[field.key]) : '';
  const linkedId = record[field.id!] ? Number(record[field.id!]) : null;
  if (field.type === 'customer') return <CustomerPicker name={name} contactId={linkedId} onSave={onSave} />;
  if (field.type === 'cleaner') return <CleanerPicker name={name} cleanerId={linkedId} onSave={onSave} />;
  const users = meta.users.map((u) => ({ id: u.id, name: u.name || u.email }));
  if (linkedId && !users.some((u) => u.id === linkedId)) users.unshift({ id: linkedId, name: name || `#${linkedId}` });
  return (
    <select value={linkedId ?? (name ? 'typed' : '')} onChange={(e) => e.target.value !== 'typed' && onSave(e.target.value ? { [field.id!]: Number(e.target.value) } : { [field.id!]: null, [field.key]: null })}>
      <option value="">—</option>
      {!linkedId && name && <option value="typed">{name} (not linked)</option>}
      {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
    </select>
  );
}

function CleanerPicker({ name, cleanerId, onSave }: { name: string; cleanerId: number | null; onSave: (p: ComplaintPatch) => void }) {
  const teams = useActiveTeams();
  const list = useMemo(() => (teams.data || []).map((t) => ({ id: t.id, name: stripCodes(t.title) })).sort((a, b) => a.name.localeCompare(b.name)), [teams.data]);
  if (cleanerId && !list.some((t) => t.id === cleanerId)) list.unshift({ id: cleanerId, name: name || `#${cleanerId}` });
  return (
    <select value={cleanerId ?? (name ? 'typed' : '')} disabled={teams.isLoading} onChange={(e) => e.target.value !== 'typed' && onSave({ cleaner_id: e.target.value ? Number(e.target.value) : null })}>
      <option value="">{teams.isLoading ? 'Loading cleaners…' : '—'}</option>
      {!cleanerId && name && <option value="typed">{name} (not linked)</option>}
      {list.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
    </select>
  );
}

function CustomerPicker({ name, contactId, onSave }: { name: string; contactId: number | null; onSave: (p: ComplaintPatch) => void }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const found = useQuery({ queryKey: ['tracker', 'contact-search', q], queryFn: () => inbox.findContacts(q), enabled: open && q.trim().length >= 2 });
  if (!open) {
    return (
      <span className="ct-linked">
        {contactId ? <Link to={`/contacts/${contactId}`}>{name || 'Contact'}</Link> : name ? <span>{name} <span className="muted">(not linked)</span></span> : <span className="muted">—</span>}
        {' '}<button type="button" className="link small" onClick={() => { setQ(contactId ? '' : name); setOpen(true); }}>{contactId ? 'Change' : 'Link'}</button>
      </span>
    );
  }
  return (
    <span className="ct-linked-search">
      <input autoFocus placeholder="Search name, email or phone" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)} />
      <span className="assign-list">
        {(found.data || []).slice(0, 8).map((c) => (
          <button type="button" key={c.id} className="assign-item" onClick={() => { onSave({ contact_id: c.id }); setOpen(false); }}>
            {c.name || 'Unnamed'}{c.l27_customer_id ? <span className="muted small"> · Launch27 customer</span> : null}
          </button>
        ))}
        {q.trim().length >= 2 && found.data && !found.data.length && <span className="muted small">No contact matches.</span>}
      </span>
      <button type="button" className="link small" onClick={() => setOpen(false)}>Cancel</button>
    </span>
  );
}

// Admins: match names typed in Kustomer to logins and Launch27 cleaners (also runs after each load).
function MatchNames() {
  const me = useInboxMe();
  const queryClient = useQueryClient();
  const run = useMutation({ mutationFn: tracker.linkNames, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tracker'], predicate: (q) => q.queryKey[1] !== 'meta' }) });
  if (me.data?.role !== 'admin') return null;
  return (
    <div className="ct-load small">
      <button className="secondary small-btn" disabled={run.isPending} onClick={() => run.mutate()}>{run.isPending ? 'Matching names…' : 'Match names'}</button>
      <div className="muted">Links cleaner and staff names to Launch27 cleaners and logins. Names that match nobody, or more than one, stay as typed.</div>
      {run.error && <div className="error">{(run.error as Error).message}</div>}
      {run.data && <div className="muted">Matched {run.data.cleaners} cleaner and {run.data.users} staff names.</div>}
    </div>
  );
}

// The same rule the server applies when a complaint is closed (src/tracker/fields.js).
function missingCloseKeys(r: ComplaintRecord): string[] {
  const out: string[] = [];
  if (!r.final_resolution_category) out.push('final_resolution_category');
  const raw = r.manager_impact_assessment;
  const mia = raw === null || raw === undefined || String(raw).trim() === '' ? null : Number(String(raw).replace(/[$,\s]/g, ''));
  if (mia === null || !Number.isFinite(mia) || mia < 0) out.push('manager_impact_assessment');
  else if (mia > 0 && !r.mia_categories) out.push('mia_categories');
  return out;
}

const pctOf = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);

// What has kept clients before for this kind of complaint, from the Complaint playbook.
function WorkedBefore({ id, record }: { id: number; record: ComplaintRecord }) {
  const g = useQuery({ queryKey: ['tracker', 'guidance', id, record.complaint_type, record.complaint_notes, record.frequency], queryFn: () => tracker.guidance(id), staleTime: 5 * 60_000 });
  const [more, setMore] = useState(false);
  if (g.isLoading) return <section className="card ct-worked muted small">Checking what has worked before…</section>;
  if (g.error || !g.data) return null;
  const d: Guidance = g.data;
  if (!d.available) return null;
  if (!d.category) return <section className="card ct-worked small"><b>What's worked before</b> <span className="muted">· {d.reason}</span></section>;
  const c = d.cheapest;
  return (
    <section className="card ct-worked">
      <div className="ct-worked-head">
        <h2>What's worked before</h2>
        <span className="muted small">
          {d.label}{d.basis === 'notes' ? ' (read from the notes; set Complaint Type to confirm)' : ` (from Complaint Type)`} · {d.cases} {d.cases === 1 ? 'complaint' : 'complaints'} {d.window ? `${d.window.from} to ${d.window.to}` : ''}
        </span>
        <Link className="small" to="/complaints">Open the playbook</Link>
      </div>
      {d.escalation && <div className="ct-worked-alert small">{d.escalation}</div>}
      {d.ranked && d.ranked.options.length > 0 ? <RankedOptions r={d.ranked} d={d} /> : (<>
      {d.cause_label && (
        <div className="small ct-worked-note">
          Likely why (from the notes): <b>{d.cause_label}</b>.{' '}
          {d.based_on === 'cause'
            ? <span className="muted">The answer below is from the {d.cause_cases} past complaints with this root cause.</span>
            : <span className="muted">Only {d.cause_decided} past {d.cause_decided === 1 ? 'complaint' : 'complaints'} with this root cause and a known outcome, so the answer below is for all {d.label} complaints.</span>}
        </div>
      )}
      {c && !c.name ? (
        <div className="muted small">{c.reason}{d.typical ? `. We usually do: ${d.typical}` : ''}.</div>
      ) : c ? (
        <div className="ct-worked-best">
          <div><span className="muted small">Cheapest that works</span><b>{c.name}</b></div>
          <div><span className="muted small">Clients kept</span><b>{pctOf(c.saved)}</b></div>
          <div><span className="muted small">Average cost</span><b>{money(c.avg_cost)}</b></div>
          <div><span className="muted small">Confidence</span><b className={`ct-grade ${c.grade.toLowerCase()}`}>{c.grade}</b></div>
          <div className="muted small ct-worked-why">{c.reason}{d.typical && d.typical !== c.name ? `. We usually do: ${d.typical}` : ''}.</div>
        </div>
      ) : (
        <div className="muted small">No history for this kind of complaint in the playbook yet.</div>
      )}
      {d.one_time && d.one_time_stats && d.one_time_stats.n > 0 && (
        <div className="small ct-worked-note">One-time client: of past one-time clients with this kind of complaint, {pctOf(d.one_time_stats.rebooked_90)} booked again within 90 days ({d.one_time_stats.decided_90} known). The rates above are for recurring clients.</div>
      )}
      {!!d.options?.length && (
        <>
          <button type="button" className="link small" onClick={() => setMore(!more)}>{more ? 'Hide' : 'Show'} every response we've tried ({d.options.length})</button>
          {more && (
            <table className="ct-table ct-worked-table">
              <thead><tr><th>Response</th><th>Clients kept</th><th>Known outcomes</th><th>Average cost</th><th>Complaints</th></tr></thead>
              <tbody>
                {d.options.map((o) => (
                  <tr key={o.rung} className={c && o.name === c.name ? 'ct-row-best' : undefined}><td>{o.name}</td><td>{pctOf(o.saved)}</td><td>{o.decided}</td><td>{money(o.avg_cost)}</td><td>{o.n}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      </>)}
    </section>
  );
}

// The agent's options, best first: what kept similar clients, how happy they were at the end,
// how often clients took it when offered, and what it cost, with how sure we are.
const GROUP_WORD: Record<string, string> = { threat_category: 'same threat and kind of complaint', threat: 'same threat', cause_category: 'same root cause and complaint', cause: 'same root cause', category: 'same kind of complaint', all: 'all complaints' };
function RankedOptions({ r, d }: { r: Ranked; d: Guidance }) {
  const used = r.groups.find((g) => g.key === r.options[0].group);
  return (
    <>
      <div className="small ct-worked-note">
        {d.threat && d.threat !== 'none' ? <div className="ct-worked-alert">{d.threat === 'review' ? 'The client is threatening a public review' : 'The client is threatening to leave'} (from the notes). Options are ranked first on past clients who did the same.</div> : null}
        {d.cause_label ? <>Likely why (from the notes): <b>{d.cause_label}</b>. </> : null}
        <span className="muted">Ranked by how many similar {d.one_time ? 'one-time clients booked again' : 'clients were still booking 60 days later'}, from {used ? `${used.cases} past complaints (${GROUP_WORD[used.key]})` : 'past complaints'}. Each option is measured on the closest group with enough known outcomes.</span>
      </div>
      <div className="table-scroll">
      <table className="ct-table ct-worked-table ct-ranked">
        <thead><tr><th>#</th><th>Response</th><th>{d.one_time ? 'Booked again' : 'Clients kept'}</th><th>Happy at the end</th><th>Taken when offered</th><th>Avg cost</th><th>Confidence</th></tr></thead>
        <tbody>
          {r.options.map((o) => (
            <tr key={o.response} className={o.rank === 1 ? 'ct-row-best' : undefined}>
              <td>{o.rank}</td>
              <td>
                {o.label}{o.best_value && <span className="pill ct-value" title="Keeps clients almost as well as the top option, for less">best value</span>}{o.best_net && <span className="pill ct-value" title="Highest expected value for this client: the chance of keeping them times their LTV, less the cost">best for this client</span>}
                <div className="small muted">{o.cases} {o.cases === 1 ? 'case' : 'cases'} · {GROUP_WORD[o.group]}{o.first_turned_down != null && o.first_turned_down >= 0.5 ? ` · often turned down as a first offer (${pctOf(o.first_turned_down)})` : ''}</div>
              </td>
              <td>{o.kept == null ? '—' : <>{pctOf(o.kept)} <span className="small muted">{o.kept_n} of {o.decided}</span></>}</td>
              <td>{o.happy == null ? '—' : <>{pctOf(o.happy)} <span className="small muted">{o.happy_n} of {o.heard}</span></>}</td>
              <td>{o.taken_when_offered == null ? '—' : <>{pctOf(o.taken_when_offered)} <span className="small muted">of {o.offered_answered}</span></>}</td>
              <td>{money(o.avg_cost)}{o.net_value != null && <div className="small muted" title="Chance of keeping them times LTV of Client, less the average cost">net {money(o.net_value)}</div>}</td>
              <td><span className={`ct-grade ${o.grade.toLowerCase()}`}>{o.grade}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {r.client_value ? <div className="small muted ct-worked-note">Net is what each option is worth for this client: the chance of keeping them, times their LTV ({money(r.client_value)}), less the average cost. "Best for this client" is the highest net among options with enough history.</div> : <div className="small muted ct-worked-note">Fill in LTV of Client to see what each option is worth for this client.</div>}
      {d.one_time && <div className="small muted ct-worked-note">One-time client: ranked on whether similar one-time clients booked again within 120 days.</div>}
    </>
  );
}

function RecordView({ id, meta }: { id: number; meta: TrackerMeta }) {
  const queryClient = useQueryClient();
  const me = useInboxMe();
  const detail = useQuery({ queryKey: ['tracker', 'record', id], queryFn: () => tracker.get(id) });
  const [snoozing, setSnoozing] = useState(false);
  const [until, setUntil] = useState('');
  const save = useMutation({
    mutationFn: (patch: ComplaintPatch) => tracker.patch(id, patch),
    onSuccess: (d) => {
      queryClient.setQueryData(['tracker', 'record', id], d);
      queryClient.invalidateQueries({ queryKey: ['tracker'], predicate: (q) => q.queryKey[1] === 'counts' || q.queryKey[1] === 'list' });
      setSnoozing(false);
    },
  });
  const byPanel = useMemo(() => meta.panels.map((p) => ({ ...p, fields: meta.fields.filter((f) => f.panel === p.key) })), [meta]);
  // After a refused close, the fields it asked for are outlined until they're filled.
  const closeNeeds = save.error && /close/i.test((save.error as Error).message) && detail.data ? missingCloseKeys(detail.data.record) : [];
  if (detail.isLoading) return <div className="muted">Loading…</div>;
  if (detail.error || !detail.data) return <div className="error">{(detail.error as Error)?.message || 'Complaint not found'}</div>;
  const r = detail.data.record;
  const mine = me.data && r.assigned_user_id === me.data.id;
  const tomorrow9 = () => {
    const t = new Date();
    t.setDate(t.getDate() + 1);
    t.setHours(9, 0, 0, 0);
    return t.toISOString();
  };
  return (
    <div className="ct-record">
      <div className="crumbs small"><Link to="/complaint-tracking">Complaint Tracking</Link> / #{r.id}</div>
      <header className="ct-record-head">
        <div className="ct-record-title">
          <TitleInput value={r.title} onSave={(title) => save.mutate({ title })} />
          <span className={`status-pill ${r.state}`}>{r.state === 'snoozed' ? `Snoozed until ${fmtDateTime(r.snooze_until || undefined)}` : STATE_LABEL[r.state]}</span>
        </div>
        <div className="actions">
          {r.state !== 'done' && <button className="secondary" onClick={() => setSnoozing(!snoozing)}>Snooze</button>}
          {r.state !== 'done' ? <button onClick={() => save.mutate({ state: 'done' })}>Mark done</button> : <button className="secondary" onClick={() => save.mutate({ state: 'open' })}>Reopen</button>}
          {!mine && <button className="secondary" onClick={() => save.mutate({ assigned_user_id: 'me' })}>Assign to me</button>}
          <label className="inline small">Assigned User
            <select value={r.assigned_user_id ?? ''} onChange={(e) => save.mutate({ assigned_user_id: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Unassigned</option>
              {meta.users.map((u) => <option key={u.id} value={u.id}>{u.name || u.email}</option>)}
            </select>
          </label>
        </div>
      </header>
      {snoozing && (
        <div className="inline-panel">
          <div className="actions">
            <button className="secondary" onClick={() => save.mutate({ state: 'snoozed', snooze_until: new Date(Date.now() + 3 * 3_600_000).toISOString() })}>3 hours</button>
            <button className="secondary" onClick={() => save.mutate({ state: 'snoozed', snooze_until: tomorrow9() })}>Tomorrow 9am</button>
            <button className="secondary" onClick={() => save.mutate({ state: 'snoozed', snooze_until: new Date(Date.now() + 2 * 86_400_000).toISOString() })}>2 days</button>
            <input type="datetime-local" aria-label="Snooze until" value={until} onChange={(e) => setUntil(e.target.value)} />
            <button disabled={!until} onClick={() => save.mutate({ state: 'snoozed', snooze_until: new Date(until).toISOString() })}>Snooze</button>
            <button className="link" onClick={() => setSnoozing(false)}>Cancel</button>
          </div>
        </div>
      )}
      {save.error && <div className="error small">{(save.error as Error).message}</div>}
      <div className="ct-meta small muted">
        Created {fmtDateTime(r.created_at)}{r.created_by_name ? ` by ${r.created_by_name}` : r.source === 'kustomer' ? ' in Kustomer' : ''}
        {' · '}Related Conversation: {r.conversation_id ? <Link to={`/inbox/${r.conversation_id}?view=all`}>{r.conversation_subject || `#${r.conversation_id}`}</Link> : 'none'}
        {' · '}Customer: {r.contact_id ? <Link to={`/contacts/${r.contact_id}`}>{r.contact_name || String(r.customer_name || 'Contact')}</Link> : String(r.customer_name || 'not linked')}
        {r.l27_customer_id ? <> (<Link to={`/customers/${r.l27_customer_id}`}>Launch27 customer</Link>)</> : null}
        {r.l27_booking_id ? <> · <Link to={`/bookings/${r.l27_booking_id}`}>Booking #{r.l27_booking_id}</Link></> : null}
        {!r.input_into_um_portal && r.original_service_date ? <> · Launch27 rating link: {daysLeft(r.rating_days_left)}</> : null}
      </div>
      {meta.playbook && <WorkedBefore id={id} record={r} />}
      <div className="ct-panels">
        {byPanel.map((p) => (
          <section key={p.key} className="card ct-panel">
            <h2>{p.label}</h2>
            {p.fields.map((f) => (
              <label key={f.key} className={closeNeeds.includes(f.key) ? 'ct-needs' : undefined}>{f.label}{r.status !== 'Closed' && meta.close_fields?.includes(f.key) ? <span className="ct-close-tag">{f.key === 'mia_categories' ? 'needed to close, if it cost something' : 'needed to close'}</span> : null}{f.id ? <LinkedField field={f} record={r} meta={meta} onSave={(p) => save.mutate(p)} /> : <FieldInput field={f} value={r[f.key]} onSave={(v) => save.mutate({ [f.key]: v })} />}</label>
            ))}
          </section>
        ))}
      </div>
      <Comments id={id} comments={detail.data.comments} users={meta.users} />
    </div>
  );
}

function TitleInput({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return <input className="ct-title-input" aria-label="Title" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => (text.trim() && text !== value ? onSave(text.trim()) : setText(value))} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />;
}

// Internal comments. Typing @ offers the team; the person mentioned gets a notification.
function Comments({ id, comments, users }: { id: number; comments: { id: number; body: string; created_at: string; author: string | null }[]; users: TrackerMeta['users'] }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const add = useMutation({
    mutationFn: () => tracker.comment(id, text),
    onSuccess: () => {
      setText('');
      queryClient.invalidateQueries({ queryKey: ['tracker', 'record', id] });
    },
  });
  const handleOf = (u: TrackerMeta['users'][number]) => u.email.split('@')[0].toLowerCase();
  const typing = /(^|\s)@([\w.-]*)$/.exec(text);
  const offers = typing ? users.filter((u) => handleOf(u).startsWith(typing[2].toLowerCase()) || (u.name || '').toLowerCase().startsWith(typing[2].toLowerCase())).slice(0, 6) : [];
  return (
    <section className="card ct-comments">
      <h2>Comments <span className="muted small">internal, never sent to the client</span></h2>
      {comments.length === 0 && <div className="muted small">No comments yet.</div>}
      {comments.map((c) => (
        <div key={c.id} className="ct-comment">
          <div className="small"><b>{c.author || 'Someone'}</b> <span className="muted">{fmtDateTime(c.created_at)}</span></div>
          <div className="ct-comment-body">{c.body}</div>
        </div>
      ))}
      <textarea rows={3} aria-label="Add a comment" placeholder="Add a comment. Type @name to notify someone." value={text} onChange={(e) => setText(e.target.value)} />
      {offers.length > 0 && (
        <div className="actions small-actions">
          {offers.map((u) => <button key={u.id} type="button" className="secondary" onClick={() => setText(text.replace(/@([\w.-]*)$/, `@${handleOf(u)} `))}>@{handleOf(u)} <span className="muted">{u.name}</span></button>)}
        </div>
      )}
      {add.error && <div className="error small">{(add.error as Error).message}</div>}
      <div className="actions end"><button disabled={!text.trim() || add.isPending} onClick={() => add.mutate()}>Comment</button></div>
    </section>
  );
}
