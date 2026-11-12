// Utilization: every tunable number in one place. Change a value here and restart the server.
export const UTILIZATION = {
  // Days the business operates (0 = Sunday … 6 = Saturday). Other days are left out of
  // availability and bookings everywhere on the page.
  operatingDays: [1, 2, 3, 4, 5, 6],

  // Travel is worked out per cleaner per day along their route: home → 1st visit → 2nd → … →
  // last → home, each leg timed with the planner's model (6 min + 2 min/km straight-line
  // driving; 10 min + 4 min/km on transit). Visits without a cleaner yet count one average leg.
  travelReturnHome: true, // count the drive home after the last visit of the day
  travelFallbackMinutes: 20, // a leg where the home or the client has no map pin

  // "Room for about N more bookings": the hours left ÷ (a typical booking + one average leg).
  // The typical booking is the average booked length in the chosen dates; this is the fallback.
  typicalBookingHours: 3,

  // How many weeks the weekly chart shows.
  trendWeeks: 8,

  // Areas, in this order (others, such as Unknown, follow).
  areas: ['Central', 'North', 'South', 'East', 'West'],
};
