export type TripStatus = "draft" | "confirmed" | "active" | "completed";
export type BookingStatus =
  | "draft"
  | "pending_payment"
  | "paid"
  | "confirmed"
  | "cancelled"
  | "expired"
  | "failed";
export type PaymentStatus =
  "pending" | "succeeded" | "failed" | "cancelled" | "refunded";
export type Freshness = "fresh" | "expired" | "unavailable";

export type ErrorCategory =
  | "validation"
  | "authentication"
  | "authorization"
  | "not_found"
  | "conflict"
  | "provider"
  | "persistence"
  | "internal";

export interface ErrorEnvelope {
  error: {
    code: string;
    category: ErrorCategory;
    message: string;
    request_id: string;
    execution_id?: string;
    details?: Record<string, unknown>;
  };
}

export interface SourceReference {
  id: string;
  kind:
    "provider" | "official_page" | "search_result" | "user_input" | "internal";
  provider: string;
  url?: string;
  retrieved_at: string;
  freshness: Freshness;
  expires_at?: string;
}

export interface TripSummary {
  id: string;
  user_id: string;
  name: string;
  timezone: string;
  status: TripStatus;
}

export interface BookingSummary {
  id: string;
  user_id: string;
  trip_id: string;
  status: BookingStatus;
  currency: string;
  total: number;
}

export interface PaymentSummary {
  id: string;
  booking_id: string;
  provider: "dummy_payment";
  mode: "simulated";
  status: PaymentStatus;
  amount: number;
  currency: string;
}

export type ContextPointConfirmationStatus = "unconfirmed" | "confirmed";
export type ContextPointResolutionStatus =
  "resolved" | "ambiguous" | "unresolved";
export type AgendaStatus =
  "suggested" | "planned" | "confirmed" | "completed" | "skipped" | "cancelled";
export type JourneyLegStatus =
  "planned" | "in_progress" | "completed" | "cancelled";

export interface ContextPointSummary {
  id: string;
  trip_id: string;
  type: string;
  label: string;
  timezone: string;
  status: "active" | "archived";
  resolution_status: ContextPointResolutionStatus;
  confirmation_status: ContextPointConfirmationStatus;
  source: string;
}

export interface AgendaItemSummary {
  id: string;
  trip_id: string;
  context_point_id: string | null;
  title: string;
  start_at: string;
  end_at: string;
  timezone: string;
  status: AgendaStatus;
}

export interface JourneyLegSummary {
  id: string;
  trip_id: string;
  origin_context_point_id: string;
  destination_context_point_id: string;
  departure_at: string;
  arrival_deadline: string | null;
  status: JourneyLegStatus;
}
