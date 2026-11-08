import type { Json, TableDefinition } from "../database.types.js";

/** Table and function types for Task 08 (migration 0007). */

export type RiskLevelValue = "low" | "medium" | "high" | "unknown";

export type PlaceDiscoveryRunRow = {
  id: string;
  trip_id: string;
  context_point_id: string;
  category: "activity" | "restaurant";
  request_id: string;
  request_fingerprint: string;
  provider: "bright_data" | "here_places_v7";
  status: "ok" | "empty" | "invalid" | "unavailable";
  retrieved_at: string;
  expires_at: string;
  error_code: string | null;
  metadata: Json;
  created_at: string;
};

export type PlaceDiscoveryResultRow = {
  id: string;
  run_id: string;
  trip_id: string;
  context_point_id: string;
  source_id: string;
  category: "activity" | "restaurant";
  name: string;
  description: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  distance_meters: number | null;
  official_url: string | null;
  provider_place_id: string | null;
  activity_type: string | null;
  indoor_outdoor: "indoor" | "outdoor" | "both" | "unknown" | null;
  recommended_duration_minutes: number | null;
  weather_sensitivity: "low" | "medium" | "high" | "unknown" | null;
  booking_required: boolean | null;
  cuisines: Json;
  opening_hours: Json | null;
  evidence: string | null;
  status: "suggested" | "selected" | "rejected" | "expired";
  retrieved_at: string;
  expires_at: string;
  metadata: Json;
  created_at: string;
};

export type WeatherSnapshotRow = {
  id: string;
  trip_id: string;
  context_point_id: string;
  provider: "openweather_free_2_5";
  source_id: string;
  request_fingerprint: string;
  latitude: number;
  longitude: number;
  timezone: string;
  observed_at: string | null;
  valid_from: string;
  valid_to: string;
  current_condition: string | null;
  current_temperature_c: number | null;
  max_precipitation_probability: number | null;
  payload: Json;
  retrieved_at: string;
  expires_at: string;
  created_at: string;
};

export type TrafficSnapshotRow = {
  id: string;
  trip_id: string;
  journey_leg_id: string | null;
  origin_context_point_id: string;
  destination_context_point_id: string;
  provider: "here_traffic_v7";
  source_id: string;
  request_fingerprint: string;
  policy_version: string;
  traffic_level: RiskLevelValue;
  center_latitude: number;
  center_longitude: number;
  radius_meters: number;
  observed_at: string | null;
  valid_from: string;
  valid_to: string;
  payload: Json;
  retrieved_at: string;
  expires_at: string;
  created_at: string;
};

export type RouteRequestRow = {
  id: string;
  trip_id: string;
  journey_leg_id: string;
  origin_context_point_id: string;
  destination_context_point_id: string;
  request_id: string;
  request_fingerprint: string;
  departure_at: string;
  arrival_deadline: string | null;
  preferences: Json;
  required_facts: Json;
  modes: Json;
  status: "completed" | "failed";
  error_code: string | null;
  policy_version: string;
  weather_snapshot_id: string | null;
  traffic_snapshot_id: string | null;
  selected_option_id: string | null;
  facts: Json;
  limitations: Json;
  departure_recommendation: Json | null;
  retrieved_at: string;
  expires_at: string;
  created_at: string;
};

export type RouteOptionRow = {
  id: string;
  route_request_id: string;
  trip_id: string;
  provider: "here_routing_v8" | "here_intermodal_v8";
  provider_route_id: string;
  transport_mode: "car" | "taxi" | "pedestrian" | "transit";
  source_id: string;
  weather_snapshot_id: string | null;
  traffic_snapshot_id: string | null;
  provider_facts: Json;
  derived_metrics: Json;
  cost: Json;
  risk: Json;
  score: Json | null;
  traffic_risk: RiskLevelValue;
  weather_risk: RiskLevelValue;
  overall_risk: RiskLevelValue;
  duration_seconds: number;
  total_duration_seconds: number;
  walking_minutes: number;
  transfer_count: number;
  departure_at: string;
  arrive_at: string;
  feasible: boolean | null;
  rank: number | null;
  status: "valid" | "excluded" | "expired" | "invalid";
  exclusion_reasons: Json;
  recommended: boolean;
  policy_version: string;
  retrieved_at: string;
  expires_at: string;
  created_at: string;
};

export type RecommendationRow = {
  id: string;
  trip_id: string;
  conversation_id: string | null;
  context_point_id: string | null;
  recommendation_type: "route";
  route_request_id: string | null;
  route_option_id: string | null;
  context_snapshot: Json;
  payload: Json;
  reason: string | null;
  status: "suggested" | "saved" | "applied" | "dismissed" | "expired";
  policy_version: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
};

export type MobilityTables = {
  place_discovery_runs: TableDefinition<
    PlaceDiscoveryRunRow,
    {
      id?: string;
      trip_id: string;
      context_point_id: string;
      category: PlaceDiscoveryRunRow["category"];
      request_id: string;
      request_fingerprint: string;
      provider: PlaceDiscoveryRunRow["provider"];
      status: PlaceDiscoveryRunRow["status"];
      retrieved_at: string;
      expires_at: string;
      error_code?: string | null;
      metadata?: Json;
      created_at?: string;
    },
    never
  >;
  place_discovery_results: TableDefinition<
    PlaceDiscoveryResultRow,
    {
      id?: string;
      run_id: string;
      trip_id: string;
      context_point_id: string;
      source_id: string;
      category: PlaceDiscoveryResultRow["category"];
      name: string;
      description?: string | null;
      address?: string | null;
      latitude?: number | null;
      longitude?: number | null;
      distance_meters?: number | null;
      official_url?: string | null;
      provider_place_id?: string | null;
      activity_type?: string | null;
      indoor_outdoor?: PlaceDiscoveryResultRow["indoor_outdoor"];
      recommended_duration_minutes?: number | null;
      weather_sensitivity?: PlaceDiscoveryResultRow["weather_sensitivity"];
      booking_required?: boolean | null;
      cuisines?: Json;
      opening_hours?: Json | null;
      evidence?: string | null;
      status?: PlaceDiscoveryResultRow["status"];
      retrieved_at: string;
      expires_at: string;
      metadata?: Json;
      created_at?: string;
    },
    never
  >;
  weather_snapshots: TableDefinition<
    WeatherSnapshotRow,
    {
      id?: string;
      trip_id: string;
      context_point_id: string;
      provider?: WeatherSnapshotRow["provider"];
      source_id: string;
      request_fingerprint: string;
      latitude: number;
      longitude: number;
      timezone: string;
      observed_at?: string | null;
      valid_from: string;
      valid_to: string;
      current_condition?: string | null;
      current_temperature_c?: number | null;
      max_precipitation_probability?: number | null;
      payload: Json;
      retrieved_at: string;
      expires_at: string;
      created_at?: string;
    },
    never
  >;
  traffic_snapshots: TableDefinition<
    TrafficSnapshotRow,
    {
      id?: string;
      trip_id: string;
      journey_leg_id?: string | null;
      origin_context_point_id: string;
      destination_context_point_id: string;
      provider?: TrafficSnapshotRow["provider"];
      source_id: string;
      request_fingerprint: string;
      policy_version: string;
      traffic_level: RiskLevelValue;
      center_latitude: number;
      center_longitude: number;
      radius_meters: number;
      observed_at?: string | null;
      valid_from: string;
      valid_to: string;
      payload: Json;
      retrieved_at: string;
      expires_at: string;
      created_at?: string;
    },
    never
  >;
  route_requests: TableDefinition<
    RouteRequestRow,
    {
      id?: string;
      trip_id: string;
      journey_leg_id: string;
      origin_context_point_id: string;
      destination_context_point_id: string;
      request_id: string;
      request_fingerprint: string;
      departure_at: string;
      arrival_deadline?: string | null;
      preferences: Json;
      required_facts: Json;
      modes: Json;
      status: RouteRequestRow["status"];
      error_code?: string | null;
      policy_version: string;
      weather_snapshot_id?: string | null;
      traffic_snapshot_id?: string | null;
      facts?: Json;
      limitations?: Json;
      departure_recommendation?: Json | null;
      retrieved_at: string;
      expires_at: string;
      created_at?: string;
    },
    { selected_option_id?: string | null }
  >;
  route_options: TableDefinition<
    RouteOptionRow,
    {
      id?: string;
      route_request_id: string;
      trip_id: string;
      provider: RouteOptionRow["provider"];
      provider_route_id: string;
      transport_mode: RouteOptionRow["transport_mode"];
      source_id: string;
      weather_snapshot_id?: string | null;
      traffic_snapshot_id?: string | null;
      provider_facts: Json;
      derived_metrics: Json;
      cost: Json;
      risk: Json;
      score?: Json | null;
      traffic_risk: RiskLevelValue;
      weather_risk: RiskLevelValue;
      overall_risk: RiskLevelValue;
      duration_seconds: number;
      total_duration_seconds: number;
      walking_minutes: number;
      transfer_count: number;
      departure_at: string;
      arrive_at: string;
      feasible?: boolean | null;
      rank?: number | null;
      status: RouteOptionRow["status"];
      exclusion_reasons?: Json;
      recommended?: boolean;
      policy_version: string;
      retrieved_at: string;
      expires_at: string;
      created_at?: string;
    },
    never
  >;
  recommendations: TableDefinition<
    RecommendationRow,
    {
      id?: string;
      trip_id: string;
      conversation_id?: string | null;
      context_point_id?: string | null;
      recommendation_type: RecommendationRow["recommendation_type"];
      route_request_id?: string | null;
      route_option_id?: string | null;
      context_snapshot?: Json;
      payload: Json;
      reason?: string | null;
      status?: RecommendationRow["status"];
      policy_version: string;
      created_at?: string;
      expires_at: string;
    },
    { status?: RecommendationRow["status"] }
  >;
};

export type MobilityFunctions = {
  persist_mobility_batch: {
    Args: { p_batch: Json };
    Returns: undefined;
  };
};

export type { Json, TableDefinition };
