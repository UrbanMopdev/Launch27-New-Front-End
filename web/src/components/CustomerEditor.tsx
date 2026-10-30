import { FormEvent, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { l27Write } from '../api';
import type { Customer } from '../types';

const FIELDS: [keyof Customer, string, string?][] = [
  ['first_name', 'First name'],
  ['last_name', 'Last name'],
  ['company_name', 'Company'],
  ['email', 'Email', 'email'],
  ['phone', 'Phone'],
  ['address', 'Street'],
  ['city', 'City'],
  ['state', 'Province'],
  ['zip', 'Postal code'],
];

// PUT /v1/staff/customers/:id with the full profile.
export function CustomerEditor({ customer, onDone }: { customer: Customer; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<Record<string, string>>(() =>
    Object.fromEntries([...FIELDS.map(([k]) => [k, (customer[k] as string) || '']), ['notes', customer.notes || '']]),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v.trim() || null]));
      await l27Write('PUT', `/v1/staff/customers/${customer.id}`, body);
      await queryClient.invalidateQueries({ queryKey: ['customer', String(customer.id)] });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={submit}>
      <h2>Edit customer</h2>
      <div className="field-grid">
        {FIELDS.map(([key, label, type]) => (
          <label key={key}>
            {label}
            <input type={type || 'text'} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
          </label>
        ))}
        <label className="span-2">
          Notes
          <textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </label>
      </div>
      {error && <div className="error pre">{error}</div>}
      <div className="actions end">
        <button type="button" className="secondary" onClick={onDone} disabled={busy}>
          Cancel
        </button>
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
