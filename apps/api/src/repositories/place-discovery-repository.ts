import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, SourceRow } from "../supabase/database.types.js";
import type {
  PlaceDiscoveryResultRow,
  PlaceDiscoveryRunRow,
} from "../supabase/tables/mobility.types.js";
import {
  persistenceFailure,
  type SourceReferenceInsert,
} from "./mobility-repository.js";

type UserScopedClient = SupabaseClient<Database>;

export interface LoadedPlaceRun {
  run: PlaceDiscoveryRunRow;
  results: PlaceDiscoveryResultRow[];
  sources: SourceRow[];
  references: SourceReferenceInsert[];
}

export class SupabasePlaceDiscoveryRepository {
  public constructor(private readonly client: UserScopedClient) {}

  public async findFreshRun(input: {
    tripId: string;
    contextPointId: string;
    category: "activity" | "restaurant";
    fingerprint: string;
    now: string;
  }): Promise<PlaceDiscoveryRunRow | null> {
    const { data, error } = await this.client
      .from("place_discovery_runs")
      .select("*")
      .eq("trip_id", input.tripId)
      .eq("context_point_id", input.contextPointId)
      .eq("category", input.category)
      .eq("request_fingerprint", input.fingerprint)
      .in("status", ["ok", "empty"])
      .gt("expires_at", input.now)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error)
      throw persistenceFailure("place_discovery.cache_lookup", error.code);
    return data;
  }

  public async latestRun(
    tripId: string,
    contextPointId: string,
    category: "activity" | "restaurant",
  ): Promise<PlaceDiscoveryRunRow | null> {
    const { data, error } = await this.client
      .from("place_discovery_runs")
      .select("*")
      .eq("trip_id", tripId)
      .eq("context_point_id", contextPointId)
      .eq("category", category)
      .in("status", ["ok", "empty"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw persistenceFailure("place_discovery.latest", error.code);
    return data;
  }

  public async loadRun(run: PlaceDiscoveryRunRow): Promise<LoadedPlaceRun> {
    const { data: results, error: resultError } = await this.client
      .from("place_discovery_results")
      .select("*")
      .eq("trip_id", run.trip_id)
      .eq("run_id", run.id)
      .order("created_at", { ascending: true });
    if (resultError)
      throw persistenceFailure("place_discovery.results", resultError.code);

    const raw = this.client as unknown as SupabaseClient;
    const entityIds = [run.id, ...(results ?? []).map((row) => row.id)];
    const { data: references, error: referenceError } = await raw
      .from("source_references")
      .select("*")
      .eq("trip_id", run.trip_id)
      .in("entity_type", ["place_discovery_run", "place_discovery_result"])
      .in("entity_id", entityIds);
    if (referenceError) {
      throw persistenceFailure(
        "place_discovery.references",
        referenceError.code,
      );
    }
    const refs = (references ?? []) as SourceReferenceInsert[];

    const sourceIds = new Set<string>(
      (results ?? []).map((row) => row.source_id),
    );
    for (const reference of refs) sourceIds.add(reference.source_id);
    let sources: SourceRow[] = [];
    if (sourceIds.size > 0) {
      const { data, error } = await this.client
        .from("sources")
        .select("*")
        .eq("trip_id", run.trip_id)
        .in("id", [...sourceIds]);
      if (error)
        throw persistenceFailure("place_discovery.sources", error.code);
      sources = data ?? [];
    }
    return { run, results: results ?? [], sources, references: refs };
  }

  /** Booking check: the result must belong to the trip. */
  public async getResultForTrip(
    resultId: string,
    tripId: string,
  ): Promise<Pick<
    PlaceDiscoveryResultRow,
    "category" | "status" | "expires_at"
  > | null> {
    const { data, error } = await this.client
      .from("place_discovery_results")
      .select("category, status, expires_at")
      .eq("id", resultId)
      .eq("trip_id", tripId)
      .maybeSingle();
    if (error)
      throw persistenceFailure("place_discovery.get_for_booking", error.code);
    return data;
  }
}
