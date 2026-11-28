// Complaint Resolution Engine, Phase 1. This repo is public: every name below is made up,
// written in the same formats as the real finance-channel posts.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseRefundPost, reasonKind } from '../src/complaints/slackRefunds.js';
import { classifyRules, mergeClassification, hardRouteFor, causeRules, causeFacts, causeFits, CAUSES, CAUSE_FITS, CAUSE_GROUPS } from '../src/complaints/taxonomy.js';
import { redact } from '../src/complaints/redact.js';
import { outcomeAt, journeyAt, recleanCost, recleanVisitCost, cleanerRateIndex, cleanerLastWorkedIndex, regularCleaner, planValue } from '../src/complaints/journey.js';
import { normalizeSettings, canApprove, rungForRefund, budgetStatus, DEFAULT_SETTINGS } from '../src/complaints/settings.js';
import { clientHints, systemNotice, isSystemSender } from '../src/complaints/hints.js';
import { buildPlaybook, monthRead } from '../src/complaints/playbook.js';
import { formatThread, offerToResolution, normalizeSolution } from '../src/complaints/solutions.js';
import { caseRows, rankResponses, threatOf, valueTier } from '../src/complaints/rank.js';
import { parseTakeout, matchCase, nameKey } from '../src/complaints/reviews.js';
import { mapStatus, toCase, discover, createKustomerClient, findListing } from '../src/complaints/sources/kustomer.js';
import { createComplaints, buildReviewStats } from '../src/complaints/service.js';
import { createReports } from '../src/reports/service.js';
import { createSchedule } from '../src/schedule/service.js';
import { createMockLaunch27 } from '../src/mock/launch27.js';
import { openDb } from '../src/db/index.js';
import { loadConfig } from '../src/config.js';

const quiet = { info() {}, warn() {}, error() {} };
const ts = (iso) => String(Date.parse(iso) / 1000);

describe('complaints: Slack refund posts', () => {
  test('percent first, with amount and service date', () => {
    const p = parseRefundPost({ text: '<@U0X|Vincent> please process 40% ($203.71) refund for Tessa Moreau, service date August 7th due to dissatisfaction of the service. Once done, send here the screenshot', ts: ts('2026-08-25T19:11:00Z'), user_name: 'Jose' });
    assert.equal(p.kind, 'complaint');
    assert.equal(p.client_name, 'Tessa Moreau');
    assert.equal(p.pct, 40);
    assert.equal(p.amount, 203.71);
    assert.equal(p.service_date, '2026-08-07');
    assert.equal(p.decided_by, 'Jose');
    assert.equal(p.approved_by, null, 'a request is not an approval');
  });
  test('"Refunded X for 50% -252.17" (no dollar sign) and review mention', () => {
    const p = parseRefundPost({ text: 'Refunded Dana Pike for 50% -252.17 for the negative experience, threatened us for negative Google Review. Updated the booking', ts: ts('2025-05-05T17:47:00Z'), user_name: 'Jose' });
    assert.equal(p.client_name, 'Dana Pike');
    assert.equal(p.pct, 50);
    assert.equal(p.amount, 252.17);
    assert.equal(p.review_related, true);
    assert.equal(p.kind, 'complaint');
    assert.equal(p.approved_by, 'Jose');
  });
  test('full refund, amount on its own line', () => {
    const p = parseRefundPost({ text: 'Hi <@U0X|Vincent>, Please process a full refund for client *Rosa Lind* for the booking below:\n\n*Booking Date/Time:* July 25, 2026, 11:00 AM – 12:00 PM\n*Refund Amount:* $158.65', ts: ts('2026-07-29T18:04:00Z'), user_name: 'Bashar Hamdan' });
    assert.equal(p.client_name, 'Rosa Lind');
    assert.equal(p.pct, 100);
    assert.equal(p.amount, 158.65);
    assert.equal(p.service_date, '2026-07-25');
  });
  test('damage with the cleaner charged half', () => {
    const p = parseRefundPost({ text: 'Update: Refunded Gail Moss for $197.75 for the repair of the sculpture. Deducted the half amount ($98.88) to Amy.', ts: ts('2025-05-19T16:53:00Z'), user_name: 'Jose' });
    assert.equal(p.kind, 'damage');
    assert.equal(p.amount, 197.75);
    assert.equal(p.cleaner_recovery, 98.88);
  });
  test('damage reimbursement with "deduct 50%" is not a 50% refund', () => {
    const p = parseRefundPost({ text: "I'd like to request for $250 reimbursement to be paid to the client's etransfer x@example.com This would be the agreed reimbursement amount for the damaged TV. I've already sent pay adjustment for Sam to deduct 50% of the amount. Client's name is Mira Oakes", ts: ts('2025-11-25T15:24:00Z'), user_name: 'Jose' });
    assert.equal(p.kind, 'damage');
    assert.equal(p.amount, 250);
    assert.equal(p.pct, null);
    assert.equal(p.cleaner_recovery, 125);
  });
  test('cancellations, payment adjustments and questions are not complaints', () => {
    assert.equal(parseRefundPost({ text: 'can you please process a full refund of *$401.04* for Vera Tull for her cancelled booking July 3,2026', ts: ts('2026-07-13T14:35:00Z') }).kind, 'cancellation');
    assert.equal(reasonKind('This is the difference of the amount she paid via affirm vs service amount'), 'billing_adjustment');
    assert.equal(parseRefundPost({ text: 'Hi Jose, could you kindly confirm if the refund for Ian Wu of $49.32 was due to unsatisfactory experience?', ts: ts('2026-01-14T14:31:00Z') }).kind, 'question');
    assert.equal(parseRefundPost({ text: '<@U0X|Vincent> has joined the channel', ts: ts('2026-01-14T14:31:00Z') }), null);
  });
  test('new channel style: approvals by Derek or the GM, partner profiles flagged', () => {
    const a = parseRefundPost({ text: 'Hi, <@U0X|Vincent>. Good afternoon! Please process a partial refund of $140 for *Lena Ortiz’s* November 10 appointment. This refund has been approved by <@U0D|Derek Chiu>. Thank you!', ts: ts('2026-11-12T19:15:00Z'), user_name: 'Grace' });
    assert.equal(a.client_name, 'Lena Ortiz');
    assert.equal(a.amount, 140);
    assert.equal(a.service_date, '2026-11-10');
    assert.equal(a.approved_by, 'Derek Chiu');
    assert.equal(a.decided_by, 'Grace');
    const b = parseRefundPost({ text: 'Please process the *$45.57* refund for Nora Dale’s appointment on November 13. She is Jon Mott’s partner, and they were dissatisfied with the appointment on October 23, which was under Jon’s profile. The refund was approved by the GM as a gesture of goodwill.', ts: ts('2026-11-11T19:10:00Z'), user_name: 'Grace' });
    assert.equal(b.approved_by, 'Jose (GM)');
    assert.equal(b.service_date, '2026-11-13', 'upcoming appointment, same year');
    assert.equal(b.other_profile, true);
    assert.equal(b.kind, 'complaint');
  });
  test('no year written: most recent such date before the post', () => {
    const p = parseRefundPost({ text: 'Fyi 20% refund for Hanna Bell due to unsatisfied with the service | Nov 13 service', ts: ts('2025-01-10T22:41:00Z'), user_name: 'Jose' });
    assert.equal(p.service_date, '2024-11-13');
    assert.equal(p.pct, 20);
  });
});

describe('complaints: taxonomy and hard routes', () => {
  test('quality complaint with areas and tone', () => {
    const c = classifyRules('Really disappointed. The kitchen counters were still dirty and the baseboards were skipped. I will be leaving a review.');
    assert.equal(c.category, 'quality_missed');
    assert.deepEqual(c.areas.sort(), ['baseboards', 'kitchen']);
    assert.equal(c.tone, 'threat_review');
    assert.equal(c.hard_route, null);
  });
  test('hard routes', () => {
    assert.equal(classifyRules('The cleaner broke my TV, it cost $800 to replace').hard_route, 'damage_over_100');
    assert.equal(classifyRules('A small chip on a mug, maybe $10').hard_route, null);
    assert.equal(classifyRules('My ring went missing after the clean').hard_route, 'theft_missing');
    assert.equal(classifyRules('I will be filing a chargeback with my credit card company').hard_route, 'legal_chargeback');
    assert.equal(hardRouteFor({ category: 'quality_missed', text: 'she brought her kids into my home' }), 'misconduct');
  });
  test("a model can't take a case off a hard route", () => {
    const rules = classifyRules('I am calling my lawyer about this');
    const merged = mergeClassification(rules, { category: 'communication', tone: 'angry', severity: 2, areas: [], hard_route: null, summary: 'x', is_complaint: true, confidence: 0.9 });
    assert.equal(merged.hard_route, 'legal_chargeback');
    assert.equal(merged.severity, 4);
    assert.equal(merged.classified_by, 'claude');
  });
});

describe('complaints: redaction before Claude', () => {
  test('names, contacts, addresses and postal codes are removed', () => {
    const out = redact('Hi Sarah,\nThis is Paul Kemp at 123 Bank St, Ottawa K1P 5N2. Call me at (613) 555-0199 or paul@example.com. Maria missed the bathroom.\nThanks,\nPaul', { names: ['Paul Kemp', 'Maria Lopez'] });
    for (const leaked of ['Paul', 'Kemp', 'Maria', '123 Bank', 'K1P', '555-0199', 'paul@example.com']) assert.ok(!out.includes(leaked), `${leaked} leaked: ${out}`);
    assert.match(out, /missed the bathroom/);
  });
});

describe('complaints: outcomes and journey', () => {
  const DAY = 86_400_000;
  const at0 = Date.parse('2026-03-01T15:00:00Z');
  const V = (offsetDays, extra = {}) => ({ id: offsetDays + 1000, at: at0 + offsetDays * DAY, date: new Date(at0 + offsetDays * DAY).toISOString().slice(0, 10), revenue: 180, freq: 'Biweekly', teams: [{ id: 7, name: 'Cleaner 7', hours: 3, earned: 66 }], ...extra });
  const today = at0 + 200 * DAY;
  test('still booking 60+ days after, and not gone within 90 = saved', () => {
    const list = [V(-14), V(0), V(14), V(28), V(42), V(56), V(70), V(84), V(98), V(112)];
    assert.equal(outcomeAt(list, at0 + DAY, 60, { today: at0 + 115 * DAY }).outcome, 'saved');
    assert.equal(outcomeAt(list, at0 + DAY, 30, { today: at0 + 115 * DAY }).outcome, 'pending', 'the 30-day check is never a verdict');
    // Booked past day 60 and still coming: saved as soon as day 60 has a visit past it.
    assert.equal(outcomeAt([V(0), V(14), V(28), V(42), V(56), V(70)], at0 + DAY, 60, { today: at0 + 75 * DAY }).outcome, 'saved');
  });
  test('a client who left within 90 days is lost, review or no review; there is no partial save', () => {
    assert.equal(outcomeAt([V(-14), V(0), V(14)], at0 + DAY, 60, { today }).outcome, 'lost', 'stopped within 60 days');
    const leftAt70 = outcomeAt([V(0), V(14), V(28), V(42), V(56), V(70)], at0 + DAY, 60, { today });
    assert.equal(leftAt70.outcome, 'lost', 'was booking at day 60, gone by day 90: lost, not a partial save');
    assert.equal(leftAt70.public_review_stars, null, 'left without a bad review: the flag is kept beside the outcome');
    assert.equal(outcomeAt([V(0), V(14), V(28), V(42), V(56), V(70), V(84), V(98)], at0 + DAY, 60, { today }).outcome, 'saved', 'left after day 90: the complaint did not lose them');
    assert.ok(![30, 60, 90].some((d) => outcomeAt([V(0), V(14), V(70)], at0 + DAY, d, { today }).outcome === 'partial_save'));
  });
  test('negative public review = lost even if still booking', () => {
    const o = outcomeAt([V(0), V(80), V(190)], at0 + DAY, 60, { today, negativeReview: { stars: 1, platform: 'google' } });
    assert.deepEqual([o.outcome, o.public_review_stars], ['lost', 1]);
  });
  test('too recent to tell = pending; gone for a full normal gap = lost already', () => {
    assert.equal(outcomeAt([V(0), V(14), V(28)], at0 + DAY, 60, { today: at0 + 40 * DAY }).outcome, 'pending', 'last visit 12 days ago');
    assert.equal(outcomeAt([V(0), V(14)], at0 + DAY, 60, { today: at0 + 40 * DAY }).outcome, 'lost', 'nothing for 26 days on a biweekly plan');
    assert.equal(outcomeAt([V(0), V(14), V(49)], at0 + DAY, 60, { today: at0 + 40 * DAY }).outcome, 'pending', 'a visit is booked ahead');
    assert.equal(outcomeAt([V(0, { freq: 'Monthly' }), V(14, { freq: 'Monthly' })], at0 + DAY, 60, { today: at0 + 40 * DAY }).outcome, 'pending', 'monthly clients get 35 days');
  });
  test('journey: cleaner change and price change', () => {
    const list = [V(-42), V(-28), V(-14, { revenue: 200, teams: [{ id: 9, name: 'Cleaner 9', hours: 3 }] })];
    const j = journeyAt(list, at0, {});
    assert.equal(j.cleaner_changed_last_visit, true);
    assert.equal(j.distinct_cleaners_90d, 2);
    assert.equal(j.cleans_total, 3);
    assert.ok(j.price_change_pct > 0.1);
  });
  test('reclean cost = hours x the wage of the cleaner who did it; no travel or lost slot unless switched on', () => {
    const c = recleanCost({ hours: 3, cleanerHourly: 24, marginPerHour: 20 }, DEFAULT_SETTINGS.costs);
    assert.deepEqual([c.labour, c.travel, c.lost_slot, c.total], [72, 0, 0, 72]);
    assert.equal(recleanCost({}, DEFAULT_SETTINGS.costs).total, 44, 'no hours, no wage: 2 hours at $22');
    const on = recleanCost({ hours: 3, cleanerHourly: 24, marginPerHour: 20 }, { ...DEFAULT_SETTINGS.costs, include_travel: true, travel_per_visit: 8, include_lost_slot: true });
    assert.deepEqual([on.travel, on.lost_slot, on.total], [8, 60, 140], 'both can be switched back on');
    assert.deepEqual([normalizeSettings({ costs: { travel_per_visit: 8 } }).costs.include_travel, normalizeSettings({ costs: { include_travel: true } }).costs.include_travel], [false, true]);
  });
  test('recleans are always paid: no pay on the visit means the pay is recorded elsewhere', () => {
    const rateOf = cleanerRateIndex([
      { teams: [{ id: 7, hours: 3, earned: 75 }] }, { teams: [{ id: 7, hours: 2, earned: 50 }] }, { teams: [{ id: 7, hours: 2, earned: 0 }] },
      { teams: [{ id: 8, hours: 4, earned: 80 }] },
    ]);
    assert.deepEqual([rateOf(7), rateOf(8), rateOf(99)], [25, 20, null]);
    const C = DEFAULT_SETTINGS.costs;
    assert.deepEqual(recleanVisitCost({ teams: [{ id: 7, hours: 2, earned: 52 }] }, rateOf, C), { labour: 52, hours: 2, estimated: false }, 'pay on the visit: actual');
    assert.deepEqual(recleanVisitCost({ teams: [{ id: 7, hours: 3, earned: 0 }] }, rateOf, C), { labour: 75, hours: 3, estimated: true }, '$0 earned: hours x their own rate');
    assert.deepEqual(recleanVisitCost({ teams: [{ id: 8, hours: null, earned: null }] }, rateOf, C), { labour: 40, hours: 2, estimated: true }, 'no hours booked: 2');
    assert.deepEqual(recleanVisitCost({ teams: [{ id: 99, hours: 1.5, earned: null }] }, rateOf, C), { labour: 33, hours: 1.5, estimated: true }, 'unknown cleaner: $22');
    assert.deepEqual(recleanVisitCost({ teams: [{ id: 7, hours: 2, earned: 50 }, { id: 8, hours: 2, earned: 0 }] }, rateOf, C), { labour: 90, hours: 4, estimated: true }, 'two cleaners, one without pay');
    assert.deepEqual(recleanVisitCost({ teams: [] }, rateOf, C), { labour: 44, hours: 2, estimated: true }, 'no visit on file');
  });
});

describe('complaints: approval rules and budget', () => {
  test('today vs target is a settings change; nobody but the owner goes above 50%', () => {
    const today = normalizeSettings({ roles: { 'om@x.ca': 'office_manager', 'derek@x.ca': 'owner' } });
    assert.equal(canApprove(today, 'om@x.ca', 'L3'), true);
    assert.equal(canApprove(today, 'om@x.ca', 'L4'), false);
    assert.equal(canApprove(today, 'anyone@x.ca', 'L3'), true);
    const target = normalizeSettings({ approval_preset: 'target', roles: { 'om@x.ca': 'office_manager' }, max_rung: { office_manager: 'L7', frontline: 'L7' } });
    assert.equal(canApprove(target, 'om@x.ca', 'L6'), true);
    assert.equal(canApprove(target, 'om@x.ca', 'L7'), false, 'office manager capped at 50%');
    assert.equal(canApprove(target, 'anyone@x.ca', 'L7'), false, 'frontline capped too');
    assert.equal(canApprove(target, 'derek@x.ca', 'L7'), false, 'owner only by role, not by name');
    assert.equal(canApprove(normalizeSettings({ roles: { 'derek@x.ca': 'owner' } }), 'derek@x.ca', 'L7'), true);
  });
  test('historical refund % maps onto rungs', () => {
    assert.deepEqual([20, 30, 40, 50, 100].map(rungForRefund), ['L4', 'L5', 'L5', 'L6', 'L7']);
  });
  test('budget: default target 20% below average, amber at 80%, red at 100%', () => {
    const s = normalizeSettings({});
    assert.equal(budgetStatus({ cost: 100, revenue: 10000 }, s, 0.02).target, 0.016);
    assert.equal(budgetStatus({ cost: 100, revenue: 10000 }, s, 0.02).level, 'green');
    assert.equal(budgetStatus({ cost: 140, revenue: 10000 }, s, 0.02).level, 'amber');
    assert.equal(budgetStatus({ cost: 170, revenue: 10000 }, s, 0.02).level, 'red');
  });
});

describe('complaints: Kustomer mapping', () => {
  test('statuses map to ours and the raw value is kept', () => {
    assert.equal(mapStatus('For Review'), 'open');
    assert.equal(mapStatus('Awaiting Response'), 'awaiting_client');
    assert.equal(mapStatus('Damaged Item'), 'open');
    assert.equal(mapStatus('Reclean Scheduled'), 'reclean_scheduled');
  });
  test('fields are found by name, whatever the org called them', () => {
    const c = toCase({ id: 'k1', attributes: { createdAt: '2026-10-01T12:00:00Z', title: 'Complaint', custom: { statusStr: 'Reclean Scheduled', complaintTypeStr: 'Missed areas', bookingNumberStr: '#74512', resolutionTxt: 'Offered reclean' } }, relationships: { customer: { data: { id: 'c1' } } } });
    assert.equal(c.status, 'reclean_scheduled');
    assert.equal(c.source_status, 'Reclean Scheduled');
    assert.equal(c.l27_booking_id, 74512);
    assert.equal(c.kustomer_customer_id, 'c1');
    assert.match(c.text, /Missed areas/);
  });
  test('discovery returns field names and types, never values', async () => {
    const client = { get: async (path) => (path === '/v1/klasses' ? { data: [{ attributes: { name: 'complaint', displayName: 'Complaint' } }, { attributes: { name: 'order' } }] } : { data: [{ attributes: { createdAt: 'x', custom: { statusStr: 'For Review', detailsTxt: 'secret client text' } } }] }) };
    const d = await discover(client);
    assert.equal(d.complaint_klass, 'complaint');
    assert.ok(d.fields.some((f) => f.name === 'custom.detailsTxt' && f.type === 'string'));
    assert.ok(!JSON.stringify(d).includes('secret client text'));
  });
});

describe('complaints: playbook', () => {
  test('rungs, retention, reclean vs refund, thin data flagged', () => {
    const cases = [];
    const resolutions = [];
    const costs = [];
    const outcomes = [];
    let id = 1;
    const add = (category, { rung, action, cost, outcome }) => {
      const c = { id: id++, source: 'kustomer', opened_at: '2026-06-10T12:00:00Z', category, l27_customer_id: id, classified_by: 'claude' };
      cases.push(c);
      if (rung) resolutions.push({ case_id: c.id, rung, action });
      if (cost) costs.push({ case_id: c.id, kind: action === 'refund' ? 'refund' : 'reclean_labour', amount: cost, estimated: false });
      outcomes.push({ case_id: c.id, day: 60, outcome });
    };
    for (let i = 0; i < 4; i++) add('quality_missed', { rung: 'L3', action: 'reclean_full', cost: 120, outcome: i < 3 ? 'saved' : 'lost' });
    for (let i = 0; i < 5; i++) add('quality_missed', { rung: 'L5', action: 'refund', cost: 50, outcome: i < 4 ? 'saved' : 'lost' });
    for (let i = 0; i < 3; i++) add('quality_missed', { outcome: 'lost' });
    const pb = buildPlaybook({ cases, resolutions, costs, outcomes, visits: [], from: '2026-05-01', to: '2026-10-31', settings: normalizeSettings({}), today: '2026-11-16' });
    const q = pb.taxonomy.find((t) => t.key === 'quality_missed');
    assert.equal(q.n, 12);
    assert.equal(q.confidence, 'fair');
    assert.equal(q.cheapest_that_works.rung, 'L5', 'the only response with 5 known outcomes of its own');
    const l3 = pb.ladder.find((r) => r.rung === 'L3');
    assert.equal(l3.n, 4);
    assert.equal(l3.confidence, 'thin');
    const rv = pb.reclean_vs_refund.find((x) => x.key === 'quality_missed');
    assert.match(rv.verdict, /reclean|refund/);
    assert.ok(pb.gaps.length >= 1);
  });
});

describe('complaints: end to end on the synthetic Launch27', () => {
  test('a run finds unhappy ratings, links bookings, computes journeys, outcomes and the playbook', async () => {
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const fetchImpl = createMockLaunch27({ password: 'demo' });
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet });
    const reports = createReports({ db, config, fetchImpl, schedule, log: quiet });
    await schedule.sync();
    await reports.sync();
    const snap = await reports.visitsSnapshot();
    const complaints = createComplaints({ db, config, reports, fetchImpl, log: quiet });
    const to = snap.to;
    const from = new Date(Date.parse(to) - 182 * 86_400_000).toISOString().slice(0, 10);
    const result = await complaints.run({ from, to });
    assert.ok(result.cases > 0, 'unhappy ratings become cases');
    const list = await complaints.listCases({ from, to });
    assert.ok(list.every((c) => c.source === 'launch27_rating'), 'no real sources outside production');
    const one = await complaints.getCase(list[0].id);
    assert.ok(one.l27_booking_id);
    assert.ok(one.journey && one.journey.cleans_total >= 1);
    assert.equal(one.outcomes.length, 3);
    // Re-running is idempotent.
    await complaints.run({ from, to });
    assert.equal((await complaints.listCases({ from, to })).length, list.length);
    const pb = await complaints.playbook({ from, to });
    assert.equal(pb.totals.cases, list.length);
    assert.ok(pb.root_causes && pb.root_causes.visits > 0);
    assert.ok(pb.baseline.months.length > 0);
    const st = await complaints.status();
    assert.equal(st.last_run.status, 'done');
    assert.match(st.sources.kustomer, /not set up/);
    await db.close();
  });
});

describe('complaints: production without a Launch27 sync login', () => {
  test("a run builds the Launch27 history with the admin's own login", async () => {
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const fetchImpl = createMockLaunch27({ password: 'demo' });
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet });
    await schedule.sync();
    const reports = createReports({ db, config, fetchImpl, schedule, log: quiet });
    await assert.rejects(() => reports.visitsSnapshot(), /not been built/);
    const login = await (await fetchImpl(`${config.l27BaseUrl}/latest/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', password: 'demo' }) })).json();
    const complaints = createComplaints({ db, config, reports, fetchImpl, log: quiet });
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 182 * 86_400_000).toISOString().slice(0, 10);
    const r = await complaints.run({ from, to, bearer: login.bearer });
    assert.ok(r.cases >= 0);
    const st = await complaints.status();
    assert.equal(st.last_run.status, 'done');
    assert.ok(st.last_run.log.some((l) => /building it now/.test(l.msg)));
    await db.close();
  });
});

describe('complaints: Kustomer listing fallbacks', () => {
  const res = (status, body) => ({ ok: status < 300, status, headers: { get: () => null }, json: async () => body });
  test('a refused listing shape falls through to the next, and Kustomer\'s reason is kept', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      const u = new URL(url);
      calls.push(u.pathname + u.search);
      if (u.pathname === '/v1/klasses') return res(200, { data: [{ id: 'k123', attributes: { name: 'complaint' } }] });
      if (u.pathname === '/v1/klasses/complaint') return res(400, { errors: [{ title: 'Bad Param', detail: 'badparam' }] });
      if (u.pathname === '/v1/klasses/complaint/kobjects') return res(400, { errors: [{ title: 'Bad Request', detail: 'use the klass id, not name (ask a@b.com)' }] });
      if (u.pathname === '/v1/klasses/k123/kobjects') return res(200, { data: [{ id: 'o1', attributes: { createdAt: '2026-10-01T00:00:00Z', custom: { statusStr: 'For Review' } } }], links: { next: null } });
      return res(404, {});
    };
    const client = createKustomerClient({ apiKey: 'x', fetchImpl, sleep: async () => {} });
    const d = await discover(client);
    assert.equal(d.listing.label, 'by id');
    assert.equal(d.attempts.length, 4);
    assert.match(d.attempts[1].error, /400 \(Bad Request: use the klass id/);
    assert.ok(!JSON.stringify(d).includes('a@b.com'), 'emails masked in error text');
    assert.equal(d.sample_count, 1);
  });
  test('when nothing works, every attempt says why', async () => {
    const fetchImpl = async () => res(403, { errors: [{ title: 'Forbidden', detail: 'missing org.permission.kobject.read' }] });
    const client = createKustomerClient({ apiKey: 'x', fetchImpl, sleep: async () => {} });
    const f = await findListing(client, { id: 'k1', name: 'complaint' });
    assert.equal(f.listing, null);
    assert.ok(f.attempts.every((a) => /403 \(Forbidden: missing org.permission.kobject.read\)/.test(a.error)));
  });
});

describe('complaints: Kustomer documented listing', () => {
  test('GET /v1/klasses/{name} is used first, and links.next is followed', async () => {
    const res = (status, body) => ({ ok: status < 300, status, headers: { get: () => null }, json: async () => body });
    const seen = [];
    const fetchImpl = async (url) => {
      const u = new URL(url);
      seen.push(u.pathname + u.search);
      if (u.pathname === '/v1/klasses') return res(200, { data: [{ id: 'k1', attributes: { name: 'complaint' } }] });
      if (u.pathname === '/v1/klasses/complaint' && !u.search) return res(200, { data: [{ id: 'a', attributes: { createdAt: '2026-10-01T00:00:00Z', custom: {} } }], links: { next: '/v1/klasses/complaint?page=2' } });
      if (u.pathname === '/v1/klasses/complaint' && u.search === '?page=2') return res(200, { data: [{ id: 'b', attributes: { createdAt: '2026-10-05T00:00:00Z', custom: {} } }], links: { next: null } });
      return res(400, { errors: [{ title: 'Bad Param' }] });
    };
    const client = createKustomerClient({ apiKey: 'x', fetchImpl, sleep: async () => {} });
    const d = await discover(client);
    assert.equal(d.listing.label, 'documented');
    const { listComplaints } = await import('../src/complaints/sources/kustomer.js');
    const ids = [];
    for await (const o of listComplaints(client, d.listing, { from: '2026-09-01', to: '2026-10-31' })) ids.push(o.id);
    assert.deepEqual(ids, ['a', 'b']);
  });
});

describe('complaints: info@ email by month', () => {
  test('a month whose search keeps timing out is skipped; the other months are still read', async () => {
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const fetchImpl = createMockLaunch27({ password: 'demo' });
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet });
    const reports = createReports({ db, config, fetchImpl, schedule, log: quiet });
    await schedule.sync();
    await reports.sync();
    let searches = 0;
    const b64 = (s) => Buffer.from(s).toString('base64url');
    const client = {
      async search(account, q) {
        searches++;
        if (/after:2026\/09\/01/.test(q)) throw new Error('The operation was aborted due to timeout');
        const m = q.match(/after:(\d{4})\/(\d\d)/);
        return { ids: [`m-${m[1]}-${m[2]}`], next: null };
      },
      async message(account, id) {
        return { id, threadId: `t-${id}`, internalDate: String(Date.parse('2026-09-15T12:00:00Z')), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Pat Client <pat@example.com>' }, { name: 'Subject', value: 'Very disappointed' }], body: { data: b64('The kitchen was still dirty and the floors were missed. Unacceptable.') } } };
      },
    };
    const complaints = createComplaints({ db, config, reports, fetchImpl, gmail: { client, accounts: ['info@example.com'] }, log: quiet });
    await complaints.run({ from: '2026-08-01', to: '2026-10-31' });
    const st = await complaints.status();
    const msgs = st.last_run.log.map((l) => l.msg);
    assert.ok(msgs.some((m) => /2026\/09\/01.*skipped/.test(m)), 'the bad month is reported');
    assert.ok(msgs.some((m) => /info@ email: [1-9]\d* candidate threads.*1 month\(s\) skipped/.test(m)), msgs.join(' | '));
    assert.ok(searches >= 4, 'the bad month was retried once and the other months still searched');
    await db.close();
  });
});

describe('complaints: cut-off runs', () => {
  test('a run left running by a restart is marked interrupted; what it saved stays', async () => {
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const fetchImpl = createMockLaunch27({ password: 'demo' });
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet });
    const reports = createReports({ db, config, fetchImpl, schedule, log: quiet });
    await schedule.sync();
    await reports.sync();
    const complaints = createComplaints({ db, config, reports, fetchImpl, log: quiet });
    const snap = await reports.visitsSnapshot();
    const from = new Date(Date.parse(snap.to) - 182 * 86_400_000).toISOString().slice(0, 10);
    await complaints.run({ from, to: snap.to });
    const saved = (await complaints.listCases({ from, to: snap.to })).length;
    assert.ok(saved > 0);
    // Simulate a restart mid-run: a run row left 'running'.
    await db.query("INSERT INTO complaint_runs (window_from, window_to, status, log) VALUES ($1, $2, 'running', '[]')", [from, snap.to]);
    assert.equal(await complaints.markInterrupted(), 1);
    const st = await complaints.status();
    assert.equal(st.last_run.status, 'interrupted');
    assert.match(st.last_run.log.at(-1).msg, /Interrupted/);
    assert.equal((await complaints.listCases({ from, to: snap.to })).length, saved, 'saved cases are kept');
    assert.equal(await complaints.markInterrupted(), 0, 'nothing left to mark');
    assert.ok((await db.query('SELECT log FROM complaint_runs WHERE id = (SELECT min(id) FROM complaint_runs)')).rows[0].log.some((l) => /Launch27 ratings: \d+ complaint cases? saved/.test(l.msg)), 'each source reports what it saved');
    await db.close();
  });
});

describe('complaints: faster classification', () => {
  test('info@ is screened by rules before Claude, and Claude calls run several at a time', async () => {
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const fetchImpl = createMockLaunch27({ password: 'demo' });
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet });
    const reports = createReports({ db, config, fetchImpl, schedule, log: quiet });
    await schedule.sync();
    await reports.sync();
    const b64 = (s) => Buffer.from(s).toString('base64url');
    const bodies = { a: 'The kitchen was still dirty and the floors were missed. Unacceptable.', b: 'Hi, can we move Tuesday to Wednesday? Thanks', c: 'Really disappointed, the bathroom was skipped again.' };
    const client = {
      async search(account, q) {
        return /after:2026\/10\/01/.test(q) ? { ids: ['a', 'b', 'c'], next: null } : { ids: [], next: null };
      },
      async message(account, id) {
        return { id, threadId: `t-${id}`, internalDate: String(Date.parse('2026-10-05T12:00:00Z')), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: `Client ${id} <${id}@example.com>` }, { name: 'Subject', value: 'Cleaning' }], body: { data: b64(bodies[id]) } } };
      },
    };
    let inFlight = 0;
    let maxInFlight = 0;
    const seen = [];
    const classifier = async (text) => {
      seen.push(text);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { is_complaint: true, category: 'quality_missed', tone: 'frustrated', severity: 2, areas: [], hard_route: null, summary: 'x', confidence: 0.9 };
    };
    const complaints = createComplaints({ db, config, reports, fetchImpl, gmail: { client, accounts: ['info@example.com'] }, classifier, log: quiet });
    await complaints.run({ from: '2026-10-01', to: '2026-10-31' });
    assert.ok(!seen.some((t) => /move Tuesday/.test(t)), 'a scheduling email never reaches Claude');
    assert.ok(seen.some((t) => /bathroom was skipped/.test(t)));
    assert.ok(maxInFlight > 1, 'Claude calls overlap');
    const st = await complaints.status();
    assert.ok(st.last_run.log.some((l) => /info@ email: 2 complaint cases saved \(1 screened out/.test(l.msg)), st.last_run.log.map((l) => l.msg).join(' | '));
    await db.close();
  });
});

describe('complaints: one-time clients, service type, clients view', () => {
  const DAY = 86_400_000;
  const at0 = Date.parse('2026-03-01T15:00:00Z');
  const V = (d, extra = {}) => ({ id: d + 5000, at: at0 + d * DAY, date: new Date(at0 + d * DAY).toISOString().slice(0, 10), revenue: 250, kind: 'one', teams: [{ id: 7, name: 'C7', hours: 4 }], ...extra });
  test('one-time client: rebooked within 90/120 days, or not, or too early', async () => {
    const { oneTimeOutcomeAt } = await import('../src/complaints/journey.js');
    const today = at0 + 200 * DAY;
    assert.equal(oneTimeOutcomeAt([V(0), V(70)], at0, 90, { today }).outcome, 'rebooked');
    assert.equal(oneTimeOutcomeAt([V(0), V(110)], at0, 90, { today }).outcome, 'not_rebooked');
    assert.equal(oneTimeOutcomeAt([V(0), V(110)], at0, 120, { today }).outcome, 'rebooked');
    assert.equal(oneTimeOutcomeAt([V(0)], at0, 120, { today }).outcome, 'not_rebooked');
    assert.equal(oneTimeOutcomeAt([V(0)], at0, 120, { today: at0 + 50 * DAY }).outcome, 'pending');
  });
  test('visit snapshot carries service type; deep clean and move in/out come from extras', async () => {
    const { slimReportVisit } = await import('../src/reports/compute.js');
    const b = { id: 1, service_date: '2026-10-05T14:00:00Z', frequency: { name: 'One time' }, user: { id: 3, name: 'A' }, summary: { revenue: 300 }, teams: [{ id: 7, title: 'C', hours: 4 }], services: [{ name: 'Three Bedroom Home', extras: [{ name: 'Deep Cleaning' }, { name: 'Inside Oven' }] }] };
    const v = slimReportVisit(b, null, null);
    assert.equal(v.svc, 'Three Bedroom Home');
    assert.equal(v.deep, true);
    assert.equal(v.move, false);
    assert.equal(slimReportVisit({ ...b, services: [{ name: 'Reclean', extras: [] }] }, null, null).reclean, true);
  });
  test('playbook: one-time clients are measured on rebooking, not Saved/Lost; plain rung names', () => {
    const cases = [
      { id: 1, source: 'kustomer', opened_at: '2026-06-10T12:00:00Z', category: 'quality_missed', l27_customer_id: 1, one_time: true },
      { id: 2, source: 'kustomer', opened_at: '2026-06-10T12:00:00Z', category: 'quality_missed', l27_customer_id: 2, one_time: true },
      { id: 3, source: 'kustomer', opened_at: '2026-06-10T12:00:00Z', category: 'quality_missed', l27_customer_id: 3 },
    ];
    const outcomes = [{ case_id: 1, day: 120, outcome: 'rebooked' }, { case_id: 2, day: 120, outcome: 'not_rebooked' }, { case_id: 3, day: 60, outcome: 'saved' }];
    const pb = buildPlaybook({ cases, resolutions: [{ case_id: 3, rung: 'L3', action: 'reclean_full' }], costs: [], outcomes, visits: [], from: '2026-05-01', to: '2026-10-31', settings: normalizeSettings({}), today: '2026-11-16' });
    assert.equal(pb.totals.decided, 1, 'only the recurring client counts toward Saved/Lost');
    assert.equal(pb.totals.saved, 1);
    assert.equal(pb.totals.one_time.n, 2);
    assert.equal(pb.totals.one_time.rebooked_120, 0.5);
    assert.equal(pb.ladder.find((r) => r.rung === 'L3').name, 'Reclean');
    assert.equal(pb.ladder.find((r) => r.rung === 'L0').name, 'Apology only');
    assert.ok(pb.like_for_like.verdict);
  });
  test('like for like: only groups with both a reclean and a refund are compared', () => {
    const cases = [];
    const resolutions = [];
    const outcomes = [];
    let id = 1;
    const add = (tone, action, outcome) => {
      cases.push({ id, source: 'kustomer', opened_at: '2026-06-10T12:00:00Z', category: 'quality_missed', tone, tenure_days: 200, l27_customer_id: id });
      resolutions.push({ case_id: id, rung: action === 'refund' ? 'L5' : 'L3', action: action === 'refund' ? 'refund' : 'reclean_full' });
      outcomes.push({ case_id: id++, day: 60, outcome });
    };
    // Calm clients: recleans only (no refund to compare with). Heated: both.
    for (let i = 0; i < 8; i++) add('mild', 'reclean', 'saved');
    for (let i = 0; i < 6; i++) add('angry', 'reclean', i < 2 ? 'saved' : 'lost');
    for (let i = 0; i < 6; i++) add('angry', 'refund', i < 4 ? 'saved' : 'lost');
    const pb = buildPlaybook({ cases, resolutions, costs: [], outcomes, visits: [], from: '2026-05-01', to: '2026-10-31', settings: normalizeSettings({}), today: '2026-11-16' });
    const l = pb.like_for_like;
    assert.equal(l.groups_compared, 1);
    assert.equal(l.matched_pairs, 6);
    assert.equal(l.reclean.saved, 0.333);
    assert.equal(l.refund.saved, 0.667);
    assert.match(l.verdict, /Too few comparable cases/);
  });
  test('clients view: repeat complainers and at-risk clients, with reasons', async () => {
    const { buildClients } = await import('../src/complaints/playbook.js');
    const now = Date.parse('2026-11-16T12:00:00Z');
    const day = (d) => new Date(now - d * DAY).toISOString();
    const rows = [
      { id: 1, l27_customer_id: 10, customer_name: 'A', opened_at: day(200), category: 'quality_missed', tone: 'mild', severity: 1, cost: 5, outcomes: [{ day: 60, outcome: 'saved', next: '2026-06-01' }] },
      { id: 2, l27_customer_id: 10, customer_name: 'A', opened_at: day(100), category: 'quality_missed', tone: 'mild', severity: 1, cost: 10, outcomes: [{ day: 60, outcome: 'saved', next: '2026-09-01' }] },
      { id: 3, l27_customer_id: 20, customer_name: 'B', opened_at: day(20), category: 'punctuality', tone: 'threat_leave', severity: 3, cost: 0, cleans_total: 2, outcomes: [{ day: 30, outcome: 'pending', next: null }] },
      { id: 4, l27_customer_id: 30, customer_name: 'C', opened_at: day(20), category: 'quality_missed', tone: 'mild', severity: 1, cost: 0, cleans_total: 40, outcomes: [{ day: 30, outcome: 'pending', next: '2026-11-20' }] },
      { id: 5, l27_customer_id: 40, customer_name: 'D', opened_at: day(150), category: 'quality_missed', tone: 'threat_review', severity: 3, cost: 80, outcomes: [{ day: 60, outcome: 'lost', next: null }] },
    ];
    const c = buildClients(rows, now);
    assert.deepEqual(c.repeat.map((x) => x.name), ['A']);
    assert.equal(c.repeat[0].complaints, 2);
    assert.equal(c.repeat[0].total_cost, 15);
    assert.equal(c.repeat[0].still_with_us, true);
    assert.deepEqual(c.at_risk.map((x) => x.name), ['B'], 'calm long-time client with a booking ahead is not at risk; a lost client is not at risk');
    assert.ok(c.at_risk[0].reasons.includes('said they may leave'));
    assert.ok(c.at_risk[0].reasons.includes('nothing booked since the complaint'));
    assert.deepEqual(c.review_mentions.map((x) => x.name), ['D']);
    assert.equal(c.google_reviews_connected, false);
  });
});

describe('complaints: automatic updates', () => {
  test('plan: newest unread days first, then older months, then the daily refresh, then nothing', async () => {
    const { planAuto } = await import('../src/complaints/service.js');
    const today = '2026-11-19';
    // Nothing read yet: the most recent month.
    let j = planAuto({ mined: [], today, historyDays: 365, recentDone: null });
    assert.deepEqual([j.kind, j.from, j.to], ['history', '2026-10-19', '2026-11-18']);
    // Aug 15 – Nov 15 read: first catch up the days since.
    j = planAuto({ mined: [{ from: '2026-08-15', to: '2026-11-15' }], today, historyDays: 365, recentDone: null });
    assert.deepEqual([j.kind, j.from, j.to], ['history', '2026-11-16', '2026-11-18']);
    // Caught up: next the month before what's been read.
    const mined = [{ from: '2026-08-15', to: '2026-11-15' }, { from: '2026-11-16', to: '2026-11-18' }];
    j = planAuto({ mined, today, historyDays: 365, recentDone: null });
    assert.deepEqual([j.kind, j.from, j.to], ['history', '2026-07-15', '2026-08-14']);
    // History target reached: the daily two-week refresh, once.
    const all = [{ from: '2025-11-19', to: '2026-11-18' }];
    j = planAuto({ mined: all, today, historyDays: 365, recentDone: '2026-11-18' });
    assert.deepEqual([j.kind, j.from, j.to, j.refreshFrom], ['recent', '2026-11-05', '2026-11-18', '2026-07-12']);
    assert.equal(planAuto({ mined: all, today, historyDays: 365, recentDone: today }), null);
    // Root causes missing in the last 90 days: one pass over them, after catching up the newest
    // days but ahead of older history and the daily refresh.
    j = planAuto({ mined: all, today, historyDays: 365, recentDone: today, causesPending: true });
    assert.deepEqual([j.kind, j.from, j.to], ['causes', '2026-08-21', '2026-11-18']);
    j = planAuto({ mined: [{ from: '2026-08-15', to: '2026-11-18' }], today, historyDays: 365, recentDone: null, causesPending: true });
    assert.equal(j.kind, 'causes', 'before older history');
    j = planAuto({ mined: [{ from: '2026-08-15', to: '2026-11-15' }], today, historyDays: 365, recentDone: null, causesPending: true });
    assert.deepEqual([j.kind, j.from], ['history', '2026-11-16'], 'the newest days come first');
    // The last chunk stops at the history target.
    j = planAuto({ mined: [{ from: '2025-12-01', to: '2026-11-18' }], today, historyDays: 365, recentDone: today });
    assert.deepEqual([j.from, j.to], ['2025-11-19', '2025-11-30']);
  });

  test('runs by itself until history is read, survives a restart, and never re-sends a classified case to Claude', async () => {
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const fetchImpl = createMockLaunch27({ password: 'demo' });
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet });
    const reports = createReports({ db, config, fetchImpl, schedule, log: quiet });
    await schedule.sync();
    await reports.sync();
    let calls = 0;
    const classifier = async () => {
      calls++;
      return { is_complaint: true, category: 'quality_missed', tone: 'frustrated', severity: 2, areas: [], hard_route: null, summary: 'x', confidence: 0.9 };
    };
    const { createSyncBearer } = await import('../src/inbox/lookup.js');
    const make = () => createComplaints({ db, config, reports, fetchImpl, classifier, syncBearer: createSyncBearer({ config, fetchImpl }), log: quiet });
    let complaints = make();
    await complaints.saveSettings({ auto: { enabled: true, history_months: 3 } });
    const drain = async (c) => {
      for (let i = 0; i < 400; i++) {
        const st = await c.status();
        if (!st.running && !st.auto.next) return st;
        if (!st.running) await c.maybeRun();
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('automatic updates never finished');
    };
    assert.equal(await complaints.maybeRun(), true, 'starts without anyone clicking');
    // "Restart" part-way: a run left running is marked interrupted and its dates are read again.
    await db.query("INSERT INTO complaint_runs (window_from, window_to, status, log) VALUES ('2026-01-01', '2026-01-31', 'running', '[]')");
    complaints = make();
    await complaints.markInterrupted();
    const st = await drain(complaints);
    assert.equal(st.auto.next, null);
    assert.ok(st.auto.last_daily_update, 'the daily update ran after the history was read');
    assert.ok(st.mined.length >= 3, 'history read in monthly pieces');
    const cases = Number((await db.query('SELECT count(*)::int AS n FROM complaint_cases')).rows[0].n);
    assert.ok(cases > 0);
    assert.ok(calls <= cases, `each case classified once (${calls} Claude calls for ${cases} cases)`);
    // Turned off in settings: nothing more is planned.
    await complaints.saveSettings({ auto: { enabled: false } });
    assert.equal(await complaints.maybeRun(), false);
    await db.close();
  });
});

describe('complaints: checking the taxonomy by hand', () => {
  test('accuracy is measured against what the engine said, and thin samples are flagged', () => {
    const rows = [
      ...Array.from({ length: 18 }, () => ({ verdict: 'correct', was_category: 'quality_missed', was_classified_by: 'claude', source: 'kustomer' })),
      { verdict: 'wrong_category', was_category: 'quality_missed', now_category: 'quality_rushed', was_classified_by: 'claude', source: 'kustomer' },
      { verdict: 'not_complaint', was_category: 'quality_missed', was_classified_by: 'rules', source: 'gmail' },
      { verdict: 'not_complaint', was_category: 'other', was_classified_by: 'rules', source: 'gmail' },
    ];
    const s = buildReviewStats(rows, [{ category: 'quality_missed', n: 40 }, { category: 'punctuality', n: 7 }]);
    assert.equal(s.total.checked, 21);
    const missed = s.by_category.find((c) => c.key === 'quality_missed');
    assert.equal(missed.accuracy, 0.9);
    assert.equal(missed.enough, true);
    assert.equal(missed.waiting, 40);
    assert.equal(s.by_category.find((c) => c.key === 'other').enough, false, 'one check is not a result');
    assert.equal(s.by_category.find((c) => c.key === 'punctuality').checked, 0, 'unchecked categories still listed');
    assert.equal(s.by_source.find((c) => c.key === 'gmail').not_complaint, 2);
    assert.deepEqual(s.confusions, [{ from: 'quality_missed', to: 'quality_rushed', n: 1 }]);
    assert.equal(s.waiting, 47);
  });

  test('a batch, the three verdicts, and what each does to the playbook', async () => {
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const fetchImpl = createMockLaunch27({ password: 'demo' });
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet });
    const reports = createReports({ db, config, fetchImpl, schedule, log: quiet });
    await schedule.sync();
    await reports.sync();
    const to = (await reports.visitsSnapshot()).to;
    const from = new Date(Date.parse(to) - 182 * 86_400_000).toISOString().slice(0, 10);
    const complaints = createComplaints({ db, config, reports, fetchImpl, log: quiet });
    await complaints.run({ from, to });
    const before = (await complaints.listCases({ from, to })).length;
    const queue = await complaints.reviewQueue({ per: 2 });
    assert.ok(queue.length >= 3, 'needs three cases to check');
    const perCat = {};
    for (const c of queue) perCat[c.category] = (perCat[c.category] || 0) + 1;
    assert.ok(Object.values(perCat).every((n) => n <= 2), 'at most the asked number per category');
    assert.ok(queue.every((c) => !('raw' in c) && !('source_id' in c)));
    assert.ok(queue.every((c) => c.text), 'the rating comment is shown to the reviewer');
    const [a, b, c] = queue;
    const other = a.category === 'punctuality' ? 'communication' : 'punctuality';
    await complaints.reviewCase(a.id, { verdict: 'correct' }, null);
    await complaints.reviewCase(b.id, { verdict: 'wrong_category', category: other === b.category ? 'scope_booking' : other }, null);
    await complaints.reviewCase(c.id, { verdict: 'not_complaint' }, null);
    const stats = await complaints.reviewStats();
    assert.equal(stats.total.checked, 3);
    assert.equal(stats.total.correct, 1);
    assert.equal(stats.total.not_complaint, 1);
    assert.equal(stats.by_category.find((g) => g.key === b.category).wrong_category >= 1, true, 'counted against the category the engine chose');
    assert.equal((await complaints.getCase(b.id)).classified_by, 'human');
    assert.equal((await complaints.listCases({ from, to })).length, before - 1, 'not-a-complaint leaves the case list');
    assert.equal((await complaints.playbook({ from, to })).totals.cases, before - 1);
    const again = await complaints.reviewQueue({ per: 100 });
    assert.ok(![a.id, b.id, c.id].some((id) => again.some((x) => x.id === id)), 'checked cases are not shown again');
    // A later run must not bring the excluded case back or undo the person's category.
    await complaints.run({ from, to });
    assert.equal((await complaints.listCases({ from, to })).length, before - 1);
    assert.equal((await complaints.getCase(b.id)).classified_by, 'human');
    await assert.rejects(complaints.reviewCase(999999, { verdict: 'correct' }, null), /Not found/);
    await db.close();
  });
});

describe('complaints: every playbook number is traceable', () => {
  const mk = () => {
    const cases = [];
    const resolutions = [];
    const costs = [];
    const outcomes = [];
    let id = 1;
    const add = (category, { rung, action, cost = 0, outcome, opened = '2026-06-10T12:00:00Z', matched = true, one_time = false, o120 }) => {
      const c = { id: id++, source: 'kustomer', opened_at: opened, category, l27_customer_id: matched ? 500 + id : null, classified_by: 'claude', one_time };
      cases.push(c);
      if (rung) resolutions.push({ case_id: c.id, rung, action });
      if (cost) costs.push({ case_id: c.id, kind: 'refund', amount: cost, estimated: false });
      if (outcome) outcomes.push({ case_id: c.id, day: 60, outcome });
      if (o120) outcomes.push({ case_id: c.id, day: 90, outcome: o120 }, { case_id: c.id, day: 120, outcome: o120 });
      return c;
    };
    return { cases, resolutions, costs, outcomes, add, build: () => buildPlaybook({ cases, resolutions, costs, outcomes, visits: [], from: '2026-05-01', to: '2026-11-15', settings: normalizeSettings({}), today: '2026-11-16' }) };
  };

  test('rates show their numerator and denominator, and the rest is explained', () => {
    const m = mk();
    for (let i = 0; i < 5; i++) m.add('punctuality', { outcome: i < 2 ? 'saved' : i < 3 ? 'partial_save' : 'lost', cost: 100 });
    m.add('punctuality', { outcome: 'pending', opened: '2026-11-01T12:00:00Z' }); // too recent
    m.add('punctuality', { matched: false, cost: 40 }); // no Launch27 client
    m.add('punctuality', { one_time: true, o120: 'rebooked' });
    m.add('punctuality', { one_time: true, o120: 'not_rebooked' });
    m.add('punctuality', { outcome: 'pending' }); // old enough, still nothing recorded
    const t = m.build().taxonomy.find((x) => x.key === 'punctuality');
    assert.equal(t.n, 10);
    assert.equal(t.ids.length, 10);
    assert.equal(t.decided, 5);
    assert.deepEqual([t.saved_n, t.partial_n, t.lost_n], [2, 0, 3], 'a row stored as a partial save counts as lost');
    assert.equal(t.saved_n + t.lost_n, t.decided, 'saved and lost add up to decided');
    assert.deepEqual([t.lost_with_review_n, t.lost_no_review_n], [0, 3], 'lost clients split by whether they left a bad review');
    assert.equal(t.saved, 0.4);
    assert.equal(t.excluded_n, 5);
    assert.deepEqual(Object.fromEntries(Object.entries(t.excluded).map(([k, v]) => [k, v.length])), { too_recent: 1, unmatched: 1, one_time: 2, no_outcome: 1 });
    assert.equal(t.decided + t.excluded_n, t.n, 'decided plus not counted is every case');
    assert.equal(t.avg_cost, 54, 'average over all 10 cases');
    assert.equal(t.avg_cost_decided, 100, 'average over the same 5 cases the rates use');
    assert.equal(t.total_cost, 540);
    assert.equal(t.total_n, 10);
    assert.deepEqual([t.one_time.n, t.one_time.decided, t.one_time.rebooked_120_n, t.one_time.rebooked_120], [2, 2, 1, 0.5]);
  });

  test('"cheapest that works" names a response only on 5+ cases with a known outcome of its own', () => {
    const m = mk();
    for (let i = 0; i < 4; i++) m.add('communication', { rung: 'L3', action: 'reclean_full', outcome: i < 2 ? 'saved' : 'lost' });
    m.add('scope_booking', { outcome: 'pending', opened: '2026-11-05T12:00:00Z' });
    m.add('damage', { rung: 'L1', action: 'credit', outcome: 'saved' });
    for (let i = 0; i < 6; i++) m.add('punctuality', { rung: 'L2', action: 'credit', outcome: i < 5 ? 'saved' : 'lost', cost: 10 });
    for (let i = 0; i < 5; i++) m.add('punctuality', { rung: 'L5', action: 'refund', outcome: i < 4 ? 'saved' : 'lost', cost: 60 });
    for (let i = 0; i < 3; i++) m.add('punctuality', { rung: 'L7', action: 'refund', outcome: 'saved', cost: 150 });
    const pb = m.build();
    const by = (k) => pb.taxonomy.find((x) => x.key === k).cheapest_that_works;
    for (const k of ['communication', 'damage', 'scope_booking']) {
      assert.deepEqual([by(k).name, by(k).basis, by(k).grade], [null, 'not_enough', 'Low'], k);
      assert.match(by(k).reason, /^Not enough data: use the standard ladder/);
    }
    assert.match(by('communication').reason, /the most is 4/);
    // Enough data: the cheapest response within 10 points of the best; three lucky full refunds are not considered.
    assert.deepEqual([by('punctuality').name, by('punctuality').basis, by('punctuality').n], ['$10 credit', 'compared', 6]);
    assert.ok(pb.taxonomy.every((x) => x.cheapest_that_works && x.cheapest_that_works.grade));
  });

  test('ladder, months and totals carry the case ids behind them', () => {
    const m = mk();
    const a = m.add('quality_missed', { rung: 'L5', action: 'refund', cost: 60, outcome: 'saved' });
    const b = m.add('damage', { outcome: 'lost' });
    b.hard_route = 'damage_over_100';
    const pb = m.build();
    assert.deepEqual(pb.ladder.find((r) => r.rung === 'L5').ids, [a.id]);
    assert.deepEqual(pb.totals.hard_routed_ids, [b.id]);
    assert.deepEqual(pb.hard_routes.find((h) => h.key === 'damage_over_100').ids, [b.id]);
    assert.ok(pb.ladder.every((r) => !r.ids.includes(b.id)), 'escalated cases are not on the ladder');
    assert.deepEqual(pb.totals.ids.sort(), [a.id, b.id]);
    assert.ok(pb.excluded_labels.too_recent);
  });
});

describe('complaints: root causes (why it happened)', () => {
  test('the codebook rules: the specific "why" wins over the symptom', () => {
    const r = classifyRules('Since our cleaner left it has not been the same. The bathroom was missed and there was dust everywhere.');
    assert.equal(r.category, 'quality_missed', 'the category is still what they complained about');
    assert.equal(r.cause, 'regular_left');
    assert.ok(r.contributing.includes('missed_areas'));
    assert.equal(r.cause_by, 'rules');
    assert.equal(causeRules('A different person showed up and nobody told us.').cause, 'changed_unannounced');
    assert.equal(causeRules('Every time it is someone new, we never get the same person.').cause, 'no_regular');
    assert.equal(causeRules('Please stop sending me so many emails.').cause, 'marketing_emails');
    assert.equal(causeRules('Only one cleaner came, we booked two.').cause, 'team_size');
    assert.equal(causeRules("She didn't understand my instructions at all.").cause, 'language');
    assert.equal(causeRules('I asked them not to use bleach on the counters and they did anyway.').cause, 'instructions_ignored');
    assert.equal(causeRules('Great job, thank you!').cause, null);
    for (const c of CAUSES) {
      assert.ok(c.definition && c.not_when && c.examples.length === 2, `${c.key} has a full codebook entry`);
      assert.ok(CAUSE_GROUPS.some((g) => g.key === c.group), `${c.key} is in a group`);
    }
  });

  test("Claude's cause wins; its 'none of these' keeps a cause the rules found, and always counts as read", () => {
    const rules = classifyRules('The new cleaner missed the kitchen.');
    const viaClaude = mergeClassification(rules, { category: 'quality_missed', tone: 'mild', severity: 2, areas: [], cause: 'replacement_quality', contributing: ['missed_areas', 'replacement_quality', 'bogus'], cause_evidence: 'not as good as our old cleaner' });
    assert.equal(viaClaude.cause, 'replacement_quality');
    assert.deepEqual(viaClaude.contributing, ['missed_areas'], 'no repeats of the cause, no unknown keys');
    assert.equal(viaClaude.cause_by, 'claude');
    const otherWithRules = mergeClassification(rules, { category: 'quality_missed', tone: 'mild', severity: 2, areas: [], cause: 'other', contributing: [] });
    assert.equal(otherWithRules.cause, rules.cause);
    assert.equal(otherWithRules.cause_by, 'rules');
    const otherAlone = mergeClassification(classifyRules('Not happy.'), { category: 'other', tone: 'mild', severity: 1, areas: [] });
    assert.equal(otherAlone.cause, 'other');
    assert.equal(otherAlone.cause_by, 'claude', 'read once, never re-sent just for a cause');
  });

  test("Launch27 facts: the regular cleaner who stopped working, and what they point at", () => {
    const DAY = 86_400_000;
    const at = Date.parse('2026-06-01T15:00:00Z');
    const v = (d, id) => ({ id: 3000 + d, at: at + d * DAY, date: '', revenue: 150, freq: 'Weekly', teams: [{ id, name: `Cleaner ${id}` }] });
    const client = [v(-56, 5), v(-49, 5), v(-42, 5), v(-35, 5), v(-7, 8)];
    const everyone = [...client, v(-20, 8), v(30, 8)];
    const j = journeyAt(client, at, { cleanerLastWorked: cleanerLastWorkedIndex(everyone, at + 60 * DAY), dataTo: at + 60 * DAY });
    assert.equal(j.regular_cleaner_name, 'Cleaner 5');
    assert.equal(j.regular_cleaner_left, true);
    assert.equal(j.regular_cleaner_last_worked, new Date(at - 35 * DAY).toISOString().slice(0, 10));
    const stillHere = journeyAt(client, at, { cleanerLastWorked: cleanerLastWorkedIndex([...everyone, v(10, 5)], at + 60 * DAY), dataTo: at + 60 * DAY });
    assert.equal(stillHere.regular_cleaner_left, false, 'still working with other clients');
    const tooSoon = journeyAt(client, at, { cleanerLastWorked: cleanerLastWorkedIndex(everyone, at), dataTo: at - 20 * DAY });
    assert.equal(tooSoon.regular_cleaner_left, false, 'a short gap at the end of the data is not leaving');
    assert.equal(regularCleaner([v(-7, 8)]), null, 'one visit is nobody\'s regular');
    const facts = causeFacts({ ...j, cleaner_changed_last_visit: true, distinct_cleaners_90d: 2, cleaner_visits_before: 4 });
    assert.deepEqual(facts.map((f) => f.cause), ['regular_left', 'changed_unannounced', 'new_cleaner']);
    assert.match(facts[0].text, /Cleaner 5/);
  });

  test('the playbook by cause: one row per cause, contributing counted beside it, categories inside', () => {
    const cases = [];
    const outcomes = [];
    const add = (category, cause, contributing = [], outcome = 'saved') => {
      const id = cases.length + 1;
      cases.push({ id, source: 'kustomer', opened_at: '2026-06-10T12:00:00Z', category, cause, contributing_causes: contributing, cause_by: cause ? 'claude' : null, l27_customer_id: 900 + id, classified_by: 'claude' });
      outcomes.push({ case_id: id, day: 60, outcome });
    };
    add('quality_missed', 'regular_left', ['missed_areas'], 'lost');
    add('cleaner_change', 'regular_left', [], 'lost');
    add('quality_missed', 'missed_areas');
    add('communication', 'marketing_emails');
    add('punctuality', null);
    const pb = buildPlaybook({ cases, resolutions: [], costs: [], outcomes, visits: [], from: '2026-05-01', to: '2026-10-31', settings: normalizeSettings({}), today: '2026-11-27' });
    const left = pb.by_cause.find((x) => x.key === 'regular_left');
    assert.equal(left.n, 2);
    assert.deepEqual(left.ids, [1, 2]);
    assert.equal(left.lost_n, 2);
    assert.deepEqual(left.by_category.map((c) => c.key).sort(), ['cleaner_change', 'quality_missed']);
    assert.equal(left.group, 'consistency');
    const missed = pb.by_cause.find((x) => x.key === 'missed_areas');
    assert.equal(missed.n, 1);
    assert.deepEqual(missed.contributing_ids, [1]);
    assert.equal(pb.by_cause.at(-1).key, 'unset', 'cases with no cause yet come last');
    assert.equal(pb.cause_groups.find((g) => g.key === 'consistency').n, 2);
    assert.equal(pb.cause_groups.find((g) => g.key === 'communication').n, 1);
    assert.ok(pb.taxonomy.find((t) => t.key === 'quality_missed').cheapest_that_works, 'the category table is unchanged');
  });

  test('cause accuracy is measured separately, by cause and by who set it', () => {
    const rows = [
      ...Array.from({ length: 3 }, () => ({ verdict: 'correct', was_category: 'quality_missed', was_cause: 'regular_left', was_cause_by: 'claude', now_cause: 'regular_left', cause_verdict: 'correct', source: 'kustomer' })),
      { verdict: 'correct', was_category: 'quality_missed', was_cause: 'missed_areas', was_cause_by: 'rules', now_cause: 'replacement_quality', cause_verdict: 'wrong', source: 'kustomer' },
      { verdict: 'correct', was_category: 'quality_missed', source: 'gmail' },
    ];
    const s = buildReviewStats(rows);
    assert.equal(s.cause.total.checked, 4, 'checks that skipped the cause are not counted');
    assert.equal(s.cause.total.accuracy, 0.75);
    assert.equal(s.cause.by_cause.find((c) => c.key === 'regular_left').accuracy, 1);
    assert.equal(s.cause.by_setter.find((c) => c.key === 'rules').wrong, 1);
    assert.deepEqual(s.cause.confusions, [{ from: 'missed_areas', to: 'replacement_quality', n: 1 }]);
  });

  test('checking a cause fixes the case, is measured against the engine, and survives a later run', async () => {
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const fetchImpl = createMockLaunch27({ password: 'demo' });
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet });
    const reports = createReports({ db, config, fetchImpl, schedule, log: quiet });
    await schedule.sync();
    await reports.sync();
    const to = (await reports.visitsSnapshot()).to;
    const from = new Date(Date.parse(to) - 182 * 86_400_000).toISOString().slice(0, 10);
    const complaints = createComplaints({ db, config, reports, fetchImpl, log: quiet });
    await complaints.run({ from, to });
    const queue = await complaints.reviewQueue({ per: 5 });
    assert.ok(queue.length >= 2);
    assert.ok(queue.every((c) => Array.isArray(c.facts)), 'Launch27 facts come with every case to check');
    const [a, b] = queue;
    await complaints.reviewCase(a.id, { verdict: 'correct', cause: a.cause || 'other' }, null);
    const pick = b.cause === 'language' ? 'team_size' : 'language';
    await complaints.reviewCase(b.id, { verdict: 'correct', cause: pick, contributing: ['marketing_emails', pick, 'marketing_emails'] }, null);
    const stats = await complaints.reviewStats();
    assert.equal(stats.cause.total.checked, 2);
    assert.equal(stats.cause.total.correct, 1);
    const fixed = await complaints.getCase(b.id);
    assert.equal(fixed.cause, pick);
    assert.equal(fixed.cause_by, 'human');
    assert.deepEqual(fixed.contributing_causes, ['marketing_emails']);
    assert.ok((await complaints.listCases({ from, to, cause: pick })).some((c) => c.id === b.id), 'the case list filters by cause');
    await complaints.run({ from, to });
    assert.equal((await complaints.getCase(b.id)).cause, pick, "a later run doesn't undo a person's cause");
    const pb = await complaints.playbook({ from, to });
    assert.ok(pb.by_cause.find((x) => x.key === pick).ids.includes(b.id));
    await db.close();
  });
});

describe('complaints: solution mining (what we offered, and how the client took it)', () => {
  test('threads read as CLIENT / US / NOTE; offers map onto the ladder; bad output is cleaned', () => {
    const t = formatThread([
      { kind: 'message', direction: 'in', body: 'The bathroom was skipped.', created_at: '2026-10-01T14:00:00Z', channel: 'email' },
      { kind: 'message', direction: 'out', body: 'So sorry! We can send a reclean Thursday.', created_at: '2026-10-01T15:00:00Z', channel: 'email' },
      { kind: 'note', direction: null, body: 'Refunded 30%.', created_at: '2026-10-02T15:00:00Z' },
      { kind: 'message', direction: 'in', body: '   ', created_at: '2026-10-02T16:00:00Z' },
    ]);
    assert.match(t, /^CLIENT \(2026-10-01, email\):\nThe bathroom was skipped\./);
    assert.match(t, /US \(2026-10-01, email\):\nSo sorry/);
    assert.match(t, /NOTE \(2026-10-02\):\nRefunded 30%\./);
    assert.equal(t.split('\n\n').length, 3, 'empty messages are left out');
    assert.deepEqual(offerToResolution({ kind: 'partial_refund', pct: 30 }), { rung: 'L5', action: 'refund', pct: 30, amount: null });
    assert.equal(offerToResolution({ kind: 'credit', amount: 5 }).rung, 'L1');
    assert.equal(offerToResolution({ kind: 'reclean' }).action, 'reclean_full');
    assert.equal(offerToResolution({ kind: 'same_cleaner' }), null, 'not a ladder step');
    const n = normalizeSolution({ asked_for: 'bogus', offers: [{ kind: 'reclean', amount: null, pct: 140, detail: 'x', client_response: 'maybe' }, { kind: 'nope' }], final_kind: 'none', client_end: 'meh', said_will_leave: 1, handling: '' });
    assert.equal(n.asked_for, 'nothing_specific');
    assert.equal(n.offers.length, 1);
    assert.deepEqual([n.offers[0].pct, n.offers[0].client_response], [100, 'unclear']);
    assert.deepEqual([n.final_kind, n.client_end, n.said_will_leave, n.handling], [null, 'unknown', true, null]);
  });

  test('the playbook view: per offer, taken or pushed back, final answers, how clients ended, who stayed', () => {
    const cases = [1, 2, 3, 4].map((id) => ({ id, source: 'kustomer', opened_at: '2026-06-10T12:00:00Z', category: 'quality_missed', l27_customer_id: 700 + id, classified_by: 'claude' }));
    const outcomes = cases.map((c) => ({ case_id: c.id, day: 60, outcome: c.id === 3 ? 'lost' : 'saved' }));
    const solutions = [
      { case_id: 1, read_by: 'claude', asked_for: 'partial_refund', offers: [{ kind: 'reclean', client_response: 'declined' }, { kind: 'partial_refund', pct: 30, client_response: 'accepted' }], final_kind: 'partial_refund', client_end: 'satisfied' },
      { case_id: 2, read_by: 'claude', asked_for: 'nothing_specific', offers: [{ kind: 'reclean', client_response: 'accepted' }], final_kind: 'reclean', client_end: 'satisfied' },
      { case_id: 3, read_by: 'claude', asked_for: 'nothing_specific', offers: [{ kind: 'reclean', client_response: 'accepted' }], final_kind: 'reclean', client_end: 'unhappy', said_will_leave: true },
      { case_id: 4, read_by: 'none', offers: [] },
    ];
    const pb = buildPlaybook({ cases, resolutions: [], costs: [], outcomes, solutions, visits: [], from: '2026-05-01', to: '2026-10-31', settings: normalizeSettings({}), today: '2026-11-27', mining: true });
    const s = pb.solutions;
    assert.deepEqual([s.enabled, s.read, s.no_thread, s.not_yet], [true, 3, 1, 0]);
    const rec = s.offers.find((o) => o.key === 'reclean');
    assert.deepEqual([rec.offered, rec.accepted, rec.pushed_back, rec.accept_rate], [3, 2, 1, 0.667]);
    assert.deepEqual([rec.final.n, rec.final.saved_n, rec.final.lost_n, rec.ended_happy], [2, 1, 1, 0.5]);
    const ref = s.offers.find((o) => o.key === 'partial_refund');
    assert.deepEqual([ref.asked_for, ref.final.n, ref.ended_happy], [1, 1, 1]);
    assert.equal(s.offers[0].key, 'reclean', 'the most common final answer first');
    assert.deepEqual(s.said_will_leave_ids, [3]);
    assert.deepEqual(s.pushed_back_first_ids, [1]);
    assert.deepEqual(s.endings.satisfied, [1, 2]);
  });

  test('a case is matched to the client\'s conversation, read once, and read again when the thread grows', async () => {
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const fetchImpl = createMockLaunch27({ password: 'demo' });
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet });
    const reports = createReports({ db, config, fetchImpl, schedule, log: quiet });
    await schedule.sync();
    await reports.sync();
    const to = (await reports.visitsSnapshot()).to;
    const from = new Date(Date.parse(to) - 182 * 86_400_000).toISOString().slice(0, 10);
    const seen = [];
    const solutionReader = async (thread, { complaint }) => {
      seen.push({ thread, complaint });
      return { asked_for: 'nothing_specific', offers: [{ kind: 'credit', amount: 10, pct: null, detail: '$10 off', client_response: 'declined' }, { kind: 'reclean', amount: null, pct: null, detail: 'reclean Thursday', client_response: 'accepted' }], final_kind: 'reclean', final_detail: 'reclean done', client_end: 'satisfied', said_will_leave: false, said_will_stay: true, handling: 'Answered the same day.' };
    };
    const complaints = createComplaints({ db, config, reports, fetchImpl, log: quiet, solutionReader });
    await complaints.run({ from, to });
    const all = await complaints.listCases({ from, to });
    const target = all.find((c) => c.l27_customer_id);
    assert.ok(target, 'needs a case linked to a Launch27 client');
    let st = await db.query('SELECT count(*)::int AS n FROM complaint_solutions');
    assert.equal(st.rows[0].n, all.length, 'every case was looked at during the run');
    assert.equal(seen.length, 0, 'no conversations on file yet: nothing sent to Claude');

    // The migrated conversation for that client, around the complaint.
    const contact = (await db.query("INSERT INTO contacts (name, l27_customer_id) VALUES ('Test Client', $1) RETURNING id", [target.l27_customer_id])).rows[0].id;
    const conv = (await db.query("INSERT INTO conversations (contact_id, channel, source, source_id) VALUES ($1, 'email', 'kustomer', 'k-1') RETURNING id", [contact])).rows[0].id;
    const at = Date.parse(target.opened_at);
    const msg = (offsetH, kind, direction, body) => db.query('INSERT INTO messages (conversation_id, kind, direction, body, created_at) VALUES ($1, $2, $3, $4, $5)', [conv, kind, direction, body, new Date(at + offsetH * 3_600_000).toISOString()]);
    await msg(1, 'message', 'in', 'Test Client here. The kitchen was not cleaned at all.');
    await msg(3, 'message', 'out', 'Sorry! $10 off your next clean?');
    await msg(5, 'message', 'in', 'I would rather have someone come back.');
    await msg(6, 'message', 'out', 'Of course, a reclean on Thursday.');
    await msg(7, 'note', null, 'Reclean booked.');
    await msg(24 * 60, 'message', 'in', 'Unrelated, two months later.');
    await db.query('DELETE FROM complaint_solutions WHERE case_id = $1', [target.id]);

    let r = await complaints.mineSolutions();
    assert.equal(r.read, 1);
    assert.equal(seen.length, 1);
    assert.match(seen[0].thread, /CLIENT .*\n.*kitchen was not cleaned/);
    assert.match(seen[0].thread, /NOTE .*\nReclean booked\./);
    assert.ok(!/Test Client/.test(seen[0].thread), 'names are redacted before Claude');
    assert.ok(!/two months later/.test(seen[0].thread), 'only around the complaint');
    const d = await complaints.getCase(target.id);
    assert.deepEqual([d.solution.read_by, d.solution.thread_messages, d.solution.final_kind, d.solution.client_end], ['claude', 5, 'reclean', 'satisfied']);
    assert.ok(d.resolutions.some((x) => x.source === 'conversation' && x.action === 'reclean_full' && x.accepted === 'yes'), 'what the client took becomes what we did');
    assert.ok(!d.resolutions.some((x) => x.source === 'conversation' && x.action === 'credit'), 'a declined offer is not what we did');

    // Nothing new: not sent again. A new message in the thread of a recent case: read again.
    await db.query("UPDATE complaint_solutions SET mined_at = now() - interval '2 days' WHERE case_id = $1", [target.id]);
    r = await complaints.mineSolutions();
    assert.equal(seen.length, 1, 'an unchanged thread is not sent again');
    await db.query('UPDATE complaint_cases SET opened_at = now() - interval \'3 days\' WHERE id = $1', [target.id]);
    await db.query("UPDATE complaint_solutions SET mined_at = now() - interval '2 days' WHERE case_id = $1", [target.id]);
    await db.query('INSERT INTO messages (conversation_id, kind, direction, body, created_at) VALUES ($1, \'message\', \'in\', \'Thanks, all good now.\', now())', [conv]);
    r = await complaints.mineSolutions();
    assert.equal(seen.length, 2, 'a grown thread is read again');
    const pb = await complaints.playbook({ from: '2000-01-01', to: '2999-12-31' });
    assert.ok(pb.solutions.read >= 1);
    assert.ok(pb.solutions.offers.find((o) => o.key === 'reclean').final.ids.includes(target.id));
    st = await db.query("SELECT count(*)::int AS n FROM complaint_resolutions WHERE case_id = $1 AND source = 'conversation'", [target.id]);
    assert.equal(st.rows[0].n, 1, 're-reading replaces, never doubles');
    await db.close();
  });
});

describe('complaints: ranked responses for a new complaint', () => {
  // n cases of a response, k of them kept, in a category/cause, optional cost / happiness / offers.
  let id = 0;
  const mk = (response, n, k, { category = 'quality_missed', cause = 'regular_left', cost = 0, happy = null, one_time = false, offered = [] } = {}) =>
    Array.from({ length: n }, (_, i) => ({ id: ++id, category, cause, one_time, response, from_conversation: true, kept: i < k ? 1 : 0, happy, cost, offered, opened_at: null }));

  test('past cases: the final answer from the conversation, else the ladder; kept from the outcome', () => {
    const rows = caseRows({
      cases: [{ id: 1, category: 'quality_missed' }, { id: 2, category: 'quality_missed' }, { id: 3, category: 'punctuality', one_time: true }, { id: 4, category: 'other' }],
      resolutions: [{ case_id: 1, rung: 'L3' }, { case_id: 2, rung: 'L2' }, { case_id: 2, rung: 'L5' }],
      costs: [{ case_id: 2, amount: '40' }, { case_id: 2, amount: '10' }],
      outcomes: [{ case_id: 1, day: 60, outcome: 'saved' }, { case_id: 2, day: 60, outcome: 'partial_save' }, { case_id: 3, day: 120, outcome: 'not_rebooked' }],
      solutions: [{ case_id: 1, read_by: 'claude', final_kind: 'same_cleaner', client_end: 'satisfied', offers: [{ kind: 'credit', client_response: 'declined' }] }],
    });
    assert.deepEqual(rows.map((r) => r.response), ['same_cleaner', 'partial_refund', 'apology', 'apology']);
    assert.deepEqual(rows.map((r) => r.kept), [1, 0, 0, null], 'an old partial save counts as lost: no half credit');
    assert.equal(rows[1].cost, 50);
    assert.equal(rows[0].happy, true);
    assert.equal(rows[2].one_time, true);
  });

  test('three lucky cases do not outrank forty solid ones; small samples are graded Low', () => {
    const rows = [...mk('full_refund', 3, 3), ...mk('reclean', 40, 32), ...mk('credit', 10, 4)];
    const r = rankResponses(rows, { category: 'quality_missed', cause: 'regular_left' });
    assert.deepEqual(r.options.map((o) => o.response), ['reclean', 'credit', 'full_refund'], 'proven responses first; 3 of 3 is not proven');
    assert.equal(r.options[0].group, 'cause_category');
    assert.deepEqual([r.options[0].kept, r.options[0].decided, r.options[0].grade], [0.8, 40, 'High']);
    assert.equal(r.options[2].grade, 'Low');
  });

  test('each response is measured in the closest group with enough outcomes', () => {
    const rows = [
      ...mk('reclean', 6, 5),
      ...mk('partial_refund', 2, 2), // too few with this cause and category…
      ...mk('partial_refund', 8, 6, { category: 'punctuality' }), // …but enough with this cause
      ...mk('apology', 20, 6, { cause: 'missed_areas' }),
    ];
    const r = rankResponses(rows, { category: 'quality_missed', cause: 'regular_left' });
    const by = Object.fromEntries(r.options.map((o) => [o.response, o]));
    assert.equal(by.reclean.group, 'cause_category');
    assert.deepEqual([by.partial_refund.group, by.partial_refund.decided], ['cause', 10]);
    assert.equal(by.apology.group, 'category');
    assert.ok(r.groups.find((g) => g.key === 'all').cases === 36);
    const noCause = rankResponses(rows, { category: 'quality_missed', cause: null });
    assert.ok(!noCause.groups.some((g) => g.key.startsWith('cause')), 'no cause: category, then all');
  });

  test('ties go to the happier ending, then the cheaper; the best-value option is flagged', () => {
    const rows = [...mk('reclean', 20, 15, { cost: 90, happy: true }), ...mk('credit', 20, 15, { cost: 10, happy: false }), ...mk('partial_refund', 20, 15, { cost: 120, happy: true })];
    const r = rankResponses(rows, { category: 'quality_missed', cause: 'regular_left' });
    assert.deepEqual(r.options.map((o) => o.response), ['reclean', 'partial_refund', 'credit']);
    assert.equal(r.options.find((o) => o.response === 'credit').best_value, true);
  });

  test('one-time clients are ranked only on one-time clients; first offers that get turned down are noted', () => {
    const turnedDown = [{ kind: 'credit', response: 'declined' }, { kind: 'reclean', response: 'accepted' }];
    const rows = [...mk('reclean', 10, 8, { offered: turnedDown }), ...mk('credit', 10, 9, { one_time: true })];
    const recurring = rankResponses(rows, { category: 'quality_missed', cause: 'regular_left' });
    assert.deepEqual(recurring.options.map((o) => o.response), ['reclean']);
    assert.equal(recurring.options[0].taken_when_offered, 1);
    const oneTime = rankResponses(rows, { category: 'quality_missed', cause: 'regular_left', one_time: true });
    assert.deepEqual(oneTime.options.map((o) => o.response), ['credit']);
    const credit = rankResponses([...mk('credit', 6, 3, { offered: turnedDown }), ...mk('reclean', 6, 5, { offered: turnedDown })], { category: 'quality_missed', cause: 'regular_left' });
    assert.equal(credit.options.find((o) => o.response === 'credit').first_turned_down, 1, 'credit was the first offer and got turned down');
  });

  test('the service ranks from every stored case', async () => {
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const fetchImpl = createMockLaunch27({ password: 'demo' });
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet });
    const reports = createReports({ db, config, fetchImpl, schedule, log: quiet });
    await schedule.sync();
    await reports.sync();
    const to = (await reports.visitsSnapshot()).to;
    const from = new Date(Date.parse(to) - 182 * 86_400_000).toISOString().slice(0, 10);
    const complaints = createComplaints({ db, config, reports, fetchImpl, log: quiet });
    await complaints.run({ from, to });
    const cases = await complaints.listCases({ from, to });
    const cat = cases.find((c) => !c.hard_route)?.category;
    const r = await complaints.rankFor({ category: cat, cause: null, one_time: false });
    assert.ok(r.groups.some((g) => g.key === 'category'));
    assert.ok(r.options.every((o, i) => o.rank === i + 1 && o.cases > 0));
    await db.close();
  });
});

describe('complaints: threats to leave or to post a review', () => {
  test('a review threat outranks a threat to leave; saying so in the conversation counts', () => {
    assert.deepEqual([threatOf('threat_review', true), threatOf('threat_leave'), threatOf('angry', true), threatOf('angry')], ['review', 'leave', 'leave', 'none']);
    const rows = caseRows({ cases: [{ id: 1, category: 'quality_missed', tone: 'mild' }, { id: 2, category: 'quality_missed', tone: 'threat_review' }], solutions: [{ case_id: 1, read_by: 'claude', final_kind: 'reclean', said_will_leave: true, offers: [] }] });
    assert.deepEqual(rows.map((r) => r.threat), ['leave', 'review']);
  });

  test('a threatening client is ranked first on past clients who made the same threat', () => {
    let id = 0;
    const mk = (response, n, k, threat) => Array.from({ length: n }, (_, i) => ({ id: ++id, category: 'quality_missed', cause: null, threat, one_time: false, response, from_conversation: true, kept: i < k ? 1 : 0, happy: null, cost: 0, offered: [], opened_at: null }));
    // No threat: a reclean keeps nearly everyone. Under a review threat it doesn't; a refund does.
    const rows = [...mk('reclean', 30, 27, 'none'), ...mk('partial_refund', 30, 21, 'none'), ...mk('reclean', 10, 3, 'review'), ...mk('partial_refund', 10, 8, 'review')];
    const calm = rankResponses(rows, { category: 'quality_missed', threat: 'none' });
    assert.equal(calm.options[0].response, 'reclean');
    assert.ok(!calm.groups.some((g) => g.key.startsWith('threat')));
    const review = rankResponses(rows, { category: 'quality_missed', threat: 'review' });
    assert.deepEqual([review.options[0].response, review.options[0].group, review.options[0].kept], ['partial_refund', 'threat_category', 0.8]);
    assert.equal(review.threat, 'review');
    // Too few past threats of this kind: falls back to everyone, and says which group it used.
    const leave = rankResponses(rows, { category: 'quality_missed', threat: 'leave' });
    assert.deepEqual([leave.options[0].response, leave.options[0].group], ['reclean', 'category']);
  });

  test('the playbook splits what each response did by threat level', () => {
    const cases = [];
    const outcomes = [];
    const resolutions = [];
    const add = (tone, rung, outcome) => {
      const id = cases.length + 1;
      cases.push({ id, source: 'kustomer', opened_at: '2026-06-10T12:00:00Z', category: 'quality_missed', tone, l27_customer_id: 800 + id, classified_by: 'claude' });
      if (rung) resolutions.push({ case_id: id, rung, action: rung === 'L3' ? 'reclean_full' : 'refund' });
      outcomes.push({ case_id: id, day: 60, outcome });
    };
    add('mild', 'L3', 'saved');
    add('threat_review', 'L3', 'lost');
    add('threat_review', 'L5', 'saved');
    add('angry', null, 'saved');
    const solutions = [{ case_id: 4, read_by: 'claude', final_kind: 'same_cleaner', said_will_leave: true, offers: [] }];
    const pb = buildPlaybook({ cases, resolutions, costs: [], outcomes, solutions, visits: [], from: '2026-05-01', to: '2026-10-31', settings: normalizeSettings({}), today: '2026-11-27' });
    const by = Object.fromEntries(pb.threats.map((t) => [t.key, t]));
    assert.deepEqual([by.none.n, by.leave.n, by.review.n], [1, 1, 2]);
    assert.deepEqual(by.review.by_response.map((r) => [r.response, r.saved_n, r.lost_n]).sort(), [['partial_refund', 1, 0], ['reclean', 0, 1]]);
    assert.equal(by.leave.by_response[0].response, 'same_cleaner', 'the final answer from the conversation');
    assert.deepEqual(by.review.ids, [2, 3]);
  });
});

describe('complaints: client value', () => {
  test('each option is weighed against what this client is worth', () => {
    let id = 0;
    const mk = (response, n, k, cost) => Array.from({ length: n }, (_, i) => ({ id: ++id, category: 'quality_missed', cause: null, threat: 'none', one_time: false, response, from_conversation: true, kept: i < k ? 1 : 0, happy: null, cost, offered: [], opened_at: null }));
    // A full refund keeps more clients but costs $180; a credit keeps fewer for $10.
    const rows = [...mk('full_refund', 20, 18, 180), ...mk('credit', 20, 14, 10)];
    const big = rankResponses(rows, { category: 'quality_missed', value: 9000 });
    assert.equal(big.client_value, 9000);
    assert.equal(big.options.find((o) => o.best_net).response, 'full_refund', 'worth it for a $9,000 client');
    const small = rankResponses(rows, { category: 'quality_missed', value: 300 });
    assert.equal(small.options.find((o) => o.best_net).response, 'credit', 'not worth it for a $300 client');
    assert.equal(small.options[0].response, 'full_refund', 'the order by clients kept does not change');
    const o = small.options.find((x) => x.response === 'credit');
    assert.equal(o.net_value, Math.round(o.score * 300 - 10));
    const none = rankResponses(rows, { category: 'quality_missed' });
    assert.ok(none.options.every((x) => x.net_value === undefined && !x.best_net));
  });

  test("a plan's yearly worth: usual visit price times visits a year; one visit for a one-time client", () => {
    const v = (revenue, freq, i) => ({ id: i, at: i * 86_400_000, revenue, freq, teams: [] });
    assert.deepEqual(planValue([v(320, 'Biweekly - 10% off', 1)]), { visit_price: 320, plan_value: 8320 }, 'only the first deep clean on file');
    assert.deepEqual(planValue([v(320, 'Biweekly', 1), v(150, 'Biweekly', 2), v(150, 'Biweekly', 3)]), { visit_price: 150, plan_value: 3900 }, 'the usual price, not the first deep clean');
    assert.deepEqual(planValue([v(160, 'Weekly - 15% off', 1), v(0, 'Weekly - 15% off', 2)]), { visit_price: 160, plan_value: 8320 }, 'a free reclean is not the price');
    assert.deepEqual(planValue([v(180, 'Every 4 weeks / Monthly', 1)]), { visit_price: 180, plan_value: 2340 });
    assert.deepEqual(planValue([v(240, 'One Time', 1)]), { visit_price: 240, plan_value: 240 });
    assert.deepEqual(planValue([]), { visit_price: null, plan_value: null });
    assert.deepEqual([valueTier(null), valueTier(240, true), valueTier(2340), valueTier(3900), valueTier(8320)], [null, 'one', 'low', 'mid', 'high']);
  });

  test('the playbook splits responses by plan value, one-time clients apart', () => {
    const cases = [];
    const outcomes = [];
    const add = (plan, outcome, one_time = false) => {
      const id = cases.length + 1;
      cases.push({ id, source: 'kustomer', opened_at: '2026-06-10T12:00:00Z', category: 'quality_missed', plan_value: plan, one_time, l27_customer_id: 600 + id, classified_by: 'claude' });
      outcomes.push({ case_id: id, day: one_time ? 120 : 60, outcome });
    };
    add('2340', 'lost');
    add('7800', 'saved');
    add('8320', 'saved');
    add('240', 'not_rebooked', true);
    add(null, 'saved');
    const pb = buildPlaybook({ cases, resolutions: [], costs: [], outcomes, visits: [], from: '2026-05-01', to: '2026-10-31', settings: normalizeSettings({}), today: '2026-11-27' });
    const by = Object.fromEntries(pb.value_tiers.map((t) => [t.key, t]));
    assert.deepEqual([by.one.n, by.low.n, by.mid.n, by.high.n, by.high.avg_spend, by.high.saved_n], [1, 1, 0, 2, 8060, 2]);
    assert.deepEqual(pb.value_unknown_ids, [5]);
  });
});

describe('complaints: Google reviews', () => {
  // Made-up reviewers, in the format of a Google Business Profile export (reviews-….json).
  const file = (rows) => ({ reviews: rows.map(([name, stars, at, comment], i) => ({ reviewer: { displayName: name }, starRating: stars, comment, createTime: at, updateTime: at, reviewReply: i === 0 ? { comment: 'Sorry to hear this.', updateTime: at } : undefined, name: `accounts/1/locations/2/reviews/r${name.replace(/\W/g, '')}${at.slice(0, 10)}` })) });

  test('an export file is read; account files and broken rows give nothing', () => {
    const rows = parseTakeout(file([['Avery Sample', 'ONE', '2026-09-10T12:00:00Z', 'Missed everything.'], ['Blake Example', 'FIVE', '2026-09-11T12:00:00Z', undefined]]));
    assert.deepEqual(rows.map((r) => [r.reviewer_name, r.stars, r.comment, !!r.reply]), [['Avery Sample', 1, 'Missed everything.', true], ['Blake Example', 5, null, false]]);
    assert.deepEqual(parseTakeout({ name: 'accounts/1', accountName: 'Sample Parent', type: 'LOCATION_GROUP' }), []);
    assert.deepEqual(parseTakeout({ reviews: [{ reviewer: { displayName: 'No Id' }, starRating: 'ONE', createTime: '2026-01-01T00:00:00Z' }, { name: 'x', starRating: 'SIX', createTime: '2026-01-01T00:00:00Z' }, { name: 'y', starRating: 'TWO', createTime: 'not a date' }] }), []);
  });

  test('a review is matched by full name and date; single names and far-off dates are not', () => {
    assert.equal(nameKey('  Zoë  O\'Brien-Sample '), "zoe o'brien-sample");
    assert.deepEqual([nameKey('Isaac'), nameKey('FL'), nameKey('X')], [null, null, null]);
    const cases = [{ id: 1, customer_name: 'Avery Sample', opened_at: '2026-08-20T12:00:00Z' }, { id: 2, customer_name: 'AVERY  SAMPLE', opened_at: '2026-09-05T12:00:00Z' }, { id: 3, customer_name: 'Avery', opened_at: '2026-09-05T12:00:00Z' }];
    const rev = (name, at) => ({ reviewer_name: name, created_at: at });
    assert.equal(matchCase(rev('Avery Sample', '2026-09-10T12:00:00Z'), cases), 2, 'the closest complaint');
    assert.equal(matchCase(rev('Avery Sample', '2026-08-15T12:00:00Z'), cases), 1, 'posted first, complained a few days later');
    assert.equal(matchCase(rev('Avery Sample', '2027-02-01T12:00:00Z'), cases), null, 'months later is not about this complaint');
    assert.equal(matchCase(rev('Avery', '2026-09-10T12:00:00Z'), cases), null, 'a first name alone never matches');
    assert.equal(matchCase(rev('Someone Else', '2026-09-10T12:00:00Z'), cases), null);
  });

  test('the playbook: which threats became reviews, and what we had done first', () => {
    const cases = [];
    const resolutions = [];
    const add = (tone, rung) => {
      const id = cases.length + 1;
      cases.push({ id, source: 'kustomer', opened_at: '2026-06-10T12:00:00Z', category: 'quality_missed', tone, l27_customer_id: 900 + id, classified_by: 'claude' });
      if (rung) resolutions.push({ case_id: id, rung, action: 'x' });
    };
    add('threat_review', 'L3');
    add('threat_review', 'L5');
    add('mild', null);
    add('mild', 'L3');
    const pb = buildPlaybook({ cases, resolutions, costs: [], outcomes: [], reviews: [{ case_id: 1, stars: 1 }, { case_id: 3, stars: 2 }, { case_id: 4, stars: 5 }], reviewTotals: { imported: 40, negative: 3, first_at: '2026-01-01T00:00:00Z', last_at: '2026-10-01T00:00:00Z' }, visits: [], from: '2026-05-01', to: '2026-10-31', settings: normalizeSettings({}), today: '2026-11-27' });
    const r = pb.reviews;
    assert.deepEqual([r.imported, r.imported_negative], [40, 3]);
    assert.deepEqual([r.low_ids, r.high_ids, r.threatened_posted_ids, r.threatened_not_posted_ids, r.low_without_threat_ids], [[1, 3], [4], [1], [2], [3]]);
    assert.deepEqual(r.low_by_response.map((x) => [x.response, x.n]).sort(), [['apology', 1], ['reclean', 1]]);
    assert.ok(pb.gaps.some((g) => /40 Google reviews imported/.test(g)));
  });

  test('importing matches reviews to cases, is safe to repeat, and a matched 1★ review makes the client LOST', async () => {
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const fetchImpl = createMockLaunch27({ password: 'demo' });
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet });
    const reports = createReports({ db, config, fetchImpl, schedule, log: quiet });
    await schedule.sync();
    await reports.sync();
    const to = (await reports.visitsSnapshot()).to;
    const from = new Date(Date.parse(to) - 182 * 86_400_000).toISOString().slice(0, 10);
    const complaints = createComplaints({ db, config, reports, fetchImpl, log: quiet });
    await complaints.run({ from, to });
    const all = await complaints.listCases({ from, to });
    const target = all.find((c) => c.client_type === 'recurring' && /\s/.test(c.customer_name || '') && all.filter((x) => x.customer_name === c.customer_name).length === 1);
    assert.ok(target, 'needs a recurring client with a full name and one case');
    const after = new Date(Date.parse(target.opened_at) + 5 * 86_400_000).toISOString();
    const upload = file([[target.customer_name.toUpperCase(), 'ONE', after, 'Never again.'], ['Nobody Known', 'TWO', after, 'Bad.'], ['Happy Person', 'FIVE', after, 'Great.']]);
    let r = await complaints.importReviews(upload, null);
    assert.deepEqual([r.read, r.added, r.matched], [3, 3, 1]);
    r = await complaints.importReviews(upload, null);
    assert.deepEqual([r.read, r.added, r.updated, r.matched], [3, 0, 3, 1], 'importing the same file again adds nothing');
    const s = await complaints.reviewsSummary();
    assert.deepEqual([s.imported, s.negative, s.matched, s.negative_matched], [3, 2, 1, 1]);
    assert.equal(s.low.find((x) => x.stars === 1).case_id, target.id);
    assert.equal(s.low.find((x) => x.stars === 2).case_id, null);
    await complaints.run({ from, to });
    const d = await complaints.getCase(target.id);
    assert.ok(d.outcomes.length > 0);
    assert.ok(d.outcomes.every((o) => o.outcome === 'lost' && o.public_review_stars === 1), 'a 1★ Google review is a lost client, whatever the bookings say');
    const pb = await complaints.playbook({ from, to });
    assert.deepEqual(pb.reviews.low_ids, [target.id]);
    await db.close();
  });
});

describe('complaints: coverage summary', () => {
  test('counts only: every section answers, with no names in it', async () => {
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const fetchImpl = createMockLaunch27({ password: 'demo' });
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet });
    const reports = createReports({ db, config, fetchImpl, schedule, log: quiet });
    await schedule.sync();
    await reports.sync();
    const to = (await reports.visitsSnapshot()).to;
    const from = new Date(Date.parse(to) - 182 * 86_400_000).toISOString().slice(0, 10);
    const lines = [];
    const complaints = createComplaints({ db, config, reports, fetchImpl, log: { ...quiet, info: (msg, a) => lines.push([msg, a]) } });
    await complaints.run({ from, to });
    const all = await complaints.listCases({ from, to });
    const c = await complaints.coverage();
    assert.equal(c.totals.cases, all.length);
    assert.equal(Object.values(c.by_source).reduce((a, b) => a + b, 0), all.length);
    assert.equal(Object.values(c.outcome_60).reduce((a, b) => a + b, 0), all.length, 'every case has one 60-day answer or "no_outcome_row"');
    assert.ok(!JSON.stringify(c).includes('"error"'), JSON.stringify(c).slice(0, 400));
    for (const n of all.map((x) => x.customer_name).filter(Boolean)) assert.ok(!JSON.stringify(c).includes(n), 'no client names');
    await complaints.logCoverage();
    assert.ok(lines.some(([m, a]) => m === 'complaints coverage' && a.section === 'totals'));
    await db.close();
  });
});

describe('complaints: tying unmatched cases to clients', () => {
  test('through a contact, a contact\'s name, or the sender\'s full name; never a first name, a shared name or our own staff', async () => {
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const fetchImpl = createMockLaunch27({ password: 'demo' });
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet });
    const reports = createReports({ db, config, fetchImpl, schedule, log: quiet });
    await schedule.sync();
    await reports.sync();
    const snap = await reports.visitsSnapshot();
    const to = snap.to;
    const from = new Date(Date.parse(to) - 182 * 86_400_000).toISOString().slice(0, 10);
    const complaints = createComplaints({ db, config, reports, fetchImpl, log: quiet });
    await complaints.run({ from, to });
    // Three Residential clients whose full name nobody else has, with visits a year back.
    const cov0 = await complaints.coverage();
    const names = new Map();
    for (const v of snap.visits) names.set(v.customer, (names.get(v.customer) || new Set()).add(v.customer_id));
    const all = await complaints.listCases({ from: '2000-01-01', to: '2999-12-31' });
    const known = all.filter((c) => c.l27_customer_id && /\S+\s+\S+/.test(c.customer_name || '') && names.get(c.customer_name)?.size === 1);
    assert.ok(known.length >= 3, 'needs three matched clients with unique full names');
    const [A, B, C] = known;
    const opened = new Date(Date.parse(to) - 100 * 86_400_000).toISOString();
    const add = async (key, name, email) => Number((await db.query(
      `INSERT INTO complaint_cases (brand, source, source_id, opened_at, status, category, customer_name, customer_email, classified_by) VALUES ('residential', 'gmail', $1, $2, 'resolved', 'quality_missed', $3, $4, 'rules') RETURNING id`,
      [`test:${key}`, opened, name, email],
    )).rows[0].id);
    const viaContact = await add('a', 'Somebody Else', 'other-address@example.com');
    const viaContactName = await add('b', null, 'second-address@example.com');
    const viaName = await add('c', C.customer_name.toUpperCase(), 'unknown@example.com');
    const firstNameOnly = await add('d', C.customer_name.split(' ')[0], 'nobody@example.com');
    const ourOwn = await add('e', C.customer_name, 'agent@urbanmop.ca');
    const k1 = (await db.query('INSERT INTO contacts (name, l27_customer_id) VALUES ($1, $2) RETURNING id', ['Whoever', A.l27_customer_id])).rows[0].id;
    await db.query("INSERT INTO contact_identities (contact_id, kind, value) VALUES ($1, 'email', 'other-address@example.com')", [k1]);
    const k2 = (await db.query('INSERT INTO contacts (name) VALUES ($1) RETURNING id', [B.customer_name])).rows[0].id;
    await db.query("INSERT INTO contact_identities (contact_id, kind, value) VALUES ($1, 'email', 'second-address@example.com')", [k2]);

    await complaints.run({ from, to });
    const get = async (id) => (await db.query('SELECT l27_customer_id, client_match FROM complaint_cases WHERE id = $1', [id])).rows[0];
    assert.deepEqual([Number((await get(viaContact)).l27_customer_id), (await get(viaContact)).client_match], [Number(A.l27_customer_id), 'contact']);
    assert.deepEqual([Number((await get(viaContactName)).l27_customer_id), (await get(viaContactName)).client_match], [Number(B.l27_customer_id), 'contact_name']);
    assert.deepEqual([Number((await get(viaName)).l27_customer_id), (await get(viaName)).client_match], [Number(C.l27_customer_id), 'name']);
    assert.equal((await get(firstNameOnly)).l27_customer_id, null, 'a first name alone never matches');
    assert.equal((await get(ourOwn)).l27_customer_id, null, 'our own staff are not clients');
    // Tied outside the run's dates, they still get a journey and an outcome.
    const d = await complaints.getCase(viaContact);
    assert.ok(d.journey, 'journey computed for the newly tied case');
    assert.ok(d.outcomes.length > 0, 'and an outcome');
    const cov = await complaints.coverage();
    assert.equal(cov.totals.matched_client, cov0.totals.matched_client + 3);
    assert.deepEqual([cov.matched_how.contact, cov.matched_how.contact_name, cov.matched_how.name], [1, 1, 1]);
    assert.equal(cov.unmatched_have.from_our_own_address, 1);
    await db.close();
  });
});

describe('complaints: step 0 diagnostics', () => {
  test('per-response snapshot, month counts and the unmatched sample log no names or addresses', async () => {
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const fetchImpl = createMockLaunch27({ password: 'demo' });
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet });
    const reports = createReports({ db, config, fetchImpl, schedule, log: quiet });
    await schedule.sync();
    await reports.sync();
    const to = (await reports.visitsSnapshot()).to;
    const from = new Date(Date.parse(to) - 182 * 86_400_000).toISOString().slice(0, 10);
    const lines = [];
    const complaints = createComplaints({ db, config, reports, fetchImpl, log: { ...quiet, info: (msg, a) => lines.push([msg, a]) } });
    await complaints.run({ from, to });
    await db.query(`INSERT INTO complaint_cases (brand, source, source_id, opened_at, status, category, customer_name, customer_email, classified_by) VALUES ('residential', 'gmail', 'test:diag', now() - interval '80 days', 'resolved', 'quality_missed', 'Zed Unknownperson', 'zed.unknown@gmail.com', 'rules')`);
    lines.length = 0;
    const c = await complaints.logCoverage();
    assert.ok(Object.keys(c.by_month).every((k) => /^\d{4}_[A-Z][a-z]{2}$/.test(k)), Object.keys(c.by_month).join(','));
    assert.ok(Object.keys(c.per_response_before).some((k) => /^recurring /.test(k)));
    const first = Object.values(c.per_response_before)[0];
    assert.deepEqual(Object.keys(first), ['cases', 'decided', 'kept', 'partly', 'lost', 'avg_cost', 'with_cost', 'threat_review', 'threat_leave']);
    const sample = lines.filter(([m]) => m === 'complaints unmatched case').map(([, a]) => JSON.parse(a.value));
    const row = sample.find((r) => r.email === 'personal_mail' && r.sender_name_words === 2);
    assert.ok(row, JSON.stringify(sample).slice(0, 300));
    assert.deepEqual([row.sender_name_residential_clients, row.contacts_with_this_email, row.name_looks_like, row.l27_email_lookup], [0, 0, 'a_full_name', 'no_login']);
    const text = JSON.stringify(lines);
    assert.ok(!/zed|unknownperson|gmail\.com/i.test(text), 'no names or addresses in the log');
    assert.ok(!text.includes('"error"'), text.slice(0, 400));
    await db.close();
  });
});

describe('complaints: the numbers fix (Derek, Nov 28 2026)', () => {
  test('impossible cause and category pairs are never produced', () => {
    assert.equal(causeFits('marketing_emails', 'damage'), false);
    assert.equal(causeFits('marketing_emails', 'communication'), true);
    assert.equal(causeFits('missed_areas', 'conduct_safety'), false);
    assert.equal(causeFits('other', 'damage'), true);
    for (const c of CAUSES) assert.ok(CAUSE_FITS[c.key]?.length, `${c.key} has its categories`);
    // A system email's footer is not a complaint about marketing emails.
    const footer = classifyRules('The cleaner broke my lamp and it was damaged. To unsubscribe from these emails click here. Report spam.');
    assert.equal(footer.category, 'damage');
    assert.notEqual(footer.cause, 'marketing_emails');
    assert.equal(classifyRules('Please stop sending me so many emails, I want to unsubscribe.').cause, 'marketing_emails');
    // Claude proposing a cause that cannot explain the category is overruled.
    const m = mergeClassification(classifyRules('The cleaner scratched and damaged the floor.'), { category: 'damage', tone: 'angry', severity: 3, areas: [], cause: 'marketing_emails', contributing: ['missed_areas'], cause_evidence: 'x' });
    assert.deepEqual([m.category, m.cause, m.contributing], ['damage', 'other', []]);
  });

  test('a month is complete only when every day was read; the baseline averages complete months only', () => {
    assert.equal(monthRead('2026-06', [{ from: '2026-05-17', to: '2026-11-16' }]), true);
    assert.equal(monthRead('2026-05', [{ from: '2026-05-17', to: '2026-11-16' }]), false);
    assert.equal(monthRead('2026-02', [{ from: '2026-01-13', to: '2026-02-12' }, { from: '2026-02-13', to: '2026-03-15' }]), true, 'two runs that meet');
    const visits = ['2026-06', '2026-07', '2026-08'].map((m, i) => ({ id: i, date: `${m}-10`, at: Date.parse(`${m}-10T12:00:00Z`), revenue: 10000, teams: [] }));
    const baselineCosts = [
      { id: 1, opened_at: '2026-06-05T12:00:00Z', kind: 'refund', amount: '100' },
      { id: 2, opened_at: '2026-08-05T12:00:00Z', kind: 'reclean_labour', amount: '300' },
      { id: 3, opened_at: '2026-08-06T12:00:00Z', kind: null, amount: null },
    ];
    const pb = buildPlaybook({ cases: [], resolutions: [], costs: [], outcomes: [], visits, baselineCosts, readWindows: [{ from: '2026-06-01', to: '2026-06-30' }, { from: '2026-08-01', to: '2026-08-31' }], from: '2026-11-01', to: '2026-11-15', settings: normalizeSettings({}), today: '2026-11-16' });
    const b = pb.baseline;
    assert.deepEqual(b.months.map((m) => [m.month, m.cases, m.cost, m.complete]), [['2026-06', 1, 100, true], ['2026-07', 0, 0, false], ['2026-08', 2, 300, true]], 'every month has its cases, whatever dates the page shows');
    assert.deepEqual([b.included_months, b.incomplete_months], [['2026-06', '2026-08'], ['2026-07']]);
    assert.equal(b.average, 0.02, 'July, never read, does not drag the average down');
  });

  test('a rules change recomputes every case first, reading no source', async () => {
    const { planAuto } = await import('../src/complaints/service.js');
    const j = planAuto({ mined: [{ from: '2025-11-19', to: '2026-11-18' }], today: '2026-11-19', historyDays: 365, recentDone: '2026-11-19', rulesPending: true });
    assert.deepEqual([j.kind, j.from, j.to], ['rules', '2025-11-19', '2026-11-18']);
    assert.equal(planAuto({ mined: [{ from: '2025-11-19', to: '2026-11-18' }], today: '2026-11-19', historyDays: 365, recentDone: '2026-11-19' }), null);
  });

  test('end to end: recleans found only in a conversation get a cost; a failed run leaves its dates unread; impossible causes are cleared', async () => {
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const fetchImpl = createMockLaunch27({ password: 'demo' });
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet });
    const reports = createReports({ db, config, fetchImpl, schedule, log: quiet });
    await schedule.sync();
    await reports.sync();
    const to = (await reports.visitsSnapshot()).to;
    const from = new Date(Date.parse(to) - 182 * 86_400_000).toISOString().slice(0, 10);
    const complaints = createComplaints({ db, config, reports, fetchImpl, log: quiet });
    await complaints.run({ from, to });
    const all = await complaints.listCases({ from, to });
    const target = all.find((c) => c.l27_customer_id && Number(c.total_cost) === 0 && !/Reclean/.test(c.rungs || ''));
    assert.ok(target, 'needs a matched case with no cost and no reclean');
    // The conversation shows a reclean the client took; a cause that cannot explain the category.
    await db.query("INSERT INTO complaint_resolutions (case_id, step, rung, action, accepted, source, source_id) VALUES ($1, 4, 'L3', 'reclean_full', 'yes', 'conversation', $2)", [target.id, `conversation:case:${target.id}:0`]);
    await db.query("UPDATE complaint_cases SET category = 'damage', cause = 'marketing_emails', cause_by = 'rules', classified_by = 'human' WHERE id = $1", [target.id]);
    // An old travel line from before the rule change.
    await db.query("INSERT INTO complaint_costs (case_id, kind, amount, source, source_ref, estimated) VALUES ($1, 'reclean_travel', 8, 'model', 'old', true)", [target.id]);
    await complaints.run({ from, to, sources: false });
    const d = await complaints.getCase(target.id);
    const lines = d.costs.filter((k) => /^reclean/.test(k.kind));
    assert.deepEqual(lines.map((k) => k.kind), ['reclean_labour'], 'one labour line; no travel, no lost slot');
    assert.ok(Number(lines[0].amount) >= 2 * 15 && lines[0].estimated === true, `2 hours at the cleaner's rate, estimated: ${lines[0].amount}`);
    assert.equal(d.cause, null, 'the impossible cause was cleared');
    assert.ok(d.outcomes.every((o) => o.outcome !== 'partial_save'));
    // The rules-only pass is not "reading" those dates, and a run whose Kustomer read failed isn't either.
    const st = await complaints.status();
    assert.equal(st.mined.length, 1, 'only the real run counts as read');
    await db.query(`INSERT INTO complaint_runs (window_from, window_to, status, finished_at, log) VALUES ('2026-01-01', '2026-01-31', 'partial', now(), '[{"level":"error","msg":"Kustomer skipped: timeout"}]'::jsonb),
      ('2026-02-01', '2026-02-28', 'partial', now(), '[{"level":"error","msg":"Slack skipped: not_in_channel"}]'::jsonb)`);
    const after = (await complaints.status()).mined.map((m) => String(m.window_from).slice(0, 15));
    assert.equal(after.length, 2, 'the run where only Slack failed counts; the one where Kustomer failed does not');
    await db.close();
  });
});

describe('complaints: system senders', () => {
  test('subject lines are logged as templates only: no names, no numbers', async () => {
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const fetchImpl = createMockLaunch27({ password: 'demo' });
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet });
    const reports = createReports({ db, config, fetchImpl, schedule, log: quiet });
    const lines = [];
    const complaints = createComplaints({ db, config, reports, fetchImpl, log: { ...quiet, info: (m, a) => lines.push([m, a]) } });
    const add = (i, subject, email, name = 'Launch27') => db.query(
      `INSERT INTO complaint_cases (brand, source, source_id, opened_at, status, category, customer_name, customer_email, classified_by, raw) VALUES ('residential', 'gmail', $1, now() - interval '70 days', 'resolved', 'quality_missed', $2, $3, 'rules', $4::jsonb)`,
      [`test:sys${i}`, name, email, JSON.stringify({ subject })],
    );
    const people = ['Quentin Zeller', 'Bartholomew Ng', 'Ottoline Varga', 'Ignatius Pell', 'Wilhelmina Oduya', 'Thaddeus Kraw'];
    for (const [i, n] of people.entries()) await add(i, `New rating from ${n} for booking #${48200 + i}: 2 stars`, 'notifications@launch27mail.com');
    await add(20, 'Something entirely different about Persephone', 'notifications@launch27mail.com');
    await add(30, 'The kitchen was missed', 'quentin.zeller@gmail.com', 'Quentin Zeller');
    await db.query("INSERT INTO contacts (name) VALUES ('Persephone Adair')");
    const p = await complaints.subjectPatterns();
    assert.deepEqual(Object.keys(p), ['launch27mail.com']);
    assert.equal(p['launch27mail.com'].cases, 7);
    assert.deepEqual(p['launch27mail.com'].subjects, { 'new rating from _ for booking # stars': 6, _: 1 });
    const text = JSON.stringify(p);
    for (const w of ['quentin', 'zeller', 'ottoline', 'persephone', '48200', 'kitchen']) assert.ok(!text.toLowerCase().includes(w), `${w} is not logged`);
    await complaints.logCoverage().catch(() => {});
    assert.ok(lines.some(([m, a]) => m === 'complaints system sender' && a.domain === 'launch27mail.com' && a.part === 'subjects'));
    await db.close();
  });
});

describe('complaints: data-quality funnel and cost per response', () => {
  const mk = (id, over = {}) => ({ id, source: 'kustomer', opened_at: '2026-06-10T12:00:00Z', category: 'quality_missed', tone: 'mild', severity: 1, l27_customer_id: 100 + id, one_time: false, ...over });
  const cases = [
    mk(1), mk(2, { tone: 'threat_leave', severity: 3 }), mk(3),
    mk(4, { opened_at: '2026-11-01T12:00:00Z' }), // too recent
    mk(5, { one_time: true }),
    mk(6, { l27_customer_id: null, unmatched_why: 'system_sender' }),
    mk(7, { l27_customer_id: null, unmatched_why: 'system_sender' }),
    mk(8, { l27_customer_id: null }),
  ];
  const resolutions = [{ case_id: 1, rung: 'L3', action: 'reclean_full' }, { case_id: 2, rung: 'L3', action: 'reclean_full' }];
  const costs = [{ case_id: 1, kind: 'reclean_labour', amount: 40 }, { case_id: 2, kind: 'reclean_labour', amount: 60 }, { case_id: 3, kind: 'credit', amount: 10 }];
  const outcomes = [{ case_id: 1, day: 60, outcome: 'saved' }, { case_id: 2, day: 60, outcome: 'lost' }, { case_id: 3, day: 60, outcome: 'saved' }, { case_id: 4, day: 60, outcome: 'pending' }];
  const pb = buildPlaybook({ cases, resolutions, costs, outcomes, visits: [], from: '2026-05-01', to: '2026-11-15', settings: normalizeSettings({}), today: '2026-11-16' });

  test('the funnel counts each step, lists who dropped out, and ends on the decided count', () => {
    const n = Object.fromEntries(pb.funnel.steps.map((s) => [s.key, s.n]));
    assert.deepEqual(n, { total: 8, matched: 5, recurring: 4, old_enough: 3, outcome_known: 3 });
    assert.equal(pb.funnel.steps.at(-1).n, pb.totals.decided);
    assert.deepEqual(pb.funnel.steps.find((s) => s.key === 'matched').dropped_ids, [6, 7, 8]);
    assert.deepEqual(pb.funnel.steps.find((s) => s.key === 'old_enough').dropped_ids, [4]);
    assert.equal(pb.funnel.unmatched_high, true); // 3 of 8 is over a quarter
    assert.deepEqual(pb.funnel.unmatched_reasons.map((r) => [r.key, r.n]), [['system_sender', 2], ['not_in_launch27', 1]]);
  });

  test("a response's average cost rests only on the cases that got that response", () => {
    const reclean = pb.by_response.find((r) => r.key === 'reclean');
    assert.equal(reclean.n, 2);
    assert.equal(reclean.avg_cost, 50); // $100 over its own 2 cases, not over all 8
    assert.deepEqual(reclean.ids, [1, 2]);
    const apology = pb.by_response.find((r) => r.key === 'apology');
    assert.equal(apology.n, 6);
    assert.equal(apology.total_cost, 10);
  });

  test('each response is split by threat and by severity', () => {
    const reclean = pb.by_response.find((r) => r.key === 'reclean');
    assert.deepEqual(reclean.by_threat.map((t) => [t.label, t.n, t.saved_n, t.lost_n]), [['No threat', 1, 1, 0], ['Threatened to leave', 1, 0, 1]]);
    assert.deepEqual(reclean.by_severity.map((t) => [t.label, t.n]), [['Minor', 1], ['Serious', 1]]);
  });
});

describe('complaints: the client behind a message a system sent', () => {
  test('hints: Reply-To, addresses, phones and booking numbers; never our own or the system', () => {
    const h = clientHints({
      replyTo: 'Odalys Brennock <odalys.brennock@example.net>',
      subject: 'From odalys.brennock@example.net Re: Important: Cleaning Reminder',
      body: 'Please call me at (613) 555-0142 about booking #48213. Sent via notifications@launch27mail.com, cc info@urbanmop.ca. Total $1,234.50 on 2026-11-20.',
    });
    assert.deepEqual(h.emails, ['odalys.brennock@example.net']);
    assert.deepEqual(h.phones, ['+16135550142']);
    assert.deepEqual(h.booking_ids, [48213]);
    assert.deepEqual(clientHints({ subject: 'New Voice Message from UM Ops on 11/20/2026 on 2:30 PM', body: 'From: 613-555-0177\nTo: 613.555.0100' }, { ownPhones: ['+16135550100'] }).phones, ['+16135550177']);
    assert.deepEqual(clientHints({ subject: 'nothing here' }), { emails: [], phones: [], booking_ids: [] });
  });

  test('a notice is not a client message; a relayed reply is', () => {
    const l = 'notifications@launch27mail.com';
    assert.equal(systemNotice(l, 'Ratings 2026-11-20 with comments'), 'ratings_digest');
    assert.equal(systemNotice(l, 'New booking by staff'), 'booking_notice');
    assert.equal(systemNotice(l, 'Important: Booking Cancellation'), 'cancellation_notice');
    assert.equal(systemNotice(l, '11/24 - Upcoming schedule'), 'schedule_notice');
    assert.equal(systemNotice(l, 'From someone@example.net Re: Booking Cancellation'), null);
    assert.equal(systemNotice(l, 'From someone@example.net Re: Important: Cleaning Reminder'), null);
    assert.equal(systemNotice('meetings@e.read.ai', 'Touchpoint meeting'), 'meeting_notes');
    assert.equal(systemNotice('someone@example.net', 'New booking by staff'), null);
    assert.equal(isSystemSender('no-reply@service.ringcentral.com'), true);
    assert.equal(isSystemSender('someone@example.net'), false);
  });

  test('stored cases: notices are left out with the reason, relayed messages are tied to the client inside', async () => {
    const db = await openDb();
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const fetchImpl = createMockLaunch27({ password: 'demo' });
    const schedule = createSchedule({ db, config, fetchImpl, log: quiet });
    const reports = createReports({ db, config, fetchImpl, schedule, log: quiet });
    const bodies = { v1: 'Voicemail transcript: the cleaner was late. Caller: (613) 555-0177' };
    const gmail = { accounts: ['info@urbanmop.ca'], client: { message: async (_a, id) => ({ id, threadId: id, payload: { headers: [{ name: 'From', value: 'no-reply@ringcentral.com' }, { name: 'Subject', value: 'New Voice Message' }], mimeType: 'text/plain', body: { data: Buffer.from(bodies[id] || '').toString('base64url') } } }) } };
    const complaints = createComplaints({ db, config, reports, fetchImpl, gmail, log: quiet });
    const add = (id, subject, email) => db.query(
      `INSERT INTO complaint_cases (brand, source, source_id, opened_at, status, category, customer_name, customer_email, classified_by, raw) VALUES ('residential', 'gmail', $1, now() - interval '70 days', 'resolved', 'punctuality', 'System', $2, 'rules', $3::jsonb)`,
      [`info@urbanmop.ca:${id}`, email, JSON.stringify({ subject })],
    );
    await add('n1', 'Ratings 2026-09-01 with comments', 'notifications@launch27mail.com');
    await add('r1', 'From odalys.brennock@example.net Re: Important: Cleaning Reminder', 'notifications@launch27mail.com');
    await add('v1', 'New Voice Message from UM Ops on 9/1/2026 on 2:30 PM', 'no-reply@ringcentral.com');
    await add('b1', 'Question about booking #7001', 'notifications@launch27mail.com');
    await add('x1', 'New Voice Message from UM Ops on 9/2/2026 on 9:00 AM', 'no-reply@ringcentral.com');
    const contact = async (name, l27, kind, value) => {
      const { rows } = await db.query('INSERT INTO contacts (name, l27_customer_id) VALUES ($1, $2) RETURNING id', [name, l27]);
      await db.query('INSERT INTO contact_identities (contact_id, kind, value) VALUES ($1, $2, $3)', [rows[0].id, kind, value]);
    };
    await contact('Odalys Brennock', 501, 'email', 'odalys.brennock@example.net');
    await contact('Ferris Abendroth', 502, 'phone', '+16135550177');
    const linked = await complaints.relinkSystemSenders({ visits: [{ id: 7001, customer_id: 503 }], bearer: null });
    assert.equal(linked.length, 3);
    const rows = Object.fromEntries((await db.query("SELECT split_part(source_id, ':', 2) AS k, l27_customer_id, client_match, excluded_why, customer_email, customer_phone, customer_name FROM complaint_cases")).rows.map((r) => [r.k, r]));
    assert.equal(rows.n1.excluded_why, 'ratings_digest');
    assert.equal(Number(rows.r1.l27_customer_id), 501);
    assert.equal(rows.r1.customer_email, 'odalys.brennock@example.net');
    assert.equal(rows.r1.customer_name, null);
    assert.equal(Number(rows.v1.l27_customer_id), 502);
    assert.equal(rows.v1.customer_phone, '+16135550177');
    assert.equal(Number(rows.b1.l27_customer_id), 503);
    assert.equal(rows.b1.client_match, 'message');
    assert.equal(rows.x1.l27_customer_id, null); // nothing inside names a client: stays unmatched
    await db.close();
  });
});
