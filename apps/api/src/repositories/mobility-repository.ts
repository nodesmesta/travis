import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../errors.js";
import type { Database, Json, SourceRow } from "../supabase/database.types.js";
import type {
  PlaceDiscoveryResultRow,
  PlaceDiscoveryRunRow,
  RecommendationRow,
  RouteOptionRow,
  RouteRequestRow,
  TrafficSnapshotRow,
  WeatherSnapshotRow,
} from "../supabase/tables/mobility.types.js";

type UserScopedClient = SupabaseClient<Database>;

export interface SourceReferenceInsert {
  id: string;
  trip_id: string;
  source_id: string;
  entity_type: string;
  entity_id: string;
  relationship_type: string;
  created_at: string;
}

/** Complete rows for one Task 08 result. Every column is set by the caller. */
export interface MobilityBatch {
  sources?: SourceRow[];
  weather_snapshots?: WeatherSnapshotRow[];
  traffic_snapshots?: TrafficSnapshotRow[];
  place_discovery_runs?: PlaceDiscoveryRunRow[];
  place_discovery_results?: PlaceDiscoveryResultRow[];
  route_requests?: RouteRequestRow[];
  route_options?: RouteOptionRow[];
  recommendations?: RecommendationRow[];
  source_references?: SourceReferenceInsert[];
}

export function persistenceFailure(
  operation: string,
  databaseCode?: string,
): AppError {
  return new AppError(
    "PERSISTENCE_ERROR",
    "persistence",
    500,
    "Mobility data could not be saved or loaded.",
    { operation, ...(databaseCode ? { database_code: databaseCode } : {}) },
  );
}

export function jsonValue(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

function newest<T extends { created_at: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

export class SupabaseMobilityRepository {
  public constructor(private readonly client: UserScopedClient) {}

  /** Inserts the whole batch in one database transaction. */
  public async persistBatch(
    batch: MobilityBatch,
    operation: string,
  ): Promise<void> {
    const { error } = await this.client.rpc("persist_mobility_batch", {
      p_batch: jsonValue(batch),
    });
    if (error) {
      if (error.message.includes("ROUTE_LEG_NOT_IN_TRIP")) {
        throw new AppError(
          "RESOURCE_NOT_FOUND",
          "not_found",
          404,
          "Journey leg was not found.",
        );
      }
      if (error.message.includes("ROUTE_LEG_ENDPOINT_MISMATCH")) {
        throw new AppError(
          "ROUTE_LEG_MISMATCH",
          "conflict",
          409,
          "The journey leg changed while the request was running. Try again.",
        );
      }
      throw persistenceFailure(operation, error.code);
    }
  }

  // Weather ----------------------------------------------------------------

  public async findFreshWeather(
    tripId: string,
    fingerprint: string,
    now: string,
  ): Promise<WeatherSnapshotRow | null> {
    const { data, error } = await this.client
      .from("weather_snapshots")
      .select("*")
      .eq("trip_id", tripId)
      .eq("request_fingerprint", fingerprint)
      .gt("expires_at", now)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw persistenceFailure("weather.cache_lookup", error.code);
    return data;
  }

  /** Fresh snapshots only: expired rows are filtered out in the query. */
  public async listFreshWeather(
    tripId: string,
    now: string,
  ): Promise<WeatherSnapshotRow[]> {
    const { data, error } = await this.client
      .from("weather_snapshots")
      .select("*")
      .eq("trip_id", tripId)
      .gt("expires_at", now)
      .order("created_at", { ascending: false });
    if (error) throw persistenceFailure("weather.list", error.code);
    return newest(data ?? []);
  }

  public async getWeatherById(
    tripId: string,
    id: string,
  ): Promise<WeatherSnapshotRow | null> {
    const { data, error } = await this.client
      .from("weather_snapshots")
      .select("*")
      .eq("trip_id", tripId)
      .eq("id", id)
      .maybeSingle();
    if (error) throw persistenceFailure("weather.get", error.code);
    return data;
  }

  // Traffic ----------------------------------------------------------------

  public async findFreshTraffic(
    tripId: string,
    fingerprint: string,
    now: string,
  ): Promise<TrafficSnapshotRow | null> {
    const { data, error } = await this.client
      .from("traffic_snapshots")
      .select("*")
      .eq("trip_id", tripId)
      .eq("request_fingerprint", fingerprint)
      .gt("expires_at", now)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw persistenceFailure("traffic.cache_lookup", error.code);
    return data;
  }

  public async listFreshTraffic(
    tripId: string,
    now: string,
  ): Promise<TrafficSnapshotRow[]> {
    const { data, error } = await this.client
      .from("traffic_snapshots")
      .select("*")
      .eq("trip_id", tripId)
      .gt("expires_at", now)
      .order("created_at", { ascending: false });
    if (error) throw persistenceFailure("traffic.list", error.code);
    return newest(data ?? []);
  }

  public async getTrafficById(
    tripId: string,
    id: string,
  ): Promise<TrafficSnapshotRow | null> {
    const { data, error } = await this.client
      .from("traffic_snapshots")
      .select("*")
      .eq("trip_id", tripId)
      .eq("id", id)
      .maybeSingle();
    if (error) throw persistenceFailure("traffic.get", error.code);
    return data;
  }

  // Route requests ---------------------------------------------------------

  public async listRouteRequests(
    tripId: string,
    journeyLegId: string,
  ): Promise<RouteRequestRow[]> {
    const { data, error } = await this.client
      .from("route_requests")
      .select("*")
      .eq("trip_id", tripId)
      .eq("journey_leg_id", journeyLegId)
      .order("created_at", { ascending: false });
    if (error) throw persistenceFailure("route_requests.list", error.code);
    return data ?? [];
  }

  public async getRouteRequest(
    tripId: string,
    routeRequestId: string,
  ): Promise<RouteRequestRow | null> {
    const { data, error } = await this.client
      .from("route_requests")
      .select("*")
      .eq("trip_id", tripId)
      .eq("id", routeRequestId)
      .maybeSingle();
    if (error) throw persistenceFailure("route_requests.get", error.code);
    return data;
  }

  public async listRouteOptions(
    tripId: string,
    routeRequestId: string,
  ): Promise<RouteOptionRow[]> {
    const { data, error } = await this.client
      .from("route_options")
      .select("*")
      .eq("trip_id", tripId)
      .eq("route_request_id", routeRequestId);
    if (error) throw persistenceFailure("route_options.list", error.code);
    return data ?? [];
  }

  public async selectOption(
    tripId: string,
    routeRequestId: string,
    optionId: string,
  ): Promise<void> {
    const { data, error } = await this.client
      .from("route_requests")
      .update({ selected_option_id: optionId })
      .eq("trip_id", tripId)
      .eq("id", routeRequestId)
      .select("id");
    if (error) throw persistenceFailure("route_requests.select", error.code);
    if (!data || data.length !== 1) {
      throw new AppError(
        "RESOURCE_NOT_FOUND",
        "not_found",
        404,
        "Route request was not found.",
      );
    }
  }

  // Sources and recommendations -------------------------------------------

  public async getSourcesByIds(
    tripId: string,
    ids: string[],
  ): Promise<SourceRow[]> {
    if (ids.length === 0) return [];
    const { data, error } = await this.client
      .from("sources")
      .select("*")
      .eq("trip_id", tripId)
      .in("id", ids);
    if (error) throw persistenceFailure("sources.get", error.code);
    return data ?? [];
  }

  public async listRecommendations(
    tripId: string,
  ): Promise<RecommendationRow[]> {
    const { data, error } = await this.client
      .from("recommendations")
      .select("*")
      .eq("trip_id", tripId)
      .order("created_at", { ascending: false });
    if (error) throw persistenceFailure("recommendations.list", error.code);
    return data ?? [];
  }

  /** Sources attached to a set of entities through `source_references`. */
  public async listSourceReferences(
    tripId: string,
    entityType: string,
    entityIds: string[],
  ): Promise<SourceReferenceInsert[]> {
    if (entityIds.length === 0) return [];
    const raw = this.client as unknown as SupabaseClient;
    const { data, error } = await raw
      .from("source_references")
      .select("*")
      .eq("trip_id", tripId)
      .eq("entity_type", entityType)
      .in("entity_id", entityIds);
    if (error) throw persistenceFailure("source_references.list", error.code);
    return (data ?? []) as SourceReferenceInsert[];
  }
}
