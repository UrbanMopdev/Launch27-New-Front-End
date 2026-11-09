// Commercial partners (B2B2C): organizations that send UrbanMop their clients.
//
// How they show up in Launch27 (seen in the Jul 2025 – Oct 2026 bookings):
// - Ongoing homemaking partners book every client from ONE account, with a service named
//   after them: "Carefor Homemaking", "OWCS Homemaking". Each address is one client.
// - Hospital transition programs do the same, with the program in brackets:
//   "Homemaking(B@H)", "Homemaking(QCH @ Home)", "Homemaking (MFT @ Home)".
// - "Past Temporary Homemaking" is a client continuing on their own account after a program.
// - The client's name, phone and cleaner wishes are typed into the booking's staff notes.

export const PROGRAMS = {
  'B@H': { name: 'Bruyère at Home', short: 'Bruyère', org: 'Carefor' },
  'QCH @ Home': { name: 'Queensway Carleton at Home', short: 'Queensway Carleton', org: 'Queensway Carleton Hospital' },
  'MFT @ Home': { name: 'Montfort at Home', short: 'Montfort', org: 'Montfort' },
};
// Agreed with the partners: 7 visits per patient: 4 weekly, 2 every two weeks, 1 monthly.
// Days from the first visit to each visit.
export const PROGRAM_PLAN = [0, 7, 14, 21, 35, 49, 77];
export const PLAN_LABEL = ['Weekly', 'Weekly', 'Weekly', 'Weekly', 'Every 2 weeks', 'Every 2 weeks', 'Monthly'];
// Referrals agreed per program per month (to compare against).
export const EXPECTED_PER_MONTH = { 'B@H': 32, 'QCH @ Home': 32, 'MFT @ Home': null };
// A gap longer than this starts a new episode for the same address.
export const EPISODE_GAP_DAYS = 60;

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Which partner a booking belongs to, from its service names (and company name as a fallback).
// Returns null for ordinary customers.
export function partnerOf(serviceNames = [], companyName = null) {
  const s = (Array.isArray(serviceNames) ? serviceNames : [serviceNames]).join(' | ');
  const prog = s.match(/\(([^()]*@[^()]*)\)/);
  if (prog) {
    const code = prog[1].replace(/\s+/g, ' ').trim().replace(/^B ?@ ?H$/i, 'B@H').replace(/^(\w+) ?@ ?home$/i, (m, a) => `${a.toUpperCase()} @ Home`);
    const p = PROGRAMS[code];
    return { key: slug(code), kind: 'program', program: code, name: p?.name || code, org: p?.org || null };
  }
  if (/past temporary/i.test(s)) return { key: 'past-temporary', kind: 'after', program: null, name: 'After a program (Past Temporary)', org: null };
  const home = s.match(/(?:^|\|\s*)([A-Za-z][\w&' .-]*?)\s+homemaking/i);
  if (home) return { key: slug(home[1]), kind: 'homemaking', program: null, name: `${home[1].trim()} Homemaking`, org: home[1].trim() };
  const co = String(companyName || '').trim();
  if (co) return { key: `co-${slug(co)}`, kind: 'company', program: null, name: co, org: co };
  return null;
}

// Partners book many clients from one account: identify the client by its street address.
export const normStreet = (a) => String(a || '').toLowerCase().replace(/,.*$/, '').replace(/[^a-z0-9]+/g, ' ').trim();

// Stable negative id for one client of a partner account (never collides with Launch27 ids).
export function clientId(accountId, address) {
  let h = 2166136261;
  for (const ch of `${accountId}|${normStreet(address)}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return -((h % 2_000_000_000) + 1);
}

// The client's name is usually the first line of the staff notes ("Jane Doe\n613-…").
export function clientLabel(notes, address) {
  const first = String(notes || '').split(/\r?\n/)[0].replace(/\t/g, ' ').trim();
  if (first && first.length <= 40 && /^[A-Za-zÀ-ÿ' .-]+$/.test(first) && /\s/.test(first)) return first.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\B\w+/g, (w) => w.toLowerCase());
  return String(address || '').split(',')[0].trim() || 'Client';
}

// Cleaner wishes typed in the staff notes, as tag-like lines the planner already understands
// ("prefers karen", "do not assign andrew", "female cleaner only"). Notes keep the newest line
// first, so only the first "prefers" counts; every "do not assign" counts.
export function noteHints(notes) {
  const out = [];
  let prefers = false;
  for (const raw of String(notes || '').split(/\r?\n/)) {
    const line = raw.replace(/\([^)]*\)/g, '').replace(/^\s*\d{1,2}\/\d{1,2}\/\d{2,4}\s*:?\s*/, '').replace(/^client\s+/i, '').trim().toLowerCase();
    if (!line) continue;
    const no = line.match(/do\s*not\s*(?:assign|send)\s+([a-zà-ÿ' -]+)/);
    if (no) out.push(`do not assign ${no[1].trim()}`);
    else if (!prefers && /^prefers?\s+[a-zà-ÿ]/.test(line) && !/female|male/.test(line)) {
      prefers = true;
      out.push(line.replace(/^prefer\s/, 'prefers ').split(/[.,;]/)[0]);
    } else if (/female/.test(line) && /(cleaner|only|request)/.test(line)) out.push(/only/.test(line) ? 'female cleaner only' : 'prefers female cleaner');
    else if (/\bmale\b/.test(line) && /(cleaner|only|request)/.test(line)) out.push('prefers male cleaner');
  }
  return [...new Set(out)];
}

// Where one program patient is against the 4/2/1 plan. dates: every visit date of the
// episode (past and booked), sorted; today: YYYY-MM-DD.
export function planStatus(dates, today) {
  const day = (d) => Date.parse(`${d}T12:00:00Z`) / 86_400_000;
  const first = dates[0];
  const done = dates.filter((d) => d <= today);
  const booked = dates.filter((d) => d > today);
  const flags = [];
  dates.forEach((d, i) => {
    if (i === 0 || i >= PROGRAM_PLAN.length) return;
    const plannedGap = PROGRAM_PLAN[i] - PROGRAM_PLAN[i - 1];
    const gap = Math.round(day(d) - day(dates[i - 1]));
    if (Math.abs(gap - plannedGap) > 3) flags.push({ visit: i + 1, gap, planned: plannedGap, past: d <= today });
  });
  const extra = Math.max(0, dates.length - PROGRAM_PLAN.length);
  const n = dates.length;
  const nextPlanned = n < PROGRAM_PLAN.length ? new Date((day(first) + PROGRAM_PLAN[n] + (day(dates[n - 1]) - day(first) - PROGRAM_PLAN[n - 1])) * 86_400_000).toISOString().slice(0, 10) : null;
  const sinceLast = Math.round(day(today) - day(dates[n - 1]));
  let state;
  if (n >= PROGRAM_PLAN.length && !booked.length) state = 'finished';
  else if (!booked.length && sinceLast > 45) state = n >= PROGRAM_PLAN.length ? 'finished' : 'ended_early';
  else state = 'active';
  // The stage is the rhythm of the next visit: weekly until 4 are done, then every two weeks, then monthly.
  const stage = done.length < 4 ? 'weekly' : done.length < 6 ? 'biweekly' : 'monthly';
  // The next visit is due within a week (or overdue) and nothing is booked.
  const unbooked = state === 'active' && !booked.length && nextPlanned && day(nextPlanned) - day(today) <= 7;
  return { visits: n, done: done.length, booked: booked.length, state, stage, next_planned: state === 'active' ? nextPlanned : null, next_label: n < PROGRAM_PLAN.length ? PLAN_LABEL[n] : null, flags, extra, unbooked };
}

// Once an account is known to be a partner or program account (from any of its bookings),
// every booking on it belongs to that partner, matched to the client by address. Programs
// book later visits as separate one-time bookings, sometimes under another service name or
// without the client's name in the notes; without this they showed as the account itself.
// Also lends a client's name to visits at the same address that only had the address.
export function harmonizePartners(visits) {
  const isPartner = (v) => v.partner_kind === 'homemaking' || v.partner_kind === 'program';
  const street = (a) => String(a || '').split(',')[0].trim();
  const byAccount = new Map(); // account -> Map(fieldsJSON -> count)
  const names = new Map(); // client id -> name (not just the address)
  for (const v of visits) {
    if (v.account_id == null || !isPartner(v)) continue;
    const f = JSON.stringify({ partner: v.partner, partner_name: v.partner_name, partner_kind: v.partner_kind, program: v.program });
    const m = byAccount.get(v.account_id) || new Map();
    m.set(f, (m.get(f) || 0) + 1);
    byAccount.set(v.account_id, m);
    if (v.customer_id < 0 && v.customer && v.customer !== street(v.addr)) names.set(v.customer_id, v.customer);
  }
  if (!byAccount.size) return visits;
  return visits.map((v) => {
    const m = v.account_id != null ? byAccount.get(v.account_id) : null;
    if (!m) return v;
    if (isPartner(v)) {
      const better = names.get(v.customer_id);
      return better && v.customer !== better ? { ...v, customer: better } : v;
    }
    const fields = JSON.parse([...m.entries()].sort((a, b) => b[1] - a[1])[0][0]);
    const id = clientId(v.account_id, v.addr || '');
    return { ...v, ...fields, customer_id: id, customer: names.get(id) || street(v.addr) || v.customer };
  });
}
