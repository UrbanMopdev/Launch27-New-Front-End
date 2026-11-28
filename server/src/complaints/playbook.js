// The Phase 1 playbook report, computed from stored cases. Pure.
//   - taxonomy: how often each category comes up, typical handling, what kept clients, at what cost
//   - by cause: the same by root cause (why it happened), with the categories each cause produced
//   - ladder:   per rung (highest rung used on the case), retention and cost
//   - reclean vs refund within each category (where our default helped, where it was overkill)
//   - root causes: complaint rate per 100 visits by journey situation, against the overall rate
//   - budget baseline: monthly complaint cost as a % of Residential revenue
//   - data gaps and confidence
// Every figure carries n; anything resting on fewer than THIN cases is flagged.
import { categoryLabel, causeLabel, CAUSES, CAUSE_GROUPS, HARD_ROUTES } from './taxonomy.js';
import { RUNGS, rungIndex, rungName } from './settings.js';
import { OFFER_KINDS, offerLabel } from './solutions.js';
import { RUNG_TO_RESPONSE, THREATS, threatOf, VALUE_TIERS, valueTier } from './rank.js';

export const THIN = 10;
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const share = (a, b) => (b ? Math.round((a / b) * 1000) / 1000 : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const confidence = (n) => (n >= 30 ? 'good' : n >= THIN ? 'fair' : n > 0 ? 'thin' : 'none');

function topRung(rs) {
  let best = null;
  for (const r of rs) if (r.rung && (best == null || rungIndex(r.rung) > rungIndex(best))) best = r.rung;
  return best || (rs.some((r) => r.action === 'damage_reimbursement') ? 'damage' : 'L0');
}

const ids = (list) => list.map((c) => c.id);
const sum = (list) => list.reduce((s, c) => s + c.cost, 0);

// Why a case has no saved/lost verdict. Every rate is "x of decided"; these are the rest.
export const EXCLUDED_LABEL = {
  one_time: 'one-time clients (measured on booking again instead)',
  unmatched: 'not matched to a Launch27 client',
  too_recent: 'not yet 60 days old',
  no_outcome: 'no outcome recorded',
};
function whyExcluded(c) {
  if (c.one_time) return 'one_time';
  if (!c.l27_customer_id) return 'unmatched';
  return c.age_days != null && c.age_days < 60 ? 'too_recent' : 'no_outcome';
}

// Every figure comes with the case ids behind it, so the page can open the exact list.
// Saved / partial / lost are shares of `decided`. Average cost is given twice: over every
// case (avg_cost) and over the same decided cases the rates use (avg_cost_decided).
function outcomeStats(list) {
  const decided = list.filter((c) => c.outcome60 && c.outcome60 !== 'pending');
  const costs = list.map((c) => c.cost);
  const of = (...o) => decided.filter((c) => o.includes(c.outcome60));
  // No "partial save" (Derek, Nov 28 2026): a client who left is lost. Rows stored under the old
  // rule count as lost until they are recomputed. Whether a lost client also left a 1-2 star
  // review is kept beside it, so responses that prevented reviews can still be seen.
  const [saved, partial, lost] = [of('saved'), [], of('lost', 'partial_save')];
  const lostReviewed = lost.filter((c) => c.review60 != null && c.review60 <= 2);
  const excluded = {};
  for (const c of list) if (!decided.includes(c)) (excluded[whyExcluded(c)] ||= []).push(c.id);
  return {
    n: list.length,
    ids: ids(list),
    decided: decided.length,
    decided_ids: ids(decided),
    saved: share(saved.length, decided.length),
    saved_n: saved.length,
    saved_ids: ids(saved),
    partial: share(partial.length, decided.length),
    partial_n: partial.length,
    partial_ids: ids(partial),
    lost: share(lost.length, decided.length),
    lost_n: lost.length,
    lost_ids: ids(lost),
    lost_with_review_n: lostReviewed.length,
    lost_with_review_ids: ids(lostReviewed),
    lost_no_review_n: lost.length - lostReviewed.length,
    lost_no_review_ids: ids(lost.filter((c) => !lostReviewed.includes(c))),
    excluded_n: list.length - decided.length,
    excluded,
    total_cost: r2(sum(list)),
    avg_cost: list.length ? r2(sum(list) / list.length) : null,
    avg_cost_decided: decided.length ? r2(sum(decided) / decided.length) : null,
    median_cost: r2(median(costs)),
    confidence: confidence(decided.length),
    one_time: oneTimeStats(list),
  };
}

// One-time clients have no schedule to keep: the question is whether they booked again.
function oneTimeStats(list) {
  const ot = list.filter((c) => c.one_time);
  const d120 = ot.filter((c) => c.outcome120 && c.outcome120 !== 'pending');
  const d90 = ot.filter((c) => c.outcome90 && c.outcome90 !== 'pending');
  const r90 = d90.filter((c) => c.outcome90 === 'rebooked');
  const r120 = d120.filter((c) => c.outcome120 === 'rebooked');
  return {
    n: ot.length,
    ids: ids(ot),
    decided: d120.length,
    decided_ids: ids(d120),
    decided_90: d90.length,
    decided_90_ids: ids(d90),
    rebooked_90: share(r90.length, d90.length),
    rebooked_90_n: r90.length,
    rebooked_90_ids: ids(r90),
    rebooked_120: share(r120.length, d120.length),
    rebooked_120_n: r120.length,
    rebooked_120_ids: ids(r120),
    too_early_ids: ids(ot.filter((c) => !d120.includes(c))),
    confidence: confidence(d120.length),
  };
}

export function buildPlaybook({ cases, resolutions, costs, outcomes, solutions = [], reviews = [], reviewTotals = null, baselineCosts = null, readWindows = null, visits = [], from, to, settings, today, mining = false }) {
  const byCase = (rows) => {
    const m = new Map();
    for (const r of rows) {
      const k = Number(r.case_id);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  };
  const R = byCase(resolutions);
  const K = byCase(costs);
  const O = byCase(outcomes);
  const rows = cases.map((c) => {
    const id = Number(c.id ?? c.case_id);
    const k = K.get(id) || [];
    return {
      ...c,
      id,
      rung: topRung(R.get(id) || []),
      rs: R.get(id) || [],
      cost: k.reduce((s, x) => s + Number(x.amount), 0),
      costBy: Object.fromEntries(['refund', 'credit', 'reclean', 'damage'].map((t) => [t, k.filter((x) => x.kind.startsWith(t)).reduce((s, x) => s + Number(x.amount), 0)])),
      estimatedCost: k.some((x) => x.estimated),
      outcome60: (O.get(id) || []).find((o) => o.day === 60)?.outcome || null,
      review60: (O.get(id) || []).find((o) => o.day === 60)?.public_review_stars ?? null,
      outcome90: (O.get(id) || []).find((o) => o.day === 90)?.outcome || null,
      outcome120: (O.get(id) || []).find((o) => o.day === 120)?.outcome || null,
      one_time: !!c.one_time,
      age_days: c.opened_at ? Math.floor((Date.parse(today) - Date.parse(c.opened_at)) / 86_400_000) : null,
      reclean: (R.get(id) || []).some((r) => /^reclean/.test(r.action)),
      refund: (R.get(id) || []).some((r) => r.action === 'refund'),
    };
  });
  const ladderRows = rows.filter((c) => !c.hard_route);

  // Taxonomy
  const cats = new Map();
  for (const c of rows) {
    if (!cats.has(c.category)) cats.set(c.category, []);
    cats.get(c.category).push(c);
  }
  // One row of the playbook for any group of cases: how many, what we did, what kept clients.
  const segment = (list) => {
    const rungCounts = {};
    for (const c of list) rungCounts[c.rung] = (rungCounts[c.rung] || 0) + 1;
    const typical = Object.entries(rungCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const byRung = Object.entries(rungCounts).map(([rung, n]) => ({ rung, name: rungName(rung), ...outcomeStats(list.filter((c) => c.rung === rung)), n }));
    return {
      n: list.length,
      share: share(list.length, rows.length),
      total_n: rows.length,
      hard_routed: list.filter((c) => c.hard_route).length,
      hard_routed_ids: ids(list.filter((c) => c.hard_route)),
      typical_rung: typical,
      typical_name: typical ? rungName(typical) : null,
      ...outcomeStats(list),
      by_rung: byRung.sort((a, b) => rungIndex(a.rung) - rungIndex(b.rung)),
      cheapest_that_works: cheapestThatWorks(byRung, typical),
    };
  };
  const taxonomy = [...cats]
    .map(([key, list]) => ({
      key,
      label: categoryLabel(key),
      ...segment(list),
      tones: Object.fromEntries(['mild', 'frustrated', 'angry', 'threat_leave', 'threat_review'].map((t) => [t, list.filter((c) => c.tone === t).length])),
    }))
    .sort((a, b) => b.n - a.n);

  // Why it happened: the same view by root cause. A case counts once, under its root cause;
  // contributing causes are counted beside it. "unset" is cases nobody has a cause for yet.
  const causeOf = (c) => c.cause || 'unset';
  const contributingOf = (c) => (Array.isArray(c.contributing_causes) ? c.contributing_causes : []);
  const causes = new Map();
  for (const c of rows) {
    if (!causes.has(causeOf(c))) causes.set(causeOf(c), []);
    causes.get(causeOf(c)).push(c);
  }
  const groupOf = (k) => CAUSES.find((x) => x.key === k)?.group || null;
  const byCause = [...causes]
    .map(([key, list]) => {
      const alsoIn = rows.filter((c) => contributingOf(c).includes(key));
      const inCat = new Map();
      for (const c of list) inCat.set(c.category, [...(inCat.get(c.category) || []), c.id]);
      return {
        key,
        label: key === 'unset' ? 'Not set yet' : causeLabel(key),
        group: groupOf(key),
        ...segment(list),
        contributing_n: alsoIn.length,
        contributing_ids: ids(alsoIn),
        set_by: countBy(list.map((c) => ({ by: c.cause_by || 'none' })), 'by'),
        by_category: [...inCat].map(([k, l]) => ({ key: k, label: categoryLabel(k), n: l.length, ids: l })).sort((a, b) => b.n - a.n),
      };
    })
    .sort((a, b) => (a.key === 'unset') - (b.key === 'unset') || b.n - a.n);
  const causeGroups = CAUSE_GROUPS.map((g) => {
    const list = rows.filter((c) => groupOf(c.cause) === g.key);
    return { key: g.key, label: g.label, n: list.length, ids: ids(list), share: share(list.length, rows.length), ...outcomeStats(list) };
  });

  // What we offered and how clients took it (solution mining, solutions.js): per kind of offer,
  // how often we offered it, how often the client took it or pushed back, how often it was the
  // final answer, and for those finals how the client sounded at the end and whether they stayed.
  const S = new Map(solutions.map((x) => [Number(x.case_id), x]));
  const readRows = rows.filter((c) => S.get(c.id)?.read_by === 'claude');
  const offersOf = (c) => (Array.isArray(S.get(c.id)?.offers) ? S.get(c.id).offers : []);
  const offerRows = OFFER_KINDS.map((k) => {
    const has = (pred) => readRows.filter((c) => offersOf(c).some((o) => o.kind === k.key && pred(o)));
    const offered = has(() => true);
    const accepted = has((o) => o.client_response === 'accepted');
    const pushedBack = has((o) => o.client_response === 'declined' || o.client_response === 'countered');
    const final = readRows.filter((c) => S.get(c.id).final_kind === k.key);
    const heard = final.filter((c) => S.get(c.id).client_end && S.get(c.id).client_end !== 'unknown');
    const happy = heard.filter((c) => S.get(c.id).client_end === 'satisfied');
    const asked = readRows.filter((c) => S.get(c.id).asked_for === k.key);
    return {
      key: k.key,
      label: k.label,
      offered: offered.length,
      offered_ids: ids(offered),
      accepted: accepted.length,
      accepted_ids: ids(accepted),
      pushed_back: pushedBack.length,
      pushed_back_ids: ids(pushedBack),
      // Of the times the client answered the offer, how often they took it.
      accept_rate: share(accepted.length, accepted.length + pushedBack.length),
      asked_for: asked.length,
      asked_for_ids: ids(asked),
      ended_happy: share(happy.length, heard.length),
      ended_happy_n: happy.length,
      ended_heard: heard.length,
      ended_happy_ids: ids(happy),
      final: outcomeStats(final),
    };
  })
    .filter((r) => r.offered || r.final.n || r.asked_for)
    .sort((a, b) => b.final.n - a.final.n || b.offered - a.offered);
  const endingIds = (e) => ids(readRows.filter((c) => S.get(c.id).client_end === e));
  const solutionView = {
    enabled: mining,
    read: readRows.length,
    read_ids: ids(readRows),
    no_thread: rows.filter((c) => S.get(c.id)?.read_by === 'none').length,
    no_thread_ids: ids(rows.filter((c) => S.get(c.id)?.read_by === 'none')),
    not_yet: rows.filter((c) => !S.has(c.id)).length,
    offers: offerRows,
    endings: Object.fromEntries(['satisfied', 'neutral', 'unhappy', 'unknown'].map((e) => [e, endingIds(e)])),
    said_will_leave_ids: ids(readRows.filter((c) => S.get(c.id).said_will_leave)),
    pushed_back_first_ids: ids(readRows.filter((c) => ['declined', 'countered'].includes(offersOf(c)[0]?.client_response))),
  };

  // Threats: what each response did when the client threatened to leave or to post a review,
  // next to clients who threatened nothing. Answers "does giving more keep them when they
  // threaten?" A case's response is the final answer from its conversation, else its ladder step.
  const levelOf = (c) => threatOf(c.tone, S.get(c.id)?.read_by === 'claude' && S.get(c.id).said_will_leave);
  const responseOf = (c) => (S.get(c.id)?.read_by === 'claude' && S.get(c.id).final_kind ? S.get(c.id).final_kind : RUNG_TO_RESPONSE[c.rung] || 'apology');
  const threats = THREATS.map((t) => {
    const list = rows.filter((c) => levelOf(c) === t.key);
    const byResp = new Map();
    for (const c of list) byResp.set(responseOf(c), [...(byResp.get(responseOf(c)) || []), c]);
    return {
      key: t.key,
      label: t.label,
      share: share(list.length, rows.length),
      ...outcomeStats(list),
      by_response: [...byResp].map(([k, l]) => ({ response: k, label: offerLabel(k), ...outcomeStats(l) })).sort((a, b) => b.n - a.n),
    };
  });

  // Google reviews matched to these complaints: which threats became a 1-2 star review, which
  // low reviews came with no threat at all, and what we had done before each one.
  const starsOf = new Map();
  for (const r of reviews) starsOf.set(Number(r.case_id), Math.min(starsOf.get(Number(r.case_id)) ?? 5, Number(r.stars)));
  const posted = rows.filter((c) => starsOf.has(c.id));
  const low = posted.filter((c) => starsOf.get(c.id) <= 2);
  const threatenedReview = rows.filter((c) => levelOf(c) === 'review');
  const lowByResp = new Map();
  for (const c of low) lowByResp.set(responseOf(c), [...(lowByResp.get(responseOf(c)) || []), c.id]);
  const reviewView = {
    imported: Number(reviewTotals?.imported) || 0,
    imported_negative: Number(reviewTotals?.negative) || 0,
    first_at: reviewTotals?.first_at || null,
    last_at: reviewTotals?.last_at || null,
    matched_ids: ids(posted),
    low_ids: ids(low),
    high_ids: ids(posted.filter((c) => starsOf.get(c.id) >= 4)),
    threatened_ids: ids(threatenedReview),
    threatened_posted_ids: ids(threatenedReview.filter((c) => starsOf.get(c.id) <= 2)),
    threatened_not_posted_ids: ids(threatenedReview.filter((c) => !(starsOf.get(c.id) <= 2))),
    low_without_threat_ids: ids(low.filter((c) => levelOf(c) !== 'review')),
    low_by_response: [...lowByResp].map(([k, l]) => ({ response: k, label: offerLabel(k), n: l.length, ids: l })).sort((a, b) => b.n - a.n),
  };

  // Client value: the same split by what the client's plan is worth in a year (one-time clients
  // apart). Do we lose our best plans more often, and does giving more keep them?
  const tierOf = (c) => valueTier(c.plan_value, c.one_time);
  const valueTiers = VALUE_TIERS.map((t) => {
    const list = rows.filter((c) => tierOf(c) === t.key);
    const byResp = new Map();
    for (const c of list) byResp.set(responseOf(c), [...(byResp.get(responseOf(c)) || []), c]);
    const spend = list.map((c) => (c.plan_value == null ? NaN : Number(c.plan_value))).filter((x) => Number.isFinite(x));
    return {
      key: t.key,
      label: t.label,
      share: share(list.length, rows.length),
      avg_spend: spend.length ? r2(spend.reduce((a, b) => a + b, 0) / spend.length) : null,
      ...outcomeStats(list),
      by_response: [...byResp].map(([k, l]) => ({ response: k, label: offerLabel(k), ...outcomeStats(l) })).sort((a, b) => b.n - a.n),
    };
  });
  const noValue = rows.filter((c) => tierOf(c) == null);

  // Ladder: cost and retention per rung (hard-routed cases excluded: they're not on the ladder)
  const ladder = RUNGS.map((r) => ({ ...r, ...outcomeStats(ladderRows.filter((c) => c.rung === r.rung)) }));

  // Reclean vs refund within each category: where the default helped and where it was overkill.
  const recleanVsRefund = taxonomy
    .map((t) => {
      const list = ladderRows.filter((c) => c.category === t.key);
      const rec = list.filter((c) => c.reclean && !c.refund);
      const ref = list.filter((c) => c.refund && !c.reclean);
      const none = list.filter((c) => !c.reclean && !c.refund);
      const a = outcomeStats(rec);
      const b = outcomeStats(ref);
      const z = outcomeStats(none);
      let verdict = 'not enough cases to compare';
      if (a.decided >= 3 && z.decided >= 3) {
        if (a.saved != null && z.saved != null && a.saved <= z.saved + 0.05) verdict = 'reclean kept no more clients than an apology/credit: likely overkill here';
        else if (b.decided >= 3 && a.saved >= b.saved - 0.05 && (a.avg_cost ?? 0) <= (b.avg_cost ?? 0)) verdict = 'reclean kept clients at least as well as a refund, for less';
        else if (b.decided >= 3 && b.saved > a.saved + 0.05) verdict = 'refund kept more clients than reclean';
        else verdict = 'reclean helped compared with doing nothing';
      }
      return { key: t.key, label: t.label, reclean: a, refund: b, neither: z, verdict };
    })
    .filter((x) => x.reclean.n || x.refund.n);

  const likeForLike = likeForLikeCompare(ladderRows);

  // Root causes: complaint rate per 100 visits by the client's situation at the visit.
  const rootCauses = rootCauseTable(visits, rows, from, to);

  // Budget baseline: monthly complaint cost / Residential revenue (12-month snapshot).
  const months = new Map();
  for (const v of visits) {
    const m = v.date.slice(0, 7);
    if (!months.has(m)) months.set(m, { month: m, revenue: 0, cost: 0, refunds: 0, credits: 0, recleans: 0, cases: 0, case_ids: [] });
    months.get(m).revenue += v.revenue || 0;
  }
  // Every month of history counts here, whatever dates the page is showing: the page's own
  // cases only (the old behaviour) made every month outside those dates read $0 / 0 cases.
  const baseRows = baselineCosts
    ? (() => {
        const by = new Map();
        for (const r of baselineCosts) {
          const id = Number(r.id);
          if (!by.has(id)) by.set(id, { id, opened_at: r.opened_at, costBy: { refund: 0, credit: 0, reclean: 0, damage: 0 } });
          const t = ['refund', 'credit', 'reclean', 'damage'].find((k) => String(r.kind || '').startsWith(k));
          if (t) by.get(id).costBy[t] += Number(r.amount) || 0;
        }
        return [...by.values()];
      })()
    : rows;
  for (const c of baseRows) {
    const m = new Date(c.opened_at).toISOString().slice(0, 7);
    if (!months.has(m)) months.set(m, { month: m, revenue: 0, cost: 0, refunds: 0, credits: 0, recleans: 0, cases: 0, case_ids: [] });
    const x = months.get(m);
    x.cases++;
    x.case_ids.push(c.id);
    x.refunds += c.costBy.refund;
    x.credits += c.costBy.credit;
    x.recleans += c.costBy.reclean;
    x.cost += c.costBy.refund + c.costBy.credit + c.costBy.reclean;
  }
  // A month is complete when every one of its days has been read from Kustomer and info@.
  // Only complete months go into the average and the target; the rest are shown, marked.
  const complete = (m) => (readWindows ? monthRead(m, readWindows) : true);
  const monthly = [...months.values()].filter((m) => m.revenue > 0 && m.month < today.slice(0, 7)).sort((a, b) => a.month.localeCompare(b.month)).map((m) => ({ ...m, revenue: Math.round(m.revenue), cost: r2(m.cost), rate: share(m.cost, m.revenue), complete: complete(m.month) }));
  const rates = monthly.filter((m) => m.complete).map((m) => m.rate).filter((x) => x != null);
  const avg = rates.length ? rates.reduce((s, x) => s + x, 0) / rates.length : null;
  const baseline = {
    months: monthly,
    average: avg == null ? null : Math.round(avg * 10000) / 10000,
    best: monthly.some((m) => m.complete) ? monthly.filter((m) => m.complete).reduce((a, b) => (b.rate < a.rate ? b : a)) : null,
    worst: monthly.some((m) => m.complete) ? monthly.filter((m) => m.complete).reduce((a, b) => (b.rate > a.rate ? b : a)) : null,
    included_months: monthly.filter((m) => m.complete).map((m) => m.month),
    incomplete_months: monthly.filter((m) => !m.complete).map((m) => m.month),
    default_target: avg == null ? null : Math.round(avg * (1 - settings.budget.below_average_by) * 10000) / 10000,
    caveat: 'The average and the target use only months that have been fully read from Kustomer and info@; months still being read are shown but left out. Revenue is Launch27 booking totals; QuickBooks reconciliation is not connected yet.',
  };

  // Response and handling
  const responseHours = rows.filter((c) => c.first_response_at).map((c) => (new Date(c.first_response_at) - new Date(c.opened_at)) / 3_600_000).filter((h) => h >= 0);
  const decidedBy = {};
  for (const c of rows) for (const r of c.rs) if (r.decided_by) decidedBy[r.decided_by] = (decidedBy[r.decided_by] || 0) + 1;

  // Data gaps
  const gaps = [];
  const n = rows.length;
  const pct = (x) => `${Math.round((x / Math.max(1, n)) * 100)}%`;
  const unlinked = rows.filter((c) => !c.l27_customer_id).length;
  if (unlinked) gaps.push(`${unlinked} of ${n} cases (${pct(unlinked)}) couldn't be matched to a Launch27 client, so they have no journey or outcome.`);
  const pending = rows.filter((c) => (c.one_time ? !c.outcome120 || c.outcome120 === 'pending' : !c.outcome60 || c.outcome60 === 'pending')).length;
  if (pending) gaps.push(`${pending} cases are too recent (or unmatched) for an outcome (60 days for recurring clients, 120 days for one-time clients).`);
  const oneTimers = rows.filter((c) => c.one_time).length;
  if (oneTimers) gaps.push(`${oneTimers} cases are one-time clients. They're left out of Saved/Lost and measured on whether they booked again within 90 and 120 days.`);
  if (visits.length && !visits.some((v) => v.svc)) gaps.push('Service type (deep clean, move in/out) appears after the next Launch27 history rebuild (it rebuilds daily when someone opens Reports).');
  const rulesOnly = rows.filter((c) => c.classified_by === 'rules').length;
  if (rulesOnly) gaps.push(`${rulesOnly} cases were classified by keyword rules only (lower confidence).`);
  const est = rows.filter((c) => c.estimatedCost).length;
  if (est) gaps.push(`${est} cases include estimated costs (reclean travel and lost-slot margin are modelled, not invoiced).`);
  if (reviewView.imported) gaps.push(`Public reviews: ${reviewView.imported} Google reviews imported (${String(reviewView.first_at).slice(0, 10)} to ${String(reviewView.last_at).slice(0, 10)}), matched to complaints by the reviewer's full name and date. A matched 1–2★ review counts the client as LOST. Reviews under a different name, initials or a business name are not matched.`);
  else gaps.push('Public reviews: no Google reviews imported yet, so LOST is based on churn only. 1–2★ Launch27 ratings are counted as complaints, not as public reviews.');
  gaps.push(`Client history goes back 12 months (nightly Launch27 sync), so tenure and lifetime spend are capped at 12 months.`);

  return {
    window: { from, to },
    totals: { cases: n, hard_routed: rows.filter((c) => c.hard_route).length, hard_routed_ids: ids(rows.filter((c) => c.hard_route)), by_source: countBy(rows, 'source'), total_cost: r2(rows.reduce((s, c) => s + c.cost, 0)), ...outcomeStats(rows) },
    taxonomy,
    by_cause: byCause,
    solutions: solutionView,
    threats,
    reviews: reviewView,
    value_tiers: valueTiers,
    value_unknown_ids: ids(noValue),
    cause_groups: causeGroups,
    ladder,
    reclean_vs_refund: recleanVsRefund,
    reclean_vs_refund_total: {
      reclean: outcomeStats(ladderRows.filter((c) => c.reclean && !c.refund)),
      refund: outcomeStats(ladderRows.filter((c) => c.refund && !c.reclean)),
      neither: outcomeStats(ladderRows.filter((c) => !c.reclean && !c.refund)),
    },
    like_for_like: likeForLike,
    root_causes: rootCauses,
    hard_routes: Object.entries(HARD_ROUTES).map(([key, label]) => ({ key, label, n: rows.filter((c) => c.hard_route === key).length, ids: ids(rows.filter((c) => c.hard_route === key)) })),
    response: { first_response_median_hours: r2(median(responseHours)), with_response_time: responseHours.length, decided_by: decidedBy },
    baseline,
    gaps,
    thin_threshold: THIN,
    excluded_labels: EXCLUDED_LABEL,
  };
}

/** Has every day of month 'YYYY-MM' been read? windows: [{from, to}] as YYYY-MM-DD. Pure. */
export function monthRead(month, windows) {
  const [y, m] = month.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  for (let d = 1; d <= days; d++) {
    const day = `${month}-${String(d).padStart(2, '0')}`;
    if (!windows.some((w) => w.from <= day && w.to >= day)) return false;
  }
  return true;
}

// "Cheapest that works" names a response only when the data supports it.
//   compared:    the cheapest response whose save rate is within 10 points of the best one,
//                among responses with at least 3 known outcomes
//   few:         fewer than 3 known outcomes anywhere: the best-saving response we have seen
//   no_outcomes: nothing decided yet: only what we usually did
// The grade here is by number of known outcomes (30+ High, 10-29 Medium, under 10 Low).
export const CHEAPEST_MIN_CASES = 5;
function cheapestThatWorks(byRung, typical) {
  // Never name a response on fewer than CHEAPEST_MIN_CASES cases with a known outcome of its own
  // (Derek, Nov 28 2026): say there isn't enough data and point to the standard ladder instead.
  const pool = byRung.filter((b) => b.decided >= CHEAPEST_MIN_CASES && b.saved != null);
  const solid = pool;
  if (!pool.length) {
    const b = byRung.find((x) => x.rung === typical);
    const most = byRung.reduce((m, x) => Math.max(m, x.decided || 0), 0);
    return { rung: null, name: null, saved: null, saved_n: 0, avg_cost: null, n: 0, cases: b?.n || 0, ids: [], basis: 'not_enough', grade: 'Low', reason: `Not enough data: use the standard ladder (no response has ${CHEAPEST_MIN_CASES} cases with a known outcome here; the most is ${most})`, usual: b?.name || null };
  }
  const best = pool.reduce((m, b) => Math.max(m, b.saved), 0);
  const b = pool.filter((x) => x.saved >= best - 0.1).sort((x, y) => (x.avg_cost ?? 0) - (y.avg_cost ?? 0))[0];
  return {
    rung: b.rung, name: b.name, saved: b.saved, saved_n: b.saved_n, avg_cost: b.avg_cost, n: b.decided, cases: b.n, ids: b.decided_ids,
    basis: solid.length ? 'compared' : 'few',
    grade: b.decided >= 30 ? 'High' : b.decided >= THIN ? 'Medium' : 'Low',
    reason: `${b.decided} ${b.decided === 1 ? 'case' : 'cases'} with a known outcome, ${b.saved_n} saved`,
  };
}

function rootCauseTable(visits, cases, from, to) {
  if (!visits.length) return null;
  const inWindow = visits.filter((v) => v.date >= from && v.date <= to);
  if (!inWindow.length) return null;
  // Features per visit, from the client's own history.
  const byCust = new Map();
  for (const v of [...visits].sort((a, b) => a.at - b.at)) {
    if (!byCust.has(v.customer_id)) byCust.set(v.customer_id, []);
    byCust.get(v.customer_id).push(v);
  }
  const byCleaner = new Map();
  const feat = new Map();
  for (const v of [...visits].sort((a, b) => a.at - b.at)) {
    const list = byCust.get(v.customer_id);
    const i = list.indexOf(v);
    const prev = list[i - 1];
    const prev3 = list.slice(Math.max(0, i - 3), i).map((x) => x.revenue).filter((x) => x > 0);
    const team = v.teams.map((t) => t.id).sort().join(',');
    const cleanerExp = Math.min(...v.teams.map((t) => byCleaner.get(t.id) || 0));
    for (const t of v.teams) byCleaner.set(t.id, (byCleaner.get(t.id) || 0) + 1);
    feat.set(v.id, {
      first_three: i < 3,
      cleaner_changed: !!prev && prev.teams.map((t) => t.id).sort().join(',') !== team,
      cleaner_lt5: cleanerExp < 5,
      cleaner_lt10: cleanerExp < 10,
      new_cleaner: cleanerExp < 15,
      price_up: prev3.length >= 2 && v.revenue > (prev3.reduce((s, x) => s + x, 0) / prev3.length) * 1.05,
      long_gap: !!prev && v.at - prev.at > 45 * 86_400_000,
      one_time: v.kind ? v.kind === 'one' : /one|once|single/i.test(v.freq || ''),
      deep: !!v.deep,
      move: !!v.move,
    });
  }
  const complained = new Map();
  for (const c of cases) if (Number(c.l27_booking_id)) complained.set(Number(c.l27_booking_id), [...(complained.get(Number(c.l27_booking_id)) || []), c.id]);
  const caseIds = (vs) => vs.flatMap((v) => complained.get(v.id) || []);
  const labels = {
    first_three: "Client's first 3 cleans",
    cleaner_changed: 'Different cleaner from last visit',
    cleaner_lt5: 'Cleaner with fewer than 5 visits',
    cleaner_lt10: 'Cleaner with fewer than 10 visits',
    new_cleaner: 'Cleaner with fewer than 15 visits',
    price_up: 'Price more than 5% above recent visits',
    long_gap: 'More than 45 days since last clean',
    one_time: 'One-time clean',
    deep: 'Deep cleaning',
    move: 'Move in / move out',
  };
  const all = inWindow.length;
  const allComplaints = inWindow.filter((v) => complained.has(v.id)).length;
  const base = all ? allComplaints / all : 0;
  return {
    base_rate_per_100: Math.round(base * 10000) / 100,
    visits: all,
    linked_complaints: allComplaints,
    linked_ids: caseIds(inWindow),
    rows: Object.entries(labels).map(([k, label]) => {
      const seg = inWindow.filter((v) => feat.get(v.id)?.[k]);
      const c = seg.filter((v) => complained.has(v.id)).length;
      const rate = seg.length ? c / seg.length : null;
      return { key: k, label, visits: seg.length, complaints: c, case_ids: caseIds(seg), rate_per_100: rate == null ? null : Math.round(rate * 10000) / 100, vs_base: rate != null && base ? Math.round((rate / base) * 100) / 100 : null, confidence: confidence(c) };
    }),
  };
}

function countBy(list, key) {
  const m = {};
  for (const x of list) m[x[key]] = (m[x[key]] || 0) + 1;
  return m;
}

// Reclean vs refund, like for like. Angrier clients tend to get refunds, so a raw comparison
// makes refunds look worse than they are. Here cases are grouped by category, tone (calm vs
// heated) and client tenure (first 90 days vs established); only groups that contain BOTH a
// reclean and a refund with a known outcome are compared, each group weighted equally per case pair.
function likeForLikeCompare(rows) {
  const heated = (t) => ['angry', 'threat_leave', 'threat_review'].includes(t);
  const groups = new Map();
  for (const c of rows) {
    if (c.one_time || !c.outcome60 || c.outcome60 === 'pending') continue;
    const arm = c.reclean && !c.refund ? 'reclean' : c.refund && !c.reclean ? 'refund' : null;
    if (!arm) continue;
    const key = `${c.category}|${heated(c.tone) ? 'heated' : 'calm'}|${c.tenure_days != null && c.tenure_days < 90 ? 'new' : 'established'}`;
    if (!groups.has(key)) groups.set(key, { key, category: c.category, reclean: [], refund: [] });
    groups.get(key)[arm].push(c);
  }
  const matched = [...groups.values()].filter((g) => g.reclean.length && g.refund.length);
  const rate = (l) => l.filter((c) => c.outcome60 === 'saved').length / l.length;
  const avg = (l) => l.reduce((s, c) => s + c.cost, 0) / l.length;
  let w = 0;
  let rec = 0;
  let ref = 0;
  let recCost = 0;
  let refCost = 0;
  for (const g of matched) {
    const k = Math.min(g.reclean.length, g.refund.length);
    w += k;
    rec += k * rate(g.reclean);
    ref += k * rate(g.refund);
    recCost += k * avg(g.reclean);
    refCost += k * avg(g.refund);
  }
  const pairs = w;
  const out = {
    groups_compared: matched.length,
    matched_pairs: pairs,
    reclean: pairs ? { saved: Math.round((rec / w) * 1000) / 1000, avg_cost: r2(recCost / w), n: matched.reduce((s, g) => s + g.reclean.length, 0), ids: matched.flatMap((g) => ids(g.reclean)) } : null,
    refund: pairs ? { saved: Math.round((ref / w) * 1000) / 1000, avg_cost: r2(refCost / w), n: matched.reduce((s, g) => s + g.refund.length, 0), ids: matched.flatMap((g) => ids(g.refund)) } : null,
    confidence: confidence(pairs),
    verdict: 'Not enough comparable cases yet: no group of similar complaints has both a reclean and a refund with a known outcome.',
  };
  if (pairs) {
    const diff = out.reclean.saved - out.refund.saved;
    out.verdict = pairs < THIN
      ? `Too few comparable cases to call (${pairs} matched). Treat as a hypothesis to test.`
      : Math.abs(diff) <= 0.05
        ? `Similar complaints, similar retention: the cheaper one wins (${out.reclean.avg_cost <= out.refund.avg_cost ? 'reclean' : 'refund'}).`
        : diff > 0
          ? 'For similar complaints, a reclean kept more clients than a refund.'
          : 'For similar complaints, a refund kept more clients than a reclean.';
  }
  return out;
}

// Clients view (last 12 months of cases, clients matched to Launch27 only).
//   repeat:  2+ complaints in 12 months: what they cost, how serious, and whether they stay
//   at_risk: complained in the last 60 days, not gone yet, and showing warning signs
//   review_mentions: said they'd post a review (Google reviews themselves aren't connected yet)
export function buildClients(rows, nowMs) {
  const DAY = 86_400_000;
  const by = new Map();
  for (const r of rows) {
    const k = Number(r.l27_customer_id);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  }
  const latestOutcome = (c) => {
    const os = (c.outcomes || []).filter((o) => o.outcome && o.outcome !== 'pending').sort((a, b) => b.day - a.day);
    return os[0]?.outcome || 'pending';
  };
  const gone = (o) => o === 'lost' || o === 'partial_save' || o === 'not_rebooked';
  const repeat = [];
  const atRisk = [];
  const reviews = [];
  for (const [id, list] of by) {
    const last = list[list.length - 1];
    const status = latestOutcome(last);
    const base = {
      l27_customer_id: id,
      name: last.customer_name,
      complaints: list.length,
      last_complaint: last.opened_at,
      last_category: last.category,
      total_cost: r2(list.reduce((s, c) => s + Number(c.cost || 0), 0)),
      avg_severity: r2(list.reduce((s, c) => s + (Number(c.severity) || 1), 0) / list.length),
      status,
      case_id: Number(last.id),
    };
    if (list.length >= 2) repeat.push({ ...base, low_severity: base.avg_severity <= 2, still_with_us: !gone(status) });
    const reviewCase = [...list].reverse().find((c) => c.tone === 'threat_review');
    if (reviewCase) reviews.push({ ...base, mentioned_on: reviewCase.opened_at });
    const age = (nowMs - new Date(last.opened_at).getTime()) / DAY;
    if (age <= 60 && !gone(status)) {
      const reasons = [];
      let score = 0;
      const add = (pts, why) => {
        score += pts;
        reasons.push(why);
      };
      if (last.tone === 'threat_leave') add(3, 'said they may leave');
      if (last.tone === 'threat_review') add(3, 'mentioned a public review');
      if (last.tone === 'angry') add(2, 'angry');
      if (last.cleans_total != null && last.cleans_total <= 3) add(2, 'within their first 3 cleans');
      if (list.length >= 2) add(1, `${list.length} complaints in 12 months`);
      if (last.cleaner_changed_last_visit) add(1, 'cleaner changed before this visit');
      if (last.price_change_pct != null && Number(last.price_change_pct) > 0.05) add(1, 'price went up');
      const next = (last.outcomes || []).find((o) => o.next)?.next || null;
      if (!next && age >= 14) add(2, 'nothing booked since the complaint');
      if (score >= 3) atRisk.push({ ...base, score, reasons, next_booking_on: next });
    }
  }
  repeat.sort((a, b) => b.complaints - a.complaints || b.total_cost - a.total_cost);
  atRisk.sort((a, b) => b.score - a.score);
  reviews.sort((a, b) => String(b.mentioned_on).localeCompare(String(a.mentioned_on)));
  return { repeat, at_risk: atRisk, review_mentions: reviews, google_reviews_connected: false, clients_with_complaints: by.size };
}
