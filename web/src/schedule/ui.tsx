// Shared pieces for the scheduling planner.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { scheduleApi, type Reason, type Visit } from './api';

export function niceDate(d: string, short = false) {
  const dt = new Date(`${d}T12:00:00Z`);
  return dt.toLocaleDateString('en-CA', short ? { month: 'short', day: 'numeric', timeZone: 'UTC' } : { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function CleanerDot({ color }: { color: string }) {
  return <span className="sch-dot" style={{ background: color }} aria-hidden="true" />;
}

export function FreqPill({ visit }: { visit: Pick<Visit, 'kind' | 'freq' | 'prepaid'> }) {
  return (
    <span className={`sch-freq f-${visit.kind}`}>
      {visit.prepaid && <span className="sch-p" title="Prepaid">P</span>}
      {visit.freq}
    </span>
  );
}

export function Reasons({ reasons }: { reasons: Reason[] }) {
  return (
    <span className="sch-reasons">
      {reasons.map((r) => <span key={r.text} className={`sch-reason t-${r.tone}`}>{r.text}</span>)}
    </span>
  );
}

export function ScheduleStatus() {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ['schedule', 'status'], queryFn: scheduleApi.status, refetchInterval: (q) => (q.state.data?.running ? 4000 : 60_000) });
  const refresh = useMutation({
    mutationFn: scheduleApi.refresh,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['schedule', 'status'] });
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ['schedule'] }), 5000);
    },
  });
  const s = status.data;
  if (!s) return null;
  const mins = s.taken_at ? Math.max(0, Math.round((Date.now() - new Date(s.taken_at).getTime()) / 60_000)) : null;
  return (
    <span className="muted small sch-status">
      {s.running ? 'Refreshing from Launch27…' : mins === null ? 'Not loaded yet' : `Updated ${mins === 0 ? 'just now' : `${mins} min ago`} · refreshes every ${s.refresh_minutes} min and a minute after changes made here`}
      {s.last_error && <span className="warn"> · last refresh failed: {s.last_error}</span>}
      {!s.running && <button className="link" disabled={refresh.isPending} onClick={() => refresh.mutate()}>Refresh now</button>}
    </span>
  );
}
