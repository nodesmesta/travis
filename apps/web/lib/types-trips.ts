import type { ContextPoint } from "./types";

export type { AgendaItemView, JourneyLegView } from "./types-assistant";
export type { ContextPoint, Trip } from "./types";

/** Trip status flow. A trip only moves forward. */
export type TripStatus = "draft" | "confirmed" | "active" | "completed";

export const TRIP_TRANSITIONS: Record<
  string,
  { target: "confirmed" | "active" | "completed"; action: string } | undefined
> = {
  draft: { target: "confirmed", action: "Confirm trip" },
  confirmed: { target: "active", action: "Start trip" },
  active: { target: "completed", action: "Complete trip" },
};

export interface CreateTripBody {
  name: string;
  destination_summary?: string;
  start_at?: string;
  end_at?: string;
  timezone: string;
}

/** Fields of `PATCH /trips/{id}`. A null date clears it. */
export interface UpdateTripBody {
  name?: string;
  destination_summary?: string | null;
  start_at?: string | null;
  end_at?: string | null;
  timezone?: string;
}

export const CONTEXT_POINT_TYPES = [
  { value: "hotel", label: "Hotel" },
  { value: "airport", label: "Airport" },
  { value: "station", label: "Station" },
  { value: "meeting", label: "Meeting venue" },
  { value: "conference", label: "Conference" },
  { value: "event", label: "Event venue" },
  { value: "restaurant", label: "Restaurant" },
  { value: "attraction", label: "Attraction" },
  { value: "custom_location", label: "Custom location" },
] as const;

export type ContextPointType = (typeof CONTEXT_POINT_TYPES)[number]["value"];

export interface CreateContextPointBody {
  type: ContextPointType;
  label: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  timezone: string;
  external_place_id?: string;
}

export interface ResolveContextPointBody {
  label?: string;
  address?: string;
  latitude: number;
  longitude: number;
  timezone: string;
  external_place_id: string;
}

/** Answer of `POST /trips/{id}/context-points`. 201 is `created`, 202 is `awaiting_clarification`. */
export interface ContextPointResult {
  kind: "created" | "awaiting_clarification";
  context_point: ContextPoint;
  clarification?: string;
  request_id: string;
}

export const AGENDA_TYPES = [
  { value: "meeting", label: "Meeting" },
  { value: "conference", label: "Conference" },
  { value: "flight", label: "Flight" },
  { value: "train", label: "Train" },
  { value: "event", label: "Event" },
  { value: "meal", label: "Meal" },
  { value: "hotel_check_in", label: "Hotel check-in" },
  { value: "hotel_check_out", label: "Hotel check-out" },
  { value: "free_time", label: "Free time" },
  { value: "custom", label: "Other" },
] as const;

export type AgendaType = (typeof AGENDA_TYPES)[number]["value"];

export interface CreateAgendaItemBody {
  title: string;
  type: AgendaType;
  start_at: string;
  end_at: string;
  timezone: string;
  context_point_id?: string;
}

export interface CreateJourneyLegBody {
  origin_context_point_id: string;
  destination_context_point_id: string;
  departure_at: string;
  arrival_deadline?: string;
}
