import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { auth } from './api';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/Login';
import { BookingsPage } from './pages/Bookings';
import { BookingDetailPage } from './pages/BookingDetail';
import { BookingFormPage } from './pages/BookingForm';
import { DashboardPage } from './pages/Dashboard';
import { CustomersPage } from './pages/Customers';
import { CustomerDetailPage } from './pages/CustomerDetail';
import { TeamsPage } from './pages/Teams';
import { ChargesPage } from './pages/Charges';
import { TimeTrackingPage } from './pages/TimeTracking';
import { FeedbackPage } from './pages/Feedback';
import {
  QuotesPage,
  DeclinedChargesPage,
  TeamPaymentsPage,
  HourlyWagesPage,
  StaffPage,
  ServicesPage,
  ExtrasPage,
  FrequenciesPage,
  PricingParametersPage,
  DiscountsPage,
  GiftCardsPage,
  TagsPage,
  TasksPage,
  SalesTaxesPage,
  ClosedDatesPage,
  BouncesPage,
} from './pages/Lists';
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
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="bookings" element={<BookingsPage />} />
        <Route path="bookings/new" element={<BookingFormPage />} />
        <Route path="bookings/:id" element={<BookingDetailPage />} />
        <Route path="bookings/:id/edit" element={<BookingFormPage />} />
        <Route path="customers" element={<CustomersPage />} />
        <Route path="customers/:id" element={<CustomerDetailPage />} />
        <Route path="teams" element={<TeamsPage />} />
        <Route path="time-tracking" element={<TimeTrackingPage />} />
        <Route path="quotes" element={<QuotesPage />} />
        <Route path="charges" element={<ChargesPage />} />
        <Route path="declined-charges" element={<DeclinedChargesPage />} />
        <Route path="team-payments" element={<TeamPaymentsPage />} />
        <Route path="hourly-wages" element={<HourlyWagesPage />} />
        <Route path="feedback" element={<FeedbackPage />} />
        <Route path="staff" element={<StaffPage />} />
        <Route path="services" element={<ServicesPage />} />
        <Route path="extras" element={<ExtrasPage />} />
        <Route path="frequencies" element={<FrequenciesPage />} />
        <Route path="pricing-parameters" element={<PricingParametersPage />} />
        <Route path="discounts" element={<DiscountsPage />} />
        <Route path="gift-cards" element={<GiftCardsPage />} />
        <Route path="tags" element={<TagsPage />} />
        <Route path="tasks" element={<TasksPage />} />
        <Route path="sales-taxes" element={<SalesTaxesPage />} />
        <Route path="closed-dates" element={<ClosedDatesPage />} />
        <Route path="bounces" element={<BouncesPage />} />
        <Route path="api" element={<ApiCatalogPage />} />
        <Route path="*" element={<div className="muted">Page not found.</div>} />
      </Route>
    </Routes>
  );
}
