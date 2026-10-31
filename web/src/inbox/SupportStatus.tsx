import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { inbox, type Presence } from './api';
import { ago, useInboxMe } from './util';

// Sidebar footer: my availability for routed work, and my notifications.
export function SupportStatus() {
  const me = useInboxMe();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const notes = useQuery({ queryKey: ['inbox', 'notifications'], queryFn: inbox.notifications, refetchInterval: 15_000, enabled: !!me.data });
  if (!me.data) return null;
  const unread = notes.data?.filter((n) => !n.read_at).length || 0;
  const setPresence = async (p: Presence) => {
    const r = await inbox.setPresence(p);
    queryClient.invalidateQueries({ queryKey: ['inbox'] });
    if (r.requeued) alert(`${r.requeued} open conversation(s) went back to their queues.`);
  };
  return (
    <div className="support-status">
      <label className="presence">
        <span className={`presence-dot ${me.data.presence}`} />
        <select value={me.data.presence} onChange={(e) => setPresence(e.target.value as Presence)}>
          <option value="available">Available</option>
          <option value="busy">Busy</option>
          <option value="offline">Offline</option>
        </select>
      </label>
      <button className="link bell" onClick={() => setOpen(!open)} aria-label="Notifications">
        🔔{unread > 0 && <span className="count late">{unread}</span>}
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
