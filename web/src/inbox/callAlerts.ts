// Desktop alerts for incoming calls, so a call is noticed even when the portal is in a
// background tab or behind another window (like the RingCentral pop-ups in Kustomer).

export const ALERTS_SUPPORTED = typeof window !== 'undefined' && 'Notification' in window;

export function alertPermission(): NotificationPermission | 'unsupported' {
  return ALERTS_SUPPORTED ? Notification.permission : 'unsupported';
}

export async function askForAlerts(): Promise<NotificationPermission | 'unsupported'> {
  if (!ALERTS_SUPPORTED) return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

// What the alert says: the caller's name (from the inbox or Launch27) when known.
export function callAlertText(phone: string, name?: string | null, role?: string | null) {
  const who = name?.trim() || phone || 'Unknown caller';
  const kind = role === 'cleaner' ? 'Cleaner' : role === 'customer' ? 'Customer' : null;
  return {
    title: `Incoming call · ${who}`,
    body: [kind, name ? phone : null].filter(Boolean).join(' · ') || 'Click to open the portal',
    tabTitle: `☎ ${who}`,
  };
}

// Show a system notification; clicking it brings the portal to the front. Returns a closer.
export function showCallAlert(text: { title: string; body: string }, tag: string, onClick: () => void): () => void {
  if (alertPermission() !== 'granted') return () => {};
  try {
    const n = new Notification(text.title, { body: text.body, tag: `call:${tag}`, requireInteraction: true });
    n.onclick = () => {
      window.focus();
      onClick();
      n.close();
    };
    return () => n.close();
  } catch {
    return () => {};
  }
}

// Blink the browser tab title while a call rings. Returns a stopper.
export function flashTitle(text: string): () => void {
  const original = document.title;
  let on = false;
  const timer = window.setInterval(() => {
    on = !on;
    document.title = on ? text : original;
  }, 1000);
  return () => {
    window.clearInterval(timer);
    document.title = original;
  };
}
