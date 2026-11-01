import { lazy, Suspense, useEffect } from 'react';

import { Navigate, Route, Routes } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { auth } from './api';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/Login';
import { BookingsPage } from './pages/Bookings';
import { BookingDetailPage } from './pages/BookingDetail';
import { BookingFormPage } from './pages/BookingForm';
import { CustomersPage } from './pages/Customers';
import { CustomerProfilePage } from './pages/CustomerProfile';
import { TeamsPage } from './pages/Teams';
import { ChargesPage } from './pages/Charges';
import { TimeTrackingPage } from './pages/TimeTracking';
import { FeedbackPage } from './pages/Feedback';
import { DispatchPage } from './pages/Dispatch';
import { MarginsPage } from './pages/Margins';

import { QuotesPage, TeamPaymentsPage } from './pages/Lists';
import { QuoteDetailPage } from './pages/QuoteDetail';
import { ApiCatalogPage } from './pages/ApiCatalog';
import { InboxPage } from './pages/Inbox';
import { ContactPage, InboxSettingsPage, SimulatorPage, SupervisorPage } from './pages/SupportPages';

// The map library is large, so the Routes page loads on demand.
const RoutesPage = lazy(() => import('./pages/Routes').then((m) => ({ default: m.RoutesPage })));

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
        <Route index element={<Navigate to="/inbox" replace />} />
        <Route path="inbox" element={<InboxPage />} />
        <Route path="inbox/:id" element={<InboxPage />} />
        <Route path="contacts/:id" element={<ContactPage />} />
        <Route path="supervisor" element={<SupervisorPage />} />
        <Route path="inbox-simulator" element={<SimulatorPage />} />
        <Route path="inbox-settings" element={<InboxSettingsPage />} />
        <Route path="dispatch" element={<DispatchPage />} />
        <Route
          path="routes"
          element={
            <Suspense fallback={<div className="muted">Loading map…</div>}>
              <RoutesPage />
            </Suspense>
          }
        />
        <Route path="bookings" element={<BookingsPage />} />
        <Route path="bookings/new" element={<BookingFormPage />} />
        <Route path="bookings/:id" element={<BookingDetailPage />} />
        <Route path="bookings/:id/edit" element={<BookingFormPage />} />
        <Route path="customers" element={<CustomersPage />} />
        <Route path="customers/:id" element={<CustomerProfilePage />} />
        <Route path="teams" element={<TeamsPage />} />
        <Route path="time-tracking" element={<TimeTrackingPage />} />
        <Route path="quotes" element={<QuotesPage />} />
        <Route path="quotes/:id" element={<QuoteDetailPage />} />
        <Route path="charges" element={<ChargesPage />} />
        <Route path="profitability" element={<MarginsPage />} />
        <Route path="team-payments" element={<TeamPaymentsPage />} />
        <Route path="feedback" element={<FeedbackPage />} />
        <Route path="api" element={<ApiCatalogPage />} />
        <Route path="*" element={<div className="muted">Page not found.</div>} />
      </Route>
    </Routes>
  );
}
