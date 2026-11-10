import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { l27 } from '../api';
import type { Customer } from '../types';
import { inbox, type Role } from './api';
import { linkToCustomer, type Caller } from './caller';
import { displayIdentity } from './util';

// "New caller" (requirements U-1 to U-6): an unknown or hidden caller is either an existing
// customer calling from a new number (find them, and the number is added to them so the next
// call matches) or someone new (save them as a contact in a few fields).
// canSave is false for real calls on dev and QA, where nothing about real callers is kept.

const KINDS: { value: string; label: string; roles: Role[]; lead: boolean }[] = [
  // A lead is not a customer until they book: no Customer role until linked to Launch27.
  { value: 'lead', label: 'New lead (wants a quote or booking)', roles: [], lead: true },
  { value: 'applicant', label: 'Job applicant', roles: ['applicant'], lead: false },
  { value: 'other', label: 'Vendor, partner or other', roles: [], lead: false },
];

const nameOf = (c: Customer) => [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company_name || c.email || `Customer #${c.id}`;

export function NewCaller({ caller, canSave, simulated = false, onDone, onClose }: { caller: Caller; canSave: boolean; simulated?: boolean; onDone: (path: string | null) => void; onClose: () => void }) {
  const hidden = caller.kind === 'hidden';
  const [q, setQ] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState(KINDS[0].value);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const term = q.trim();
  const found = useQuery({ queryKey: ['call', 'find', term], queryFn: () => l27<Customer[]>('/v1/staff/customers', { query: term, limit: 8 }), enabled: term.length >= 2, staleTime: 60_000 });

  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    try {
      onDone(await fn());
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  // U-2: an existing customer on a new number. The number is added to them in the portal
  // (Launch27 itself is unchanged while writes are off).
  // A contact the call log already made with just this number (the call ended first).
  const numberOnly = async () => (hidden ? null : (await inbox.lookup('phone', caller.phone, simulated).catch(() => null))?.contacts.find((c) => !c.name && !c.l27_customer_id && !c.l27_team_id && !c.lead_stage) || null);

  const thisIsThem = (c: Customer) =>
    run(async () => {
      if (canSave && !hidden) {
        const bare = await numberOnly();
        if (bare) await linkToCustomer(bare, c.id);
        const contact = await inbox.fromL27({ customer_id: c.id });
        const known = (contact.identities || []).some((i) => i.kind === 'phone' && i.value.replace(/\D/g, '').slice(-10) === caller.phone.replace(/\D/g, '').slice(-10));
        if (!known) await inbox.addIdentity(contact.id, 'phone', caller.phone, 'Called from');
      }
      return `/customers/${c.id}`;
    });

  // U-3 / U-4: someone new.
  const save = () =>
    run(async () => {
      const k = KINDS.find((x) => x.value === kind)!;
      // Fill in the number-only contact if the call log already made one, rather than a second.
      const existing = await numberOnly();
      const contact = existing || (await inbox.createContact({ name: name.trim(), roles: k.roles, ...(hidden ? {} : { phone: caller.phone }) }));
      const patch: Record<string, unknown> = existing ? { name: name.trim(), roles: k.roles } : {};
      if (k.lead) Object.assign(patch, { lead_stage: 'New', lead_source: 'Phone call' });
      if (notes.trim()) patch.notes = notes.trim();
      if (Object.keys(patch).length) await inbox.updateContact(contact.id, patch as Parameters<typeof inbox.updateContact>[1]);
      return `/contacts/${contact.id}`;
    });

  // U-4: a wrong number or spam. The number is kept so the next call from it is labelled.
  const mark = (flag: 'spam' | 'wrong_number') =>
    run(async () => {
      const contact = (await numberOnly()) || (await inbox.createContact({ name: '', roles: [], phone: caller.phone }));
      await inbox.updateContact(contact.id, { caller_flag: flag });
      return null;
    });

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="card modal new-caller" role="dialog" aria-label="New caller" onClick={(e) => e.stopPropagation()} data-ignore-unsaved>
        <h2>New caller</h2>
        <p className="muted small">{hidden ? 'Hidden number: nothing to link, but you can still save who called.' : `${displayIdentity(caller.phone)} isn't in Launch27 or the inbox.`}</p>
        {!canSave && <p className="warn small">Real calls aren't saved on this test site. You can look people up, but nothing is stored here.</p>}

        <h3>Already a customer?</h3>
        <input className="full" placeholder="Search by name, email or address" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        {term.length >= 2 && (
          <div className="new-caller-results">
            {found.isLoading && <div className="muted small">Searching…</div>}
            {found.data && !found.data.length && <div className="muted small">No customers match.</div>}
            {(found.data || []).map((c) => (
              <div key={c.id} className="new-caller-row">
                <div className="grow">
                  <strong>{nameOf(c)}</strong>
                  <div className="muted small">{[c.address, c.city].filter(Boolean).join(', ') || c.email}{c.phone ? ` · ${displayIdentity(c.phone)}` : ''}</div>
                </div>
                <button type="button" className="secondary" disabled={busy} onClick={() => thisIsThem(c)}>
                  {canSave && !hidden ? 'This is them: add number' : 'Open'}
                </button>
              </div>
            ))}
          </div>
        )}

        <h3>Someone new</h3>
        <label>
          Name
          <input className="full" value={name} onChange={(e) => setName(e.target.value)} placeholder="First and last name" />
        </label>
        <label>
          Who are they?
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>{k.label}</option>
            ))}
          </select>
        </label>
        <label>
          Notes
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Address or postal code, what they need, how they heard of us" />
        </label>
        {error && <div className="error">{error}</div>}
        <div className="actions end">
          {!hidden && (
            <>
              <button type="button" className="secondary" disabled={busy || !canSave} onClick={() => mark('wrong_number')} title="Label future calls from this number">Wrong number</button>
              <button type="button" className="secondary" disabled={busy || !canSave} onClick={() => mark('spam')} title="Label future calls from this number as likely spam">Spam</button>
            </>
          )}
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>Not now</button>
          <button type="button" disabled={busy || !canSave || !name.trim()} onClick={save}>Save contact</button>
        </div>
      </div>
    </div>
  );
}
