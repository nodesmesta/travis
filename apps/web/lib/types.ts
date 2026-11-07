export interface Trip {
  id: string;
  user_id: string;
  name: string;
  destination_summary: string | null;
  start_at: string | null;
  end_at: string | null;
  timezone: string;
  status: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface ContextPoint {
  id: string;
  trip_id: string;
  type: string;
  label: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone: string;
  external_place_id: string | null;
  status: "active" | "archived";
  resolution_status: "resolved" | "ambiguous" | "unresolved";
  confirmation_status: "unconfirmed" | "confirmed";
  source: string;
  metadata: Record<string, unknown>;
}

export interface EventItem {
  id: string;
  trip_id: string;
  context_point_id: string;
  title: string;
  description?: string;
  venue_name?: string;
  starts_at?: string;
  ends_at?: string;
  category?: string;
  status: "suggested" | "selected" | "rejected" | "expired";
  source_ids: string[];
}

export interface EventSource {
  id: string;
  kind: string;
  provider: string;
  url?: string;
  title?: string;
  retrieved_at: string;
  freshness: "fresh" | "expired" | "unavailable";
  expires_at?: string;
}

export interface EventDiscoveryResponse {
  request_id: string;
  trip_id: string;
  context_point_id: string;
  items: EventItem[];
  sources: EventSource[];
  retrieved_at: string;
  freshness?: "fresh" | "expired" | "unavailable";
  expires_at?: string;
  limitations?: string[];
}

export interface Booking {
  id: string;
  user_id: string;
  trip_id: string;
  booking_type: "event" | "activity" | "itinerary_item";
  source_type: "event_discovery_result" | "activity" | "agenda_item";
  source_id: string;
  provider_name?: string;
  confirmation_code?: string;
  status: string;
  currency: string;
  subtotal: number;
  tax: number;
  total: number;
  pricing_policy: string;
  starts_at?: string;
  ends_at?: string;
  cancelled_at?: string;
  created_at: string;
  updated_at: string;
}

export interface Payment {
  id: string;
  booking_id: string;
  payment_reference: string;
  provider: "dummy_payment";
  mode: "simulated";
  amount: number;
  currency: string;
  status: "pending" | "succeeded" | "failed" | "cancelled" | "refunded";
  paid_at?: string;
  failed_at?: string;
  failure_code?: string;
  created_at: string;
  updated_at: string;
}

export interface PaymentResult {
  booking: Booking;
  payment: Payment;
  request_id: string;
}

export interface ApiErrorPayload {
  error: {
    code: string;
    category: string;
    message: string;
    request_id?: string;
    details?: Record<string, unknown>;
  };
}

/** Price decided by the server before a booking is created. */
export interface BookingQuote {
  policy_version: string;
  booking_type: "event" | "activity" | "itinerary_item";
  currency: string;
  subtotal: number;
  tax: number;
  total: number;
  request_id: string;
}
