// Turns a pull of real Launch27 data into a QA copy with no personal information.
//
// Approach: allow-list. Each object is rebuilt field by field; anything not listed is
// dropped, so a new personal field Launch27 adds later can never leak through.
//
// Replaced: customer and cleaner names, emails, phones, street addresses, exact
// coordinates (shifted by a few hundred metres), every free-text field (notes, comments,
// booking-question "Other" text, adjustment and cancellation reasons, rating comments),
// card last 4 digits, payment processor ids, staff names.
// Kept: dates/times, services, rooms, extras, frequencies, prices, discounts,
// adjustments, tips, totals, ratings, cleaner assignments, check-in/out times,
// booking/customer/cleaner ids, locations, city, first 3 characters of the postal code.

import { createHmac, randomBytes } from 'node:crypto';

const FIRST = ['Avery', 'Jordan', 'Taylor', 'Morgan', 'Riley', 'Casey', 'Quinn', 'Jamie', 'Drew', 'Reese', 'Skyler', 'Rowan', 'Emerson', 'Hayden', 'Parker', 'Sage', 'Logan', 'Blake', 'Cameron', 'Dakota', 'Alex', 'Robin', 'Jesse', 'Kendall', 'Shawn', 'Remy', 'Ari', 'Noor', 'Kai', 'Lee'];
const LAST = ['Tremblay', 'Martin', 'Roy', 'Gagnon', 'Lee', 'Wilson', 'Johnson', 'MacDonald', 'Taylor', 'Campbell', 'Anderson', 'Smith', 'Brown', 'Leblanc', 'Clark', 'Young', 'Wright', 'Scott', 'Morin', 'Fortin', 'Singh', 'Nguyen', 'Chen', 'Patel', 'Cote', 'Bouchard', 'Ahmed', 'Kim', 'Lopez', 'Moreau'];
const STREETS = ['Maple Ave', 'Cedar St', 'Birch Cres', 'Elm Dr', 'Willow Way', 'Oak St', 'Pine Rd', 'Spruce Ct', 'Aspen Pl', 'Linden Ave', 'Poplar St', 'Juniper Dr'];

export const NOTE = 'Note removed for QA';

// True for values the anonymizer itself produces (fake names and streets). A real
// person who happens to share a fake name is not a leak.
const FAKE_NAMES = new Set(FIRST.flatMap((f) => LAST.map((l) => `${f} ${l}`.toLowerCase())));
const FAKE_STREET = new RegExp(`^\\d+ (${STREETS.join('|')})$`, 'i');
export function isGeneratedValue(s) {
  const v = String(s).trim().toLowerCase();
  return FAKE_NAMES.has(v) || FAKE_STREET.test(v) || v === NOTE.toLowerCase();
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;

// First and last names of everyone in the data (lower case, 3+ letters), used to spot
// tags that name a person ("Prefers Marc", "Do not assign …").
export function personTokens({ customers = [], teams = [] }) {
  const out = new Set();
  for (const p of [...customers, ...teams]) {
    for (const part of [p.first_name, p.last_name, ...(String(p.title || '').split(/\s+/))]) {
      for (const w of String(part || '').toLowerCase().split(/[^a-zà-ÿ'-]+/)) if (w.length >= 3) out.add(w);
    }
  }
  return out;
}

// Tags are typed by staff, so treat them like notes: keep a tag only when it holds no
// name, email or phone; otherwise replace it with a neutral label of the same kind.
export function cleanTag(name, people = new Set()) {
  const text = String(name || '');
  const words = text.toLowerCase().split(/[^a-zà-ÿ'-]+/).filter(Boolean);
  const personal = EMAIL_RE.test(text) || PHONE_RE.test(text) || words.some((w) => people.has(w));
  if (!personal) return text;
  if (/(not|never|don'?t|avoid).{0,20}(assign|send|book)|do not/i.test(text)) return 'Do not assign a specific cleaner';
  if (/prefer|request|favou?rite|only/i.test(text)) return 'Prefers a specific cleaner';
  return 'Tag removed for QA';
}

export function createAnonymizer(salt = randomBytes(16).toString('hex'), people = new Set()) {
  const tags = (list) => (list || []).map((t) => ({ id: t.id, name: cleanTag(t.name, people), color: t.color, type: t.type }));
  const h = (kind, id) => createHmac('sha256', salt).update(`${kind}:${id}`).digest();
  const pick = (arr, buf, i) => arr[buf[i] % arr.length];
  const person = (kind, id) => {
    const b = h(kind, id);
    return { first: pick(FIRST, b, 0), last: pick(LAST, b, 1) };
  };
  const phone = (kind, id) => {
    const b = h(`${kind}-phone`, id);
    return `(613) 555-${String(1000 + (b.readUInt16BE(2) % 9000)).padStart(4, '0')}`;
  };
  const street = (kind, id) => {
    const b = h(`${kind}-street`, id);
    return `${10 + (b.readUInt16BE(4) % 980)} ${pick(STREETS, b, 6)}`;
  };
  // Shift a coordinate by roughly 200–600 m in a stable direction.
  const jitter = (kind, id, lat, lng) => {
    if (lat === null || lat === undefined || lng === null || lng === undefined) return { latitude: null, longitude: null };
    const b = h(`${kind}-geo`, id);
    const dist = 0.002 + (b[8] / 255) * 0.004;
    const ang = (b[9] / 255) * Math.PI * 2;
    return { latitude: Number(lat) + Math.sin(ang) * dist, longitude: Number(lng) + Math.cos(ang) * dist * 1.4 };
  };
  const fsa = (zip) => (zip ? `${String(zip).replace(/\s/g, '').slice(0, 3).toUpperCase()} 0A0` : null);
  const text = (v) => (v && String(v).trim() ? NOTE : v ?? null);

  function customer(c) {
    const p = person('customer', c.id);
    const geo = jitter('customer', c.id, c.latitude, c.longitude);
    return {
      id: c.id,
      first_name: p.first,
      last_name: p.last,
      company_name: c.company_name ? `${p.last} Property Co.` : null,
      email: `customer${c.id}@example.com`,
      has_generated_email: false,
      phone: phone('customer', c.id),
      address: street('customer', c.id),
      city: c.city ?? null,
      state: c.state ?? null,
      zip: fsa(c.zip),
      ...geo,
      notes: text(c.notes),
      active: c.active,
      confirmed: c.confirmed,
      is_new_customer: c.is_new_customer,
      created_at: c.created_at,
      tags_info: tags(c.tags_info),
      sales_tax: c.sales_tax ?? null,
    };
  }

  function team(t) {
    const p = person('team', t.id);
    const geo = jitter('team', t.id, t.latitude, t.longitude);
    // Titles often carry a prefix like "(PT) " or "ON HOLD": keep it, replace the name.
    const prefix = String(t.title || '').match(/^(\s*(\([^)]*\)|ON HOLD)\s*)+/i)?.[0] || '';
    return {
      id: t.id,
      title: `${prefix}${p.first} ${p.last}`,
      first_name: p.first,
      last_name: p.last,
      email: `cleaner${t.id}@example.com`,
      phone: phone('team', t.id),
      address: street('team', t.id),
      city: t.city ?? null,
      state: t.state ?? null,
      zip: fsa(t.zip),
      ...geo,
      notes: text(t.notes),
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

  const teamName = (id) => {
    const p = person('team', id);
    return `${p.first} ${p.last}`;
  };
  const card = (pm) => (pm ? { code: pm.code, text: pm.brand ? `${pm.brand} - 0000` : pm.code === 'stripe' ? 'card - 0000' : pm.text && /\d{4}/.test(pm.text) ? pm.text.replace(/\d{4}/g, '0000') : pm.text, brand: pm.brand } : null);

  function charge(ch) {
    return { id: ch.id, amount: ch.amount, status: ch.status, charged_date: ch.charged_date, description: ch.description && /^on hold/i.test(ch.description) ? 'On hold' : ch.description ? 'Charge' : null, payment_method_info: card(ch.payment_method_info) };
  }

  function booking(b) {
    const u = b.user || {};
    const p = u.id ? person('customer', u.id) : { first: 'Guest', last: 'Customer' };
    const addr = b.address || {};
    const geo = jitter('customer', u.id ?? b.id, addr.latitude, addr.longitude);
    const st = u.id ? street('customer', u.id) : street('booking', b.id);
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
      active: b.active,
      completed: b.completed,
      booking_status: b.booking_status,
      service_date: b.service_date,
      arrival_window: b.arrival_window,
      duration: b.duration,
      blocked_duration: b.blocked_duration,
      created_at: b.created_at,
      created_by: b.created_by ? { id: b.created_by.id, name: 'Office staff' } : null,
      location: b.location ? { id: b.location.id, name: b.location.name } : null,
      frequency: b.frequency ? { id: b.frequency.id, interval: b.frequency.interval, name: b.frequency.name } : null,
      first_recurring: b.first_recurring,
      user: u.id ? { id: u.id, name: `${p.first} ${p.last}`, first_name: p.first, last_name: p.last, email: `customer${u.id}@example.com`, is_new_customer: u.is_new_customer } : null,
      phone: u.id ? phone('customer', u.id) : null,
      address: { full_address: `${st}, ${addr.city || ''}${addr.state ? `, ${addr.state}` : ''} ${fsa(addr.zip) || ''}`.trim(), street: st, city: addr.city ?? null, state: addr.state ?? null, zip: fsa(addr.zip), ...geo },
      services,
      summary: b.summary,
      discount_info: { frequency_amount: di.frequency_amount, discount_amount: di.discount_amount, discount_code: di.discount_code ? 'QACODE' : undefined, giftcard_amount: di.giftcard_amount },
      price_adjustment_comment: text(b.price_adjustment_comment),
      payment_method_info: card(b.payment_method_info),
      custom_fields: (b.custom_fields || []).map((f) => ({ id: f.id, title: f.title, type: f.type, values: (f.values || []).map((v) => ({ id: v.id, label: v.label, name: v.name, other: v.other ? NOTE : '' })) })),
      staff_notes: text(b.staff_notes),
      customer_notes: text(b.customer_notes),
      teams: (b.teams || []).map((t) => ({ id: t.id, title: teamName(t.id), share: t.share, hours: t.hours, earned: t.earned, bg_color: t.bg_color, fg_color: t.fg_color })),
      team_requested_id: b.team_requested_id ?? null,
      team_with_key_id: b.team_with_key_id ?? null,
      time_tracking: (b.time_tracking || []).map((x) => {
        const g = jitter('checkin', `${b.id}-${x.id}`, x.checkin_latitude, x.checkin_longitude);
        return { id: x.id, team: x.team ? { id: x.team.id, title: teamName(x.team.id) } : null, state: x.state, enroute_started_at: x.enroute_started_at, enroute_finished_at: x.enroute_finished_at, checkin_at: x.checkin_at, checkout_at: x.checkout_at, checkin_latitude: g.latitude, checkin_longitude: g.longitude, distance: x.distance };
      }),
      charges: b.charges ? { charged: (b.charges.charged || []).map(charge), onhold: (b.charges.onhold || []).map(charge), refunded: (b.charges.refunded || []).map(charge), marked_paid: (b.charges.marked_paid || []).map(charge), outstanding: b.charges.outstanding } : undefined,
      feedback: b.feedback ? { rating: b.feedback.rating, stars: b.feedback.stars, rated_at: b.feedback.rated_at, comment: b.feedback.comment ? NOTE : null } : null,
      cancellation: b.cancellation ? { fee: b.cancellation.fee, date: b.cancellation.date, reason: text(b.cancellation.reason), cancelled_by: { name: 'Office staff' } } : undefined,
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
export function sensitiveStrings({ customers = [], teams = [], bookings = [] }) {
  const out = new Set();
  const add = (v, min = 4) => {
    const s = String(v ?? '').trim();
    if (s.length >= min) out.add(s.toLowerCase());
  };
  const addPhone = (v) => {
    const d = String(v ?? '').replace(/\D/g, '');
    // The fake numbers use the 555 exchange, so a real 555 number would match by chance.
    if (d.length >= 7 && !d.slice(-7).startsWith('555')) out.add(d.slice(-7));
  };
  for (const c of customers) {
    add(c.email, 6);
    add(c.address, 6);
    addPhone(c.phone);
    if (c.first_name && c.last_name) add(`${c.first_name} ${c.last_name}`, 6);
    add(c.notes, 12);
  }
  for (const t of teams) {
    add(t.email, 6);
    add(t.address, 6);
    addPhone(t.phone);
    if (t.first_name && t.last_name) add(`${t.first_name} ${t.last_name}`, 6);
  }
  for (const b of bookings) {
    add(b.user?.email, 6);
    add(b.user?.name, 6);
    add(b.address?.street, 6);
    addPhone(b.phone);
    add(b.staff_notes, 12);
    add(b.customer_notes, 12);
    add(b.feedback?.comment, 12);
    add(b.price_adjustment_comment, 12);
  }
  for (const v of [...out]) if (isGeneratedValue(v)) out.delete(v);
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
    throw new Error(`QA copy is not anonymous: ${problems.join('; ')}${where.length ? `. Fields: ${where.join(', ')}` : ''}`);
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
