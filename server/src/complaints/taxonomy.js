// Complaint taxonomy (DRAFT: to be re-cut from the pilot data, see docs/complaints-engine.md)
// and a rules-based first pass: category, tone, areas cited and hard routes. The rules
// always run; when Claude classification is on it refines category/tone/severity, but a
// hard route found by either is kept (we never let a model talk a case off a hard route).

export const CATEGORIES = [
  { key: 'quality_missed', label: 'Quality: missed areas', re: /\b(miss(ed|ing) (spot|area|room)|missed|forg[eo]t|didn'?t (clean|do|wipe|vacuum|mop|dust)|not (clean(ed)?|done|thorough)|dust(y)?|dirty|still (dirty|there)|skipp?ed|overlook|streak|hair|crumbs?|sticky|grime|not up to|disappoint|unsatisf|dissatisf|poor (job|clean|quality)|sub-?par)/i },
  { key: 'quality_rushed', label: 'Quality: rushed / short time', re: /\b(rush(ed)?|hurr(y|ied)|left early|only (spent|stayed|there)|short(er)? (time|visit)|less than \d|(fewer|less) hours)/i },
  { key: 'punctuality', label: 'Late / no-show', re: /\b(late|no.?show|didn'?t (show|come|arrive)|never (showed|came|arrived)|wait(ed|ing) (for|over)|stood up|delay(ed)?)\b/i },
  { key: 'cleaner_change', label: 'Cleaner change / consistency', re: /\b(usual|regular|same) (cleaner|person|team|lady)|new (cleaner|person|team)|different (cleaner|person|team)|changed? (the |my )?cleaner/i },
  { key: 'scope_booking', label: 'Scope / booking error', re: /\b(wrong (date|day|time|address|service)|extras?|oven|fridge|inside (the )?(cabinets|windows)|not (included|what i (booked|asked))|double.?book|cancel+ed (by you|on me|last minute)|reschedul)/i },
  { key: 'communication', label: 'Communication', re: /\b(no (one|body) (called|replied|responded|got back)|never (heard|responded|replied|got back)|no (response|reply|update)|unresponsive|ignored)\b/i },
  { key: 'pricing_billing', label: 'Pricing / billing', re: /\b(over.?charg|charged (twice|again|more)|double charg|price (increase|went up|change)|invoice|bill(ed|ing)?|affirm|refund (my|the) (deposit|payment)|fee)\b/i },
  { key: 'property_condition', label: 'Property condition (job not finished)', re: /\b(condition of the (property|home|house)|unable to (continue|finish|complete)|couldn'?t (continue|finish|complete)|hoard|biohazard)/i },
  { key: 'damage', label: 'Damage / breakage', re: /\b(broke(n)?|break(ing)?|damag(e|ed)|scratch(ed)?|crack(ed)?|ruin(ed)?|chipp?ed|dent(ed)?|shatter(ed)?|bleach(ed)? (my|the)|stain(ed)? (my|the))/i },
  { key: 'missing_item', label: 'Missing item / theft', re: /\b(stole|stolen|steal|theft|missing (item|ring|jewel|money|cash|watch)|can'?t find (my|the)|went missing|took (my|our))/i },
  { key: 'conduct_safety', label: 'Cleaner conduct / safety', re: /\b(rude|disrespect|yell(ed)?|inappropriate|harass|unsafe|injur|hurt|smok(ed|ing)|drunk|high|on (the|their) phone|brought (?:her |his |their )?(someone|a friend|kids?)|privacy|photo|video)/i },
];
export const CATEGORY_KEYS = [...CATEGORIES.map((c) => c.key), 'other'];
export const categoryLabel = (key) => CATEGORIES.find((c) => c.key === key)?.label || (key === 'other' ? 'Other / unclear' : key || 'Unclassified');

// Root causes: the second layer. The category says what the client complained about ("the
// clean was bad"); the root cause says why it happened ("their regular cleaner left and the
// new one didn't know the home"). A cause can sit under any category: a quality complaint
// whose cause is a cleaner who left is the pattern we most need to see.
// One root cause per case, plus up to two contributing causes. The codebook entries
// (definition, examples, "not this when") are what a person checks against, so two people
// checking the same case pick the same cause. Signed off by Derek, Nov 27 2026.
export const CAUSE_GROUPS = [
  { key: 'consistency', label: 'Cleaner consistency' },
  { key: 'communication', label: 'Communication' },
  { key: 'quality', label: 'Quality' },
];
export const CAUSES = [
  {
    key: 'regular_left', group: 'consistency', label: 'Regular cleaner left the company',
    definition: "The client's usual cleaner stopped working for us, and the client didn't settle with the replacement (complains, or cancels).",
    examples: ["Our cleaner isn't with you anymore?", "Since she left it just hasn't been the same."],
    not_when: 'The cleaner still works for us but was moved to other clients: that is "changed without asking".',
    re: /\b((no longer|not) (with|working (for|with)) (you|urbanmop|the company)|(left|quit) (the company|urbanmop|you)|since (she|he|they|our (usual |regular )?cleaner) (left|quit)|(she|he|they) (left|quit)\b)/i,
  },
  {
    key: 'changed_unannounced', group: 'consistency', label: 'Cleaner changed without asking or telling the client',
    definition: 'We sent a different cleaner and the client was not asked or told beforehand.',
    examples: ['A different person showed up and nobody told us.', 'We never asked for a new cleaner.'],
    not_when: 'The client asked for the change, or the regular cleaner left the company (that is "regular cleaner left").',
    re: /\b((no ?one|nobody) (told|informed|warned|asked|notified) (us|me)|(no ?one|nobody|you) let (us|me) know|(didn'?t|never|did not) (tell|inform|notify|warn|ask) (us|me)|without (asking|telling|notice|warning)|didn'?t ask for a (new|different) (cleaner|person|team))/i,
  },
  {
    key: 'no_regular', group: 'consistency', label: 'Different cleaner every visit',
    definition: 'The client never got a regular cleaner: a different person or team keeps coming.',
    examples: ['Every time it is someone new.', "We've had four different cleaners in a month."],
    not_when: 'They had a regular who left (regular cleaner left) or was swapped once (changed without asking).',
    re: /\b((different|new) (cleaner|person|team|people) (every|each) (time|visit|week|clean)|(every|each) (time|visit|week|clean),? (it'?s |it is |there'?s |there is |a )?(someone|somebody) (new|different)|never (get|have|see) the same (cleaner|person|team|lady)|(three|four|five|3|4|5) different cleaners)/i,
  },
  {
    key: 'requested_unavailable', group: 'consistency', label: 'Requested cleaner not available',
    definition: 'The client asked for a specific cleaner (usually their old one) and we could not give them that cleaner.',
    examples: ['Can we get Maria back?', 'We asked for the same cleaner and were told she is fully booked.'],
    not_when: 'They are unhappy with the new cleaner but never asked for anyone specific (replacement quality).',
    re: /\b((can|could) (we|i) (get|have) (her|him|them|\w+) back|asked (for|to have) (the same|our (old|usual|regular|previous))|(she|he|they)('?s| is| are| was| were) (fully booked|not available|unavailable))/i,
  },
  {
    key: 'replacement_quality', group: 'consistency', label: "Replacement cleaner's quality below the previous one",
    definition: 'A new cleaner took over and the client says the work is worse than what their previous cleaner did.',
    examples: ['Not nearly as good as our old cleaner.', 'Our previous cleaner never missed the baseboards.'],
    not_when: 'There was no change of cleaner: use the quality causes.',
    re: /\b(not (nearly )?as (good|thorough) as (our|my|the) (old|usual|regular|previous|last)|(our|my|the) (old|usual|regular|previous|last) (cleaner|one|lady|team) (was|did|never|always)|compared to (our|my|the) (old|usual|regular|previous))/i,
  },
  {
    key: 'marketing_emails', group: 'communication', label: 'Too many marketing emails',
    definition: 'The client is annoyed by how many promotional emails or texts we send.',
    examples: ['Please stop sending me so many emails.', 'I get three promotions a week from you.'],
    not_when: 'It is about a missing reply from the office (office slow or not responding).',
    re: /\b((too many|so many|constant(ly)?|keep (getting|sending)|stop sending( me)?) (e-?mails|emails|promo(tion)?s?|newsletters?|texts|marketing)|(please |want to |tried to |can'?t |cannot )unsubscribe|(stop|your|keep) spamming|(you|you guys|urbanmop) (keep |are )?spam(ming)? (me|us))\b/i,
  },
  {
    key: 'team_size', group: 'communication', label: 'Number of cleaners miscommunicated',
    definition: 'The client expected a different number of cleaners than arrived (expected two, got one, or the reverse), or did not understand how team size changes time on site.',
    examples: ['Only one cleaner came, we booked two.', 'Two cleaners came so they left after an hour and a half.'],
    not_when: 'The right number came but rushed (rushed or short visit).',
    re: /\b((only|just) (one|1) (cleaner|person|lady) (came|showed|arrived)|expected (two|2|three|3) (cleaners|people)|(two|2|three|3) (cleaners|people) (came|showed|arrived)|number of cleaners|how many cleaners)/i,
  },
  {
    key: 'language', group: 'communication', label: 'Language barrier',
    definition: "The cleaner and the client couldn't understand each other, or the cleaner couldn't follow written instructions in English (or French).",
    examples: ["She didn't understand my instructions.", 'Only spoke French, could not explain what I needed.'],
    not_when: 'The cleaner understood but did not do it (instructions not followed).',
    re: /\b((did ?n'?t|does ?n'?t|did not|does not|could ?n'?t|could not|can'?t) (understand|speak|read) (english|french|me|us|my (instructions|notes))|language barrier|only (spoke|speaks|spoke in) (french|english)|no (english|french))/i,
  },
  {
    key: 'office_unresponsive', group: 'communication', label: 'Office slow or not responding',
    definition: 'The client contacted us and waited too long, or never got an answer.',
    examples: ['Nobody got back to me.', "I've emailed twice with no reply."],
    not_when: 'We answered but the answer was wrong or unclear (booking details not confirmed).',
    re: /\b(no (one|body) (called|replied|responded|got back)|never (heard|responded|replied|got back)|no (response|reply|answer|update)|unresponsive|ignored|(emailed|called|texted) (twice|three times|again))\b/i,
  },
  {
    key: 'booking_unclear', group: 'communication', label: 'Booking details not confirmed or unclear',
    definition: 'Time, scope, price or what was included was not confirmed, or the client understood it differently from us.',
    examples: ['I thought the oven was included.', 'Nobody confirmed the time, so I wasn\'t home.'],
    not_when: 'We clearly booked the wrong thing ourselves (that stays a Scope / booking error with no communication cause).',
    re: /\b((never|not|wasn'?t|was not) (confirmed|told (about|that)|clear|explained)|misunderst|confus(ed|ing)|unclear|i thought (it|the|that) (was|would)|was under the impression)/i,
  },
  {
    key: 'missed_areas', group: 'quality', label: 'Missed areas',
    definition: 'Specific rooms or tasks were skipped or not cleaned properly.',
    examples: ['The bathroom floor was not mopped.', 'Dust still on every shelf.'],
    not_when: 'They clearly ran out of time (rushed or short visit) or skipped something the client specifically asked for (instructions not followed).',
    re: null, // the Quality: missed areas category's own rules
  },
  {
    key: 'rushed', group: 'quality', label: 'Rushed or short visit',
    definition: 'The cleaner left early, spent less than the booked time, or the work looked hurried.',
    examples: ['They were only here an hour.', 'It felt rushed.'],
    not_when: 'Fewer cleaners than expected came (number of cleaners miscommunicated).',
    re: null, // the Quality: rushed category's own rules
  },
  {
    key: 'new_cleaner', group: 'quality', label: 'New or inexperienced cleaner',
    definition: 'The cleaner was new to us or to this kind of work, and it showed.',
    examples: ['It seemed like her first day.', "She didn't know how to use the steam mop."],
    not_when: 'The client is comparing with their previous cleaner (replacement quality).',
    re: /\b(new (cleaner|girl|lady|person|hire)|inexperienc|first (day|time|week)|in training|trainee|did ?n'?t know (how|what) to)/i,
  },
  {
    key: 'instructions_ignored', group: 'quality', label: "Client's instructions not followed",
    definition: 'The client gave clear instructions or notes and the cleaner did not follow them.',
    examples: ['I asked them not to use bleach on the counters.', 'The notes say to skip the office and they cleaned it anyway.'],
    not_when: "The cleaner couldn't understand the instructions (language barrier).",
    re: /\b((did ?n'?t|did not|never) (follow|read|listen|pay attention)|ignored (my|our|the) (instructions|notes|request)|despite (asking|telling|my|our)|(asked|told) (them|her|him) (not )?to|specifically (asked|requested|said))/i,
  },
];
export const CAUSE_KEYS = CAUSES.map((c) => c.key);
// Which complaints a cause can explain. A cause outside its row is an impossible pairing
// ("too many marketing emails" as the root cause of a breakage) and is dropped, whoever
// proposed it: the keyword rules, Claude, or the Launch27 facts. Checked by Derek's request
// after the Nov 28 run (A0d). 'other' and the hard categories keep only causes that fit them.
const QUALITY = ['quality_missed', 'quality_rushed'];
export const CAUSE_FITS = {
  regular_left: [...QUALITY, 'cleaner_change', 'communication', 'other'],
  changed_unannounced: [...QUALITY, 'cleaner_change', 'communication', 'other'],
  no_regular: [...QUALITY, 'cleaner_change', 'communication', 'other'],
  requested_unavailable: [...QUALITY, 'cleaner_change', 'communication', 'scope_booking', 'other'],
  replacement_quality: [...QUALITY, 'cleaner_change', 'other'],
  marketing_emails: ['communication', 'other'],
  team_size: [...QUALITY, 'scope_booking', 'punctuality', 'communication', 'pricing_billing', 'other'],
  language: [...QUALITY, 'communication', 'conduct_safety', 'scope_booking', 'cleaner_change', 'damage', 'other'],
  office_unresponsive: ['communication', 'scope_booking', 'pricing_billing', 'punctuality', 'damage', 'missing_item', 'conduct_safety', 'property_condition', ...QUALITY, 'cleaner_change', 'other'],
  booking_unclear: ['scope_booking', 'pricing_billing', 'communication', 'punctuality', 'property_condition', ...QUALITY, 'other'],
  missed_areas: [...QUALITY, 'scope_booking', 'property_condition', 'pricing_billing', 'other'],
  rushed: [...QUALITY, 'punctuality', 'scope_booking', 'pricing_billing', 'other'],
  new_cleaner: [...QUALITY, 'cleaner_change', 'damage', 'conduct_safety', 'punctuality', 'other'],
  instructions_ignored: [...QUALITY, 'scope_booking', 'damage', 'conduct_safety', 'communication', 'property_condition', 'other'],
};
export const causeFits = (cause, category) => !cause || cause === 'other' || !category || (CAUSE_FITS[cause] || []).includes(category);
export const causeLabel = (key) => CAUSES.find((c) => c.key === key)?.label || (key === 'other' ? 'Other / not on the list' : key ? key : 'Not set');
const CAUSE_RE = {
  ...Object.fromEntries(CAUSES.filter((c) => c.re).map((c) => [c.key, c.re])),
  missed_areas: CATEGORIES.find((c) => c.key === 'quality_missed').re,
  rushed: CATEGORIES.find((c) => c.key === 'quality_rushed').re,
};
// When several causes match, the more specific "why" wins over the symptom it produced:
// a cleaner who left explains the missed areas, not the other way round.
const CAUSE_ORDER = ['regular_left', 'changed_unannounced', 'requested_unavailable', 'no_regular', 'replacement_quality', 'language', 'team_size', 'marketing_emails', 'instructions_ignored', 'new_cleaner', 'office_unresponsive', 'booking_unclear', 'rushed', 'missed_areas'];

/** Rules-based root cause: { cause, contributing } from complaint text. Pure. */
export function causeRules(text) {
  const t = String(text || '');
  const hits = CAUSE_ORDER.filter((k) => CAUSE_RE[k].test(t));
  return { cause: hits[0] || null, contributing: hits.slice(1, 3) };
}

/**
 * Facts from Launch27 that point at a cause, for the person checking and as a tie-break
 * when the text says nothing specific. journey: a complaint_journeys row.
 */
export function causeFacts(j) {
  if (!j) return [];
  const out = [];
  if (j.regular_cleaner_left) out.push({ cause: 'regular_left', text: `Their regular cleaner${j.regular_cleaner_name ? ` (${j.regular_cleaner_name})` : ''} stopped working with us${j.regular_cleaner_last_worked ? ` after ${String(j.regular_cleaner_last_worked).slice(0, 10)}` : ''}` });
  if (j.cleaner_changed_last_visit) out.push({ cause: 'changed_unannounced', text: 'A different cleaner from the visit before' });
  if (Number(j.distinct_cleaners_90d) >= 3) out.push({ cause: 'no_regular', text: `${j.distinct_cleaners_90d} different cleaners in the 90 days before` });
  if (j.cleaner_visits_before != null && Number(j.cleaner_visits_before) < 10) out.push({ cause: 'new_cleaner', text: `The cleaner had ${j.cleaner_visits_before} visits with us before this one` });
  return out;
}

export const TONES = ['mild', 'frustrated', 'angry', 'threat_leave', 'threat_review'];
const TONE_RULES = [
  { key: 'threat_review', re: /\b(review|google|yelp|bbb|better business|post (about|this)|tell (everyone|my friends)|social media|facebook|reddit)\b/i },
  { key: 'threat_leave', re: /\b(cancel (my|all|the) (service|bookings?|subscription|account)|never (use|book) (you|again|urbanmop)|find (another|a different) (company|service)|done with (you|urbanmop)|won'?t be (booking|using))\b/i },
  { key: 'angry', re: /\b(unacceptable|ridiculous|disgust|furious|outrage|horrible|terrible|worst|appall|livid|scam)\b|!!|[A-Z]{6,}/ },
  { key: 'frustrated', re: /\b(disappoint|frustrat|upset|not happy|unhappy|annoy|again\b|second time|third time|keeps? happening)/i },
];

export const AREAS = ['kitchen', 'bathroom', 'floors', 'baseboards', 'dusting', 'windows', 'appliances', 'bedrooms', 'stairs'];
const AREA_RE = {
  kitchen: /\b(kitchen|counter(top)?s?|sink|stove(top)?|backsplash|cabinet)/i,
  bathroom: /\b(bath(room|tub)?|toilet|shower|washroom|mirror|vanity|grout)/i,
  floors: /\b(floor|vacuum|mop(ped|ping)?|carpet|rug)/i,
  baseboards: /\bbaseboard/i,
  dusting: /\b(dust|shel(f|ves)|blinds|ceiling fan|light fixture)/i,
  windows: /\b(window|sill|glass door)/i,
  appliances: /\b(oven|fridge|refrigerator|microwave|dishwasher)/i,
  bedrooms: /\b(bed(room)?|sheets|linen)/i,
  stairs: /\b(stair|railing|banister)/i,
};

// Never on the A/B/C/D ladder: straight to whoever holds the Office Manager role.
export const HARD_ROUTES = {
  damage_over_100: 'Damage claim over $100',
  theft_missing: 'Theft or missing item',
  safety: 'Safety incident',
  misconduct: 'Cleaner misconduct',
  legal_chargeback: 'Legal threat or chargeback',
};
const LEGAL_RE = /\b(lawyer|attorney|legal action|sue|suing|small claims|chargeback|dispute (the|this) (charge|payment)|credit card company|bank dispute)\b/i;
const SAFETY_RE = /\b(injur|hurt|unsafe|fire|flood(ed)?|gas leak|police|911|ambulance|assault)\b/i;
const MISCONDUCT_RE = /\b(harass|inappropriate|drunk|intoxicated|high on|smok(ed|ing) (in|inside)|went through (my|our)|snoop|brought (?:her |his |their )?(someone|a friend|kids?|children)|took (photos|pictures|videos?))\b/i;
const MONEY_RE = /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)/g;

export function amountsIn(text) {
  return [...String(text || '').matchAll(MONEY_RE)].map((m) => Number(m[1].replace(/,/g, ''))).filter((n) => Number.isFinite(n));
}

/** Rules-based classification of complaint text. Pure; no personal data leaves. */
export function classifyRules(text, { claimAmount = null } = {}) {
  const t = String(text || '');
  const hits = CATEGORIES.map((c) => ({ key: c.key, n: (t.match(new RegExp(c.re.source, 'gi')) || []).length })).filter((h) => h.n);
  // Damage/theft/conduct outrank quality even with fewer hits: they change who handles it.
  const priority = ['missing_item', 'conduct_safety', 'damage', 'property_condition', 'punctuality', 'pricing_billing', 'scope_booking'];
  hits.sort((a, b) => {
    const pa = priority.indexOf(a.key);
    const pb = priority.indexOf(b.key);
    if (pa !== -1 || pb !== -1) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
    return b.n - a.n;
  });
  const category = hits[0]?.key || 'other';
  const tone = TONE_RULES.find((r) => r.re.test(t))?.key || 'mild';
  const areas = AREAS.filter((a) => AREA_RE[a].test(t));
  const amount = claimAmount ?? Math.max(0, ...amountsIn(t));
  const hard = hardRouteFor({ category, text: t, amount });
  const severity = hard ? 4 : tone === 'threat_review' || tone === 'threat_leave' ? 3 : tone === 'angry' || category === 'damage' ? 3 : tone === 'frustrated' ? 2 : 1;
  const all = causeRules(t);
  const fitting = [all.cause, ...all.contributing].filter((k) => k && causeFits(k, category));
  const why = { cause: fitting[0] || null, contributing: fitting.slice(1, 3) };
  return {
    category, secondary: hits.slice(1, 3).map((h) => h.key), tone, areas, hard_route: hard, severity, confidence: hits.length ? Math.min(0.7, 0.35 + 0.1 * hits[0].n) : 0.2,
    cause: why.cause, contributing: why.contributing, cause_evidence: null, cause_by: why.cause ? 'rules' : null,
  };
}

export function hardRouteFor({ category, text = '', amount = 0 }) {
  if (LEGAL_RE.test(text)) return 'legal_chargeback';
  if (category === 'missing_item') return 'theft_missing';
  if (SAFETY_RE.test(text)) return 'safety';
  if (MISCONDUCT_RE.test(text)) return 'misconduct';
  if (category === 'damage' && Number(amount) > 100) return 'damage_over_100';
  return null;
}

/** Combine rules + model output. Hard routes from either side stick. */
export function mergeClassification(rules, model) {
  if (!model) return { ...rules, classified_by: 'rules' };
  const category = CATEGORY_KEYS.includes(model.category) ? model.category : rules.category;
  const hard = rules.hard_route || (model.hard_route && HARD_ROUTES[model.hard_route] ? model.hard_route : null);
  // Once Claude has read the case its answer stands, even "none of these" (so the case is never
  // sent again just for a cause). Its "other" doesn't wipe out a cause the keyword rules found.
  // A cause must fit the final category (CAUSE_FITS): Claude's if it does, else the rules'.
  const modelCause = CAUSE_KEYS.includes(model.cause) && causeFits(model.cause, category) ? model.cause : null;
  const rulesCause = causeFits(rules.cause, category) ? rules.cause : null;
  const cause = modelCause || rulesCause || 'other';
  return {
    cause,
    contributing: [...new Set((modelCause ? model.contributing || [] : rules.contributing || []).filter((k) => CAUSE_KEYS.includes(k) && k !== cause && causeFits(k, category)))].slice(0, 2),
    cause_evidence: modelCause ? String(model.cause_evidence || '').slice(0, 300) || null : null,
    cause_by: modelCause || !rulesCause ? 'claude' : 'rules',
    category,
    secondary: rules.secondary,
    tone: TONES.includes(model.tone) ? model.tone : rules.tone,
    areas: [...new Set([...(rules.areas || []), ...(model.areas || []).filter((a) => AREAS.includes(a))])],
    hard_route: hard,
    severity: hard ? 4 : Math.min(4, Math.max(1, Number(model.severity) || rules.severity)),
    summary: model.summary || null,
    is_complaint: model.is_complaint,
    confidence: Number(model.confidence) || 0.6,
    classified_by: 'claude',
  };
}
