import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { l27Write } from '../api';
import { useCanWrite } from '../hooks';
import type { Booking } from '../types';

// Edit / cancel / restore buttons for a booking.
//   POST /v1/staff/bookings/:id/cancel  { confirmed_recurring: { cancel_future }, reason }
//   POST /v1/staff/bookings/:id/restore
export function BookingActions({ booking }: { booking: Booking }) {
  const canWrite = useCanWrite();
  const queryClient = useQueryClient();
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [cancelFuture, setCancelFuture] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canWrite) return null;
  const actions = booking.actions || {};

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setCancelling(false);
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
        <Link to={`/bookings/${booking.id}/edit`} className="button">
          Edit
        </Link>
      )}
      {(actions.cancel || actions.late_cancel || actions.recurring_cancel) && (
        <button type="button" className="danger" onClick={() => setCancelling(true)}>
          Cancel booking
        </button>
      )}
      {!booking.active && (
        <button type="button" className="secondary" disabled={busy} onClick={() => run(() => l27Write('POST', `/v1/staff/bookings/${booking.id}/restore`, {}))}>
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
                onClick={() => run(() => l27Write('POST', `/v1/staff/bookings/${booking.id}/cancel`, { confirmed_recurring: { cancel_future: cancelFuture }, reason: reason || null }))}
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
