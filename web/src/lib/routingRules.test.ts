import { describe, expect, it } from 'vitest';
import { describeAction, describeConditions, formatMinutes, fromForm, newRuleIndex, ruleProblems, toForm } from './routingRules';

// Shapes taken from the seeded UrbanMop rules (server/src/inbox/seed.js).
const systemNotices = {
  any: [
    { from_contains: ['notify@ringcentral.com', 'team@bark.com'] },
    { to: ['no-reply@urbanmop.ca'] },
    { subject_contains: ['New booking request by'], text_excludes: ['Booking inserted into Launch 27?: N'] },
  ],
};
const ottawaSms = { channel: ['sms'], to: ['+16136919880'] };

describe('rule form <-> stored conditions', () => {
  it('round-trips every seeded shape without loss', () => {
    for (const c of [systemNotices, ottawaSms, {}, { contact_role: ['cleaner'] }, { channel: ['email'], any: [{ to: ['billing@urbanmop.ca'] }, { from_contains: ['intuit'] }] }]) {
      expect(fromForm(toForm(c))).toEqual(c);
    }
  });

  it('splits required conditions from OR alternatives', () => {
    const f = toForm({ channel: ['email'], any: [{ to: ['a@x.ca'] }, { subject_contains: ['x'], text_excludes: ['y'] }] });
    expect(f.all).toEqual([{ field: 'channel', values: ['email'] }]);
    expect(f.alternatives).toHaveLength(2);
    expect(f.alternatives[1].map((r) => r.field)).toEqual(['subject_contains', 'text_excludes']);
  });

  it('drops blank values and empty alternatives, merges repeated fields', () => {
    const c = fromForm({
      all: [
        { field: 'subject_contains', values: ['quote', ' '] },
        { field: 'subject_contains', values: ['Quote Lead Form', 'quote'] },
        { field: 'channel', values: [] },
      ],
      alternatives: [[{ field: 'to', values: [''] }]],
      extra: {},
    });
    expect(c).toEqual({ subject_contains: ['quote', 'Quote Lead Form'] });
  });

  it('keeps conditions it has no control for', () => {
    const nested = { channel: ['email'], any: [{ any: [{ to: ['a@x.ca'] }] }] };
    const f = toForm(nested);
    expect(f.alternatives).toEqual([]);
    expect(fromForm(f)).toEqual(nested);
  });
});

describe('plain-English summaries', () => {
  it('describes conditions and actions', () => {
    expect(describeConditions(ottawaSms)).toEqual(['arrives by text', 'is sent to +16136919880']);
    expect(describeConditions({ subject_contains: ['a', 'b', 'c'] })).toEqual(['subject includes “a”, “b” or “c”']);
    expect(describeConditions({ any: [{ to: ['x@y.ca'] }, { contact_role: ['cleaner'] }] })).toEqual(['any of: (1) is sent to x@y.ca; (2) contact is a cleaner']);
    const lookups = { queueName: (s: string) => s.toUpperCase(), slaName: (s: string) => `${s} target` };
    expect(describeAction({ queue: 'sales', sla: 'quote', priority: 4 }, lookups)).toBe('send to SALES · reply target: quote target · priority: High');
    expect(describeAction({ mark_done: true, redact: true }, lookups)).toBe('mark done (no queue) · hide the message text');
  });

  it('formats minutes', () => {
    expect(formatMinutes(5)).toBe('5 min');
    expect(formatMinutes(90)).toBe('1 h 30 min');
    expect(formatMinutes(720)).toBe('12 h');
    expect(formatMinutes(1500)).toBe('1 day 1 h');
  });
});

describe('rule problems', () => {
  const r = (name: string, conditions: Record<string, unknown>, action: Record<string, unknown> = { queue: 'ops' }, enabled = true) => ({ name, conditions, action, enabled });
  it('flags rules that can never run, missing destinations and names', () => {
    const p = ruleProblems([r('All', {}), r('Sales', { subject_contains: ['quote'] }), r('', { channel: ['sms'] }, {})]);
    expect(p.get(0)).toBeUndefined();
    expect(p.get(1)?.[0]).toMatch(/Never runs: rule #1/);
    expect(p.get(2)).toContain('Give this rule a name.');
    expect(p.get(2)).toContain('Pick a queue to send these to, or mark them done.');
  });
  it('ignores turned-off rules and spots duplicates', () => {
    const p = ruleProblems([r('All', {}, { queue: 'x' }, false), r('A', { channel: ['sms'] }), r('a', { channel: ['sms'] })]);
    expect(p.get(1)).toBeUndefined();
    expect(p.get(2)).toEqual(['Another rule (#2) has the same name.', 'Never runs: rule #2 “A” above it has the same conditions.']);
  });
  it('notices whole-channel rules above that take the message first', () => {
    const p = ruleProblems([r('All email', { channel: ['email'] }), r('Refunds', { subject_contains: ['refund'] }), r('Email quotes', { channel: ['email'], subject_contains: ['quote'] }), r('Texts', { channel: ['sms'] })]);
    expect(p.get(1)?.[0]).toMatch(/takes every email first, so this rule only applies to other channels/);
    expect(p.get(2)?.[0]).toMatch(/^Never runs: rule #1 “All email” above it already takes every email/);
    expect(p.get(3)).toBeUndefined();
  });
  it('puts new rules above the broad rules at the bottom', () => {
    expect(newRuleIndex([r('A', { to: ['x'] }), r('Voice', { channel: ['voice', 'chat'] }), r('Email', { channel: ['email'] })])).toBe(1);
    expect(newRuleIndex([r('A', { to: ['x'] })])).toBe(1);
    expect(newRuleIndex([r('A', { to: ['x'] }), r('Off', {}, {}, false)])).toBe(2);
  });
});
