import { NavLink, Outlet } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { auth } from '../api';

// Add a line here for each page rebuilt from docs/api-catalog.json.
const NAV = [
  { to: '/bookings', label: 'Bookings' },
  { to: '/api', label: 'API catalog' },
];

export function Layout({ email }: { email: string }) {
  const queryClient = useQueryClient();
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
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => (isActive ? 'active' : '')}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="muted small">{email}</div>
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
