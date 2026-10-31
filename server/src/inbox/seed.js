import { seedWorkforce } from './workforce.js';
// Starting configuration for UrbanMop, rebuilt from the Kustomer audit (Oct 31, 2026):
// 14 queues and 72 rules there become 9 queues and 15 ordered rules here.
import { json } from '../db/index.js';

export const UM = {
  info: 'info@urbanmop.ca',
  billing: 'billing@urbanmop.ca',
  management: 'management@urbanmop.ca',
  customerSuccess: 'customersuccess@urbanmop.ca',
  noReply: 'no-reply@urbanmop.ca',
  hr: 'hr@urbanmop.ca',
  careers: 'careers@urbanmop.ca',
  hiring: 'hiring@urbanmop.ca',
  payroll: 'payroll@urbanmop.ca',
  smsOttawa: '+16136919880',
  smsHiring: '+16136918368',
};

// Identities agents can send from, per channel.
export const OUR_IDENTITIES = {
  email: [UM.info, UM.billing, UM.customerSuccess, UM.management, UM.hr, UM.careers, UM.hiring, UM.payroll],
  sms: [UM.smsOttawa, UM.smsHiring],
};

export const QUEUES = [
  { slug: 'operations', name: 'Operations', description: 'Customer and cleaner service: bookings, arrivals, changes' },
  { slug: 'sales', name: 'Sales', description: 'Quotes, new inquiries, cart abandonment, lead follow-up' },
  { slug: 'billing', name: 'Billing', description: 'Charges, declined cards, invoices, biller reports' },
  { slug: 'customer-success', name: 'Customer Success', description: 'Ratings, reviews, retention' },
  { slug: 'management', name: 'Management', description: 'Escalations and disputes' },
  { slug: 'hr', name: 'HR', description: 'Staff HR', restricted: true },
  { slug: 'hiring', name: 'Hiring', description: 'Applicants and recruiting', restricted: true },
  { slug: 'payroll', name: 'Payroll', description: 'Payroll inquiries', restricted: true },
  { slug: 'fallback', name: 'Fallback', description: 'Matched no rule. Someone should check this daily.' },
];

export const SLA_POLICIES = [
  { slug: 'voice', name: 'Missed call callback', first_response_minutes: 15 },
  { slug: 'cleaner', name: 'Cleaner messages', first_response_minutes: 5, warn_minutes: 1 },
  { slug: 'chat', name: 'Chat', first_response_minutes: 5, warn_minutes: 1 },
  { slug: 'quote', name: 'Quote lead', first_response_minutes: 10 },
  { slug: 'cart', name: 'Cart abandonment', first_response_minutes: 30, warn_minutes: 5 },
  { slug: 'standard', name: 'Customer messages', first_response_minutes: 240, warn_minutes: 30 },
  { slug: 'hiring', name: 'Hiring and HR', first_response_minutes: 720, warn_minutes: 60 },
];

const SYSTEM_SENDERS = ['notifications@kustomerapp.com', 'notify@ringcentral.com', 'feedback@slack.com', 'team@bark.com', 'noreply@ziprecruiter.com', 'noreply@facebookmail.com', 'news@team.semrush.com', 'localservices-noreply'];

export const RULES = [
  {
    name: 'System notices: mark done',
    conditions: { any: [{ from_contains: SYSTEM_SENDERS }, { to: [UM.noReply] }, { subject_contains: ['New booking request by'], text_excludes: ['Booking inserted into Launch 27?: N'] }] },
    action: { mark_done: true, disposition: { audience: 'system', reason: 'System notice', outcome: 'No action needed' } },
    replaces: 'Auto Close business rules; Auto Close Part 2; NoReply',
  },
  {
    name: 'Bank verification codes: keep out of shared queues',
    conditions: { text_contains: ['RBCPayEdge Authentication Code', 'verification code for RBC', 'donotreply@rbcpayedge.com'] },
    action: { queue: 'payroll', mark_done: true, redact: true, disposition: { audience: 'system', reason: 'Verification code', outcome: 'Redacted' } },
    replaces: 'RCB PayEdge Redirect; Auto assign to Payroll',
  },
  { name: 'Stripe disputes to Management', conditions: { from_contains: ['notifications@stripe.com'], text_contains: ['is being disputed'] }, action: { queue: 'management', priority: 5 }, replaces: 'Dispute from Stripe to management' },
  { name: 'Escalations to Management', conditions: { any: [{ to: [UM.management] }, { text_contains: ['Derek for review', 'Leslie for review'] }] }, action: { queue: 'management', priority: 4 }, replaces: 'Management Queue' },
  { name: 'HR and hiring', conditions: { any: [{ to: [UM.hr, UM.careers, UM.hiring, UM.smsHiring] }, { from_contains: ['pandadoc', 'mybackcheck'] }] }, action: { queue: 'hiring', sla: 'hiring' }, replaces: 'HR email; HR Queue Rule; Route SMS to Hiring Team; Route to Hiring Team' },
  { name: 'Payroll', conditions: { to: [UM.payroll] }, action: { queue: 'payroll', sla: 'hiring' }, replaces: 'Payroll Queue Rule' },
  {
    name: 'Billing',
    conditions: { any: [{ to: [UM.billing] }, { from_contains: ['businessservices@intuit.com'] }, { subject_contains: ['Warning: The credit cards for', 'Biller Report For Biller Code'] }] },
    action: { queue: 'billing', sla: 'standard' },
    replaces: 'Billing & Financial Operations; Financial Operations Rule; Billing Routing; Accounts Receivables',
  },
  { name: 'Cleaners to Operations', conditions: { contact_role: ['cleaner'] }, action: { queue: 'operations', sla: 'cleaner', priority: 4 }, replaces: 'Cleaner business rule; Cleaner SMS SLA' },
  { name: 'Quote and booking requests to Sales', conditions: { channel: ['email'], subject_contains: ['submitted an inquiry', 'New booking request by', 'Quote Lead Form', 'requesting a quote'] }, action: { queue: 'sales', sla: 'quote', priority: 4 }, replaces: 'Sales Queue Rule; Quote Lead' },
  { name: 'Cart abandonment to Sales', conditions: { subject_contains: ['Cart Abandonment'] }, action: { queue: 'sales', sla: 'cart' }, replaces: 'Sales Overflow (Cart Abandonment)' },
  { name: 'Leads in follow-up stay with Sales', conditions: { lead_stage: ['Attempt #1', 'Attempt #2', 'Attempt #3', 'Contacted Highly Interested', 'Contacted Undecided'] }, action: { queue: 'sales', sla: 'standard' }, replaces: 'Keep in Sales Queue' },
  { name: 'Customer success', conditions: { any: [{ to: [UM.customerSuccess] }, { text_contains: ["it was ok", "it wasn't good", 'it wasnt good'] }] }, action: { queue: 'customer-success', sla: 'standard' }, replaces: 'Customer Success rules; Rating email (ok / not good)' },
  { name: 'Voice and chat to Operations', conditions: { channel: ['voice', 'chat'] }, action: { queue: 'operations' }, replaces: 'Operations - Chat Rule; RingCentral Policy' },
  { name: 'Ottawa SMS to Operations', conditions: { channel: ['sms'], to: [UM.smsOttawa] }, action: { queue: 'operations', sla: 'standard' }, replaces: 'Route SMS to Operations Team' },
  { name: 'Other email to Operations', conditions: { channel: ['email'] }, action: { queue: 'operations', sla: 'standard' }, replaces: 'Operations Queue Rule' },
];

// Disposition lists, rebuilt from Kustomer's "Reason for Conversation" tree as three
// separate fields. Channel and direction are captured automatically, so they're gone.
export const DISPOSITIONS = {
  audience: ['Customer', 'Lead', 'Cleaner', 'Applicant', 'Vendor or system'],
  reason: [
    'Booking inquiry',
    'New booking or quote',
    'Reschedule',
    'Change of cleaner',
    'Add instructions or modify booking',
    'Cancellation',
    'Cleaner arrival or late',
    'Complaint or feedback',
    'Billing or payment',
    'Refund request',
    'Rating or Google review',
    'Retention or win-back',
    'Cleaner availability',
    'Cleaner pay',
    'Cleaner last-minute cancellation',
    'Applicant inquiry',
    'Interview or onboarding',
    'Equipment pickup',
    'Spam or wrong number',
    'Telemarketer',
    'System notice',
    'Other',
  ],
  outcome: [
    'Resolved',
    'Booking saved',
    'Quote sent',
    'Rescheduled',
    'Cancelled',
    'Cleaner reassigned',
    'Return clean offered',
    'Credit or refund given',
    'Escalated',
    'Left voicemail',
    'No answer',
    'Awaiting customer',
    'No action needed',
  ],
  cancellationReasons: ['Quality of service', 'Budget', 'Schedule change', 'Moving', 'Illness', 'Not disclosed', 'Other'],
};

export const CANNED = [
  { shortcut: 'late', title: 'Cleaner running late', body: 'Hi {{first_name}}, your cleaner is running a little behind and is now expected at {{eta}}. Sorry for the wait, and thank you for your patience!' },
  { shortcut: 'confirm', title: 'Booking confirmed', body: 'Hi {{first_name}}, you are all set for {{next_booking}}. Reply here if anything changes.' },
  { shortcut: 'resched', title: 'Rescheduled', body: 'Hi {{first_name}}, your cleaning has been moved to {{next_booking}}. Let us know if that time doesn\'t work.' },
  { shortcut: 'review', title: 'Google review ask', body: 'Thank you {{first_name}}! If you have a minute, a Google review helps our team a lot: https://g.page/r/urbanmop/review' },
  { shortcut: 'eta', title: 'Ask cleaner for ETA', body: 'Hi {{first_name}}, could you share your ETA for your next booking? The customer is asking. Thanks!', channels: ['sms'] },
  { shortcut: 'sorry', title: 'Sorry about the clean', body: 'Hi {{first_name}}, I\'m sorry the clean didn\'t meet your expectations. Could you tell me which areas were missed? We\'d like to make it right with a return visit.' },
];

// Ontario statutory holidays. Kustomer had none set.
export const HOLIDAYS = [
  ['2026-12-25', 'Christmas Day'],
  ['2026-12-26', 'Boxing Day'],
  ['2027-01-01', "New Year's Day"],
  ['2027-02-15', 'Family Day'],
  ['2027-03-26', 'Good Friday'],
  ['2027-05-24', 'Victoria Day'],
  ['2027-07-01', 'Canada Day'],
  ['2027-09-06', 'Labour Day'],
  ['2027-10-11', 'Thanksgiving'],
  ['2027-12-25', 'Christmas Day'],
  ['2027-12-27', 'Boxing Day (observed)'],
];

// Idempotent: only fills empty tables, so admin changes are never overwritten.
export async function seed(db) {
  const count = async (table) => Number((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
  if (!(await count('queues'))) {
    for (const [i, q] of QUEUES.entries()) {
      await db.query('INSERT INTO queues (slug, name, description, restricted, position) VALUES ($1,$2,$3,$4,$5)', [q.slug, q.name, q.description, !!q.restricted, i]);
    }
  }
  if (!(await count('sla_policies'))) {
    for (const p of SLA_POLICIES) {
      await db.query('INSERT INTO sla_policies (slug, name, first_response_minutes, warn_minutes) VALUES ($1,$2,$3,$4)', [p.slug, p.name, p.first_response_minutes, p.warn_minutes ?? 2]);
    }
  }
  if (!(await count('routing_rules'))) {
    for (const [i, r] of RULES.entries()) {
      await db.query('INSERT INTO routing_rules (position, name, conditions, action, replaces) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5)', [(i + 1) * 10, r.name, json(r.conditions), json(r.action), r.replaces || null]);
    }
  }
  if (!(await count('canned_responses'))) {
    for (const c of CANNED) {
      await db.query('INSERT INTO canned_responses (shortcut, title, body, channels) VALUES ($1,$2,$3,$4::jsonb)', [c.shortcut, c.title, c.body, json(c.channels || [])]);
    }
  }
  if (!(await count('holidays'))) {
    for (const [day, name] of HOLIDAYS) await db.query('INSERT INTO holidays (day, name) VALUES ($1,$2)', [day, name]);
  }
  await seedWorkforce(db);
}
