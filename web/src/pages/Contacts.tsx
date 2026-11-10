import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { inbox, type ContactList } from '../inbox/api';
import { ago, displayIdentity } from '../inbox/util';

// People in the portal who are not (yet) a Launch27 customer or cleaner: leads to follow up,
// job applicants, vendors and others, numbers nobody named, and numbers marked spam or wrong.
// A lead who books is linked to their Launch27 customer from their contact page (or
// automatically on their next call) and leaves this list.
const LISTS: { id: ContactList; label: string; empty: string }[] = [
  { id: 'leads', label: 'Leads', empty: 'No open leads. Callers saved as "New lead" show here until they are linked to a Launch27 customer.' },
  { id: 'applicants', label: 'Job applicants', empty: 'No job applicants saved.' },
  { id: 'other', label: 'Vendors and others', empty: 'Nobody here.' },
  { id: 'number_only', label: 'Number only', empty: 'Every number has a name.' },
  { id: 'flagged', label: 'Spam and wrong numbers', empty: 'No numbers marked.' },
];

export function ContactsPage() {
  const [list, setList] = useState<ContactList>('leads');
  const data = useQuery({ queryKey: ['inbox', 'contact-list', list], queryFn: () => inbox.contactList(list), staleTime: 30_000 });
  const current = LISTS.find((l) => l.id === list)!;
  return (
    <>
      <header className="page-header">
        <h1>Contacts</h1>
        <span className="muted small">People who aren't a Launch27 customer or cleaner yet. Link a lead to their customer record from their page once they book.</span>
      </header>
      <div className="tabs">
        {LISTS.map((l) => (
          <button key={l.id} className={l.id === list ? 'tab active' : 'tab'} onClick={() => setList(l.id)}>
            {l.label}
            {data.data?.counts[l.id] ? ` (${data.data.counts[l.id]})` : ''}
          </button>
        ))}
      </div>
      {data.isLoading && <div className="muted">Loading…</div>}
      {data.error && <div className="error">{(data.error as Error).message}</div>}
      {data.data && !data.data.rows.length && <p className="muted">{current.empty}</p>}
      {!!data.data?.rows.length && (
        <div className="card no-pad">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Phone or email</th>
                {list === 'leads' && <th>Stage</th>}
                {list === 'flagged' && <th>Marked as</th>}
                <th>Notes</th>
                <th>Last activity</th>
              </tr>
            </thead>
            <tbody>
              {data.data.rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={`/contacts/${r.id}`}>{r.name || 'Unnamed'}</Link>
                  </td>
                  <td>{r.identities.map((i) => displayIdentity(i.value)).join(', ') || '—'}</td>
                  {list === 'leads' && <td>{r.lead_stage}{r.lead_source ? <span className="muted small"> · {r.lead_source}</span> : null}</td>}
                  {list === 'flagged' && <td>{r.caller_flag === 'spam' ? 'Spam' : 'Wrong number'}</td>}
                  <td className="muted small">{r.notes ? (r.notes.length > 80 ? `${r.notes.slice(0, 80)}…` : r.notes) : ''}</td>
                  <td className="muted small">{ago(r.last_activity || r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
