// Launch27 booking, as returned by GET /v1/staff/bookings.
// Field list comes from the check-in tracker's parser (checkin_tracker/parse.py);
// everything is optional because Launch27 omits fields freely.

export interface Named {
  id?: number;
  name?: string;
}

export interface TimeTracking {
  id?: number;
  team?: { id: number; title: string };
  state?: string;
  enroute_started_at?: string;
  enroute_finished_at?: string;
  checkin_at?: string;
  checkout_at?: string;
  distance?: number;
}

export interface Service {
  id: number;
  name: string;
  price?: number;
  extras?: { id: number; name: string; quantity: number; price: number; total: number }[];
  pricing_parameters?: { id: number; name: string; quantity: number; price: number; total: number }[];
  hourly?: { title?: string; quantity: number; minutes: number };
  discount_by_frequency?: boolean;
  discount_by_code?: boolean;
}

export interface Charge {
  id: number;
  amount?: number;
  description?: string;
  status?: string;
  charged_date?: string;
  payment_method_info?: { code?: string; text?: string };
}

// GET /v1/staff/bookings/:id/comments
export interface BookingComment {
  id: number;
  comment: string;
  author_type?: string;
  created_at?: string;
  team_viewable?: boolean;
  customer_viewable?: boolean;
}

export interface CustomField {
  title?: string;
  values?: { label?: string; value?: string; name?: string; other?: string }[];
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
  address?: { full_address?: string; street?: string; city?: string; state?: string; zip?: string };
  user?: Named & { email?: string; is_new_customer?: boolean; referral_code?: string; is_stripe_card?: boolean };
  teams?: { id?: number; title?: string }[];
  services?: Service[];
  staff_notes?: string | null;
  customer_notes?: string | null;
  price_adjustment_comment?: string | null;
  active?: boolean;
  completed?: boolean;
  digest?: string;
  team_with_key_id?: number | null;
  team_requested_id?: number | null;
  sms_notifications?: boolean;
  summary?: {
    services?: number;
    extras?: number;
    pricing_parameters?: number;
    adjustment?: number;
    next_total?: number;
    revenue?: number;
    discount?: number;
    tip?: number;
    total?: number;
    tax?: { before_tax?: number; tax_percent?: number; tax_amount?: number; after_tax?: number };
  };
  payment_method_info?: { code?: string; text?: string };
  discount_info?: { frequency_amount?: number; discount_amount?: number; discount_code?: string; giftcard_amount?: number };
  actions?: Record<string, boolean>;
  time_tracking?: TimeTracking[];
  charges?: {
    charged?: Charge[];
    onhold?: Charge[];
    refunded?: Charge[];
    marked_paid?: Charge[];
    outstanding?: number;
  };
  custom_fields?: CustomField[];
  [key: string]: unknown;
}

export interface Tag {
  id: number;
  name: string;
  color?: string;
  type?: string;
}

// GET /v1/staff/customers
export interface Customer {
  id: number;
  company_name?: string | null;
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  notes?: string | null;
  referral_code?: string;
  active?: boolean;
  confirmed?: boolean;
  is_new_customer?: boolean;
  created_at?: string;
  tags_info?: Tag[] | null;
  quickbooks_customer_id?: string;
}

// GET /v1/staff/teams
export interface Team {
  id: number;
  title: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  notes?: string;
  rating?: number;
  stars?: number;
  ratings_count?: number;
  fg_color?: string;
  bg_color?: string;
  active?: boolean;
  share?: number;
  tags_info?: Tag[] | null;
  locations?: { id: number; name: string }[];
}
