import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../errors.js";
import type { Database } from "../supabase/database.types.js";

/**
 * Recommendations are created by Task 08 (migration 0007). Task 09 only reads
 * them and changes their status after a confirmed user action, so this
 * repository talks to the table through an untyped client and declares the
 * columns it relies on (Segment 07, `recommendations`).
 */
export interface RecommendationRecord {
  id: string;
  trip_id: string;
  conversation_id: string | null;
  context_point_id: string | null;
  recommendation_type: string;
  route_request_id?: string | null;
  route_option_id?: string | null;
  policy_version?: string;
  context_snapshot: Record<string, unknown>;
  payload: Record<string, unknown>;
  reason: string | null;
  created_at: string;
  expires_at: string | null;
  status: string;
}

/** What a route recommendation turns into when it is added to the itinerary. */
export interface RouteItinerarySource {
  routeRequestId: string;
  routeOptionId: string;
  journeyLegId: string | null;
  transportMode: string;
  departureAt: string;
  arriveAt: string;
  originLabel: string;
  destinationLabel: string;
  destinationContextPointId: string;
  timezone: string;
}

export const RECOMMENDATION_STATUS_AFTER = {
  save_recommendation: "saved",
  apply_recommendation: "applied",
  dismiss_recommendation: "dismissed",
} as const;

/** Statuses from which no further action is possible. */
export const RECOMMENDATION_FINAL_STATUSES = [
  "dismissed",
  "applied",
  "expired",
] as const;

function persistenceFailure(operation: string, code?: string): AppError {
  return new AppError(
    "PERSISTENCE_ERROR",
    "persistence",
    500,
    "Recommendations could not be loaded or changed.",
    { operation, ...(code ? { database_code: code } : {}) },
  );
}

function unavailable(): AppError {
  return new AppError(
    "RECOMMENDATIONS_UNAVAILABLE",
    "internal",
    503,
    "Recommendations are not available in this environment yet.",
  );
}

function isMissingTable(code: string | undefined): boolean {
  // PGRST205: table not in the API schema cache. 42P01: undefined_table.
  return code === "PGRST205" || code === "42P01";
}

export class SupabaseRecommendationRepository {
  private readonly client: SupabaseClient;

  public constructor(client: SupabaseClient<Database>) {
    this.client = client as unknown as SupabaseClient;
  }

  public async list(
    tripId: string,
    limit = 20,
  ): Promise<RecommendationRecord[]> {
    const { data, error } = await this.client
      .from("recommendations")
      .select("*")
      .eq("trip_id", tripId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) {
      if (isMissingTable(error.code)) throw unavailable();
      throw persistenceFailure("recommendation.list", error.code);
    }
    return (data ?? []) as RecommendationRecord[];
  }

  public async get(
    tripId: string,
    recommendationId: string,
  ): Promise<RecommendationRecord | null> {
    const { data, error } = await this.client
      .from("recommendations")
      .select("*")
      .eq("trip_id", tripId)
      .eq("id", recommendationId)
      .maybeSingle();
    if (error) {
      if (isMissingTable(error.code)) throw unavailable();
      throw persistenceFailure("recommendation.get", error.code);
    }
    return (data as RecommendationRecord | null) ?? null;
  }

  /**
   * Reads the stored route option behind a route recommendation (Task 08 tables
   * route_options, route_requests, context_points). Only a still valid option
   * can be added to the itinerary.
   */
  public async routeItinerarySource(
    recommendation: RecommendationRecord,
  ): Promise<RouteItinerarySource | null> {
    const optionId = (recommendation as { route_option_id?: string | null })
      .route_option_id;
    const requestId = (recommendation as { route_request_id?: string | null })
      .route_request_id;
    if (!optionId || !requestId) return null;
    const { data: option, error: optionError } = await this.client
      .from("route_options")
      .select(
        "id, route_request_id, transport_mode, departure_at, arrive_at, status, expires_at",
      )
      .eq("trip_id", recommendation.trip_id)
      .eq("id", optionId)
      .maybeSingle();
    if (optionError) {
      if (isMissingTable(optionError.code)) throw unavailable();
      throw persistenceFailure("route_option.get", optionError.code);
    }
    if (!option) return null;
    const { data: routeRequest, error: requestError } = await this.client
      .from("route_requests")
      .select(
        "id, journey_leg_id, origin_context_point_id, destination_context_point_id",
      )
      .eq("trip_id", recommendation.trip_id)
      .eq("id", requestId)
      .maybeSingle();
    if (requestError)
      throw persistenceFailure("route_request.get", requestError.code);
    if (!routeRequest) return null;
    const { data: points, error: pointError } = await this.client
      .from("context_points")
      .select("id, label, timezone")
      .eq("trip_id", recommendation.trip_id)
      .in("id", [
        routeRequest.origin_context_point_id,
        routeRequest.destination_context_point_id,
      ]);
    if (pointError)
      throw persistenceFailure("context_point.list", pointError.code);
    const origin = (points ?? []).find(
      (point) => point.id === routeRequest.origin_context_point_id,
    );
    const destination = (points ?? []).find(
      (point) => point.id === routeRequest.destination_context_point_id,
    );
    if (!origin || !destination) return null;
    if (
      option.status !== "valid" ||
      Date.parse(option.expires_at) <= Date.now()
    ) {
      return null;
    }
    return {
      routeRequestId: routeRequest.id,
      routeOptionId: option.id,
      journeyLegId: routeRequest.journey_leg_id ?? null,
      transportMode: option.transport_mode,
      departureAt: option.departure_at,
      arriveAt: option.arrive_at,
      originLabel: origin.label,
      destinationLabel: destination.label,
      destinationContextPointId: destination.id,
      timezone: origin.timezone,
    };
  }

  /** Changes the status only while the recommendation still has the expected one. */
  public async transition(
    tripId: string,
    recommendationId: string,
    expectedStatus: string,
    nextStatus: string,
  ): Promise<RecommendationRecord | null> {
    const { data, error } = await this.client
      .from("recommendations")
      .update({ status: nextStatus })
      .eq("trip_id", tripId)
      .eq("id", recommendationId)
      .eq("status", expectedStatus)
      .select("*")
      .maybeSingle();
    if (error) {
      if (isMissingTable(error.code)) throw unavailable();
      throw persistenceFailure("recommendation.transition", error.code);
    }
    return (data as RecommendationRecord | null) ?? null;
  }
}
