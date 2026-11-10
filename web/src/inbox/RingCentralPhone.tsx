import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { inbox } from './api';
import { displayIdentity, ROLE_LABEL, useMeta } from './util';
import { alertPermission, askForAlerts, callAlertText, flashTitle, showCallAlert } from './callAlerts';

// RingCentral Embeddable: RingCentral's own softphone widget, loaded into the workspace.
// Agents sign in with their RingCentral login inside the widget, and calls ring in the
// browser while the workspace is open. We listen to the widget's events to:
//   - pop the caller's profile when a call rings, plus a desktop alert and a blinking tab
//     title when the portal is in the background (needs the browser's permission once)
//   - log every finished call on the right conversation (POST /api/calls)
// and send it "dial this number" messages for click-to-call.
// It only loads when RINGCENTRAL_CLIENT_ID is set on the server (UrbanMop's registered app).
//
// Event names and payloads follow RingCentral's Embeddable docs; check them against the
// widget version in use when the client ID is first configured.

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
};

const num = (v: RcCall['from'], alt?: string) => (typeof v === 'string' ? v : v?.phoneNumber) || alt || '';

export function RingCentralPhone() {
  const meta = useMeta();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [pop, setPop] = useState<null | { phone: string; name?: string; role?: string; conversationId?: number; contactId?: number; href?: string }>(null);
  const answered = useRef(new Set<string>());
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

  useEffect(() => {
    if (!cfg?.clientId || document.getElementById('rc-adapter-script')) return;
    const s = document.createElement('script');
    s.id = 'rc-adapter-script';
    const params = new URLSearchParams({ clientId: cfg.clientId, ...(cfg.appServer ? { appServer: cfg.appServer } : {}) });
    s.src = `${ADAPTER}?${params}`;
    s.async = true;
    document.body.appendChild(s);
  }, [cfg?.clientId, cfg?.appServer]);

  useEffect(() => {
    if (!cfg?.clientId) return;
    const onMessage = async (e: MessageEvent) => {
      const data = e.data as { type?: string; call?: RcCall };
      if (!data || typeof data !== 'object' || !data.type?.startsWith('rc-')) return;
      const call = data.call;
      const key = call?.telephonySessionId || call?.sessionId || call?.id || '';
      if (data.type === 'rc-call-ring-notify' && call) {
        const phone = num(call.from, call.fromNumber);
        // Real logins in dev/QA: don't send real callers' numbers to the test server.
        const who = cfg.record === false ? null : await inbox.lookup('phone', phone).catch(() => null);
        const contact = who?.contacts[0];
        const p = { phone, name: contact?.name || who?.l27?.name, role: (contact?.roles || who?.l27?.roles || [])[0], conversationId: who?.open[0]?.id, contactId: contact?.id, href: who?.l27?.l27_team_id ? `/cleaners/${who.l27.l27_team_id}` : who?.l27?.l27_customer_id ? `/customers/${who.l27.l27_customer_id}` : undefined };
        setPop(p);
        // Ringing while the portal is in the background: a desktop alert and a blinking tab.
        stopAlert.current();
        if (document.hidden || !document.hasFocus()) {
          const text = callAlertText(phone, p.name, p.role);
          const stopFlash = flashTitle(text.tabTitle);
          const close = showCallAlert(text, key || phone, () => {
            if (p.conversationId) navigate(`/inbox/${p.conversationId}`);
            else if (p.contactId) navigate(`/contacts/${p.contactId}`);
            else if (p.href) navigate(p.href);
          });
          stopAlert.current = () => {
            stopFlash();
            close();
            stopAlert.current = () => {};
          };
        }
      }
      if (data.type === 'rc-call-start-notify' || data.type === 'rc-call-end-notify') stopAlert.current();
      if (data.type === 'rc-call-start-notify' && key) answered.current.add(key);
      if (data.type === 'rc-call-end-notify' && call && cfg.record === false) {
        answered.current.delete(key);
        setPop(null);
        return;
      }
      if (data.type === 'rc-call-end-notify' && call) {
        const inbound = /in/i.test(call.direction || '');
        const start = call.startTime ? Number(new Date(call.startTime)) : Date.now();
        const end = call.endTime || call.callEndTime ? Number(new Date((call.endTime || call.callEndTime)!)) : Date.now();
        const wasAnswered = answered.current.has(key) || /connected|answered|accepted/i.test(call.callStatus || call.result || '');
        const res = await inbox
          .logCall({
            call_id: key || undefined,
            direction: inbound ? 'inbound' : 'outbound',
            from: num(call.from, call.fromNumber),
            to: num(call.to, call.toNumber),
            started_at: new Date(start).toISOString(),
            duration_seconds: call.duration ?? Math.max(0, Math.round((end - start) / 1000)),
            result: wasAnswered ? 'answered' : inbound ? 'missed' : 'no_answer',
            recording_url: call.recording?.link || call.recording?.contentUri || null,
          })
          .catch(() => null);
        answered.current.delete(key);
        setPop(null);
        queryClient.invalidateQueries({ queryKey: ['inbox'] });
        if (res && wasAnswered) navigate(`/inbox/${res.conversationId}`);
      }
    };
    const onDial = (e: Event) => {
      const phone = (e as CustomEvent<string>).detail;
      const frame = document.querySelector<HTMLIFrameElement>('#rc-widget-adapter-frame');
      frame?.contentWindow?.postMessage({ type: 'rc-adapter-new-call', phoneNumber: phone, toCall: true }, '*');
    };
    window.addEventListener('message', onMessage);
    window.addEventListener('workspace:dial', onDial);
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('workspace:dial', onDial);
      stopAlert.current();
    };
  }, [cfg?.clientId, cfg?.record, navigate, queryClient]);

  if (!pop) {
    if (!cfg?.clientId || !askAlerts) return null;
    return (
      <div className="call-pop call-pop-ask" role="status">
        <div className="call-pop-title">Phone</div>
        <div className="small">Get a desktop alert when a call rings while you're in another tab or app?</div>
        <div className="actions">
          <button onClick={() => askForAlerts().finally(doneAsking)}>Turn on call alerts</button>
          <button className="secondary" onClick={doneAsking}>Not now</button>
        </div>
      </div>
    );
  }
  return (
    <div className="call-pop" role="alert">
      <div className="call-pop-title">☎ Incoming call</div>
      <div className="call-pop-who">
        {pop.name || displayIdentity(pop.phone)} {pop.role && <span className={`role-badge ${pop.role}`}>{ROLE_LABEL[pop.role as keyof typeof ROLE_LABEL]}</span>}
      </div>
      <div className="muted small">{displayIdentity(pop.phone)}</div>
      <div className="actions">
        {pop.conversationId && <button onClick={() => navigate(`/inbox/${pop.conversationId}`)}>Open conversation</button>}
        {!pop.conversationId && pop.contactId && <button onClick={() => navigate(`/contacts/${pop.contactId}`)}>Open profile</button>}
        {!pop.conversationId && !pop.contactId && pop.href && <button onClick={() => navigate(pop.href!)}>Open {pop.role === 'cleaner' ? 'cleaner' : 'customer'}</button>}
        <button className="secondary" onClick={() => setPop(null)}>Dismiss</button>
      </div>
    </div>
  );
}
