// Raise readiness: every tunable number in one place. Change a value here and restart the
// server. (Phase 2 moves these to an admin settings screen.)
export const RAISE_THRESHOLDS = {
  // The verdict always uses this window, whatever period the page shows.
  windowDays: 91,

  // Not enough to judge: fewer visits or rated visits than this in the window shows "—".
  minVisits: 20,
  minRated: 10,

  // Verdict rule: Ready = no "Not yet" factors and at least this many "Ready" factors.
  readyFactorsNeeded: 7,
  // Not yet = this many "Not yet" factors (or a hard gate below).
  notYetFactors: 3,

  // Each factor: the "Ready" line and the "Watch" line. Anything worse is "Not yet".
  tenureMonths: { ready: 6, watch: 3 },
  happy: { ready: 0.9, watch: 0.8, minRated: 15 },
  stars: { ready: 4.6, watch: 4.3, minCount: 30 },
  onTime: { ready: 0.95, watch: 0.85 },
  lastMinute: { ready: 0, watch: 1 }, // cleaner-initiated drops < 24 h before the start
  shortNotice: { ready: 1, watch: 3 }, // drops 24–72 h before + missing check-ins/outs
  finishedEarly: { ready: 0.1, watch: 0.2 }, // share of residential visits
  complaints: { ready: 0, watch: 1 },
  keeps: { ready: 0.9, watch: 0.75 },
  hoursPerWeek: { ready: 30, watch: 20 },
  restrictiveTags: { ready: 2, watch: 4 },
  googleReviews: { ready: 2, watch: 1 }, // a bonus only: never counts against them

  // Hard gates: any no-show, or this many last-minute cancellations, means "Not yet".
  gateLastMinute: 2,

  // Ratings can't carry a "Ready" alone while fewer than this share of visits get rated: the
  // rating factor still counts, but at least this many non-rating factors must be "Ready" too.
  thinRatingShare: 0.2,

  // A pattern of drops is penalised even when each one had notice: this many cleaner-initiated
  // drops in the window, or this many on a Monday or Friday. A pattern makes the short-notice
  // factor "Not yet". The first sick day in the window is a one-off and isn't counted.
  patternDrops: 3,
  patternMonFri: 2,
  forgiveFirstSickDay: true,

  // Re-review dates.
  reReviewDays: { not_yet: 90, watch: 60 },

  // Contractors at this hourly rate are at the ceiling: no $ raise to decide.
  ceilingRate: 25,
};

// When a cleaner drops a visit (or is taken off it), dispatch picks one of these. Only
// cleaner-initiated codes count against the cleaner.
export const DROP_REASONS = {
  cleaner_sick: { label: 'Cleaner – sick', cleaner: true },
  cleaner_personal: { label: 'Cleaner – personal', cleaner: true },
  cleaner_no_show: { label: 'Cleaner – no-show', cleaner: true, noShow: true },
  client_cancelled: { label: 'Client cancelled', cleaner: false },
  office_reschedule: { label: 'Office reschedule', cleaner: false },
  weather: { label: 'Weather/emergency', cleaner: false },
};

// The app keeps its own log of schedule changes from this date (Launch27 hides cancelled
// bookings). Drop counts before it are unknown and show "—".
export const CHANGE_LOG_START = '2026-10-31';

// On time = checked in within the first 15 minutes of the arrival window (residential).
// Homemaking visits (Carefor, OWCS, Bruyère) are fixed 2-hour visits: on time = start + 10 min.
// "Minutes late" counts from those marks.
export const ON_TIME_MIN = 15;
export const HOMEMAKING_GRACE_MIN = 10;
// Finished early: on site this many minutes less than booked (residential, one cleaner).
export const EARLY_MIN = 30;

// Tags on a cleaner's Launch27 profile that narrow which visits they can take.
export const RESTRICTIVE_TAGS = [
  { key: 'pets', re: /\b(pet|dog|cat)s?\b.*\b(fear|afraid|allerg|no)\b|\b(no|fear|afraid|allerg\w*)\b.*\b(pet|dog|cat)s?\b|allerg/i, label: 'Pet fears / allergies' },
  { key: 'radius', re: /max(imum)?\s*(of\s*)?\d+\s*(min|km)|drive radius|close to home|no (long )?driv/i, label: 'Drive radius' },
  { key: 'short', re: /no\s*2\s*-?\s*h(ou)?r|no short|min(imum)?\s*\d+\s*h/i, label: 'No 2-hour jobs' },
  { key: 'pair', re: /do\s*not\s*pair|don'?t pair|no team|solo only|works alone/i, label: 'Do-not-pair' },
  { key: 'address', re: /do\s*not\s*(send|assign)|banned|not (allowed|welcome) at/i, label: 'Address bans' },
  { key: 'weekend', re: /no\s*(weekend|saturday|sunday)s?|weekdays only|weekend limit/i, label: 'Weekend limits' },
];

// Employee cleaners move up a ladder rather than getting a $ raise. Read from their tags.
export const EMPLOYEE_TAG = /\bemployee\b/i;
export const LADDER = ['Regular', 'Flex', 'Team Lead', 'Trainer'];
