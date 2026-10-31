import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { inbox, type Channel, type Complaint, type ConversationDetail, type Disposition, type Message } from './api';
import { CHANNEL_ICON, CHANNEL_LABEL, ROLE_LABEL, ago, displayIdentity, drafts, fillTemplate, firstName, slaText, useInboxMe, useMeta } from './util';
import { fmtDateTime } from '../format';

export interface ComposerHandle {
  insert: (text: string) => void;
}

export function ConversationView({ id, composerRef }: { id: number; composerRef?: React.Ref<ComposerHandle> }) {
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ['inbox', 'conversation', id], queryFn: () => inbox.get(id), refetchInterval: 5_000 });
  const me = useInboxMe();
  const meta = useMeta();
  const [panel, setPanel] = useState<null | 'done' | 'snooze' | 'assign' | 'complaint'>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['inbox'] });
  const act = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => {
      setError(null);
      setPanel(null);
      refresh();
    },
    onError: (err) => setError((err as Error).message),
  });

  if (detail.isLoading) return <div className="conv-empty muted">Loading…</div>;
  if (detail.error) return <div className="conv-empty error">{(detail.error as Error).message}</div>;
  const d = detail.data!;
  const c = d.conversation;
  const sla = c.status === 'open' ? slaText(c.sla_due_at) : null;
  const mine = me.data && c.owner_id === me.data.id;

  return (
    <div className="conv">
      <header className="conv-header">
        <div className="conv-who">
          <div className="mobile-only small">
            <Link to="/inbox">← Inbox</Link>
            {d.contact && <> · <Link to={`/contacts/${d.contact.id}`}>Profile and bookings</Link></>}
          </div>
          <h2>
            {d.contact?.name || displayIdentity(c.their_identity) || 'Unknown sender'}
            {d.contact?.roles?.map((r) => <span key={r} className={`role-badge ${r}`}>{ROLE_LABEL[r]}</span>)}
          </h2>
          <div className="muted small">
            {CHANNEL_ICON[c.channel]} {CHANNEL_LABEL[c.channel]} · {displayIdentity(c.their_identity)} → {displayIdentity(c.our_identity)} · #{c.id}
            {c.subject && <> · <span className="clip">{c.subject}</span></>}
          </div>
        </div>
        <div className="conv-state">
          <span className={`status-pill ${c.status}`}>{c.status === 'snoozed' ? `Snoozed until ${fmtDateTime(c.snooze_until || undefined)}` : c.status}</span>
          {sla && <span className={`sla ${sla.tone}`} title={d.sla_policy?.name}>{sla.text}</span>}
          {c.priority >= 4 && <span className="pill late">P{c.priority}</span>}
        </div>
      </header>

      <div className="conv-toolbar">
        <span className="small">
          {d.queue?.name || 'No queue'} · {d.owner ? <>Owner: <b>{d.owner.name || d.owner.email}</b>{d.owner.presence !== 'available' && <span className="muted"> ({d.owner.presence})</span>}</> : <span className="warn">Unassigned</span>}
        </span>
        <div className="actions">
          {!c.owner_id && <button onClick={() => act.mutate(() => inbox.claim(id))}>Claim</button>}
          <button className="secondary" onClick={() => setPanel(panel === 'assign' ? null : 'assign')}>Assign</button>
          {c.status !== 'done' && <button className="secondary" onClick={() => setPanel(panel === 'snooze' ? null : 'snooze')}>Snooze</button>}
          <button className="secondary" onClick={() => setPanel(panel === 'complaint' ? null : 'complaint')}>{c.complaint ? 'Complaint ●' : 'Complaint'}</button>
          {c.status !== 'done' ? (
            <button onClick={() => setPanel(panel === 'done' ? null : 'done')}>Done</button>
          ) : (
            <button className="secondary" onClick={() => act.mutate(() => inbox.patch(id, { status: 'open' }))}>Reopen</button>
          )}
        </div>
      </div>
      {error && <div className="error small">{error}</div>}

      {panel === 'done' && meta.data && <DonePanel initial={c.disposition || {}} roles={d.contact?.roles || []} meta={meta.data.dispositions} busy={act.isPending} onCancel={() => setPanel(null)} onSave={(disposition) => act.mutate(() => inbox.patch(id, { status: 'done', disposition }))} />}
      {panel === 'snooze' && <SnoozePanel onCancel={() => setPanel(null)} onSave={(until) => act.mutate(() => inbox.patch(id, { status: 'snoozed', snooze_until: until }))} />}
      {panel === 'assign' && <AssignPanel detail={d} onCancel={() => setPanel(null)} onAssign={(userId, reason) => act.mutate(() => inbox.assign(id, userId, reason))} onMove={(queueId) => act.mutate(() => inbox.patch(id, { queue_id: queueId }))} />}
      {panel === 'complaint' && <ComplaintPanel initial={c.complaint} bookingId={c.l27_booking_id} onCancel={() => setPanel(null)} onSave={(complaint) => act.mutate(() => inbox.patch(id, { complaint }))} />}
      {c.needs_match && <MatchPanel detail={d} onMatch={(contactId) => act.mutate(() => inbox.match(id, contactId))} />}

      <Timeline messages={d.messages} />

      {c.status === 'done' && c.disposition && (
        <div className="done-banner small">
          Done: {c.disposition.audience} · {c.disposition.reason} · {c.disposition.outcome}
          {c.disposition.note && <> · {c.disposition.note}</>}
        </div>
      )}
      <Composer ref={composerRef} detail={d} mine={!!mine} onSent={refresh} />
    </div>
  );
}

function Timeline({ messages }: { messages: Message[] }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Braces matter: newer browsers return a promise from scrollIntoView, which React would treat as a cleanup.
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);
  return (
    <div className="timeline">
      {messages.map((m) => {
        if (m.kind === 'event') {
          return (
            <div key={m.id} className="tl-event">
              <span>{m.body}</span> <span className="muted">{ago(m.created_at)}</span>
            </div>
          );
        }
        if (m.kind === 'note') {
          return (
            <div key={m.id} className="tl-msg note">
              <div className="tl-meta">🔒 Internal note · {m.author_name} · {fmtDateTime(m.created_at)}</div>
              <div className="pre">{m.body}</div>
            </div>
          );
        }
        if (m.kind === 'call') {
          return (
            <div key={m.id} className={`tl-msg call ${m.direction}`}>
              <div className="tl-meta">☎ {m.body} · {fmtDateTime(m.created_at)}</div>
              {m.meta?.recording_url && <a href={String(m.meta.recording_url)} target="_blank" rel="noreferrer" className="small">Recording</a>}
            </div>
          );
        }
        const notSent = m.delivery_state === 'not_connected' || m.delivery_state === 'failed';
        return (
          <div key={m.id} className={`tl-msg ${m.direction}`}>
            <div className="tl-meta">
              {m.channel && CHANNEL_ICON[m.channel]} {m.direction === 'out' ? m.author_name || 'Agent' : displayIdentity(m.from_addr)}
              {m.direction === 'out' && <> → {displayIdentity(m.to_addr)}</>} · {fmtDateTime(m.created_at)}
              {m.direction === 'out' && <span className={notSent ? 'delivery bad' : 'delivery'}> · {m.delivery_state === 'not_connected' ? 'not sent: channel not connected' : m.delivery_state}</span>}
            </div>
            {m.subject && m.channel === 'email' && <div className="small"><b>{m.subject}</b></div>}
            <div className="pre">{m.body}</div>
          </div>
        );
      })}
      <div ref={end} />
    </div>
  );
}

const Composer = forwardRef<ComposerHandle, { detail: ConversationDetail; mine: boolean; onSent: () => void }>(function Composer({ detail, onSent }, ref) {
  const c = detail.conversation;
  const meta = useMeta();
  const location = useLocation();
  const key = `conv:${c.id}`;
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  const [text, setText] = useState(() => drafts.get(key) || (location.state as { prefill?: string } | null)?.prefill || '');
  const [channel, setChannel] = useState<Channel>(c.channel === 'voice' || c.channel === 'chat' ? (detail.contact?.identities.some((i) => i.kind === 'phone') ? 'sms' : 'email') : c.channel);
  const [to, setTo] = useState('');
  const [from, setFrom] = useState('');
  const [subject, setSubject] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => ({
    insert: (t: string) => {
      setText((cur) => (cur ? `${cur}${cur.endsWith(' ') ? '' : ' '}${t}` : t));
      setMode('reply');
      area.current?.focus();
    },
  }));
  useEffect(() => {
    drafts.set(key, text);
  }, [key, text]);

  const kind = channel === 'email' ? 'email' : 'phone';
  const targets = (detail.contact?.identities || []).filter((i) => i.kind === kind);
  const defaultTo = channel === c.channel ? c.their_identity : targets[0]?.value;
  const target = to || defaultTo || '';
  const optedOut = channel === 'sms' && targets.find((i) => i.value === target)?.opted_out;
  const fromOptions = channel === 'email' ? meta.data?.identities.email : meta.data?.identities.sms;
  const sender = from || (channel === c.channel ? c.our_identity : fromOptions?.[0]) || '';
  const connected = meta.data?.connected_channels.includes(channel);

  // "/" opens canned replies; type to filter.
  const slash = mode === 'reply' && /(^|\s)\/(\w*)$/.exec(text);
  const canned = useMemo(() => {
    if (!slash || !meta.data) return [];
    const q = slash[2].toLowerCase();
    return meta.data.canned.filter((x) => (!x.channels.length || x.channels.includes(channel)) && (x.shortcut.includes(q) || x.title.toLowerCase().includes(q))).slice(0, 6);
  }, [slash, meta.data, channel]);
  const pick = (body: string) => {
    const filled = fillTemplate(body, { first_name: firstName(detail.contact) });
    setText((cur) => cur.replace(/(^|\s)\/\w*$/, `$1${filled}`));
    area.current?.focus();
  };

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'note') await inbox.note(c.id, text);
      else await inbox.reply(c.id, { body: text, channel, to: target, from: sender, subject: channel === 'email' && subject ? subject : undefined });
      setText('');
      drafts.set(key, '');
      onSent();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const segments = channel === 'sms' ? Math.max(1, Math.ceil(text.length / (/[^\x00-\x7F]/.test(text) ? 67 : 153))) : 0;

  return (
    <div className={mode === 'note' ? 'composer note-mode' : 'composer'}>
      <div className="composer-tabs">
        <button className={mode === 'reply' ? 'tab active' : 'tab'} onClick={() => setMode('reply')}>Reply</button>
        <button className={mode === 'note' ? 'tab active' : 'tab'} onClick={() => setMode('note')}>🔒 Internal note</button>
        {mode === 'reply' && (
          <div className="composer-route small">
            <select value={channel} onChange={(e) => { setChannel(e.target.value as Channel); setTo(''); setFrom(''); }}>
              <option value="sms">Text</option>
              <option value="email">Email</option>
            </select>
            to
            <select value={target} onChange={(e) => setTo(e.target.value)}>
              {target && !targets.some((t) => t.value === target) && <option value={target}>{displayIdentity(target)}</option>}
              {targets.map((t) => <option key={t.id} value={t.value}>{displayIdentity(t.value)}{t.opted_out ? ' (STOP)' : ''}</option>)}
            </select>
            from
            <select value={sender} onChange={(e) => setFrom(e.target.value)}>
              {sender && !fromOptions?.includes(sender) && <option value={sender}>{displayIdentity(sender)}</option>}
              {fromOptions?.map((f) => <option key={f} value={f}>{displayIdentity(f)}</option>)}
            </select>
          </div>
        )}
      </div>
      {mode === 'reply' && channel === 'email' && channel !== c.channel && <input className="full" placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />}
      <div className="composer-box">
        <textarea
          ref={area}
          rows={4}
          value={text}
          placeholder={mode === 'note' ? 'Only your team sees this. @name to notify someone.' : 'Type a reply. "/" for saved replies. Ctrl+Enter to send.'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim() && !busy && !optedOut) send();
          }}
        />
        {!!canned.length && (
          <div className="canned-pop">
            {canned.map((x) => (
              <button key={x.id} className="canned-item" onMouseDown={(e) => { e.preventDefault(); pick(x.body); }}>
                <b>/{x.shortcut}</b> {x.title}
              </button>
            ))}
          </div>
        )}
      </div>
      {error && <div className="error small">{error}</div>}
      {optedOut && <div className="error small">This number replied STOP. Texts are blocked until they text START.</div>}
      <div className="composer-foot">
        <span className="muted small">
          {mode === 'reply' && !connected && `${CHANNEL_LABEL[channel]} isn't connected yet: replies are saved, not sent.`}
          {mode === 'reply' && channel === 'sms' && text && ` ${text.length} chars · ${segments} SMS`}
        </span>
        <button disabled={busy || !text.trim() || !!optedOut} className={mode === 'note' ? 'note-btn' : ''} onClick={send}>
          {busy ? 'Saving…' : mode === 'note' ? 'Add note' : 'Send'}
        </button>
      </div>
    </div>
  );
});

function DonePanel({ initial, roles, meta, busy, onCancel, onSave }: { initial: Disposition; roles: string[]; meta: { audience: string[]; reason: string[]; outcome: string[]; cancellationReasons: string[] }; busy: boolean; onCancel: () => void; onSave: (d: Disposition) => void }) {
  const guess = roles.includes('cleaner') ? 'Cleaner' : roles.includes('applicant') ? 'Applicant' : roles.includes('customer') ? 'Customer' : undefined;
  const [d, setD] = useState<Disposition>({ audience: guess, ...initial });
  const set = (k: keyof Disposition) => (e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) => setD({ ...d, [k]: e.target.value || undefined });
  return (
    <div className="inline-panel">
      <div className="grid-3">
        <label>Who<select value={d.audience || ''} onChange={set('audience')}><option value="">Pick…</option>{meta.audience.map((x) => <option key={x}>{x}</option>)}</select></label>
        <label>Reason<select value={d.reason || ''} onChange={set('reason')}><option value="">Pick…</option>{meta.reason.map((x) => <option key={x}>{x}</option>)}</select></label>
        <label>Outcome<select value={d.outcome || ''} onChange={set('outcome')}><option value="">Pick…</option>{meta.outcome.map((x) => <option key={x}>{x}</option>)}</select></label>
      </div>
      {d.reason === 'Cancellation' && (
        <label>Cancellation reason<select value={d.cancellation_reason || ''} onChange={set('cancellation_reason')}><option value="">Pick…</option>{meta.cancellationReasons.map((x) => <option key={x}>{x}</option>)}</select></label>
      )}
      <label>Note (optional)<input className="full" value={d.note || ''} onChange={set('note')} /></label>
      <div className="actions end">
        <button className="secondary" onClick={onCancel}>Cancel</button>
        <button disabled={busy || !d.audience || !d.reason || !d.outcome} onClick={() => onSave(d)}>Mark done</button>
      </div>
    </div>
  );
}

function SnoozePanel({ onCancel, onSave }: { onCancel: () => void; onSave: (iso: string) => void }) {
  const opts = [
    ['1 hour', 60],
    ['3 hours', 180],
    ['Tomorrow 9am', -1],
    ['2 days', 2 * 24 * 60],
  ] as const;
  const [custom, setCustom] = useState('');
  const at = (mins: number) => {
    if (mins >= 0) return new Date(Date.now() + mins * 60_000).toISOString();
    const t = new Date();
    t.setDate(t.getDate() + 1);
    t.setHours(9, 0, 0, 0);
    return t.toISOString();
  };
  return (
    <div className="inline-panel">
      <div className="actions">
        {opts.map(([label, mins]) => <button key={label} className="secondary" onClick={() => onSave(at(mins))}>{label}</button>)}
        <input type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} />
        <button disabled={!custom} onClick={() => onSave(new Date(custom).toISOString())}>Snooze</button>
        <button className="link" onClick={onCancel}>Cancel</button>
      </div>
      <div className="muted small">It comes back to you at that time, or sooner if they reply. The reply target pauses meanwhile.</div>
    </div>
  );
}

function AssignPanel({ detail, onCancel, onAssign, onMove }: { detail: ConversationDetail; onCancel: () => void; onAssign: (userId: number | null, reason?: string) => void; onMove: (queueId: number) => void }) {
  const users = useQuery({ queryKey: ['inbox', 'users'], queryFn: inbox.users });
  const meta = useMeta();
  const [reason, setReason] = useState('');
  return (
    <div className="inline-panel">
      <div className="grid-2 tight">
        <div>
          <div className="small muted">Assign to</div>
          <div className="assign-list">
            {users.data?.map((u) => (
              <button key={u.id} className="assign-item" onClick={() => onAssign(u.id, reason || undefined)}>
                <span className={`presence-dot ${u.presence}`} /> {u.name || u.email} <span className="muted small">{u.open_count} open</span>
              </button>
            ))}
            {detail.conversation.owner_id && <button className="assign-item" onClick={() => onAssign(null, reason || undefined)}>↩ Back to the queue</button>}
          </div>
          <input className="full" placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <div>
          <div className="small muted">Move to queue</div>
          <div className="assign-list">
            {meta.data?.queues.map((q) => (
              <button key={q.id} className="assign-item" disabled={q.id === detail.conversation.queue_id} onClick={() => onMove(q.id)}>
                {q.name}
              </button>
            ))}
          </div>
        </div>
      </div>
      <button className="link" onClick={onCancel}>Close</button>
    </div>
  );
}

function ComplaintPanel({ initial, bookingId, onCancel, onSave }: { initial: Complaint | null; bookingId: number | null; onCancel: () => void; onSave: (c: Complaint | null) => void }) {
  const [c, setC] = useState<Complaint>(initial || { booking_id: bookingId, status: 'open', outcome: 'pending' });
  return (
    <div className="inline-panel">
      <div className="grid-3">
        <label>Booking #<input value={c.booking_id ?? ''} onChange={(e) => setC({ ...c, booking_id: e.target.value ? Number(e.target.value) : null })} /></label>
        <label>Cleaner<input value={c.cleaner || ''} onChange={(e) => setC({ ...c, cleaner: e.target.value })} /></label>
        <label>Outcome<select value={c.outcome} onChange={(e) => setC({ ...c, outcome: e.target.value as Complaint['outcome'] })}>{['pending', 'return clean', 'credit', 'refund', 'none'].map((o) => <option key={o}>{o}</option>)}</select></label>
      </div>
      <label>What went wrong<textarea rows={2} value={c.issue || ''} onChange={(e) => setC({ ...c, issue: e.target.value })} /></label>
      <div className="grid-3">
        <label>Cost to us ($)<input type="number" value={c.monetary_impact ?? ''} onChange={(e) => setC({ ...c, monetary_impact: e.target.value ? Number(e.target.value) : null })} /></label>
        <label>Status<select value={c.status} onChange={(e) => setC({ ...c, status: e.target.value as Complaint['status'] })}><option value="open">open</option><option value="resolved">resolved</option></select></label>
      </div>
      <div className="actions end">
        {initial && <button className="link" onClick={() => onSave(null)}>Remove complaint</button>}
        <button className="secondary" onClick={onCancel}>Cancel</button>
        <button onClick={() => onSave(c)}>Save complaint</button>
      </div>
    </div>
  );
}

function MatchPanel({ detail, onMatch }: { detail: ConversationDetail; onMatch: (contactId: number) => void }) {
  const [q, setQ] = useState('');
  const found = useQuery({ queryKey: ['inbox', 'contacts', q], queryFn: () => inbox.findContacts(q), enabled: q.length >= 2 });
  const list = q.length >= 2 ? found.data || [] : detail.candidates;
  return (
    <div className="inline-panel warn-panel">
      <div className="small"><b>Who is this?</b> {displayIdentity(detail.conversation.their_identity)} matches {detail.candidates.length || 'no'} contacts. Pick the right person; nothing is merged automatically.</div>
      <input className="full" placeholder="Search contacts" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="assign-list">
        {list.map((c) => (
          <button key={c.id} className="assign-item" onClick={() => onMatch(c.id)}>
            {c.name || 'Unnamed'} {c.roles?.map((r) => <span key={r} className={`role-badge ${r}`}>{ROLE_LABEL[r]}</span>)}
          </button>
        ))}
      </div>
      <div className="muted small">Not listed? Open their Launch27 customer or cleaner page and use "Message" to create the contact.</div>
    </div>
  );
}
