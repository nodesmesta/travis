import type { SourceRow } from "../supabase/database.types.js";
import type {
  RecommendationRow,
  RouteOptionRow,
  RouteRequestRow,
  TrafficSnapshotRow,
  WeatherSnapshotRow,
} from "../supabase/tables/mobility.types.js";

/**
 * Row to API shape. Everything the frontend or the assistant sees passes
 * through here, so provider payloads and database-only columns do not leak.
 * Freshness is decided from `expires_at` and the current time on every read;
 * a stored "valid" option past its expiry is reported as expired.
 */

type Freshness = "fresh" | "expired";

export function freshnessAt(expiresAt: string, now: Date): Freshness {
  return Date.parse(expiresAt) > now.getTime() ? "fresh" : "expired";
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function sourceDto(row: SourceRow, now: Date): Record<string, unknown> {
  const observed = record(row.observed_for);
  const observedFor: Record<string, unknown> = {};
  if (typeof observed.from === "string") observedFor.from = observed.from;
  if (typeof observed.to === "string") observedFor.to = observed.to;
  if (typeof observed.timezone === "string")
    observedFor.timezone = observed.timezone;
  return {
    id: row.id,
    kind: row.kind,
    provider: row.provider,
    ...(row.url ? { url: row.url } : {}),
    ...(row.title ? { title: row.title } : {}),
    retrieved_at: row.retrieved_at,
    freshness: row.expires_at
      ? freshnessAt(row.expires_at, now)
      : row.freshness,
    ...(row.expires_at ? { expires_at: row.expires_at } : {}),
    ...(Object.keys(observedFor).length > 0
      ? { observed_for: observedFor }
      : {}),
  };
}

export function routeRequestDto(
  row: RouteRequestRow,
  now: Date,
): Record<string, unknown> {
  return {
    id: row.id,
    trip_id: row.trip_id,
    journey_leg_id: row.journey_leg_id,
    origin_context_point_id: row.origin_context_point_id,
    destination_context_point_id: row.destination_context_point_id,
    departure_at: row.departure_at,
    arrival_deadline: row.arrival_deadline,
    preferences: row.preferences,
    required_facts: row.required_facts,
    modes: row.modes,
    status: row.status,
    error_code: row.error_code,
    policy_version: row.policy_version,
    selected_option_id: row.selected_option_id,
    retrieved_at: row.retrieved_at,
    expires_at: row.expires_at,
    freshness: freshnessAt(row.expires_at, now),
    created_at: row.created_at,
  };
}

export function routeOptionDto(
  row: RouteOptionRow,
  request: RouteRequestRow,
  now: Date,
  /** Source ids of the weather and traffic snapshots this option was judged with. */
  snapshotSourceIds: { weather: string | null; traffic: string | null },
): Record<string, unknown> {
  const freshness = freshnessAt(row.expires_at, now);
  const expired = freshness === "expired";
  const sourceIds = [
    row.source_id,
    ...(row.weather_snapshot_id && snapshotSourceIds.weather
      ? [snapshotSourceIds.weather]
      : []),
    ...(row.traffic_snapshot_id && snapshotSourceIds.traffic
      ? [snapshotSourceIds.traffic]
      : []),
  ];
  const score = row.score ? record(row.score) : null;
  return {
    id: row.id,
    route_request_id: row.route_request_id,
    provider: row.provider,
    provider_route_id: row.provider_route_id,
    transport_mode: row.transport_mode,
    provider_facts: row.provider_facts,
    derived_metrics: row.derived_metrics,
    cost: row.cost,
    risk: row.risk,
    score: score ? { ...score, rank: row.rank } : null,
    status: expired && row.status === "valid" ? "expired" : row.status,
    exclusion_reasons: row.exclusion_reasons,
    recommended: row.recommended && !expired,
    selected: request.selected_option_id === row.id,
    policy_version: row.policy_version,
    source_ids: [...new Set(sourceIds)],
    retrieved_at: row.retrieved_at,
    expires_at: row.expires_at,
    freshness,
  };
}

export function weatherDto(
  row: WeatherSnapshotRow,
  now: Date,
  cacheStatus?: "hit" | "miss",
): Record<string, unknown> {
  const payload = record(row.payload);
  return {
    id: row.id,
    trip_id: row.trip_id,
    context_point_id: row.context_point_id,
    provider: row.provider,
    source_id: row.source_id,
    timezone: row.timezone,
    observed_at: row.observed_at,
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    retrieved_at: row.retrieved_at,
    expires_at: row.expires_at,
    freshness: freshnessAt(row.expires_at, now),
    ...(cacheStatus ? { cache_status: cacheStatus } : {}),
    current: payload.current ?? null,
    hourly: list(payload.hourly),
    daily: list(payload.daily),
    alerts: list(payload.alerts),
    forecast_interval_minutes: payload.forecast_interval_minutes ?? null,
    forecast_ends_at: payload.forecast_ends_at ?? null,
  };
}

export function trafficDto(
  row: TrafficSnapshotRow,
  now: Date,
  cacheStatus?: "hit" | "miss",
): Record<string, unknown> {
  const payload = record(row.payload);
  return {
    id: row.id,
    trip_id: row.trip_id,
    journey_leg_id: row.journey_leg_id,
    origin_context_point_id: row.origin_context_point_id,
    destination_context_point_id: row.destination_context_point_id,
    provider: row.provider,
    source_id: row.source_id,
    policy_version: row.policy_version,
    traffic_level: row.traffic_level,
    observed_at: row.observed_at,
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    retrieved_at: row.retrieved_at,
    expires_at: row.expires_at,
    freshness: freshnessAt(row.expires_at, now),
    ...(cacheStatus ? { cache_status: cacheStatus } : {}),
    area: {
      latitude: row.center_latitude,
      longitude: row.center_longitude,
      radius_meters: row.radius_meters,
    },
    summary: record(payload.summary),
    incidents: list(payload.incidents),
  };
}

export function recommendationDto(
  row: RecommendationRow,
  sourceIds: string[],
  now: Date,
): Record<string, unknown> {
  const expired = freshnessAt(row.expires_at, now) === "expired";
  return {
    id: row.id,
    trip_id: row.trip_id,
    conversation_id: row.conversation_id,
    context_point_id: row.context_point_id,
    recommendation_type: row.recommendation_type,
    route_request_id: row.route_request_id,
    route_option_id: row.route_option_id,
    status: expired && row.status === "suggested" ? "expired" : row.status,
    reason: row.reason,
    payload: row.payload,
    context_snapshot: row.context_snapshot,
    policy_version: row.policy_version,
    source_ids: sourceIds,
    created_at: row.created_at,
    expires_at: row.expires_at,
    freshness: expired ? "expired" : "fresh",
  };
}
