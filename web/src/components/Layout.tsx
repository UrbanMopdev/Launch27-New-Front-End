import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { auth } from '../api';
import { useCanWrite } from '../hooks';
import { EnvBanner } from './EnvBanner';
import { Icon } from './Icon';
import { SupportStatus } from '../inbox/SupportStatus';
import { CommandBar } from '../inbox/CommandBar';
import { RingCentralPhone } from '../inbox/RingCentralPhone';
import { useCounts } from '../inbox/util';

// Sidebar sections. Add a line here for each page rebuilt from docs/API.md.
// `icon` is a name from components/Icon.tsx.
const NAV: { section: string; items: { to: string; label: string; icon: string }[] }[] = [
  {
    section: 'Support',
    items: [
      { to: '/inbox', label: 'Inbox', icon: 'inbox' },
      { to: '/supervisor', label: 'Supervisor', icon: 'headset' },
      { to: '/inbox-simulator', label: 'Channel simulator', icon: 'flask' },
      { to: '/inbox-settings', label: 'Support settings', icon: 'sliders' },
    ],
  },
  {
    section: 'Operations',
    items: [
      { to: '/dispatch', label: 'Dispatch board', icon: 'truck' },
      { to: '/routes', label: 'Routes & travel', icon: 'route' },
      { to: '/bookings', label: 'Bookings', icon: 'calendar' },
      { to: '/time-tracking', label: 'Time tracking', icon: 'clock' },
      { to: '/quotes', label: 'Quotes', icon: 'file' },
      { to: '/customers', label: 'Customers', icon: 'user' },
      { to: '/teams', label: 'Teams', icon: 'users' },
    ],
  },
  {
    section: 'Money',
    items: [
      { to: '/profitability', label: 'Job profitability', icon: 'trend' },
      { to: '/charges', label: 'Charge customers', icon: 'card' },
      { to: '/team-payments', label: 'Team payments', icon: 'wallet' },
    ],
  },
  {
    section: 'Reports',
    items: [{ to: '/feedback', label: 'Customer feedback', icon: 'star' }],
  },
  { section: 'Developer', items: [{ to: '/api', label: 'API catalog', icon: 'code' }] },
];

// Sidebar preferences are per-browser conveniences; storage can be missing or throw.
function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`sidebar:${key}`);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function savePref(key: string, value: unknown) {
  try {
    localStorage.setItem(`sidebar:${key}`, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

function initials(email: string) {
  const parts = email.split('@')[0].split(/[._-]+/).filter(Boolean);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || parts[0]?.[1] || '')).toUpperCase() || '?';
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function Layout({ email }: { email: string }) {
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();
  // Phones: the sidebar becomes a slide-out drawer behind a top bar.
  const [menuOpen, setMenuOpen] = useState(false);
  // Desktop: the sidebar can shrink to an icon rail.
  const [rail, setRail] = useState(() => loadPref('rail', false));
  const [closed, setClosed] = useState<Record<string, boolean>>(() => loadPref('closed', { Developer: true }));
  const location = useLocation();
  useEffect(() => setMenuOpen(false), [location.pathname]);
  const current = NAV.flatMap((g) => g.items).filter((i) => location.pathname === i.to || location.pathname.startsWith(`${i.to}/`)).sort((a, b) => b.to.length - a.to.length)[0];
  const counts = useCounts();
  const wide = location.pathname.startsWith('/inbox/') || location.pathname === '/inbox';

  const toggleRail = () => {
    setRail(!rail);
    savePref('rail', !rail);
  };
  const toggleSection = (section: string) => {
    const next = { ...closed, [section]: !closed[section] };
    setClosed(next);
    savePref('closed', next);
  };
  const search = () => window.dispatchEvent(new Event('workspace:search'));

  const logout = async () => {
    await auth.logout();
    queryClient.clear();
    queryClient.setQueryData(['me'], null);
  };

  return (
    <div className={rail ? 'shell nav-collapsed' : 'shell'}>
      <EnvBanner />
      <header className="topbar">
        <button className="icon-button" aria-label="Open menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>
          <Icon name="menu" size={22} />
        </button>
        <div className="topbar-title">{current?.label || 'UrbanMop Ops'}</div>
        <button className="icon-button" aria-label="Search" onClick={search}>
          <Icon name="search" size={20} />
        </button>
      </header>
      {menuOpen && <div className="drawer-backdrop" onClick={() => setMenuOpen(false)} />}
      <aside className={menuOpen ? 'sidebar open' : 'sidebar'} aria-label="Main menu">
        <div className="sidebar-head">
          <div className="brand-mark" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M11 3l1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9z" />
              <path d="M18.5 14l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" />
            </svg>
          </div>
          <div className="brand-text">
            <div className="brand-name">UrbanMop</div>
            <div className="brand-sub">Operations</div>
          </div>
          <button className="icon-button rail-toggle" aria-label={rail ? 'Expand sidebar' : 'Collapse sidebar'} title={rail ? 'Expand sidebar' : 'Collapse sidebar'} onClick={toggleRail}>
            <Icon name={rail ? 'panel-open' : 'panel-close'} size={18} />
          </button>
          <button className="icon-button drawer-close" aria-label="Close menu" onClick={() => setMenuOpen(false)}>
            <Icon name="close" size={20} />
          </button>
        </div>

        <div className="sidebar-search">
          <button className="search-button" onClick={search} title={rail ? 'Search' : undefined} aria-label="Search">
            <Icon name="search" size={16} />
            <span className="label">Search</span>
            <kbd>{isMac ? '⌘K' : 'Ctrl K'}</kbd>
          </button>
        </div>

        <nav>
          {NAV.map((group) => {
            // Rail: every item shows. Expanded: closed sections hide their items, except the current page.
            const open = rail || !closed[group.section];
            const items = open ? group.items : group.items.filter((i) => i === current);
            return (
              <div key={group.section} className="nav-group">
                <button className="nav-section" aria-expanded={open} onClick={() => toggleSection(group.section)}>
                  <span>{group.section}</span>
                  <Icon name="chevron" size={14} className={open ? 'chev open' : 'chev'} />
                </button>
                {items.map((item) => (
                  <NavLink key={item.to} to={item.to} className="nav-item" title={rail ? item.label : undefined}>
                    <Icon name={item.icon} size={18} />
                    <span className="label">{item.label}</span>
                    {item.to === '/inbox' && !!counts.data?.mine && <span className="nav-badge">{counts.data.mine}</span>}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <SupportStatus />
          <div className="user-row">
            <div className="avatar" aria-hidden="true">
              {initials(email)}
            </div>
            <div className="user-text">
              <div className="user-line">
                <span className="user-email" title={email}>
                  {email}
                </span>
              </div>
              <div className="user-mode">{canWrite ? <span className="mode-chip on">Editing on</span> : <span className="mode-chip">Read-only</span>}</div>
            </div>
            <button className="icon-button" aria-label="Log out" title="Log out" onClick={logout}>
              <Icon name="logout" size={18} />
            </button>
          </div>
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
