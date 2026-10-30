import { NavLink, Outlet } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { auth } from '../api';
import { useCanWrite } from '../hooks';

// Sidebar sections. Add a line here for each page rebuilt from docs/API.md.
const NAV: { section: string; items: { to: string; label: string }[] }[] = [
  {
    section: 'Operations',
    items: [
      { to: '/dashboard', label: 'Dashboard' },
      { to: '/bookings', label: 'Bookings' },
      { to: '/time-tracking', label: 'Time tracking' },
      { to: '/quotes', label: 'Quotes' },
      { to: '/customers', label: 'Customers' },
      { to: '/teams', label: 'Teams' },
    ],
  },
  {
    section: 'Money',
    items: [
      { to: '/charges', label: 'Charge customers' },
      { to: '/declined-charges', label: 'Declined charges' },
      { to: '/team-payments', label: 'Team payments' },
      { to: '/hourly-wages', label: 'Hourly wages' },
      { to: '/discounts', label: 'Discount codes' },
      { to: '/gift-cards', label: 'Gift cards' },
    ],
  },
  {
    section: 'Reports',
    items: [{ to: '/feedback', label: 'Customer feedback' }],
  },
  {
    section: 'Settings',
    items: [
      { to: '/services', label: 'Services' },
      { to: '/extras', label: 'Extras' },
      { to: '/pricing-parameters', label: 'Pricing parameters' },
      { to: '/frequencies', label: 'Frequencies' },
      { to: '/sales-taxes', label: 'Sales taxes' },
      { to: '/closed-dates', label: 'Closed dates' },
      { to: '/tags', label: 'Tags' },
      { to: '/staff', label: 'Office staff' },
      { to: '/tasks', label: 'Automated tasks' },
      { to: '/bounces', label: 'Undeliverable emails' },
    ],
  },
  { section: 'Developer', items: [{ to: '/api', label: 'API catalog' }] },
];

export function Layout({ email }: { email: string }) {
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();
  const logout = async () => {
    await auth.logout();
    queryClient.clear();
    queryClient.setQueryData(['me'], null);
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">UrbanMop Ops</div>
        <nav>
          {NAV.map((group) => (
            <div key={group.section} className="nav-group">
              <div className="nav-section">{group.section}</div>
              {group.items.map((item) => (
                <NavLink key={item.to} to={item.to} className={({ isActive }) => (isActive ? 'active' : '')}>
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="muted small">{email}</div>
          <div className="small">{canWrite ? <span className="ok">Editing on</span> : <span className="muted">Read-only</span>}</div>
          <button className="link" onClick={logout}>
            Log out
          </button>
        </div>
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
