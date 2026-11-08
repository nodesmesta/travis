import type {
  AgendaItemRecord,
  ContextPointRecord,
  CostObject,
  DepartureRecommendation,
  DerivedMetrics,
  JourneyLegRecord,
  ProviderFacts,
  RiskObject,
  ToolRegistry,
  TrafficIncident,
  TransportMode,
  WeatherAlert,
  WeatherPoint,
} from "@travelflow/domain";
import type { Booking } from "../../supabase/database.types.js";
import type { EventDiscoveryResponse } from "../../repositories/event-discovery-repository.js";
import type { RecommendationRecord } from "../../repositories/recommendation-repository.js";

/** What the assistant knows about a trip, loaded once per request. */
export interface TripSnapshotData {
  trip: { id: string; name: string; timezone: string; status: string };
  destinationSummary: string | null;
  contextPoints: ContextPointRecord[];
  agenda: AgendaItemRecord[];
  journeyLegs: JourneyLegRecord[];
  bookings: Booking[];
}

/** A source as the mobility and place services report it. */
export interface SourceView {
  id: string;
  kind:
    "provider" | "official_page" | "search_result" | "user_input" | "internal";
  provider: string;
  url?: string;
  title?: string;
  retrieved_at: string;
  freshness: "fresh" | "expired" | "unavailable";
  expires_at?: string;
  observed_for?: { from?: string; to?: string; timezone?: string };
}

export interface RouteOptionView {
  id: string;
  transport_mode: TransportMode;
  provider_facts: ProviderFacts;
  derived_metrics: DerivedMetrics;
  cost: CostObject;
  risk: RiskObject;
  score: { total: number; rank: number | null } | null;
  status: string;
  exclusion_reasons: string[];
  recommended: boolean;
  source_ids: string[];
  retrieved_at: string;
  expires_at: string;
  freshness: "fresh" | "expired";
}

export interface WeatherView {
  id: string;
  context_point_id: string;
  source_id: string;
  timezone: string;
  observed_at: string | null;
  retrieved_at: string;
  expires_at: string;
  freshness: "fresh" | "expired";
  cache_status?: "hit" | "miss";
  current: WeatherPoint | null;
  /** Forecast points. Three hours apart on the plan without a subscription. */
  hourly: WeatherPoint[];
  daily: WeatherPoint[];
  alerts: WeatherAlert[];
  forecast_interval_minutes?: number | null;
  /** Time of the last forecast point. Later moments have no forecast. */
  forecast_ends_at?: string | null;
}

export interface TrafficView {
  id: string;
  source_id: string;
  traffic_level: string;
  observed_at: string | null;
  retrieved_at: string;
  expires_at: string;
  freshness: "fresh" | "expired";
  cache_status?: "hit" | "miss";
  area: { latitude: number; longitude: number; radius_meters: number };
  summary: {
    segment_count?: number;
    average_jam_factor?: number | null;
    max_jam_factor?: number | null;
    closed_segment_count?: number;
    incident_count?: number;
  };
  incidents: TrafficIncident[];
}

export interface RouteComparisonView {
  /** True when nothing was stored (no journey leg covers the pair). */
  preview: boolean;
  routeRequestId: string | null;
  originContextPointId: string;
  destinationContextPointId: string;
  departureAt: string;
  arrivalDeadline: string | null;
  /** "requested" when the user gave a time, "now" when none was given, "leg" for a stored leg. */
  departureBasis: "requested" | "now" | "leg";
  options: RouteOptionView[];
  recommendedOptionId: string | null;
  departureRecommendation: DepartureRecommendation | null;
  facts: string[];
  limitations: string[];
  sources: SourceView[];
  weather: WeatherView | null;
  traffic: TrafficView | null;
}

export interface PlaceView {
  id: string;
  name: string;
  description: string | null;
  address: string | null;
  distance_meters: number | null;
  official_url: string | null;
  activity_type?: string | null;
  indoor_outdoor?: string | null;
  recommended_duration_minutes?: number | null;
  weather_sensitivity?: string | null;
  booking_required?: boolean | null;
  cuisines?: string[];
  opening_hours: { text: string[] } | null;
  status: string;
  source_ids: string[];
  retrieved_at: string;
  expires_at: string;
  freshness: "fresh" | "expired";
}

export interface PlaceDiscoveryView {
  category: "activity" | "restaurant";
  status: "ok" | "empty";
  cache_status: "hit" | "miss";
  items: PlaceView[];
  sources: SourceView[];
  retrieved_at: string;
  expires_at: string;
  freshness: "fresh" | "expired";
  limitations: string[];
}

/** Narrow ports the tools use. The LLM never reaches these directly. */
export interface ToolServices {
  discoverEvents(input: {
    requestId: string;
    executionId: string;
    userId: string;
    tripId: string;
    contextPointId: string;
    observedFor: { from: string; to: string; timezone: string };
    category: string;
    radiusPreference?: string;
    language?: string;
  }): Promise<EventDiscoveryResponse>;
  /**
   * Routes for a stored journey leg, or for a pair of context points when no
   * leg is given. Both end in the same deterministic engine.
   */
  compareRoutes(input: {
    requestId: string;
    executionId: string;
    userId: string;
    tripId: string;
    journeyLegId?: string;
    originContextPointId?: string;
    destinationContextPointId?: string;
    /** ISO time with offset. Null means leave now. Ignored for a stored leg. */
    departureAt: string | null;
    modes?: TransportMode[];
  }): Promise<RouteComparisonView>;
  getWeather(input: {
    requestId: string;
    userId: string;
    tripId: string;
    contextPointId: string;
  }): Promise<{ weather: WeatherView; sources: SourceView[] }>;
  getTraffic(input: {
    requestId: string;
    userId: string;
    tripId: string;
    journeyLegId?: string;
    originContextPointId?: string;
    destinationContextPointId?: string;
  }): Promise<{
    traffic: TrafficView;
    originContextPointId: string;
    destinationContextPointId: string;
    sources: SourceView[];
  }>;
  discoverPlaces(input: {
    requestId: string;
    executionId: string;
    userId: string;
    tripId: string;
    contextPointId: string;
    category: "activity" | "restaurant";
    radiusMeters?: number;
    language?: string;
  }): Promise<PlaceDiscoveryView>;
  listBookings(tripId: string): Promise<Booking[]>;
  listRecommendations(tripId: string): Promise<RecommendationRecord[]>;
}

/** Everything a tool may use. Built per request from the authenticated session. */
export interface ToolRuntime {
  requestId: string;
  executionId: string;
  userId: string;
  tripId: string;
  snapshot: TripSnapshotData;
  services: ToolServices;
  now: () => Date;
  maxItems: number;
}

export type AssistantToolRegistry = ToolRegistry<ToolRuntime>;
