import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { l27Write } from '../api';
import { useCanWrite } from '../hooks';
import type { Booking } from '../types';

// Edit / cancel / restore buttons for a booking.
//   POST /v1/staff/bookings/:id/cancel  { confirmed_recurring: { cancel_future }, reason }
//   POST /v1/staff/bookings/:id/restore
// onDone lets the support workspace log what happened on the conversation's timeline.
export function BookingActions({ booking, onDone, editLink }: { booking: Booking; onDone?: (summary: string) => void; editLink?: string }) {
  const canWrite = useCanWrite();
  const queryClient = useQueryClient();
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [cancelFuture, setCancelFuture] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canWrite) return null;
  const actions = booking.actions || {};

  const run = async (fn: () => Promise<unknown>, summary?: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setCancelling(false);
      if (summary) onDone?.(summary);
      await queryClient.invalidateQueries({ queryKey: ['booking', String(booking.id)] });
      await queryClient.invalidateQueries({ queryKey: ['bookings'] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="actions">
      {actions.edit && (
        <Link to={rescheduleLink(booking, editLink)} className="button secondary">
          Reschedule
        </Link>
      )}
      {actions.edit && (
        <Link to={editLink || `/bookings/${booking.id}/edit`} className="button">
          Edit
        </Link>
      )}
      {(actions.cancel || actions.late_cancel || actions.recurring_cancel) && (
        <button type="button" className="danger" onClick={() => setCancelling(true)}>
          Cancel booking
        </button>
      )}
      {!booking.active && (
        <button type="button" className="secondary" disabled={busy} onClick={() => run(() => l27Write('POST', `/v1/staff/bookings/${booking.id}/restore`, {}), `Restored booking #${booking.id}`)}>
          Restore booking
        </button>
      )}
      {error && !cancelling && <div className="error pre">{error}</div>}

      {cancelling && (
        <div className="modal-backdrop" onClick={() => !busy && setCancelling(false)}>
          <div className="card modal" onClick={(e) => e.stopPropagation()}>
            <h2>Cancel booking #{booking.id}?</h2>
            {actions.late_cancel && !actions.cancel && <p className="warn small">This is inside the late-cancellation window; Launch27's cancellation policy applies.</p>}
            <label className="block">
              Reason
              <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            {actions.recurring_cancel && (
              <label className="check">
                <input type="checkbox" checked={cancelFuture} onChange={(e) => setCancelFuture(e.target.checked)} /> Also cancel all future bookings in this series
              </label>
            )}
            {error && <div className="error pre">{error}</div>}
            <div className="actions end">
              <button type="button" className="secondary" disabled={busy} onClick={() => setCancelling(false)}>
                Keep booking
              </button>
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => run(() => l27Write('POST', `/v1/staff/bookings/${booking.id}/cancel`, { confirmed_recurring: { cancel_future: cancelFuture }, reason: reason || null }), `Cancelled booking #${booking.id}${cancelFuture ? ' and future visits' : ''}${reason ? ` (${reason})` : ''}`)}
              >
                {busy ? 'Cancelling…' : 'Cancel booking'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Reschedule = Find a slot for this client, with this booking's length and rhythm, and the
// question "usual cleaner only, or any cleaner?". "Move to this slot" returns to this booking's
// edit form (keeping any conversation link) with the new date, time and cleaner filled in.
function rescheduleLink(b: Booking, editLink?: string) {
  const name = b.frequency?.name || '';
  const kind = /one\s*-?\s*time/i.test(name) ? 'one' : /bi\s*-?\s*weekly/i.test(name) ? 'bi' : /month/i.test(name) ? 'monthly' : /weekly/i.test(name) ? 'weekly' : 'one';
  const q = new URLSearchParams({ tab: 'find', booking: String(b.id), freq: kind, next: editLink || `/bookings/${b.id}/edit` });
  if (b.user?.id) q.set('customer', String(b.user.id));
  if (b.duration) q.set('hours', String(Math.round((b.duration / 60) * 2) / 2));
  if (b.service_date) q.set('current', b.service_date);
  return `/schedule?${q.toString()}`;
}
