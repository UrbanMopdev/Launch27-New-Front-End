import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { l27, l27Write } from '../api';
import { useActiveTeams, useCanWrite, useLocations } from '../hooks';
import type { Booking, Customer } from '../types';
import { fmtMoney, TIMEZONE } from '../format';
import { customerName } from './Customers';

// Create:  POST /v1/staff/bookings
// Edit:    PUT  /v1/staff/bookings/:id
// The body mirrors what Launch27's admin sends (see docs/WRITE_API.md). Launch27
// prices the booking itself, so the total is shown after saving.

interface BookableService {
  id: number;
  name: string;
  price: number;
  hourly?: { quantity_minimum: number; quantity_maximum: number; minutes_minimum: number; minutes_maximum: number; half_hour_increments: boolean };
  extras: { id: number; name: string; price: number; quantity_based: boolean }[];
  pricing_parameters: { id: number; name: string; price: number; quantity_minimum: number; quantity_maximum: number }[];
}

interface FormField {
  id: number;
  control_type: string;
  label: string;
  value_required: boolean;
  active: boolean;
  options?: { id: number; label: string; active: boolean }[];
}

interface ServiceLine {
  id: number;
  pricing: Record<number, number>;
  extras: Record<number, number>; // extra id -> quantity (0 = not selected)
  hourly?: { quantity: number; minutes: number };
}

interface FormState {
  customerId: number | null;
  first_name: string;
  last_name: string;
  email: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  location_id: number | null;
  frequency_id: number | null;
  date: string;
  time: string;
  arrival_window: number;
  services: ServiceLine[];
  teams: number[];
  payment: string;
  customer_notes: string;
  staff_notes: string;
  discount_code: string;
  tip: string;
  price_adjustment: string;
  price_adjustment_comment: string;
  sms_notifications: boolean;
  custom: Record<number, number[] | string>;
  is_mass_update: boolean;
}

const EMPTY: FormState = {
  customerId: null,
  first_name: '',
  last_name: '',
  email: '',
  address: '',
  city: '',
  state: 'ON',
  zip: '',
  phone: '',
  location_id: null,
  frequency_id: null,
  date: '',
  time: '08:00',
  arrival_window: 60,
  services: [],
  teams: [],
  payment: 'check',
  customer_notes: '',
  staff_notes: '',
  discount_code: '',
  tip: '',
  price_adjustment: '',
  price_adjustment_comment: '',
  sms_notifications: true,
  custom: {},
  is_mass_update: false,
};

const stripTags = (html: string) => html.replace(/<[^>]*>/g, '').trim();

// UTC timestamp from Launch27 -> local date and time inputs.
function toLocalInputs(iso?: string) {
  if (!iso) return { date: '', time: '08:00' };
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-CA', { timeZone: TIMEZONE });
  const time = d.toLocaleTimeString('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' });
  return { date, time };
}

function fromBooking(b: Booking): FormState {
  const { date, time } = toLocalInputs(b.service_date);
  const custom: FormState['custom'] = {};
  for (const cf of b.custom_fields || []) {
    const raw = cf as unknown as { id: number; type: string; value?: unknown; values?: { id: number }[] };
    if (raw.values) custom[raw.id] = raw.values.map((v) => v.id);
    else if (raw.value !== undefined && raw.value !== null) custom[raw.id] = String(raw.value);
  }
  return {
    ...EMPTY,
    customerId: b.user?.id ?? null,
    address: (b.address as { street?: string; full_address?: string } | undefined)?.street || b.address?.full_address || '',
    city: (b.address as { city?: string } | undefined)?.city || '',
    state: (b.address as { state?: string } | undefined)?.state || '',
    zip: (b.address as { zip?: string } | undefined)?.zip || '',
    phone: b.phone || '',
    location_id: b.location?.id ?? null,
    frequency_id: b.frequency?.id ?? null,
    date,
    time,
    arrival_window: Number(b.arrival_window) || 0,
    services: (b.services || []).map((s) => {
      const svc = s as typeof s & { hourly?: { quantity: number; minutes: number } };
      return {
        id: s.id,
        pricing: Object.fromEntries((s.pricing_parameters || []).map((p) => [p.id, p.quantity])),
        extras: Object.fromEntries((s.extras || []).map((x) => [x.id, x.quantity])),
        hourly: svc.hourly ? { quantity: svc.hourly.quantity, minutes: svc.hourly.minutes } : undefined,
      };
    }),
    teams: (b.teams || []).map((t) => t.id!).filter(Boolean),
    payment: b.payment_method_info?.code || 'check',
    customer_notes: b.customer_notes || '',
    staff_notes: b.staff_notes || '',
    price_adjustment_comment: b.price_adjustment_comment || '',
    tip: b.summary?.tip ? String(b.summary.tip) : '',
    sms_notifications: (b as { sms_notifications?: boolean }).sms_notifications ?? true,
    custom,
  };
}

function newServiceLine(svc: BookableService): ServiceLine {
  return {
    id: svc.id,
    pricing: Object.fromEntries(svc.pricing_parameters.map((p) => [p.id, p.quantity_minimum ?? 0])),
    extras: {},
    hourly: svc.hourly ? { quantity: svc.hourly.quantity_minimum || 1, minutes: svc.hourly.minutes_minimum || 180 } : undefined,
  };
}

export function BookingFormPage() {
  const { id } = useParams();
  const editing = !!id;
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();

  const existing = useQuery({ queryKey: ['booking', id], queryFn: () => l27<Booking>(`/v1/staff/bookings/${id}`), enabled: editing });
  const presetCustomerId = params.get('customer');
  const presetCustomer = useQuery({
    queryKey: ['customer', presetCustomerId],
    queryFn: () => l27<Customer>(`/v1/staff/customers/${presetCustomerId}`),
    enabled: !editing && !!presetCustomerId,
  });

  const [form, setForm] = useState<FormState>(EMPTY);
  const [loaded, setLoaded] = useState(!editing && !presetCustomerId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  useEffect(() => {
    if (editing && existing.data && !loaded) {
      setForm(fromBooking(existing.data));
      setLoaded(true);
    }
  }, [editing, existing.data, loaded]);

  useEffect(() => {
    const c = presetCustomer.data;
    if (c && !loaded) {
      setForm((f) => ({ ...f, customerId: c.id, address: c.address || '', city: c.city || '', state: c.state || 'ON', zip: c.zip || '', phone: c.phone || '' }));
      setLoaded(true);
    }
  }, [presetCustomer.data, loaded]);

  const locations = useLocations();
  useEffect(() => {
    if (!form.location_id && locations.data?.length) set({ location_id: (locations.data.find((l) => l.default) || locations.data[0]).id });
  }, [locations.data, form.location_id]);

  const loc = form.location_id;
  const services = useQuery({
    queryKey: ['booking-services', loc],
    queryFn: () => l27<BookableService[]>('/v1/booking/services', { location_id: loc! }),
    enabled: !!loc,
  });
  const frequencies = useQuery({
    queryKey: ['booking-frequencies', loc],
    queryFn: () => l27<{ id: number; name: string }[]>('/v1/booking/frequencies', { location_id: loc! }),
    enabled: !!loc,
  });
  useEffect(() => {
    if (!form.frequency_id && frequencies.data?.length) set({ frequency_id: frequencies.data[0].id });
  }, [frequencies.data, form.frequency_id]);

  const fields = useQuery({
    queryKey: ['booking-form-fields'],
    queryFn: () => l27<FormField[]>('/v1/staff/booking_form/custom_fields'),
    staleTime: 10 * 60_000,
    // plain_text is display-only; unlabelled optional fields aren't shown in Launch27's admin either.
    select: (list) => list.filter((f) => f.active && f.control_type !== 'plain_text' && (f.value_required || stripTags(f.label || ''))),
  });
  const teams = useActiveTeams();
  const customerId = form.customerId;
  const customer = useQuery({
    queryKey: ['customer', customerId],
    queryFn: () => l27<Customer>(`/v1/staff/customers/${customerId}`),
    enabled: !!customerId,
  });

  const serviceById = useMemo(() => new Map((services.data || []).map((s) => [s.id, s])), [services.data]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!form.customerId && (!form.first_name || !form.email)) return setError('Pick a customer, or enter a first name and email for a new one.');
    if (!form.services.length) return setError('Add at least one service.');
    if (!form.date) return setError('Pick a date.');

    const payment = form.payment.startsWith('stripe') ? 'stripe' : form.payment.startsWith('fspay') ? 'fspay' : form.payment;
    const info = existing.data?.payment_method_info as { stripe_payment_method_id?: string; fspay_payment_method_id?: string } | undefined;
    const body: Record<string, unknown> = {
      user: form.customerId ? { id: form.customerId } : { first_name: form.first_name, last_name: form.last_name || null, email: form.email },
      address: form.address || null,
      city: form.city || null,
      state: form.state || null,
      zip: form.zip || null,
      phone: form.phone || null,
      location_id: form.location_id,
      frequency_id: form.frequency_id,
      service_date: `${form.date}T${form.time}:00`,
      arrival_window: form.arrival_window,
      services: form.services.map((line) => {
        const svc = serviceById.get(line.id);
        const out: Record<string, unknown> = { id: line.id };
        if (line.hourly) out.hourly = line.hourly;
        // Launch27 requires every pricing parameter of the service, even at 0.
        const pp = svc ? svc.pricing_parameters.map((p) => ({ id: p.id, quantity: line.pricing[p.id] ?? 0 })) : Object.entries(line.pricing).map(([pid, q]) => ({ id: Number(pid), quantity: q }));
        if (pp.length) out.pricing_parameters = pp;
        const extras = Object.entries(line.extras).filter(([, q]) => q > 0).map(([xid, q]) => ({ id: Number(xid), quantity: q, recurring: null }));
        if (extras.length) out.extras = extras;
        return out;
      }),
      discount_code: form.discount_code || null,
      tip: form.tip ? parseFloat(form.tip) : null,
      tip_recurring: false,
      payment_method: payment,
      stripe_payment_method_id: payment === 'stripe' ? info?.stripe_payment_method_id : undefined,
      fspay_payment_method_id: payment === 'fspay' ? info?.fspay_payment_method_id : undefined,
      customer_notes: form.customer_notes || null,
      staff_notes: form.staff_notes || null,
      price_adjustment: form.price_adjustment ? parseFloat(form.price_adjustment) : null,
      price_adjustment_comment: form.price_adjustment_comment || null,
      custom_fields: (fields.data || [])
        .filter((f) => form.custom[f.id] !== undefined && form.custom[f.id] !== '')
        .map((f) => {
          const v = form.custom[f.id];
          return Array.isArray(v) ? { id: f.id, values: v.map((oid) => ({ id: oid, other: null })) } : { id: f.id, value: v };
        }),
      teams: form.teams,
      sms_notifications: form.sms_notifications,
    };
    if (editing) {
      body.id = Number(id);
      body.is_mass_update = form.is_mass_update;
      body.team_with_key_id = existing.data?.team_with_key_id ?? null;
      body.team_requested_id = existing.data?.team_requested_id ?? null;
    }

    setSaving(true);
    try {
      const saved = editing
        ? await l27Write<{ id: number }>('PUT', `/v1/staff/bookings/${id}`, body)
        : await l27Write<{ id: number }>('POST', '/v1/staff/bookings', body);
      await queryClient.invalidateQueries({ queryKey: ['booking'] });
      await queryClient.invalidateQueries({ queryKey: ['bookings'] });
      navigate(`/bookings/${saved.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!canWrite) return <WritesOff />;
  if (!loaded) return <div className="muted">Loading…</div>;
  if (editing && existing.data && !existing.data.actions?.edit) {
    return <div className="error">Launch27 doesn't allow editing this booking (it may be cancelled or completed).</div>;
  }

  const teamsForLocation = (teams.data || []).filter((t) => !loc || !t.locations?.length || t.locations.some((l) => l.id === loc));
  const recurring = editing && existing.data?.frequency?.name && !/one time/i.test(existing.data.frequency.name);

  return (
    <form onSubmit={submit} className="booking-form">
      <header className="page-header">
        <div>
          <div className="muted small">
            <Link to="/bookings">Bookings</Link> {editing && <>/ <Link to={`/bookings/${id}`}>#{id}</Link></>} /
          </div>
          <h1>{editing ? `Edit booking #${id}` : 'New booking'}</h1>
        </div>
        <div className="filters form-actions">
          <button type="button" className="secondary" onClick={() => navigate(-1)}>
            Cancel
          </button>
          <button type="submit" disabled={saving}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Create booking'}
          </button>
        </div>
      </header>

      {error && <div className="error pre">{error}</div>}

      <div className="grid-2">
        <section className="card">
          <h2>Customer</h2>
          {form.customerId ? (
            <div className="row-line">
              <span>
                <strong>{customer.data ? customerName(customer.data) : `#${form.customerId}`}</strong> <span className="muted small">{customer.data?.email}</span>
              </span>
              {!editing && (
                <button type="button" className="link" onClick={() => set({ customerId: null })}>
                  Change
                </button>
              )}
            </div>
          ) : (
            <CustomerPicker form={form} set={set} />
          )}

          <h3>Service address</h3>
          <div className="field-grid">
            <label className="span-2">
              Street
              <input value={form.address} onChange={(e) => set({ address: e.target.value })} />
            </label>
            <label>
              City
              <input value={form.city} onChange={(e) => set({ city: e.target.value })} />
            </label>
            <label>
              Province
              <input value={form.state} onChange={(e) => set({ state: e.target.value })} />
            </label>
            <label>
              Postal code
              <input value={form.zip} onChange={(e) => set({ zip: e.target.value })} />
            </label>
            <label>
              Phone
              <input value={form.phone} onChange={(e) => set({ phone: e.target.value })} />
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={form.sms_notifications} onChange={(e) => set({ sms_notifications: e.target.checked })} /> Send text message notifications
          </label>
        </section>

        <section className="card">
          <h2>When</h2>
          <div className="field-grid">
            <label>
              Location
              <select value={form.location_id ?? ''} onChange={(e) => set({ location_id: Number(e.target.value), services: [], frequency_id: null })}>
                {locations.data?.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Frequency
              <select value={form.frequency_id ?? ''} onChange={(e) => set({ frequency_id: Number(e.target.value) })}>
                {frequencies.data?.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Date
              <input type="date" value={form.date} onChange={(e) => set({ date: e.target.value })} required />
            </label>
            <label>
              Arrival time
              <input type="time" step={900} value={form.time} onChange={(e) => set({ time: e.target.value })} required />
            </label>
            <label>
              Arrival window
              <select value={form.arrival_window} onChange={(e) => set({ arrival_window: Number(e.target.value) })}>
                {[0, 30, 60, 90, 120, 180].map((m) => (
                  <option key={m} value={m}>
                    {m ? `${m} min` : 'Exact time'}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {recurring && (
            <label className="check">
              <input type="checkbox" checked={form.is_mass_update} onChange={(e) => set({ is_mass_update: e.target.checked })} /> Also apply changes to future bookings in this
              series
            </label>
          )}

          <h3>Cleaners</h3>
          <TeamPicker teams={teamsForLocation} selected={form.teams} onChange={(t) => set({ teams: t })} />
          <p className="muted small">Assigned cleaners are notified by Launch27.</p>
        </section>
      </div>

      <section className="card">
        <h2>Services</h2>
        {form.services.map((line, index) => {
          const svc = serviceById.get(line.id);
          const update = (patch: Partial<ServiceLine>) => set({ services: form.services.map((l, i) => (i === index ? { ...l, ...patch } : l)) });
          return (
            <div key={`${line.id}-${index}`} className="service-line">
              <div className="row-line">
                <strong>{svc?.name || `Service #${line.id}`}</strong>
                <span>
                  {svc && <span className="muted small">base {fmtMoney(svc.price)} </span>}
                  <button type="button" className="link" onClick={() => set({ services: form.services.filter((_, i) => i !== index) })}>
                    Remove
                  </button>
                </span>
              </div>
              <div className="field-grid">
                {line.hourly && svc?.hourly && (
                  <>
                    <label>
                      Cleaners
                      <input type="number" min={svc.hourly.quantity_minimum} max={svc.hourly.quantity_maximum} value={line.hourly.quantity} onChange={(e) => update({ hourly: { ...line.hourly!, quantity: Number(e.target.value) } })} />
                    </label>
                    <label>
                      Hours
                      <input
                        type="number"
                        step={svc.hourly.half_hour_increments ? 0.5 : 1}
                        min={svc.hourly.minutes_minimum / 60}
                        max={svc.hourly.minutes_maximum / 60}
                        value={line.hourly.minutes / 60}
                        onChange={(e) => update({ hourly: { ...line.hourly!, minutes: Math.round(Number(e.target.value) * 60) } })}
                      />
                    </label>
                  </>
                )}
                {svc?.pricing_parameters.map((p) => (
                  <label key={p.id}>
                    {p.name} <span className="muted small">({fmtMoney(p.price)} each)</span>
                    <input
                      type="number"
                      min={p.quantity_minimum ?? 0}
                      max={p.quantity_maximum ?? undefined}
                      value={line.pricing[p.id] ?? 0}
                      onChange={(e) => update({ pricing: { ...line.pricing, [p.id]: Number(e.target.value) } })}
                    />
                  </label>
                ))}
              </div>
              {!!svc?.extras.length && (
                <details open={Object.values(line.extras).some((q) => q > 0)}>
                  <summary className="small">Extras ({Object.values(line.extras).filter((q) => q > 0).length} selected)</summary>
                  <div className="extras">
                    {svc.extras.map((x) => {
                      const qty = line.extras[x.id] || 0;
                      return (
                        <label key={x.id} className="check">
                          <input type="checkbox" checked={qty > 0} onChange={(e) => update({ extras: { ...line.extras, [x.id]: e.target.checked ? 1 : 0 } })} />
                          {x.name} <span className="muted small">{fmtMoney(x.price)}</span>
                          {x.quantity_based && qty > 0 && (
                            <input type="number" min={1} className="qty" value={qty} onChange={(e) => update({ extras: { ...line.extras, [x.id]: Math.max(1, Number(e.target.value)) } })} />
                          )}
                        </label>
                      );
                    })}
                  </div>
                </details>
              )}
            </div>
          );
        })}
        <select
          value=""
          onChange={(e) => {
            const svc = serviceById.get(Number(e.target.value));
            if (svc) set({ services: [...form.services, newServiceLine(svc)] });
          }}
        >
          <option value="">+ Add a service…</option>
          {services.data?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({fmtMoney(s.price)})
            </option>
          ))}
        </select>
        <p className="muted small">Launch27 calculates the price when the booking is saved.</p>
      </section>

      <div className="grid-2">
        <section className="card">
          <h2>Payment & price</h2>
          <div className="field-grid">
            <label>
              Payment method
              <select value={form.payment} onChange={(e) => set({ payment: e.target.value })}>
                {editing && existing.data?.payment_method_info?.code && existing.data.payment_method_info.code !== 'check' && (
                  <option value={existing.data.payment_method_info.code}>{existing.data.payment_method_info.text || existing.data.payment_method_info.code} (current)</option>
                )}
                <option value="check">Cash / cheque</option>
              </select>
            </label>
            <label>
              Discount code
              <input value={form.discount_code} onChange={(e) => set({ discount_code: e.target.value })} />
            </label>
            <label>
              Tip
              <input type="number" step="0.01" value={form.tip} onChange={(e) => set({ tip: e.target.value })} />
            </label>
            <label>
              Price adjustment (+/−)
              <input type="number" step="0.01" value={form.price_adjustment} onChange={(e) => set({ price_adjustment: e.target.value })} />
            </label>
            <label className="span-2">
              Adjustment reason
              <input value={form.price_adjustment_comment} onChange={(e) => set({ price_adjustment_comment: e.target.value })} />
            </label>
          </div>
          {!editing && <p className="muted small">Card payments: add the card on the booking in Launch27 for now.</p>}
        </section>

        <section className="card">
          <h2>Notes & questions</h2>
          <label className="block">
            Staff notes (internal)
            <textarea rows={3} value={form.staff_notes} onChange={(e) => set({ staff_notes: e.target.value })} />
          </label>
          <label className="block">
            Customer notes
            <textarea rows={3} value={form.customer_notes} onChange={(e) => set({ customer_notes: e.target.value })} />
          </label>
          {fields.data?.map((f) => (
            <CustomFieldInput key={f.id} field={f} value={form.custom[f.id]} onChange={(v) => set({ custom: { ...form.custom, [f.id]: v } })} />
          ))}
        </section>
      </div>
    </form>
  );
}

function CustomerPicker({ form, set }: { form: FormState; set: (p: Partial<FormState>) => void }) {
  const [mode, setMode] = useState<'search' | 'new'>('search');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 300);
    return () => clearTimeout(t);
  }, [query]);
  const results = useQuery({
    queryKey: ['customer-search', debounced],
    queryFn: () => l27<Customer[]>('/v1/staff/customers', { filter: 'active', query: debounced, limit: 8, offset: 0 }),
    enabled: mode === 'search' && debounced.length >= 2,
  });

  return (
    <>
      <div className="tabs">
        <button type="button" className={mode === 'search' ? 'tab active' : 'tab'} onClick={() => setMode('search')}>
          Existing customer
        </button>
        <button type="button" className={mode === 'new' ? 'tab active' : 'tab'} onClick={() => setMode('new')}>
          New customer
        </button>
      </div>
      {mode === 'search' ? (
        <>
          <input placeholder="Search name, email or phone…" value={query} onChange={(e) => setQuery(e.target.value)} className="full" />
          <div className="picker-results">
            {results.data?.map((c) => (
              <button
                type="button"
                key={c.id}
                className="picker-row"
                onClick={() => set({ customerId: c.id, address: c.address || '', city: c.city || '', state: c.state || 'ON', zip: c.zip || '', phone: c.phone || '' })}
              >
                <strong>{customerName(c)}</strong> <span className="muted small">{c.email} · {[c.address, c.city].filter(Boolean).join(', ')}</span>
              </button>
            ))}
            {results.data?.length === 0 && <div className="muted small">No match.</div>}
          </div>
        </>
      ) : (
        <div className="field-grid">
          <label>
            First name
            <input value={form.first_name} onChange={(e) => set({ first_name: e.target.value })} />
          </label>
          <label>
            Last name
            <input value={form.last_name} onChange={(e) => set({ last_name: e.target.value })} />
          </label>
          <label className="span-2">
            Email
            <input type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} />
          </label>
        </div>
      )}
    </>
  );
}

function TeamPicker({ teams, selected, onChange }: { teams: { id: number; title: string; bg_color?: string }[]; selected: number[]; onChange: (ids: number[]) => void }) {
  const [filter, setFilter] = useState('');
  const shown = teams.filter((t) => selected.includes(t.id) || t.title.toLowerCase().includes(filter.toLowerCase()));
  return (
    <>
      <input placeholder="Filter cleaners…" value={filter} onChange={(e) => setFilter(e.target.value)} className="full" />
      <div className="team-list">
        {shown.map((t) => (
          <label key={t.id} className="check">
            <input type="checkbox" checked={selected.includes(t.id)} onChange={(e) => onChange(e.target.checked ? [...selected, t.id] : selected.filter((x) => x !== t.id))} />
            <span className="dot" style={{ background: t.bg_color || '#ccc' }} />
            {t.title}
          </label>
        ))}
      </div>
      <div className="muted small">{selected.length ? `${selected.length} selected` : 'Unassigned'}</div>
    </>
  );
}

function CustomFieldInput({ field, value, onChange }: { field: FormField; value: number[] | string | undefined; onChange: (v: number[] | string) => void }) {
  const label = (
    <>
      {stripTags(field.label) || `Field ${field.id}`}
      {field.value_required && <span className="warn"> *</span>}
    </>
  );
  const options = (field.options || []).filter((o) => o.active);
  switch (field.control_type) {
    case 'drop_down':
    case 'radio_buttons':
      return (
        <label className="block">
          {label}
          <select value={Array.isArray(value) ? value[0] ?? '' : ''} onChange={(e) => onChange(e.target.value ? [Number(e.target.value)] : [])}>
            <option value="">—</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      );
    case 'checkboxes': {
      const list = Array.isArray(value) ? value : [];
      return (
        <fieldset className="block">
          <legend>{label}</legend>
          {options.map((o) => (
            <label key={o.id} className="check">
              <input type="checkbox" checked={list.includes(o.id)} onChange={(e) => onChange(e.target.checked ? [...list, o.id] : list.filter((x) => x !== o.id))} /> {o.label}
            </label>
          ))}
        </fieldset>
      );
    }
    case 'checkbox':
      // Launch27 wants the strings "true"/"false" here.
      return (
        <label className="check block">
          <input type="checkbox" checked={value === 'true'} onChange={(e) => onChange(e.target.checked ? 'true' : 'false')} /> {label}
        </label>
      );
    case 'multi_line':
      return (
        <label className="block">
          {label}
          <textarea rows={2} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />
        </label>
      );
    default:
      return (
        <label className="block">
          {label}
          <input value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />
        </label>
      );
  }
}

export function WritesOff() {
  return (
    <div className="card">
      <h2>Editing is turned off</h2>
      <p className="muted">
        The server only lets read requests through to Launch27. Set <code>L27_ALLOW_WRITES=true</code> in <code>.env</code> and restart <code>npm run dev</code> to enable editing.
      </p>
    </div>
  );
}
