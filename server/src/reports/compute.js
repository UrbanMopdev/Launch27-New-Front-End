// Scheduling and cleaner reports: pure calculations over a year of slimmed visits.
import { clientId, clientLabel, partnerOf } from '../commercial/partners.js';
import { addDays, areaOf, daysBetween, frequencyKind, localDate, localMinutes, mondayOf, weekday } from '../schedule/rules.js';
import { EARLY_MIN, HOMEMAKING_GRACE_MIN, LATE_GRACE_MIN } from './raise-config.js';

const MIN = 60_000;
export const PERIODS = { '4w': 28, '13w': 91, '12m': 365 };
const DAYNAME = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const FREQ = { weekly: 'Weekly', bi: 'Biweekly', monthly: 'Monthly', tri: 'Every 3 weeks', one: 'One-time' };
const clock = (min) => {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h >= 12 ? 'pm' : 'am'}`;
};
export const cleanName = (title) => String(title || '').replace(/^\s*(on\s*hold\s*)?(\s*\([^)]*\))*\s*/i, '').trim() || String(title || '');
const pct = (a, b) => (b ? a / b : null);
const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// Merge Launch27's three lists for one booking into one record.
// booking: /v1/staff/bookings row; tt: /v1/staff/bookings/time_tracking row; fb: feedback.
export function slimReportVisit(booking, tt, fb) {
  const b = booking || tt;
  const teams = (b.teams || []).map((t) => {
    const ttTeam = tt?.teams?.find((x) => x.id === t.id);
    const tr = ttTeam?.time_tracking || (b.time_tracking || []).find((x) => x.team?.id === t.id) || null;
    return {
      id: Number(t.id),
      name: cleanName(t.title),
      hours: Number(t.hours) || 0,
      earned: ttTeam?.earned != null ? Number(ttTeam.earned) : t.earned != null ? Number(t.earned) : null,
      // Pay rate on this visit ($/h, Launch27 "share").
      rate: t.share != null && t.share !== '' ? Number(t.share) : null,
      enroute: tr?.enroute_started_at || null,
      checkin: tr?.checkin_at || null,
      checkout: tr?.checkout_at || null,
      distance: tr?.distance != null ? Number(tr.distance) : null,
    };
  });
  const feedback = fb?.feedback || b.feedback || null;
  return {
    id: b.id,
    date: localDate(b.service_date),
    at: Date.parse(b.service_date),
    start: localMinutes(b.service_date),
    window: Number(b.arrival_window) || 60,
    duration: Number(b.duration) || Number(tt?.estimated_duration) || Math.round((teams[0]?.hours || 3) * 60),
    ...(() => {
      // Partners book every client from one account: each address is its own client.
      const services = ((booking || b).services || []).map((x) => x.name).filter(Boolean);
      const partner = partnerOf(services, b.user?.company_name);
      const perAddress = partner && (partner.kind === 'homemaking' || partner.kind === 'program');
      const street = (booking || b).address?.street || (booking || b).address?.full_address || '';
      return {
        customer_id: perAddress && b.user?.id != null ? clientId(b.user.id, street) : b.user?.id ?? null,
        account_id: b.user?.id ?? null,
        customer: perAddress ? clientLabel((booking || b).staff_notes, street) : b.user?.name || [b.user?.first_name, b.user?.last_name].filter(Boolean).join(' ') || 'Customer',
        partner: partner?.key || null,
        partner_name: partner?.name || null,
        partner_kind: partner?.kind || null,
        program: partner?.program || null,
        addr: street || null,
        freq: (booking || b).frequency?.name || null,
      };
    })(),
    location_id: Number(b.location?.id ?? b.location_id ?? booking?.location?.id) || null,
    location_name: b.location?.name ?? booking?.location?.name ?? null,
    kind: frequencyKind(booking?.frequency?.name),
    lat: b.address?.latitude ?? null,
    lng: b.address?.longitude ?? null,
    revenue: Number(b.summary?.revenue ?? b.summary?.total) || 0,
    teams,
    rating: feedback ? { r: Number(feedback.rating), comment: feedback.comment || null, at: feedback.rated_at || null } : null,
  };
}

// Homemaking (Carefor, OWCS, Bruyère): fixed-time 2-hour visits, measured differently.
export const isHomemaking = (v) => v.partner_kind === 'homemaking';
// Residential: not homemaking, not a hospital program, not at a Commercial location.
export const isResidential = (v) => v.partner_kind !== 'homemaking' && v.partner_kind !== 'program' && !/commercial|cornwall/i.test(v.location_name || '');

// Per visit and cleaner: on time, minutes late, ran long, finished early, on-site minutes.
// Residential on time = checked in by the end of the arrival window + 5 min; homemaking =
// by the start time + 10 min. Finished early = on site 30+ min less than booked, on a
// residential visit with one cleaner (split team jobs and homemaking are left out).
export function timing(v, t) {
  if (!t.checkin) return null;
  const home = isHomemaking(v);
  const due = home ? v.at + HOMEMAKING_GRACE_MIN * MIN : v.at + v.window * MIN + LATE_GRACE_MIN * MIN;
  const ci = Date.parse(t.checkin);
  const late = ci > due ? Math.round((ci - (home ? v.at : v.at + v.window * MIN)) / MIN) : 0;
  const booked = t.hours ? t.hours * 60 : v.duration / Math.max(v.teams.length, 1);
  const onsite = t.checkout ? (Date.parse(t.checkout) - ci) / MIN : null;
  const earlyEligible = isResidential(v) && v.teams.length === 1 && onsite != null;
  return {
    onTime: !late, late, onsite,
    long: onsite != null && booked > 30 ? onsite > booked * 1.15 : false,
    early: earlyEligible ? booked - onsite > EARLY_MIN : null,
    enroute: !!t.enroute, distance: t.distance,
  };
}

// Index: customers' assigned visits in time order (for "main cleaner" as of any date).
export function indexVisits(visits) {
  const byCustomer = new Map();
  for (const v of [...visits].sort((a, b) => a.at - b.at)) {
    if (v.customer_id == null || !v.teams.length) continue;
    if (!byCustomer.has(v.customer_id)) byCustomer.set(v.customer_id, []);
    byCustomer.get(v.customer_id).push(v);
  }
  return byCustomer;
}
// The client's main cleaner before a moment: most of their previous 6 assigned visits.
export function mainBefore(list, at) {
  const prev = [];
  for (let i = list.length - 1; i >= 0 && prev.length < 6; i--) if (list[i].at < at) prev.push(list[i]);
  if (!prev.length) return null;
  const counts = new Map();
  for (const v of prev) for (const t of v.teams) counts.set(t.id, (counts.get(t.id) || 0) + 1);
  let best = null;
  for (const [id, n] of counts) if (!best || n > best.n) best = { id, n };
  return best?.id ?? null;
}

const inRange = (v, from, to) => v.date >= from && v.date <= to;
export function periodRange(today, period) {
  const days = PERIODS[period] || PERIODS['13w'];
  return { from: addDays(today, -days), to: addDays(today, -1), days };
}

// Same-cleaner share for recurring visits in a range (and week by week).
export function sameCleaner(visits, byCustomer, from, to) {
  let n = 0;
  let same = 0;
  const weeks = new Map();
  for (const v of visits) {
    if (!inRange(v, from, to) || v.kind === 'one' || !v.teams.length || v.customer_id == null) continue;
    const main = mainBefore(byCustomer.get(v.customer_id) || [], v.at);
    if (main == null) continue;
    const hit = v.teams.some((t) => t.id === main);
    n++;
    if (hit) same++;
    const wk = mondayOf(v.date);
    const w = weeks.get(wk) || { n: 0, same: 0 };
    w.n++;
    if (hit) w.same++;
    weeks.set(wk, w);
  }
  return { share: pct(same, n), visits: n, series: [...weeks.entries()].sort().map(([week, w]) => ({ week, share: pct(w.same, w.n), visits: w.n })) };
}

// Cleaner-level stats over a range.
export function cleanerStats(visits, byCustomer, from, to, today) {
  const map = new Map();
  const get = (id, name) => {
    if (!map.has(id)) map.set(id, emptyStats(id, name));
    return map.get(id);
  };
  const recentFrom = addDays(today, -28);
  for (const v of visits) {
    if (!inRange(v, from, to)) continue;
    for (const t of v.teams) {
      const s = get(t.id, t.name);
      s.visits++;
      s.bookedMin += t.hours ? t.hours * 60 : v.duration / Math.max(v.teams.length, 1);
      s.revenue += v.revenue / v.teams.length;
      if (t.earned != null) {
        s.earned += t.earned;
        s.earnedKnown = true;
      }
      if (!isHomemaking(v) && t.earned != null) {
        s.marginRev += v.revenue / v.teams.length;
        s.marginPay += t.earned;
      }
      const tm = timing(v, t);
      if (!tm && v.date < today) s.missing.push({ date: v.date, customer: v.customer, kind: 'missing_checkin', visit_id: v.id });
      if (tm) {
        s.tracked++;
        if (tm.onTime) s.onTime++;
        else {
          s.lateMin.push(tm.late);
          s.lateList.push({ date: v.date, customer: v.customer, late: tm.late, visit_id: v.id });
        }
        if (tm.onsite == null && v.date < today) s.missing.push({ date: v.date, customer: v.customer, kind: 'missing_checkout', visit_id: v.id });
        if (tm.early != null) {
          s.residential++;
          if (tm.early) {
            s.early++;
            s.earlyList.push({ date: v.date, customer: v.customer, short_min: Math.round((t.hours ? t.hours * 60 : v.duration) - tm.onsite), visit_id: v.id });
          }
        }
        if (tm.long) s.long++;
        if (tm.enroute) s.enroute++;
        if (tm.onsite != null) s.onsiteMin += tm.onsite;
        if (tm.distance != null) s.km.push(tm.distance);
      }
      if (v.rating) {
        s.rated++;
        if (v.rating.r === 2) s.happy++;
        if (v.rating.r === 0) {
          s.unhappy++;
          if (v.date >= recentFrom) s.unhappyRecent++;
        }
      }
    }
  }
  // Last 40 tracked visits per cleaner (any time), for punctuality and flags.
  const sorted = [...visits].sort((a, b) => b.at - a.at);
  for (const v of sorted) {
    if (v.date > to) continue;
    for (const t of v.teams) {
      const s = map.get(t.id);
      if (!s || s.last40.length >= 40) continue;
      const tm = timing(v, t);
      if (tm) s.last40.push({ date: v.date, late: tm.late, long: tm.long, early: !!tm.early, enroute: tm.enroute, customer: v.customer });
    }
  }
  // Keeps clients: clients whose main cleaner was them at the start; still them at the end.
  const startAt = Date.parse(`${from}T00:00:00Z`);
  const endAt = Date.parse(`${to}T23:59:59Z`);
  for (const [cid, list] of byCustomer) {
    if (!list.some((v) => v.kind !== 'one')) continue;
    // Homemaking clients are placed by the partner, not kept by the cleaner.
    if (list.every(isHomemaking)) continue;
    const a = mainBefore(list, startAt);
    if (a == null) continue;
    const s = map.get(a);
    if (!s) continue;
    const recent = list.some((v) => v.at >= endAt - 60 * 86_400_000 && v.at <= endAt);
    const b = recent ? mainBefore(list, endAt) : null;
    s.started = (s.started || 0) + 1;
    if (b === a) s.kept = (s.kept || 0) + 1;
    else (s.lost ||= []).push({ customer_id: cid, customer: list.at(-1).customer, to: b, stopped: !recent });
  }
  return map;
}

const emptyStats = (id, name) => ({ id, name, visits: 0, onsiteMin: 0, bookedMin: 0, tracked: 0, onTime: 0, lateMin: [], lateList: [], long: 0, early: 0, earlyList: [], residential: 0, missing: [], enroute: 0, km: [], rated: 0, happy: 0, unhappy: 0, unhappyRecent: 0, revenue: 0, earned: 0, earnedKnown: false, marginRev: 0, marginPay: 0, last40: [] });
export { emptyStats };

// The team's "runs long" picture from everyone's last 40 visits: the median share and the
// top-quartile line. Runs long is relative: if everyone runs long, booked times are too short.
export function teamLong(stats, minVisits = 10) {
  const shares = [...stats.values()].map((s) => s.last40 || []).filter((l) => l.length >= minVisits).map((l) => l.filter((x) => x.long).length / l.length).sort((a, b) => a - b);
  if (!shares.length) return { median: null, p75: null, n: 0 };
  const q = (p) => shares[Math.min(shares.length - 1, Math.floor(p * shares.length))];
  return { median: q(0.5), p75: q(0.75), n: shares.length };
}

export function flagsFor(s, util, team = null) {
  const flags = [];
  const l40 = s.last40 || [];
  if (s.unhappyRecent >= 2) flags.push({ kind: 'ratings', label: 'Ratings slipping', detail: `${s.unhappyRecent} unhappy ratings in the last 4 weeks` });
  if (l40.length >= 10) {
    const late = l40.filter((x) => x.late);
    if (late.length / l40.length > 0.15) flags.push({ kind: 'late', label: 'Often late', detail: `Late on ${late.length} of the last ${l40.length} visits, ${Math.round(late.reduce((a, x) => a + x.late, 0) / late.length)} min on average` });
    // Runs long: only well above the team (top quartile and 25%+ of visits). For raises it's
    // neutral-to-positive (thorough); it's a booking-length question first.
    const long = l40.filter((x) => x.long).length;
    const share = long / l40.length;
    const teamMed = team?.median;
    if (share >= 0.25 && (team?.p75 == null || share >= team.p75) && (teamMed == null || share > teamMed)) {
      flags.push({ kind: 'long', label: 'Runs long vs the team', detail: `${long} of the last ${l40.length} cleans ran 15%+ over booked time${teamMed != null ? ` (team: ${Math.round(teamMed * 100)}%)` : ''}` });
    }
    // Finishing early on residential jobs is the quality risk.
    const eligible = l40.filter((x) => x.early != null);
    const early = l40.filter((x) => x.early).length;
    if (eligible.length >= 10 && early / eligible.length > 0.2) flags.push({ kind: 'early', label: 'Finishes early', detail: `${early} of the last ${eligible.length} residential cleans finished 30+ min under booked time` });
  }
  if (util && util.capacity >= 8 && util.booked / util.capacity < 0.5) flags.push({ kind: 'underbooked', label: 'Under-booked', detail: `Booked ${Math.round(util.booked)} of ${Math.round(util.capacity)} available hours a week` });
  if ((s.started || 0) >= 5 && (s.kept || 0) / s.started < 0.6) flags.push({ kind: 'losing', label: 'Losing clients', detail: `Kept ${s.kept || 0} of ${s.started} regular clients this period` });
  return flags;
}

export function cleanerRow(s, extra = {}) {
  return {
    id: s.id,
    name: extra.name || s.name,
    visits: s.visits,
    on_time: pct(s.onTime, s.tracked),
    late_avg: s.lateMin.length ? Math.round(s.lateMin.reduce((a, b) => a + b, 0) / s.lateMin.length) : null,
    ran_long: pct(s.long, s.tracked),
    finished_early: pct(s.early, s.residential),
    early_n: s.early,
    residential: s.residential,
    missing_checks: s.missing.length,
    margin: s.marginRev ? Math.round(((s.marginRev - s.marginPay) / s.marginRev) * 1000) / 1000 : null,
    enroute: pct(s.enroute, s.tracked),
    km_per_visit: s.km.length ? round1(s.km.reduce((a, b) => a + b, 0) / s.km.length) : null,
    rated: s.rated,
    happy: pct(s.happy, s.rated),
    unhappy: s.unhappy,
    keeps: s.started ? pct(s.kept || 0, s.started) : null,
    clients_started: s.started || 0,
    revenue: Math.round(s.revenue),
    earned: s.earnedKnown ? Math.round(s.earned) : null,
    onsite_hours: round1(s.onsiteMin / 60),
    booked_hours: round1(s.bookedMin / 60),
  };
}

// A cleaner's regular clients: they are the client's main cleaner today.
export function regularClients(cleanerId, byCustomer, nowAt) {
  const out = [];
  for (const [cid, list] of byCustomer) {
    if (mainBefore(list, nowAt) !== cleanerId) continue;
    const withThem = list.filter((v) => v.teams.some((t) => t.id === cleanerId));
    const last = list.at(-1);
    const lastRated = [...withThem].reverse().find((v) => v.rating);
    out.push({
      customer_id: cid,
      customer: last.customer,
      rhythm: `${FREQ[last.kind]} · ${DAYNAME[weekday(last.date)]} ${clock(last.start)}`,
      since: withThem[0]?.date || null,
      cleans: withThem.length,
      last_rating: lastRated ? { r: lastRated.rating.r, comment: lastRated.rating.comment, date: lastRated.date } : null,
    });
  }
  return out.sort((a, b) => b.cleans - a.cleans);
}

export function weeklySeries(visits, cleanerId, from, to) {
  const weeks = new Map();
  for (let w = mondayOf(from); w <= to; w = addDays(w, 7)) weeks.set(w, { week: w, visits: 0, tracked: 0, onTime: 0, rated: 0, happy: 0 });
  for (const v of visits) {
    if (!inRange(v, from, to)) continue;
    const t = v.teams.find((x) => x.id === cleanerId);
    if (!t) continue;
    const w = weeks.get(mondayOf(v.date));
    if (!w) continue;
    w.visits++;
    const tm = timing(v, t);
    if (tm) {
      w.tracked++;
      if (tm.onTime) w.onTime++;
    }
    if (v.rating) {
      w.rated++;
      if (v.rating.r === 2) w.happy++;
    }
  }
  return [...weeks.values()].map((w) => ({ week: w.week, visits: w.visits, on_time: pct(w.onTime, w.tracked), happy: pct(w.happy, w.rated) }));
}

export function outsideArea(v, cleaner) {
  if (!cleaner || cleaner.lat == null || v.lat == null) return null;
  return areaOf({ lat: v.lat, lng: v.lng }) !== cleaner.area;
}
export { daysBetween, median, pct, round1 };
