// Routing rules: ordered, first match wins, everything else goes to the fallback queue.
//
// conditions (every key given must match; inside a key, any value may match):
//   channel:          ['email', 'sms', 'voice', 'chat']
//   to:               our addresses / numbers the message was sent to
//   from_contains:    parts of the sender's address
//   subject_contains: parts of the subject (case-insensitive)
//   text_contains:    parts of the subject or body
//   text_excludes:    none of these may appear in the subject or body
//   contact_role:     ['cleaner', 'customer', 'applicant']
//   lead_stage:       contact lead stages
//   any:              [ {conditions}, ... ]  at least one must match (an OR group)
// action:
//   queue (slug), sla (policy slug), priority (1-5), mark_done (bool),
//   redact (bool: replace the body, e.g. bank verification codes), disposition

import { normalizeIdentity } from './normalize.js';

const lc = (s) => String(s ?? '').toLowerCase();
const containsAny = (hay, needles) => needles.some((n) => lc(hay).includes(lc(n)));

export function matches(conditions = {}, ctx) {
  const c = conditions;
  const text = `${ctx.subject || ''}\n${ctx.body || ''}`;
  if (c.channel?.length && !c.channel.includes(ctx.channel)) return false;
  if (c.to?.length) {
    const ours = c.to.map((v) => normalizeIdentity(v.includes('@') ? 'email' : 'phone', v) || lc(v));
    if (!ours.includes(ctx.to)) return false;
  }
  if (c.from_contains?.length && !containsAny(ctx.from, c.from_contains)) return false;
  if (c.subject_contains?.length && !containsAny(ctx.subject, c.subject_contains)) return false;
  if (c.text_contains?.length && !containsAny(text, c.text_contains)) return false;
  if (c.text_excludes?.length && containsAny(text, c.text_excludes)) return false;
  if (c.contact_role?.length && !c.contact_role.some((r) => (ctx.roles || []).includes(r))) return false;
  if (c.lead_stage?.length && !c.lead_stage.includes(ctx.leadStage)) return false;
  if (c.any?.length && !c.any.some((sub) => matches(sub, ctx))) return false;
  return true;
}

// ctx: { channel, to, from, subject, body, roles, leadStage } with normalized to/from.
export function route(rules, ctx) {
  const ordered = [...rules].filter((r) => r.enabled !== false).sort((a, b) => a.position - b.position);
  for (const rule of ordered) {
    if (matches(rule.conditions, ctx)) return { rule, action: rule.action || {} };
  }
  return { rule: null, action: { queue: 'fallback' } };
}

const isEmpty = (c) => !c || Object.values(c).every((v) => v === undefined || (Array.isArray(v) && v.length === 0));
const canonical = (c) => JSON.stringify(Object.fromEntries(Object.entries(c || {}).filter(([, v]) => !(Array.isArray(v) && !v.length)).sort(([a], [b]) => a.localeCompare(b))));

// Warnings an admin sees before saving: rules that can never match.
export function lintRules(rules) {
  const ordered = [...rules].filter((r) => r.enabled !== false).sort((a, b) => a.position - b.position);
  const warnings = [];
  ordered.forEach((rule, i) => {
    const earlier = ordered.slice(0, i);
    const catchAll = earlier.find((e) => isEmpty(e.conditions));
    if (catchAll) {
      warnings.push({ ruleId: rule.id, message: `"${rule.name}" never runs: "${catchAll.name}" above it has no conditions and matches everything.` });
      return;
    }
    const twin = earlier.find((e) => canonical(e.conditions) === canonical(rule.conditions));
    if (twin) warnings.push({ ruleId: rule.id, message: `"${rule.name}" never runs: "${twin.name}" above it has the same conditions.` });
    if (!rule.action?.queue && !rule.action?.mark_done) warnings.push({ ruleId: rule.id, message: `"${rule.name}" has no queue and doesn't mark done.` });
  });
  return warnings;
}
