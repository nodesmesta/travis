import type {
  NormalizedEventDiscovery,
  NormalizedEventItem,
  NormalizedEventSource,
} from "@travelflow/integrations";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../errors.js";
import type {
  Database,
  EventDiscoveryResultRow,
  EventDiscoveryRunRow,
  Json,
  SourceReferenceRow,
  SourceRow,
} from "../supabase/database.types.js";

type UserScopedClient = SupabaseClient<Database>;

export interface EventDiscoveryResponse {
  request_id: string;
  trip_id: string;
  context_point_id: string;
  items: Array<{
    id: string;
    trip_id: string;
    context_point_id: string;
    title: string;
    description?: string;
    venue_name?: string;
    starts_at: string;
    ends_at?: string;
    category?: string;
    status: "suggested" | "selected" | "rejected" | "expired";
    source_ids: string[];
  }>;
  sources: Array<{
    id: string;
    kind: SourceRow["kind"];
    provider: string;
    url?: string;
    title?: string;
    retrieved_at: string;
    freshness: SourceRow["freshness"];
    expires_at?: string;
    observed_for?: Record<string, unknown>;
  }>;
  retrieved_at: string;
  freshness: "fresh" | "expired" | "unavailable";
  expires_at: string;
  limitations: string[];
}

function persistenceFailure(operation: string): AppError {
  return new AppError(
    "PERSISTENCE_ERROR",
    "persistence",
    500,
    "Event discovery persistence failed.",
    { operation },
  );
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function jsonValue(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

function sourceResponse(
  row: SourceRow,
): EventDiscoveryResponse["sources"][number] {
  const observedFor = jsonObject(row.observed_for);
  return {
    id: row.id,
    kind: row.kind,
    provider: row.provider,
    ...(row.url ? { url: row.url } : {}),
    ...(row.title ? { title: row.title } : {}),
    retrieved_at: row.retrieved_at,
    freshness: row.freshness,
    ...(row.expires_at ? { expires_at: row.expires_at } : {}),
    ...(Object.keys(observedFor).length > 0
      ? { observed_for: observedFor }
      : {}),
  };
}

export class SupabaseEventDiscoveryRepository {
  public constructor(private readonly client: UserScopedClient) {}

  public async findFreshSnapshot(input: {
    tripId: string;
    contextPointId: string;
    fingerprint: string;
    now: string;
  }): Promise<EventDiscoveryResponse | null> {
    const { data: run, error: runError } = await this.client
      .from("event_discovery_runs")
      .select("*")
      .eq("trip_id", input.tripId)
      .eq("context_point_id", input.contextPointId)
      .eq("request_fingerprint", input.fingerprint)
      .in("status", ["ok", "empty"])
      .gt("expires_at", input.now)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (runError) throw persistenceFailure("event_discovery.cache_lookup");
    return run ? this.loadResponse(run) : null;
  }

  public async persistSnapshot(input: {
    query: {
      requestId: string;
      tripId: string;
      contextPointId: string;
      fingerprint: string;
      category: string;
      observedFrom: string;
      observedTo: string;
      timezone: string;
    };
    normalized: NormalizedEventDiscovery;
  }): Promise<EventDiscoveryResponse> {
    const { query, normalized } = input;
    const { data: run, error: runError } = await this.client
      .from("event_discovery_runs")
      .insert({
        trip_id: query.tripId,
        context_point_id: query.contextPointId,
        request_id: query.requestId,
        request_fingerprint: query.fingerprint,
        category: query.category,
        observed_from: query.observedFrom,
        observed_to: query.observedTo,
        timezone: query.timezone,
        status: normalized.status,
        retrieved_at: normalized.retrievedAt,
        expires_at: normalized.expiresAt,
        metadata: jsonValue({
          limitations: normalized.limitations,
          search_url: normalized.searchUrl,
        }),
      })
      .select("*")
      .single();
    if (runError || !run)
      throw persistenceFailure("event_discovery.run_create");

    const sourceRows = normalized.sources.map((source) => ({
      trip_id: query.tripId,
      kind: source.kind,
      provider: source.provider,
      url: source.url,
      title: source.title,
      retrieved_at: normalized.retrievedAt,
      freshness: normalized.freshness,
      expires_at: normalized.expiresAt,
      observed_for: jsonValue({
        from: query.observedFrom,
        to: query.observedTo,
        timezone: query.timezone,
      }),
      content_hash: null,
      metadata: jsonValue({ source_key: source.sourceKey }),
    }));
    const { data: sources, error: sourceError } = await this.client
      .from("sources")
      .insert(sourceRows)
      .select("*");
    if (sourceError || !sources) {
      throw persistenceFailure("event_discovery.sources_create");
    }
    const sourceByKey = new Map<string, SourceRow>();
    for (const source of sources) {
      const key = jsonObject(source.metadata).source_key;
      if (typeof key === "string") sourceByKey.set(key, source);
    }

    const runReferences = sources.map((source) => ({
      trip_id: query.tripId,
      source_id: source.id,
      entity_type: "event_discovery_run" as const,
      entity_id: run.id,
      relationship_type: "provider_result",
    }));
    const { error: runReferenceError } = await this.client
      .from("source_references")
      .insert(runReferences);
    if (runReferenceError) {
      throw persistenceFailure("event_discovery.run_source_references");
    }

    if (normalized.items.length > 0) {
      const eventRows = normalized.items.map((item) => {
        const primarySourceKey = item.sourceKeys[0];
        const source = primarySourceKey
          ? sourceByKey.get(primarySourceKey)
          : undefined;
        if (!source) throw persistenceFailure("event_discovery.source_mapping");
        return {
          run_id: run.id,
          trip_id: query.tripId,
          context_point_id: query.contextPointId,
          source_id: source.id,
          title: item.title,
          description: item.description ?? null,
          venue_name: item.venueName ?? null,
          starts_at: item.startsAt,
          ends_at: item.endsAt ?? null,
          category: item.category ?? null,
          status: "suggested" as const,
          retrieved_at: normalized.retrievedAt,
          expires_at: normalized.expiresAt,
          metadata: jsonValue({
            dedupe_key: item.dedupeKey,
            source_keys: item.sourceKeys,
            source_url: item.sourceUrl,
          }),
        };
      });
      const { data: events, error: eventError } = await this.client
        .from("event_discovery_results")
        .insert(eventRows)
        .select("*");
      if (eventError || !events) {
        throw persistenceFailure("event_discovery.events_create");
      }
      const references: Array<{
        trip_id: string;
        source_id: string;
        entity_type: "event_discovery_result";
        entity_id: string;
        relationship_type: string;
      }> = [];
      for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        if (!event) continue;
        const item = normalized.items[index];
        if (!item) continue;
        for (const sourceKey of item.sourceKeys.slice(1)) {
          const source = sourceByKey.get(sourceKey);
          if (source) {
            references.push({
              trip_id: query.tripId,
              source_id: source.id,
              entity_type: "event_discovery_result",
              entity_id: event.id,
              relationship_type: "event_evidence",
            });
          }
        }
      }
      if (references.length > 0) {
        const { error: referenceError } = await this.client
          .from("source_references")
          .insert(references);
        if (referenceError) {
          throw persistenceFailure("event_discovery.event_source_references");
        }
      }
    }

    return this.loadResponse(run);
  }

  public async listLatest(
    tripId: string,
    contextPointId: string,
  ): Promise<EventDiscoveryResponse | null> {
    const { data: run, error } = await this.client
      .from("event_discovery_runs")
      .select("*")
      .eq("trip_id", tripId)
      .eq("context_point_id", contextPointId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw persistenceFailure("event_discovery.latest_lookup");
    return run ? this.loadResponse(run) : null;
  }

  private async loadResponse(
    run: EventDiscoveryRunRow,
  ): Promise<EventDiscoveryResponse> {
    const { data: events, error: eventError } = await this.client
      .from("event_discovery_results")
      .select("*")
      .eq("run_id", run.id)
      .order("starts_at", { ascending: true });
    if (eventError) throw persistenceFailure("event_discovery.events_lookup");

    const eventIds = (events ?? []).map((event) => event.id);
    const { data: references, error: referenceError } = await this.client
      .from("source_references")
      .select("*")
      .eq("trip_id", run.trip_id)
      .in("entity_type", ["event_discovery_run", "event_discovery_result"])
      .in("entity_id", [run.id, ...eventIds]);
    if (referenceError)
      throw persistenceFailure("event_discovery.references_lookup");

    const sourceIds = new Set<string>(
      (events ?? []).map((event) => event.source_id),
    );
    for (const reference of references ?? [])
      sourceIds.add(reference.source_id);
    const { data: sources, error: sourceError } = await this.client
      .from("sources")
      .select("*")
      .eq("trip_id", run.trip_id)
      .in("id", [...sourceIds]);
    if (sourceError) throw persistenceFailure("event_discovery.sources_lookup");
    const sourcesById = new Map(
      (sources ?? []).map((source) => [source.id, source]),
    );
    const refsByEntity = new Map<string, SourceReferenceRow[]>();
    for (const reference of references ?? []) {
      const current = refsByEntity.get(reference.entity_id) ?? [];
      current.push(reference);
      refsByEntity.set(reference.entity_id, current);
    }

    return {
      request_id: run.request_id,
      trip_id: run.trip_id,
      context_point_id: run.context_point_id,
      items: (events ?? []).map((event) => {
        const sourceIdsForEvent = [
          event.source_id,
          ...(refsByEntity.get(event.id) ?? []).map(
            (reference) => reference.source_id,
          ),
        ];
        return {
          id: event.id,
          trip_id: event.trip_id,
          context_point_id: event.context_point_id,
          title: event.title,
          ...(event.description ? { description: event.description } : {}),
          ...(event.venue_name ? { venue_name: event.venue_name } : {}),
          starts_at: event.starts_at,
          ...(event.ends_at ? { ends_at: event.ends_at } : {}),
          ...(event.category ? { category: event.category } : {}),
          status: event.status,
          source_ids: [...new Set(sourceIdsForEvent)],
        };
      }),
      sources: [...sourcesById.values()].map(sourceResponse),
      retrieved_at: run.retrieved_at,
      freshness: Date.parse(run.expires_at) > Date.now() ? "fresh" : "expired",
      expires_at: run.expires_at,
      limitations: Array.isArray(jsonObject(run.metadata).limitations)
        ? (jsonObject(run.metadata).limitations as string[])
        : [],
    };
  }
}
