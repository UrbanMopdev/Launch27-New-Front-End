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
}

const digits = (s: string) => s.replace(/\D/g, '');
export const last10 = (s: string) => digits(s).slice(-10);

// Private, blocked or withheld caller ID (M-7).
export function isHidden(phone: string | null | undefined) {
  return !phone || last10(phone).length < 7 || /anonymous|private|restricted|unknown|withheld/i.test(phone);
}

const fullName = (c: Pick<Customer, 'first_name' | 'last_name' | 'company_name' | 'email'>) => [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company_name || c.email || 'Customer';

export function blankCaller(phone: string): Caller {
  return { phone, kind: isHidden(phone) ? 'hidden' : 'unknown', name: null, contactId: null, customerId: null, teamId: null, matches: [], preselect: null, open: [] };
}

// Lookup order (M rules): support contacts already linked, then Launch27 cleaners, then
// Launch27 customers. Matching is on the last 10 digits.
export async function identifyCaller(phone: string, simulated = false): Promise<Caller> {
  const out = blankCaller(phone);
  if (out.kind === 'hidden') return out;
  const who = await inbox.lookup('phone', phone, simulated).catch(() => null);
  const contact = who?.contacts[0] || null;
  out.open = who?.open || [];
  out.contactId = contact?.id ?? null;
  out.name = contact?.name || who?.l27?.name || null;
  const teamId = contact?.l27_team_id || who?.l27?.l27_team_id || null;
  if (teamId) return { ...out, kind: 'cleaner', teamId }; // M-1: a cleaner wins
  if (contact?.l27_customer_id) return { ...out, kind: 'customer', customerId: contact.l27_customer_id }; // M-2
  const want = last10(phone);
  const found = await l27<Customer[]>('/v1/staff/customers', { query: want, limit: 10 }).catch(() => [] as Customer[]);
  const exact = (found || []).filter((c) => last10(c.phone || '') === want);
  if (exact.length === 1) return { ...out, kind: 'customer', customerId: exact[0].id, name: fullName(exact[0]) };
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
