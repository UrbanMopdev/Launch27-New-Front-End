import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { inbox } from './api';
import { CHANNEL_ICON, ROLE_LABEL, ago } from './util';

// Ctrl/Cmd+K anywhere: find a person, a conversation, or jump to a booking number.
export function CommandBar() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const results = useQuery({ queryKey: ['inbox', 'search', q], queryFn: () => inbox.search(q), enabled: open && q.trim().length >= 2 });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('workspace:search', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('workspace:search', onOpen);
    };
  }, []);
  useEffect(() => {
    if (open) setTimeout(() => input.current?.focus(), 0);
  }, [open]);

  if (!open) return null;
  const go = (path: string) => {
    setOpen(false);
    setQ('');
    navigate(path);
  };
  const bookingId = /^#?\d{4,}$/.test(q.trim()) ? q.trim().replace('#', '') : null;

  return (
    <div className="modal-backdrop top" onClick={() => setOpen(false)}>
      <div className="card cmdbar" onClick={(e) => e.stopPropagation()}>
        <input ref={input} className="full" placeholder="Search people, phone, email, message text or booking #" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="cmd-results">
          {bookingId && <button className="cmd-item" onClick={() => go(`/bookings/${bookingId}`)}>📅 Open booking #{bookingId}</button>}
          {results.data?.contacts.map((c) => (
            <button key={`c${c.id}`} className="cmd-item" onClick={() => go(`/contacts/${c.id}`)}>
              👤 {c.name || 'Unnamed'} {c.roles?.map((r) => <span key={r} className={`role-badge ${r}`}>{ROLE_LABEL[r]}</span>)} <span className="muted small">{c.identities}</span>
            </button>
          ))}
          {results.data?.conversations.map((c) => (
            <button key={`v${c.id}`} className="cmd-item" onClick={() => go(`/inbox/${c.id}?view=all`)}>
              {CHANNEL_ICON[c.channel]} {c.contact_name || 'Unknown'} <span className="muted small">#{c.id} · {c.status} · {ago(c.last_message_at)}</span>
              <div className="small muted clip">{c.subject || c.snippet}</div>
            </button>
          ))}
          {q.length >= 2 && results.data && !results.data.contacts.length && !results.data.conversations.length && !bookingId && <div className="muted small pad">No matches.</div>}
        </div>
        <div className="muted small">Ctrl+K to open · Esc to close</div>
      </div>
    </div>
  );
}
