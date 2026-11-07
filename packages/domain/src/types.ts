export type ContextPointType =
  | "airport"
  | "station"
  | "hotel"
  | "meeting"
  | "conference"
  | "event"
  | "restaurant"
  | "attraction"
  | "custom_location";

export type ContextPointStatus = "active" | "archived";
export type ContextResolutionStatus = "resolved" | "ambiguous" | "unresolved";
export type ContextConfirmationStatus = "unconfirmed" | "confirmed";
export type AgendaStatus =
  "suggested" | "planned" | "confirmed" | "completed" | "skipped" | "cancelled";
export type JourneyLegStatus =
  "planned" | "in_progress" | "completed" | "cancelled";

export interface TripRecord {
  id: string;
  userId: string;
  timezone: string;
  status: "draft" | "confirmed" | "active" | "completed";
}

export interface ContextPointRecord {
  id: string;
  tripId: string;
  type: ContextPointType;
  label: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone: string;
  externalPlaceId: string | null;
  status: ContextPointStatus;
  resolutionStatus: ContextResolutionStatus;
  confirmationStatus: ContextConfirmationStatus;
  source:
    | "user_input"
    | "booking_import"
    | "assistant_suggestion"
    | "brightdata"
    | "external_provider";
  metadata: Record<string, unknown>;
}

export interface AgendaItemRecord {
  id: string;
  tripId: string;
  contextPointId: string | null;
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
  startAt: string;
  endAt: string;
  timezone: string;
  status: AgendaStatus;
  source:
    | "user_input"
    | "booking_import"
    | "assistant_suggestion"
    | "event_discovery"
    | "external_provider";
  metadata: Record<string, unknown>;
}

export interface JourneyLegRecord {
  id: string;
  tripId: string;
  originContextPointId: string;
  destinationContextPointId: string;
  relatedAgendaId: string | null;
  departureAt: string;
  arrivalDeadline: string | null;
  status: JourneyLegStatus;
}

export interface CommandContext {
  actorUserId: string;
  idempotencyKey: string;
  requestHash: string;
}

export interface CreateContextPointInput {
  tripId: string;
  type: ContextPointType;
  label: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  timezone: string;
  externalPlaceId?: string;
  resolutionStatus?: ContextResolutionStatus;
  confirmationStatus?: ContextConfirmationStatus;
  source: ContextPointRecord["source"];
  metadata?: Record<string, unknown>;
}

export interface ResolveContextPointInput {
  label?: string;
  address?: string;
  latitude: number;
  longitude: number;
  timezone: string;
  externalPlaceId: string;
}

export interface CreateAgendaItemInput {
  tripId: string;
  contextPointId?: string;
  title: string;
  type: AgendaItemRecord["type"];
  startAt: string;
  endAt: string;
  timezone: string;
  source: AgendaItemRecord["source"];
  metadata?: Record<string, unknown>;
}

export interface CreateJourneyLegInput {
  tripId: string;
  originContextPointId: string;
  destinationContextPointId: string;
  relatedAgendaId?: string;
  departureAt: string;
  arrivalDeadline?: string;
}

export type ContextResolutionResult =
  | { kind: "created"; contextPoint: ContextPointRecord }
  | {
      kind: "awaiting_clarification";
      contextPoint: ContextPointRecord;
      clarification: string;
    };
