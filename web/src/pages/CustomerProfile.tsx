import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { l27 } from '../api';
import { useCanWrite } from '../hooks';
import type { Customer } from '../types';
import { CustomerEditor } from '../components/CustomerEditor';
import { Customer360 } from '../inbox/Customer360';
import { inbox } from '../inbox/api';
import { DialButton } from './SupportPages';
import { customerName } from './Customers';

// The one customer page: everything from Launch27 (bookings, money, ratings, home) plus
// conversations, in the Customer 360 layout. Every customer link in the app lands here.
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

  if (customer.error) return <div className="error">{(customer.error as Error).message}</div>;
  const c = customer.data;

  return (
    <>
      <header className="page-header">
        <div>
          <div className="muted small">
            <Link to="/customers">Customers</Link> /
          </div>
          <h1>
            {c ? customerName(c) : 'Loading…'} {c && !c.active && <span className="badge danger">inactive</span>}
          </h1>
        </div>
        <div className="actions">
          {contact.data && (
            <>
              <button type="button" onClick={() => start('sms')}>Text</button>
              <button type="button" className="secondary" onClick={() => start('email')}>Email</button>
              <DialButton contact={contact.data} />
            </>
          )}
          {canWrite && c && !editing && (
            <>
              <button type="button" className="secondary" onClick={() => setEditing(true)}>Edit customer</button>
              <Link to={`/bookings/new?customer=${cid}`} className="button">New booking</Link>
            </>
          )}
        </div>
      </header>
      {error && <div className="error">{error}</div>}
      {editing && c && <CustomerEditor customer={c} onDone={() => setEditing(false)} />}

      {contact.error ? (
        <div className="error">Couldn't load this customer's profile: {(contact.error as Error).message}</div>
      ) : contact.data ? (
        <div className="card flush">
          <Customer360 contact={contact.data} full />
        </div>
      ) : (
        <div className="muted">Loading…</div>
      )}
    </>
  );
}
