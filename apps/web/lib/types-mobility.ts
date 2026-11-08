/** API shapes for Task 08. They mirror contracts/schemas; nothing here is computed in the browser. */

export type RiskLevel = "low" | "medium" | "high" | "unknown";
export type TransportMode = "car" | "taxi" | "pedestrian" | "transit";
export type MobilityFreshness = "fresh" | "expired";

export interface JourneyLeg {
  id: string;
  trip_id: string;
  origin_context_point_id: string;
  destination_context_point_id: string;
  related_agenda_id: string | null;
  departure_at: string;
  arrival_deadline: string | null;
  status: "planned" | "in_progress" | "completed" | "cancelled";
}

export interface MobilitySource {
  id: string;
  kind: string;
  provider: string;
  url?: string;
  title?: string;
  retrieved_at: string;
  freshness: "fresh" | "expired" | "unavailable";
  expires_at?: string;
}

export interface RouteSectionView {
  type: string;
  mode: string | null;
  service_name: string | null;
  operator: string | null;
  headsign: string | null;
  departure_at: string;
  arrival_at: string;
  duration_seconds: number;
}

export interface RouteOptionView {
  id: string;
  route_request_id: string;
  provider: string;
  provider_route_id: string;
  transport_mode: TransportMode;
  provider_facts: {
    distance_meters: number | null;
    duration_seconds: number;
    base_duration_seconds: number | null;
    typical_duration_seconds: number | null;
    departure_at: string;
    arrival_at: string;
    sections: RouteSectionView[];
    notices: string[];
  };
  derived_metrics: {
    departure_at: string;
    arrival_at: string;
    total_duration_seconds: number;
    traffic_delay_seconds: number | null;
    traffic_delay_ratio: number | null;
    walking_minutes: number;
    transfer_count: number;
    safety_buffer_seconds: number;
    deadline_slack_seconds: number | null;
    feasible: boolean | null;
    latest_departure_at: string | null;
    reason_codes: string[];
  };
  cost: {
    min_amount: number | null;
    max_amount: number | null;
    currency: string;
    source_type: "provider" | "user_input" | "calculated" | "unavailable";
    is_estimate: boolean;
  };
  risk: { traffic: RiskLevel; weather: RiskLevel; overall: RiskLevel };
  score: { total: number; rank: number | null } | null;
  status: "valid" | "excluded" | "expired" | "invalid";
  exclusion_reasons: string[];
  recommended: boolean;
  selected: boolean;
  policy_version: string;
  source_ids: string[];
  retrieved_at: string;
  expires_at: string;
  freshness: MobilityFreshness;
}

export interface RouteRequestView {
  id: string;
  journey_leg_id: string;
  status: "completed" | "failed";
  error_code: string | null;
  policy_version: string;
  selected_option_id: string | null;
  retrieved_at: string;
  expires_at: string;
  freshness: MobilityFreshness;
}

export interface WeatherPointView {
  at: string;
  granularity: "current" | "hourly" | "three_hourly" | "daily";
  interval_minutes?: number;
  temperature_c: number | null;
  precipitation_probability: number | null;
  precipitation_mm: number | null;
  wind_speed_ms: number | null;
  visibility_m: number | null;
  condition: string | null;
  description: string | null;
}

export interface WeatherSnapshotView {
  id: string;
  context_point_id: string;
  source_id: string;
  timezone: string;
  retrieved_at: string;
  expires_at: string;
  freshness: MobilityFreshness;
  cache_status?: "hit" | "miss";
  current: WeatherPointView | null;
  hourly: WeatherPointView[];
  daily: WeatherPointView[];
  alerts: Array<{
    sender: string | null;
    event: string;
    start: string | null;
    end: string | null;
  }>;
  /** Minutes between forecast points. Null when there is no forecast. */
  forecast_interval_minutes?: number | null;
  /** Time of the last forecast point. Later moments have no forecast. */
  forecast_ends_at?: string | null;
}

export interface TrafficSnapshotView {
  id: string;
  journey_leg_id: string | null;
  origin_context_point_id: string;
  destination_context_point_id: string;
  source_id: string;
  policy_version: string;
  traffic_level: RiskLevel;
  observed_at: string | null;
  retrieved_at: string;
  expires_at: string;
  freshness: MobilityFreshness;
  cache_status?: "hit" | "miss";
  summary: {
    segment_count: number;
    average_jam_factor: number | null;
    max_jam_factor: number | null;
    closed_segment_count: number;
    incident_count: number;
  };
  incidents: Array<{
    id: string;
    type: string | null;
    criticality: string | null;
    road_closed: boolean;
    summary: string | null;
  }>;
}

export interface RouteRequestResult {
  request_id: string;
  route_request: RouteRequestView;
  options: RouteOptionView[];
  recommended_option_id: string | null;
  departure_recommendation: {
    depart_at: string;
    latest_departure_at: string | null;
    buffer_seconds: number;
    policy_version: string;
    reason_codes: string[];
  } | null;
  facts: string[];
  limitations: string[];
  sources: MobilitySource[];
  weather: WeatherSnapshotView | null;
  traffic: TrafficSnapshotView | null;
}

export interface WeatherList {
  request_id: string;
  items: WeatherSnapshotView[];
  missing_context_point_ids: string[];
}

export interface TrafficList {
  request_id: string;
  items: TrafficSnapshotView[];
}

export interface PlaceItemView {
  id: string;
  context_point_id: string;
  category: "activity" | "restaurant";
  name: string;
  description?: string | null;
  address?: string | null;
  distance_meters?: number | null;
  official_url?: string | null;
  activity_type?: string | null;
  indoor_outdoor?: "indoor" | "outdoor" | "both" | "unknown" | null;
  recommended_duration_minutes?: number | null;
  weather_sensitivity?: "low" | "medium" | "high" | "unknown" | null;
  booking_required?: boolean | null;
  cuisines?: string[];
  opening_hours: { text: string[] } | null;
  status: string;
  source_ids: string[];
  retrieved_at: string;
  expires_at: string;
  freshness: MobilityFreshness;
}

export interface PlaceDiscoveryView {
  request_id: string;
  context_point_id: string;
  category: "activity" | "restaurant";
  status: "ok" | "empty";
  cache_status?: "hit" | "miss";
  items: PlaceItemView[];
  sources: MobilitySource[];
  retrieved_at: string;
  expires_at: string;
  freshness: "fresh" | "expired" | "unavailable";
  limitations: string[];
}
