// Shared bits for the Commercial pages.
import { useMemo } from 'react';
import { useLocations } from '../hooks';
import { useBrand } from '../brands/useBrand';

// The Commercial brand's Launch27 locations (Commercial Ottawa, Cornwall), whatever the switcher says.
export function useCommercialLocations() {
  const locations = useLocations();
  const brand = useBrand();
  return useMemo(() => (locations.data ? locations.data.filter((l) => brand.brandOf(l.id, l.name) === 'commercial').map((l) => l.id) : null), [locations.data, brand]);
}

export const money = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }));
export const pct0 = (x: number | null | undefined) => (x == null ? '—' : `${Math.round(x * 100)}%`);
export const niceDate = (d: string | null | undefined) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '—');
export const clockOf = (m: number) => `${((Math.floor(m / 60) + 11) % 12) + 1}:${String(m % 60).padStart(2, '0')}${m >= 720 ? 'pm' : 'am'}`;

export function Trend({ value }: { value: number | null }) {
  if (value == null) return <span className="com-pill new">New</span>;
  if (Math.abs(value) < 0.05) return <span className="com-pill flat">Steady</span>;
  return <span className={value > 0 ? 'com-pill up' : 'com-pill down'}>{value > 0 ? 'Up' : 'Down'} {Math.round(Math.abs(value) * 100)}%</span>;
}

export function RhythmPill({ rhythm }: { rhythm: string }) {
  const cls = /^weekly/i.test(rhythm) ? 'wk' : /2 weeks/i.test(rhythm) ? 'bi' : /month/i.test(rhythm) ? 'mo' : 'flat';
  return <span className={`com-pill ${cls}`}>{rhythm}</span>;
}
