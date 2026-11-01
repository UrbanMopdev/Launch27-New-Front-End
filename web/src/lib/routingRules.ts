// Routing rules as the settings screen sees them: a form (fields, values, OR groups)
// instead of the JSON the server stores. Kept pure so it can be tested.
//
// Stored shape (server/src/inbox/routing.js):
//   conditions: { channel: [...], to: [...], from_contains: [...], ..., any: [{...}, {...}] }
//   every top-level key must match; `any` is a list of alternatives, one must match.
// Form shape:
//   all:          [{ field, values }]      every one must match
//   alternatives: [[{ field, values }], …] at least one alternative must fully match

export type ConditionField = 'channel' | 'to' | 'from_contains' | 'subject_contains' | 'text_contains' | 'text_excludes' | 'contact_role' | 'lead_stage';
export type FieldKind = 'channel' | 'role' | 'address' | 'words' | 'stage';

export interface ConditionRow {
  field: ConditionField;
  values: string[];
}

export interface RuleForm {
  all: ConditionRow[];
  alternatives: ConditionRow[][];
  // Anything we don't have a control for (e.g. an OR group inside an OR group) is kept as is.
  extra: Record<string, unknown>;
}

export const FIELDS: Record<ConditionField, { label: string; kind: FieldKind; phrase: string; help: string; placeholder?: string }> = {
  channel: { label: 'Channel', kind: 'channel', phrase: 'arrives by', help: 'How the message reached us.' },
  to: { label: 'Sent to', kind: 'address', phrase: 'is sent to', help: 'Which of our email addresses or phone numbers received it.', placeholder: 'Another address or number' },
  from_contains: { label: 'Sender includes', kind: 'words', phrase: "sender's address includes", help: 'Part of the sender’s email address or phone number, e.g. "stripe.com".', placeholder: 'e.g. stripe.com' },
  subject_contains: { label: 'Subject includes', kind: 'words', phrase: 'subject includes', help: 'Words or phrases in the email subject. Not case-sensitive.', placeholder: 'e.g. Quote request' },
  text_contains: { label: 'Message includes', kind: 'words', phrase: 'subject or message includes', help: 'Words or phrases anywhere in the subject or message. Not case-sensitive.', placeholder: 'e.g. refund' },
  text_excludes: { label: 'Message does not include', kind: 'words', phrase: 'subject and message do not include', help: 'The rule is skipped if any of these appear.', placeholder: 'e.g. unsubscribe' },
  contact_role: { label: 'Contact is a', kind: 'role', phrase: 'contact is a', help: 'Who we know the sender to be, from Launch27 or their contact profile.' },
  lead_stage: { label: 'Lead stage is', kind: 'stage', phrase: 'lead stage is', help: 'The contact’s sales lead stage.' },
};

export const FIELD_ORDER = Object.keys(FIELDS) as ConditionField[];

export const CHANNEL_OPTIONS = [
  { value: 'email', label: 'Email' },
  { value: 'sms', label: 'Text' },
  { value: 'voice', label: 'Call' },
  { value: 'chat', label: 'Chat' },
];

export const ROLE_OPTIONS = [
  { value: 'customer', label: 'Customer' },
  { value: 'cleaner', label: 'Cleaner' },
  { value: 'applicant', label: 'Applicant' },
];

export const LEAD_STAGES = ['New', 'Attempt #1', 'Attempt #2', 'Attempt #3', 'Contacted Highly Interested', 'Contacted Undecided', 'Booked', 'Not Interested-Price', 'Not Interested-Timing', 'Not Interested-Other', 'Non-Region'];

export const PRIORITY_OPTIONS = [
  { value: 1, label: 'Lowest' },
  { value: 2, label: 'Low' },
  { value: 3, label: 'Normal' },
  { value: 4, label: 'High' },
  { value: 5, label: 'Urgent' },
];

const isField = (k: string): k is ConditionField => k in FIELDS;
const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v === undefined || v === null || v === '' ? [] : [String(v)]);

function rowsOf(c: Record<string, unknown>): { rows: ConditionRow[]; extra: Record<string, unknown> } {
  const rows: ConditionRow[] = [];
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c || {})) {
    if (isField(k)) rows.push({ field: k, values: asList(v) });
    else if (k !== 'any') extra[k] = v;
  }
  return { rows, extra };
}

export function toForm(conditions: Record<string, unknown> = {}): RuleForm {
  const { rows, extra } = rowsOf(conditions);
  const alternatives: ConditionRow[][] = [];
  if (Array.isArray(conditions.any)) {
    for (const sub of conditions.any as Record<string, unknown>[]) {
      const inner = rowsOf(sub);
      // A nested group we can't show: keep the whole `any` untouched.
      if (Object.keys(inner.extra).length || Array.isArray(sub?.any)) return { all: rows, alternatives: [], extra: { ...extra, any: conditions.any } };
      alternatives.push(inner.rows);
    }
  }
  return { all: rows, alternatives, extra };
}

function objectOf(rows: ConditionRow[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const r of rows) {
    const values = r.values.map((v) => v.trim()).filter(Boolean);
    if (!values.length) continue;
    out[r.field] = [...new Set([...(out[r.field] || []), ...values])];
  }
  return out;
}

export function fromForm(form: RuleForm): Record<string, unknown> {
  const out: Record<string, unknown> = { ...form.extra, ...objectOf(form.all) };
  const any = form.alternatives.map(objectOf).filter((o) => Object.keys(o).length);
  if (any.length) out.any = any;
  return out;
}

// ---------- plain-English summaries ----------

export interface Lookups {
  queueName: (slug: string) => string;
  slaName: (slug: string) => string;
}

const label = (options: { value: string; label: string }[], v: string) => options.find((o) => o.value === v)?.label || v;
const orList = (values: string[]) => (values.length <= 1 ? values.join('') : `${values.slice(0, -1).join(', ')} or ${values[values.length - 1]}`);

export function describeRow(row: ConditionRow): string {
  const f = FIELDS[row.field];
  const vals = row.values.filter(Boolean);
  if (!vals.length) return `${f.label.toLowerCase()} (not set)`;
  if (f.kind === 'channel') return `arrives by ${orList(vals.map((v) => label(CHANNEL_OPTIONS, v).toLowerCase()))}`;
  if (f.kind === 'role') return `contact is a ${orList(vals.map((v) => label(ROLE_OPTIONS, v).toLowerCase()))}`;
  if (f.kind === 'address' || f.kind === 'stage') return `${f.phrase} ${orList(vals)}`;
  return `${f.phrase} ${orList(vals.map((v) => `“${v}”`))}`;
}

export function describeConditions(conditions: Record<string, unknown>): string[] {
  const form = toForm(conditions);
  const parts = form.all.map(describeRow);
  if (form.alternatives.length) {
    const alts = form.alternatives.map((rows) => rows.map(describeRow).join(' and '));
    parts.push(alts.length === 1 ? alts[0] : `any of: ${alts.map((a, i) => `(${i + 1}) ${a}`).join('; ')}`);
  }
  if ('any' in form.extra) parts.push('an advanced condition group');
  return parts;
}

export function describeAction(action: Record<string, unknown>, lookups: Lookups): string {
  const parts: string[] = [];
  if (action.queue) parts.push(`send to ${lookups.queueName(String(action.queue))}`);
  if (action.mark_done) parts.push(action.queue ? 'mark done' : 'mark done (no queue)');
  if (action.redact) parts.push('hide the message text');
  if (action.sla) parts.push(`reply target: ${lookups.slaName(String(action.sla))}`);
  if (action.priority) parts.push(`priority: ${PRIORITY_OPTIONS.find((p) => p.value === Number(action.priority))?.label || action.priority}`);
  return parts.join(' · ') || 'does nothing yet';
}

// ---------- problems to flag before saving ----------

export interface RuleLike {
  name: string;
  enabled: boolean;
  conditions: Record<string, unknown>;
  action: Record<string, unknown>;
}

const isEmpty = (c: Record<string, unknown>) => !c || Object.values(c).every((v) => v === undefined || (Array.isArray(v) && v.length === 0));
const canonical = (c: Record<string, unknown>) =>
  JSON.stringify(Object.fromEntries(Object.entries(c || {}).filter(([, v]) => !(Array.isArray(v) && !v.length)).sort(([a], [b]) => a.localeCompare(b))));

// Same checks as the server's lintRules, plus missing names. Index = position in the list.
export function ruleProblems(rules: RuleLike[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  const add = (i: number, msg: string) => out.set(i, [...(out.get(i) || []), msg]);
  const names = new Map<string, number>();
  rules.forEach((rule, i) => {
    if (!rule.name.trim()) add(i, 'Give this rule a name.');
    const n = rule.name.trim().toLowerCase();
    if (n && names.has(n)) add(i, `Another rule (#${names.get(n)! + 1}) has the same name.`);
    else if (n) names.set(n, i);
    if (!rule.enabled) return;
    if (!rule.action?.queue && !rule.action?.mark_done) add(i, 'Pick a queue to send these to, or mark them done.');
    for (let j = 0; j < i; j++) {
      const e = rules[j];
      if (!e.enabled) continue;
      if (isEmpty(e.conditions)) {
        add(i, `Never runs: rule #${j + 1} “${e.name}” above it has no conditions and catches everything.`);
        break;
      }
      if (canonical(e.conditions) === canonical(rule.conditions)) {
        add(i, `Never runs: rule #${j + 1} “${e.name}” above it has the same conditions.`);
        break;
      }
      // A rule above that takes a whole channel (e.g. "all email") wins for that channel.
      const broad = channelOnly(e.conditions);
      if (broad) {
        const mine = asList(rule.conditions.channel);
        const names = broad.map((c) => CHANNEL_OPTIONS.find((o) => o.value === c)?.label.toLowerCase() || c);
        if (mine.length && mine.every((c) => broad.includes(c))) {
          add(i, `Never runs: rule #${j + 1} “${e.name}” above it already takes every ${orList(names)}. Move this rule above it.`);
          break;
        }
        if (!mine.length) add(i, `Rule #${j + 1} “${e.name}” above it takes every ${orList(names)} first, so this rule only applies to other channels. Move it up if it should win.`);
      }
    }
  });
  return out;
}

// Conditions that are only a channel list (a "catch the rest of this channel" rule).
function channelOnly(c: Record<string, unknown>): string[] | null {
  const keys = Object.entries(c || {}).filter(([, v]) => !(Array.isArray(v) && !v.length));
  return keys.length === 1 && keys[0][0] === 'channel' ? asList(keys[0][1]) : null;
}

// Where a new rule should go: above the first catch-all or whole-channel rule, so the
// broad rules at the bottom don't swallow it. Otherwise at the end.
export function newRuleIndex(rules: RuleLike[]): number {
  const i = rules.findIndex((r) => r.enabled && (isEmpty(r.conditions) || channelOnly(r.conditions)));
  return i === -1 ? rules.length : i;
}

// Minutes as people say them: 90 -> "1 h 30 min", 1440 -> "1 day".
export function formatMinutes(m: number | null | undefined): string {
  if (m === null || m === undefined || Number.isNaN(m)) return '—';
  if (m === 0) return '0 min';
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const min = m % 60;
  const parts = [];
  if (d) parts.push(`${d} day${d === 1 ? '' : 's'}`);
  if (h) parts.push(`${h} h`);
  if (min) parts.push(`${min} min`);
  return parts.join(' ');
}
