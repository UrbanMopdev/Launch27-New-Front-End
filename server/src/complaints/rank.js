// Ranked responses for a new complaint (customer success brain, step 2). Pure.
//
// For a complaint of a given category and root cause, from a recurring or a one-time client:
// which responses kept similar clients before, in order. "Similar" narrows as far as the data
// allows: same root cause and category, then same root cause, then same category, then every
// complaint. Each response is judged in the most specific group where it has enough known
// outcomes (MIN_DECIDED), so a well-tried response is never measured on two cases.
//
// The order: responses with enough known outcomes first; within that, the kept rate pulled
// toward its group's overall rate when there are few cases (SMOOTH pseudo-cases), so three
// lucky cases can't outrank forty solid ones. Ties go to the
// response clients were happier with at the end, then to the cheaper one. Agents see why:
// how many similar cases, kept x of y, happy at the end, how often clients took it when it
// was offered, the average cost and a confidence grade.
import { causeLabel, categoryLabel } from './taxonomy.js';
import { offerLabel } from './solutions.js';

export const MIN_DECIDED = 5;
export const SMOOTH = 10;
export const TOP = 5;
const DAY = 86_400_000;

// How hard the client pushed: threatened a public review, threatened to leave (in the complaint's
// tone or said so in the conversation), or neither. A review threat outranks a threat to leave.
export const THREATS = [
  { key: 'none', label: 'No threat' },
  { key: 'leave', label: 'Threatened to leave' },
  { key: 'review', label: 'Threatened a public review' },
];
export const threatLabel = (k) => THREATS.find((t) => t.key === k)?.label || k;
export const threatOf = (tone, saidWillLeave = false) => (tone === 'threat_review' ? 'review' : tone === 'threat_leave' || saidWillLeave ? 'leave' : 'none');

// Client value tiers, by what the client's plan is worth in a year (visit price x visits a
// year, journey.js planValue): what is at stake when they complain. Past spend says little:
// most complaints come on a first or second clean. One-time clients have no plan and are
// their own tier. Roughly: a monthly plan, a biweekly plan, a weekly plan.
export const VALUE_TIERS = [
  { key: 'one', label: 'One-time booking' },
  { key: 'low', label: 'Plan under $2,500 a year', max: 2500 },
  { key: 'mid', label: 'Plan of $2,500 to $5,999 a year', max: 6000 },
  { key: 'high', label: 'Plan of $6,000 or more a year', max: Infinity },
];
export const valueTier = (planValue, oneTime = false) => {
  if (oneTime) return 'one';
  if (planValue == null || !Number.isFinite(Number(planValue))) return null;
  return VALUE_TIERS.find((t) => t.max != null && Number(planValue) < t.max).key;
};

// A rung of the ladder in the same terms as a mined offer.
export const RUNG_TO_RESPONSE = { L0: 'apology', L1: 'credit', L2: 'credit', L3: 'reclean', L4: 'partial_refund', L5: 'partial_refund', L6: 'partial_refund', L7: 'full_refund', damage_reimbursement: 'damage_reimbursement' };
const RUNG_ORDER = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'damage_reimbursement'];

/**
 * One row per past case: { id, category, cause, one_time, response, from_conversation, kept,
 * happy, cost, offered:[{kind, response}] }. kept: 1 saved / rebooked, 0.5 partial save,
 * 0 lost / not rebooked, null not known yet.
 */
export function caseRows({ cases, resolutions = [], costs = [], outcomes = [], solutions = [] }) {
  const by = (rows) => {
    const m = new Map();
    for (const r of rows) {
      const k = Number(r.case_id);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  };
  const R = by(resolutions);
  const K = by(costs);
  const O = by(outcomes);
  const S = new Map(solutions.map((s) => [Number(s.case_id), s]));
  return cases.map((c) => {
    const id = Number(c.id);
    const s = S.get(id);
    const mined = s?.read_by === 'claude';
    const rungs = (R.get(id) || []).map((r) => r.rung || r.action).filter((r) => RUNG_TO_RESPONSE[r]);
    const top = rungs.sort((a, b) => RUNG_ORDER.indexOf(b) - RUNG_ORDER.indexOf(a))[0] || 'L0';
    const response = mined && s.final_kind ? s.final_kind : RUNG_TO_RESPONSE[top];
    const o = O.get(id) || [];
    const one = !!c.one_time;
    const out = one ? o.find((x) => x.day === 120)?.outcome : o.find((x) => x.day === 60)?.outcome;
    const kept = out === 'saved' || out === 'rebooked' ? 1 : out === 'lost' || out === 'partial_save' || out === 'not_rebooked' ? 0 : null;
    return {
      id,
      category: c.category,
      cause: c.cause || null,
      threat: threatOf(c.tone, mined && s.said_will_leave),
      one_time: one,
      response,
      from_conversation: !!(mined && s.final_kind),
      kept,
      happy: mined && s.client_end && s.client_end !== 'unknown' ? s.client_end === 'satisfied' : null,
      cost: (K.get(id) || []).reduce((t, x) => t + Number(x.amount || 0), 0),
      offered: mined && Array.isArray(s.offers) ? s.offers.map((x) => ({ kind: x.kind, response: x.client_response })) : [],
      opened_at: c.opened_at ? Date.parse(c.opened_at) : null,
    };
  });
}

const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const grade = (n) => (n >= 30 ? 'High' : n >= 10 ? 'Medium' : 'Low');

/**
 * Rank responses for { category, cause, one_time }. rows: caseRows(). Returns the groups
 * looked at and the top responses, best first.
 */
export function rankResponses(rows, { category = null, cause = null, one_time = false, threat = 'none', value = null } = {}, { top = TOP, now = null } = {}) {
  const pool = rows.filter((r) => r.one_time === !!one_time && r.response);
  // A client who is threatening to leave or to post a review is first compared with past
  // clients who did the same: what keeps them can differ from what keeps everyone else.
  const threatened = threat === 'leave' || threat === 'review';
  const groups = [
    threatened && category && { key: 'threat_category', label: `${threatLabel(threat)} · ${categoryLabel(category)}`, rows: pool.filter((r) => r.threat === threat && r.category === category) },
    threatened && { key: 'threat', label: threatLabel(threat), rows: pool.filter((r) => r.threat === threat) },
    cause && category && cause !== 'other' && { key: 'cause_category', label: `${causeLabel(cause)} · ${categoryLabel(category)}`, rows: pool.filter((r) => r.cause === cause && r.category === category) },
    cause && cause !== 'other' && { key: 'cause', label: causeLabel(cause), rows: pool.filter((r) => r.cause === cause) },
    category && { key: 'category', label: categoryLabel(category), rows: pool.filter((r) => r.category === category) },
    { key: 'all', label: one_time ? 'All one-time clients' : 'All recurring clients', rows: pool },
  ].filter(Boolean);
  const decided = (list) => list.filter((r) => r.kept != null);
  const keptRate = (list) => {
    const d = decided(list);
    return d.length ? d.reduce((t, r) => t + r.kept, 0) / d.length : null;
  };
  const responses = [...new Set(groups[0] ? groups.flatMap((g) => g.rows.map((r) => r.response)) : [])];
  const options = [];
  for (const resp of responses) {
    // The most specific group where this response has enough known outcomes; otherwise the
    // most specific group it appears in at all (graded Low).
    let g = groups.find((x) => decided(x.rows.filter((r) => r.response === resp)).length >= MIN_DECIDED);
    if (!g) g = groups.find((x) => x.rows.some((r) => r.response === resp));
    const mine = g.rows.filter((r) => r.response === resp);
    const d = decided(mine);
    const prior = keptRate(g.rows) ?? 0.5;
    const kept = d.length ? d.reduce((t, r) => t + r.kept, 0) / d.length : null;
    const score = (d.reduce((t, r) => t + r.kept, 0) + SMOOTH * prior) / (d.length + SMOOTH);
    const heard = mine.filter((r) => r.happy != null);
    const offers = g.rows.flatMap((r) => r.offered.filter((o) => o.kind === resp));
    const answered = offers.filter((o) => ['accepted', 'declined', 'countered'].includes(o.response));
    const taken = answered.filter((o) => o.response === 'accepted');
    const firstTurnedDown = g.rows.filter((r) => r.offered[0]?.kind === resp && ['declined', 'countered'].includes(r.offered[0]?.response)).length;
    const firstOffered = g.rows.filter((r) => r.offered[0]?.kind === resp).length;
    const recent = now ? mine.filter((r) => r.opened_at && r.opened_at >= now - 180 * DAY).length : null;
    options.push({
      response: resp,
      label: offerLabel(resp),
      group: g.key,
      group_label: g.label,
      group_cases: g.rows.length,
      cases: mine.length,
      case_ids: mine.map((r) => r.id),
      decided: d.length,
      kept: r3(kept),
      kept_n: r3(d.reduce((t, r) => t + r.kept, 0)),
      score: r3(score),
      vs_group: kept != null && prior ? r3(kept - prior) : null,
      happy: heard.length ? r3(heard.filter((r) => r.happy).length / heard.length) : null,
      happy_n: heard.filter((r) => r.happy).length,
      heard: heard.length,
      taken_when_offered: answered.length ? r3(taken.length / answered.length) : null,
      offered_answered: answered.length,
      first_turned_down: firstOffered >= 3 ? r3(firstTurnedDown / firstOffered) : null,
      avg_cost: mine.length ? Math.round(avg(mine.map((r) => r.cost)) * 100) / 100 : null,
      from_conversations: mine.filter((r) => r.from_conversation).length,
      recent_cases: recent,
      grade: d.length >= MIN_DECIDED ? grade(d.length) : 'Low',
    });
  }
  // Proven responses (enough known outcomes) always come before unproven ones, whatever their rate.
  const proven = (o) => (o.decided >= MIN_DECIDED ? 1 : 0);
  options.sort((a, b) => proven(b) - proven(a) || b.score - a.score || (b.happy ?? -1) - (a.happy ?? -1) || (a.avg_cost ?? 0) - (b.avg_cost ?? 0));
  // Best value: the cheapest of the options within 5 points of the best score, if it isn't the best.
  const best = options[0];
  if (best) {
    const value = options.filter((o) => o.score >= best.score - 0.05 && o.decided >= MIN_DECIDED).sort((a, b) => (a.avg_cost ?? 0) - (b.avg_cost ?? 0))[0];
    if (value && value !== best && (value.avg_cost ?? 0) < (best.avg_cost ?? 0)) value.best_value = true;
  }
  // What each option is worth for this client: the share of similar clients it kept (smoothed)
  // times what this client is worth to us, less what the response costs on average. A full
  // refund can be the right call for a $9,000 client and the wrong one for a $300 one.
  const worth = Number(value) > 0 ? Number(value) : null;
  if (worth) {
    for (const o of options) {
      o.kept_value = Math.round(o.score * worth);
      o.net_value = Math.round(o.score * worth - (o.avg_cost ?? 0));
    }
    const sure = options.filter((o) => o.decided >= MIN_DECIDED);
    const bestNet = (sure.length ? sure : options).slice().sort((a, b) => b.net_value - a.net_value)[0];
    if (bestNet) bestNet.best_net = true;
  }
  return {
    threat,
    client_value: worth,
    groups: groups.map((g) => ({ key: g.key, label: g.label, cases: g.rows.length, decided: decided(g.rows).length, kept: r3(keptRate(g.rows)) })),
    options: options.slice(0, top).map((o, i) => ({ rank: i + 1, ...o })),
    considered: options.length,
  };
}
