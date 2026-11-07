import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AgendaInput,
  Exposure,
  LegInput,
  TrafficSnapshotInput,
  WeatherSnapshotInput,
} from "@travelflow/domain";
import type { Database } from "@travelflow/api/shared";

type Client = SupabaseClient<Database>;
type Tables = Database["public"]["Tables"];
type ContextPointRow = Tables["context_points"]["Row"];

export interface TripSummary {
  id: string;
  user_id: string;
  timezone: string;
  status: Tables["trips"]["Row"]["status"];
}

export class TripDataError extends Error {
  public readonly operation: string;

  public constructor(operation: string, databaseCode?: string) {
    super(
      `Trip data could not be read during ${operation}${databaseCode ? ` (${databaseCode})` : ""}.`,
    );
    this.name = "TripDataError";
    this.operation = operation;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function exposureOf(metadata: unknown): Exposure | null {
  const value = record(metadata).indoor_outdoor;
  return value === "indoor" ||
    value === "outdoor" ||
    value === "both" ||
    value === "unknown"
    ? value
    : null;
}

function isResolved(point: ContextPointRow | undefined): boolean {
  return (
    point !== undefined &&
    point.status === "active" &&
    point.resolution_status === "resolved" &&
    point.latitude !== null &&
    point.longitude !== null
  );
}

/** Read access to the itinerary and the stored snapshots, with the service role. */
export class TripData {
  public constructor(private readonly client: Client) {}

  /** Confirmed and active trips, optionally limited to `onlyTripIds` (WORKER_TRIP_IDS). */
  public async schedulableTrips(
    onlyTripIds: string[] = [],
  ): Promise<TripSummary[]> {
    let query = this.client
      .from("trips")
      .select("id, user_id, timezone, status")
      .in("status", ["confirmed", "active"]);
    if (onlyTripIds.length > 0) query = query.in("id", onlyTripIds);
    const { data, error } = await query;
    if (error) throw new TripDataError("trips.list", error.code);
    return data ?? [];
  }

  public async trip(tripId: string): Promise<TripSummary | null> {
    const { data, error } = await this.client
      .from("trips")
      .select("id, user_id, timezone, status")
      .eq("id", tripId)
      .maybeSingle();
    if (error) throw new TripDataError("trips.get", error.code);
    return data;
  }

  private async points(tripId: string): Promise<Map<string, ContextPointRow>> {
    const { data, error } = await this.client
      .from("context_points")
      .select("*")
      .eq("trip_id", tripId);
    if (error) throw new TripDataError("context_points.list", error.code);
    return new Map((data ?? []).map((row) => [row.id, row]));
  }

  public async legs(tripId: string, onlyId?: string): Promise<LegInput[]> {
    let query = this.client
      .from("journey_legs")
      .select("*")
      .eq("trip_id", tripId);
    if (onlyId) query = query.eq("id", onlyId);
    const { data, error } = await query;
    if (error) throw new TripDataError("journey_legs.list", error.code);
    const points = await this.points(tripId);
    const result: LegInput[] = [];
    for (const leg of data ?? []) {
      const origin = points.get(leg.origin_context_point_id);
      const destination = points.get(leg.destination_context_point_id);
      if (!origin || !destination) continue;
      result.push({
        id: leg.id,
        trip_id: leg.trip_id,
        status: leg.status,
        departure_at: leg.departure_at,
        arrival_deadline: leg.arrival_deadline,
        origin_context_point_id: origin.id,
        destination_context_point_id: destination.id,
        origin_label: origin.label,
        destination_label: destination.label,
        timezone: origin.timezone,
        origin_resolved: isResolved(origin),
        destination_resolved: isResolved(destination),
      });
    }
    return result;
  }

  /** Agenda items with the exposure recorded in their metadata, optionally for one context point. */
  public async agenda(
    tripId: string,
    contextPointId?: string,
  ): Promise<AgendaInput[]> {
    let query = this.client
      .from("agenda_items")
      .select("*")
      .eq("trip_id", tripId);
    if (contextPointId) query = query.eq("context_point_id", contextPointId);
    const { data, error } = await query;
    if (error) throw new TripDataError("agenda_items.list", error.code);
    const points = await this.points(tripId);
    return (data ?? []).map((item) => {
      const point = item.context_point_id
        ? points.get(item.context_point_id)
        : undefined;
      return {
        id: item.id,
        trip_id: item.trip_id,
        title: item.title,
        status: item.status,
        start_at: item.start_at,
        end_at: item.end_at,
        timezone: item.timezone,
        context_point_id: item.context_point_id,
        context_label: point?.label ?? null,
        context_resolved: isResolved(point),
        exposure: exposureOf(item.metadata),
      };
    });
  }

  /** Newest stored traffic snapshot for the pair, expired or not. The rule decides what expired means. */
  public async latestTraffic(
    tripId: string,
    originId: string,
    destinationId: string,
  ): Promise<TrafficSnapshotInput | null> {
    const { data, error } = await this.client
      .from("traffic_snapshots")
      .select("*")
      .eq("trip_id", tripId)
      .eq("origin_context_point_id", originId)
      .eq("destination_context_point_id", destinationId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new TripDataError("traffic_snapshots.latest", error.code);
    if (!data) return null;
    const summary = record(record(data.payload).summary);
    const number = (value: unknown): number | null =>
      typeof value === "number" && Number.isFinite(value) ? value : null;
    return {
      id: data.id,
      source_id: data.source_id,
      provider: data.provider,
      traffic_level: data.traffic_level,
      average_jam_factor: number(summary.average_jam_factor),
      max_jam_factor: number(summary.max_jam_factor),
      closed_segment_count: number(summary.closed_segment_count) ?? 0,
      incident_count: number(summary.incident_count) ?? 0,
      segment_count: number(summary.segment_count) ?? 0,
      retrieved_at: data.retrieved_at,
      expires_at: data.expires_at,
    };
  }

  public async latestWeather(
    tripId: string,
    contextPointId: string,
  ): Promise<WeatherSnapshotInput | null> {
    const { data, error } = await this.client
      .from("weather_snapshots")
      .select("*")
      .eq("trip_id", tripId)
      .eq("context_point_id", contextPointId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new TripDataError("weather_snapshots.latest", error.code);
    if (!data) return null;
    const payload = record(data.payload);
    return {
      id: data.id,
      source_id: data.source_id,
      provider: data.provider,
      context_point_id: data.context_point_id,
      timezone: data.timezone,
      observed_at: data.observed_at,
      current: (payload.current ?? null) as WeatherSnapshotInput["current"],
      hourly: list(payload.hourly) as WeatherSnapshotInput["hourly"],
      daily: list(payload.daily) as WeatherSnapshotInput["daily"],
      retrieved_at: data.retrieved_at,
      expires_at: data.expires_at,
    };
  }

  /** Provider request ids kept in the audit metadata of a source. */
  public async providerRequestIds(sourceId: string): Promise<string[]> {
    const { data, error } = await this.client
      .from("sources")
      .select("metadata")
      .eq("id", sourceId)
      .maybeSingle();
    if (error) throw new TripDataError("sources.get", error.code);
    const metadata = record(data?.metadata);
    const ids: string[] = [];
    if (typeof metadata.provider_request_id === "string") {
      ids.push(metadata.provider_request_id);
    }
    for (const entry of list(metadata.provider_request_ids)) {
      if (typeof entry === "string") ids.push(entry);
    }
    return ids;
  }
}
