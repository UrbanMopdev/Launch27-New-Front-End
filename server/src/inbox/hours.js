// Business hours and the SLA clock.
// Times are stored in UTC; opening hours are wall-clock times in the brand's time zone,
// so daylight saving changes are handled by converting each day's open/close separately.

export const URBANMOP_HOURS = {
  timeZone: 'America/Toronto',
  // weekday 0 = Sunday. [open, close] as "HH:MM" local time; null = closed.
  week: {
    0: ['09:00', '17:00'],
    1: ['08:00', '20:00'],
    2: ['08:00', '20:00'],
    3: ['08:00', '20:00'],
    4: ['08:00', '20:00'],
    5: ['08:00', '20:00'],
    6: ['08:00', '20:00'],
  },
};

const MINUTE = 60_000;

// Local calendar parts of an instant in a time zone.
export function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { y: +get('year'), m: +get('month'), d: +get('day'), h: +get('hour'), mi: +get('minute'), s: +get('second'), weekday };
}

// The UTC instant of a local wall-clock time in a zone.
export function fromZoned(y, m, d, h, mi, timeZone) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const offsetAt = (t) => {
    const p = zonedParts(new Date(t), timeZone);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - t;
  };
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t); // second pass settles DST edges
  return new Date(t);
}

const isoDay = (p) => `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;

// [open, close] instants for the local day containing `date`, or null when closed.
export function windowFor(date, hours = URBANMOP_HOURS, holidays = new Set()) {
  const p = zonedParts(date, hours.timeZone);
  if (holidays.has(isoDay(p))) return null;
  const span = hours.week[p.weekday];
  if (!span) return null;
  const [oh, om] = span[0].split(':').map(Number);
  const [ch, cm] = span[1].split(':').map(Number);
  return [fromZoned(p.y, p.m, p.d, oh, om, hours.timeZone), fromZoned(p.y, p.m, p.d, ch, cm, hours.timeZone)];
}

export function isOpen(date, hours = URBANMOP_HOURS, holidays = new Set()) {
  const w = windowFor(date, hours, holidays);
  return !!w && date >= w[0] && date < w[1];
}

// Start of the next local day (noon-anchored so DST never skips a day).
function nextDay(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const noon = fromZoned(p.y, p.m, p.d, 12, 0, timeZone);
  const n = zonedParts(new Date(noon.getTime() + 24 * 3600_000), timeZone);
  return fromZoned(n.y, n.m, n.d, 0, 0, timeZone);
}

// Add `minutes` of open time to `start`. With businessHours=false this is plain clock time.
export function addBusinessMinutes(start, minutes, { hours = URBANMOP_HOURS, holidays = new Set(), businessHours = true } = {}) {
  if (!businessHours) return new Date(start.getTime() + minutes * MINUTE);
  let t = new Date(start);
  let left = minutes * MINUTE;
  for (let guard = 0; guard < 400; guard++) {
    const w = windowFor(t, hours, holidays);
    if (!w || t >= w[1]) {
      t = nextDay(t, hours.timeZone);
      continue;
    }
    if (t < w[0]) t = w[0];
    const room = w[1] - t;
    if (left <= room) return new Date(t.getTime() + left);
    left -= room;
    t = nextDay(t, hours.timeZone);
  }
  throw new Error('No business hours found within 400 days');
}
