import { randomUUID } from "node:crypto";
import {
  ExternalDataError,
  buildActivityDiscoveryQuery,
  normalizeHereRestaurants,
  restaurantFingerprint,
  HERE_RESTAURANT_CATEGORY,
  type ActivityDiscoveryPipeline,
  type HereClient,
  type NormalizedActivityDiscovery,
  type RestaurantQuery,
} from "@travelflow/integrations";
import type { ContextPointRecord } from "@travelflow/domain";
import { AppError } from "../errors.js";
import {
  jsonValue,
  type MobilityBatch,
  type SourceReferenceInsert,
  SupabaseMobilityRepository,
} from "../repositories/mobility-repository.js";
import type {
  LoadedPlaceRun,
  SupabasePlaceDiscoveryRepository,
} from "../repositories/place-discovery-repository.js";
import type { SupabaseTripContextRepository } from "../repositories/trip-context-repository.js";
import type { SourceRow } from "../supabase/database.types.js";
import type {
  PlaceDiscoveryResultRow,
  PlaceDiscoveryRunRow,
} from "../supabase/tables/mobility.types.js";
import { freshnessAt, sourceDto } from "./mobility-serializers.js";

export type PlaceCategoryName = "activity" | "restaurant";

export interface DiscoverPlacesInput {
  requestId: string;
  executionId: string;
  userId: string;
  tripId: string;
  contextPointId: string;
  category: PlaceCategoryName;
  radiusMeters?: number;
  language?: string;
}

const DEFAULT_RADIUS_METERS = 1000;
const MAX_RADIUS_METERS = 5000;
const RESTAURANT_LIMIT = 20;

function notFound(message: string): AppError {
  return new AppError("RESOURCE_NOT_FOUND", "not_found", 404, message);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export class PlaceDiscoveryService {
  public constructor(
    private readonly trips: SupabaseTripContextRepository,
    private readonly places: SupabasePlaceDiscoveryRepository,
    private readonly mobility: SupabaseMobilityRepository,
    private readonly here: HereClient,
    private readonly activityPipeline: ActivityDiscoveryPipeline,
    private readonly ttl: { activityHours: number; restaurantHours: number },
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async requireContext(
    tripId: string,
    userId: string,
    contextPointId: string,
  ): Promise<{
    point: ContextPointRecord & { latitude: number; longitude: number };
    destination: string | null;
  }> {
    const trip = await this.trips.getTripRowForUser(tripId, userId);
    if (!trip) throw notFound("Trip was not found.");
    const point = await this.trips.getContextPoint(contextPointId);
    if (!point || point.tripId !== tripId)
      throw notFound("Context point was not found.");
    if (
      point.status !== "active" ||
      point.resolutionStatus !== "resolved" ||
      point.latitude === null ||
      point.longitude === null
    ) {
      throw new AppError(
        "EXTERNAL_CONTEXT_UNRESOLVED",
        "validation",
        422,
        "Place discovery requires an active, resolved context point.",
      );
    }
    return {
      point: point as ContextPointRecord & {
        latitude: number;
        longitude: number;
      },
      destination: trip.destination_summary,
    };
  }

  public async discover(
    input: DiscoverPlacesInput,
  ): Promise<Record<string, unknown>> {
    const { point, destination } = await this.requireContext(
      input.tripId,
      input.userId,
      input.contextPointId,
    );
    return input.category === "activity"
      ? this.discoverActivities(input, point, destination)
      : this.discoverRestaurants(input, point);
  }

  public async latest(input: {
    tripId: string;
    userId: string;
    contextPointId: string;
    category: PlaceCategoryName;
    requestId: string;
  }): Promise<Record<string, unknown>> {
    await this.requireContext(input.tripId, input.userId, input.contextPointId);
    const run = await this.places.latestRun(
      input.tripId,
      input.contextPointId,
      input.category,
    );
    if (!run)
      throw notFound("No place discovery was found for this context point.");
    if (freshnessAt(run.expires_at, this.now()) === "expired") {
      throw new AppError(
        "PLACE_DISCOVERY_EXPIRED",
        "provider",
        410,
        "The latest place discovery has expired. Run a new discovery.",
      );
    }
    return this.response(
      await this.places.loadRun(run),
      input.requestId,
      "hit",
    );
  }

  // -------------------------------------------------------------------------

  private async discoverActivities(
    input: DiscoverPlacesInput,
    point: ContextPointRecord & { latitude: number; longitude: number },
    destination: string | null,
  ): Promise<Record<string, unknown>> {
    const query = buildActivityDiscoveryQuery({
      requestId: input.requestId,
      executionId: input.executionId,
      tripId: input.tripId,
      contextPointId: point.id,
      contextLabel: point.label,
      contextAddress: point.address,
      destination,
      contextLatitude: point.latitude,
      contextLongitude: point.longitude,
      ...(input.language ? { language: input.language } : {}),
    });
    const now = this.now();
    const cached = await this.places.findFreshRun({
      tripId: input.tripId,
      contextPointId: point.id,
      category: "activity",
      fingerprint: query.fingerprint,
      now: now.toISOString(),
    });
    if (cached)
      return this.response(
        await this.places.loadRun(cached),
        input.requestId,
        "hit",
      );

    let normalized: NormalizedActivityDiscovery;
    try {
      normalized = await this.activityPipeline.run(
        query,
        now.toISOString(),
        this.ttl.activityHours,
      );
    } catch (error) {
      await this.recordFailure(
        input,
        point,
        "activity",
        query.fingerprint,
        "bright_data",
        error,
      );
      throw error;
    }

    const retrievedAt = normalized.retrievedAt;
    const expiresAt = normalized.expiresAt;
    const runId = randomUUID();
    const sourceRows: SourceRow[] = [];
    const sourceIdByKey = new Map<string, string>();
    for (const source of normalized.sources) {
      const id = randomUUID();
      sourceIdByKey.set(source.sourceKey, id);
      sourceRows.push({
        id,
        trip_id: input.tripId,
        kind: source.kind,
        provider: source.provider,
        url: source.url,
        title: source.title.slice(0, 300),
        retrieved_at: retrievedAt,
        freshness: "fresh",
        expires_at: expiresAt,
        observed_for: null,
        content_hash: null,
        metadata: jsonValue({ source_key: source.sourceKey }),
        created_at: retrievedAt,
      });
    }
    const results: PlaceDiscoveryResultRow[] = [];
    const references: SourceReferenceInsert[] = [];
    const reference = (
      sourceId: string,
      type: string,
      entityId: string,
      relationship: string,
    ): void => {
      references.push({
        id: randomUUID(),
        trip_id: input.tripId,
        source_id: sourceId,
        entity_type: type,
        entity_id: entityId,
        relationship_type: relationship,
        created_at: retrievedAt,
      });
    };
    for (const item of normalized.items) {
      const primary = item.sourceKeys[0]
        ? sourceIdByKey.get(item.sourceKeys[0])
        : undefined;
      // An item without a stored source is never saved.
      if (!primary) {
        throw new AppError(
          "PLACE_SOURCE_MISSING",
          "provider",
          502,
          "A discovered activity had no source and was rejected.",
        );
      }
      const id = randomUUID();
      results.push({
        id,
        run_id: runId,
        trip_id: input.tripId,
        context_point_id: point.id,
        source_id: primary,
        category: "activity",
        name: item.name,
        description: item.description,
        address: item.address,
        latitude: item.latitude,
        longitude: item.longitude,
        distance_meters: item.distanceMeters,
        official_url: item.officialUrl,
        provider_place_id: null,
        activity_type: item.activityType,
        indoor_outdoor: item.indoorOutdoor,
        recommended_duration_minutes: item.recommendedDurationMinutes,
        weather_sensitivity: item.weatherSensitivity,
        booking_required: item.bookingRequired,
        cuisines: [],
        opening_hours: item.openingHoursText
          ? { text: item.openingHoursText }
          : null,
        evidence: item.evidence,
        status: "suggested",
        retrieved_at: retrievedAt,
        expires_at: expiresAt,
        metadata: jsonValue({
          dedupe_key: item.dedupeKey,
          source_keys: item.sourceKeys,
          source_url: item.sourceUrl,
        }),
        created_at: retrievedAt,
      });
      for (const key of item.sourceKeys.slice(1)) {
        const extra = sourceIdByKey.get(key);
        if (extra)
          reference(extra, "place_discovery_result", id, "place_evidence");
      }
    }
    for (const row of sourceRows)
      reference(row.id, "place_discovery_run", runId, "provider_result");

    const run: PlaceDiscoveryRunRow = {
      id: runId,
      trip_id: input.tripId,
      context_point_id: point.id,
      category: "activity",
      request_id: input.requestId,
      request_fingerprint: query.fingerprint,
      provider: "bright_data",
      status: normalized.status,
      retrieved_at: retrievedAt,
      expires_at: expiresAt,
      error_code: null,
      metadata: jsonValue({
        limitations: normalized.limitations,
        search_url: normalized.searchUrl,
      }),
      created_at: retrievedAt,
    };
    await this.mobility.persistBatch(
      {
        sources: sourceRows,
        place_discovery_runs: [run],
        place_discovery_results: results,
        source_references: references,
      },
      "place_discovery.persist",
    );
    return this.response(
      { run, results, sources: sourceRows, references },
      input.requestId,
      "miss",
    );
  }

  private async discoverRestaurants(
    input: DiscoverPlacesInput,
    point: ContextPointRecord & { latitude: number; longitude: number },
  ): Promise<Record<string, unknown>> {
    const radius = input.radiusMeters ?? DEFAULT_RADIUS_METERS;
    if (
      !Number.isInteger(radius) ||
      radius < 100 ||
      radius > MAX_RADIUS_METERS
    ) {
      throw new AppError(
        "REQUEST_INVALID",
        "validation",
        400,
        `radius_meters must be between 100 and ${MAX_RADIUS_METERS}.`,
      );
    }
    const query: RestaurantQuery = {
      contextPointId: point.id,
      latitude: point.latitude,
      longitude: point.longitude,
      radiusMeters: radius,
      limit: RESTAURANT_LIMIT,
      ...(input.language ? { language: input.language } : {}),
    };
    const print = restaurantFingerprint(query);
    const now = this.now();
    const cached = await this.places.findFreshRun({
      tripId: input.tripId,
      contextPointId: point.id,
      category: "restaurant",
      fingerprint: print,
      now: now.toISOString(),
    });
    if (cached)
      return this.response(
        await this.places.loadRun(cached),
        input.requestId,
        "hit",
      );

    let response;
    let normalized;
    try {
      response = await this.here.browse({
        center: { latitude: point.latitude, longitude: point.longitude },
        radiusMeters: radius,
        categories: [HERE_RESTAURANT_CATEGORY],
        limit: RESTAURANT_LIMIT,
        ...(input.language ? { language: input.language } : {}),
      });
      normalized = normalizeHereRestaurants(response.json, query);
    } catch (error) {
      await this.recordFailure(
        input,
        point,
        "restaurant",
        print,
        "here_places_v7",
        error,
      );
      throw error;
    }

    const retrievedAt = now.toISOString();
    const expiresAt = new Date(
      now.getTime() + this.ttl.restaurantHours * 3_600_000,
    ).toISOString();
    const runId = randomUUID();
    const sourceId = randomUUID();
    const source: SourceRow = {
      id: sourceId,
      trip_id: input.tripId,
      kind: "provider",
      provider: "here_places_v7",
      url: null,
      title: `HERE Browse restaurants within ${radius} m of ${point.label}`,
      retrieved_at: retrievedAt,
      freshness: "fresh",
      expires_at: expiresAt,
      observed_for: null,
      content_hash: null,
      metadata: jsonValue({
        audit_url: response.auditUrl,
        provider_request_id: response.providerRequestId,
        http_status: response.httpStatus,
      }),
      created_at: retrievedAt,
    };
    const results: PlaceDiscoveryResultRow[] = normalized.items.map((item) => ({
      id: randomUUID(),
      run_id: runId,
      trip_id: input.tripId,
      context_point_id: point.id,
      source_id: sourceId,
      category: "restaurant" as const,
      name: item.name,
      description: null,
      address: item.address,
      latitude: item.latitude,
      longitude: item.longitude,
      distance_meters: item.distance_meters,
      official_url: item.official_url,
      provider_place_id: item.provider_place_id,
      activity_type: null,
      indoor_outdoor: null,
      recommended_duration_minutes: null,
      weather_sensitivity: null,
      booking_required: null,
      cuisines: jsonValue(item.cuisines),
      opening_hours: item.opening_hours_text
        ? { text: item.opening_hours_text }
        : null,
      evidence: null,
      status: "suggested" as const,
      retrieved_at: retrievedAt,
      expires_at: expiresAt,
      metadata: jsonValue({}),
      created_at: retrievedAt,
    }));
    const limitations = [
      "Distance is measured in a straight line from the context point, not along a walking route.",
      "Opening hours are shown only when HERE returned them. Table availability, ratings, and prices are not provided.",
      ...normalized.rejected.map((entry) =>
        entry.count > 1
          ? `${entry.count} results rejected: ${entry.reason}.`
          : `1 result rejected: ${entry.reason}.`,
      ),
    ];
    const run: PlaceDiscoveryRunRow = {
      id: runId,
      trip_id: input.tripId,
      context_point_id: point.id,
      category: "restaurant",
      request_id: input.requestId,
      request_fingerprint: print,
      provider: "here_places_v7",
      status: results.length > 0 ? "ok" : "empty",
      retrieved_at: retrievedAt,
      expires_at: expiresAt,
      error_code: null,
      metadata: jsonValue({ limitations, radius_meters: radius }),
      created_at: retrievedAt,
    };
    const references: SourceReferenceInsert[] = [
      {
        id: randomUUID(),
        trip_id: input.tripId,
        source_id: sourceId,
        entity_type: "place_discovery_run",
        entity_id: runId,
        relationship_type: "provider_result",
        created_at: retrievedAt,
      },
    ];
    await this.mobility.persistBatch(
      {
        sources: [source],
        place_discovery_runs: [run],
        place_discovery_results: results,
        source_references: references,
      },
      "place_discovery.persist",
    );
    return this.response(
      { run, results, sources: [source], references },
      input.requestId,
      "miss",
    );
  }

  /** Keeps the failure for audit. The original error is always rethrown by the caller. */
  private async recordFailure(
    input: DiscoverPlacesInput,
    point: ContextPointRecord,
    category: PlaceCategoryName,
    fingerprintValue: string,
    provider: PlaceDiscoveryRunRow["provider"],
    cause: unknown,
  ): Promise<void> {
    const code =
      cause instanceof ExternalDataError || cause instanceof AppError
        ? cause.code
        : "INTERNAL_ERROR";
    const at = this.now().toISOString();
    const row: PlaceDiscoveryRunRow = {
      id: randomUUID(),
      trip_id: input.tripId,
      context_point_id: point.id,
      category,
      request_id: input.requestId,
      request_fingerprint: fingerprintValue,
      provider,
      status: "unavailable",
      retrieved_at: at,
      expires_at: new Date(Date.parse(at) + 1000).toISOString(),
      error_code: code,
      metadata: jsonValue({}),
      created_at: at,
    };
    const batch: MobilityBatch = { place_discovery_runs: [row] };
    try {
      await this.mobility.persistBatch(batch, "place_discovery.record_failure");
    } catch {
      throw new AppError(
        "PERSISTENCE_ERROR",
        "persistence",
        500,
        "The place discovery failed and the failure could not be recorded.",
        { original_error_code: code },
      );
    }
  }

  // -------------------------------------------------------------------------

  private response(
    loaded: LoadedPlaceRun,
    requestId: string,
    cache: "hit" | "miss",
  ): Record<string, unknown> {
    const now = this.now();
    const { run } = loaded;
    const extraByResult = new Map<string, string[]>();
    for (const reference of loaded.references) {
      if (reference.entity_type !== "place_discovery_result") continue;
      const current = extraByResult.get(reference.entity_id) ?? [];
      current.push(reference.source_id);
      extraByResult.set(reference.entity_id, current);
    }
    const limitations = stringList(metadataRecord(run.metadata).limitations);
    const items = loaded.results.map((row) => {
      const hours = metadataRecord(row.opening_hours);
      const hoursText = stringList(hours.text);
      return {
        id: row.id,
        trip_id: row.trip_id,
        context_point_id: row.context_point_id,
        category: row.category,
        name: row.name,
        description: row.description,
        address: row.address,
        latitude: row.latitude,
        longitude: row.longitude,
        distance_meters: row.distance_meters,
        official_url: row.official_url,
        provider_place_id: row.provider_place_id,
        ...(row.category === "activity"
          ? {
              activity_type: row.activity_type,
              indoor_outdoor: row.indoor_outdoor,
              recommended_duration_minutes: row.recommended_duration_minutes,
              weather_sensitivity: row.weather_sensitivity,
              booking_required: row.booking_required,
            }
          : { cuisines: stringList(row.cuisines) }),
        opening_hours: hoursText.length > 0 ? { text: hoursText } : null,
        status:
          freshnessAt(row.expires_at, now) === "expired" &&
          row.status === "suggested"
            ? "expired"
            : row.status,
        source_ids: [
          ...new Set([row.source_id, ...(extraByResult.get(row.id) ?? [])]),
        ],
        evidence: row.evidence,
        retrieved_at: row.retrieved_at,
        expires_at: row.expires_at,
        freshness: freshnessAt(row.expires_at, now),
      };
    });
    return {
      request_id: requestId,
      trip_id: run.trip_id,
      context_point_id: run.context_point_id,
      category: run.category,
      status: run.status === "ok" ? "ok" : "empty",
      cache_status: cache,
      items,
      sources: loaded.sources.map((row) => sourceDto(row, now)),
      retrieved_at: run.retrieved_at,
      expires_at: run.expires_at,
      freshness: freshnessAt(run.expires_at, now),
      limitations,
    };
  }
}
