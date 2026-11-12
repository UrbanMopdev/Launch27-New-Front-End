// Headroom: every tunable number in one place. Change a value here and restart the server.
export const HEADROOM = {
  // Days the business operates (0 = Sunday … 6 = Saturday). Other days are left out of
  // availability and bookings everywhere on the page.
  operatingDays: [1, 2, 3, 4, 5, 6],

  // Deductions (adjusted headroom only; raw headroom ignores them).
  // Travel is worked out per cleaner per day along their route: home → 1st visit → 2nd → … →
  // last → home, each leg timed with the planner's model (6 min + 2 min/km straight-line
  // driving; 10 min + 4 min/km on transit). These two values fill the gaps:
  travelReturnHome: true, // count the drive home after the last visit of the day
  travelFallbackMinutes: 20, // a leg where the home or the client has no map pin
  // Unassigned visits have no route yet: each counts one leg of the average upcoming leg
  // (or the fallback above when there are no legs to average).
  fragmentMinHours: 2.5, // open stretches shorter than this can't take a booking

  // Status thresholds on headroom % (of usable availability).
  redAt: 0.15, // RED at or below
  amberAt: 0.25, // AMBER at or below (above redAt); GREEN above

  // Window choices (weeks), and the trend length.
  windows: [1, 2, 4, 8],
  trendWeeks: 8,

  // Areas shown in the "By area" table, in this order (others, such as Unknown, follow).
  areas: ['Central', 'North', 'South', 'East', 'West'],
};
