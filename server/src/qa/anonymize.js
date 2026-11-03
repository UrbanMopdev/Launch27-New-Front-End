// Turns a pull of real Launch27 data into the QA copy.
//
// Approach: allow-list. Each object is rebuilt field by field; anything not listed is
// dropped, so a new field Launch27 adds later can never come through unnoticed.
//
// What is masked (decided Nov 3, 2026: the team knows its clients and cleaners, so QA
// mirrors them except for the ways to contact them):
// - emails -> customer<id>@example.com / cleaner<id>@example.com
// - phone numbers -> fake (613) 555 numbers
// - any email or phone typed inside notes, tags, comments or reasons
// - card numbers (brand and expiry only) and payment processor ids
// Kept as in production: names, company names, addresses, postal codes, map locations,
// notes, tags, comments, staff names, and everything about bookings (dates, services,
// prices, frequencies, cleaners, check-in/out, ratings).

import { createHmac, randomBytes } from 'node:crypto';

export const NOTE = 'Note removed for QA';
export const EMAIL_MASK = '[email removed]';
export const PHONE_MASK = '[phone removed]';

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

// Masks emails and phone numbers inside free text; everything else in the text stays.
const EMAIL_ALL = new RegExp(EMAIL_RE.source, 'g');
const PHONE_ALL = /(\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
export function maskContacts(v) {
  if (v === null || v === undefined) return v ?? null;
  return String(v).replace(EMAIL_ALL, EMAIL_MASK).replace(PHONE_ALL, PHONE_MASK);
}

export function createAnonymizer(salt = randomBytes(16).toString('hex')) {
  const tags = (list) => (list || []).map((t) => ({ id: t.id, name: maskContacts(t.name), color: t.color, type: t.type }));
  const h = (kind, id) => createHmac('sha256', salt).update(`${kind}:${id}`).digest();
  const phone = (kind, id) => {
    const b = h(`${kind}-phone`, id);
    return `(613) 555-${String(1000 + (b.readUInt16BE(2) % 9000)).padStart(4, '0')}`;
  };

  function customer(c) {
    return {
      id: c.id,
      first_name: c.first_name ?? null,
      last_name: c.last_name ?? null,
      company_name: c.company_name ?? null,
      email: `customer${c.id}@example.com`,
      has_generated_email: false,
      phone: phone('customer', c.id),
      address: maskContacts(c.address),
      city: c.city ?? null,
      state: c.state ?? null,
      zip: c.zip ?? null,
      latitude: c.latitude ?? null,
      longitude: c.longitude ?? null,
      notes: maskContacts(c.notes),
      active: c.active,
      confirmed: c.confirmed,
      is_new_customer: c.is_new_customer,
      created_at: c.created_at,
      tags_info: tags(c.tags_info),
      sales_tax: c.sales_tax ?? null,
    };
  }

  function team(t) {
    return {
      id: t.id,
      title: maskContacts(t.title),
      first_name: t.first_name ?? null,
      last_name: t.last_name ?? null,
      email: `cleaner${t.id}@example.com`,
      phone: phone('team', t.id),
      address: maskContacts(t.address),
      city: t.city ?? null,
      state: t.state ?? null,
      zip: t.zip ?? null,
      latitude: t.latitude ?? null,
      longitude: t.longitude ?? null,
      notes: maskContacts(t.notes),
      active: t.active,
      confirmed: t.confirmed,
      bg_color: t.bg_color,
      fg_color: t.fg_color,
      share: t.share,
      rating: t.rating,
      ratings_count: t.ratings_count,
      stars: t.stars,
      locations: (t.locations || []).map((l) => ({ id: l.id, name: l.name, active: l.active, default: l.default })),
      tags_info: tags(t.tags_info),
    };
  }


  const card = (pm) => (pm ? { code: pm.code, text: pm.brand ? `${pm.brand} - 0000` : pm.code === 'stripe' ? 'card - 0000' : pm.text && /\d{4}/.test(pm.text) ? pm.text.replace(/\d{4}/g, '0000') : pm.text, brand: pm.brand } : null);

  function charge(ch) {
    return { id: ch.id, amount: ch.amount, status: ch.status, charged_date: ch.charged_date, description: ch.description && /^on hold/i.test(ch.description) ? 'On hold' : ch.description ? 'Charge' : null, payment_method_info: card(ch.payment_method_info) };
  }

  function booking(b) {
    const u = b.user || {};
    const addr = b.address || {};
    const services = (b.services || []).map((s) => ({
      id: s.id,
      name: s.name,
      price: s.price,
      hourly: s.hourly ? { title: s.hourly.title, quantity: s.hourly.quantity, minutes: s.hourly.minutes } : undefined,
      commercial: s.commercial,
      discount_by_frequency: s.discount_by_frequency,
      discount_by_code: s.discount_by_code,
      pricing_parameters: (s.pricing_parameters || []).map((x) => ({ id: x.id, type: x.type, name: x.name, quantity: x.quantity, price: x.price, total: x.total })),
      extras: (s.extras || []).map((x) => ({ id: x.id, name: x.name, quantity: x.quantity, quantity_based: x.quantity_based, price: x.price, total: x.total, recurring: x.recurring, discount_by_frequency: x.discount_by_frequency, discount_by_code: x.discount_by_code })),
    }));
    const di = b.discount_info || {};
    return {
      id: b.id,
      // Launch27's forecast of future recurring visits: no id, just the booking it repeats.
      forecasted_from_booking: b.forecasted_from_booking ? { id: b.forecasted_from_booking.id } : undefined,
      active: b.active,
      completed: b.completed,
      booking_status: b.booking_status,
      service_date: b.service_date,
      arrival_window: b.arrival_window,
      duration: b.duration,
      blocked_duration: b.blocked_duration,
      created_at: b.created_at,
      created_by: b.created_by ? { id: b.created_by.id, name: b.created_by.name ?? null } : null,
      location: b.location ? { id: b.location.id, name: b.location.name } : null,
      frequency: b.frequency ? { id: b.frequency.id, interval: b.frequency.interval, name: b.frequency.name } : null,
      first_recurring: b.first_recurring,
      user: u.id ? { id: u.id, name: u.name ?? null, first_name: u.first_name ?? null, last_name: u.last_name ?? null, company_name: u.company_name ?? null, email: `customer${u.id}@example.com`, is_new_customer: u.is_new_customer, tags_info: tags(u.tags_info) } : null,
      phone: u.id ? phone('customer', u.id) : null,
      address: { full_address: maskContacts(addr.full_address), street: maskContacts(addr.street), city: addr.city ?? null, state: addr.state ?? null, zip: addr.zip ?? null, latitude: addr.latitude ?? null, longitude: addr.longitude ?? null },
      services,
      summary: b.summary,
      discount_info: { frequency_amount: di.frequency_amount, discount_amount: di.discount_amount, discount_code: di.discount_code ?? undefined, giftcard_amount: di.giftcard_amount },
      price_adjustment_comment: maskContacts(b.price_adjustment_comment),
      payment_method_info: card(b.payment_method_info),
      custom_fields: (b.custom_fields || []).map((f) => ({ id: f.id, title: f.title, type: f.type, values: (f.values || []).map((v) => ({ id: v.id, label: v.label, name: v.name, other: maskContacts(v.other || '') })) })),
      staff_notes: maskContacts(b.staff_notes),
      customer_notes: maskContacts(b.customer_notes),
      teams: (b.teams || []).map((t) => ({ id: t.id, title: maskContacts(t.title), share: t.share, hours: t.hours, earned: t.earned, bg_color: t.bg_color, fg_color: t.fg_color })),
      team_requested_id: b.team_requested_id ?? null,
      team_with_key_id: b.team_with_key_id ?? null,
      time_tracking: (b.time_tracking || []).map((x) => {
        return { id: x.id, team: x.team ? { id: x.team.id, title: maskContacts(x.team.title) } : null, state: x.state, enroute_started_at: x.enroute_started_at, enroute_finished_at: x.enroute_finished_at, checkin_at: x.checkin_at, checkout_at: x.checkout_at, checkin_latitude: x.checkin_latitude ?? null, checkin_longitude: x.checkin_longitude ?? null, distance: x.distance };
      }),
      charges: b.charges ? { charged: (b.charges.charged || []).map(charge), onhold: (b.charges.onhold || []).map(charge), refunded: (b.charges.refunded || []).map(charge), marked_paid: (b.charges.marked_paid || []).map(charge), outstanding: b.charges.outstanding } : undefined,
      feedback: b.feedback ? { rating: b.feedback.rating, stars: b.feedback.stars, rated_at: b.feedback.rated_at, comment: maskContacts(b.feedback.comment) } : null,
      cancellation: b.cancellation ? { fee: b.cancellation.fee, date: b.cancellation.date, reason: maskContacts(b.cancellation.reason), cancelled_by: { name: b.cancellation.cancelled_by?.name ?? null } } : undefined,
      actions: b.actions,
      tip_recurring: b.tip_recurring,
      price_adjustment_recurring: b.price_adjustment_recurring,
    };
  }

  function cards(billing) {
    return { cards: (billing?.cards || []).map((k, i) => ({ id: `card${i}`, brand: k.brand, last4: '0000', exp_month: k.exp_month, exp_year: k.exp_year, is_default: k.is_default, is_deleted: k.is_deleted })) };
  }

  return { customer, team, booking, cards };
}

// Strings from the real data that must never appear in the copy.
// The real emails and phone numbers in a pull: none of them may appear in the copy. (Names,
// addresses and notes are meant to come through, so they are not checked.)
export function sensitiveStrings({ customers = [], teams = [], bookings = [] }) {
  const out = new Set();
  const addEmail = (v) => {
    const s = String(v ?? '').trim().toLowerCase();
    if (s.includes('@') && !s.endsWith('@example.com')) out.add(s);
  };
  const addPhone = (v) => {
    const d = String(v ?? '').replace(/\D/g, '');
    // The fake numbers use the 555 exchange, so a real 555 number would match by chance.
    if (d.length >= 7 && !d.slice(-7).startsWith('555')) out.add(d.slice(-7));
  };
  for (const p of [...customers, ...teams]) {
    addEmail(p.email);
    addPhone(p.phone);
  }
  for (const b of bookings) {
    addEmail(b.user?.email);
    addPhone(b.phone);
  }
  return out;
}

// A real value counts as leaked when a copied string equals it (or one of its
// comma-separated parts does), or, for long values, contains it. Short values are only
// matched exactly: a 4-letter street name will otherwise turn up inside random text.
const LONG = 12;

function stringValues(v, path, out) {
  if (v === null || v === undefined) return out;
  if (Array.isArray(v)) v.forEach((x) => stringValues(x, `${path}[]`, out));
  else if (typeof v === 'object') Object.entries(v).forEach(([k, x]) => stringValues(x, path ? `${path}.${/^\d+$/.test(k) ? '*' : k}` : k, out));
  else out.push([path, String(v)]);
  return out;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}\b/g;

function findLeaks(copy, originals) {
  const values = stringValues(copy, '', []);
  const long = originals ? [...originals].filter((s) => s.length >= LONG && !/^\d{7}$/.test(s)) : [];
  const counts = { emails: 0, phones: 0, processor: 0 };
  const hits = new Set();
  const paths = new Map();
  for (const [path, str] of values) {
    let leak = false;
    const emails = (str.match(EMAIL) || []).filter((e) => !/@example\.com$/i.test(e));
    const phones = str.match(PHONE) || [];
    const realPhones = phones.filter((ph) => !/\b555[\s.-]?\d{4}\b/.test(ph));
    counts.emails += emails.length;
    counts.phones += realPhones.length;
    if (emails.length || realPhones.length) leak = true;
    if (/pm_[A-Za-z0-9]{10,}|cus_[A-Za-z0-9]{10,}/.test(str)) { counts.processor++; leak = true; }
    if (originals) {
      const t = str.trim().toLowerCase();
      const parts = t.includes(',') ? [t, ...t.split(',').map((x) => x.trim())] : [t];
      for (const part of parts) if (originals.has(part)) { hits.add(part); leak = true; }
      for (const ph of phones) {
        const tail = ph.replace(/\D/g, '').slice(-7);
        if (originals.has(tail)) { hits.add(tail); leak = true; }
      }
      if (t.length >= LONG) for (const s of long) if (t.includes(s)) { hits.add(s); leak = true; }
    }
    if (leak) paths.set(path, (paths.get(path) || 0) + 1);
  }
  return { counts, hits: hits.size, paths };
}

// Throws if the copy still contains anything personal. `originals` (optional) adds the
// strongest check: none of the real values may appear anywhere.
export function assertAnonymous(copy, originals = null) {
  const { counts, hits, paths } = findLeaks(copy, originals);
  const problems = [];
  if (counts.emails) problems.push(`${counts.emails} email address(es) not on example.com`);
  if (counts.phones) problems.push(`${counts.phones} phone number(s) not in the 555 range`);
  if (counts.processor) problems.push('payment processor ids present');
  if (hits) problems.push(`${hits} real value(s) from Launch27 still present`);
  if (problems.length) {
    const where = fieldList(paths);
    throw new Error(`QA copy still has contact details: ${problems.join('; ')}${where.length ? `. Fields: ${where.join(', ')}` : ''}`);
  }
  return true;
}

function fieldList(paths, limit = 20) {
  return [...paths.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([p, n]) => `${p} (${n})`);
}

// Where personal data was found, as field paths with array indexes collapsed
// (e.g. "bookings[].services[].extras[].name"). Never includes the values themselves.
export function leakPaths(copy, originals = null, limit = 20) {
  return fieldList(findLeaks(copy, originals).paths, limit);
}
