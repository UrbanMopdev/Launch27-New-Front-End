import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { l27 } from '../api';
import { useCanWrite } from '../hooks';
import type { Customer } from '../types';
import { CustomerEditor } from '../components/CustomerEditor';
import { Icon } from '../components/Icon';
import { Customer360 } from '../inbox/Customer360';
import { inbox } from '../inbox/api';
import { CallButton } from '../components/CallButton';

// The one customer page: the full Customer 360. Every customer link in the app lands here.
export function CustomerProfilePage() {
  const { id } = useParams();
  const cid = Number(id);
  const navigate = useNavigate();
  const canWrite = useCanWrite();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const customer = useQuery({ queryKey: ['customer', String(cid)], queryFn: () => l27<Customer>(`/v1/staff/customers/${cid}`), staleTime: 15 * 60_000 });
  // The support contact for this customer (created on first visit, linked by phone/email
  // if they've already written in). It carries their conversations and channel identities.
  const contact = useQuery({ queryKey: ['inbox', 'contact-for-customer', cid], queryFn: async () => inbox.contact((await inbox.fromL27({ customer_id: cid })).id), staleTime: 60_000 });

  const start = async (channel: 'sms' | 'email') => {
    if (!contact.data) return;
    setError(null);
    try {
      const conv = await inbox.start({ contact_id: contact.data.id, channel });
      navigate(`/inbox/${conv.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const phone = contact.data?.identities.find((i) => i.kind === 'phone' && !i.opted_out)?.value;

  if (customer.error) return <div className="error">{(customer.error as Error).message}</div>;
  const c = customer.data;

  const actions = (
    <>
      <button type="button" onClick={() => start('sms')} disabled={!contact.data}>
        <Icon name="sms" /> Text
      </button>
      <button type="button" className="secondary" onClick={() => start('email')} disabled={!contact.data}>
        <Icon name="email" /> Email
      </button>
      <CallButton phone={phone || c?.phone} />
      {canWrite && (
        <Link to={`/bookings/new?customer=${cid}`} className="button secondary-link">
          New booking
        </Link>
      )}
      {canWrite && c && !editing && (
        <button type="button" className="secondary" onClick={() => setEditing(true)}>
          Edit customer
        </button>
      )}
    </>
  );

  return (
    <>
      <div className="crumbs small">
        <Link to="/customers">Customers</Link> / {c ? [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company_name : '…'}
      </div>
      {error && <div className="error">{error}</div>}
      {editing && c && <CustomerEditor customer={c} onDone={() => setEditing(false)} />}
      {contact.error ? (
        <div className="error">Couldn't load this customer's profile: {(contact.error as Error).message}</div>
      ) : contact.data ? (
        <Customer360 contact={contact.data} full actions={actions} />
      ) : (
        <div className="muted">Loading…</div>
      )}
    </>
  );
}
