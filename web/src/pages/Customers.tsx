import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ResourceList } from '../components/ResourceList';
import type { Customer } from '../types';
import { fmtDateTime } from '../format';
import { useInboxMe } from '../inbox/util';
import { segmentsApi, type SegmentId, type SegmentSummary, type TraitId } from '../segments/api';
import { SEGMENT_HELP, SegmentPill, TraitTag, UpdatedLine, money, shortDate } from '../segments/ui';

export const customerName = (c: Customer) => [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company_name || c.email || `#${c.id}`;

const PAGE = 50;
// Ops to-do lists: the segments where a call or offer makes a difference.
const TODO: { id: SegmentId; text: string }[] = [
  { id: 'risk', text: 'Plan customers with nothing booked: call before they lapse' },
  { id: 'repeat', text: 'Keep booking one-time cleans: offer a plan' },
  { id: 'first', text: 'New customers: ask for a rating, offer a second clean' },
];

export function CustomersPage() {
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'directory' ? 'directory' : 'segments';
  const setView = (v: string) => {
    const next = new URLSearchParams(params);
    if (v === 'segments') next.delete('view');
    else next.set('view', v);
    setParams(next, { replace: true });
  };
  return (
    <>
      <div className="tabs seg-view-tabs">
        <button className={view === 'segments' ? 'tab active' : 'tab'} onClick={() => setView('segments')}>Segments</button>
        <button className={view === 'directory' ? 'tab active' : 'tab'} onClick={() => setView('directory')}>Directory</button>
      </div>
      {view === 'segments' ? <SegmentsView /> : <Directory />}
    </>
  );
}

function SegmentsView() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = useInboxMe();
  const [params, setParams] = useSearchParams();
  const segment = (params.get('segment') as SegmentId | null) || null;
  const traits = (params.get('traits') || '').split(',').filter(Boolean) as TraitId[];
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);

  const summary = useQuery({ queryKey: ['segments', 'summary'], queryFn: segmentsApi.summary, refetchInterval: (query) => (query.state.data?.running ? 5000 : 60_000) });
  const list = useQuery({
    queryKey: ['segments', 'customers', segment, traits.join(','), q, page],
    queryFn: () => segmentsApi.customers({ segment, traits, q: q.trim() || undefined, limit: PAGE, offset: page * PAGE }),
    placeholderData: (prev) => prev,
  });
  const refresh = useMutation({ mutationFn: segmentsApi.refresh, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['segments'] }) });

  const update = (seg: SegmentId | null, tr: TraitId[]) => {
    const next = new URLSearchParams(params);
    if (seg) next.set('segment', seg);
    else next.delete('segment');
    if (tr.length) next.set('traits', tr.join(','));
    else next.delete('traits');
    setParams(next, { replace: true });
    setPage(0);
  };
  const s = summary.data;
  const current = s?.segments.find((x) => x.id === segment);
  const isAdmin = me.data?.role === 'admin';

  return (
    <div className="seg-page">
      <header className="page-header">
        <div className="seg-head">
          <h1>Customers</h1>
          <p className="muted">Find a customer or work a list. Segments update on their own from booking history.</p>
          <UpdatedLine summary={s} />
        </div>
        <div className="seg-head-actions">
          <label className="seg-search">
            <span className="sr-only">Search customers</span>
            <input type="search" placeholder="Name, email or phone" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
          </label>
          {isAdmin && (
            <button className="secondary" disabled={refresh.isPending || s?.running} onClick={() => refresh.mutate()}>
              {s?.running ? 'Updating…' : 'Update now'}
            </button>
          )}
        </div>
      </header>

      {summary.isError && <div className="error">{(summary.error as Error).message}</div>}
      {s && s.total === 0 && (
        <section className="card seg-empty">
          <h2>{s.running ? 'Working out segments…' : 'No segments yet'}</h2>
          <p className="muted">
            {s.running
              ? 'The first update reads the last 18 months of bookings and rebuilds the past year. This takes a few minutes.'
              : s.last_error
                ? `The last update failed: ${s.last_error}`
                : 'Segments appear after the first update.'}
          </p>
          {isAdmin && !s.running && <button onClick={() => refresh.mutate()}>Update now</button>}
        </section>
      )}

      {s && s.total > 0 && (
        <>
          <section aria-label="Needs attention" className="seg-section">
            <h2 className="eyebrow">Needs attention</h2>
            <div className="seg-todo">
              {TODO.map((t) => {
                const n = s.segments.find((x) => x.id === t.id)?.count ?? 0;
                return (
                  <Link key={t.id} to={`/customers/segments/${t.id}`} className="seg-todo-card">
                    <SegmentPill segment={t.id} />
                    <span className="seg-todo-count">{n.toLocaleString('en-CA')}</span>
                    <span className="seg-todo-text">{t.text}</span>
                    <span className="seg-todo-go">Open list →</span>
                  </Link>
                );
              })}
            </div>
          </section>

          <section aria-label="Segment" className="seg-filter">
            <span className="small seg-traits-label">Segment</span>
            <button className={!segment ? 'chip-btn active' : 'chip-btn'} aria-pressed={!segment} onClick={() => update(null, traits)}>
              All <span className="seg-chip-count">{s.total.toLocaleString('en-CA')}</span>
            </button>
            {s.segments.map((x) => (
              <button key={x.id} className={segment === x.id ? 'chip-btn active' : 'chip-btn'} aria-pressed={segment === x.id} onClick={() => update(segment === x.id ? null : x.id, traits)}>
                {x.label} <span className="seg-chip-count">{x.count.toLocaleString('en-CA')}</span>
              </button>
            ))}
          </section>

          <section aria-label="Traits" className="seg-traits">
            <span className="small seg-traits-label">Trait</span>
            {s.traits.map((t) => {
              const on = traits.includes(t.id);
              return (
                <button key={t.id} className={on ? 'chip-btn active' : 'chip-btn'} aria-pressed={on} onClick={() => update(segment, on ? traits.filter((x) => x !== t.id) : [...traits, t.id])}>
                  {t.label} <span className="seg-chip-count">{t.count}</span>
                </button>
              );
            })}
          </section>

          <section className="card flush">
            <div className="seg-table-head">
              <div>
                <h2>{current ? current.label : 'All customers'}</h2>
                <span className="muted small">
                  {current ? SEGMENT_HELP[current.id](s.settings) : 'Pick a segment above to focus the list.'}
                  {traits.length > 0 && <> Only: {traits.map((t) => s.traits.find((x) => x.id === t)?.label).join(', ')}.</>}
                </span>
              </div>
              {current && current.group === 'active' && (
                <Link className="button secondary-link" to={`/customers/segments/${current.id}`}>Open work list</Link>
              )}
            </div>
            <div className="table-scroll">
              <table className="seg-table">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Segment</th>
                    <th>Plan</th>
                    <th>Last clean</th>
                    <th>Next clean</th>
                    <th className="num">12-mo spend</th>
                    <th>Suggested next step</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data?.rows.map((r) => (
                    <tr key={r.customer_id} className="clickable" onClick={() => navigate(`/customers/${r.customer_id}`)}>
                      <td>
                        <Link to={`/customers/${r.customer_id}`} onClick={(e) => e.stopPropagation()} className="seg-name">{r.name || `#${r.customer_id}`}</Link>
                        {r.traits.length > 0 && <div className="seg-trait-row">{r.traits.map((t) => <TraitTag key={t} trait={t} />)}</div>}
                      </td>
                      <td><SegmentPill segment={r.segment} /></td>
                      <td className="muted">{r.plan || '—'}</td>
                      <td>{shortDate(r.last_clean)}</td>
                      <td>{r.next_clean ? shortDate(r.next_clean) : <span className="muted">None booked</span>}</td>
                      <td className="num mono">{money(r.spend_12m)}</td>
                      <td>{r.suggestion}</td>
                    </tr>
                  ))}
                  {list.data && list.data.rows.length === 0 && (
                    <tr><td colSpan={7} className="muted seg-none-row">No customers match.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <Pager total={list.data?.total ?? 0} page={page} setPage={setPage} />
          </section>
        </>
      )}
    </div>
  );
}

export function Pager({ total, page, setPage }: { total: number; page: number; setPage: (p: number) => void }) {
  const pages = Math.ceil(total / PAGE);
  return (
    <div className="seg-pager">
      <span className="muted small">{total.toLocaleString('en-CA')} customers</span>
      {pages > 1 && (
        <span className="seg-pager-btns">
          <button className="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
          <span className="small">Page {page + 1} of {pages}</span>
          <button className="secondary" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Next</button>
        </span>
      )}
    </div>
  );
}

export type { SegmentSummary };

// The full Launch27 customer list (including deleted), as before.
function Directory() {
  const navigate = useNavigate();
  return (
    <ResourceList<Customer>
      title="Customer directory"
      path="/v1/staff/customers"
      searchParam="query"
      tabs={[
        { label: 'Active', params: { filter: 'active' } },
        { label: 'All' },
        { label: 'Deleted', path: '/v1/staff/customers/deleted', hasCount: false },
      ]}
      onRowClick={(c) => navigate(`/customers/${c.id}`)}
      columns={[
        { header: 'Name', render: (c) => (
          <>
            {customerName(c)}
            {c.is_new_customer && <span className="badge">new</span>}
          </>
        ) },
        { header: 'Email', render: (c) => c.email || '—' },
        { header: 'Phone', render: (c) => c.phone || '—' },
        { header: 'Address', render: (c) => [c.address, c.city].filter(Boolean).join(', ') || '—' },
        { header: 'Tags', render: (c) => c.tags_info?.map((t) => <span key={t.id} className="pill">{t.name}</span>) },
        { header: 'Created', render: (c) => fmtDateTime(c.created_at) },
      ]}
    />
  );
}
