import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { l27 } from '../api';
import { fmtTime, todayISO, TIMEZONE } from '../format';
import type { Booking, Customer, Tag } from '../types';
import { inbox } from './api';
import { displayIdentity, useMeta } from './util';
import { alertPermission, askForAlerts, callAlertText, flashTitle, showCallAlert } from './callAlerts';
import { NewCaller } from './NewCaller';
import { badgeFor, blankCaller, hasUnsavedWork, identifyCaller, isHidden, pageFor, rememberChoice, type Caller } from './caller';

// RingCentral Embeddable: RingCentral's own softphone widget, loaded into the workspace.
// Agents sign in with their RingCentral login inside the widget, and calls ring in the
// browser while the workspace is open. Behavior follows "Incoming calls: desired behavior"
// (approved Nov 10, 2026):
//   - while it rings: a card with who is calling and why they may be calling (R-1 to R-9),
//     a desktop alert and blinking tab when the portal is in the background; the page the
//     agent is on never moves while it rings
//   - when answered: the caller's page opens (A-1 to A-5), in a new tab if the agent has
//     unsaved typing (A-8); a number shared by several customers asks who it is (A-4, D-3)
//   - when it ends: the call is logged on the right conversation (POST /api/calls)
// It only loads when RINGCENTRAL_CLIENT_ID is set on the server (UrbanMop's registered app).
// With real logins outside production (record: false) nothing is looked up or saved.

const ADAPTER = 'https://apps.ringcentral.com/integration/ringcentral-embeddable/latest/adapter.js';

type RcCall = {
  telephonySessionId?: string;
  sessionId?: string;
  id?: string;
  direction?: string;
  from?: string | { phoneNumber?: string };
  to?: string | { phoneNumber?: string };
  fromNumber?: string;
  toNumber?: string;
  startTime?: number | string;
  endTime?: number | string;
  callEndTime?: number | string;
  duration?: number;
  callStatus?: string;
  result?: string;
  recording?: { contentUri?: string; link?: string };
  simulated?: boolean; // a test call from the Channel simulator (test data only)
};

const num = (v: RcCall['from'], alt?: string) => (typeof v === 'string' ? v : v?.phoneNumber) || alt || '';
const keyOf = (c?: RcCall) => c?.telephonySessionId || c?.sessionId || c?.id || '';

type Missed = { key: string; phone: string; name: string | null; badge: string | null; conversationId: number | null; note: string | null };
type Pop = { key: string; caller: Caller; loading: boolean; answered: boolean; simulated: boolean };

export function RingCentralPhone() {
  const meta = useMeta();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [pop, setPop] = useState<Pop | null>(null);
  const [picker, setPicker] = useState<Caller | null>(null);
  const [missed, setMissed] = useState<Missed[]>([]);
  const [newCaller, setNewCaller] = useState<{ caller: Caller; canSave: boolean; simulated: boolean } | null>(null);
  const ringing = useRef(new Map<string, Caller | null>()); // call key -> caller (null while looking up)
  const answered = useRef(new Set<string>());
  const simulatedKeys = useRef(new Set<string>());
  const stopAlert = useRef<() => void>(() => {});
  const cfg = meta.data?.ringcentral;
  const [askAlerts, setAskAlerts] = useState(() => {
    try {
      return alertPermission() === 'default' && localStorage.getItem('callAlertsAsked') !== '1';
    } catch {
      return alertPermission() === 'default';
    }
  });
  const doneAsking = () => {
    setAskAlerts(false);
    try {
      localStorage.setItem('callAlertsAsked', '1');
    } catch {
      /* private window */
    }
  };

  // A-8: never throw away what the agent is typing; open the page in a new tab instead.
  const openPage = (path: string) => {
    if (hasUnsavedWork()) window.open(path, '_blank', 'noopener');
    else navigate(path);
  };
  const openRef = useRef(openPage);
  openRef.current = openPage;

  useEffect(() => {
    if (!cfg?.clientId || document.getElementById('rc-adapter-script')) return;
    const s = document.createElement('script');
    s.id = 'rc-adapter-script';
    // defaultDirection=left: the widget sits bottom left, clear of the call card (top right).
    // disableGlip / disableMeeting: the portal uses calls only. Our RingCentral app has no
    // Team Messaging or Video permissions, so leaving those features on makes the widget call
    // APIs that always fail (403), which RingCentral flags as a high error rate.
    const params = new URLSearchParams({ clientId: cfg.clientId, defaultDirection: 'left', disableGlip: 'true', disableMeeting: 'true', ...(cfg.appServer ? { appServer: cfg.appServer } : {}) });
    s.src = `${ADAPTER}?${params}`;
    s.async = true;
    document.body.appendChild(s);
  }, [cfg?.clientId, cfg?.appServer]);

  useEffect(() => {
    if (!cfg?.clientId) return;
    const saving = cfg.record !== false;

    // When the agent answers: open the caller's page, or ask which customer it is.
    const onAnswered = (key: string, caller: Caller, simulated: boolean) => {
      setPop((p) => (p && p.key === key ? { ...p, answered: true } : p));
      // A-6: unknown and hidden callers get the "New caller" screen; the card stays up too.
      if (caller.kind === 'unknown' || caller.kind === 'hidden') {
        setNewCaller({ caller, canSave: saving || simulated, simulated });
        return;
      }
      if (caller.kind === 'several') {
        setPicker(caller);
        return;
      }
      const path = pageFor(caller);
      if (path) {
        openRef.current(path);
        setPop((p) => (p && p.key === key ? null : p)); // the page now shows everything
      }
    };

    const onEvent = async (data: { type?: string; call?: RcCall }) => {
      if (!data || typeof data !== 'object' || !data.type?.startsWith('rc-')) return;
      const call = data.call;
      const key = keyOf(call);

      if (data.type === 'rc-call-ring-notify' && call) {
        const phone = num(call.from, call.fromNumber);
        const k = key || phone;
        // The card shows the number at once and fills in the name when the lookup returns.
        ringing.current.set(k, null);
        simulatedKeys.current[call.simulated ? 'add' : 'delete'](k);
        setPop({ key: k, caller: blankCaller(phone), loading: saving || !!call.simulated, answered: false, simulated: !!call.simulated });
        stopAlert.current();
        const background = document.hidden || !document.hasFocus();
        const stopFlash = background ? flashTitle(`☎ ${displayIdentity(phone)}`) : () => {};
        let closeAlert = () => {};
        stopAlert.current = () => {
          stopFlash();
          closeAlert();
          stopAlert.current = () => {};
        };
        // Real logins in dev/QA: don't send real callers' numbers to the test server.
        // Simulated calls use test data, so they are looked up everywhere.
        const caller = saving || call.simulated ? await identifyCaller(phone, !!call.simulated, saving || !!call.simulated).catch(() => blankCaller(phone)) : blankCaller(phone);
        if (!ringing.current.has(k)) return; // already over
        ringing.current.set(k, caller);
        setPop((p) => (p && p.key === k ? { ...p, caller, loading: false } : p));
        if (background) {
          closeAlert = showCallAlert(callAlertText(phone, caller.kind === 'several' ? null : caller.name, caller.kind), k, () => {
            const path = pageFor(caller);
            if (path) openRef.current(path);
          });
        }
        if (answered.current.has(k)) onAnswered(k, caller, !!call.simulated); // answered before the lookup returned
        return;
      }

      if (data.type === 'rc-call-start-notify' || data.type === 'rc-call-end-notify') stopAlert.current();

      if (data.type === 'rc-call-start-notify') {
        // Only calls that rang here (inbound); outbound calls start without ringing.
        const k = ringing.current.has(key) ? key : ringing.current.size === 1 ? [...ringing.current.keys()][0] : '';
        if (!k) return;
        answered.current.add(k);
        const caller = ringing.current.get(k);
        if (caller) onAnswered(k, caller, simulatedKeys.current.has(k));
        return;
      }

      if (data.type === 'rc-call-end-notify' && call) {
        const k = ringing.current.has(key) ? key : ringing.current.has(num(call.from, call.fromNumber)) ? num(call.from, call.fromNumber) : key;
        const wasAnswered = answered.current.has(k) || /connected|answered|accepted/i.test(call.callStatus || call.result || '');
        const rang = ringing.current.has(k);
        const known = ringing.current.get(k) || null;
        ringing.current.delete(k);
        simulatedKeys.current.delete(k);
        answered.current.delete(k);
        setPop((p) => (p && p.key === k ? null : p));
        const inbound = /in/i.test(call.direction || '');
        const phone = num(call.from, call.fromNumber);
        // A missed call leaves a card until dismissed, pointing at its callback (V-1).
        const showMissed = (conversationId: number | null, note: string | null) =>
          rang && inbound && !wasAnswered &&
          setMissed((m) => [{ key: k, phone, name: known?.kind === 'several' ? null : known?.name || null, badge: known ? badgeFor(known) : null, conversationId, note }, ...m.filter((x) => x.key !== k)].slice(0, 3));
        // Real calls are saved only where calls are recorded; test calls from the simulator always.
        if (!saving && !call.simulated) {
          showMissed(null, 'Not saved on this test site.');
          return;
        }
        const start = call.startTime ? Number(new Date(call.startTime)) : Date.now();
        const end = call.endTime || call.callEndTime ? Number(new Date((call.endTime || call.callEndTime)!)) : Date.now();
        const res = await inbox
          .logCall({
            call_id: key || undefined,
            ...(call.simulated ? { simulated: true } : {}),
            direction: inbound ? 'inbound' : 'outbound',
            from: num(call.from, call.fromNumber),
            to: num(call.to, call.toNumber),
            started_at: new Date(start).toISOString(),
            duration_seconds: call.duration ?? Math.max(0, Math.round((end - start) / 1000)),
            result: wasAnswered ? 'answered' : inbound ? 'missed' : 'no_answer',
            recording_url: call.recording?.link || call.recording?.contentUri || null,
          })
          .catch(() => null);
        showMissed(res?.conversationId ?? null, res?.hidden ? 'Hidden number: no way to call back.' : res?.conversationId ? null : 'Could not log this call.');
        queryClient.invalidateQueries({ queryKey: ['inbox'] });
      }
    };
    const onDial = (e: Event) => {
      const phone = (e as CustomEvent<string>).detail;
      const frame = document.querySelector<HTMLIFrameElement>('#rc-widget-adapter-frame');
      frame?.contentWindow?.postMessage({ type: 'rc-adapter-new-call', phoneNumber: phone, toCall: true }, '*');
    };
    // Real calls come from the RingCentral widget as window messages. Test calls from the
    // Channel simulator come as a private event the widget never sees (it must not get
    // fake call messages).
    const onMessage = (e: MessageEvent) => {
      // Simulated calls only arrive through the private event below.
      if (e.data && typeof e.data === 'object' && !(e.data as { call?: RcCall }).call?.simulated) void onEvent(e.data);
    };
    const onSimulated = (e: Event) => void onEvent({ ...(e as CustomEvent<{ type: string; call: RcCall }>).detail });
    window.addEventListener('message', onMessage);
    window.addEventListener('workspace:sim-call', onSimulated);
    window.addEventListener('workspace:dial', onDial);
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('workspace:sim-call', onSimulated);
      window.removeEventListener('workspace:dial', onDial);
      stopAlert.current();
    };
  }, [cfg?.clientId, cfg?.record, queryClient]);

  const pick = (caller: Caller, customerId: number) => {
    rememberChoice(caller.phone, customerId);
    setPicker(null);
    setPop((p) => (p && p.caller.phone === caller.phone ? null : p));
    openPage(`/customers/${customerId}`);
  };

  return (
    <>
      {picker && (
        <CallSafe key={`pick-${picker.phone}`}>
          <WhoIsCalling caller={picker} onPick={(id) => pick(picker, id)} onClose={() => setPicker(null)} />
        </CallSafe>
      )}
      {newCaller && (
        <CallSafe key={`new-${newCaller.caller.phone}`}>
          <NewCaller
            caller={newCaller.caller}
            canSave={newCaller.canSave}
            simulated={newCaller.simulated}
            onClose={() => setNewCaller(null)}
            onDone={(path) => {
              setNewCaller(null);
              setPop((p) => (p && p.caller.phone === newCaller.caller.phone ? null : p));
              queryClient.invalidateQueries({ queryKey: ['inbox'] });
              if (path) openPage(path);
            }}
          />
        </CallSafe>
      )}
      <div className="call-stack">
      {pop ? (
        <CallSafe key={pop.key}>
          <CallCard pop={pop} onOpen={openPage} onDismiss={() => setPop(null)} onPick={() => setPicker(pop.caller)} onAdd={() => setNewCaller({ caller: pop.caller, canSave: cfg?.record !== false || pop.simulated, simulated: pop.simulated })} />
        </CallSafe>
      ) : cfg?.clientId && askAlerts ? (
        <div className="call-pop call-pop-ask" role="status">
          <div className="call-pop-title">Phone</div>
          <div className="small">Get a desktop alert when a call rings while you're in another tab or app?</div>
          <div className="actions">
            <button onClick={() => askForAlerts().finally(doneAsking)}>Turn on call alerts</button>
            <button className="secondary" onClick={doneAsking}>Not now</button>
          </div>
        </div>
      ) : null}
      {missed.map((m) => (
        <CallSafe key={`missed-${m.key}`}>
          <div className="call-pop call-missed" role="status">
            <div className="call-pop-title">☎ Missed call</div>
            <div className="call-pop-who">
              {m.name || (isHidden(m.phone) ? 'Hidden number' : displayIdentity(m.phone))} {m.badge && !isHidden(m.phone) && <span className="role-badge">{m.badge}</span>}
            </div>
            {m.name && <div className="muted small">{displayIdentity(m.phone)}</div>}
            {m.conversationId ? <div className="small">Added to Calls › Waiting for a callback.</div> : m.note && <div className="small muted">{m.note}</div>}
            <div className="actions">
              {m.conversationId && (
                <button onClick={() => { setMissed((x) => x.filter((y) => y.key !== m.key)); openPage(`/inbox/${m.conversationId}`); }}>Open callback</button>
              )}
              <button className="secondary" onClick={() => setMissed((x) => x.filter((y) => y.key !== m.key))}>Dismiss</button>
            </div>
          </div>
        </CallSafe>
      ))}
      </div>
    </>
  );
}

// A problem drawing the call card must never take the page (or the phone) down with it:
// hide the card (the widget still shows the call) and keep the error for the browser console.
class CallSafe extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    console.error('Call card failed', err);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

// R-1 to R-5: who is calling and why they may be calling. It never takes focus (R-7).
function CallCard({ pop, onOpen, onDismiss, onPick, onAdd }: { pop: Pop; onOpen: (path: string) => void; onDismiss: () => void; onPick: () => void; onAdd: () => void }) {
  const c = pop.caller;
  const path = pageFor(c);
  const conv = c.open[0];
  return (
    <div className="call-pop" role="status" aria-live="polite">
      <div className="call-pop-title">{pop.answered ? '☎ On call' : '☎ Incoming call'}</div>
      <div className="call-pop-who">
        {pop.loading ? displayIdentity(c.phone) : c.name || (c.kind === 'hidden' ? 'Hidden number' : displayIdentity(c.phone))}{' '}
        {!pop.loading && <span className={`role-badge ${c.flag ? 'warn' : c.kind === 'cleaner' ? 'cleaner' : c.kind === 'customer' ? 'customer' : ''}`}>{badgeFor(c)}</span>}
      </div>
      {c.kind !== 'hidden' && !pop.loading && c.name && <div className="muted small">{displayIdentity(c.phone)}</div>}
      {pop.loading && <div className="muted small">Looking up…</div>}
      {!pop.loading && c.linked && <div className="small">Now linked to their Launch27 customer record.</div>}
      {!pop.loading && c.flag && <div className="small warn">{c.flag === 'spam' ? 'Marked as spam on an earlier call.' : 'Marked as a wrong number on an earlier call.'}</div>}
      {!pop.loading && c.kind === 'customer' && c.customerId && <CustomerFacts id={c.customerId} />}
      {!pop.loading && c.kind === 'cleaner' && c.teamId && <CleanerFacts id={c.teamId} />}
      {!pop.loading && c.kind === 'several' && (
        <ul className="call-pop-list small">
          {c.matches.map((m) => (
            <li key={m.customerId}>
              <strong>{m.name}</strong>
              {m.customerId === c.preselect && <span className="muted"> · last time</span>}
              {m.address && <div className="muted">{m.address}</div>}
            </li>
          ))}
        </ul>
      )}
      {!pop.loading && c.open.length > 0 && (
        <div className="call-pop-facts small">
          <div className="muted">Open conversations</div>
          {c.open.slice(0, 3).map((o) => (
            <div key={o.id}>{o.subject || `${o.channel} conversation`}</div>
          ))}
        </div>
      )}
      {!pop.loading && (c.kind === 'unknown' || c.kind === 'hidden') && <div className="small muted">Not in Launch27 or the inbox.</div>}
      <div className="actions">
        {path && <button onClick={() => onOpen(path)}>Open {c.kind === 'cleaner' ? 'cleaner' : c.kind === 'customer' ? 'customer' : 'profile'}</button>}
        {c.kind === 'several' && <button onClick={onPick}>Who is it?</button>}
        {!pop.loading && (c.kind === 'unknown' || c.kind === 'hidden') && <button onClick={onAdd}>Add contact</button>}
        {conv && <button className="secondary" onClick={() => onOpen(`/inbox/${conv.id}`)}>Open conversation</button>}
        <button className="secondary" onClick={onDismiss}>Dismiss</button>
      </div>
    </div>
  );
}

const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: TIMEZONE, weekday: 'short', month: 'short', day: 'numeric' }) : '');
const RATING = ['Unhappy', 'Okay', 'Happy'];

// R-2: next booking, last visit and how it went, tags, the customer's own notes.
function CustomerFacts({ id }: { id: number }) {
  const next = useQuery({ queryKey: ['call', 'customer', id, 'next'], queryFn: () => l27<Booking[]>('/v1/staff/bookings', { customers: id, options: 'not_completed', sort: 'asc', limit: 1 }), staleTime: 60_000 });
  const last = useQuery({ queryKey: ['call', 'customer', id, 'last'], queryFn: () => l27<(Booking & { feedback?: { rating?: number } })[]>('/v1/staff/bookings', { customers: id, options: 'completed,exclude_forecasted', sort: 'desc', limit: 1 }), staleTime: 60_000 });
  const tags = useQuery({ queryKey: ['customer', String(id), 'tags'], queryFn: () => l27<Tag[]>(`/v1/staff/customers/${id}/tags`), staleTime: 5 * 60_000 });
  const customer = useQuery({ queryKey: ['customer', String(id)], queryFn: () => l27<Customer>(`/v1/staff/customers/${id}`), staleTime: 5 * 60_000 });
  const n = next.data?.[0];
  const l = last.data?.[0];
  const rating = l?.feedback?.rating;
  const note = (customer.data?.notes || '').split(/\r?\n/).find((x) => x.trim());
  return (
    <div className="call-pop-facts small">
      <div>
        <span className="muted">Next: </span>
        {next.isLoading ? '…' : n ? `${day(n.service_date)} ${fmtTime(n.service_date)}${n.teams?.length ? ` · ${n.teams.map((t) => t.title).join(', ')}` : ''}` : 'nothing booked'}
      </div>
      <div>
        <span className="muted">Last visit: </span>
        {last.isLoading ? '…' : l ? `${day(l.service_date)}${typeof rating === 'number' ? ` · ${RATING[rating] || 'rated'}` : ''}` : 'none yet'}
      </div>
      {!!tags.data?.length && <div className="chips">{tags.data.slice(0, 4).map((t) => <span key={t.id} className="chip">{t.name}</span>)}</div>}
      {note && <div className="muted">Note: {note.length > 90 ? `${note.slice(0, 90)}…` : note}</div>}
    </div>
  );
}

// R-3: the cleaner's jobs today.
function CleanerFacts({ id }: { id: number }) {
  const today = todayISO();
  const jobs = useQuery({ queryKey: ['call', 'cleaner', id, today], queryFn: () => l27<Booking[]>('/v1/staff/bookings', { teams: id, from: today, to: today, sort: 'asc', limit: 20 }), staleTime: 60_000 });
  const list = jobs.data || [];
  return (
    <div className="call-pop-facts small">
      <div className="muted">Today</div>
      {jobs.isLoading ? <div>…</div> : list.length ? list.slice(0, 4).map((b) => (
        <div key={b.id}>
          {fmtTime(b.service_date)} · {b.address?.street || b.address?.full_address || 'address'}{b.completed ? ' · done' : ''}
        </div>
      )) : <div>No jobs today</div>}
      {list.length > 4 && <div className="muted">+{list.length - 4} more</div>}
    </div>
  );
}

// A-4 / D-3: several customers share the number; ask who it is, last choice pre-selected.
function WhoIsCalling({ caller, onPick, onClose }: { caller: Caller; onPick: (customerId: number) => void; onClose: () => void }) {
  const [chosen, setChosen] = useState<number | null>(caller.preselect);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card modal" role="dialog" aria-label="Who is calling?" onClick={(e) => e.stopPropagation()}>
        <h2>Who is calling?</h2>
        <p className="muted small">{displayIdentity(caller.phone)} belongs to {caller.matches.length} customers.</p>
        <div className="call-pick">
          {caller.matches.map((m) => (
            <label key={m.customerId} className="check">
              <input type="radio" name="caller" checked={chosen === m.customerId} onChange={() => setChosen(m.customerId)} />
              <span>
                <strong>{m.name}</strong>
                {m.customerId === caller.preselect && <span className="muted"> · picked last time</span>}
                {m.address && <span className="muted small"> · {m.address}</span>}
              </span>
            </label>
          ))}
        </div>
        <div className="actions end">
          <button type="button" className="secondary" onClick={onClose}>Not now</button>
          <button type="button" disabled={!chosen} onClick={() => chosen && onPick(chosen)}>Open customer</button>
        </div>
      </div>
    </div>
  );
}
