import { FormEvent, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { inbox } from '../inbox/api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { l27, l27All, l27Write } from '../api';
import { Icon } from '../components/Icon';
import { Avatar } from '../inbox/Customer360';
import { cleanerAffinity } from '../lib/customer360';
import type { RatedBooking } from '../lib/feedbackModel';
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
  const [addingService, setAddingService] = useState(false);
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
      // Opened from a support conversation: log the change there and go back to it.
      const conversationId = params.get('conversation');
      if (conversationId) {
        const after = saved as Booking;
        const when = String(body.service_date || '').replace('T', ' ').slice(0, 16);
        const before = existing.data?.summary?.total;
        const price = editing && before !== undefined && after.summary?.total !== undefined && before !== after.summary.total ? `, price ${fmtMoney(before)} → ${fmtMoney(after.summary.total)}` : '';
        const summary = `${editing ? 'Updated' : 'Created'} booking #${saved.id} for ${when}${editing && form.is_mass_update ? ' (this and future visits)' : ''}${price}`;
        await inbox.addEvent(Number(conversationId), summary, { type: 'booking', booking_id: saved.id, action: editing ? 'updated' : 'created' }).catch(() => {});
        if (!editing) await inbox.patch(Number(conversationId), { l27_booking_id: saved.id }).catch(() => {});
        navigate(params.get('return') || `/inbox/${conversationId}`);
        return;
      }
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
  const estimate = estimateTotal(form.services, serviceById);
  const freqName = frequencies.data?.find((f) => f.id === form.frequency_id)?.name;
  const chosenTeams = (teams.data || []).filter((t) => form.teams.includes(t.id));
  const missing = [!form.customerId && !(form.first_name && form.email) && 'customer', !form.services.length && 'service', !form.date && 'date'].filter(Boolean) as string[];

  return (
    <form onSubmit={submit} className="bf">
      <div className="crumbs small">
        <Link to="/bookings">Bookings</Link> {editing && <>/ <Link to={`/bookings/${id}`}>#{id}</Link></>} / {editing ? 'Edit' : 'New'}
      </div>
      <h1 className="bf-title">{editing ? `Edit booking #${id}` : 'New booking'}</h1>
      {error && <div className="error pre">{error}</div>}

      <div className="bf-cols">
        <div className="bf-main">
          <Step n={1} title="Customer" done={!!form.customerId || !!(form.first_name && form.email)}>
            {form.customerId ? (
              <div className="bf-picked">
                <Avatar name={customer.data ? customerName(customer.data) : ''} size={44} />
                <div className="grow">
                  <strong>{customer.data ? customerName(customer.data) : `#${form.customerId}`}</strong>
                  <div className="muted small">{[customer.data?.email, customer.data?.phone].filter(Boolean).join(' · ')}</div>
                </div>
                {!editing && (
                  <button type="button" className="secondary" onClick={() => set({ customerId: null })}>
                    Change
                  </button>
                )}
              </div>
            ) : (
              <CustomerPicker form={form} set={set} />
            )}
            <details className="bf-more" open={!form.customerId || !form.address}>
              <summary>
                <Icon name="home" /> {form.address ? [form.address, form.city].filter(Boolean).join(', ') : 'Service address'}
              </summary>
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
            </details>
          </Step>

          <Step n={2} title="Service" done={form.services.length > 0}>
            {(locations.data?.length || 0) > 1 && (
              <Segmented
                label="Location"
                value={form.location_id ?? 0}
                options={(locations.data || []).map((l) => ({ value: l.id, label: l.name }))}
                onChange={(v) => set({ location_id: v, services: [], frequency_id: null })}
              />
            )}
            {form.services.map((line, index) => {
              const svc = serviceById.get(line.id);
              const update = (patch: Partial<ServiceLine>) => set({ services: form.services.map((l, i) => (i === index ? { ...l, ...patch } : l)) });
              return (
                <div key={`${line.id}-${index}`} className="bf-line">
                  <div className="bf-line-head">
                    <strong>{svc?.name || `Service #${line.id}`}</strong>
                    {svc && <span className="muted small mono">{fmtMoney(svc.price)}{svc.hourly ? ' / hour' : ''}</span>}
                    <button type="button" className="link small" onClick={() => set({ services: form.services.filter((_, i) => i !== index) })}>
                      Remove
                    </button>
                  </div>
                  <div className="bf-qtys">
                    {line.hourly && svc?.hourly && (
                      <>
                        <Qty label="Cleaners" value={line.hourly.quantity} min={svc.hourly.quantity_minimum} max={svc.hourly.quantity_maximum} onChange={(v) => update({ hourly: { ...line.hourly!, quantity: v } })} />
                        <Qty label="Hours" value={line.hourly.minutes / 60} step={svc.hourly.half_hour_increments ? 0.5 : 1} min={svc.hourly.minutes_minimum / 60} max={svc.hourly.minutes_maximum / 60} onChange={(v) => update({ hourly: { ...line.hourly!, minutes: Math.round(v * 60) } })} />
                      </>
                    )}
                    {svc?.pricing_parameters.map((pp) => (
                      <Qty key={pp.id} label={pp.name} hint={fmtMoney(pp.price)} value={line.pricing[pp.id] ?? 0} min={pp.quantity_minimum ?? 0} max={pp.quantity_maximum ?? undefined} onChange={(v) => update({ pricing: { ...line.pricing, [pp.id]: v } })} />
                    ))}
                  </div>
                  {!!svc?.extras.length && (
                    <div className="bf-extras">
                      <div className="eyebrow">Extras</div>
                      <div className="bf-chips">
                        {svc.extras.map((x) => {
                          const qty = line.extras[x.id] || 0;
                          return (
                            <span key={x.id} className={qty > 0 ? 'bf-extra on' : 'bf-extra'}>
                              <button type="button" aria-pressed={qty > 0} onClick={() => update({ extras: { ...line.extras, [x.id]: qty > 0 ? 0 : 1 } })}>
                                {qty > 0 && <Icon name="check" size={14} />} {x.name} <span className="mono">{fmtMoney(x.price)}</span>
                              </button>
                              {x.quantity_based && qty > 0 && (
                                <input aria-label={`${x.name} quantity`} type="number" min={1} className="qty" value={qty} onChange={(e) => update({ extras: { ...line.extras, [x.id]: Math.max(1, Number(e.target.value)) } })} />
                              )}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {(!form.services.length || addingService) && (
              <div className="bf-svc-grid">
                {services.data?.map((sv) => (
                  <button
                    key={sv.id}
                    type="button"
                    className="bf-svc"
                    onClick={() => {
                      set({ services: [...form.services, newServiceLine(sv)] });
                      setAddingService(false);
                    }}
                  >
                    <strong>{sv.name}</strong>
                    <span className="muted small mono">from {fmtMoney(sv.price)}{sv.hourly ? ' / hour' : ''}</span>
                  </button>
                ))}
                {services.isLoading && <div className="muted">Loading services…</div>}
              </div>
            )}
            {!!form.services.length && !addingService && (
              <button type="button" className="secondary" onClick={() => setAddingService(true)}>
                + Add another service
              </button>
            )}
          </Step>

          <Step n={3} title="When" done={!!form.date}>
            <Segmented label="How often" value={form.frequency_id ?? 0} options={(frequencies.data || []).map((f) => ({ value: f.id, label: f.name }))} onChange={(v) => set({ frequency_id: v })} />
            <div className="bf-when">
              <label>
                Date
                <input type="date" value={form.date} onChange={(e) => set({ date: e.target.value })} required />
              </label>
              <div className="bf-quick">
                {quickDates().map((d) => (
                  <button key={d.value} type="button" className={form.date === d.value ? 'pillbtn on' : 'pillbtn'} onClick={() => set({ date: d.value })}>
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="bf-when">
              <label>
                Arrival
                <input type="time" step={900} value={form.time} onChange={(e) => set({ time: e.target.value })} required />
              </label>
              <div className="bf-quick">
                {['08:00', '09:00', '10:00', '12:00', '13:00', '14:00'].map((tm) => (
                  <button key={tm} type="button" className={form.time === tm ? 'pillbtn on' : 'pillbtn'} onClick={() => set({ time: tm })}>
                    {clock(tm)}
                  </button>
                ))}
              </div>
            </div>
            <Segmented label="Arrival window" value={form.arrival_window} options={[0, 30, 60, 90, 120].map((m) => ({ value: m, label: m ? `${m} min` : 'Exact' }))} onChange={(v) => set({ arrival_window: v })} />
            {recurring && (
              <label className="check bf-check">
                <input type="checkbox" checked={form.is_mass_update} onChange={(e) => set({ is_mass_update: e.target.checked })} /> Also apply these changes to future visits in this series
              </label>
            )}
          </Step>

          <Step n={4} title="Cleaner" done={form.teams.length > 0} optional>
            <TeamPicker teams={teamsForLocation} selected={form.teams} onChange={(tm) => set({ teams: tm })} customerId={form.customerId} />
          </Step>

          <Step n={5} title="Notes and questions" done={!!(form.customer_notes || form.staff_notes)} optional>
            <div className="field-grid two">
              <label className="block">
                From the customer
                <textarea rows={3} value={form.customer_notes} onChange={(e) => set({ customer_notes: e.target.value })} placeholder="What the cleaner should know" />
              </label>
              <label className="block">
                Staff notes (internal)
                <textarea rows={3} value={form.staff_notes} onChange={(e) => set({ staff_notes: e.target.value })} placeholder="Only the office sees this" />
              </label>
            </div>
            <div className="field-grid">
              {fields.data?.map((f) => (
                <CustomFieldInput key={f.id} field={f} value={form.custom[f.id]} onChange={(v) => set({ custom: { ...form.custom, [f.id]: v } })} />
              ))}
            </div>
          </Step>

          <Step n={6} title="Payment and price" done optional>
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
            <label className="check bf-check">
              <input type="checkbox" checked={form.sms_notifications} onChange={(e) => set({ sms_notifications: e.target.checked })} /> Send text message notifications
            </label>
            {!editing && <p className="muted small">Card payments: add the card on the booking in Launch27 for now.</p>}
          </Step>
        </div>

        <aside className="bf-side">
          <section className="card bf-summary">
            <div className="eyebrow">Summary</div>
            <SummaryRow icon="user" label={form.customerId ? (customer.data ? customerName(customer.data) : '…') : form.first_name ? `${form.first_name} ${form.last_name} (new)` : null} empty="No customer yet" />
            <SummaryRow icon="calendar" label={form.date ? `${new Date(`${form.date}T12:00:00`).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' })} · ${clock(form.time)}${form.arrival_window ? ` +${form.arrival_window} min` : ''}` : null} empty="No date yet" sub={freqName} />
            <SummaryRow icon="home" label={form.address ? [form.address, form.city].filter(Boolean).join(', ') : null} empty="No address" />
            <SummaryRow icon="user" label={chosenTeams.length ? chosenTeams.map((x) => x.title).join(', ') : null} empty="No cleaner (assign later)" />
            <div className="bf-sum-lines">
              {form.services.map((line, i) => {
                const sv = serviceById.get(line.id);
                return (
                  <div key={i} className="rc-line">
                    <span>{sv?.name || `Service #${line.id}`}</span>
                    <span className="mono">{fmtMoney(lineEstimate(line, sv))}</span>
                  </div>
                );
              })}
              {!form.services.length && <div className="muted small">No service yet</div>}
            </div>
            {!!form.services.length && (
              <div className="rc-line total">
                <span>Estimate</span>
                <span className="mono">{fmtMoney(estimate)}</span>
              </div>
            )}
            <p className="muted small">Before tax and discounts. Launch27 sets the final price when you save.</p>
            <button type="submit" disabled={saving}>
              {saving ? 'Saving…' : editing ? 'Save changes' : 'Create booking'}
            </button>
            <button type="button" className="secondary" onClick={() => navigate(-1)}>
              Cancel
            </button>
            {!!missing.length && <p className="small warn">Still needed: {missing.join(', ')}</p>}
          </section>
        </aside>
      </div>
    </form>
  );
}

function Step({ n, title, done, optional, children }: { n: number; title: string; done?: boolean; optional?: boolean; children: ReactNode }) {
  return (
    <section className="card bf-step">
      <div className="bf-step-head">
        <span className={done ? 'bf-num done' : 'bf-num'} aria-hidden="true">
          {done ? <Icon name="check" size={14} /> : n}
        </span>
        <h2>{title}</h2>
        {optional && <span className="muted small">optional</span>}
      </div>
      <div className="bf-step-body">{children}</div>
    </section>
  );
}

function Segmented({ label, value, options, onChange }: { label: string; value: number; options: { value: number; label: string }[]; onChange: (v: number) => void }) {
  return (
    <div className="bf-seg-wrap">
      <div className="eyebrow">{label}</div>
      <div className="bf-seg" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Qty({ label, hint, value, min = 0, max, step = 1, onChange }: { label: string; hint?: string; value: number; min?: number; max?: number; step?: number; onChange: (v: number) => void }) {
  const clamp = (v: number) => Math.max(min, max !== undefined ? Math.min(max, v) : v);
  return (
    <div className="bf-qty">
      <div className="small">
        {label} {hint && <span className="muted mono">{hint}</span>}
      </div>
      <div className="bf-qty-ctl">
        <button type="button" className="secondary" aria-label={`Fewer ${label}`} disabled={value <= min} onClick={() => onChange(clamp(value - step))}>
          −
        </button>
        <span className="mono" aria-live="polite">{value}</span>
        <button type="button" className="secondary" aria-label={`More ${label}`} disabled={max !== undefined && value >= max} onClick={() => onChange(clamp(value + step))}>
          +
        </button>
      </div>
    </div>
  );
}

function SummaryRow({ icon, label, empty, sub }: { icon: string; label: string | null; empty: string; sub?: string }) {
  return (
    <div className="bf-sum-row">
      <Icon name={icon} />
      <div className="grow">
        {label ? <span>{label}</span> : <span className="muted">{empty}</span>}
        {sub && <div className="muted small">{sub}</div>}
      </div>
    </div>
  );
}

const clock = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'a.m.' : 'p.m.'}`;
};

function quickDates() {
  const out: { value: string; label: string }[] = [];
  const base = new Date();
  for (let i = 1; out.length < 5; i++) {
    const d = new Date(base.getTime() + i * 86_400_000);
    const value = d.toLocaleDateString('en-CA', { timeZone: TIMEZONE });
    out.push({ value, label: i === 1 ? 'Tomorrow' : d.toLocaleDateString('en-CA', { timeZone: TIMEZONE, weekday: 'short', day: 'numeric' }) });
  }
  return out;
}

// Rough price from the service's list prices, so the office sees a number while building
// the booking. Launch27 prices it for real on save (taxes, discounts, hourly rules).
export function lineEstimate(line: ServiceLine, svc?: BookableService) {
  if (!svc) return 0;
  let total = svc.hourly && line.hourly ? svc.price * (line.hourly.minutes / 60) * line.hourly.quantity : svc.price;
  for (const p of svc.pricing_parameters) total += (line.pricing[p.id] ?? 0) * (p.price || 0);
  for (const x of svc.extras) total += (line.extras[x.id] || 0) * (x.price || 0);
  return Math.round(total * 100) / 100;
}

export function estimateTotal(lines: ServiceLine[], byId: Map<number, BookableService>) {
  return Math.round(lines.reduce((s, l) => s + lineEstimate(l, byId.get(l.id)), 0) * 100) / 100;
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
      <div className="bf-seg" role="radiogroup" aria-label="Customer">
        <button type="button" role="radio" aria-checked={mode === 'search'} className={mode === 'search' ? 'on' : ''} onClick={() => setMode('search')}>
          Existing customer
        </button>
        <button type="button" role="radio" aria-checked={mode === 'new'} className={mode === 'new' ? 'on' : ''} onClick={() => setMode('new')}>
          New customer
        </button>
      </div>
      {mode === 'search' ? (
        <>
          <label className="bf-search">
            <Icon name="search" />
            <span className="sr-only">Search customers</span>
            <input autoFocus placeholder="Search name, email or phone…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <div className="picker-results">
            {results.data?.map((c) => (
              <button
                type="button"
                key={c.id}
                className="picker-row"
                onClick={() => set({ customerId: c.id, address: c.address || '', city: c.city || '', state: c.state || 'ON', zip: c.zip || '', phone: c.phone || '' })}
              >
                <Avatar name={customerName(c)} size={32} />
                <span className="grow">
                  <strong>{customerName(c)}</strong>
                  <span className="muted small"> {[c.email, c.phone, [c.address, c.city].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}</span>
                </span>
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

function TeamPicker({ teams, selected, onChange, customerId }: { teams: { id: number; title: string; bg_color?: string }[]; selected: number[]; onChange: (ids: number[]) => void; customerId: number | null }) {
  const [filter, setFilter] = useState('');
  // Who has cleaned for this customer, and how it went: preferred first.
  const history = useQuery({
    queryKey: ['customer', String(customerId), '360', 'past'],
    queryFn: () => l27All<RatedBooking>('/v1/staff/bookings', { customers: customerId!, options: 'completed,exclude_forecasted', sort: 'desc' }),
    enabled: !!customerId,
    staleTime: 15 * 60_000,
  });
  const affinity = useMemo(() => cleanerAffinity(history.data || []), [history.data]);
  const statsFor = (id: number) => affinity.all.find((c) => c.id === id);
  const rank = (id: number) => (affinity.preferred?.id === id ? 0 : statsFor(id) ? 1 : affinity.avoid.some((a) => a.id === id) ? 3 : 2);
  const shown = teams
    .filter((t) => selected.includes(t.id) || t.title.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => Number(selected.includes(b.id)) - Number(selected.includes(a.id)) || rank(a.id) - rank(b.id) || (statsFor(b.id)?.visits || 0) - (statsFor(a.id)?.visits || 0));
  return (
    <>
      <label className="bf-search">
        <Icon name="search" />
        <span className="sr-only">Filter cleaners</span>
        <input placeholder="Filter cleaners…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </label>
      <div className="bf-teams">
        {shown.map((t) => {
          const on = selected.includes(t.id);
          const st = statsFor(t.id);
          const avoid = affinity.avoid.some((a) => a.id === t.id);
          return (
            <button key={t.id} type="button" aria-pressed={on} className={on ? 'bf-team on' : 'bf-team'} onClick={() => onChange(on ? selected.filter((x) => x !== t.id) : [...selected, t.id])}>
              <Avatar name={t.title} size={32} />
              <span className="grow">
                <strong>{t.title}</strong>
                {affinity.preferred?.id === t.id && <span className="chip ok">preferred</span>}
                {avoid && <span className="chip neg">rated unhappy</span>}
                <span className="muted small"> {st ? `${st.visits} visit${st.visits === 1 ? '' : 's'} for this customer · ${st.happy} happy` : customerId ? 'New to this customer' : ''}</span>
              </span>
              {on && <Icon name="check" />}
            </button>
          );
        })}
      </div>
      <div className="muted small">{selected.length ? `${selected.length} selected · Launch27 notifies assigned cleaners` : 'Unassigned: you can assign from the dispatch board later'}</div>
    </>
  );
}

function CustomFieldInput({ field, value, onChange }: { field: FormField; value: number[] | string | undefined; onChange: (v: number[] | string) => void }) {
  const label = (
    <span>
      {stripTags(field.label) || `Field ${field.id}`}
      {field.value_required && <span className="warn"> *</span>}
    </span>
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
