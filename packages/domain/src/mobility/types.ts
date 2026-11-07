/**
 * Types for the deterministic mobility engine (Segment 06).
 *
 * Provider facts are values a provider returned. Derived metrics are values
 * this code computed from them under a versioned policy. The two are kept in
 * separate objects so a reader can always tell them apart.
 */

export type TransportMode = "car" | "taxi" | "pedestrian" | "transit";
export const TRANSPORT_MODES: readonly TransportMode[] = [
  "car",
  "taxi",
  "pedestrian",
  "transit",
];

export type RiskLevel = "low" | "medium" | "high" | "unknown";
export type RequiredFact = "route" | "traffic" | "weather";
export const REQUIRED_FACTS: readonly RequiredFact[] = [
  "route",
  "traffic",
  "weather",
];

export type Criticality = "normal" | "important_meeting" | "airport_departure";

export type ComfortPriority = "low" | "medium" | "high";
export type BudgetPreference = "low" | "moderate" | "high";

/** Reason codes allowed in output (Segment 06). Anything else is rejected. */
export const REASON_CODES = [
  "arrival_deadline",
  "traffic_delay",
  "traffic_incident",
  "weather_risk",
  "walking_limit",
  "transfer_limit",
  "cost_limit",
  "shorter_duration",
  "more_buffer",
  "public_transit_preference",
  "comfort_preference",
  "route_unavailable",
  "weather_unavailable",
  "traffic_unavailable",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export interface PlacePoint {
  name: string | null;
  latitude: number;
  longitude: number;
  provider_place_id: string | null;
}

export interface RouteSection {
  /** Provider section type: vehicle, pedestrian, transit, taxi, rented. */
  type: string;
  /** Provider transport mode of the section, for example car or lightRail. */
  mode: string | null;
  /** Service name such as a line. Null when the provider gave none. */
  service_name: string | null;
  /** Operator name. Null unless the provider returned it. */
  operator: string | null;
  operator_id: string | null;
  headsign: string | null;
  departure_at: string;
  arrival_at: string;
  duration_seconds: number;
  distance_meters: number | null;
  from: PlacePoint;
  to: PlacePoint;
}

export interface RouteCandidate {
  provider: "here_routing_v8" | "here_intermodal_v8";
  provider_route_id: string;
  transport_mode: TransportMode;
  distance_meters: number | null;
  duration_seconds: number;
  base_duration_seconds: number | null;
  typical_duration_seconds: number | null;
  departure_at: string;
  arrival_at: string;
  sections: RouteSection[];
  /** Provider notice codes for the route, for example walkOptionViolated. */
  notices: string[];
  /** Fare returned by the provider. Null when the provider returned none. */
  provider_fare: ProviderFare | null;
  /** Identifies which provider call produced the candidate. */
  source_key: string;
}

export interface ProviderFare {
  min_amount: number;
  max_amount: number;
  currency: string;
  is_estimate: boolean;
}

export interface WeatherPoint {
  /** ISO time the point is valid for. */
  at: string;
  granularity: "current" | "hourly" | "three_hourly" | "daily";
  /** Minutes between forecast points, when the provider reports it. */
  interval_minutes?: number;
  temperature_c: number | null;
  /** Probability of precipitation, 0 to 1. Null when the provider omitted it. */
  precipitation_probability: number | null;
  precipitation_mm: number | null;
  wind_speed_ms: number | null;
  visibility_m: number | null;
  condition_id: number | null;
  condition: string | null;
  description: string | null;
}

export interface WeatherAlert {
  sender: string | null;
  event: string;
  start: string | null;
  end: string | null;
}

export interface WeatherFacts {
  latitude: number;
  longitude: number;
  /** IANA timezone reported by the provider for the location. */
  timezone: string;
  observed_at: string | null;
  current: WeatherPoint | null;
  /** Forecast points. Hourly or three-hourly, see each point's granularity. */
  hourly: WeatherPoint[];
  daily: WeatherPoint[];
  alerts: WeatherAlert[];
  /** Minutes between forecast points; null when there is no forecast. */
  forecast_interval_minutes?: number | null;
  /** Time of the last forecast point. Later moments have no forecast. */
  forecast_ends_at?: string | null;
  retrieved_at: string;
  expires_at: string;
}

export type IncidentCriticality = "critical" | "major" | "minor" | "low";

export interface TrafficIncident {
  id: string;
  type: string | null;
  criticality: IncidentCriticality | null;
  road_closed: boolean;
  summary: string | null;
  start_time: string | null;
  end_time: string | null;
}

export interface TrafficFacts {
  /** Last update of the provider's traffic source. */
  observed_at: string | null;
  segment_count: number;
  /** Length-weighted average jam factor, 0 to 10. */
  average_jam_factor: number | null;
  max_jam_factor: number | null;
  closed_segment_count: number;
  incident_count: number;
  incidents: TrafficIncident[];
  retrieved_at: string;
  expires_at: string;
}

export interface MobilityPreferences {
  preferred_modes: TransportMode[];
  max_walking_minutes: number;
  max_transfers: number;
  budget_preference: BudgetPreference;
  avoid_heavy_traffic: boolean;
  comfort_priority: ComfortPriority;
}

export interface MobilityInput {
  /** Time used for freshness checks. */
  now: string;
  departure_at: string;
  arrival_deadline: string | null;
  timezone: string;
  criticality: Criticality;
  preferences: MobilityPreferences;
  required_facts: RequiredFact[];
  candidates: RouteCandidate[];
  traffic: TrafficFacts | null;
  weather: WeatherFacts | null;
}

export interface CostObject {
  min_amount: number | null;
  max_amount: number | null;
  currency: string;
  source_type: "provider" | "user_input" | "calculated" | "unavailable";
  is_estimate: boolean;
}

export interface ProviderFacts {
  distance_meters: number | null;
  duration_seconds: number;
  base_duration_seconds: number | null;
  typical_duration_seconds: number | null;
  departure_at: string;
  arrival_at: string;
  sections: RouteSection[];
  notices: string[];
}

export interface DerivedMetrics {
  departure_at: string;
  arrival_at: string;
  /** Duration including any waiting for a timetabled departure. */
  total_duration_seconds: number;
  traffic_delay_seconds: number | null;
  traffic_delay_ratio: number | null;
  walking_minutes: number;
  transfer_count: number;
  safety_buffer_seconds: number;
  /** Null when the leg has no arrival deadline. */
  deadline_slack_seconds: number | null;
  /** Null when the leg has no arrival deadline. */
  feasible: boolean | null;
  /** Latest departure that still meets the deadline, assuming the same duration. */
  latest_departure_at: string | null;
  reason_codes: ReasonCode[];
}

export interface RiskObject {
  traffic: RiskLevel;
  weather: RiskLevel;
  overall: RiskLevel;
}

export interface ScoreObject {
  total: number;
  components: Record<string, number | null>;
  weights: Record<string, number>;
  rank: number | null;
}

export interface EvaluatedOption {
  key: string;
  provider: RouteCandidate["provider"];
  provider_route_id: string;
  transport_mode: TransportMode;
  source_key: string;
  provider_facts: ProviderFacts;
  derived_metrics: DerivedMetrics;
  cost: CostObject;
  risk: RiskObject;
  score: ScoreObject | null;
  status: "valid" | "excluded";
  exclusion_reasons: ReasonCode[];
  recommended: boolean;
}

export interface DepartureRecommendation {
  /** Departure time the provider evaluated for the recommended option. */
  depart_at: string;
  /** Latest departure that still meets the deadline. Null when not computable. */
  latest_departure_at: string | null;
  buffer_seconds: number;
  policy_version: string;
  reason_codes: ReasonCode[];
}

export interface MobilityEvaluation {
  policy_version: string;
  options: EvaluatedOption[];
  recommended_key: string | null;
  departure_recommendation: DepartureRecommendation | null;
  facts: string[];
  limitations: string[];
  missing_facts: RequiredFact[];
  /** Cost was dropped from scoring because at least one valid option has no cost. */
  cost_compared: boolean;
  tie_break_applied: boolean;
}

export class MobilityEngineError extends Error {
  public readonly code:
    | "BUFFER_POLICY_MISSING"
    | "POLICY_INVALID"
    | "ROUTE_FACTS_MISSING"
    | "TRAFFIC_FACTS_MISSING"
    | "WEATHER_FACTS_MISSING"
    | "INPUT_INVALID";

  public constructor(code: MobilityEngineError["code"], message: string) {
    super(message);
    this.name = "MobilityEngineError";
    this.code = code;
  }
}
