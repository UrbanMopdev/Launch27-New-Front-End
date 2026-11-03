// Shared pieces for the reports pages.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useInboxMe } from '../inbox/util';
import { reportsApi, type Period } from './api';

export const PERIOD_LABEL: Record<Period, string> = { '4w': 'Last 4 weeks', '13w': '13 weeks', '12m': '12 months' };

export function PeriodPicker({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  return (
    <div className="seg-period" role="group" aria-label="Period">
      {(Object.keys(PERIOD_LABEL) as Period[]).map((p) => (
        <button key={p} className={value === p ? 'active' : ''} aria-pressed={value === p} onClick={() => onChange(p)}>{PERIOD_LABEL[p]}</button>
      ))}
    </div>
  );
}

export function ReportStatusLine() {
  const queryClient = useQueryClient();
  const me = useInboxMe();
  const status = useQuery({ queryKey: ['reports', 'status'], queryFn: reportsApi.status, refetchInterval: (q) => (q.state.data?.running ? 5000 : 120_000) });
  const refresh = useMutation({ mutationFn: reportsApi.refresh, onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['reports', 'status'] }); setTimeout(() => queryClient.invalidateQueries({ queryKey: ['reports'] }), 8000); } });
  const s = status.data;
  if (!s) return null;
  const when = s.taken_at ? new Date(s.taken_at).toLocaleString('en-CA', { timeZone: 'America/Toronto', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
  return (
    <span className="muted small sch-status">
      {s.running ? 'Building from Launch27…' : when ? `Built ${when} from the last 12 months of Launch27 · rebuilds overnight` : 'Not built yet'}
      {s.last_error && <span className="warn"> · last build failed: {s.last_error}</span>}
      {me.data?.role === 'admin' && !s.running && <button className="link" disabled={refresh.isPending} onClick={() => refresh.mutate()}>Refresh now</button>}
    </span>
  );
}

export function Kpi({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: 'warn' }) {
  return (
    <div className="card seg-stat">
      <span className="muted small">{label}</span>
      <span className={tone === 'warn' ? 'seg-stat-value rep-warn' : 'seg-stat-value'}>{value}</span>
      {note && <span className="small">{note}</span>}
    </div>
  );
}

// Tiny trend line (0..1 values; gaps skipped).
export function Spark({ values, warn }: { values: (number | null)[]; warn?: boolean }) {
  const pts = values.map((v, i) => (v == null ? null : [values.length > 1 ? (i * 120) / (values.length - 1) : 60, 26 - Math.max(0, Math.min(1, v)) * 24])).filter(Boolean) as number[][];
  if (pts.length < 2) return <svg className="rep-spark" viewBox="0 0 120 28" aria-hidden="true" />;
  return (
    <svg className="rep-spark" viewBox="0 0 120 28" aria-hidden="true">
      <polyline points={pts.map((p) => p.join(',')).join(' ')} fill="none" stroke={warn ? '#d97706' : '#0891b2'} strokeWidth="2" />
    </svg>
  );
}

export function NotBuilt({ message }: { message: string }) {
  const queryClient = useQueryClient();
  const me = useInboxMe();
  const refresh = useMutation({ mutationFn: reportsApi.refresh, onSuccess: () => setTimeout(() => queryClient.invalidateQueries({ queryKey: ['reports'] }), 8000) });
  return (
    <section className="card seg-empty">
      <h2>Reports not built yet</h2>
      <p className="muted">{message}</p>
      {me.data?.role === 'admin' && <button disabled={refresh.isPending} onClick={() => refresh.mutate()}>Build now</button>}
    </section>
  );
}

export const weekLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export const monthYear = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', year: 'numeric', timeZone: 'UTC' });
