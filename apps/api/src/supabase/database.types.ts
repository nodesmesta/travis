import type {
  MobilityFunctions,
  MobilityTables,
} from "./tables/mobility.types.js";
import type {
  ConversationFunctions,
  ConversationTables,
} from "./tables/conversation.types.js";
import type { JobFunctions, JobTables } from "./tables/job.types.js";
import type {
  InvoiceFunctions,
  InvoiceTables,
} from "./tables/invoice.types.js";

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

type ProfileRow = {
  id: string;
  name: string | null;
  timezone: string;
  preferences: Json;
  created_at: string;
  updated_at: string;
};

type TripRow = {
  id: string;
  user_id: string;
  name: string;
  destination_summary: string | null;
  start_at: string | null;
  end_at: string | null;
  timezone: string;
  status: "draft" | "confirmed" | "active" | "completed";
  source: "user_input" | "imported_booking" | "internal";
  created_at: string;
  updated_at: string;
};

type ContextPointRow = {
  id: string;
  trip_id: string;
  type:
    | "airport"
    | "station"
    | "hotel"
    | "meeting"
    | "conference"
    | "event"
    | "restaurant"
    | "attraction"
    | "custom_location";
  label: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone: string;
  external_place_id: string | null;
  status: "active" | "archived";
  resolution_status: "resolved" | "ambiguous" | "unresolved";
  source:
    | "user_input"
    | "booking_import"
    | "assistant_suggestion"
    | "brightdata"
    | "external_provider";
  confirmation_status: "unconfirmed" | "confirmed";
  metadata: Json;
  created_at: string;
  updated_at: string;
};

type AgendaItemRow = {
  id: string;
  trip_id: string;
  context_point_id: string | null;
  title: string;
  type:
    | "flight"
    | "train"
    | "meeting"
    | "conference"
    | "event"
    | "meal"
    | "hotel_check_in"
    | "hotel_check_out"
    | "free_time"
    | "custom";
  start_at: string;
  end_at: string;
  timezone: string;
  status:
    | "suggested"
    | "planned"
    | "confirmed"
    | "completed"
    | "skipped"
    | "cancelled";
  source:
    | "user_input"
    | "booking_import"
    | "assistant_suggestion"
    | "event_discovery"
    | "external_provider";
  metadata: Json;
  created_at: string;
  updated_at: string;
};

type JourneyLegRow = {
  id: string;
  trip_id: string;
  origin_context_point_id: string;
  destination_context_point_id: string;
  related_agenda_id: string | null;
  departure_at: string;
  arrival_deadline: string | null;
  status: "planned" | "in_progress" | "completed" | "cancelled";
  created_at: string;
  updated_at: string;
};

type IdempotencyRecordRow = {
  id: string;
  actor_user_id: string;
  scope: string;
  idempotency_key: string;
  request_hash: string;
  status: "processing" | "completed";
  response_body: Json;
  created_at: string;
  completed_at: string | null;
  expires_at: string | null;
};

type ActivityLogRow = {
  id: string;
  actor_user_id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  metadata: Json;
  created_at: string;
};

type EventDiscoveryRunRow = {
  id: string;
  trip_id: string;
  context_point_id: string;
  request_id: string;
  request_fingerprint: string;
  category: string;
  observed_from: string;
  observed_to: string;
  timezone: string;
  status: "ok" | "empty" | "invalid" | "unavailable";
  retrieved_at: string;
  expires_at: string;
  error_code: string | null;
  metadata: Json;
  created_at: string;
};

type SourceRow = {
  id: string;
  trip_id: string;
  kind:
    "provider" | "official_page" | "search_result" | "user_input" | "internal";
  provider: string;
  url: string | null;
  title: string | null;
  retrieved_at: string;
  freshness: "fresh" | "expired" | "unavailable";
  expires_at: string | null;
  observed_for: Json | null;
  content_hash: string | null;
  metadata: Json;
  created_at: string;
};

type EventDiscoveryResultRow = {
  id: string;
  run_id: string;
  trip_id: string;
  context_point_id: string;
  source_id: string;
  title: string;
  description: string | null;
  venue_name: string | null;
  starts_at: string;
  ends_at: string | null;
  category: string | null;
  status: "suggested" | "selected" | "rejected" | "expired";
  retrieved_at: string;
  expires_at: string;
  metadata: Json;
  created_at: string;
};

type SourceReferenceRow = {
  id: string;
  trip_id: string;
  source_id: string;
  entity_type: "event_discovery_run" | "event_discovery_result";
  entity_id: string;
  relationship_type: string;
  created_at: string;
};

type BookingRow = {
  id: string;
  user_id: string;
  trip_id: string;
  booking_type: "event" | "activity" | "itinerary_item";
  source_type: "event_discovery_result" | "activity" | "agenda_item";
  source_id: string;
  provider_name: string;
  confirmation_code: string | null;
  status:
    | "draft"
    | "pending_payment"
    | "paid"
    | "confirmed"
    | "cancelled"
    | "expired"
    | "failed"
    | "refunded";
  currency: string;
  subtotal: number;
  tax: number;
  total: number;
  pricing_policy: string;
  starts_at: string | null;
  ends_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
};

type PaymentRow = {
  id: string;
  booking_id: string;
  payment_reference: string;
  provider: "dummy_payment";
  mode: "simulated";
  amount: number;
  currency: string;
  status: "pending" | "succeeded" | "failed" | "cancelled" | "refunded";
  paid_at: string | null;
  failed_at: string | null;
  failure_code: string | null;
  metadata: Json;
  created_at: string;
  updated_at: string;
};

export type TableDefinition<Row, Insert, Update> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: CoreTables &
      MobilityTables &
      ConversationTables &
      JobTables &
      InvoiceTables;
    Views: Record<string, never>;
    Functions: CoreFunctions &
      MobilityFunctions &
      ConversationFunctions &
      JobFunctions &
      InvoiceFunctions;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

type CoreTables = {
  profiles: TableDefinition<
    ProfileRow,
    {
      id: string;
      name?: string | null;
      timezone?: string;
      preferences?: Json;
      created_at?: string;
      updated_at?: string;
    },
    Partial<Omit<ProfileRow, "id">>
  >;
  trips: TableDefinition<
    TripRow,
    {
      id?: string;
      user_id: string;
      name: string;
      destination_summary?: string | null;
      start_at?: string | null;
      end_at?: string | null;
      timezone: string;
      status?: TripRow["status"];
      source?: TripRow["source"];
      created_at?: string;
      updated_at?: string;
    },
    Partial<Omit<TripRow, "id" | "user_id" | "created_at" | "updated_at">>
  >;
  context_points: TableDefinition<
    ContextPointRow,
    {
      id?: string;
      trip_id: string;
      type: ContextPointRow["type"];
      label: string;
      address?: string | null;
      latitude?: number | null;
      longitude?: number | null;
      timezone: string;
      external_place_id?: string | null;
      status?: ContextPointRow["status"];
      resolution_status?: ContextPointRow["resolution_status"];
      source?: ContextPointRow["source"];
      confirmation_status?: ContextPointRow["confirmation_status"];
      metadata?: Json;
      created_at?: string;
      updated_at?: string;
    },
    Partial<
      Omit<ContextPointRow, "id" | "trip_id" | "created_at" | "updated_at">
    >
  >;
  agenda_items: TableDefinition<
    AgendaItemRow,
    {
      id?: string;
      trip_id: string;
      context_point_id?: string | null;
      title: string;
      type: AgendaItemRow["type"];
      start_at: string;
      end_at: string;
      timezone: string;
      status?: AgendaItemRow["status"];
      source?: AgendaItemRow["source"];
      metadata?: Json;
      created_at?: string;
      updated_at?: string;
    },
    Partial<Omit<AgendaItemRow, "id" | "trip_id" | "created_at" | "updated_at">>
  >;
  journey_legs: TableDefinition<
    JourneyLegRow,
    {
      id?: string;
      trip_id: string;
      origin_context_point_id: string;
      destination_context_point_id: string;
      related_agenda_id?: string | null;
      departure_at: string;
      arrival_deadline?: string | null;
      status?: JourneyLegRow["status"];
      created_at?: string;
      updated_at?: string;
    },
    Partial<Omit<JourneyLegRow, "id" | "trip_id" | "created_at" | "updated_at">>
  >;
  idempotency_records: TableDefinition<
    IdempotencyRecordRow,
    {
      id?: string;
      actor_user_id: string;
      scope: string;
      idempotency_key: string;
      request_hash: string;
      status?: IdempotencyRecordRow["status"];
      response_body?: Json;
      created_at?: string;
      completed_at?: string | null;
      expires_at?: string | null;
    },
    Partial<Omit<IdempotencyRecordRow, "id" | "actor_user_id" | "created_at">>
  >;
  activity_logs: TableDefinition<
    ActivityLogRow,
    {
      id?: string;
      actor_user_id: string;
      action: string;
      resource_type: string;
      resource_id: string;
      metadata?: Json;
      created_at?: string;
    },
    never
  >;
  event_discovery_runs: TableDefinition<
    EventDiscoveryRunRow,
    {
      id?: string;
      trip_id: string;
      context_point_id: string;
      request_id: string;
      request_fingerprint: string;
      category: string;
      observed_from: string;
      observed_to: string;
      timezone: string;
      status: EventDiscoveryRunRow["status"];
      retrieved_at: string;
      expires_at: string;
      error_code?: string | null;
      metadata?: Json;
      created_at?: string;
    },
    never
  >;
  sources: TableDefinition<
    SourceRow,
    {
      id?: string;
      trip_id: string;
      kind: SourceRow["kind"];
      provider: string;
      url?: string | null;
      title?: string | null;
      retrieved_at: string;
      freshness: SourceRow["freshness"];
      expires_at?: string | null;
      observed_for?: Json | null;
      content_hash?: string | null;
      metadata?: Json;
      created_at?: string;
    },
    never
  >;
  event_discovery_results: TableDefinition<
    EventDiscoveryResultRow,
    {
      id?: string;
      run_id: string;
      trip_id: string;
      context_point_id: string;
      source_id: string;
      title: string;
      description?: string | null;
      venue_name?: string | null;
      starts_at: string;
      ends_at?: string | null;
      category?: string | null;
      status?: EventDiscoveryResultRow["status"];
      retrieved_at: string;
      expires_at: string;
      metadata?: Json;
      created_at?: string;
    },
    never
  >;
  source_references: TableDefinition<
    SourceReferenceRow,
    {
      id?: string;
      trip_id: string;
      source_id: string;
      entity_type: SourceReferenceRow["entity_type"];
      entity_id: string;
      relationship_type: string;
      created_at?: string;
    },
    never
  >;
  bookings: TableDefinition<
    BookingRow,
    {
      id?: string;
      user_id: string;
      trip_id: string;
      booking_type: BookingRow["booking_type"];
      source_type: BookingRow["source_type"];
      source_id: string;
      provider_name?: string;
      confirmation_code?: string | null;
      status?: BookingRow["status"];
      currency: string;
      subtotal: number;
      tax?: number;
      total: number;
      pricing_policy?: string;
      starts_at?: string | null;
      ends_at?: string | null;
      cancelled_at?: string | null;
      created_at?: string;
      updated_at?: string;
    },
    Partial<
      Omit<
        BookingRow,
        "id" | "user_id" | "trip_id" | "created_at" | "updated_at"
      >
    >
  >;
  payments: TableDefinition<
    PaymentRow,
    {
      id?: string;
      booking_id: string;
      payment_reference: string;
      provider?: PaymentRow["provider"];
      mode?: PaymentRow["mode"];
      amount: number;
      currency: string;
      status?: PaymentRow["status"];
      paid_at?: string | null;
      failed_at?: string | null;
      failure_code?: string | null;
      metadata?: Json;
      created_at?: string;
      updated_at?: string;
    },
    Partial<Omit<PaymentRow, "id" | "booking_id" | "created_at" | "updated_at">>
  >;
};

type CoreFunctions = {
  simulate_dummy_payment: {
    Args: {
      p_booking_id: string;
      p_outcome: string;
      p_failure_code: string | null;
      p_idempotency_key: string;
      p_request_hash: string;
      p_scope: string;
    };
    Returns: Json;
  };
  refund_dummy_payment: {
    Args: {
      p_booking_id: string;
      p_payment_id: string;
      p_idempotency_key: string;
      p_request_hash: string;
      p_scope: string;
    };
    Returns: Json;
  };
};

export type Profile = Database["public"]["Tables"]["profiles"]["Row"];
export type Trip = Database["public"]["Tables"]["trips"]["Row"];
export type ContextPoint =
  Database["public"]["Tables"]["context_points"]["Row"];
export type AgendaItem = Database["public"]["Tables"]["agenda_items"]["Row"];
export type JourneyLeg = Database["public"]["Tables"]["journey_legs"]["Row"];
export type EventDiscoveryRun =
  Database["public"]["Tables"]["event_discovery_runs"]["Row"];
export type Source = Database["public"]["Tables"]["sources"]["Row"];
export type EventDiscoveryResult =
  Database["public"]["Tables"]["event_discovery_results"]["Row"];
export type SourceReference =
  Database["public"]["Tables"]["source_references"]["Row"];
export type Booking = Database["public"]["Tables"]["bookings"]["Row"];
export type Payment = Database["public"]["Tables"]["payments"]["Row"];
export type {
  EventDiscoveryRunRow,
  SourceRow,
  EventDiscoveryResultRow,
  SourceReferenceRow,
};
