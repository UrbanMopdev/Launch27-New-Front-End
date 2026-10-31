import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { inbox } from './api';
import { displayIdentity, ROLE_LABEL, useMeta } from './util';

// RingCentral Embeddable: RingCentral's own softphone widget, loaded into the workspace.
// Agents sign in with their RingCentral login inside the widget, and calls ring in the
// browser while the workspace is open. We listen to the widget's events to:
//   - pop the caller's profile when a call rings
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
  const [pop, setPop] = useState<null | { phone: string; name?: string; role?: string; conversationId?: number; contactId?: number }>(null);
  const answered = useRef(new Set<string>());
  const cfg = meta.data?.ringcentral;

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
        const who = await inbox.lookup('phone', phone).catch(() => null);
        const contact = who?.contacts[0];
        setPop({ phone, name: contact?.name || who?.l27?.name, role: (contact?.roles || who?.l27?.roles || [])[0], conversationId: who?.open[0]?.id, contactId: contact?.id });
      }
      if (data.type === 'rc-call-start-notify' && key) answered.current.add(key);
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
    };
  }, [cfg?.clientId, navigate, queryClient]);

  if (!pop) return null;
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
        <button className="secondary" onClick={() => setPop(null)}>Dismiss</button>
      </div>
    </div>
  );
}
