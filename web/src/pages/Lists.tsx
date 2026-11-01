// Launch27 admin list pages that are a straight table over one endpoint.
// Each comment names the Launch27 page it replaces and the calls it makes
// (see docs/API.md for full request/response shapes).
import { ResourceList } from '../components/ResourceList';
import { fmtDateTime, fmtMoney, TIMEZONE } from '../format';

type Row = Record<string, any> & { id?: number };

const person = (p?: Row) => p?.name || [p?.first_name, p?.last_name].filter(Boolean).join(' ') || '—';
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString('en-CA', { timeZone: TIMEZONE });
};
const weekStart = () => daysAgo(new Date().getDay());

// /admin/quotes: GET /v1/staff/quotes?from&to (+ /count)
export function QuotesPage() {
  return (
    <ResourceList<Row>
      title="Quote inquiries"
      path="/v1/staff/quotes"
      dates="range"
      defaultFrom={daysAgo(30)}
      columns={[
        { header: 'Name', render: (q) => person(q) },
        { header: 'Email', render: (q) => q.email || '—' },
        { header: 'Phone', render: (q) => q.phone || '—' },
        { header: 'Quoted', render: (q) => fmtMoney(q.booking_draft?.final_price) },
        { header: 'Created', render: (q) => `${fmtDateTime(q.created_at)}${q.created_by ? ` by ${person(q.created_by)}` : ''}` },
        { header: 'Expires', render: (q) => fmtDateTime(q.expires_at) },
        { header: 'Booked', render: (q) => (q.booking_ids?.length ? q.booking_ids.join(', ') : '—') },
      ]}
    />
  );
}

// /admin/payments: GET /v1/staff/teams/payments/summary?filter=active&from&to
export function TeamPaymentsPage() {
  return (
    <ResourceList<Row>
      title="Team payments"
      path="/v1/staff/teams/payments/summary"
      params={{ filter: 'active' }}
      dates="range"
      defaultFrom={weekStart()}
      hasCount={false}
      rowKey={(r) => r.team.id}
      columns={[
        { header: 'Team', render: (r) => r.team.title },
        { header: 'Hours (earned / scheduled)', render: (r) => `${r.hours?.earned ?? '—'} / ${r.hours?.scheduled ?? '—'}` },
        { header: 'Earned', render: (r) => fmtMoney(r.earned), className: 'num' },
        { header: 'Tips', render: (r) => fmtMoney(r.tips), className: 'num' },
        { header: 'Adjustments', render: (r) => fmtMoney(r.adjustments), className: 'num' },
        { header: 'Due', render: (r) => fmtMoney(r.due), className: 'num' },
        { header: 'Paid', render: (r) => fmtMoney(r.paid), className: 'num' },
      ]}
    />
  );
}
