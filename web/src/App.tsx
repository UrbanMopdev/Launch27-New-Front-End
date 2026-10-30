import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { auth } from './api';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/Login';
import { BookingsPage } from './pages/Bookings';
import { ApiCatalogPage } from './pages/ApiCatalog';

export function App() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: auth.me, retry: false });

  // Any 401 from Launch27 means the session is gone: show the login screen.
  useEffect(() => {
    const onLoggedOut = () => queryClient.setQueryData(['me'], null);
    window.addEventListener('l27:logged-out', onLoggedOut);
    return () => window.removeEventListener('l27:logged-out', onLoggedOut);
  }, [queryClient]);

  if (me.isLoading) return <div className="center muted">Loading…</div>;
  if (!me.data) return <LoginPage onLoggedIn={() => me.refetch()} />;

  return (
    <Routes>
      <Route element={<Layout email={me.data.email} />}>
        <Route index element={<Navigate to="/bookings" replace />} />
        <Route path="bookings" element={<BookingsPage />} />
        <Route path="api" element={<ApiCatalogPage />} />
        <Route path="*" element={<div className="muted">Page not found.</div>} />
      </Route>
    </Routes>
  );
}
