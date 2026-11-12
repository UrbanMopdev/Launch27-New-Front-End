// Crew Planner: reading client preferences out of Launch27 tags and notes, and matching the
// names people type to real cleaners and clients. Pure functions (docs/crew-planner.md).

export const PREF_TYPES = ['PREF_CLEANER', 'AVOID_CLEANER', 'FEMALE_ONLY', 'NO_TRAINEES', 'CONSISTENT_CLEANER', 'FIXED_TIME', 'HOLD_UNPAID', 'PENDING_CANCEL'];
export const PREF_SOURCES = ['launch27_tag', 'launch27_note', 'continuity_history', 'grace_manual'];
// Types that name cleaners.
export const NAMES_CLEANERS = new Set(['PREF_CLEANER', 'AVOID_CLEANER']);

// Words that end a name ("prefers Karen for deep cleans" → Karen).
const STOP = new Set(['for', 'as', 'if', 'when', 'because', 'please', 'on', 'at', 'to', 'from', 'since', 'unless', 'again', 'anymore', 'ever', 'cleaner', 'cleaners', 'only', 'is', 'was', 'per', 'the', 'thanks', 'thank', 'every', 'each', 'in', 'with', 'she', 'he', 'they', 'but', 'until']);
const NOT_NAMES = new Set(['female', 'male', 'woman', 'women', 'man', 'men', 'same', 'consistent', 'regular', 'usual', 'trainee', 'trainees', 'new', 'a', 'an', 'the', 'any', 'her', 'his', 'their', 'cleaner', 'cleaners', 'team', 'teams', 'booked', 'be', 'not']);

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// "Etelvina or Khadra", "Karen & Mo", "Ruth/Amy" → ['Etelvina', 'Khadra'].
export function splitNames(text) {
  const out = [];
  for (const part of String(text || '').split(/\s*(?:\bor\b|\band\b|&|\/|,|\+)\s*/i)) {
    const words = [];
    for (const w of part.replace(/[^A-Za-zÀ-ÿ' -]/g, ' ').split(/\s+/).filter(Boolean)) {
      if (STOP.has(w.toLowerCase())) break;
      words.push(w);
      if (words.length === 3) break;
    }
    const name = words.join(' ').replace(/^['-]+|['-]+$/g, '').trim();
    if (name && !NOT_NAMES.has(name.toLowerCase()) && !NOT_NAMES.has(name.split(' ')[0].toLowerCase())) out.push(name);
  }
  return out;
}

// One line → the preferences it states. Each: { type, names: [], text }.
export function parseLine(raw) {
  const text = clean(String(raw || '').replace(/^\s*\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\s*:?\s*/, '').replace(/^#\s*/, ''));
  if (!text) return [];
  const l = text.toLowerCase();
  const out = [];
  const add = (type, names = []) => out.push({ type, names, text });

  // Time that mustn't move: "appointment should be at 9AM, do not move", "fixed time".
  if (/do\s*n[o']t\s*(?:move|change)\s*(?:the\s*)?(?:time|appointment|her|him|them|it)?\b|fixed\s*time|keep\s*(?:the\s*)?(?:same\s*)?time|time\s*is\s*fixed|must\s*be\s*at\s*\d/.test(l) && !/do\s*n[o']t\s*move\s+(?:to|with)\b/.test(l)) add('FIXED_TIME');
  // No trainees / new cleaners.
  if (/no\s*(?:trainees?|new\s*(?:hires?|cleaners?)|training)|without\s*(?:a\s*)?trainees?|not\s*(?:a\s*)?trainees?/.test(l)) add('NO_TRAINEES');
  // Female cleaner.
  if (/\bfemale\b|\bwom[ae]n\s*(?:cleaner|only)|\bladies\b/.test(l)) add('FEMALE_ONLY');
  // Same cleaner every time.
  if (/consistent|same\s*cleaner|same\s*person|same\s*team|regular\s*cleaner\s*only/.test(l)) add('CONSISTENT_CLEANER');
  // Cancelling soon.
  const notBooked = l.match(/requested\s*(?:not\s*to\s*be\s*booked|no\s*more\s*bookings)(?:\s*with\s+(.+))?/);
  if (notBooked && notBooked[1]) add('AVOID_CLEANER', splitNames(text.slice(text.toLowerCase().indexOf(notBooked[1]))));
  else if (notBooked || /pending\s*cancel|wants?\s*to\s*cancel|cancell?ing\s*(?:service|after|at|their)|will\s*cancel|(?:is|will\s*be)\s*(?:the|their|her|his)\s*last\s*(?:clean|visit)\b/.test(l)) add('PENDING_CANCEL');
  // Owes money.
  if (/\bowes?\b|unpaid|balance\s*(?:owing|due|outstanding)|outstanding\s*balance|payment\s*(?:declined|failed)|collect\s*payment/.test(l)) add('HOLD_UNPAID');

  // Cleaners to avoid: "do not assign X", "do not send X", "avoid X", "no X please".
  const avoid = text.match(/(?:do\s*n[o']t|never)\s*(?:assign|send|book|schedule)\s+(?:with\s+)?(.+)|\bavoid\s+(?:cleaner\s+)?(.+)/i);
  if (avoid) {
    const names = splitNames(avoid[1] || avoid[2]);
    if (names.length) add('AVOID_CLEANER', names);
  }
  // Preferred cleaners, in order: "Tyler if Karlo is unavailable" (Karlo first, then Tyler).
  const fallback = text.match(/^([A-Za-zÀ-ÿ' -]+?)\s+if\s+([A-Za-zÀ-ÿ' -]+?)\s+(?:is\s*)?(?:un|not\s*)available/i);
  if (fallback && !avoid) {
    const names = [...splitNames(fallback[2]), ...splitNames(fallback[1])];
    if (names.length) add('PREF_CLEANER', names);
  } else if (!avoid) {
    // "prefers X", "preferred cleaner: X", "X only" (but not "female only").
    const pref = text.match(/\bprefer(?:s|red)?\s*(?:cleaner\s*(?:is|:)?\s*)?:?\s*(.+)|\brequests?\s+(?!female|male)([A-Za-zÀ-ÿ' ]+?)\s*(?:only|as\s*(?:her|his|their)\s*cleaner)/i);
    const only = text.match(/^(?:client\s+)?(?:wants\s+)?([A-Za-zÀ-ÿ' ]+?(?:\s*(?:or|and|&|\/)\s*[A-Za-zÀ-ÿ' ]+?)*)\s+only\b/i);
    const from = pref ? pref[1] || pref[2] : only ? only[1] : null;
    if (from) {
      const names = splitNames(from);
      if (names.length) add('PREF_CLEANER', names);
    }
  }
  return out;
}

// A whole tag list or notes field → preferences, one line at a time, de-duplicated.
export function parsePrefText(text) {
  const seen = new Set();
  const out = [];
  for (const line of String(text || '').split(/\r?\n|;|•/)) {
    for (const p of parseLine(line)) {
      const k = `${p.type}|${p.names.join(',').toLowerCase()}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(p);
    }
  }
  return out;
}

// ---------- name matching ----------
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z' -]/g, ' ').replace(/\s+/g, ' ').trim();
const words = (s) => norm(s).split(' ').filter((w) => w.length > 1 || /^[a-z]$/.test(w));

// cleaners: [{ id, name, aliases? }]. Returns { id } | { ambiguous: [ids] } | null.
// Tries the full name, then an alias, then a unique first name (or unique first + last).
export function matchCleaner(wanted, cleaners) {
  const w = norm(wanted);
  if (!w) return null;
  const pick = (list) => (list.length === 1 ? { id: list[0].id } : list.length > 1 ? { ambiguous: list.map((c) => c.id) } : null);
  const exact = cleaners.filter((c) => norm(c.name) === w);
  if (exact.length) return pick(exact);
  const alias = cleaners.filter((c) => (c.aliases || []).some((a) => norm(a) === w));
  if (alias.length) return pick(alias);
  const ww = words(wanted);
  const starts = cleaners.filter((c) => {
    const cw = words(c.name);
    return ww.every((x, i) => cw[i] === x) || (ww.length >= 2 && cw[0] === ww[0] && cw[cw.length - 1] === ww[ww.length - 1]);
  });
  if (starts.length) return pick(starts);
  // Any word of the cleaner's name ("Sadam" for "Mohamed Sadam") when it's the only one.
  if (ww.length === 1) return pick(cleaners.filter((c) => words(c.name).includes(ww[0])));
  return null;
}

// customers: [{ id, name }]. Same idea, but stricter: first and last name must both match
// (middle names and initials are ignored: "Denis R Gervais" = "Denis Gervais").
export function matchClient(wanted, customers) {
  const ww = words(wanted);
  if (!ww.length) return null;
  const pick = (list) => (list.length === 1 ? { id: list[0].id } : list.length > 1 ? { ambiguous: list.map((c) => c.id) } : null);
  const exact = customers.filter((c) => norm(c.name) === norm(wanted));
  if (exact.length) return pick(exact);
  if (ww.length < 2) return null;
  const first = ww[0];
  const last = ww[ww.length - 1];
  return pick(customers.filter((c) => {
    const cw = words(c.name);
    return cw.length >= 2 && cw[0] === first && cw[cw.length - 1] === last;
  }));
}

// History says this client has a regular: the same cleaner on at least 3 visits and more than
// half of them. history: { cleanerId: visits }.
export function continuitySuggestion(history, minVisits = 3) {
  const entries = Object.entries(history || {}).map(([id, n]) => [Number(id), Number(n)]);
  const total = entries.reduce((s, [, n]) => s + n, 0);
  if (!total) return null;
  const [id, n] = entries.sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  return n >= minVisits && n / total > 0.5 ? { cleaner_id: id, visits: n, of: total } : null;
}

// ---------- postal codes ----------
// "k2g 2x1" → "K2G".
export const fsaOf = (zip) => {
  const m = String(zip || '').toUpperCase().replace(/\s+/g, '').match(/^([A-Z]\d[A-Z])/);
  return m ? m[1] : null;
};
// clusters: Map or object fsa → cluster name.
export function clusterOf(zip, clusters) {
  const fsa = fsaOf(zip);
  if (!fsa) return null;
  return (clusters instanceof Map ? clusters.get(fsa) : clusters?.[fsa]) || null;
}

// ---------- Launch27 title codes ----------
// "(1)(F)(FT) Jane Doe" → tier 1, F. The planner's own parser (schedule/rules.js) gives gender; tier
// is the (1)/(2)/(3) code.
export function tierFromTitle(title) {
  const m = String(title || '').match(/\(\s*([123])\s*\)/);
  return m ? Number(m[1]) : null;
}
