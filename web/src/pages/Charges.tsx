import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { l27All } from '../api';
import { useLocations } from '../hooks';
import type { Booking, Charge } from '../types';
import { fmtDateTime, fmtMoney, TIMEZONE } from '../format';

// /admin/charges replacement.
//   GET /v1/staff/charges?filter=all|unpaid|paid|onhold|refunded&from&to  (all pages)
// Each row is a booking with its charges; we filter by location_id client-side so
// the summary can break down every location from one fetch.

type ChargeRow = Booking & {
  location_id: number;
  refunds?: { amount: number; status: string; booking_charge_non_captured?: boolean }[];
  cancellation?: { fee?: number; date?: string; reason?: string; cancelled_by?: { name?: string } } | null;
};

const PAGE = 50;

const STATUS_TABS = [
  { id: 'all', label: 'All' },
  { id: 'unpaid', label: 'Unpaid' },
  { id: 'paid', label: 'Paid' },
  { id: 'onhold', label: 'On hold' },
  { id: 'refunded', label: 'Refunded' },
];

function isoDay(offsetDays = 0, from = new Date()) {
  const d = new Date(from);
  d.setDate(d.getDate() + offsetDays);
  return d.toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

function presets() {
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);
  return [
    { label: 'Today', from: isoDay(0), to: isoDay(0) },
    { label: 'Yesterday', from: isoDay(-1), to: isoDay(-1) },
    { label: 'Last 7 days', from: isoDay(-6), to: isoDay(0) },
    { label: 'This month', from: isoDay(0, monthStart), to: isoDay(0) },
    { label: 'Last month', from: isoDay(0, lastMonthStart), to: isoDay(0, lastMonthEnd) },
  ];
}

const ok = (c: Charge) => !c.status || c.status === 'succeeded';
const sum = (list: Charge[] | undefined) => (list || []).filter(ok).reduce((s, c) => s + (c.amount || 0), 0);

// Launch27 places a card hold a few days before each visit. When the hold is let go
// (booking cancelled, or re-authorized) it shows up in charges.refunded with a
// description like "On Hold for UrbanMop - 10/28/2026 8:00am". No money moved, so
// these are not refunds.
const isHoldRelease = (c: Charge) => /^on hold\b/i.test(c.description || '');
const realRefunds = (r: ChargeRow) => sum((r.charges?.refunded || []).filter((c) => !isHoldRelease(c)));
const holdReleases = (r: ChargeRow) => sum((r.charges?.refunded || []).filter(isHoldRelease));
const captured = (r: ChargeRow) => sum(r.charges?.charged) + sum(r.charges?.marked_paid);
const netCollected = (r: ChargeRow) => captured(r) - realRefunds(r);
const isCancelled = (r: ChargeRow) => r.active === false;

// Cancelled with money still kept beyond any cancellation fee: refund or credit owed?
export const keptOnCancelled = (r: ChargeRow) => (isCancelled(r) ? Math.max(0, netCollected(r) - (r.cancellation?.fee || 0)) : 0);

interface Totals {
  bookings: number;
  billed: number;
  revenue: number;
  tax: number;
  tips: number;
  discounts: number;
  collected: number;
  refunded: number;
  holdsReleased: number;
  outstanding: number;
  credit: number;
  onhold: number;
  unpaidCount: number;
  cancelledCount: number;
  cancelledValue: number;
  cancelFees: number;
  review: number;
  reviewCount: number;
}

function totalsOf(rows: ChargeRow[]): Totals {
  const t: Totals = {
    bookings: 0, billed: 0, revenue: 0, tax: 0, tips: 0, discounts: 0, collected: 0, refunded: 0, holdsReleased: 0,
    outstanding: 0, credit: 0, onhold: 0, unpaidCount: 0, cancelledCount: 0, cancelledValue: 0, cancelFees: 0, review: 0, reviewCount: 0,
  };
  for (const r of rows) {
    const s = r.summary || {};
    const c = r.charges || {};
    // Money actually taken or given back counts whatever the booking's state.
    t.collected += captured(r);
    t.refunded += realRefunds(r);
    t.holdsReleased += holdReleases(r);
    t.onhold += sum(c.onhold);

    if (isCancelled(r)) {
      // A cancelled booking isn't billed; its price is shown separately.
      t.cancelledCount += 1;
      t.cancelledValue += s.total || 0;
      t.cancelFees += r.cancellation?.fee || 0;
      const kept = keptOnCancelled(r);
      if (kept > 0) {
        t.review += kept;
        t.reviewCount += 1;
      }
      continue;
    }
    t.bookings += 1;
    t.billed += s.total || 0;
    t.revenue += s.revenue || 0;
    t.tax += s.tax?.tax_amount || 0;
    t.tips += s.tip || 0;
    t.discounts += s.discount || 0;
    // Negative outstanding = paid more than the booking now costs (e.g. price lowered after charging).
    const due = c.outstanding || 0;
    if (due > 0) {
      t.outstanding += due;
      t.unpaidCount += 1;
    } else t.credit -= due;
  }
  return t;
}

function paymentStatus(r: ChargeRow): { label: string; cls: string; note?: string } {
  const c = r.charges || {};
  if (isCancelled(r)) {
    const kept = keptOnCancelled(r);
    if (kept > 0) return { label: 'Cancelled · charged', cls: 'neg', note: `${fmtMoney(kept)} kept, no fee — refund or credit?` };
    if (r.cancellation?.fee) return { label: 'Cancelled · fee', cls: 'warn', note: `Fee ${fmtMoney(r.cancellation.fee)}` };
    if (holdReleases(r)) return { label: 'Cancelled', cls: 'muted', note: 'Card hold released' };
    if (realRefunds(r)) return { label: 'Cancelled · refunded', cls: 'muted' };
    return { label: 'Cancelled', cls: 'muted' };
  }
  if (c.onhold?.length) return { label: 'On hold', cls: 'warn' };
  if ((c.outstanding || 0) > 0) return { label: 'Unpaid', cls: 'neg' };
  if (realRefunds(r)) return { label: captured(r) > realRefunds(r) ? 'Partly refunded' : 'Refunded', cls: 'muted' };
  if (captured(r)) return { label: 'Paid', cls: 'ok' };
  return { label: (r.summary?.total || 0) > 0 ? 'Not charged' : 'No charge', cls: 'muted' };
}

function toCsv(rows: ChargeRow[], locationName: (id: number) => string) {
  const head = ['Booking', 'Date', 'Location', 'Customer', 'Service', 'Payment method', 'Status', 'Note', 'Cancellation reason', 'Total', 'Collected (net)', 'Outstanding'];
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = rows.map((r) =>
    [
      r.id,
      r.service_date,
      locationName(r.location_id),
      r.user?.name,
      r.services?.map((s) => s.name).join('; '),
      r.payment_method_info?.text,
      paymentStatus(r).label,
      paymentStatus(r).note,
      r.cancellation?.reason,
      (r.summary?.total || 0).toFixed(2),
      netCollected(r).toFixed(2),
      isCancelled(r) ? '' : (r.charges?.outstanding || 0).toFixed(2),
    ]
      .map(esc)
      .join(','),
  );
  return [head.map(esc).join(','), ...lines].join('\n');
}

export function ChargesPage() {
  const navigate = useNavigate();
  const ranges = useMemo(presets, []);
  const [from, setFrom] = useState(ranges[0].from);
  const [to, setTo] = useState(ranges[0].to);
  const [status, setStatus] = useState('all');
  const [locationId, setLocationId] = useState<number | 'all'>('all');
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [reviewOnly, setReviewOnly] = useState(false);

  const locations = useLocations();
  const locationName = (id: number) => locations.data?.find((l) => l.id === id)?.name || `Location ${id}`;

  const charges = useQuery({
    queryKey: ['charges', status, from, to],
    queryFn: () => l27All<ChargeRow>('/v1/staff/charges', { filter: status, from, to }),
  });

  const inLocation = useMemo(() => (charges.data || []).filter((r) => locationId === 'all' || r.location_id === locationId), [charges.data, locationId]);
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = q ? inLocation.filter((r) => [r.id, r.user?.name, r.user?.email, r.payment_method_info?.text].join(' ').toLowerCase().includes(q)) : inLocation;
    if (reviewOnly) list = list.filter((r) => keptOnCancelled(r) > 0);
    return [...list].sort((a, b) => (a.service_date || '').localeCompare(b.service_date || ''));
  }, [inLocation, search, reviewOnly]);

  const totals = useMemo(() => totalsOf(inLocation), [inLocation]);
  useEffect(() => setShown(PAGE), [status, from, to, locationId, search, reviewOnly]);
  useEffect(() => setReviewOnly(false), [status, from, to, locationId]);
  const byLocation = useMemo(() => {
    const groups = new Map<number, ChargeRow[]>();
    for (const r of charges.data || []) groups.set(r.location_id, [...(groups.get(r.location_id) || []), r]);
    return [...groups.entries()].map(([id, list]) => ({ id, ...totalsOf(list) })).sort((a, b) => b.billed - a.billed);
  }, [charges.data]);
  const byMethod = useMemo(() => {
    const groups = new Map<string, ChargeRow[]>();
    for (const r of inLocation) {
      const code = r.payment_method_info?.code || 'none';
      const key = code.startsWith('stripe') || code.startsWith('fspay') ? 'Card' : code === 'check' || code === 'cash' ? 'Cash / cheque' : code === 'paypal' ? 'PayPal' : code;
      groups.set(key, [...(groups.get(key) || []), r]);
    }
    return [...groups.entries()].map(([method, list]) => ({ method, ...totalsOf(list) })).sort((a, b) => b.billed - a.billed);
  }, [inLocation]);

  const download = () => {
    const blob = new Blob([toCsv(rows, locationName)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `charges-${locationId === 'all' ? 'all' : locationName(locationId)}-${from}-to-${to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const collectedNet = totals.collected - totals.refunded;
  const collectedPct = totals.billed ? Math.round((collectedNet / totals.billed) * 100) : 0;

  return (
    <>
      <header className="page-header">
        <h1>Charge customers</h1>
        <div className="filters">
          <label>
            Location
            <select value={locationId} onChange={(e) => setLocationId(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
              <option value="all">All locations</option>
              {locations.data?.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Period
            <select
              value={ranges.find((r) => r.from === from && r.to === to)?.label || 'custom'}
              onChange={(e) => {
                const r = ranges.find((x) => x.label === e.target.value);
                if (r) {
                  setFrom(r.from);
                  setTo(r.to);
                }
              }}
            >
              {ranges.map((r) => (
                <option key={r.label}>{r.label}</option>
              ))}
              <option value="custom" disabled>
                Custom
              </option>
            </select>
          </label>
          <label>
            From
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            To
            <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
      </header>

      <div className="tabs">
        {STATUS_TABS.map((t) => (
          <button key={t.id} className={t.id === status ? 'tab active' : 'tab'} onClick={() => setStatus(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {charges.isLoading && <div className="muted">Loading charges…</div>}
      {charges.error && <div className="error">{(charges.error as Error).message}</div>}

      {charges.data && (
        <>
          <div className="tiles">
            <Tile label="Billed" value={fmtMoney(totals.billed)} sub={`${totals.bookings} active bookings`} />
            <Tile label="Collected (net)" value={fmtMoney(collectedNet)} sub={`${collectedPct}% of billed${totals.refunded ? ` · ${fmtMoney(totals.refunded)} refunded` : ''}`} tone="ok" />
            <Tile label="Outstanding" value={fmtMoney(totals.outstanding)} sub={`${totals.unpaidCount} bookings unpaid`} tone={totals.outstanding > 0 ? 'neg' : undefined} />
            <Tile label="On hold (authorized)" value={fmtMoney(totals.onhold)} sub={totals.holdsReleased ? `${fmtMoney(totals.holdsReleased)} in holds released` : undefined} />
            <Tile
              label="Cancelled"
              value={String(totals.cancelledCount)}
              sub={`${fmtMoney(totals.cancelledValue)} not billed${totals.cancelFees ? ` · ${fmtMoney(totals.cancelFees)} in fees` : ''}`}
            />
          </div>

          {totals.reviewCount > 0 && (
            <div className="alert">
              <div>
                <strong>
                  {totals.reviewCount} cancelled booking{totals.reviewCount > 1 ? 's' : ''} still {totals.reviewCount > 1 ? 'have' : 'has'} {fmtMoney(totals.review)} charged
                </strong>
                <div className="small">No cancellation fee and no refund — refund the customer, apply it as credit, or record a fee.</div>
              </div>
              <button type="button" className="secondary" onClick={() => setReviewOnly(!reviewOnly)}>
                {reviewOnly ? 'Show all' : 'Review them'}
              </button>
            </div>
          )}

          <div className="grid-2">
            <section className="card">
              <h2>Breakdown{locationId !== 'all' && ` · ${locationName(locationId)}`}</h2>
              <dl className="kv">
                <dt>Revenue before tax</dt>
                <dd>{fmtMoney(totals.revenue)}</dd>
                <dt>Sales tax</dt>
                <dd>{fmtMoney(totals.tax)}</dd>
                <dt>Tips</dt>
                <dd>{fmtMoney(totals.tips)}</dd>
                <dt>Discounts given</dt>
                <dd>{fmtMoney(totals.discounts)}</dd>
                {totals.credit > 0 && (
                  <>
                    <dt>Overpaid / credits</dt>
                    <dd>{fmtMoney(totals.credit)}</dd>
                  </>
                )}
                <dt>Total billed</dt>
                <dd>
                  <strong>{fmtMoney(totals.billed)}</strong>
                </dd>
              </dl>
            </section>
            <section className="card">
              <h2>By payment method</h2>
              <div className="cards-on-mobile nested">
              <table>
                <thead>
                  <tr>
                    <th>Method</th>
                    <th className="num">Billed</th>
                    <th className="num">Collected</th>
                    <th className="num">Outstanding</th>
                  </tr>
                </thead>
                <tbody>
                  {byMethod.map((m) => (
                    <tr key={m.method} className="static">
                      <td data-label="Method">
                        {m.method} <span className="muted small">({m.bookings})</span>
                      </td>
                      <td data-label="Billed" className="num">{fmtMoney(m.billed)}</td>
                      <td data-label="Collected" className="num">{fmtMoney(m.collected - m.refunded)}</td>
                      <td data-label="Outstanding" className="num">{fmtMoney(m.outstanding)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </section>
          </div>

          {locationId === 'all' && byLocation.length > 1 && (
            <section className="card">
              <h2>By location</h2>
              <div className="cards-on-mobile nested">
              <table>
                <thead>
                  <tr>
                    <th>Location</th>
                    <th className="num">Bookings</th>
                    <th className="num">Billed</th>
                    <th className="num">Collected</th>
                    <th className="num">Outstanding</th>
                  </tr>
                </thead>
                <tbody>
                  {byLocation.map((l) => (
                    <tr key={l.id} onClick={() => setLocationId(l.id)}>
                      <td data-label="Location">{locationName(l.id)}</td>
                      <td data-label="Bookings" className="num">{l.bookings}</td>
                      <td data-label="Billed" className="num">{fmtMoney(l.billed)}</td>
                      <td data-label="Collected" className="num">{fmtMoney(l.collected - l.refunded)}</td>
                      <td data-label="Outstanding" className={`num ${l.outstanding > 0 ? 'neg' : ''}`}>{fmtMoney(l.outstanding)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              <p className="muted small">Tap a location to filter the page to it.</p>
            </section>
          )}

          <div className="page-header list-header">
            <h2>
              Bookings <span className="muted count">({rows.length})</span>
            </h2>
            <div className="filters">
              <input placeholder="Search customer, booking #, card…" value={search} onChange={(e) => setSearch(e.target.value)} />
              <button type="button" className="secondary" onClick={download} disabled={!rows.length}>
                Download CSV
              </button>
            </div>
          </div>
          <div className="table-wrap cards-on-mobile">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Customer</th>
                  <th>Location</th>
                  <th>Payment</th>
                  <th>Status</th>
                  <th className="num">Total</th>
                  <th className="num">Outstanding</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="muted">
                      Nothing in this period.
                    </td>
                  </tr>
                )}
                {rows.slice(0, shown).map((r) => {
                  const st = paymentStatus(r);
                  return (
                    <tr key={r.id} onClick={() => navigate(`/bookings/${r.id}`)}>
                      <td data-label="Date">{fmtDateTime(r.service_date)}</td>
                      <td data-label="Customer">{r.user?.name || '—'}</td>
                      <td data-label="Location">{locationName(r.location_id)}</td>
                      <td data-label="Payment">{r.payment_method_info?.text || '—'}</td>
                      <td data-label="Status">
                        <span className="status-cell">
                          <span className={st.cls}>{st.label}</span>
                          {st.note && <span className="muted small">{st.note}</span>}
                          {r.cancellation?.reason && <span className="muted small clip" title={r.cancellation.reason}>“{r.cancellation.reason}”{r.cancellation.cancelled_by?.name ? ` — ${r.cancellation.cancelled_by.name}` : ''}</span>}
                        </span>
                      </td>
                      <td data-label="Total" className="num">
                        {fmtMoney(r.summary?.total)}
                      </td>
                      <td data-label={isCancelled(r) ? 'Kept' : 'Outstanding'} className={`num ${(r.charges?.outstanding || 0) > 0 && !isCancelled(r) ? 'neg' : ''}`}>
                        {isCancelled(r) ? (netCollected(r) ? fmtMoney(netCollected(r)) : '—') : fmtMoney(r.charges?.outstanding)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {rows.length > shown && (
            <button type="button" className="secondary show-more" onClick={() => setShown(shown + PAGE)}>
              Show more ({rows.length - shown} left)
            </button>
          )}
        </>
      )}
    </>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'ok' | 'neg' }) {
  return (
    <div className="card tile">
      <div className="muted small">{label}</div>
      <div className={`tile-value ${tone || ''}`}>{value}</div>
      {sub && <div className="muted small">{sub}</div>}
    </div>
  );
}
