import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { inbox } from './api';
import { ago, useInboxMe } from './util';
import { Icon } from '../components/Icon';

// Sidebar footer: my availability for routed work, and my notifications.
export function SupportStatus() {
  const me = useInboxMe();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const notes = useQuery({ queryKey: ['inbox', 'notifications'], queryFn: inbox.notifications, refetchInterval: 15_000, enabled: !!me.data });
  if (!me.data) return null;
  const unread = notes.data?.filter((n) => !n.read_at).length || 0;
  const changeStatus = async (id: number) => {
    const r = await inbox.setStatus(id);
    queryClient.invalidateQueries({ queryKey: ['inbox'] });
    if (r.requeued) alert(`${r.requeued} open conversation(s) went back to their queues.`);
  };
  const current = me.data.status;
  const mins = current?.status_since ? Math.floor((Date.now() - new Date(current.status_since).getTime()) / 60_000) : null;
  const over = !!current?.max_minutes && mins !== null && mins > current.max_minutes;
  const options = (me.data.statuses || []).filter((x) => x.selectable || x.id === current?.id);
  return (
    <div className="support-status">
      <label className="presence" title={current ? `${current.name}${mins !== null ? ` for ${mins} min` : ''}` : undefined}>
        <span className="status-dot" style={{ background: current?.color || '#6b7280' }} />
        <span className="sr-only">My status</span>
        <select value={current?.id ?? ''} onChange={(e) => changeStatus(Number(e.target.value))}>
          {!current && <option value="">Set status…</option>}
          {options.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
              {x.max_minutes ? ` (${x.max_minutes} min)` : ''}
            </option>
          ))}
        </select>
        {mins !== null && current?.kind !== 'available' && <span className={over ? 'status-time over' : 'status-time'}>{mins}m</span>}
      </label>
      <button className="icon-button bell" onClick={() => setOpen(!open)} aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'} title="Notifications">
        <Icon name="bell" size={18} />
        {unread > 0 && <span className="bell-badge">{unread}</span>}
      </button>
      {open && (
        <div className="notif-pop">
          <div className="notif-head">
            <b>Notifications</b>
            <button className="link small" onClick={() => inbox.readNotifications().then(() => queryClient.invalidateQueries({ queryKey: ['inbox', 'notifications'] }))}>Mark all read</button>
          </div>
          {notes.data?.length === 0 && <div className="muted small">Nothing yet.</div>}
          {notes.data?.slice(0, 20).map((n) => (
            <button key={n.id} className={n.read_at ? 'notif read' : 'notif'} onClick={() => { setOpen(false); if (n.conversation_id) navigate(`/inbox/${n.conversation_id}?view=all`); }}>
              <span>{n.text}{n.contact_name ? `: ${n.contact_name}` : ''}</span>
              <span className="muted small">{ago(n.created_at)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
