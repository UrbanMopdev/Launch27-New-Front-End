import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { auth } from '../api';
import { useCanWrite } from '../hooks';
import { EnvBanner } from './EnvBanner';
import { SupportStatus } from '../inbox/SupportStatus';
import { CommandBar } from '../inbox/CommandBar';
import { RingCentralPhone } from '../inbox/RingCentralPhone';
import { useCounts } from '../inbox/util';

// Sidebar sections. Add a line here for each page rebuilt from docs/API.md.
const NAV: { section: string; items: { to: string; label: string }[] }[] = [
  {
    section: 'Support',
    items: [
      { to: '/inbox', label: 'Inbox' },
      { to: '/supervisor', label: 'Supervisor' },
      { to: '/inbox-simulator', label: 'Channel simulator' },
      { to: '/inbox-settings', label: 'Support settings' },
    ],
  },
  {
    section: 'Operations',
    items: [
      { to: '/dashboard', label: 'Dashboard' },
      { to: '/dispatch', label: 'Dispatch board' },
      { to: '/routes', label: 'Routes & travel' },
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
      { to: '/profitability', label: 'Job profitability' },
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
  // Phones: the sidebar becomes a slide-out drawer behind a top bar.
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMenuOpen(false), [location.pathname]);
  const current = NAV.flatMap((g) => g.items).filter((i) => location.pathname === i.to || location.pathname.startsWith(`${i.to}/`)).sort((a, b) => b.to.length - a.to.length)[0];
  const counts = useCounts();
  const wide = location.pathname.startsWith('/inbox/') || location.pathname === '/inbox';

  const logout = async () => {
    await auth.logout();
    queryClient.clear();
    queryClient.setQueryData(['me'], null);
  };

  return (
    <div className="shell">
      <EnvBanner />
      <header className="topbar">
        <button className="menu-button" aria-label="Open menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>
          <span />
          <span />
          <span />
        </button>
        <div className="topbar-title">{current?.label || 'UrbanMop Ops'}</div>
      </header>
      {menuOpen && <div className="drawer-backdrop" onClick={() => setMenuOpen(false)} />}
      <aside className={menuOpen ? 'sidebar open' : 'sidebar'}>
        <div className="brand">
          UrbanMop Ops
          <button className="drawer-close" aria-label="Close menu" onClick={() => setMenuOpen(false)}>
            ×
          </button>
        </div>
        <nav>
          {NAV.map((group) => (
            <div key={group.section} className="nav-group">
              <div className="nav-section">{group.section}</div>
              {group.items.map((item) => (
                <NavLink key={item.to} to={item.to} className={({ isActive }) => (isActive ? 'active' : '')}>
                  {item.label}
                  {item.to === '/inbox' && !!counts.data?.mine && <span className="count nav-count">{counts.data.mine}</span>}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <SupportStatus />
          <button className="link small" onClick={() => window.dispatchEvent(new Event('workspace:search'))}>Search (Ctrl+K)</button>
          <div className="muted small">{email}</div>
          <div className="small">{canWrite ? <span className="ok">Editing on</span> : <span className="muted">Read-only</span>}</div>
          <button className="link" onClick={logout}>
            Log out
          </button>
        </div>
      </aside>
      <main className={wide ? 'content wide' : 'content'}>
        <Outlet />
      </main>
      <CommandBar />
      <RingCentralPhone />
    </div>
  );
}
