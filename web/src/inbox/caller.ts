// Incoming calls: who is calling (requirements M-1 to M-7) and which page opens when the
// agent answers (A-1 to A-8). Approved Nov 10, 2026 ("Incoming calls: desired behavior").
import { l27 } from '../api';
import type { Customer } from '../types';
import { inbox } from './api';

export type CallerKind = 'cleaner' | 'customer' | 'several' | 'contact' | 'unknown' | 'hidden';

export interface CallerMatch {
  customerId: number;
  name: string;
  address: string | null;
}

export interface Caller {
  phone: string;
  kind: CallerKind;
  name: string | null;
  contactId: number | null;
  customerId: number | null;
  teamId: number | null;
  matches: CallerMatch[]; // several customers share the number (M-4)
  preselect: number | null; // the customer last picked for this number (D-3)
  open: { id: number; subject: string | null; channel: string }[];
  flag: 'spam' | 'wrong_number' | null; // marked on an earlier call (U-4)
  lead: boolean; // a lead saved in the portal, not yet a Launch27 customer
  applicant: boolean;
  linked: boolean; // this lookup just linked the contact to its Launch27 customer
}

const digits = (s: string) => s.replace(/\D/g, '');
export const last10 = (s: string) => digits(s).slice(-10);

// Private, blocked or withheld caller ID (M-7).
export function isHidden(phone: string | null | undefined) {
  return !phone || last10(phone).length < 7 || /anonymous|private|restricted|unknown|withheld/i.test(phone);
}

const fullName = (c: Pick<Customer, 'first_name' | 'last_name' | 'company_name' | 'email'>) => [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company_name || c.email || 'Customer';

export function blankCaller(phone: string): Caller {
  return { phone, kind: isHidden(phone) ? 'hidden' : 'unknown', name: null, contactId: null, customerId: null, teamId: null, matches: [], preselect: null, open: [], flag: null, lead: false, applicant: false, linked: false };
}

// Lookup order (M rules): support contacts already linked, then Launch27 cleaners, then
// Launch27 customers. Matching is on the last 10 digits.
// canSave: a portal contact that isn't linked yet (a lead, a number nobody named) is linked to
// its Launch27 customer as soon as exactly one customer has this number, e.g. once they book.
export async function identifyCaller(phone: string, simulated = false, canSave = false): Promise<Caller> {
  const out = blankCaller(phone);
  if (out.kind === 'hidden') return out;
  const who = await inbox.lookup('phone', phone, simulated).catch(() => null);
  const all = who?.contacts || [];
  // A contact already linked to Launch27 speaks for the number; then any other.
  const contact = all.find((c) => c.l27_team_id) || all.find((c) => c.l27_customer_id) || all[0] || null;
  // Portal-only contacts on this number (a lead, a number nobody named) that should be linked
  // to the customer once we know who it is. Spam and wrong numbers are left alone.
  const linkOthers = async (customerId: number) => {
    if (!canSave) return false;
    const loose = all.filter((c) => !c.l27_customer_id && !c.l27_team_id && !c.caller_flag && !c.roles.includes('applicant'));
    const done = await Promise.all(loose.map((c) => linkToCustomer(c, customerId)));
    return done.some(Boolean);
  };
  out.open = who?.open || [];
  out.contactId = contact?.id ?? null;
  out.name = contact?.name || who?.l27?.name || null;
  out.flag = contact?.caller_flag || null;
  out.applicant = !!contact?.roles.includes('applicant');
  out.lead = !!contact?.lead_stage && !contact.l27_customer_id && !out.applicant;
  if (out.flag) return { ...out, kind: 'contact' }; // spam or a wrong number: no need to look further
  const teamId = contact?.l27_team_id || who?.l27?.l27_team_id || null;
  if (teamId) return { ...out, kind: 'cleaner', teamId }; // M-1: a cleaner wins
  if (contact?.l27_customer_id) {
    const linked = await linkOthers(Number(contact.l27_customer_id));
    return { ...out, kind: 'customer', customerId: contact.l27_customer_id, lead: false, linked }; // M-2
  }
  const want = last10(phone);
  const found = await l27<Customer[]>('/v1/staff/customers', { query: want, limit: 10 }).catch(() => [] as Customer[]);
  const exact = (found || []).filter((c) => last10(c.phone || '') === want);
  if (exact.length === 1) {
    const linked = await linkOthers(exact[0].id);
    return { ...out, kind: 'customer', customerId: exact[0].id, name: fullName(exact[0]), lead: false, linked };
  }
  if (exact.length > 1) {
    const choice = await inbox.callerChoice(phone).catch(() => null);
    const matches = exact.map((c) => ({ customerId: c.id, name: fullName(c), address: [c.address, c.city].filter(Boolean).join(', ') || null }));
    const pre = matches.some((m) => m.customerId === choice?.l27_customer_id) ? choice!.l27_customer_id : null;
    return { ...out, kind: 'several', matches, preselect: pre, name: `${matches.length} customers share this number` };
  }
  if (who?.l27?.l27_customer_id) return { ...out, kind: 'customer', customerId: who.l27.l27_customer_id };
  if (contact) return { ...out, kind: 'contact' }; // M-5: known, not a client
  return out; // M-6: unknown
}

// Link a portal contact to its Launch27 customer. A lead that is still open becomes "Booked".
const OPEN_LEAD = /^(new|attempt|contacted)/i;
export async function linkToCustomer(contact: { id: number; roles: string[]; lead_stage: string | null }, customerId: number): Promise<boolean> {
  const roles = [...new Set([...contact.roles, 'customer'])] as ('customer' | 'cleaner' | 'applicant' | 'system')[];
  const patch = { l27_customer_id: customerId, roles, ...(contact.lead_stage && OPEN_LEAD.test(contact.lead_stage) ? { lead_stage: 'Booked' } : {}) };
  return inbox.updateContact(contact.id, patch).then(() => true, () => false);
}

// The label on the call card.
export function badgeFor(c: Caller): string {
  if (c.flag === 'spam') return 'Likely spam';
  if (c.flag === 'wrong_number') return 'Wrong number before';
  if (c.kind === 'contact' && c.lead) return 'Lead';
  if (c.kind === 'contact' && c.applicant) return 'Job applicant';
  return CALLER_BADGE[c.kind];
}

export const rememberChoice = (phone: string, customerId: number) => inbox.rememberCallerChoice(phone, customerId).catch(() => null);

// The page that opens when the agent answers (A-1 to A-5). Several matches, unknown and
// hidden callers have no page yet: the card asks (several) or stays up (unknown, hidden).
export function pageFor(c: Caller): string | null {
  if (c.kind === 'customer' && c.customerId) return `/customers/${c.customerId}`;
  if (c.kind === 'cleaner' && c.teamId) return `/cleaners/${c.teamId}`;
  if (c.kind === 'contact' && c.contactId) return `/contacts/${c.contactId}`;
  return null;
}

// A-8: the agent is mid-way through typing something (a reply, a note, a booking form).
export function hasUnsavedWork(doc: Document = document): boolean {
  if (doc.querySelector('[data-unsaved="true"]')) return true;
  // Text areas anywhere (replies, notes); text fields only inside a form (not search or filter boxes).
  return [...doc.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>('textarea, form input[type="text"], form input:not([type])')].some(
    (el) => !el.readOnly && !el.disabled && el.value.trim().length > 0 && el.value !== el.defaultValue && !el.closest('[data-ignore-unsaved]'),
  );
}

export const CALLER_BADGE: Record<CallerKind, string> = {
  cleaner: 'Cleaner',
  customer: 'Customer',
  several: 'Several customers',
  contact: 'Known contact',
  unknown: 'Unknown caller',
  hidden: 'Hidden number',
};
