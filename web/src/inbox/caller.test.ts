import { describe, expect, it } from 'vitest';
import { blankCaller, hasUnsavedWork, isHidden, last10, pageFor, type Caller } from './caller';

const caller = (over: Partial<Caller>): Caller => ({ ...blankCaller('+16135551234'), ...over });

describe('incoming calls: who is calling', () => {
  it('matches on the last 10 digits', () => {
    expect(last10('+1 (613) 555-1234')).toBe('6135551234');
    expect(last10('613.555.1234')).toBe('6135551234');
  });
  it('treats private and blocked numbers as hidden (M-7)', () => {
    expect(isHidden('Anonymous')).toBe(true);
    expect(isHidden('')).toBe(true);
    expect(isHidden(null)).toBe(true);
    expect(isHidden('+16135551234')).toBe(false);
    expect(blankCaller('Restricted').kind).toBe('hidden');
    expect(blankCaller('+16135551234').kind).toBe('unknown');
  });
});

describe('incoming calls: the page that opens when answered', () => {
  it('opens the customer, cleaner or contact page (A-1, A-2, A-5)', () => {
    expect(pageFor(caller({ kind: 'customer', customerId: 77 }))).toBe('/customers/77');
    expect(pageFor(caller({ kind: 'cleaner', teamId: 4760 }))).toBe('/cleaners/4760');
    expect(pageFor(caller({ kind: 'contact', contactId: 9 }))).toBe('/contacts/9');
  });
  it('opens nothing by itself for several matches, unknown or hidden callers (A-4, A-6)', () => {
    expect(pageFor(caller({ kind: 'several', matches: [{ customerId: 1, name: 'A', address: null }, { customerId: 2, name: 'B', address: null }] }))).toBeNull();
    expect(pageFor(caller({ kind: 'unknown' }))).toBeNull();
    expect(pageFor(caller({ kind: 'hidden' }))).toBeNull();
  });
});

describe('incoming calls: unsaved work (A-8)', () => {
  const field = (value: string, defaultValue = '', extra: Partial<{ readOnly: boolean; disabled: boolean; ignored: boolean }> = {}) => ({ value, defaultValue, readOnly: !!extra.readOnly, disabled: !!extra.disabled, closest: () => (extra.ignored ? {} : null) });
  const doc = (fields: ReturnType<typeof field>[], flagged = false) => ({ querySelector: () => (flagged ? {} : null), querySelectorAll: () => fields }) as unknown as Document;
  it('spots a half-typed reply or form', () => {
    expect(hasUnsavedWork(doc([field('Hi Jane, your cleaner')]))).toBe(true);
    expect(hasUnsavedWork(doc([], true))).toBe(true);
  });
  it('ignores empty, unchanged, read-only and opted-out fields', () => {
    expect(hasUnsavedWork(doc([field('')]))).toBe(false);
    expect(hasUnsavedWork(doc([field('same', 'same')]))).toBe(false);
    expect(hasUnsavedWork(doc([field('x', '', { readOnly: true })]))).toBe(false);
    expect(hasUnsavedWork(doc([field('x', '', { ignored: true })]))).toBe(false);
  });
});
