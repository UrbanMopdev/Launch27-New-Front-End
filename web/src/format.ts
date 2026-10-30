export const TIMEZONE = 'America/New_York';

export function fmtTime(iso?: string) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString('en-CA', { timeZone: TIMEZONE, hour: 'numeric', minute: '2-digit' });
}

export function fmtDateTime(iso?: string) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-CA', { timeZone: TIMEZONE, dateStyle: 'medium', timeStyle: 'short' });
}

export function fmtMoney(n?: number) {
  return typeof n === 'number' ? n.toLocaleString('en-CA', { style: 'currency', currency: 'CAD' }) : '—';
}

export function todayISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}
