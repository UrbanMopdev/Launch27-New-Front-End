// Placement: quote, availability, holds and bookings for the Sales Hub (docs/placement.md).
// Prices use Launch27's own rules (mock/pricing.js), slots come from the scheduling planner,
// and bookings are written to Launch27 with a dedicated placement login.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { addDays, daysBetween, localDate } from '../schedule/rules.js';
import { normalizeEmail, normalizePhone } from '../inbox/normalize.js';
import {
  CONTRACT_TO_KIND, brandKey, brandSlug, bookingBody, catalogService, customFieldsFrom, frequencyMap, locationFor, priceQuote,
  questionsOf, quotableServices, staffNotesFor, suggestBrand, taxPercentFor,
} from './mapping.js';

export const CONTRACT_VERSION = '1.1.0';
const TZ = 'America/Toronto';
const QUOTE_MS = 60 * 60_000;
const HOLD_MS = 10 * 60_000;
const REF_MS = 5 * 60_000; // reference data (services, locations, questions) cache
const KEEP_DAYS = 30;
const AUDIT_DAYS = 180;
const ARRIVAL_WINDOW = 60;
const UPSTREAM_TIMEOUT_MS = 30_000;

/** An answer for the caller: HTTP status plus a contract error code. */
export class PlacementError extends Error {
  constructor(status, code, message, { retryable = false, details } = {}) {
    super(message);
    Object.assign(this, { status, code, retryable, details });
  }
}
const fail = (...a) => {
  throw new PlacementError(...a);
};

const newId = (prefix) => `${prefix}_${randomBytes(9).toString('base64url')}`;
const pad = (n) => String(n).padStart(2, '0');

// Toronto wall-clock (date + minutes after midnight) -> RFC 3339 with the right offset (DST-safe).
const OFFSET_FMT = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' });
const offsetMinutes = (ms) => {
  const m = OFFSET_FMT.formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName')?.value.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) : 0;
};
export function torontoIso(date, minutes) {
  const d = minutes >= 1440 ? addDays(date, Math.floor(minutes / 1440)) : date;
  const min = minutes % 1440;
  const wall = Date.parse(`${d}T${pad(Math.floor(min / 60))}:${pad(min % 60)}:00Z`);
  let off = offsetMinutes(wall - offsetMinutes(wall) * 60_000);
  off = offsetMinutes(wall - off * 60_000);
  const sign = off < 0 ? '-' : '+';
  return `${d}T${pad(Math.floor(min / 60))}:${pad(min % 60)}:00${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

const stable = (v) => (Array.isArray(v) ? `[${v.map(stable).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v));
const fingerprint = (body) => createHash('sha256').update(stable(body)).digest('hex');

export function createPlacement({ db, config, fetchImpl = fetch, schedule, writes = null, log = { info() {}, warn() {}, error() {} }, now = () => Date.now() }) {
  const slotKey = createHash('sha256').update(`placement-slot:${config.sessionSecret}`).digest();
  const today = () => localDate(now());
  // Bookings: in production only with PLACEMENT_BOOKING_ENABLED (separate from L27_ALLOW_WRITES,
  // which governs staff screens); elsewhere wherever writes are allowed (the synthetic Launch27).
  const bookingOn = () => (config.production ? config.placementBookingEnabled === true : !!config.allowWrites);
  const nameOf = (caller) => (typeof caller === 'string' ? caller : caller?.name || 'unknown');

  // ---------- Launch27, signed in as the placement user ----------
  let bearer = null; // { token, at }
  function credentials() {
    if (config.l27Mode === 'mock') return { email: 'placement@example.com', password: config.mockPassword || 'demo' };
    return config.l27PlacementEmail && config.l27PlacementPassword ? { email: config.l27PlacementEmail, password: config.l27PlacementPassword } : null;
  }
  async function login() {
    const creds = credentials();
    if (!creds) fail(503, 'platform_unavailable', 'Placement has no Launch27 login yet (L27_PLACEMENT_EMAIL / L27_PLACEMENT_PASSWORD).');
    let res;
    try {
      res = await fetchImpl(`${config.l27BaseUrl}/latest/login`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(creds), signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    } catch (err) {
      fail(503, 'platform_unavailable', `Could not reach Launch27: ${err.message}`, { retryable: true });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.bearer) fail(503, 'platform_unavailable', `Launch27 refused the placement login (${res.status}).`);
    bearer = { token: body.bearer, at: now() };
    return bearer.token;
  }
  const token = async () => (bearer && now() - bearer.at < 30 * 60_000 ? bearer.token : login());

  async function l27(method, path, { query, body } = {}, retried = false) {
    // Defence in depth: the only write placement ever sends is creating a booking, and only
    // while booking is on. Anything else is a bug and never reaches Launch27.
    if (method !== 'GET' && !(method === 'POST' && path === '/v1/staff/bookings' && bookingOn())) fail(403, 'forbidden', 'Placement may not change Launch27 here.');
    const u = new URL(config.l27BaseUrl + path);
    for (const [k, v] of Object.entries(query || {})) if (v != null) u.searchParams.set(k, String(v));
    let res;
    try {
      res = await fetchImpl(u.toString(), {
        method,
        headers: { authorization: `Bearer ${await token()}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof PlacementError) throw err;
      throw Object.assign(new PlacementError(503, 'platform_unavailable', `Could not reach Launch27: ${err.message}`, { retryable: true }), { network: true });
    }
    if (res.status === 401 && !retried) {
      bearer = null;
      return l27(method, path, { query, body }, true);
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, ok: res.ok, body: json, text };
  }
  async function l27Get(path, query) {
    const r = await l27('GET', path, { query });
    if (!r.ok) fail(503, 'platform_unavailable', `Launch27 ${path} answered ${r.status}.`, { retryable: true });
    return r.body;
  }

  // ---------- reference data (cached a few minutes) ----------
  const cache = new Map();
  async function cached(key, load) {
    const hit = cache.get(key);
    if (hit && now() - hit.at < REF_MS) return hit.value;
    const value = await load();
    cache.set(key, { value, at: now() });
    return value;
  }
  const locations = () => cached('locations', () => l27Get('/v1/staff/locations'));
  const services = (loc) => cached(`services:${loc}`, () => l27Get('/v1/staff/services', { location_id: loc }));
  const frequencies = (loc) => cached(`frequencies:${loc}`, () => l27Get('/v1/booking/frequencies', { location_id: loc }));
  const fields = () => cached('fields', () => l27Get('/v1/staff/booking_form/custom_fields'));
  const salesTaxes = () => cached('taxes', () => l27Get('/v1/staff/sales_taxes'));
  // Admin choices in Support settings → Brands win over the default by location name.
  const brandOverrides = () => cached('brand_overrides', async () => new Map((await db.query('SELECT location_id, brand FROM brand_locations')).rows.map((r) => [Number(r.location_id), r.brand])));
  async function brandOfFn() {
    const overrides = await brandOverrides();
    return (l) => (overrides.has(Number(l.id)) ? overrides.get(Number(l.id)) : suggestBrand(l.name));
  }

  function servedSlug(key) {
    const slug = brandSlug(key);
    if (!slug || !config.placementBrands.includes(slug)) fail(422, 'brand_not_served', `This app doesn't place customers for brand "${key}".`);
    return slug;
  }
  // The location a brand's catalog is read from: Launch27's default location if it's in the brand.
  async function homeLocation(slug) {
    const brandOf = await brandOfFn();
    const mine = (await locations()).filter((l) => l.active !== false && brandOf(l) === slug);
    if (!mine.length) fail(422, 'brand_not_served', `No Launch27 location belongs to brand ${slug}.`);
    return mine.find((l) => l.default) || mine.sort((a, b) => a.id - b.id)[0];
  }

  // ---------- health ----------
  async function health() {
    let status = 'ok';
    let message;
    try {
      await token();
      const sched = await schedule.status();
      const age = sched.taken_at ? now() - Date.parse(sched.taken_at) : Infinity;
      if (!bookingOn()) [status, message] = ['degraded', config.production ? 'Booking is turned off (PLACEMENT_BOOKING_ENABLED): quotes, availability and holds work, bookings are refused.' : 'Writes to Launch27 are turned off here: quotes and availability work, bookings are refused.'];
      else if (!sched.taken_at) [status, message] = ['degraded', 'The schedule has not loaded yet: no availability until it does.'];
      else if (age > 30 * 60_000) [status, message] = ['degraded', `The schedule is ${Math.round(age / 60_000)} minutes old.`];
    } catch (err) {
      [status, message] = ['down', err.message];
    }
    return { status, platform: 'launch27', contract_version: CONTRACT_VERSION, brands: config.placementBrands.map(brandKey), capabilities: { holds: 'local' }, checked_at: new Date(now()).toISOString(), ...(message ? { message } : {}) };
  }

  // ---------- catalog ----------
  async function catalog(key) {
    const slug = servedSlug(key);
    const loc = await homeLocation(slug);
    const svcs = quotableServices(await services(loc.id));
    return {
      brand: key,
      currency: 'CAD',
      timezone: TZ,
      services: svcs.map(catalogService),
      frequencies: [...frequencyMap(await frequencies(loc.id)).keys()],
      questions: questionsOf(await fields()),
    };
  }

  // ---------- quote ----------
  async function quote(req, caller) {
    const slug = servedSlug(req.brand);
    const loc = locationFor(await locations(), req.address.postal_code, slug, await brandOfFn());
    const no = (reason, message) => ({ brand: req.brand, serviceable: false, not_serviceable_reason: reason, message });
    if (!loc) return no('outside_service_area', 'This postal code is outside our service area.');
    const service = quotableServices(await services(loc.id)).find((s) => String(s.id) === String(req.service_code));
    if (!service) return no('service_not_offered', `That service isn't offered in ${loc.name}.`);
    const freq = frequencyMap(await frequencies(loc.id)).get(req.frequency);
    if (!freq) return no('service_not_offered', `${req.frequency.replace(/_/g, ' ')} visits aren't offered in ${loc.name}.`);
    let priced;
    try {
      priced = priceQuote({ service, request: req, frequency: freq, recurringFrequency: req.frequency === 'one_time' ? null : freq, taxPercent: taxPercentFor(await salesTaxes(), loc.id, today()) });
    } catch (err) {
      if (err.code === 'invalid_request') fail(400, 'invalid_request', err.message);
      throw err;
    }
    const id = newId('q');
    const expires = new Date(now() + QUOTE_MS);
    const data = { frequency_id: freq.id, kind: CONTRACT_TO_KIND[req.frequency], duration: priced.duration_minutes, l27_line: priced.l27_line, price: priced.price };
    await db.query('INSERT INTO placement_quotes (id, caller, brand, location_id, request, data, expires_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)', [id, nameOf(caller), slug, loc.id, JSON.stringify(req), JSON.stringify(data), expires]);
    return { brand: req.brand, serviceable: true, quote_id: id, expires_at: expires.toISOString(), service_area: loc.name, duration_minutes: priced.duration_minutes, price: priced.price };
  }

  // A quote (and its holds) belongs to the caller that made it: another caller gets "not found",
  // never a hint that it exists. A token limited to some brands can't use another brand's quote.
  async function loadQuote(id, { allowExpired = false, caller = null } = {}) {
    const q = (await db.query('SELECT * FROM placement_quotes WHERE id = $1', [String(id)])).rows[0];
    if (!q || (caller && q.caller !== nameOf(caller))) fail(404, 'quote_not_found', 'No such quote.');
    if (caller?.brands && !caller.brands.has(brandKey(q.brand))) fail(403, 'forbidden', `This token may not place customers for ${brandKey(q.brand)}.`);
    if (!allowExpired && new Date(q.expires_at).getTime() <= now()) fail(410, 'quote_expired', 'The quote expired: quote again.');
    return { ...q, location_id: Number(q.location_id), request: typeof q.request === 'string' ? JSON.parse(q.request) : q.request, data: typeof q.data === 'string' ? JSON.parse(q.data) : q.data };
  }

  // ---------- availability ----------
  async function openHolds(exceptId = null) {
    const rows = (await db.query("SELECT id, cleaner_id, to_char(day, 'YYYY-MM-DD') AS day, start_min, end_min FROM placement_holds WHERE released_at IS NULL AND used_at IS NULL AND expires_at > $1", [new Date(now())])).rows;
    return rows.filter((r) => r.id !== exceptId).map((r) => ({ cleaner_id: Number(r.cleaner_id), date: r.day, start: r.start_min, end: r.end_min }));
  }

  const sign = (payload) => createHmac('sha256', slotKey).update(payload).digest('base64url').slice(0, 22);
  function slotToken(quoteId, s) {
    const payload = Buffer.from(JSON.stringify({ q: quoteId, d: s.date, s: s.start, e: s.end, c: s.cleaner_id })).toString('base64url');
    return `${payload}.${sign(payload)}`;
  }
  function readSlotToken(tokenStr) {
    const [payload, mac] = String(tokenStr).split('.');
    const expected = payload ? sign(payload) : '';
    if (!payload || !mac || mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) fail(400, 'invalid_request', 'That slot_token was not issued by this app.');
    const t = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return { quote_id: t.q, date: t.d, start: t.s, end: t.e, cleaner_id: t.c };
  }

  const planner = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof PlacementError) throw err;
      if (err.status === 409) fail(503, 'platform_unavailable', 'The schedule has not loaded yet. Try again in a few minutes.', { retryable: true });
      throw err;
    }
  };

  function contractSlot(quoteId, s, name, notes) {
    return {
      slot_token: slotToken(quoteId, s),
      start: torontoIso(s.date, s.start),
      end: torontoIso(s.date, s.end),
      arrival_window: { start: torontoIso(s.date, s.start), end: torontoIso(s.date, s.start + ARRIVAL_WINDOW) },
      team: { id: String(s.cleaner_id), ...(name ? { name } : {}) },
      ...(notes?.length ? { notes } : {}),
    };
  }

  async function availability({ quote_id, from, to, limit = 50 }, caller = null) {
    const span = daysBetween(from, to);
    if (span < 0 || span > 31) fail(400, 'invalid_request', '"to" must be on or up to 31 days after "from".');
    const q = await loadQuote(quote_id, { caller });
    const found = await planner(() =>
      schedule.findSlots({ duration: q.data.duration, kind: q.data.kind, from, days: span + 1, limit: Math.min(Number(limit) || 50, 200), locations: [q.location_id], held: [] }),
    );
    const held = await openHolds();
    const travelNote = found.place_known ? [] : ['Travel time is estimated: the new address is not on the map yet.'];
    const slots = found.slots
      .filter((s) => s.date >= from && s.date <= to)
      .map((s) => ({ date: s.date, start: s.start, end: s.start + q.data.duration, cleaner_id: s.cleaner.id, name: s.cleaner.name, reasons: s.reasons }))
      .filter((s) => !held.some((h) => h.cleaner_id === s.cleaner_id && h.date === s.date && h.start < s.end && s.start < h.end))
      .map((s) => contractSlot(q.id, s, s.name, [...s.reasons.map((r) => r.text), ...travelNote]));
    return { quote_id: q.id, timezone: TZ, slots, generated_at: new Date(now()).toISOString() };
  }

  // ---------- holds ----------
  async function hold({ slot_token, lead_ref = null, placed_by }, caller = null) {
    const t = readSlotToken(slot_token);
    const q = await loadQuote(t.quote_id, { caller });
    if (t.date <= today()) fail(409, 'slot_unavailable', 'That slot is in the past.');
    const check = await planner(async () => schedule.checkSlot({ cleaner_id: t.cleaner_id, date: t.date, start: t.start, duration: t.end - t.start, kind: q.data.kind, held: await openHolds() }));
    if (!check.ok) fail(409, 'slot_unavailable', `That slot was taken (${check.reason}). Pick another one.`);
    const id = newId('h');
    const expires = new Date(now() + HOLD_MS);
    const slot = contractSlot(q.id, t, check.cleaner?.name);
    const taken = await db.tx(async (tx) => {
      // One hold at a time per cleaner and day (no-op on PGlite, which runs one statement at a time).
      if (db.kind === 'postgres') await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`placement:${t.cleaner_id}:${t.date}`]);
      const clash = (await tx.query('SELECT 1 FROM placement_holds WHERE cleaner_id = $1 AND day = $2 AND released_at IS NULL AND used_at IS NULL AND expires_at > $3 AND start_min < $4 AND $5 < end_min LIMIT 1', [t.cleaner_id, t.date, new Date(now()), t.end, t.start])).rows.length;
      if (clash) return true;
      await tx.query('INSERT INTO placement_holds (id, quote_id, cleaner_id, day, start_min, end_min, slot, lead_ref, placed_by, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10)', [id, q.id, t.cleaner_id, t.date, t.start, t.end, JSON.stringify(slot), lead_ref, JSON.stringify(placed_by), expires]);
      return false;
    });
    if (taken) fail(409, 'slot_unavailable', 'Someone else is holding that slot. Pick another one.');
    return { hold_id: id, slot, expires_at: expires.toISOString(), kind: 'local' };
  }

  async function release(holdId, caller = null) {
    const r = (await db.query(
      'UPDATE placement_holds h SET released_at = coalesce(h.released_at, now()) FROM placement_quotes q WHERE h.id = $1 AND q.id = h.quote_id AND ($2::text IS NULL OR q.caller = $2) RETURNING h.id',
      [String(holdId), caller ? nameOf(caller) : null],
    )).rows[0];
    if (!r) fail(404, 'hold_not_found', 'No such hold.');
  }

  // ---------- bookings ----------
  // An existing Launch27 customer: the same email, or the same phone AND last name. A phone
  // alone isn't enough (mistyped or recycled numbers would put a stranger's visit on someone
  // else's account); without a confident match a new customer is created.
  async function findCustomer(customer) {
    const email = normalizeEmail(customer.email);
    const phone = normalizePhone(customer.phone);
    const last = String(customer.last_name || '').trim().toLowerCase();
    for (const [query, match] of [
      [email, (c) => normalizeEmail(c.email) === email],
      [phone && last ? phone.slice(-10) : null, (c) => normalizePhone(c.phone) === phone && String(c.last_name || '').trim().toLowerCase() === last],
    ]) {
      if (!query) continue;
      const rows = await l27Get('/v1/staff/customers', { query, limit: 20 });
      const hit = (Array.isArray(rows) ? rows : []).find(match);
      if (hit) return Number(hit.id);
    }
    return null;
  }

  // What Launch27 said, safe to hand back: its status and a short message, nothing else.
  const launch27Says = (res) => {
    const m = res.body && typeof res.body === 'object' ? res.body.message || res.body.error || res.body.errors : null;
    const text = typeof m === 'string' ? m : m ? JSON.stringify(m) : '';
    return { launch27_status: res.status, ...(text ? { launch27_message: text.slice(0, 300) } : {}) };
  };

  // Booking, with two guarantees:
  //   - one hold books at most once: the hold is claimed atomically before Launch27 is called
  //     and only freed again when Launch27 certainly made nothing;
  //   - one Idempotency-Key books at most once: once the request has gone to Launch27, the key
  //     is never forgotten. A 4xx from Launch27 means it made nothing; anything else after
  //     sending (no answer, 5xx, an answer without an id, our own failure afterwards) leaves the
  //     key and the hold blocked as "unknown": check Launch27 before trying again.
  async function book(body, idemKey, callerIn) {
    const caller = nameOf(callerIn);
    const key = `${caller}:${idemKey}`;
    const fp = fingerprint(body);
    const seen = (await db.query('SELECT * FROM placement_bookings WHERE key = $1', [key])).rows[0];
    if (seen) {
      if (seen.fingerprint !== fp) fail(409, 'idempotency_conflict', 'That Idempotency-Key was already used with a different request.');
      if (seen.state === 'done') return { replay: true, booking: typeof seen.response === 'string' ? JSON.parse(seen.response) : seen.response };
      if (seen.state === 'pending') fail(409, 'idempotency_conflict', 'A booking with that Idempotency-Key is still in progress.', { retryable: true });
      const r = typeof seen.response === 'string' ? JSON.parse(seen.response) : seen.response;
      fail(seen.status || 502, r?.error?.code || 'platform_unavailable', r?.error?.message || 'The earlier attempt with this key did not finish.');
    }

    const { custom_fields, missing } = customFieldsFrom(await fields(), body.answers || []);
    if (missing.length) fail(400, 'invalid_request', 'Answer the required booking questions.', { details: { questions: missing } });

    const gone = () => fail(404, 'hold_not_found', 'No such hold, or it was already used or released.');
    const h = (await db.query("SELECT *, to_char(day, 'YYYY-MM-DD') AS day FROM placement_holds WHERE id = $1", [String(body.hold_id)])).rows[0];
    if (!h) gone();
    // Ownership first: another caller's hold looks exactly like one that doesn't exist.
    const q = await loadQuote(h.quote_id, { allowExpired: true, caller: typeof callerIn === 'object' ? callerIn : null }).catch((err) => {
      if (err.code === 'quote_not_found') gone();
      throw err;
    });
    if (h.used_at || h.released_at) gone();
    if (new Date(h.expires_at).getTime() <= now()) fail(410, 'hold_expired', 'The hold expired: hold the slot again.');
    const date = h.day;
    const slot = { date, start: h.start_min, end: h.end_min, cleaner_id: Number(h.cleaner_id), arrival_window: ARRIVAL_WINDOW };
    const actor = `${caller} / ${body.placed_by.kind} ${body.placed_by.id}`;

    if (!bookingOn()) {
      await writes?.record({ email: actor, source: 'placement', method: 'POST', path: '/v1/staff/bookings', body: null, outcome: 'blocked', status: 403 });
      fail(403, 'forbidden', config.production ? 'Booking through the placement API is turned off (PLACEMENT_BOOKING_ENABLED).' : `Writes to the live Launch27 are blocked in ${config.appEnv}.`);
    }

    // Claim the key and the hold together, atomically. Losing either race = someone else has it.
    const claimed = await db.tx(async (tx) => {
      const k = (await tx.query("INSERT INTO placement_bookings (key, fingerprint, hold_id, state) VALUES ($1, $2, $3, 'pending') ON CONFLICT DO NOTHING RETURNING key", [key, fp, h.id])).rows[0];
      if (!k) return 'key';
      const got = (await tx.query('UPDATE placement_holds SET used_at = now() WHERE id = $1 AND used_at IS NULL AND released_at IS NULL AND expires_at > $2 RETURNING id', [h.id, new Date(now())])).rows[0];
      if (!got) {
        await tx.query('DELETE FROM placement_bookings WHERE key = $1', [key]);
        return 'hold';
      }
      return 'ok';
    });
    if (claimed === 'key') {
      const other = (await db.query('SELECT 1 FROM placement_bookings WHERE key = $1', [key])).rows[0];
      if (other) fail(409, 'idempotency_conflict', 'A booking with that Idempotency-Key is already in progress.', { retryable: true });
      gone(); // the hold is already being booked with another key
    }
    if (claimed === 'hold') gone();

    let sent = false; // once true, the key and the hold are never freed
    const unclaim = async () => {
      await db.query('DELETE FROM placement_bookings WHERE key = $1', [key]);
      await db.query('UPDATE placement_holds SET used_at = NULL WHERE id = $1 AND booking_id IS NULL', [h.id]);
    };
    const unknown = async (status, code, message) => {
      const out = { error: { code, message, retryable: false } };
      await db.query("UPDATE placement_bookings SET state = 'unknown', status = $2, response = $3::jsonb, finished_at = now() WHERE key = $1", [key, status, JSON.stringify(out)]).catch(() => {});
      return new PlacementError(status, code, message);
    };

    try {
      const check = await planner(async () => schedule.checkSlot({ cleaner_id: slot.cleaner_id, date, start: slot.start, duration: slot.end - slot.start, kind: q.data.kind, held: await openHolds(h.id) }));
      if (!check.ok) {
        await db.query('UPDATE placement_holds SET released_at = now() WHERE id = $1', [h.id]);
        fail(409, 'slot_unavailable', `That slot was taken in Launch27 (${check.reason}). Pick another one.`);
      }
      const existing = await findCustomer(body.customer);
      const request = bookingBody({
        quote: { ...q.data, location_id: q.location_id, address: q.request.address },
        slot,
        customer: body.customer,
        existingCustomerId: existing,
        customFields: custom_fields,
        paymentMethod: config.placementPaymentMethod,
        staffNotes: staffNotesFor({ accessNotes: body.access_notes, placedBy: body.placed_by, caller, leadRef: body.lead_ref || h.lead_ref, source: body.source }),
      });

      sent = true;
      let res;
      try {
        res = await l27('POST', '/v1/staff/bookings', { body: request });
      } catch (err) {
        if (err instanceof PlacementError && !err.network && err.code === 'forbidden') {
          sent = false; // refused before leaving this app
          throw err;
        }
        await writes?.record({ email: actor, source: 'placement', method: 'POST', path: '/v1/staff/bookings', body: request, outcome: 'failed', error: err.message });
        throw await unknown(502, 'platform_unavailable', 'Launch27 did not answer, so the booking may or may not exist. Check Launch27 before trying again with a new key.');
      }
      await writes?.record({ email: actor, source: 'placement', method: 'POST', path: '/v1/staff/bookings', body: request, outcome: res.ok ? 'done' : 'refused', status: res.status, error: res.ok ? null : res.text.slice(0, 500) });
      if (res.status >= 400 && res.status < 500) {
        // Launch27 refused it: nothing was made, so the key and the hold are free again.
        sent = false;
        fail(400, 'invalid_request', `Launch27 refused the booking (${res.status}).`, { details: launch27Says(res) });
      }
      if (!res.ok || !res.body?.id) throw await unknown(502, 'platform_unavailable', `Launch27 answered ${res.status} without a booking id, so the booking may or may not exist. Check Launch27 before trying again with a new key.`);

      const bookingId = Number(res.body.id);
      // From here the booking exists: nothing below may free the key or the hold.
      await db.query('UPDATE placement_holds SET booking_id = $2 WHERE id = $1', [h.id, bookingId]).catch(() => {});
      let customerId = existing;
      if (!customerId) customerId = Number((await l27Get(`/v1/staff/bookings/${bookingId}`).catch(() => null))?.user?.id) || null;
      const booking = {
        booking_id: String(bookingId),
        customer_id: String(customerId ?? 'unknown'),
        customer_created: !existing,
        platform: 'launch27',
        brand: brandKey(q.brand),
        start: torontoIso(date, slot.start),
        end: torontoIso(date, slot.end),
        price: q.data.price.first_visit,
        status: 'confirmed',
      };
      await db.query("UPDATE placement_bookings SET state = 'done', status = 201, response = $2::jsonb, booking_id = $3, finished_at = now() WHERE key = $1", [key, JSON.stringify(booking), bookingId]);
      schedule.soon?.(await token().catch(() => null));
      log.info('placement booked', { caller, booking_id: bookingId, brand: q.brand, customer_created: !existing });
      return { replay: false, booking };
    } catch (err) {
      // Only when Launch27 certainly made nothing: free the key (and the hold) for a corrected retry.
      if (!sent) {
        const row = (await db.query('SELECT state FROM placement_bookings WHERE key = $1', [key])).rows[0];
        if (row?.state === 'pending') await unclaim();
      }
      throw err;
    }
  }

  // One row per request (src/placement/api.js): who, what, result. No customer details.
  async function audit(e) {
    await db.query(
      'INSERT INTO placement_audit (caller, ip, method, operation, path, status, code, ms, ref) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [e.caller, e.ip ? String(e.ip).slice(0, 64) : null, e.method, e.operation, e.path, e.status, e.code, Math.round(e.ms || 0), e.ref ? String(e.ref).slice(0, 80) : null],
    );
  }
  async function auditLog({ days = 7, limit = 500 } = {}) {
    const since = new Date(now() - Math.min(Math.max(days, 1), 180) * 86_400_000);
    const rows = (await db.query('SELECT id, at, caller, ip, method, operation, path, status, code, ms, ref FROM placement_audit WHERE at >= $1 ORDER BY at DESC LIMIT $2', [since, Math.min(Math.max(limit, 1), 2000)])).rows;
    return { booking: bookingOn(), callers: [...(config.placementTokens?.entries() || [])].map(([name, t]) => ({ name, actions: [...(t.actions || [])], brands: t.brands ? [...t.brands] : null })), allowed_ips: (config.placementAllowedIps || []).length, rows };
  }

  let lastPurge = 0;
  async function purge() {
    if (now() - lastPurge < 60 * 60_000) return;
    lastPurge = now();
    const cutoff = new Date(now() - KEEP_DAYS * 86_400_000);
    await db.query('DELETE FROM placement_quotes WHERE created_at < $1', [cutoff]);
    await db.query('DELETE FROM placement_bookings WHERE created_at < $1', [cutoff]);
    await db.query('DELETE FROM placement_audit WHERE at < $1', [new Date(now() - AUDIT_DAYS * 86_400_000)]);
  }

  return { health, catalog, quote, availability, hold, release, book, purge, audit, auditLog, _today: today, _addDays: addDays };
}
