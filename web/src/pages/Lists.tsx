// Launch27 admin list pages that are a straight table over one endpoint.
// Each comment names the Launch27 page it replaces and the calls it makes
// (see docs/API.md for full request/response shapes).
import { useNavigate } from 'react-router-dom';
import { ResourceList } from '../components/ResourceList';
import { fmtDateTime, fmtMoney, TIMEZONE } from '../format';

type Row = Record<string, any> & { id?: number };

const yesNo = (v?: boolean) => (v ? 'Yes' : '—');
const names = (list?: { id: number; name: string }[]) => list?.map((x) => <span key={x.id} className="pill">{x.name}</span>);
const person = (p?: Row) => p?.name || [p?.first_name, p?.last_name].filter(Boolean).join(' ') || '—';
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString('en-CA', { timeZone: TIMEZONE });
};
const weekStart = () => daysAgo(new Date().getDay());

// A quote is "Booked" once it has produced a booking, "Expired" past its expires_at
// with no booking yet, otherwise still "Open" for the office to act on.
export function quoteStatus(expiresAt?: string, bookingIds?: number[] | null): { label: string; cls: string } {
  if (bookingIds?.length) return { label: 'Booked', cls: 'chip ok' };
  if (expiresAt && new Date(expiresAt).getTime() < Date.now()) return { label: 'Expired', cls: 'chip neg' };
  return { label: 'Open', cls: 'chip accent' };
}

// /admin/quotes: GET /v1/staff/quotes?from&to (+ /count)
export function QuotesPage() {
  const navigate = useNavigate();
  return (
    <ResourceList<Row>
      title="Quote inquiries"
      path="/v1/staff/quotes"
      dates="range"
      defaultFrom={daysAgo(30)}
      onRowClick={(q) => navigate(`/quotes/${q.id}`, { state: { quote: q } })}
      columns={[
        { header: 'Name', render: (q) => person(q) },
        { header: 'Email', render: (q) => q.email || '—' },
        { header: 'Phone', render: (q) => q.phone || '—' },
        { header: 'Quoted', render: (q) => fmtMoney(q.booking_draft?.final_price) },
        { header: 'Status', render: (q) => <span className={quoteStatus(q.expires_at, q.booking_ids).cls}>{quoteStatus(q.expires_at, q.booking_ids).label}</span> },
        { header: 'Created', render: (q) => `${fmtDateTime(q.created_at)}${q.created_by ? ` by ${person(q.created_by)}` : ''}` },
        { header: 'Expires', render: (q) => fmtDateTime(q.expires_at) },
      ]}
    />
  );
}

// /admin/reports/charges: GET /v1/staff/reports/declined_charges (+ /count)
export function DeclinedChargesPage() {
  const navigate = useNavigate();
  return (
    <ResourceList<Row>
      title="Declined charges"
      path="/v1/staff/reports/declined_charges"
      onRowClick={(b) => navigate(`/bookings/${b.id}`)}
      columns={[
        { header: 'Date', render: (b) => fmtDateTime(b.service_date) },
        { header: 'Customer', render: (b) => person(b.user) },
        { header: 'Phone', render: (b) => b.phone || '—' },
        { header: 'Card', render: (b) => b.payment_method_info?.text || '—' },
        { header: 'Total', render: (b) => fmtMoney(b.summary?.total), className: 'num' },
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

// /admin/reports/hourly_wages: GET /v1/staff/reports/hourly_wages?date
export function HourlyWagesPage() {
  return (
    <ResourceList<Row>
      title="Hourly wages"
      path="/v1/staff/reports/hourly_wages"
      dates="day"
      hasCount={false}
      columns={[
        { header: 'Team', render: (r) => r.title || r.name },
        { header: 'Date', render: (r) => String(r.date).slice(0, 10) },
        { header: 'Rate', render: (r) => fmtMoney(r.rate), className: 'num' },
        { header: 'Hours', render: (r) => r.hours, className: 'num' },
        { header: 'Total', render: (r) => fmtMoney(r.total), className: 'num' },
      ]}
    />
  );
}

// /admin/staff: GET /v1/staff/staff?filter=active (+ /count), /v1/staff/staff/deleted
export function StaffPage() {
  return (
    <ResourceList<Row>
      title="Office staff"
      path="/v1/staff/staff"
      searchParam="query"
      tabs={[{ label: 'Active', params: { filter: 'active' } }, { label: 'All' }, { label: 'Deleted', path: '/v1/staff/staff/deleted', hasCount: false }]}
      columns={[
        { header: 'Name', render: (s) => person(s) },
        { header: 'Role', render: (s) => s.role },
        { header: 'Email', render: (s) => s.email },
        { header: 'Phone', render: (s) => s.phone || '—' },
        { header: '2FA', render: (s) => yesNo(s.has_twofactor) },
      ]}
    />
  );
}

// /admin/services: GET /v1/staff/services?filter=active&query (+ /count)
export function ServicesPage() {
  return (
    <ResourceList<Row>
      title="Services"
      path="/v1/staff/services"
      searchParam="query"
      tabs={[{ label: 'Active', params: { filter: 'active' } }, { label: 'All' }]}
      columns={[
        { header: 'Name', render: (s) => s.name },
        { header: 'Price', render: (s) => fmtMoney(s.price), className: 'num' },
        { header: 'Duration', render: (s) => (s.duration ? `${s.duration} min` : '—'), className: 'num' },
        { header: 'Commercial', render: (s) => yesNo(s.commercial) },
        { header: 'Locations', render: (s) => names(s.locations) },
        { header: 'Categories', render: (s) => names(s.tags_info) },
      ]}
    />
  );
}

// /admin/extras: GET /v1/staff/extras?filter=active&query (+ /count)
export function ExtrasPage() {
  return (
    <ResourceList<Row>
      title="Extras"
      path="/v1/staff/extras"
      searchParam="query"
      tabs={[{ label: 'Active', params: { filter: 'active' } }, { label: 'All' }]}
      columns={[
        { header: 'Name', render: (x) => x.name },
        { header: 'Price', render: (x) => fmtMoney(x.price), className: 'num' },
        { header: 'Duration', render: (x) => (x.duration ? `${x.duration} min` : '—'), className: 'num' },
        { header: 'Per quantity', render: (x) => yesNo(x.quantity_based) },
        { header: 'Recurring', render: (x) => yesNo(x.recurring) },
        { header: 'Services', render: (x) => names(x.services) },
      ]}
    />
  );
}

// /admin/frequencies: GET /v1/staff/frequencies?filter=active (+ /count)
export function FrequenciesPage() {
  return (
    <ResourceList<Row>
      title="Frequencies"
      path="/v1/staff/frequencies"
      searchParam="query"
      tabs={[{ label: 'Active', params: { filter: 'active' } }, { label: 'All' }]}
      columns={[
        { header: 'Name', render: (f) => f.name },
        { header: 'Interval', render: (f) => f.interval },
        { header: 'Discount', render: (f) => (f.percent ? `${f.percent}%` : f.amount ? fmtMoney(f.amount) : '—'), className: 'num' },
        { header: 'Default', render: (f) => yesNo(f.default) },
        { header: 'Locations', render: (f) => names(f.locations) },
      ]}
    />
  );
}

// /admin/pricing_parameters: GET /v1/staff/pricing_parameters?filter=active (+ /count)
export function PricingParametersPage() {
  return (
    <ResourceList<Row>
      title="Pricing parameters"
      path="/v1/staff/pricing_parameters"
      searchParam="query"
      tabs={[{ label: 'Active', params: { filter: 'active' } }, { label: 'All' }]}
      columns={[
        { header: 'Name', render: (p) => p.name },
        { header: 'Type', render: (p) => p.type },
        { header: 'Price', render: (p) => fmtMoney(p.price), className: 'num' },
        { header: 'Qty range', render: (p) => `${p.quantity_minimum ?? 0}–${p.quantity_maximum ?? '∞'}` },
        { header: 'Duration', render: (p) => (p.duration ? `${p.duration} min` : '—'), className: 'num' },
        { header: 'Services', render: (p) => names(p.services) },
      ]}
    />
  );
}

// /admin/discounts: GET /v1/staff/discounts?filter=active&query (+ /count)
export function DiscountsPage() {
  return (
    <ResourceList<Row>
      title="Discount codes"
      path="/v1/staff/discounts"
      searchParam="query"
      tabs={[{ label: 'Active', params: { filter: 'active' } }, { label: 'All' }]}
      columns={[
        { header: 'Code', render: (d) => <code>{d.code}</code> },
        { header: 'Value', render: (d) => (d.percent ? `${d.percent}%` : fmtMoney(d.amount)), className: 'num' },
        { header: 'Uses', render: (d) => d.number_of_uses ?? '∞', className: 'num' },
        { header: 'Valid', render: (d) => [d.start_date, d.end_date || d.expiration_date].filter(Boolean).join(' → ') || 'Always' },
        { header: 'Bookings', render: (d) => d.summary?.bookings?.active ?? 0, className: 'num' },
        { header: 'Stackable', render: (d) => yesNo(d.stackable) },
      ]}
    />
  );
}

// /admin/giftcards/sold: GET /v1/staff/giftcards (+ /count)
export function GiftCardsPage() {
  return (
    <ResourceList<Row>
      title="Gift cards"
      path="/v1/staff/giftcards"
      columns={[
        { header: 'Code', render: (g) => <code>{g.code}</code> },
        { header: 'From', render: (g) => g.sender?.name || '—' },
        { header: 'To', render: (g) => g.recipient?.name || '—' },
        { header: 'Amount', render: (g) => fmtMoney(g.amount), className: 'num' },
        { header: 'Balance', render: (g) => fmtMoney(g.balance), className: 'num' },
        { header: 'Created', render: (g) => fmtDateTime(g.created_at) },
      ]}
    />
  );
}

// /admin/tags + /admin/service_categories: GET /v1/staff/tags?type=regular|service_category (+ /count)
export function TagsPage() {
  return (
    <ResourceList<Row>
      title="Tags"
      path="/v1/staff/tags"
      tabs={[{ label: 'Tags', params: { type: 'regular' } }, { label: 'Service categories', params: { type: 'service_category' } }]}
      columns={[
        { header: 'Name', render: (t) => <span className="pill" style={t.color ? { borderColor: t.color } : undefined}>{t.name}</span> },
        { header: 'Customers', render: (t) => t.customers_count, className: 'num' },
        { header: 'Teams', render: (t) => t.teams_count, className: 'num' },
        { header: 'Services', render: (t) => t.services_count, className: 'num' },
        { header: 'Bookings', render: (t) => t.bookings_count, className: 'num' },
      ]}
    />
  );
}

// /admin/tasks: GET /v1/staff/tasks (+ /count)
export function TasksPage() {
  return (
    <ResourceList<Row>
      title="Automated tasks"
      path="/v1/staff/tasks"
      columns={[
        { header: 'Task', render: (t) => t.name },
        { header: 'Runs', render: (t) => `${t.hours}h ${t.minutes}m ${t.delta ?? ''}` },
        { header: 'Enabled', render: (t) => yesNo(t.enabled) },
        { header: 'Last run', render: (t) => fmtDateTime(t.executed_at) },
        { header: 'Next run', render: (t) => fmtDateTime(t.due_at) },
      ]}
    />
  );
}

// /admin/sales_taxes: GET /v1/staff/sales_taxes (+ /count)
export function SalesTaxesPage() {
  return (
    <ResourceList<Row>
      title="Sales taxes"
      path="/v1/staff/sales_taxes"
      columns={[
        { header: 'Effective', render: (t) => t.effective_date },
        { header: 'Rate', render: (t) => `${t.percent}%`, className: 'num' },
        { header: 'Locations', render: (t) => names(t.locations) },
      ]}
    />
  );
}

// /admin/spots/closed-dates: GET /v1/staff/holidays
export function ClosedDatesPage() {
  return (
    <ResourceList<Row>
      title="Closed dates"
      path="/v1/staff/holidays"
      hasCount={false}
      columns={[
        { header: 'Date', render: (h) => h.date },
        { header: 'Hours', render: (h) => (h.start_time && h.start_time !== h.end_time ? `${h.start_time}–${h.end_time}` : 'All day') },
        { header: 'Description', render: (h) => h.description || '—' },
      ]}
    />
  );
}

// /admin/bounces: GET /v1/staff/bounces (+ /count)
export function BouncesPage() {
  return (
    <ResourceList<Row>
      title="Undeliverable emails"
      path="/v1/staff/bounces"
      columns={[
        { header: 'When', render: (b) => fmtDateTime(b.created_at) },
        { header: 'To', render: (b) => `${b.user_name || ''} <${b.email_recipient}>` },
        { header: 'User type', render: (b) => b.user_type },
        { header: 'Subject', render: (b) => b.email_subject },
        { header: 'Booking', render: (b) => b.booking_id || '—' },
      ]}
    />
  );
}
