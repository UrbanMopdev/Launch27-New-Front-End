import { useNavigate } from 'react-router-dom';
import { ResourceList } from '../components/ResourceList';
import type { Customer } from '../types';
import { fmtDateTime } from '../format';

export const customerName = (c: Customer) => [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company_name || c.email || `#${c.id}`;

// GET /v1/staff/customers?filter=active (or omitted = all)&query=&limit&offset  (+ /count)
// GET /v1/staff/customers/deleted
export function CustomersPage() {
  const navigate = useNavigate();
  return (
    <ResourceList<Customer>
      title="Customers"
      path="/v1/staff/customers"
      searchParam="query"
      tabs={[
        { label: 'Active', params: { filter: 'active' } },
        { label: 'All' },
        { label: 'Deleted', path: '/v1/staff/customers/deleted', hasCount: false },
      ]}
      onRowClick={(c) => navigate(`/customers/${c.id}`)}
      columns={[
        { header: 'Name', render: (c) => (
          <>
            {customerName(c)}
            {c.is_new_customer && <span className="badge">new</span>}
          </>
        ) },
        { header: 'Email', render: (c) => c.email || '—' },
        { header: 'Phone', render: (c) => c.phone || '—' },
        { header: 'Address', render: (c) => [c.address, c.city].filter(Boolean).join(', ') || '—' },
        { header: 'Tags', render: (c) => c.tags_info?.map((t) => <span key={t.id} className="pill">{t.name}</span>) },
        { header: 'Created', render: (c) => fmtDateTime(c.created_at) },
      ]}
    />
  );
}
