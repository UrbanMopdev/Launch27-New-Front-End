// Scheduling planner: pure rules. Cleaners, the 4-week cycle, availability, travel, and
// how a cleaner is ranked for a visit or a whole recurring series.

const TZ = 'America/Toronto';
const DAY = 86_400_000;
const pad = (n) => String(n).padStart(2, '0');

// ---------- dates ----------
const DATE_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const TIME_FMT = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
export const localDate = (iso) => DATE_FMT.format(new Date(iso));
export function localMinutes(iso) {
  const [h, m] = TIME_FMT.format(new Date(iso)).split(':').map(Number);
  return (h % 24) * 60 + m;
}
export const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY);
export const weekday = (d) => new Date(`${d}T12:00:00Z`).getUTCDay(); // 0 = Sunday
export const mondayOf = (d) => addDays(d, -((weekday(d) + 6) % 7));
export const hhmm = (min) => `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`;
// "09:00", "9:00:00", "9:00 AM", "5pm", "17:30" -> minutes since midnight.
export const toMinutes = (s) => {
  const m = String(s ?? '').trim().match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*([ap])?\.?\s*m?\.?$/i);
  if (!m) {
    const [h, mm] = String(s || '0:0').split(':').map(Number);
    return (h || 0) * 60 + (mm || 0);
  }
  let h = Number(m[1]) % 24;
  const ap = m[3]?.toLowerCase();
  if (ap === 'p' && h < 12) h += 12;
  if (ap === 'a' && h === 12) h = 0;
  return h * 60 + Number(m[2] || 0);
};

// ---------- the 4-week cycle ----------
// Week A is the week of the anchor Monday; weeks repeat A, B, C, D.
export const CYCLE_ANCHOR = '2026-11-02';
export const CYCLE = ['A', 'B', 'C', 'D'];
export function cycleWeek(d, anchor = CYCLE_ANCHOR) {
  const n = Math.floor(daysBetween(anchor, mondayOf(d)) / 7);
  return CYCLE[((n % 4) + 4) % 4];
}
export function frequencyKind(name) {
  const n = String(name || '').toLowerCase();
  if (/one\s*-?\s*time/.test(n)) return 'one';
  if (/tri\s*-?\s*weekly/.test(n)) return 'tri';
  if (/bi\s*-?\s*weekly/.test(n)) return 'bi';
  if (/weekly/.test(n)) return 'weekly';
  if (/month/.test(n)) return 'monthly';
  return 'one';
}
export const isPrepaid = (name) => /prepaid/i.test(String(name || ''));
export const FREQ_LABEL = { weekly: 'Weekly', bi: 'Biweekly', monthly: 'Monthly', tri: 'Every 3 weeks', one: 'One-time' };
export const FREQ_DAYS = { weekly: 7, bi: 14, tri: 21, monthly: 28, one: 0 };
// Which cycle weeks a series occupies, given one of its dates.
export function cycleWeeks(kind, d) {
  const w = cycleWeek(d);
  const i = CYCLE.indexOf(w);
  if (kind === 'weekly') return 'ABCD';
  if (kind === 'bi') return [CYCLE[i], CYCLE[(i + 2) % 4]].sort().join('');
  return w; // monthly, one-time and every-3-weeks sit on the week they fall in
}

// ---------- cleaners ----------
// Title codes (UrbanMop convention): (1) active, (2) new hire OK to work, (3) not ready,
// (X) off schedule, "ON HOLD" in front = not taking bookings, (F)/(M), (FT)/(PT).
export const STATUS_LABEL = { active: 'Active', new: 'New hire', not_ready: 'Not ready', off_schedule: 'Off schedule', on_hold: 'On hold', no_code: 'No code' };
export function parseCleaner(t) {
  const title = String(t.title || '');
  const codes = [...title.matchAll(/\(([^)]*)\)/g)].map((m) => m[1].trim().toUpperCase());
  const onHold = /on\s*hold/i.test(title);
  const level = codes.find((c) => /^[123]$/.test(c)) || null;
  const tags = (t.tags_info || []).map((g) => String(g.name || '').trim()).filter(Boolean);
  const lc = tags.map((x) => x.toLowerCase());
  const has = (re) => lc.some((x) => re.test(x));
  const status = onHold ? 'on_hold' : codes.includes('X') ? 'off_schedule' : level === '1' ? 'active' : level === '2' ? 'new' : level === '3' ? 'not_ready' : 'no_code';
  const name = title.replace(/^\s*(on\s*hold\s*)?(\s*\([^)]*\))*\s*/i, '').trim() || [t.first_name, t.last_name].filter(Boolean).join(' ') || `Cleaner ${t.id}`;
  const maxTravel = lc.map((x) => x.match(/max(?:imum)?\s*(?:of\s*)?(\d+)\s*min/)).find(Boolean);
  const transit = has(/public\s*trans/) && !has(/^vehicle$|company vehicle/);
  return {
    id: Number(t.id),
    name,
    title,
    status,
    // Launch27 locations the cleaner works in (decides their brand).
    location_ids: (t.locations || []).map((l) => Number(l.id)).filter(Boolean),
    assignable: status === 'active' || status === 'new',
    isNew: status === 'new',
    gender: codes.includes('F') || has(/^female$/) ? 'F' : codes.includes('M') || has(/^male$/) ? 'M' : null,
    hoursType: codes.includes('FT') ? 'FT' : codes.includes('PT') ? 'PT' : null,
    color: t.bg_color || '#94A3B8',
    phone: t.phone || null,
    lat: Number.isFinite(Number(t.latitude)) && t.latitude !== null ? Number(t.latitude) : null,
    lng: Number.isFinite(Number(t.longitude)) && t.longitude !== null ? Number(t.longitude) : null,
    tags,
    rules: {
      transit,
      maxTravelMin: maxTravel ? Number(maxTravel[1]) : null,
      lastMinute: has(/last\s*minute/),
      noShort: has(/no\s*2\s*-?\s*hour/),
      confirmFirst: has(/without (the )?cleaner'?s confirmation/),
      afraidOfDogs: has(/afraid of dogs/),
      french: has(/french/),
      deepClean: has(/deep clean/),
      moveOut: has(/move in\s*\/\s*out cleaner/) && !has(/^no move/),
      recurringBest: has(/recurring/),
      doNotPair: lc.map((x) => x.match(/do not pair with\s+(.+)/)).filter(Boolean).map((m) => m[1].trim()),
    },
  };
}

// What a customer's tags say about cleaners.
export function customerPrefs(tags = []) {
  const names = tags.map((t) => String(t?.name ?? t ?? '').trim()).filter(Boolean);
  const lc = names.map((x) => x.toLowerCase());
  const prefers = [];
  const avoid = [];
  for (const x of lc) {
    const no = x.match(/do\s*not\s*assign\s+(.+)/);
    if (no) {
      avoid.push(no[1].replace(/[^a-zÀ-ɏ' -]/gi, '').trim());
      continue;
    }
    const p = x.match(/^#?\s*prefer(?:s|red)?\s+(.+)/);
    if (p && !/female|male|consistent|same/.test(p[1])) prefers.push(p[1].replace(/[^a-zÀ-ɏ' -]/gi, '').trim());
  }
  return {
    femaleOnly: lc.some((x) => /female/.test(x) && /only/.test(x)),
    prefersFemale: lc.some((x) => /female/.test(x)),
    prefersMale: lc.some((x) => /\bmale\b/.test(x) && !/female/.test(x)),
    consistent: lc.some((x) => /consistent|same cleaner/.test(x)),
    prefers,
    avoid,
  };
}
const firstWord = (s) => String(s || '').toLowerCase().split(/\s+/)[0] || '';
export const nameMatches = (cleanerName, wanted) => {
  const w = String(wanted || '').toLowerCase().trim();
  if (!w) return false;
  const n = String(cleanerName || '').toLowerCase();
  return n === w || firstWord(n) === firstWord(w) || n.includes(w);
};

// ---------- availability ----------
// Launch27 rows: weekly (date null, weekday 0-6) and date-specific overrides; plus dates the
// office marked unavailable in this app.
// A date row only overrides the weekly hours when it says something: a day off, or its own times
// (Launch27 can return a row for a date with neither). A day can have several blocks (8–12 and
// 1–5): the window runs from the first start to the last end.
const hasTimes = (r) => r.start_time && r.end_time && toMinutes(r.end_time) > toMinutes(r.start_time);
function dayRows(rows, d) {
  const dated = rows.filter((r) => r.date && String(r.date).slice(0, 10) === d && (r.dayoff || hasTimes(r)));
  if (dated.length) return dated;
  return rows.filter((r) => !r.date && Number(r.weekday) === weekday(d));
}
export function workingWindow(rows = [], d, unavailableDates = null) {
  if (unavailableDates?.has(d)) return null;
  const list = dayRows(rows, d);
  if (list.some((r) => r.dayoff && !hasTimes(r)) && !list.some((r) => !r.dayoff && hasTimes(r))) return null;
  const open = list.filter((r) => !r.dayoff && hasTimes(r));
  if (!open.length) return null;
  return [Math.min(...open.map((r) => toMinutes(r.start_time))), Math.max(...open.map((r) => toMinutes(r.end_time)))];
}
// Minutes a cleaner is open on a date: the sum of that day's blocks (a split day counts its gap as closed).
export function workingMinutes(rows = [], d, unavailableDates = null) {
  if (!workingWindow(rows, d, unavailableDates)) return 0;
  return dayRows(rows, d).filter((r) => !r.dayoff && hasTimes(r)).reduce((m, r) => m + toMinutes(r.end_time) - toMinutes(r.start_time), 0);
}
export function weeklyHours(rows = []) {
  let min = 0;
  for (let w = 0; w < 7; w++) {
    for (const row of rows.filter((r) => !r.date && Number(r.weekday) === w)) {
      if (!row.dayoff && hasTimes(row)) min += toMinutes(row.end_time) - toMinutes(row.start_time);
    }
  }
  return min / 60;
}

// ---------- travel ----------
export function km(a, b) {
  if (!a || !b || a.lat == null || b.lat == null || a.lng == null || b.lng == null) return null;
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
// Rough city drive (or transit) minutes; unknown distance counts as 20 minutes.
export function travelMinutes(distanceKm, transit = false) {
  if (distanceKm == null) return 20;
  return Math.round(transit ? 10 + distanceKm * 4 : 6 + distanceKm * 2);
}
// Area from the home base, relative to downtown Ottawa.
const CENTRE = { lat: 45.4215, lng: -75.6972 };
export function areaOf(p) {
  const d = km(p, CENTRE);
  if (d == null) return 'Unknown';
  if (d < 5) return 'Central';
  const dy = p.lat - CENTRE.lat;
  const dx = (p.lng - CENTRE.lng) * Math.cos((CENTRE.lat * Math.PI) / 180);
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'East' : 'West';
  return dy > 0 ? 'North' : 'South';
}

// ---------- fitting a visit into a cleaner's day ----------
// busy: that cleaner's visits that day [{ start, end, lat, lng, key }]
export function fitsDay({ window, busy = [], start, duration, place, transit = false, ignoreKeys = null }) {
  if (!window) return { ok: false, reason: 'not working' };
  if (start < window[0] || start + duration > window[1]) return { ok: false, reason: 'outside hours' };
  let travel = null;
  for (const v of busy) {
    if (ignoreKeys?.has(v.key)) continue;
    const t = travelMinutes(km(v, place), transit);
    if (v.end <= start) {
      if (v.end + t > start) return { ok: false, reason: 'not enough time to get there' };
      travel = travel == null ? t : Math.min(travel, t);
    } else if (v.start >= start + duration) {
      if (start + duration + t > v.start) return { ok: false, reason: 'not enough time for the next visit' };
    } else return { ok: false, reason: 'already booked' };
  }
  return { ok: true, travel };
}

// Open stretches of a day (at least `min` minutes) after bookings.
export function openGaps(window, busy = [], min = 120) {
  if (!window) return [];
  const sorted = [...busy].sort((a, b) => a.start - b.start);
  const gaps = [];
  let t = window[0];
  for (const v of sorted) {
    if (v.start - t >= min) gaps.push([t, v.start]);
    t = Math.max(t, v.end);
  }
  if (window[1] - t >= min) gaps.push([t, window[1]]);
  return gaps;
}

// ---------- ranking ----------
// job: { dates: [YYYY-MM-DD], start, duration, place: {lat,lng}, customerId, kind, services: [names],
//        prefs (customerPrefs), mainCleanerId, history: Map(cleanerId -> visits), firstDate }
// ctx: { windowFor(cleaner, date), busyFor(cleanerId, date), weekLoad(cleanerId, date) -> { booked, capacity }, today }
export function rankCleaners(job, cleaners, ctx, { limit = 5, ignoreKeys = null } = {}) {
  const out = [];
  for (const c of cleaners) {
    if (!c.assignable) continue;
    if (job.prefs?.avoid?.some((n) => nameMatches(c.name, n))) continue;
    if (job.prefs?.femaleOnly && c.gender !== 'F') continue;
    if (c.rules.noShort && job.duration <= 120) continue;
    const homeKm = km(c, job.place);
    if (c.rules.maxTravelMin && travelMinutes(homeKm, c.rules.transit) > c.rules.maxTravelMin) continue;
    let fits = 0;
    let travelSum = 0;
    let travelN = 0;
    const misses = {};
    for (const d of job.dates) {
      const f = fitsDay({ window: ctx.windowFor(c, d), busy: ctx.busyFor(c.id, d), start: job.start, duration: job.duration, place: job.place, transit: c.rules.transit, ignoreKeys });
      if (f.ok) {
        fits++;
        const t = f.travel ?? travelMinutes(homeKm, c.rules.transit);
        travelSum += t;
        travelN++;
      } else misses[f.reason] = (misses[f.reason] || 0) + 1;
    }
    if (!fits) continue;
    const reasons = [];
    let score = 0;
    const seen = job.history?.get(c.id) || 0;
    if (job.mainCleanerId === c.id) {
      score += 60;
      reasons.push({ text: 'Usual cleaner', tone: 'good' });
    } else if (seen) {
      score += Math.min(seen * 5, 25);
      reasons.push({ text: `Cleaned here ${seen} time${seen === 1 ? '' : 's'} before`, tone: 'good' });
    } else reasons.push({ text: 'New to this client', tone: 'neutral' });
    if (job.prefs?.prefers?.some((n) => nameMatches(c.name, n))) {
      score += 40;
      reasons.push({ text: 'Client asked for them', tone: 'good' });
    }
    const ratio = fits / job.dates.length;
    score += ratio * 30;
    if (ratio === 1) reasons.push({ text: job.dates.length > 1 ? `Free all ${job.dates.length} dates` : 'Free then', tone: 'good' });
    else reasons.push({ text: `Free ${fits} of ${job.dates.length} dates`, tone: 'warn' });
    const travel = travelN ? Math.round(travelSum / travelN) : null;
    if (travel != null) {
      score += Math.max(0, 20 - travel / 2);
      reasons.push({ text: `About ${travel} min away`, tone: travel <= 15 ? 'good' : travel <= 30 ? 'neutral' : 'warn' });
    }
    const load = ctx.weekLoad?.(c.id, job.dates[0]);
    if (load && load.capacity > 0) {
      const util = load.booked / load.capacity;
      score += Math.max(0, 1 - util) * 10;
      if (util < 0.5) reasons.push({ text: 'Has lots of room', tone: 'good' });
      else if (util > 0.9) reasons.push({ text: 'Nearly full that week', tone: 'warn' });
    }
    if (job.prefs?.prefersFemale && c.gender === 'F') {
      score += 10;
      reasons.push({ text: 'Female cleaner, as the client prefers', tone: 'good' });
    } else if (job.prefs?.prefersMale && c.gender === 'M') score += 10;
    const svc = (job.services || []).join(' ').toLowerCase();
    if (/deep/.test(svc) && c.rules.deepClean) {
      score += 8;
      reasons.push({ text: 'Deep-clean specialist', tone: 'good' });
    }
    if (/move/.test(svc) && c.rules.moveOut) {
      score += 8;
      reasons.push({ text: 'Move in/out specialist', tone: 'good' });
    }
    if (job.kind !== 'one' && c.rules.recurringBest) score += 5;
    if (ctx.today && job.firstDate && daysBetween(ctx.today, job.firstDate) <= 1 && c.rules.lastMinute) {
      score += 10;
      reasons.push({ text: 'Takes last-minute bookings', tone: 'good' });
    }
    if (c.isNew) reasons.push({ text: 'New hire', tone: 'neutral' });
    if (c.rules.confirmFirst) reasons.push({ text: 'Call or text to confirm first', tone: 'warn' });
    out.push({ cleaner_id: c.id, name: c.name, color: c.color, status: c.status, score: Math.round(Math.min(score / 160, 1) * 100) / 100, fits, total: job.dates.length, travel, reasons, misses });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

// The client's main cleaner: who did most of their last 6 assigned visits.
export function mainCleaner(pastVisits) {
  const assigned = pastVisits.filter((v) => v.team_ids?.length).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
  const counts = new Map();
  for (const v of assigned) for (const id of v.team_ids) counts.set(id, (counts.get(id) || 0) + 1);
  let best = null;
  for (const [id, n] of counts) if (!best || n > best.n) best = { id, n };
  return best ? { id: best.id, visits: best.n, of: assigned.length } : null;
}

// Dates of a series from `from` for `weeks` weeks.
export function seriesDates(kind, firstDate, until) {
  const step = FREQ_DAYS[kind];
  if (!step) return [firstDate];
  const out = [];
  for (let d = firstDate; d <= until; d = addDays(d, step)) out.push(d);
  return out;
}
