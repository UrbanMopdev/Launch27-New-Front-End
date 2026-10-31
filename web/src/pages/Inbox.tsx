import { useRef, useState } from 'react';
import { Link, NavLink, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { inbox, type ConversationDetail } from '../inbox/api';
import { ConversationView, type ComposerHandle } from '../inbox/ConversationView';
import { Customer360 } from '../inbox/Customer360';
import { Cleaner360 } from '../inbox/Cleaner360';
import { CHANNEL_ICON, ROLE_LABEL, ago, displayIdentity, slaText, useCounts, useInboxMe, useMeta } from '../inbox/util';

// The one-stop support workspace: work list | conversation | 360.
export function InboxPage() {
  const { id } = useParams();
  const convId = id ? Number(id) : null;
  const composer = useRef<ComposerHandle>(null);
  const [params, setParams] = useSearchParams();
  const view = params.get('view') || 'mine';
  const detail = useQuery({ queryKey: ['inbox', 'conversation', convId], queryFn: () => inbox.get(convId!), enabled: !!convId, refetchInterval: 5_000 });

  return (
    <div className={convId ? 'workspace has-conv' : 'workspace'}>
      <WorkList view={view} setView={(v) => setParams(v === 'mine' ? {} : { view: v })} activeId={convId} />
      <section className="ws-center">{convId ? <ConversationView key={convId} id={convId} composerRef={composer} /> : <EmptyState />}</section>
      <aside className="ws-right">{detail.data ? <Panel360 key={`${convId}-${detail.data.contact?.id}`} detail={detail.data} onInsert={(t) => composer.current?.insert(t)} /> : <div className="muted small pad">Pick a conversation to see the customer or cleaner here.</div>}</aside>
    </div>
  );
}

function Panel360({ detail, onInsert }: { detail: ConversationDetail; onInsert: (t: string) => void }) {
  const contact = detail.contact;
  const roles = contact?.roles || [];
  const both = roles.includes('cleaner') && roles.includes('customer');
  const [tab, setTab] = useState<'customer' | 'cleaner'>(roles.includes('cleaner') ? 'cleaner' : 'customer');
  if (!contact) return <div className="muted small pad">Match this conversation to a contact to see their 360.</div>;
  const showCleaner = both ? tab === 'cleaner' : roles.includes('cleaner');
  return (
    <>
      {both && (
        <div className="tabs compact pad-x">
          <button className={tab === 'customer' ? 'tab active' : 'tab'} onClick={() => setTab('customer')}>As customer</button>
          <button className={tab === 'cleaner' ? 'tab active' : 'tab'} onClick={() => setTab('cleaner')}>As cleaner</button>
        </div>
      )}
      {showCleaner ? (
        <Cleaner360 contact={contact} conversationId={detail.conversation.id} onInsert={onInsert} />
      ) : (
        <Customer360 contact={contact} conversationId={detail.conversation.id} pinnedBookingId={detail.conversation.l27_booking_id} onInsert={onInsert} />
      )}
      <div className="pad-x small"><Link to={`/contacts/${contact.id}`}>Full profile →</Link></div>
    </>
  );
}

function EmptyState() {
  const counts = useCounts();
  return (
    <div className="conv-empty">
      <h2>Support workspace</h2>
      <p className="muted">{counts.data ? `${counts.data.mine} open for you · ${counts.data.unassigned} unassigned · ${counts.data.breached} past their reply target` : 'Loading…'}</p>
      <p className="muted small">Channels aren't connected yet. Use the <Link to="/inbox-simulator">simulator</Link> to send test messages through routing.</p>
    </div>
  );
}

function WorkList({ view, setView, activeId }: { view: string; setView: (v: string) => void; activeId: number | null }) {
  const me = useInboxMe();
  const meta = useMeta();
  const counts = useCounts();
  const navigate = useNavigate();
  const [status, setStatus] = useState('open');
  const [channel, setChannel] = useState('');
  const [role, setRole] = useState('');
  const [q, setQ] = useState('');
  const list = useQuery({
    queryKey: ['inbox', 'list', view, status, channel, role, q],
    queryFn: () => inbox.list({ view, status, channel: channel || undefined, role: role || undefined, q: q || undefined }),
    refetchInterval: 5_000,
  });
  const views = [
    { key: 'mine', label: 'Mine', n: counts.data?.mine },
    { key: 'unassigned', label: 'Unassigned', n: counts.data?.unassigned },
    { key: 'mentions', label: 'Mentions', n: counts.data?.mentions },
    { key: 'breached', label: 'Late', n: counts.data?.breached },
    { key: 'needs_match', label: 'Who is this?', n: counts.data?.needs_match },
    { key: 'all', label: 'All' },
  ];
  const now = Date.now();

  return (
    <aside className="ws-left">
      <div className="ws-views">
        {views.map((v) => (
          <button key={v.key} className={view === v.key ? 'view active' : 'view'} onClick={() => setView(v.key)}>
            {v.label} {!!v.n && <span className={v.key === 'breached' ? 'count late' : 'count'}>{v.n}</span>}
          </button>
        ))}
        <div className="ws-views-label">Queues</div>
        {meta.data?.queues.map((qu) => (
          <button key={qu.id} className={view === `queue:${qu.id}` ? 'view active' : 'view'} onClick={() => setView(`queue:${qu.id}`)}>
            {qu.name} {qu.restricted && '🔒'} {!!counts.data?.queues[qu.id] && <span className="count">{counts.data.queues[qu.id]}</span>}
          </button>
        ))}
      </div>
      <div className="ws-filters">
        <input placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="open">Open</option>
          <option value="snoozed">Snoozed</option>
          <option value="done">Done</option>
          <option value="all">Any status</option>
        </select>
        <select value={channel} onChange={(e) => setChannel(e.target.value)}>
          <option value="">All channels</option>
          <option value="sms">Text</option>
          <option value="email">Email</option>
          <option value="voice">Calls</option>
          <option value="chat">Chat</option>
        </select>
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="">Everyone</option>
          <option value="customer">Customers</option>
          <option value="cleaner">Cleaners</option>
          <option value="applicant">Applicants</option>
        </select>
      </div>
      <div className="ws-list">
        {list.isLoading && <div className="muted small pad">Loading…</div>}
        {list.data?.length === 0 && <div className="muted small pad">{view === 'mine' && me.data?.presence !== 'available' ? 'Nothing assigned. Set yourself to Available to receive work.' : 'Nothing here.'}</div>}
        {list.data?.map((c) => {
          const sla = c.status === 'open' ? slaText(c.sla_due_at, now) : null;
          return (
            <NavLink key={c.id} to={`/inbox/${c.id}${view !== 'mine' ? `?view=${encodeURIComponent(view)}` : ''}`} className={c.id === activeId ? 'ws-row active' : 'ws-row'} onClick={(e) => { e.preventDefault(); navigate(`/inbox/${c.id}${view !== 'mine' ? `?view=${encodeURIComponent(view)}` : ''}`); }}>
              <div className="ws-row-top">
                <span className="ws-name">
                  {CHANNEL_ICON[c.channel]} {c.contact_name || displayIdentity(c.their_identity)}
                  {c.contact_roles?.filter((r) => r !== 'customer').map((r) => <span key={r} className={`role-badge ${r}`}>{ROLE_LABEL[r]}</span>)}
                  {c.needs_match && <span className="role-badge unknown">?</span>}
                </span>
                <span className="muted small">{ago(c.last_message_at, now)}</span>
              </div>
              <div className="ws-preview">{c.subject ? <b>{c.subject} </b> : null}{c.last_preview}</div>
              <div className="ws-row-meta small">
                <span className="muted">{c.queue_name}{c.owner_name ? ` · ${c.owner_name}` : ' · unassigned'}</span>
                {c.l27_booking_id && <span className="pill">#{c.l27_booking_id}</span>}
                {c.has_complaint && <span className="pill late">complaint</span>}
                {sla && <span className={`sla ${sla.tone}`}>{sla.text}</span>}
              </div>
            </NavLink>
          );
        })}
      </div>
    </aside>
  );
}
