// Raise readiness on cleaner reports: the acceptance checks from the spec.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { slimReportVisit, timing, indexVisits, cleanerStats, cleanerRow, flagsFor, teamLong } from '../src/reports/compute.js';
import { classifyDrop, ladderOf, raiseReview, rateHistory, reliability, reliabilityWeeks, restrictiveTags, slackSummary, torontoInstant } from '../src/reports/raise.js';
import { RAISE_THRESHOLDS } from '../src/reports/raise-config.js';
import { createReports } from '../src/reports/service.js';
import { createSchedule } from '../src/schedule/service.js';
import { createMockLaunch27 } from '../src/mock/launch27.js';
import { openDb } from '../src/db/index.js';
import { loadConfig } from '../src/config.js';

const quiet = { info() {}, warn() {}, error() {} };
let nextId = 1;
// A visit at 9am Toronto. teams: [[id, onsiteMin]]; checkinAfter: minutes after the start.
function V(date, cust, teams, { service = 'Standard Cleaning', checkinAfter = 20, duration = 180, rating = null, rate = 22, company = null } = {}) {
  const start = Date.parse(`${date}T14:00:00Z`);
  const checkin = new Date(start + checkinAfter * 60_000).toISOString();
  const booking = { id: nextId++, service_date: `${date}T14:00:00Z`, arrival_window: 60, duration, frequency: { name: 'Biweekly' }, services: [{ name: service }], user: { id: cust, name: `Client ${cust}`, company_name: company }, summary: { revenue: 200 }, teams: teams.map(([id]) => ({ id, title: `(1)(F)Cleaner ${id}`, hours: duration / 60 / teams.length, share: rate })) };
  const tt = { id: booking.id, teams: teams.map(([id, onsite]) => ({ id, earned: 66, time_tracking: { checkin_at: checkin, checkout_at: onsite == null ? null : new Date(Date.parse(checkin) + onsite * 60_000).toISOString() } })) };
  const fb = rating == null ? null : { feedback: { rating, comment: 'x', rated_at: checkin } };
  return slimReportVisit(booking, tt, fb);
}

const drop = (visitAt, droppedAt, reason, extra = {}) => ({ visit_at: visitAt, dropped_at: droppedAt, dropped_on: droppedAt.slice(0, 10), visit_date: visitAt.slice(0, 10), reason, customer: 'Client', ...extra });

// A strong 13-week record; tests change one thing at a time.
const base = (over = {}) => ({
  today: '2026-11-12',
  start_date: '2025-06-01', start_known: true,
  visits: 60, rated: 16, happy: 0.94, stars: 4.7, stars_count: 40, rated_share: 0.16,
  on_time: 0.97, tracked: 58,
  reliability: reliability({ from: '2026-08-13', to: '2026-11-12' }),
  residential: 50, early_share: 0.04,
  complaints: 0,
  keeps: 0.95, clients_started: 12,
  hours_per_week: 32,
  restrictive: [],
  google_reviews: 0,
  rate: 22,
  ladder: null,
  ...over,
});

describe('raise: drops and reliability', () => {
  test('10 h before the start is a last-minute cancellation; 48 h a short-notice drop', () => {
    assert.equal(classifyDrop({ visit_at: '2026-11-10T14:00:00Z', dropped_at: '2026-11-10T04:00:00Z', reason: 'cleaner_personal' }).kind, 'last_minute');
    assert.equal(classifyDrop({ visit_at: '2026-11-10T14:00:00Z', dropped_at: '2026-11-08T14:00:00Z', reason: 'cleaner_personal' }).kind, 'short_notice');
    assert.equal(classifyDrop({ visit_at: '2026-11-10T14:00:00Z', dropped_at: '2026-11-05T14:00:00Z', reason: 'cleaner_personal' }).kind, 'notice');
    assert.equal(classifyDrop({ visit_at: '2026-11-10T14:00:00Z', dropped_at: '2026-11-10T15:00:00Z', reason: 'cleaner_no_show' }).kind, 'no_show');
  });

  test('only cleaner-initiated codes count against the cleaner', () => {
    const r = reliability({
      from: '2026-08-13', to: '2026-11-12',
      drops: [
        drop('2026-11-03T14:00:00Z', '2026-11-03T08:00:00Z', 'client_cancelled'),
        drop('2026-11-04T14:00:00Z', '2026-11-04T08:00:00Z', 'office_reschedule'),
        drop('2026-11-05T14:00:00Z', '2026-11-05T08:00:00Z', 'weather'),
        drop('2026-11-06T14:00:00Z', '2026-11-06T08:00:00Z', null),
        drop('2026-11-07T14:00:00Z', '2026-11-07T08:00:00Z', 'cleaner_personal'),
      ],
    });
    assert.equal(r.last_minute, 1);
    assert.equal(r.uncoded, 1);
    assert.equal(r.issues, 1);
  });

  test('a one-off sick day with notice is forgiven; a pattern is not', () => {
    const one = reliability({ from: '2026-08-13', to: '2026-11-12', drops: [drop('2026-11-05T14:00:00Z', '2026-11-04T14:00:00Z', 'cleaner_sick')] });
    assert.equal(one.short_notice, 0);
    assert.equal(one.sick_days, 1);
    assert.equal(one.pattern, null);
    const three = reliability({
      from: '2026-08-13', to: '2026-11-12',
      drops: [
        drop('2026-11-03T14:00:00Z', '2026-10-31T14:00:00Z', 'cleaner_sick'),
        drop('2026-11-05T14:00:00Z', '2026-11-01T14:00:00Z', 'cleaner_personal'),
        drop('2026-11-11T14:00:00Z', '2026-11-07T14:00:00Z', 'cleaner_personal'),
      ],
    });
    assert.match(three.pattern, /3 cleaner-initiated drops/);
    const review = raiseReview(base({ reliability: three }));
    assert.equal(review.factors.find((f) => f.key === 'short_notice').grade, 'not_yet');
  });

  test('counts before Oct 31, 2026 show "—" (null), not zero', () => {
    const before = reliability({ from: '2026-07-01', to: '2026-10-20' });
    assert.equal(before.no_shows, null);
    assert.equal(before.last_minute, null);
    const after = reliability({ from: '2026-08-13', to: '2026-11-12' });
    assert.equal(after.no_shows, 0);
    assert.equal(after.partial, true);
    assert.equal(after.covers_from, '2026-10-31');
    const weeks = reliabilityWeeks(after, '2026-08-13', '2026-11-12');
    assert.equal(weeks[0].drops, null);
    assert.equal(weeks.at(-1).drops, 0);
  });

  test('a drop logged before Oct 31 is not counted', () => {
    const r = reliability({ from: '2026-08-13', to: '2026-11-12', drops: [drop('2026-10-20T14:00:00Z', '2026-10-20T10:00:00Z', 'cleaner_no_show')] });
    assert.equal(r.no_shows, 0);
  });
});

describe('raise: timing rules', () => {
  test('homemaking on time = start + 10 min; residential = window + 5 min', () => {
    const home = V('2026-10-05', 1, [[7, 120]], { service: 'Carefor Homemaking', checkinAfter: 15, duration: 120 });
    assert.equal(home.partner_kind, 'homemaking');
    assert.equal(timing(home, home.teams[0]).onTime, false);
    const homeOk = V('2026-10-05', 1, [[7, 120]], { service: 'Carefor Homemaking', checkinAfter: 9, duration: 120 });
    assert.equal(timing(homeOk, homeOk.teams[0]).onTime, true);
    const res = V('2026-10-05', 2, [[7, 180]], { checkinAfter: 64 });
    assert.equal(timing(res, res.teams[0]).onTime, true);
    const resLate = V('2026-10-05', 2, [[7, 180]], { checkinAfter: 66 });
    assert.equal(timing(resLate, resLate.teams[0]).onTime, false);
  });

  test('finished early excludes homemaking and split team jobs', () => {
    const early = V('2026-10-05', 1, [[7, 120]]); // 60 min under 3 h
    const home = V('2026-10-06', 2, [[7, 60]], { service: 'Carefor Homemaking', duration: 120 });
    const split = V('2026-10-07', 3, [[7, 30], [8, 30]]);
    const fine = V('2026-10-08', 4, [[7, 170]]);
    const company = V('2026-10-09', 5, [[7, 100]], { company: 'Smith Property Group' });
    assert.equal(timing(early, early.teams[0]).early, true);
    assert.equal(timing(home, home.teams[0]).early, null);
    assert.equal(timing(split, split.teams[0]).early, null);
    assert.equal(timing(fine, fine.teams[0]).early, false);
    assert.equal(timing(company, company.teams[0]).early, true, 'a company-named client is still residential');
    const visits = [early, home, split, fine, company];
    const st = cleanerStats(visits, indexVisits(visits), '2026-10-01', '2026-10-31', '2026-11-12').get(7);
    assert.equal(st.residential, 3);
    assert.equal(st.early, 2);
    assert.equal(cleanerRow(st).finished_early, 2 / 3);
  });

  test('missing check-outs are counted', () => {
    const v = V('2026-10-05', 1, [[7, null]]);
    const st = cleanerStats([v], indexVisits([v]), '2026-10-01', '2026-10-31', '2026-11-12').get(7);
    assert.deepEqual(st.missing.map((m) => m.kind), ['missing_checkout']);
  });

  test('"runs long" is relative to the team', () => {
    const mk = (n) => ({ last40: Array.from({ length: 40 }, (_, i) => ({ late: 0, long: i < n * 40, early: false })), unhappyRecent: 0 });
    const stats = new Map([[1, mk(0.5)], [2, mk(0.55)], [3, mk(0.6)], [4, mk(0.9)]]);
    const team = teamLong(stats);
    assert.equal(flagsFor(stats.get(1), null, team).some((f) => f.kind === 'long'), false, 'everyone runs long: not a flag');
    assert.equal(flagsFor(stats.get(4), null, team).some((f) => f.kind === 'long'), true);
  });
});

describe('raise: verdict', () => {
  test('Ready: hand calculation', () => {
    const r = raiseReview(base());
    // tenure, rating, on time, no-shows, last-minute, short-notice, early, complaints, keeps, hours, assignability = 11 ready
    // (rating doesn't count while < 20% of visits are rated): 10 ≥ 7, none Not yet.
    assert.equal(r.ready_count, 10);
    assert.equal(r.verdict, 'ready');
    assert.equal(r.re_review, null);
  });

  test('Watch: hand calculation', () => {
    const r = raiseReview(base({ start_date: '2026-07-01', happy: 0.85, stars: 4.4, hours_per_week: 22, on_time: 0.9, keeps: 0.8 }));
    // Watch: tenure (4 mo), rating, on time, keeps, hours → ready: 6 (no-shows, last-min, short-notice, early, complaints, assignability) < 7.
    assert.equal(r.factors.filter((f) => f.grade === 'not_yet').length, 0);
    assert.equal(r.verdict, 'watch');
    assert.equal(r.re_review, '2027-01-11');
  });

  test('Not yet: hand calculation (3+ Not yet factors)', () => {
    const r = raiseReview(base({ start_date: '2026-09-01', on_time: 0.8, restrictive: restrictiveTags(['Afraid of dogs', 'Maximum of 30 mins travel', 'No 2-HOUR Booking', 'Do not pair with Jean', 'No weekends']) }));
    assert.deepEqual(r.factors.filter((f) => f.grade === 'not_yet').map((f) => f.key).sort(), ['assignability', 'on_time', 'tenure']);
    assert.equal(r.verdict, 'not_yet');
    assert.equal(r.re_review, '2027-02-10');
    assert.ok(r.to_ready.length >= 3);
  });

  test('one no-show forces Not yet even with 100% Happy', () => {
    const rel = reliability({ from: '2026-08-13', to: '2026-11-12', drops: [drop('2026-11-05T14:00:00Z', '2026-11-05T15:00:00Z', 'cleaner_no_show')] });
    const r = raiseReview(base({ happy: 1, rated: 30, rated_share: 0.5, reliability: rel }));
    assert.equal(r.verdict, 'not_yet');
    assert.deepEqual(r.gates, ['1 no-show']);
  });

  test('two last-minute cancellations force Not yet', () => {
    const rel = reliability({ from: '2026-08-13', to: '2026-11-12', drops: [drop('2026-11-05T14:00:00Z', '2026-11-05T08:00:00Z', 'cleaner_personal'), drop('2026-11-07T14:00:00Z', '2026-11-07T08:00:00Z', 'cleaner_personal')] });
    assert.equal(raiseReview(base({ reliability: rel })).verdict, 'not_yet');
  });

  test('thin data shows "—"', () => {
    const r = raiseReview(base({ visits: 15 }));
    assert.equal(r.verdict, 'thin');
    assert.equal(r.label, '—');
    assert.equal(raiseReview(base({ rated: 8 })).verdict, 'thin');
  });

  test('at the $25 ceiling shows "At ceiling"; an employee shows their ladder role', () => {
    const ceil = raiseReview(base({ rate: 25 }));
    assert.equal(ceil.verdict, 'ceiling');
    assert.equal(ceil.label, 'At ceiling');
    const emp = raiseReview(base({ ladder: ladderOf(['Employee', 'Flex']) }));
    assert.equal(emp.verdict, 'ladder');
    assert.equal(emp.label, 'Flex');
    assert.equal(emp.ladder.next, 'Team Lead');
    assert.deepEqual(ladderOf(['Employee']), { role: 'Regular', next: 'Flex' });
    assert.equal(ladderOf(['Vehicle']), null);
  });

  test('the rating factor says which system it used', () => {
    const r = raiseReview(base({ happy: 0.82, rated: 17, stars: 4.07, stars_count: 28 }));
    const f = r.factors.find((x) => x.key === 'rating');
    assert.equal(f.uses, 'happy');
    assert.equal(f.grade, 'watch');
    const s = raiseReview(base({ happy: 0.7, stars: 4.8, stars_count: 45 })).factors.find((x) => x.key === 'rating');
    assert.equal(s.uses, 'stars');
    assert.equal(s.grade, 'ready');
  });

  test('Google reviews are a bonus, never a fail', () => {
    assert.equal(raiseReview(base({ google_reviews: 0 })).factors.find((f) => f.key === 'google').grade, 'neutral');
    assert.equal(raiseReview(base({ google_reviews: 2 })).factors.find((f) => f.key === 'google').grade, 'ready');
  });

  test('thresholds come from one config object', () => {
    assert.equal(RAISE_THRESHOLDS.ceilingRate, 25);
    const strict = { ...RAISE_THRESHOLDS, readyFactorsNeeded: 12 };
    assert.equal(raiseReview(base(), strict).verdict, 'watch');
  });

  test('Slack summary is clean plain text', () => {
    const review = raiseReview(base({ start_date: '2026-09-10', on_time: 0.8, happy: 0.82, rated: 17, hours_per_week: 21, restrictive: restrictiveTags(['Afraid of dogs', 'Maximum of 30 mins travel', 'No 2-HOUR Booking', 'Do not pair with Jean', 'No weekends']) }));
    const text = slackSummary({ name: 'Jane Doe', review, rate: { current: 22, since: '2026-08-04', previous: null }, from: '2026-08-13', to: '2026-11-12' });
    const lines = text.split('\n');
    assert.ok(lines.length >= 3 && lines.length <= 4);
    assert.match(lines[0], /^Raise review: Jane Doe: Not yet/);
    assert.match(lines[1], /\$22\.00\/h/);
    assert.doesNotMatch(text, /[<>*_`]/);
  });
});

describe('raise: pay rate and helpers', () => {
  test('last raise date and previous rate from per-visit rates', () => {
    const pts = [['2026-05-01', 22], ['2026-06-01', 22], ['2026-07-01', 23], ['2026-07-15', 22], ['2026-08-04', 23], ['2026-08-18', 23], ['2026-09-01', 23]].map(([date, rate]) => ({ date, rate }));
    assert.deepEqual(rateHistory(pts), { current: 23, since: '2026-08-04', previous: 22, changed_on: '2026-08-04', first_seen: '2026-05-01' });
    assert.equal(rateHistory([{ date: '2026-05-01', rate: 21 }, { date: '2026-06-01', rate: 21 }]).previous, null);
  });
  test('Toronto wall-clock to an instant (DST aware)', () => {
    assert.equal(new Date(torontoInstant('2026-07-01', 9 * 60)).toISOString(), '2026-07-01T13:00:00.000Z');
    assert.equal(new Date(torontoInstant('2026-12-01', 9 * 60)).toISOString(), '2026-12-01T14:00:00.000Z');
  });
  test('restrictive tags', () => {
    const hits = restrictiveTags(['Own Equipment', 'Vehicle', 'Afraid of dogs', 'Maximum of 45 mins travel time to a booking', 'No 2-HOUR Booking', "Do not assign new booking without cleaner's confirmation via call or text"]);
    assert.deepEqual(hits.map((h) => h.kind), ['Pet fears / allergies', 'Drive radius', 'No 2-hour jobs', 'Address bans']);
  });
});

describe('raise: service on the sample Launch27', () => {
  test('raise verdicts and pay are admin-only; drops and reviews feed the report', async () => {
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const fetchImpl = createMockLaunch27({ password: 'demo' });
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet });
    const reports = createReports({ db, config, fetchImpl, schedule, log: quiet, now: () => Date.parse('2026-11-12T17:00:00Z') });
    await schedule.sync();
    await reports.sync();
    const agent = await reports.cleaners('4w', { admin: false });
    assert.ok(agent.rows.every((r) => r.raise === undefined && r.margin === undefined));
    assert.ok(agent.rows.every((r) => typeof r.reliability.issues === 'number'));
    const admin = await reports.cleaners('4w', { admin: true });
    assert.ok(admin.rows.every((r) => r.raise && ['ready', 'watch', 'not_yet', 'thin', 'ceiling', 'ladder'].includes(r.raise.verdict)));
    assert.equal(admin.raise_window.to, '2026-11-12');
    const someone = admin.rows.find((r) => r.visits >= 20);

    // A no-show logged from Dispatch forces Not yet on the panel.
    await reports.recordDrop({ cleaner_id: someone.id, visit_key: '999001', booking_id: 999001, customer: 'Test client', visit_at: '2026-11-11T14:00:00Z', reason: 'cleaner_no_show' }, null);
    await reports.addReview(someone.id, { review_date: '2026-11-01', reviewer: 'A. Client', link: 'https://g.co/x' }, null);
    await assert.rejects(() => reports.addReview(someone.id, { review_date: '', reviewer: 'x' }, null), /date/);
    const one = await reports.cleaner(someone.id, '13w', { admin: true });
    assert.equal(one.reliability.no_shows, 1);
    assert.equal(one.raise.verdict === 'not_yet' || ['ceiling', 'ladder', 'thin'].includes(one.raise.verdict), true);
    assert.equal(one.raise.underlying, 'not_yet');
    assert.equal(one.google_reviews.length, 1);
    assert.ok(one.raise.rate && one.raise.rate.current > 0);
    assert.equal(typeof one.raise.summary, 'string');
    const notAdmin = await reports.cleaner(someone.id, '13w', { admin: false });
    assert.equal(notAdmin.raise, undefined);
    assert.equal(notAdmin.stats.margin, undefined);

    // Synthetic data: a raise in August, a cleaner at the ceiling, an employee on the ladder.
    const all = await Promise.all(admin.rows.map((r) => reports.cleaner(r.id, '13w', { admin: true })));
    assert.ok(all.some((c) => c.raise.rate?.previous != null && c.raise.rate.changed_on >= '2026-08-01'));
    assert.ok(all.some((c) => c.raise.verdict === 'ceiling'));
    await assert.rejects(() => reports.recordDrop({ cleaner_id: someone.id, visit_key: 'x', visit_at: '2026-11-11T14:00:00Z', reason: 'because' }, null), /reason/);
  });
});
