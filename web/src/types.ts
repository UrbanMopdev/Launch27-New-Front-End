// Launch27 booking, as returned by GET /v1/staff/bookings.
// Field list comes from the check-in tracker's parser (checkin_tracker/parse.py);
// everything is optional because Launch27 omits fields freely.

export interface Named {
  id?: number;
  name?: string;
}

export interface TimeTracking {
  state?: string;
  enroute_started_at?: string;
  enroute_finished_at?: string;
  checkin_at?: string;
  checkout_at?: string;
  distance?: number;
}

export interface CustomField {
  title?: string;
  values?: { label?: string; value?: string }[];
}

export interface Booking {
  id: number;
  service_date?: string;
  arrival_window?: number | string;
  duration?: number;
  blocked_duration?: number;
  phone?: string;
  created_at?: string;
  created_by?: Named;
  location?: Named;
  frequency?: Named;
  address?: { full_address?: string };
  user?: Named & { email?: string; is_new_customer?: boolean; referral_code?: string; is_stripe_card?: boolean };
  teams?: { id?: number; title?: string }[];
  services?: (Named & { price?: number })[];
  summary?: {
    revenue?: number;
    discount?: number;
    tip?: number;
    total?: number;
    tax?: { before_tax?: number; tax_percent?: number; tax_amount?: number; after_tax?: number };
  };
  payment_method_info?: { code?: string; text?: string };
  actions?: Record<string, boolean>;
  time_tracking?: TimeTracking[];
  charges?: { charged?: { description?: string; status?: string; charged_date?: string }[] };
  custom_fields?: CustomField[];
  [key: string]: unknown;
}
