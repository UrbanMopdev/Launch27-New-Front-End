import { useRef, useState } from 'react';
import { Link, NavLink, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { inbox, type ConversationDetail } from '../inbox/api';
import { ConversationView, type ComposerHandle } from '../inbox/ConversationView';
import { Avatar, Customer360 } from '../inbox/Customer360';
import { Cleaner360 } from '../inbox/Cleaner360';
import { ROLE_LABEL, ago, displayIdentity, slaText, useCounts, useInboxMe, useMeta } from '../inbox/util';
import { Icon } from '../components/Icon';
import { l27 } from '../api';
import type { Booking } from '../types';
import { liveVisit, visitStatus } from '../lib/customer360';
import { fmtTime } from '../format';

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
      <section className="ws-center">{convId ? <ConversationView key={convId} id={convId} composerRef={composer} assist={detail.data ? <AssistBar detail={detail.data} onUse={(t) => composer.current?.insert(t)} /> : null} /> : <EmptyState />}</section>
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
            <Icon name={VIEW_ICON[v.key] || 'inbox'} size={15} /> {v.label} {!!v.n && <span className={v.key === 'breached' ? 'count late' : 'count'}>{v.n}</span>}
          </button>
        ))}
        <div className="ws-views-label">Queues</div>
        {meta.data?.queues.map((qu) => (
          <button key={qu.id} className={view === `queue:${qu.id}` ? 'view active' : 'view'} onClick={() => setView(`queue:${qu.id}`)}>
            {qu.name} {qu.restricted && <Icon name="lock" size={12} label="Restricted" />} {!!counts.data?.queues[qu.id] && <span className="count">{counts.data.queues[qu.id]}</span>}
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
              <Avatar name={c.contact_name || displayIdentity(c.their_identity)} size={36} />
              <div className="ws-row-body">
                <div className="ws-row-top">
                  <span className="ws-name">
                    {c.contact_name || displayIdentity(c.their_identity)}
                    {c.contact_roles?.filter((r) => r !== 'customer').map((r) => <span key={r} className={`chip role-${r}`}>{ROLE_LABEL[r]}</span>)}
                    {c.needs_match && <span className="chip warn">Who is this?</span>}
                  </span>
                  <span className="muted small mono">{ago(c.last_message_at, now)}</span>
                </div>
                <div className="ws-preview">{c.subject ? <b>{c.subject} · </b> : null}{c.last_preview}</div>
                <div className="ws-row-meta">
                  <Icon name={c.channel} size={14} label={c.channel === 'sms' ? 'Text' : c.channel === 'email' ? 'Email' : c.channel === 'voice' ? 'Call' : 'Chat'} />
                  {sla && <span className={sla.tone === 'late' ? 'chip neg' : sla.tone === 'warn' ? 'chip warn' : 'chip'}>{sla.text}</span>}
                  {c.has_complaint && <span className="chip neg">Complaint</span>}
                  {c.l27_booking_id && <span className="chip">#{c.l27_booking_id}</span>}
                  <span className="muted small ws-owner">{c.owner_name || 'unassigned'}</span>
                </div>
              </div>
            </NavLink>
          );
        })}
      </div>
    </aside>
  );
}

const VIEW_ICON: Record<string, string> = { mine: 'inbox', unassigned: 'user', mentions: 'at', breached: 'alert', needs_match: 'question', all: 'search' };

// Spots something worth telling the customer about today's visit, from the cleaner's
// en route / check-in taps, and drafts the message.
function AssistBar({ detail, onUse }: { detail: ConversationDetail; onUse: (text: string) => void }) {
  const cid = detail.contact?.l27_customer_id;
  const isCustomer = !!cid && !detail.contact?.roles?.includes('cleaner');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const visits = useQuery({
    queryKey: ['customer', String(cid), 'today', today],
    queryFn: () => l27<Booking[]>('/v1/staff/bookings', { customers: cid!, from: today, to: today }),
    enabled: isCustomer && detail.conversation.status !== 'done',
    refetchInterval: 60_000,
  });
  const b = visits.data ? liveVisit(visits.data) : null;
  if (!b) return null;
  const s = visitStatus(b);
  const who = (b.teams?.[0]?.title || 'Your cleaner').split(' ')[0];
  const firstName = (detail.contact?.name || '').split(' ')[0];
  const end = fmtTime(new Date(s.windowEnd).toISOString());
  let line: string | null = null;
  let draft = '';
  if (s.risk?.kind === 'not_checked_in') {
    line = `${who} has been en route since ${fmtTime(s.enrouteAt)} and hasn't checked in. The window ends at ${end}.`;
    draft = `Hi ${firstName}, so sorry for the wait! ${who} is on the way now (left at ${fmtTime(s.enrouteAt)}). We'll text you the moment they arrive.`;
  } else if (s.risk?.kind === 'not_enroute') {
    line = `${who} hasn't started en route yet and the window opened at ${fmtTime(new Date(s.windowStart).toISOString())}.`;
    draft = `Hi ${firstName}, thanks for your patience. We're checking in with ${who} now and will update you in a few minutes.`;
  } else if (s.stage === 'enroute') {
    line = `${who} is on the way (en route since ${fmtTime(s.enrouteAt)}).`;
    draft = `Hi ${firstName}, good news: ${who} is on the way now (left at ${fmtTime(s.enrouteAt)}).`;
  } else if (s.stage === 'arrived') {
    line = `${who} checked in at ${fmtTime(s.checkinAt)}.`;
    draft = `Hi ${firstName}, ${who} arrived at ${fmtTime(s.checkinAt)} and is getting started.`;
  }
  if (!line) return null;
  return (
    <div className={s.risk ? 'assist risk' : 'assist'} role="status">
      <Icon name="bolt" />
      <span className="grow">
        <strong>{line}</strong> Let {firstName || 'them'} know?
      </span>
      <button type="button" className="secondary" onClick={() => onUse(draft)}>
        Draft the update
      </button>
    </div>
  );
}
