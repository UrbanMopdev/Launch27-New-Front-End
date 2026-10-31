import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { l27All } from '../api';
import { useLocations } from '../hooks';
import { fmtDateTime, TIMEZONE } from '../format';
import { DEFAULT_SETTINGS, FLAG_LABEL, jobMargin, marginGap, needsAttention, rollup, summarise, visitsPerYear, type CostSettings, type Flag, type JobMargin, type MarginInput, type Rollup } from '../lib/margin';

// Job profitability.
//   GET /v1/staff/bookings/time_tracking?filter=active&from&to   cleaner pay per job (teams[].earned = rate × paid hours), check-in/out
//   GET /v1/staff/bookings?from&to                               location, frequency, payment method
// Costs Launch27 doesn't know (payroll on-costs, card fees, supplies) are set under "Cost assumptions".

const money = (n: number) => {
  const a = Math.abs(n);
  return `${n < 0 ? '−' : ''}$${a >= 1000 ? `${(a / 1000).toFixed(a >= 10000 ? 0 : 1)}k` : a.toFixed(0)}`;
};
const money2 = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('en-CA', { style: 'currency', currency: 'CAD' }));
const pct = (x: number | null | undefined) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const cleanName = (name = '') => name.replace(/^(\s*(\([^)]*\)|ON HOLD))+\s*/i, '') || name;

function isoDay(offset = 0, base = new Date()) {
  const d = new Date(base);
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}
function presets() {
  const t = new Date();
  return [
    { label: 'Last 7 days', from: isoDay(-7), to: isoDay(-1) },
    { label: 'Last 30 days', from: isoDay(-30), to: isoDay(-1) },
    { label: 'This month', from: isoDay(0, new Date(t.getFullYear(), t.getMonth(), 1)), to: isoDay(0) },
    { label: 'Last month', from: isoDay(0, new Date(t.getFullYear(), t.getMonth() - 1, 1)), to: isoDay(0, new Date(t.getFullYear(), t.getMonth(), 0)) },
    { label: 'Last 90 days', from: isoDay(-90), to: isoDay(-1) },
  ];
}

function loadSettings(): CostSettings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('margin:settings') || '{}') };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

type Tab = 'jobs' | 'service' | 'customer' | 'cleaner' | 'plan';
const TABS: { id: Tab; label: string }[] = [
  { id: 'jobs', label: 'Jobs' },
  { id: 'service', label: 'By service' },
  { id: 'customer', label: 'By customer' },
  { id: 'cleaner', label: 'By cleaner' },
  { id: 'plan', label: 'By plan & location' },
];

export function MarginsPage() {
  const ranges = useMemo(presets, []);
  const [range, setRange] = useState(ranges[1]);
  const [locationId, setLocationId] = useState<number | 'all'>('all');
  const [settings, setSettings] = useState<CostSettings>(loadSettings);
  const [showSettings, setShowSettings] = useState(false);
  const [tab, setTab] = useState<Tab>('jobs');
  const [flagFilter, setFlagFilter] = useState<Flag | 'flagged' | 'all'>('flagged');
  useEffect(() => {
    try {
      localStorage.setItem('margin:settings', JSON.stringify(settings));
    } catch {
      /* private mode */
    }
  }, [settings]);

  const locations = useLocations();
  const pay = useQuery({
    queryKey: ['margin-pay', range.from, range.to],
    queryFn: () => l27All<MarginInput>('/v1/staff/bookings/time_tracking', { filter: 'active', from: range.from, to: range.to }),
  });
  const details = useQuery({
    queryKey: ['margin-details', range.from, range.to],
    queryFn: () => l27All<MarginInput>('/v1/staff/bookings', { from: range.from, to: range.to }),
  });

  const items = useMemo(() => {
    if (!pay.data || !details.data) return [];
    const byId = new Map(details.data.filter((b) => b.id).map((b) => [b.id, b]));
    return pay.data
      .filter((j) => j.active !== false)
      .map((j) => {
        const d = byId.get(j.id);
        return jobMargin({ ...j, location: d?.location, frequency: d?.frequency, payment_method_info: d?.payment_method_info, user: { ...j.user, ...d?.user } }, settings);
      })
      .filter((m) => locationId === 'all' || m.job.location?.id === locationId);
  }, [pay.data, details.data, settings, locationId]);

  const total = useMemo(() => summarise(items), [items]);
  const loading = pay.isLoading || details.isLoading;

  return (
    <>
      <header className="page-header">
        <h1>Job profitability</h1>
        <div className="filters">
          <label>
            Period
            <select value={range.label} onChange={(e) => setRange(ranges.find((r) => r.label === e.target.value)!)}>
              {ranges.map((r) => (
                <option key={r.label}>{r.label}</option>
              ))}
            </select>
          </label>
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
          <button className="secondary" onClick={() => setShowSettings(!showSettings)}>
            ⚙ Cost assumptions
          </button>
        </div>
      </header>

      {showSettings && <Settings settings={settings} onChange={setSettings} />}

      <p className="muted small">
        Gross margin = what the client paid for the visit (after discounts, before tax and tips) minus cleaner pay
        {settings.onCostPct ? ` + ${settings.onCostPct}% payroll costs` : ''}
        {settings.cardPct ? `, card fees` : ''}
        {settings.suppliesPerJob ? `, $${settings.suppliesPerJob} supplies` : ''}. Prepaid-plan visits and $0 jobs are shown separately. Flags: under {settings.targetMarginPct}% margin; under ${settings.targetRate} per cleaner-hour. {range.from} → {range.to}.
      </p>

      {loading && <div className="muted">Loading jobs… (90 days takes about 15 seconds)</div>}
      {(pay.error || details.error) && <div className="error">{((pay.error || details.error) as Error).message}</div>}

      {!loading && items.length > 0 && (
        <>
          <div className="tiles">
            <Tile label="Revenue" value={money(total.revenue)} sub={`${items.filter((m) => !m.excluded).length} priced jobs · ${Math.round(total.paidHours)} cleaner-hours`} />
            <Tile label="Cleaner pay" value={money(total.labour)} sub={`${pct(total.revenue ? total.labour / total.revenue : null)} of revenue`} />
            <Tile label="Gross profit" value={money(total.profit)} sub={`${pct(total.margin)} gross margin`} tone={total.margin !== null && total.margin < settings.targetMarginPct / 100 ? 'neg' : 'ok'} />
            <Tile label="Charged per cleaner-hour" value={total.rate ? `$${total.rate.toFixed(0)}` : '—'} sub={`Cleaners cost ~$${total.paidHours ? (total.labour / total.paidHours).toFixed(0) : '—'}/h`} />
            <Tile label="Needs attention" value={String(total.flagged)} sub={`losing money or under ${settings.targetMarginPct}% margin`} tone={total.flagged ? 'neg' : undefined} />
          </div>

          <Insights items={items} total={total} settings={settings} onTab={setTab} onFlag={(f) => { setTab('jobs'); setFlagFilter(f); }} />

          <div className="tabs">
            {TABS.map((t) => (
              <button key={t.id} className={t.id === tab ? 'tab active' : 'tab'} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'jobs' && <Jobs items={items} settings={settings} flagFilter={flagFilter} setFlagFilter={setFlagFilter} />}
          {tab === 'service' && (
            <RollupTable title="Service" rows={rollup(items, (m) => (m.job.services?.length ? m.job.services : [{ name: 'No service' }]).map((s) => ({ key: s.name, label: s.name })))} settings={settings} />
          )}
          {tab === 'customer' && <Customers items={items} settings={settings} />}
          {tab === 'cleaner' && (
            <RollupTable
              title="Cleaner"
              note="Cleaner pay rate and the price of the jobs they're sent to drive these numbers — a low margin here usually means a higher pay rate or cheaper jobs, not poor work."
              rows={rollup(items, (m) => (m.job.teams?.length ? m.job.teams : [{ id: 0, title: 'Unassigned' }]).map((t) => ({ key: String(t.id), label: cleanName(t.title) })))}
              settings={settings}
              extra={(r) => {
                const list = items.filter((m) => m.job.teams?.some((t) => String(t.id) === r.key));
                const rates = list.map((m) => m.payRate).filter((x): x is number => x !== null);
                return rates.length ? `$${(rates.reduce((a, b) => a + b, 0) / rates.length).toFixed(2)}/h pay` : '';
              }}
            />
          )}
          {tab === 'plan' && (
            <>
              <RollupTable title="Plan" rows={rollup(items, (m) => [{ key: m.job.frequency?.name || 'Unknown', label: m.job.frequency?.name || 'Unknown' }])} settings={settings} />
              <RollupTable title="Location" rows={rollup(items, (m) => [{ key: m.job.location?.name || 'Unknown', label: m.job.location?.name || 'Unknown' }])} settings={settings} />
            </>
          )}
        </>
      )}
      {!loading && pay.data && items.length === 0 && <div className="muted">No jobs in this period.</div>}
    </>
  );
}

function Settings({ settings, onChange }: { settings: CostSettings; onChange: (s: CostSettings) => void }) {
  const field = (key: keyof CostSettings, label: string, hint: string, step = 0.1) => (
    <label>
      {label}
      <input type="number" step={step} value={settings[key]} onChange={(e) => onChange({ ...settings, [key]: Number(e.target.value) || 0 })} />
      <span className="muted small">{hint}</span>
    </label>
  );
  return (
    <section className="card">
      <h2>Cost assumptions</h2>
      <p className="muted small">Launch27 knows revenue and cleaner pay. Add the other costs of a job here — saved in this browser.</p>
      <div className="field-grid">
        {field('onCostPct', 'Payroll costs on top of pay (%)', 'CPP, EI, vacation pay, WSIB. ~10–15% for employees; 0 for contractors.')}
        {field('cardPct', 'Card fee (%)', 'Applied to card-paid jobs.')}
        {field('cardFixed', 'Card fee per charge ($)', 'e.g. 0.30')}
        {field('suppliesPerJob', 'Supplies & travel per job ($)', 'Products, mileage, parking.', 1)}
        {field('targetMarginPct', 'Flag margin below (%)', 'Your minimum acceptable gross margin.', 1)}
        {field('targetRate', 'Flag rate below ($/cleaner-hour)', 'Minimum you want to charge per cleaner-hour.', 1)}
      </div>
      <button className="link small" onClick={() => onChange(DEFAULT_SETTINGS)}>
        Reset to defaults
      </button>
    </section>
  );
}

function Insights({ items, total, settings, onTab, onFlag }: { items: JobMargin[]; total: Rollup; settings: CostSettings; onTab: (t: Tab) => void; onFlag: (f: Flag | 'flagged') => void }) {
  const cards: { tone: 'bad' | 'good' | 'info'; title: string; action?: string; go?: () => void }[] = [];
  const target = settings.targetMarginPct / 100;
  const low = items.filter((m) => m.flags.includes('low_margin') || m.flags.includes('loss'));
  const gap = low.reduce((s, m) => s + marginGap(m, settings), 0);
  if (low.length)
    cards.push({
      tone: 'bad',
      title: `${low.length} of ${items.filter((m) => !m.excluded).length} jobs made less than ${settings.targetMarginPct}% margin. Bringing them up to target would have added ${money(gap)} in this period.`,
      action: 'Look at which services and customers they come from (tabs below) — usually a pricing or time-allowance issue.',
      go: () => onFlag('low_margin'),
    });
  const losses = items.filter((m) => m.flags.includes('loss'));
  if (losses.length) cards.push({ tone: 'bad', title: `${losses.length} job${losses.length > 1 ? 's' : ''} cost more in cleaner pay than the client paid (${money(losses.reduce((s, m) => s + m.profit, 0))}).`, action: 'Check for a wrong price, a large discount, or too many paid hours.', go: () => onFlag('loss') });

  const services = rollup(items, (m) => (m.job.services || []).map((s) => ({ key: s.name, label: s.name }))).filter((r) => r.jobs >= 10 && r.rate !== null);
  const worstSvc = [...services].sort((a, b) => (a.margin ?? 1) - (b.margin ?? 1))[0];
  if (worstSvc && worstSvc.margin !== null && worstSvc.margin < target)
    cards.push({
      tone: 'bad',
      title: `${worstSvc.label} is the least profitable service: ${pct(worstSvc.margin)} margin and $${worstSvc.rate!.toFixed(0)} per cleaner-hour (company: ${pct(total.margin)}, $${total.rate?.toFixed(0)}/h).`,
      action: `Review its price or the hours allowed. Raising it to ${settings.targetMarginPct}% margin is the biggest single lever.`,
      go: () => onTab('service'),
    });

  const custs = customerRows(items, settings).filter((c) => c.recurring && !/prepaid/i.test(c.freq) && c.annualGap > 0);
  if (custs.length)
    cards.push({
      tone: 'bad',
      title: `${custs.length} regular customer${custs.length > 1 ? 's are' : ' is'} priced below target. Small price increases would add about ${money(custs.reduce((s, c) => s + c.annualGap, 0))} a year.`,
      action: 'Start with the biggest gaps on the "By customer" tab — it shows the increase per visit each needs.',
      go: () => onTab('customer'),
    });

  const over = items.filter((m) => m.flags.includes('ran_over'));
  if (over.length) cards.push({ tone: 'info', title: `${over.length} jobs ran more than 30 minutes past their paid hours.`, action: 'Either the job is underquoted (price/time), or cleaners aren\'t being paid for real time worked. Check both.', go: () => onFlag('ran_over') });
  const lowRate = items.filter((m) => m.flags.includes('low_rate'));
  if (lowRate.length) cards.push({ tone: 'info', title: `${lowRate.length} jobs charged under $${settings.targetRate} per cleaner-hour (company average $${total.rate?.toFixed(0)}).`, action: 'Often hourly or contract work (e.g. homemaking) priced close to cost — check those rates at renewal.', go: () => onFlag('low_rate') });
  const zero = items.filter((m) => m.flags.includes('zero_revenue'));
  if (zero.length) cards.push({ tone: 'info', title: `${zero.length} non-prepaid jobs show $0 revenue but cost ${money(zero.reduce((s, m) => s + m.labour, 0))} in cleaner pay.`, action: 'Usually re-cleans or comped visits — fine if intended; otherwise a missed charge.', go: () => onFlag('zero_revenue') });
  const prepaid = items.filter((m) => m.flags.includes('prepaid'));
  if (prepaid.length) cards.push({ tone: 'info', title: `${prepaid.length} prepaid-plan visits (cleaner pay ${money(prepaid.reduce((s, m) => s + m.labour, 0))}) are left out of the margin figures — their revenue was collected up front, not per visit.` });

  const best = [...services].sort((a, b) => (b.margin ?? 0) - (a.margin ?? 0))[0];
  if (best && best.margin !== null && best.margin >= target) cards.push({ tone: 'good', title: `Most profitable service: ${best.label} — ${pct(best.margin)} margin, $${best.rate!.toFixed(0)} per cleaner-hour.`, action: 'Promote it and use it as the pricing benchmark.', go: () => onTab('service') });

  if (!cards.length) return null;
  return (
    <section className="card insight-group">
      <h2>What needs attention</h2>
      {cards.map((c, i) => (
        <div key={i} className={`insight-card ${c.tone}`}>
          <div className="insight-title">{c.title}</div>
          {c.action && (
            <div className="insight-action">
              <strong>What to do:</strong> {c.action}
            </div>
          )}
          {c.go && (
            <button className="link small" onClick={c.go}>
              See the jobs →
            </button>
          )}
        </div>
      ))}
    </section>
  );
}

const marginCls = (m: number | null, target: number) => (m === null ? 'muted' : m < 0 ? 'neg' : m < target ? 'warn' : 'ok');

function Jobs({ items, settings, flagFilter, setFlagFilter }: { items: JobMargin[]; settings: CostSettings; flagFilter: Flag | 'flagged' | 'all'; setFlagFilter: (f: Flag | 'flagged' | 'all') => void }) {
  const navigate = useNavigate();
  const [sort, setSort] = useState<'margin' | 'rate' | 'profit' | 'date'>('margin');
  const [shown, setShown] = useState(50);
  const target = settings.targetMarginPct / 100;
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: items.length, flagged: 0 };
    for (const m of items) {
      if (needsAttention(m)) c.flagged += 1;
      for (const f of m.flags) c[f] = (c[f] || 0) + 1;
    }
    return c;
  }, [items]);
  const list = useMemo(() => {
    const l = items.filter((m) => flagFilter === 'all' || (flagFilter === 'flagged' ? needsAttention(m) : m.flags.includes(flagFilter)));
    const key = { margin: (m: JobMargin) => m.margin ?? 9, rate: (m: JobMargin) => m.ratePaid ?? 9999, profit: (m: JobMargin) => m.profit, date: (m: JobMargin) => -Date.parse(m.job.service_date) }[sort];
    return [...l].sort((a, b) => key(a) - key(b));
  }, [items, flagFilter, sort]);
  useEffect(() => setShown(50), [flagFilter, sort]);

  const download = () => {
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['Booking', 'Date', 'Customer', 'Service', 'Plan', 'Location', 'Cleaners', 'Revenue', 'Cleaner pay', 'Other costs', 'Gross profit', 'Margin %', 'Paid hours', 'Actual hours', '$/cleaner-hour', 'Flags'];
    const lines = list.map((m) =>
      [m.job.id, m.job.service_date, m.job.user?.name, m.job.services?.map((s) => s.name).join('; '), m.job.frequency?.name, m.job.location?.name, m.job.teams?.map((t) => cleanName(t.title)).join('; '), m.revenue.toFixed(2), m.labour.toFixed(2), (m.cardFee + m.supplies).toFixed(2), m.profit.toFixed(2), m.margin === null ? '' : (m.margin * 100).toFixed(1), m.paidHours.toFixed(2), m.actualHours?.toFixed(2) ?? '', m.ratePaid?.toFixed(2) ?? '', m.flags.map((f) => FLAG_LABEL[f]).join('; ')]
        .map(esc)
        .join(','),
    );
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([[head.map(esc).join(','), ...lines].join('\n')], { type: 'text/csv' }));
    a.download = 'job-margins.csv';
    a.click();
  };

  const chips: (Flag | 'flagged' | 'all')[] = ['flagged', 'loss', 'low_margin', 'low_rate', 'ran_over', 'discounted', 'zero_revenue', 'prepaid', 'all'];
  return (
    <>
      <div className="flag-chips">
        {chips
          .filter((c) => c === 'all' || c === 'flagged' || counts[c])
          .map((c) => (
            <button key={c} className={`chip-btn ${flagFilter === c ? 'active' : ''}`} onClick={() => setFlagFilter(c)}>
              {c === 'all' ? 'All jobs' : c === 'flagged' ? 'Needs attention' : FLAG_LABEL[c]} ({counts[c] || 0})
            </button>
          ))}
      </div>
      <div className="row-line no-border list-tools">
        <label className="small muted">
          Sort by{' '}
          <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            <option value="margin">Lowest margin</option>
            <option value="rate">Lowest $/hour</option>
            <option value="profit">Lowest profit</option>
            <option value="date">Newest</option>
          </select>
        </label>
        <button className="secondary" onClick={download} disabled={!list.length}>
          Download CSV
        </button>
      </div>
      <div className="table-wrap cards-on-mobile">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Customer</th>
              <th>Service</th>
              <th>Cleaner(s)</th>
              <th className="num">Revenue</th>
              <th className="num">Cleaner pay</th>
              <th className="num">Profit</th>
              <th className="num">Margin</th>
              <th className="num">$/cleaner-hr</th>
              <th>Flags</th>
            </tr>
          </thead>
          <tbody>
            {list.length === 0 && (
              <tr>
                <td colSpan={10} className="muted">
                  No jobs here.
                </td>
              </tr>
            )}
            {list.slice(0, shown).map((m) => (
              <tr key={m.job.id} onClick={() => navigate(`/bookings/${m.job.id}`)}>
                <td data-label="Date">{fmtDateTime(m.job.service_date)}</td>
                <td data-label="Customer">{m.job.user?.name}</td>
                <td data-label="Service" className="wrap">{m.job.services?.map((s) => s.name).join(', ')}</td>
                <td data-label="Cleaner(s)" className="wrap">
                  {m.job.teams?.map((t) => cleanName(t.title)).join(', ') || '—'}
                  <div className="muted small">
                    {m.paidHours ? `${m.paidHours}h paid` : ''}
                    {m.actualHours !== null ? ` · worked ${m.actualHours.toFixed(1)}h` : ''}
                  </div>
                </td>
                <td data-label="Revenue" className="num">
                  {money2(m.revenue)}
                </td>
                <td data-label="Cleaner pay" className="num">
                  {money2(m.labour)}
                </td>
                <td data-label="Profit" className={`num ${m.profit < 0 ? 'neg' : ''}`}>
                  {money2(m.profit)}
                </td>
                <td data-label="Margin" className={`num ${marginCls(m.margin, target)}`}>
                  <strong>{pct(m.margin)}</strong>
                </td>
                <td data-label="$/cleaner-hr" className={`num ${m.ratePaid !== null && m.ratePaid < settings.targetRate ? 'warn' : ''}`}>
                  {m.ratePaid ? `$${m.ratePaid.toFixed(0)}` : '—'}
                </td>
                <td data-label="Flags" className="wrap">
                  {m.flags.map((f) => (
                    <span key={f} className={`verdict ${f === 'loss' || f === 'low_margin' ? 'v-bad' : f === 'low_rate' || f === 'ran_over' ? 'v-raw' : 'v-ns'}`}>
                      {FLAG_LABEL[f]}
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.length > shown && (
        <button className="secondary show-more" onClick={() => setShown(shown + 50)}>
          Show more ({list.length - shown} left)
        </button>
      )}
    </>
  );
}

function RollupTable({ title, rows, settings, note, extra }: { title: string; rows: Rollup[]; settings: CostSettings; note?: string; extra?: (r: Rollup) => string }) {
  const target = settings.targetMarginPct / 100;
  const sorted = [...rows].sort((a, b) => (a.margin ?? 9) - (b.margin ?? 9));
  return (
    <section className="card">
      <h2>By {title.toLowerCase()}</h2>
      <p className="muted small">Lowest margin first. {note}</p>
      <div className="cards-on-mobile nested">
        <table>
          <thead>
            <tr>
              <th>{title}</th>
              <th className="num">Jobs</th>
              <th className="num">Revenue</th>
              <th className="num">Gross profit</th>
              <th className="num">Margin</th>
              <th className="num">$/cleaner-hr</th>
              <th className="num">Flagged jobs</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.key} className="static">
                <td data-label={title}>
                  {r.label}
                  {extra && <span className="muted small"> {extra(r)}</span>}
                </td>
                <td data-label="Jobs" className="num">
                  {r.jobs}
                </td>
                <td data-label="Revenue" className="num">
                  {money(r.revenue)}
                </td>
                <td data-label="Gross profit" className="num">
                  {money(r.profit)}
                </td>
                <td data-label="Margin" className={`num ${marginCls(r.margin, target)}`}>
                  <strong>{pct(r.margin)}</strong>
                </td>
                <td data-label="$/cleaner-hr" className={`num ${r.rate !== null && r.rate < settings.targetRate ? 'warn' : ''}`}>
                  {r.rate ? `$${r.rate.toFixed(0)}` : '—'}
                </td>
                <td data-label="Flagged" className={`num ${r.flagged ? 'neg' : ''}`}>
                  {r.flagged}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function customerRows(items: JobMargin[], settings: CostSettings) {
  const map = new Map<string, JobMargin[]>();
  for (const m of items) {
    const key = String(m.job.user?.id || m.job.user?.name);
    map.set(key, [...(map.get(key) || []), m]);
  }
  return [...map.entries()].map(([key, list]) => {
    const s = summarise(list, key, list[0].job.user?.name || key);
    const priced = list.filter((m) => !m.excluded);
    const gapPerVisit = priced.length ? priced.reduce((a, m) => a + marginGap(m, settings), 0) / priced.length : 0;
    const freq = list[list.length - 1].job.frequency?.name || '';
    return { ...s, userId: list[0].job.user?.id, freq, recurring: !/one time/i.test(freq), gapPerVisit, annualGap: gapPerVisit * visitsPerYear(freq) };
  });
}

function Customers({ items, settings }: { items: JobMargin[]; settings: CostSettings }) {
  const [recurringOnly, setRecurringOnly] = useState(true);
  const [shown, setShown] = useState(50);
  const target = settings.targetMarginPct / 100;
  const rows = useMemo(() => customerRows(items, settings).filter((c) => (!recurringOnly || c.recurring) && c.revenue > 0 && !/prepaid/i.test(c.freq)).sort((a, b) => b.annualGap - a.annualGap || (a.margin ?? 9) - (b.margin ?? 9)), [items, settings, recurringOnly]);
  return (
    <section className="card">
      <div className="row-line no-border">
        <h2>By customer</h2>
        <label className="check">
          <input type="checkbox" checked={recurringOnly} onChange={(e) => setRecurringOnly(e.target.checked)} /> Regular customers only
        </label>
      </div>
      <p className="muted small">
        Biggest pricing gap first. "Increase needed" is the average extra per visit to reach {settings.targetMarginPct}% margin; "per year" multiplies it by visits per year on their plan.
      </p>
      <div className="cards-on-mobile nested">
        <table>
          <thead>
            <tr>
              <th>Customer</th>
              <th>Plan</th>
              <th className="num">Jobs</th>
              <th className="num">Revenue</th>
              <th className="num">Margin</th>
              <th className="num">$/cleaner-hr</th>
              <th className="num">Increase needed / visit</th>
              <th className="num">Per year</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, shown).map((c) => (
              <tr key={c.key} className="static">
                <td data-label="Customer">{c.userId ? <Link to={`/customers/${c.userId}`}>{c.label}</Link> : c.label}</td>
                <td data-label="Plan">{c.freq}</td>
                <td data-label="Jobs" className="num">
                  {c.jobs}
                </td>
                <td data-label="Revenue" className="num">
                  {money(c.revenue)}
                </td>
                <td data-label="Margin" className={`num ${marginCls(c.margin, target)}`}>
                  <strong>{pct(c.margin)}</strong>
                </td>
                <td data-label="$/cleaner-hr" className="num">
                  {c.rate ? `$${c.rate.toFixed(0)}` : '—'}
                </td>
                <td data-label="Increase / visit" className={`num ${c.gapPerVisit > 0 ? 'neg' : 'muted'}`}>
                  {c.gapPerVisit > 0 ? `+${money2(c.gapPerVisit)}` : '—'}
                </td>
                <td data-label="Per year" className="num">
                  {c.annualGap > 0 ? money(c.annualGap) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > shown && (
        <button className="secondary show-more" onClick={() => setShown(shown + 50)}>
          Show more ({rows.length - shown} left)
        </button>
      )}
    </section>
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
