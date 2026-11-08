import { createHash, randomUUID } from "node:crypto";
import {
  ExternalDataError,
  isEmptyWeather,
  normalizeHereIntermodalRoutes,
  normalizeHereRoadRoutes,
  normalizeHereTraffic,
  normalizeFreeTier,
  OPENWEATHER_SNAPSHOT_PROVIDER,
  type HereClient,
  type NormalizedRouteCandidate,
  type NormalizedRoutes,
  type OpenWeatherClient,
} from "@travelflow/integrations";
import {
  MOBILITY_POLICY_V1,
  MobilityEngineError,
  classifyTrafficArea,
  evaluateMobility,
  haversineMeters,
  type CommandContext,
  type ContextPointRecord,
  type Criticality,
  type EvaluatedOption,
  type JourneyLegRecord,
  type MobilityEvaluation,
  type MobilityPolicy,
  type MobilityPreferences,
  type RequiredFact,
  type TrafficFacts,
  type TransportMode,
  type WeatherFacts,
} from "@travelflow/domain";
import { AppError } from "../errors.js";
import type { Logger } from "../logger.js";
import {
  SupabaseMobilityRepository,
  jsonValue,
  type MobilityBatch,
  type SourceReferenceInsert,
} from "../repositories/mobility-repository.js";
import type {
  SupabaseActivityLogWriter,
  SupabaseIdempotencyStore,
} from "../repositories/domain-persistence.js";
import type { SupabaseTripContextRepository } from "../repositories/trip-context-repository.js";
import type { SourceRow } from "../supabase/database.types.js";
import type {
  RecommendationRow,
  RouteOptionRow,
  RouteRequestRow,
  TrafficSnapshotRow,
  WeatherSnapshotRow,
} from "../supabase/tables/mobility.types.js";
import {
  freshnessAt,
  recommendationDto,
  routeOptionDto,
  routeRequestDto,
  sourceDto,
  trafficDto,
  weatherDto,
} from "./mobility-serializers.js";

const ALL_MODES: readonly TransportMode[] = [
  "car",
  "taxi",
  "pedestrian",
  "transit",
];
const DEFAULT_MODES: readonly TransportMode[] = [
  "car",
  "pedestrian",
  "transit",
];
const ALL_FACTS: readonly RequiredFact[] = ["route", "traffic", "weather"];
const MAX_WEATHER_POINTS = 10;

const MODE_LABEL: Record<TransportMode, string> = {
  car: "Drive",
  taxi: "Taxi",
  pedestrian: "Walk",
  transit: "Public transit",
};

export interface MobilityDeps {
  trips: SupabaseTripContextRepository;
  repo: SupabaseMobilityRepository;
  here: HereClient;
  weather: OpenWeatherClient;
  idempotency: SupabaseIdempotencyStore;
  activityLog: SupabaseActivityLogWriter;
  logger: Logger;
  policy?: MobilityPolicy;
  now?: () => Date;
}

export interface CreateRouteRequestInput {
  tripId: string;
  userId: string;
  journeyLegId: string;
  requestId: string;
  body: Record<string, unknown>;
}

function fingerprint(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function notFound(message: string): AppError {
  return new AppError("RESOURCE_NOT_FOUND", "not_found", 404, message);
}

function requestInvalid(message: string): AppError {
  return new AppError("REQUEST_INVALID", "validation", 400, message);
}

function errorCodeOf(error: unknown): string {
  if (error instanceof ExternalDataError) return error.code;
  if (error instanceof AppError) return error.code;
  if (error instanceof MobilityEngineError) return error.code;
  return "INTERNAL_ERROR";
}

function stringArray<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T[] {
  if (!Array.isArray(value)) throw requestInvalid(`${field} must be an array.`);
  const result: T[] = [];
  for (const entry of value) {
    if (
      typeof entry !== "string" ||
      !(allowed as readonly string[]).includes(entry)
    ) {
      throw requestInvalid(`${field} contains an unsupported value.`);
    }
    if (!result.includes(entry as T)) result.push(entry as T);
  }
  return result;
}

function oneOf<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === undefined) return fallback;
  if (
    typeof value !== "string" ||
    !(allowed as readonly string[]).includes(value)
  ) {
    throw requestInvalid(`${field} is not supported.`);
  }
  return value as T;
}

/** The parts of a journey leg that routing needs. A preview has no stored leg. */
interface LegLike {
  id: string | null;
  departureAt: string;
  arrivalDeadline: string | null;
  relatedAgendaId: string | null;
}

interface GatheredEvaluation {
  evaluation: MobilityEvaluation;
  collected: Awaited<ReturnType<MobilityService["collectRoutes"]>>;
  weatherRow: WeatherSnapshotRow | null;
  trafficRow: TrafficSnapshotRow | null;
}

export interface ParsedRouteRequest {
  requiredFacts: RequiredFact[];
  modes: TransportMode[];
  preferences: MobilityPreferences;
}

export function parseRouteRequestBody(
  body: Record<string, unknown>,
  policy: MobilityPolicy,
): ParsedRouteRequest {
  for (const key of Object.keys(body)) {
    if (!["required_facts", "modes", "preferences"].includes(key)) {
      throw requestInvalid(`${key} is not supported.`);
    }
  }
  const requiredFacts =
    body.required_facts === undefined
      ? (["route"] as RequiredFact[])
      : stringArray(body.required_facts, "required_facts", ALL_FACTS);
  if (!requiredFacts.includes("route")) requiredFacts.unshift("route");
  const modes =
    body.modes === undefined
      ? [...DEFAULT_MODES]
      : stringArray(body.modes, "modes", ALL_MODES);
  if (modes.length === 0) throw requestInvalid("modes must not be empty.");

  const raw = body.preferences ?? {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw requestInvalid("preferences must be an object.");
  }
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (
      ![
        "preferred_modes",
        "max_walking_minutes",
        "max_transfers",
        "budget_preference",
        "avoid_heavy_traffic",
        "comfort_priority",
      ].includes(key)
    ) {
      throw requestInvalid(`preferences.${key} is not supported.`);
    }
  }
  const maxWalking =
    input.max_walking_minutes ?? policy.defaults.max_walking_minutes;
  const maxTransfers = input.max_transfers ?? policy.defaults.max_transfers;
  if (
    typeof maxWalking !== "number" ||
    !Number.isFinite(maxWalking) ||
    maxWalking < 0
  ) {
    throw requestInvalid(
      "preferences.max_walking_minutes must not be negative.",
    );
  }
  if (
    typeof maxTransfers !== "number" ||
    !Number.isInteger(maxTransfers) ||
    maxTransfers < 0
  ) {
    throw requestInvalid(
      "preferences.max_transfers must be a non-negative integer.",
    );
  }
  if (
    input.avoid_heavy_traffic !== undefined &&
    typeof input.avoid_heavy_traffic !== "boolean"
  ) {
    throw requestInvalid("preferences.avoid_heavy_traffic must be a boolean.");
  }
  return {
    requiredFacts,
    modes,
    preferences: {
      preferred_modes:
        input.preferred_modes === undefined
          ? []
          : stringArray(
              input.preferred_modes,
              "preferences.preferred_modes",
              ALL_MODES,
            ),
      max_walking_minutes: maxWalking,
      max_transfers: maxTransfers,
      budget_preference: oneOf(
        input.budget_preference,
        "preferences.budget_preference",
        ["low", "moderate", "high"],
        "moderate",
      ),
      avoid_heavy_traffic: input.avoid_heavy_traffic === true,
      comfort_priority: oneOf(
        input.comfort_priority,
        "preferences.comfort_priority",
        ["low", "medium", "high"],
        "medium",
      ),
    },
  };
}

/** Circle around the middle of the leg, large enough to cover both ends. */
export function corridorArea(
  origin: { latitude: number; longitude: number },
  destination: { latitude: number; longitude: number },
): { latitude: number; longitude: number; radiusMeters: number } {
  const distance = haversineMeters(origin, destination);
  return {
    latitude:
      Math.round(((origin.latitude + destination.latitude) / 2) * 1e6) / 1e6,
    longitude:
      Math.round(((origin.longitude + destination.longitude) / 2) * 1e6) / 1e6,
    radiusMeters: Math.max(
      1000,
      Math.min(20_000, Math.ceil(distance / 2) + 500),
    ),
  };
}

function weatherFacts(row: WeatherSnapshotRow): WeatherFacts {
  const payload = row.payload as Record<string, unknown>;
  return {
    latitude: row.latitude,
    longitude: row.longitude,
    timezone: row.timezone,
    observed_at: row.observed_at,
    current: (payload.current ?? null) as WeatherFacts["current"],
    hourly: (payload.hourly ?? []) as WeatherFacts["hourly"],
    daily: (payload.daily ?? []) as WeatherFacts["daily"],
    alerts: (payload.alerts ?? []) as WeatherFacts["alerts"],
    forecast_interval_minutes:
      typeof payload.forecast_interval_minutes === "number"
        ? payload.forecast_interval_minutes
        : null,
    forecast_ends_at:
      typeof payload.forecast_ends_at === "string"
        ? payload.forecast_ends_at
        : null,
    retrieved_at: row.retrieved_at,
    expires_at: row.expires_at,
  };
}

function trafficFacts(row: TrafficSnapshotRow): TrafficFacts {
  const payload = row.payload as Record<string, unknown>;
  const summary = (payload.summary ?? {}) as Record<string, unknown>;
  return {
    observed_at: row.observed_at,
    segment_count: Number(summary.segment_count ?? 0),
    average_jam_factor: (summary.average_jam_factor ?? null) as number | null,
    max_jam_factor: (summary.max_jam_factor ?? null) as number | null,
    closed_segment_count: Number(summary.closed_segment_count ?? 0),
    incident_count: Number(summary.incident_count ?? 0),
    incidents: (payload.incidents ?? []) as TrafficFacts["incidents"],
    retrieved_at: row.retrieved_at,
    expires_at: row.expires_at,
  };
}

function minutesLabel(seconds: number): number {
  return Math.round(seconds / 60);
}

export class MobilityService {
  private readonly policy: MobilityPolicy;
  private readonly now: () => Date;

  public constructor(private readonly deps: MobilityDeps) {
    this.policy = deps.policy ?? MOBILITY_POLICY_V1;
    this.now = deps.now ?? (() => new Date());
  }

  // -------------------------------------------------------------------------
  // Access helpers

  private async requireTrip(tripId: string, userId: string): Promise<void> {
    const trip = await this.deps.trips.getTripRowForUser(tripId, userId);
    if (!trip) throw notFound("Trip was not found.");
  }

  private async requireLeg(
    tripId: string,
    legId: string,
  ): Promise<JourneyLegRecord> {
    const leg = await this.deps.trips.getJourneyLeg(legId);
    if (!leg || leg.tripId !== tripId)
      throw notFound("Journey leg was not found.");
    return leg;
  }

  private async requirePoint(
    tripId: string,
    contextPointId: string,
  ): Promise<ContextPointRecord & { latitude: number; longitude: number }> {
    const point = await this.deps.trips.getContextPoint(contextPointId);
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
        `Context point "${point.label}" must be active and resolved before it can be used for mobility.`,
        { context_point_id: point.id },
      );
    }
    return point as ContextPointRecord & {
      latitude: number;
      longitude: number;
    };
  }

  // -------------------------------------------------------------------------
  // Weather

  public async weatherFor(
    tripId: string,
    point: ContextPointRecord & { latitude: number; longitude: number },
  ): Promise<{ row: WeatherSnapshotRow; cache: "hit" | "miss" }> {
    const now = this.now();
    const print = fingerprint({
      provider: OPENWEATHER_SNAPSHOT_PROVIDER,
      tripId,
      contextPointId: point.id,
      latitude: point.latitude,
      longitude: point.longitude,
    });
    const cached = await this.deps.repo.findFreshWeather(
      tripId,
      print,
      now.toISOString(),
    );
    if (cached) return { row: cached, cache: "hit" };

    const started = Date.now();
    const response = await this.deps.weather.snapshot({
      latitude: point.latitude,
      longitude: point.longitude,
    });
    const weather = normalizeFreeTier({
      current: response.current.json,
      forecast: response.forecast.json,
      timezone: point.timezone,
    });
    if (isEmptyWeather(weather)) {
      throw new AppError(
        "WEATHER_EMPTY_RESULT",
        "provider",
        422,
        "OpenWeather returned no weather data for this location.",
        { context_point_id: point.id },
      );
    }
    const retrievedAt = now.toISOString();
    const expiresAt = new Date(
      now.getTime() + this.policy.ttl_minutes.weather * 60_000,
    ).toISOString();
    const times = [
      weather.current?.at,
      ...weather.hourly.map((entry) => entry.at),
      ...weather.daily.map((entry) => entry.at),
    ]
      .filter((value): value is string => typeof value === "string")
      .sort();
    const validFrom = times[0] as string;
    const validTo = times[times.length - 1] as string;
    const probabilities = weather.hourly
      .map((entry) => entry.precipitation_probability)
      .filter((value): value is number => value !== null);
    const sourceId = randomUUID();
    const source: SourceRow = {
      id: sourceId,
      trip_id: tripId,
      kind: "provider",
      provider: OPENWEATHER_SNAPSHOT_PROVIDER,
      url: null,
      title: `OpenWeather current weather and 5-day forecast for ${point.label}`,
      retrieved_at: retrievedAt,
      freshness: "fresh",
      expires_at: expiresAt,
      observed_for: jsonValue({
        from: validFrom,
        to: validTo,
        timezone: weather.timezone,
      }),
      content_hash: null,
      metadata: jsonValue({
        requests: [response.current, response.forecast].map((part) => ({
          audit_url: part.auditUrl,
          provider_request_id: part.providerRequestId,
          http_status: part.httpStatus,
        })),
        // The worker's audit trail reads this list.
        provider_request_ids: [response.current, response.forecast]
          .map((part) => part.providerRequestId)
          .filter((id): id is string => typeof id === "string"),
        duration_ms: Date.now() - started,
      }),
      created_at: retrievedAt,
    };
    const row: WeatherSnapshotRow = {
      id: randomUUID(),
      trip_id: tripId,
      context_point_id: point.id,
      provider: OPENWEATHER_SNAPSHOT_PROVIDER,
      source_id: sourceId,
      request_fingerprint: print,
      latitude: point.latitude,
      longitude: point.longitude,
      timezone: weather.timezone,
      observed_at: weather.observed_at,
      valid_from: validFrom,
      valid_to: validTo,
      current_condition: weather.current?.condition ?? null,
      current_temperature_c: weather.current?.temperature_c ?? null,
      max_precipitation_probability:
        probabilities.length > 0 ? Math.max(...probabilities) : null,
      payload: jsonValue({
        current: weather.current,
        hourly: weather.hourly,
        daily: weather.daily,
        alerts: weather.alerts,
        forecast_interval_minutes: weather.forecast_interval_minutes,
        forecast_ends_at: weather.forecast_ends_at,
        units: {
          temperature: "celsius",
          wind_speed: "m/s",
          visibility: "m",
          precipitation: "mm",
        },
      }),
      retrieved_at: retrievedAt,
      expires_at: expiresAt,
      created_at: retrievedAt,
    };
    await this.deps.repo.persistBatch(
      { sources: [source], weather_snapshots: [row] },
      "weather.persist",
    );
    return { row, cache: "miss" };
  }

  public async listWeather(input: {
    tripId: string;
    userId: string;
    requestId: string;
    contextPointId?: string;
  }): Promise<Record<string, unknown>> {
    await this.requireTrip(input.tripId, input.userId);
    const now = this.now();
    const points = (
      await this.deps.trips.listContextPointsForTrip(input.tripId, input.userId)
    ).filter(
      (point) =>
        point.status === "active" &&
        point.resolution_status === "resolved" &&
        point.latitude !== null &&
        point.longitude !== null &&
        (!input.contextPointId || point.id === input.contextPointId),
    );
    if (input.contextPointId && points.length === 0) {
      throw notFound("Context point was not found.");
    }
    const fresh = await this.deps.repo.listFreshWeather(
      input.tripId,
      now.toISOString(),
    );
    const latest = new Map<string, WeatherSnapshotRow>();
    for (const row of fresh)
      if (!latest.has(row.context_point_id))
        latest.set(row.context_point_id, row);
    const items = points
      .map((point) => latest.get(point.id))
      .filter((row): row is WeatherSnapshotRow => row !== undefined);
    return {
      request_id: input.requestId,
      // The traveller reads places, not ids: every place the trip has, with the
      // forecast when one exists, so a place without weather is still visible.
      places: points.map((point) => ({
        context_point_id: point.id,
        label: point.label,
        type: point.type,
        latitude: point.latitude,
        longitude: point.longitude,
        has_snapshot: latest.has(point.id),
      })),
      items: items.map((row) => weatherDto(row, now)),
      missing_context_point_ids: points
        .filter((point) => !latest.has(point.id))
        .map((point) => point.id),
    };
  }

  public async refreshWeather(input: {
    tripId: string;
    userId: string;
    requestId: string;
    contextPointId?: string;
  }): Promise<Record<string, unknown>> {
    await this.requireTrip(input.tripId, input.userId);
    let points: Array<
      ContextPointRecord & { latitude: number; longitude: number }
    >;
    if (input.contextPointId) {
      points = [await this.requirePoint(input.tripId, input.contextPointId)];
    } else {
      const all = (
        await this.deps.trips.listContextPointsForTrip(
          input.tripId,
          input.userId,
        )
      ).filter(
        (point) =>
          point.status === "active" &&
          point.resolution_status === "resolved" &&
          point.latitude !== null &&
          point.longitude !== null,
      );
      if (all.length === 0) {
        throw new AppError(
          "EXTERNAL_CONTEXT_UNRESOLVED",
          "validation",
          422,
          "The trip has no resolved context point to fetch weather for.",
        );
      }
      if (all.length > MAX_WEATHER_POINTS) {
        throw requestInvalid(
          `Weather refresh covers at most ${MAX_WEATHER_POINTS} context points. Pass context_point_id.`,
        );
      }
      points = [];
      for (const row of all)
        points.push(await this.requirePoint(input.tripId, row.id));
    }
    const now = this.now();
    const items: Record<string, unknown>[] = [];
    // One point at a time: a failure stops the refresh with its own error.
    for (const point of points) {
      const result = await this.weatherFor(input.tripId, point);
      items.push(weatherDto(result.row, now, result.cache));
    }
    return {
      request_id: input.requestId,
      items,
      missing_context_point_ids: [],
    };
  }

  // -------------------------------------------------------------------------
  // Traffic

  private async trafficFor(
    tripId: string,
    journeyLegId: string | null,
    origin: ContextPointRecord & { latitude: number; longitude: number },
    destination: ContextPointRecord & { latitude: number; longitude: number },
  ): Promise<{ row: TrafficSnapshotRow; cache: "hit" | "miss" }> {
    const now = this.now();
    const area = corridorArea(origin, destination);
    const print = fingerprint({
      provider: "here_traffic_v7",
      tripId,
      origin: [origin.id, origin.latitude, origin.longitude],
      destination: [
        destination.id,
        destination.latitude,
        destination.longitude,
      ],
      area,
    });
    const cached = await this.deps.repo.findFreshTraffic(
      tripId,
      print,
      now.toISOString(),
    );
    if (cached) return { row: cached, cache: "hit" };

    const started = Date.now();
    const [flow, incidents] = await Promise.all([
      this.deps.here.trafficFlow(area),
      this.deps.here.trafficIncidents(area),
    ]);
    const traffic = normalizeHereTraffic(flow.json, incidents.json);
    if (traffic.segment_count === 0 && traffic.incident_count === 0) {
      throw new AppError(
        "TRAFFIC_EMPTY_RESULT",
        "provider",
        422,
        "HERE returned no traffic data for the area around this journey.",
        { journey_leg_id: journeyLegId },
      );
    }
    const retrievedAt = now.toISOString();
    const expiresAt = new Date(
      now.getTime() + this.policy.ttl_minutes.traffic * 60_000,
    ).toISOString();
    const retrievedMs = now.getTime();
    const observedAt = traffic.observed_at;
    const level = classifyTrafficArea(
      {
        ...traffic,
        retrieved_at: retrievedAt,
        expires_at: expiresAt,
      },
      this.policy,
    );
    const sourceId = randomUUID();
    const source: SourceRow = {
      id: sourceId,
      trip_id: tripId,
      kind: "provider",
      provider: "here_traffic_v7",
      url: null,
      title: `HERE Traffic API v7 flow and incidents around ${origin.label} to ${destination.label}`,
      retrieved_at: retrievedAt,
      freshness: "fresh",
      expires_at: expiresAt,
      observed_for: jsonValue({
        from: retrievedAt,
        to: expiresAt,
        timezone: origin.timezone,
      }),
      content_hash: null,
      metadata: jsonValue({
        audit_urls: [flow.auditUrl, incidents.auditUrl],
        provider_request_ids: [
          flow.providerRequestId,
          incidents.providerRequestId,
        ],
        duration_ms: Date.now() - started,
      }),
      created_at: retrievedAt,
    };
    const validFrom =
      observedAt && Date.parse(observedAt) <= retrievedMs
        ? observedAt
        : retrievedAt;
    const row: TrafficSnapshotRow = {
      id: randomUUID(),
      trip_id: tripId,
      journey_leg_id: journeyLegId,
      origin_context_point_id: origin.id,
      destination_context_point_id: destination.id,
      provider: "here_traffic_v7",
      source_id: sourceId,
      request_fingerprint: print,
      policy_version: this.policy.version,
      traffic_level: level,
      center_latitude: area.latitude,
      center_longitude: area.longitude,
      radius_meters: area.radiusMeters,
      observed_at: observedAt,
      valid_from: validFrom,
      valid_to: expiresAt,
      payload: jsonValue({
        summary: {
          segment_count: traffic.segment_count,
          average_jam_factor: traffic.average_jam_factor,
          max_jam_factor: traffic.max_jam_factor,
          closed_segment_count: traffic.closed_segment_count,
          incident_count: traffic.incident_count,
        },
        incidents: traffic.incidents,
      }),
      retrieved_at: retrievedAt,
      expires_at: expiresAt,
      created_at: retrievedAt,
    };
    await this.deps.repo.persistBatch(
      { sources: [source], traffic_snapshots: [row] },
      "traffic.persist",
    );
    return { row, cache: "miss" };
  }

  public async listTraffic(input: {
    tripId: string;
    userId: string;
    requestId: string;
    journeyLegId?: string;
  }): Promise<Record<string, unknown>> {
    await this.requireTrip(input.tripId, input.userId);
    const now = this.now();
    let pair: { origin: string; destination: string } | null = null;
    if (input.journeyLegId) {
      const leg = await this.requireLeg(input.tripId, input.journeyLegId);
      pair = {
        origin: leg.originContextPointId,
        destination: leg.destinationContextPointId,
      };
    }
    const fresh = await this.deps.repo.listFreshTraffic(
      input.tripId,
      now.toISOString(),
    );
    const latest = new Map<string, TrafficSnapshotRow>();
    for (const row of fresh) {
      if (
        pair &&
        (row.origin_context_point_id !== pair.origin ||
          row.destination_context_point_id !== pair.destination)
      ) {
        continue;
      }
      const key = `${row.origin_context_point_id}|${row.destination_context_point_id}`;
      if (!latest.has(key)) latest.set(key, row);
    }
    return {
      request_id: input.requestId,
      items: [...latest.values()].map((row) => trafficDto(row, now)),
    };
  }

  public async refreshTraffic(input: {
    tripId: string;
    userId: string;
    requestId: string;
    journeyLegId: string;
  }): Promise<Record<string, unknown>> {
    await this.requireTrip(input.tripId, input.userId);
    const leg = await this.requireLeg(input.tripId, input.journeyLegId);
    const origin = await this.requirePoint(
      input.tripId,
      leg.originContextPointId,
    );
    const destination = await this.requirePoint(
      input.tripId,
      leg.destinationContextPointId,
    );
    const result = await this.trafficFor(
      input.tripId,
      leg.id,
      origin,
      destination,
    );
    return {
      request_id: input.requestId,
      items: [trafficDto(result.row, this.now(), result.cache)],
    };
  }

  /**
   * Traffic around the corridor between two context points, for callers that
   * have no stored journey leg (the assistant). The snapshot is not tied to a leg.
   */
  public async refreshTrafficForPair(input: {
    tripId: string;
    userId: string;
    requestId: string;
    originContextPointId: string;
    destinationContextPointId: string;
  }): Promise<Record<string, unknown>> {
    await this.requireTrip(input.tripId, input.userId);
    const origin = await this.requirePoint(
      input.tripId,
      input.originContextPointId,
    );
    const destination = await this.requirePoint(
      input.tripId,
      input.destinationContextPointId,
    );
    const result = await this.trafficFor(
      input.tripId,
      null,
      origin,
      destination,
    );
    return {
      request_id: input.requestId,
      items: [trafficDto(result.row, this.now(), result.cache)],
    };
  }

  // -------------------------------------------------------------------------
  // Route requests

  private async criticalityFor(
    leg: { relatedAgendaId: string | null },
    destination: ContextPointRecord,
  ): Promise<Criticality> {
    if (destination.type === "airport") return "airport_departure";
    if (leg.relatedAgendaId) {
      const agenda = await this.deps.trips.getAgendaItem(leg.relatedAgendaId);
      if (
        agenda &&
        (agenda.type === "meeting" || agenda.type === "conference")
      ) {
        return "important_meeting";
      }
    }
    return "normal";
  }

  private async collectRoutes(
    modes: TransportMode[],
    origin: { latitude: number; longitude: number },
    destination: { latitude: number; longitude: number },
    departureAt: string,
  ): Promise<{
    candidates: NormalizedRouteCandidate[];
    audits: Map<
      string,
      {
        auditUrl: string;
        providerRequestId: string | null;
        httpStatus: number;
        mode: TransportMode;
      }
    >;
    notes: string[];
    emptyModes: TransportMode[];
  }> {
    const settled = await Promise.allSettled(
      modes.map(async (mode) => {
        if (mode === "transit") {
          const response = await this.deps.here.intermodalRoutes({
            origin,
            destination,
            departureAt,
          });
          return {
            mode,
            response,
            routes: normalizeHereIntermodalRoutes(response.json),
          };
        }
        const response = await this.deps.here.roadRoutes({
          mode,
          origin,
          destination,
          departureAt,
        });
        return {
          mode,
          response,
          routes: normalizeHereRoadRoutes(response.json, mode),
        };
      }),
    );
    // A provider failure for any requested mode fails the request; there is no partial answer.
    for (const result of settled) {
      if (result.status === "rejected") throw result.reason;
    }
    const candidates: NormalizedRouteCandidate[] = [];
    const audits = new Map<
      string,
      {
        auditUrl: string;
        providerRequestId: string | null;
        httpStatus: number;
        mode: TransportMode;
      }
    >();
    const notes: string[] = [];
    const emptyModes: TransportMode[] = [];
    for (const result of settled) {
      if (result.status !== "fulfilled") continue;
      const { mode, response, routes } = result.value as {
        mode: TransportMode;
        response: {
          auditUrl: string;
          providerRequestId: string | null;
          httpStatus: number;
        };
        routes: NormalizedRoutes;
      };
      const sourceKey =
        mode === "transit"
          ? "here_intermodal_v8:transit"
          : `here_routing_v8:${mode}`;
      audits.set(sourceKey, { ...response, mode });
      if (routes.dropped.length > 0) {
        notes.push(
          `${routes.dropped.length} intermodal route(s) had no public transit section and were not treated as public transit.`,
        );
      }
      if (routes.candidates.length === 0) {
        emptyModes.push(mode);
        notes.push(
          mode === "transit"
            ? "TRANSIT_EMPTY_RESULT: HERE returned no public transit route for this leg."
            : `ROUTE_EMPTY_RESULT: HERE returned no ${mode} route for this leg.`,
        );
      }
      candidates.push(...routes.candidates);
    }
    return { candidates, audits, notes, emptyModes };
  }

  public async createRouteRequest(
    input: CreateRouteRequestInput,
    command: CommandContext,
  ): Promise<Record<string, unknown>> {
    await this.requireTrip(input.tripId, input.userId);
    const leg = await this.requireLeg(input.tripId, input.journeyLegId);
    if (leg.status !== "planned" && leg.status !== "in_progress") {
      throw new AppError(
        "JOURNEY_LEG_STATE_INVALID",
        "conflict",
        409,
        "Only a planned or in-progress journey leg can be routed.",
      );
    }
    const parsed = parseRouteRequestBody(input.body, this.policy);
    const origin = await this.requirePoint(
      input.tripId,
      leg.originContextPointId,
    );
    const destination = await this.requirePoint(
      input.tripId,
      leg.destinationContextPointId,
    );

    return this.deps.idempotency.execute(
      `route-request.create:${leg.id}`,
      command,
      async () => {
        const result = await this.computeRouteRequest(
          input,
          leg,
          origin,
          destination,
          parsed,
        );
        await this.deps.activityLog.append({
          actorUserId: input.userId,
          action: "route_request.created",
          resourceType: "route_request",
          resourceId: result.routeRequestId,
          metadata: {
            trip_id: input.tripId,
            journey_leg_id: leg.id,
            policy_version: this.policy.version,
          },
        });
        return this.routeRequestResult(
          input.tripId,
          result.routeRequestId,
          input.requestId,
        );
      },
    );
  }

  private async computeRouteRequest(
    input: CreateRouteRequestInput,
    leg: JourneyLegRecord,
    origin: ContextPointRecord & { latitude: number; longitude: number },
    destination: ContextPointRecord & { latitude: number; longitude: number },
    parsed: ParsedRouteRequest,
  ): Promise<{ routeRequestId: string }> {
    const now = this.now();
    const retrievedAt = now.toISOString();
    const routeRequestId = randomUUID();
    const print = fingerprint({
      legId: leg.id,
      departureAt: leg.departureAt,
      arrivalDeadline: leg.arrivalDeadline,
      modes: [...parsed.modes].sort(),
      requiredFacts: [...parsed.requiredFacts].sort(),
      preferences: parsed.preferences,
      policy: this.policy.version,
    });
    const requestRow = (
      status: "completed" | "failed",
      errorCode: string | null,
      extra: Partial<RouteRequestRow> = {},
    ): RouteRequestRow => ({
      id: routeRequestId,
      trip_id: input.tripId,
      journey_leg_id: leg.id,
      origin_context_point_id: origin.id,
      destination_context_point_id: destination.id,
      request_id: input.requestId,
      request_fingerprint: print,
      departure_at: leg.departureAt,
      arrival_deadline: leg.arrivalDeadline,
      preferences: jsonValue(parsed.preferences),
      required_facts: jsonValue(parsed.requiredFacts),
      modes: jsonValue(parsed.modes),
      status,
      error_code: errorCode,
      policy_version: this.policy.version,
      weather_snapshot_id: null,
      traffic_snapshot_id: null,
      selected_option_id: null,
      facts: [],
      limitations: [],
      departure_recommendation: null,
      retrieved_at: retrievedAt,
      expires_at: retrievedAt,
      created_at: retrievedAt,
      ...extra,
    });

    let gathered: GatheredEvaluation;
    try {
      gathered = await this.gatherEvaluation({
        tripId: input.tripId,
        requestId: input.requestId,
        routeRequestId,
        leg,
        origin,
        destination,
        parsed,
        now,
      });
    } catch (error) {
      await this.recordFailure(
        input,
        requestRow("failed", errorCodeOf(error)),
        error,
      );
      throw error instanceof MobilityEngineError ? engineError(error) : error;
    }
    const { evaluation, collected, weatherRow, trafficRow } = gathered;

    // Rows -------------------------------------------------------------
    const routeTtlMs = this.policy.ttl_minutes.route * 60_000;
    const expiresAt = new Date(now.getTime() + routeTtlMs).toISOString();
    const { rows: sources, idByKey: sourceIdByKey } = routeSourceRows({
      tripId: input.tripId,
      evaluation,
      collected,
      origin,
      destination,
      departureAt: leg.departureAt,
      arrivalDeadline: leg.arrivalDeadline,
      retrievedAt,
      expiresAt,
    });

    const optionRows: RouteOptionRow[] = evaluation.options.map((option) =>
      optionRow(option, {
        id: randomUUID(),
        routeRequestId,
        tripId: input.tripId,
        sourceId: sourceIdByKey.get(option.source_key) as string,
        weather: weatherRow,
        traffic: trafficRow,
        policy: this.policy.version,
        retrievedAt,
        expiresAt,
      }),
    );
    const recommendedRow = optionRows.find((row) => row.recommended) ?? null;
    const recommended =
      evaluation.options.find((option) => option.recommended) ?? null;

    const limitations = [...evaluation.limitations, ...collected.notes];
    const request = requestRow("completed", null, {
      weather_snapshot_id: weatherRow?.id ?? null,
      traffic_snapshot_id: trafficRow?.id ?? null,
      facts: jsonValue(evaluation.facts),
      limitations: jsonValue([...new Set(limitations)]),
      departure_recommendation: evaluation.departure_recommendation
        ? jsonValue(evaluation.departure_recommendation)
        : null,
      expires_at: expiresAt,
    });

    const references: SourceReferenceInsert[] = [];
    const reference = (
      sourceId: string,
      entityType: string,
      entityId: string,
      relationship: string,
    ): void => {
      references.push({
        id: randomUUID(),
        trip_id: input.tripId,
        source_id: sourceId,
        entity_type: entityType,
        entity_id: entityId,
        relationship_type: relationship,
        created_at: retrievedAt,
      });
    };
    for (const row of optionRows) {
      if (weatherRow)
        reference(
          weatherRow.source_id,
          "route_option",
          row.id,
          "risk_evidence_weather",
        );
      if (trafficRow)
        reference(
          trafficRow.source_id,
          "route_option",
          row.id,
          "risk_evidence_traffic",
        );
    }

    const batch: MobilityBatch = {
      sources,
      route_requests: [request],
      route_options: optionRows,
    };
    if (recommended && recommendedRow) {
      const recommendationId = randomUUID();
      const reasonText =
        `${MODE_LABEL[recommended.transport_mode]} ranks first under ${this.policy.version}: ` +
        `arrives ${recommended.derived_metrics.arrival_at} with a safety buffer of ` +
        `${minutesLabel(recommended.derived_metrics.safety_buffer_seconds)} min` +
        (recommended.derived_metrics.deadline_slack_seconds !== null
          ? ` and ${minutesLabel(recommended.derived_metrics.deadline_slack_seconds)} min of slack before the deadline.`
          : ". There is no arrival deadline on this leg.");
      const recommendation: RecommendationRow = {
        id: recommendationId,
        trip_id: input.tripId,
        conversation_id: null,
        context_point_id: destination.id,
        recommendation_type: "route",
        route_request_id: routeRequestId,
        route_option_id: recommendedRow.id,
        context_snapshot: jsonValue({
          journey_leg_id: leg.id,
          origin: { id: origin.id, label: origin.label },
          destination: { id: destination.id, label: destination.label },
          departure_at: leg.departureAt,
          arrival_deadline: leg.arrivalDeadline,
          required_facts: parsed.requiredFacts,
          weather_snapshot_id: weatherRow?.id ?? null,
          traffic_snapshot_id: trafficRow?.id ?? null,
        }),
        payload: jsonValue({
          title: `${MODE_LABEL[recommended.transport_mode]} to ${destination.label}`,
          route_request_id: routeRequestId,
          route_option_id: recommendedRow.id,
          transport_mode: recommended.transport_mode,
          departure_recommendation: evaluation.departure_recommendation,
          arrival_at: recommended.derived_metrics.arrival_at,
          total_duration_seconds:
            recommended.derived_metrics.total_duration_seconds,
          safety_buffer_seconds:
            recommended.derived_metrics.safety_buffer_seconds,
          deadline_slack_seconds:
            recommended.derived_metrics.deadline_slack_seconds,
          cost: recommended.cost,
          risk: recommended.risk,
          reason_codes: recommended.derived_metrics.reason_codes,
        }),
        reason: reasonText,
        status: "suggested",
        policy_version: this.policy.version,
        created_at: retrievedAt,
        updated_at: retrievedAt,
        expires_at: new Date(
          now.getTime() + this.policy.ttl_minutes.recommendation * 60_000,
        ).toISOString(),
      };
      batch.recommendations = [recommendation];
      const evidence = new Set<string>([recommendedRow.source_id]);
      if (weatherRow) evidence.add(weatherRow.source_id);
      if (trafficRow) evidence.add(trafficRow.source_id);
      for (const sourceId of evidence)
        reference(
          sourceId,
          "recommendation",
          recommendationId,
          "route_evidence",
        );
    }
    batch.source_references = references;
    await this.deps.repo.persistBatch(batch, "route_request.persist");
    return { routeRequestId };
  }

  /**
   * Collects routes, applies the weather and traffic rules, and runs the
   * deterministic engine. Shared by stored route requests and previews, so the
   * ranking never depends on which path asked.
   */
  private async gatherEvaluation(args: {
    tripId: string;
    requestId: string;
    routeRequestId: string | null;
    leg: LegLike;
    origin: ContextPointRecord & { latitude: number; longitude: number };
    destination: ContextPointRecord & { latitude: number; longitude: number };
    parsed: ParsedRouteRequest;
    now: Date;
  }): Promise<GatheredEvaluation> {
    const { leg, origin, destination, parsed, now, routeRequestId } = args;
    const retrievedAtIso = now.toISOString();
    let weatherRow: WeatherSnapshotRow | null = null;
    let trafficRow: TrafficSnapshotRow | null = null;
    const collected = await this.collectRoutes(
      parsed.modes,
      origin,
      destination,
      leg.departureAt,
    );
    if (collected.candidates.length === 0) {
      throw new AppError(
        "ROUTE_EMPTY_RESULT",
        "provider",
        422,
        "HERE returned no route for this journey leg.",
        { empty_modes: collected.emptyModes },
      );
    }

    // Weather at the destination, only when asked for or already stored and fresh.
    if (parsed.requiredFacts.includes("weather")) {
      weatherRow = (await this.weatherFor(args.tripId, destination)).row;
    } else {
      const print = fingerprint({
        provider: OPENWEATHER_SNAPSHOT_PROVIDER,
        tripId: args.tripId,
        contextPointId: destination.id,
        latitude: destination.latitude,
        longitude: destination.longitude,
      });
      weatherRow = await this.deps.repo.findFreshWeather(
        args.tripId,
        print,
        retrievedAtIso,
      );
    }

    // Area traffic is a "now" fact, so it only applies to a leg that departs soon.
    const minutesToDeparture =
      (Date.parse(leg.departureAt) - now.getTime()) / 60_000;
    const withinHorizon =
      minutesToDeparture <= this.policy.traffic_live_horizon_minutes;
    if (parsed.requiredFacts.includes("traffic")) {
      if (!withinHorizon) {
        throw new AppError(
          "TRAFFIC_FACTS_MISSING",
          "validation",
          422,
          "Live traffic only describes the next few hours. This journey leg departs later, so traffic cannot be required.",
          {
            reason: "departure_beyond_live_horizon",
            horizon_minutes: this.policy.traffic_live_horizon_minutes,
          },
        );
      }
      trafficRow = (
        await this.trafficFor(args.tripId, leg.id, origin, destination)
      ).row;
    } else if (withinHorizon) {
      const area = corridorArea(origin, destination);
      const trafficPrint = fingerprint({
        provider: "here_traffic_v7",
        tripId: args.tripId,
        origin: [origin.id, origin.latitude, origin.longitude],
        destination: [
          destination.id,
          destination.latitude,
          destination.longitude,
        ],
        area,
      });
      trafficRow = await this.deps.repo.findFreshTraffic(
        args.tripId,
        trafficPrint,
        retrievedAtIso,
      );
    }

    const started = Date.now();
    const evaluation = evaluateMobility(
      {
        now: retrievedAtIso,
        departure_at: leg.departureAt,
        arrival_deadline: leg.arrivalDeadline,
        timezone: origin.timezone,
        criticality: await this.criticalityFor(leg, destination),
        preferences: parsed.preferences,
        required_facts: parsed.requiredFacts,
        candidates: collected.candidates,
        traffic: trafficRow ? trafficFacts(trafficRow) : null,
        weather: weatherRow ? weatherFacts(weatherRow) : null,
      },
      this.policy,
    );
    this.deps.logger.info("mobility.evaluated", {
      request_id: args.requestId,
      trip_id: args.tripId,
      journey_leg_id: leg.id,
      route_request_id: routeRequestId,
      policy_version: this.policy.version,
      candidate_count: collected.candidates.length,
      feasible_count: evaluation.options.filter(
        (option) => option.derived_metrics.feasible === true,
      ).length,
      recommended_key: evaluation.recommended_key,
      required_facts: parsed.requiredFacts,
      missing_facts: evaluation.missing_facts,
      scoring_duration_ms: Date.now() - started,
    });
    return { evaluation, collected, weatherRow, trafficRow };
  }

  /** Keeps a failed request for audit, then the caller rethrows the original error. */
  private async recordFailure(
    input: CreateRouteRequestInput,
    row: RouteRequestRow,
    cause: unknown,
  ): Promise<void> {
    try {
      await this.deps.repo.persistBatch(
        { route_requests: [row] },
        "route_request.record_failure",
      );
    } catch (persistError) {
      this.deps.logger.error("mobility.failure_not_recorded", {
        request_id: input.requestId,
        original_error_code: errorCodeOf(cause),
        persistence_error: errorCodeOf(persistError),
      });
      throw new AppError(
        "PERSISTENCE_ERROR",
        "persistence",
        500,
        "The route request failed and the failure could not be recorded.",
        { original_error_code: errorCodeOf(cause) },
      );
    }
  }

  // -------------------------------------------------------------------------
  // Reading

  /**
   * Routes between two context points without storing anything. The assistant
   * uses it when the user asks about a trip between two places that no stored
   * journey leg covers. It runs the same collection and the same engine as a
   * stored route request; the only difference is that nothing is written, so
   * there is no recommendation to save or apply.
   */
  public async previewRoutes(input: {
    tripId: string;
    userId: string;
    requestId: string;
    originContextPointId: string;
    destinationContextPointId: string;
    /** ISO time with offset. Null means leave now. */
    departureAt: string | null;
    modes?: TransportMode[];
  }): Promise<Record<string, unknown>> {
    await this.requireTrip(input.tripId, input.userId);
    const origin = await this.requirePoint(
      input.tripId,
      input.originContextPointId,
    );
    const destination = await this.requirePoint(
      input.tripId,
      input.destinationContextPointId,
    );
    if (origin.id === destination.id) {
      throw requestInvalid(
        "The origin and the destination are the same place.",
      );
    }
    const now = this.now();
    const departureAt = input.departureAt ?? now.toISOString();
    if (Date.parse(departureAt) < now.getTime() - 5 * 60_000) {
      throw requestInvalid("The departure time is in the past.");
    }
    const parsed = parseRouteRequestBody(
      input.modes ? { modes: input.modes } : {},
      this.policy,
    );
    const { evaluation, collected, weatherRow, trafficRow } =
      await this.gatherEvaluation({
        tripId: input.tripId,
        requestId: input.requestId,
        routeRequestId: null,
        leg: {
          id: null,
          departureAt,
          arrivalDeadline: null,
          relatedAgendaId: null,
        },
        origin,
        destination,
        parsed,
        now,
      });

    const retrievedAt = now.toISOString();
    const expiresAt = new Date(
      now.getTime() + this.policy.ttl_minutes.route * 60_000,
    ).toISOString();
    const { rows: sources, idByKey } = routeSourceRows({
      tripId: input.tripId,
      evaluation,
      collected,
      origin,
      destination,
      departureAt,
      arrivalDeadline: null,
      retrievedAt,
      expiresAt,
    });
    const previewId = randomUUID();
    const optionRows = evaluation.options.map((option) =>
      optionRow(option, {
        id: randomUUID(),
        routeRequestId: previewId,
        tripId: input.tripId,
        sourceId: idByKey.get(option.source_key) as string,
        weather: weatherRow,
        traffic: trafficRow,
        policy: this.policy.version,
        retrievedAt,
        expiresAt,
      }),
    );
    optionRows.sort((a, b) => {
      const rankA = a.rank ?? Number.MAX_SAFE_INTEGER;
      const rankB = b.rank ?? Number.MAX_SAFE_INTEGER;
      if (rankA !== rankB) return rankA - rankB;
      if (a.total_duration_seconds !== b.total_duration_seconds) {
        return a.total_duration_seconds - b.total_duration_seconds;
      }
      return a.id < b.id ? -1 : 1;
    });
    const notStored = { selected_option_id: null } as RouteRequestRow;
    const snapshotSources = {
      weather: weatherRow?.source_id ?? null,
      traffic: trafficRow?.source_id ?? null,
    };
    const extraSourceIds = [
      snapshotSources.weather,
      snapshotSources.traffic,
    ].filter((id): id is string => id !== null);
    const evidence = await this.deps.repo.getSourcesByIds(
      input.tripId,
      extraSourceIds,
    );
    const recommended = optionRows.find((row) => row.recommended) ?? null;
    return {
      request_id: input.requestId,
      preview: true,
      origin_context_point_id: origin.id,
      destination_context_point_id: destination.id,
      departure_at: departureAt,
      departure_basis: input.departureAt ? "requested" : "now",
      policy_version: this.policy.version,
      options: optionRows.map((row) =>
        routeOptionDto(row, notStored, now, snapshotSources),
      ),
      recommended_option_id: recommended?.id ?? null,
      departure_recommendation: evaluation.departure_recommendation,
      facts: evaluation.facts,
      limitations: [
        ...new Set([...evaluation.limitations, ...collected.notes]),
      ],
      sources: [...sources, ...evidence].map((row) => sourceDto(row, now)),
      weather: weatherRow ? weatherDto(weatherRow, now) : null,
      traffic: trafficRow ? trafficDto(trafficRow, now) : null,
    };
  }

  /** Source records for ids that belong to this trip, in the API shape. */
  public async sourceViews(
    tripId: string,
    ids: string[],
  ): Promise<Record<string, unknown>[]> {
    const rows = await this.deps.repo.getSourcesByIds(tripId, [
      ...new Set(ids),
    ]);
    const now = this.now();
    return rows.map((row) => sourceDto(row, now));
  }

  public async listRouteRequests(input: {
    tripId: string;
    userId: string;
    journeyLegId: string;
    requestId: string;
  }): Promise<Record<string, unknown>> {
    await this.requireTrip(input.tripId, input.userId);
    await this.requireLeg(input.tripId, input.journeyLegId);
    const rows = await this.deps.repo.listRouteRequests(
      input.tripId,
      input.journeyLegId,
    );
    const now = this.now();
    return {
      request_id: input.requestId,
      items: rows.map((row) => routeRequestDto(row, now)),
    };
  }

  public async getRouteRequest(input: {
    tripId: string;
    userId: string;
    routeRequestId: string;
    requestId: string;
  }): Promise<Record<string, unknown>> {
    await this.requireTrip(input.tripId, input.userId);
    return this.routeRequestResult(
      input.tripId,
      input.routeRequestId,
      input.requestId,
    );
  }

  public async listRouteOptions(input: {
    tripId: string;
    userId: string;
    routeRequestId: string;
    requestId: string;
  }): Promise<Record<string, unknown>> {
    await this.requireTrip(input.tripId, input.userId);
    const result = await this.routeRequestResult(
      input.tripId,
      input.routeRequestId,
      input.requestId,
    );
    return {
      request_id: input.requestId,
      route_request_id: input.routeRequestId,
      recommended_option_id: result.recommended_option_id,
      items: result.options,
      sources: result.sources,
    };
  }

  private async routeRequestResult(
    tripId: string,
    routeRequestId: string,
    requestId: string,
  ): Promise<Record<string, unknown>> {
    const request = await this.deps.repo.getRouteRequest(
      tripId,
      routeRequestId,
    );
    if (!request) throw notFound("Route request was not found.");
    const now = this.now();
    const optionRows = await this.deps.repo.listRouteOptions(
      tripId,
      routeRequestId,
    );
    const weather = request.weather_snapshot_id
      ? await this.deps.repo.getWeatherById(tripId, request.weather_snapshot_id)
      : null;
    const traffic = request.traffic_snapshot_id
      ? await this.deps.repo.getTrafficById(tripId, request.traffic_snapshot_id)
      : null;
    const sourceIds = new Set<string>(optionRows.map((row) => row.source_id));
    if (weather) sourceIds.add(weather.source_id);
    if (traffic) sourceIds.add(traffic.source_id);
    const sources = await this.deps.repo.getSourcesByIds(tripId, [
      ...sourceIds,
    ]);

    const ordered = [...optionRows].sort((a, b) => {
      const rankA = a.rank ?? Number.MAX_SAFE_INTEGER;
      const rankB = b.rank ?? Number.MAX_SAFE_INTEGER;
      if (rankA !== rankB) return rankA - rankB;
      if (a.total_duration_seconds !== b.total_duration_seconds) {
        return a.total_duration_seconds - b.total_duration_seconds;
      }
      return a.id < b.id ? -1 : 1;
    });
    const options = ordered.map((row) =>
      routeOptionDto(row, request, now, {
        weather: weather?.source_id ?? null,
        traffic: traffic?.source_id ?? null,
      }),
    );
    const requestExpired = freshnessAt(request.expires_at, now) === "expired";
    const recommended = ordered.find((row) => row.recommended) ?? null;
    return {
      request_id: requestId,
      route_request: routeRequestDto(request, now),
      options,
      recommended_option_id:
        recommended && !requestExpired ? recommended.id : null,
      departure_recommendation: requestExpired
        ? null
        : request.departure_recommendation,
      facts: request.facts,
      limitations: request.limitations,
      sources: sources.map((row) => sourceDto(row, now)),
      weather: weather ? weatherDto(weather, now) : null,
      traffic: traffic ? trafficDto(traffic, now) : null,
    };
  }

  public async selectRouteOption(
    input: {
      tripId: string;
      userId: string;
      routeRequestId: string;
      optionId: string;
      requestId: string;
    },
    command: CommandContext,
  ): Promise<Record<string, unknown>> {
    await this.requireTrip(input.tripId, input.userId);
    const request = await this.deps.repo.getRouteRequest(
      input.tripId,
      input.routeRequestId,
    );
    if (!request) throw notFound("Route request was not found.");
    return this.deps.idempotency.execute(
      `route-request.select:${request.id}`,
      command,
      async () => {
        const options = await this.deps.repo.listRouteOptions(
          input.tripId,
          request.id,
        );
        const option = options.find((row) => row.id === input.optionId);
        if (!option)
          throw notFound("Route option was not found in this request.");
        if (freshnessAt(option.expires_at, this.now()) === "expired") {
          throw new AppError(
            "ROUTE_OPTION_EXPIRED",
            "conflict",
            409,
            "This route option has expired. Request routes again.",
          );
        }
        if (option.status !== "valid") {
          throw new AppError(
            "ROUTE_OPTION_NOT_SELECTABLE",
            "conflict",
            409,
            "This route option was excluded by the mobility policy and cannot be selected.",
            { status: option.status },
          );
        }
        await this.deps.repo.selectOption(input.tripId, request.id, option.id);
        await this.deps.activityLog.append({
          actorUserId: input.userId,
          action: "route_option.selected",
          resourceType: "route_request",
          resourceId: request.id,
          metadata: { trip_id: input.tripId, route_option_id: option.id },
        });
        return this.routeRequestResult(
          input.tripId,
          request.id,
          input.requestId,
        );
      },
    );
  }

  public async listRecommendations(input: {
    tripId: string;
    userId: string;
    requestId: string;
    includeExpired: boolean;
  }): Promise<Record<string, unknown>> {
    await this.requireTrip(input.tripId, input.userId);
    const now = this.now();
    const rows = await this.deps.repo.listRecommendations(input.tripId);
    const kept = rows.filter(
      (row) =>
        input.includeExpired || freshnessAt(row.expires_at, now) === "fresh",
    );
    const references = await this.deps.repo.listSourceReferences(
      input.tripId,
      "recommendation",
      kept.map((row) => row.id),
    );
    const byRecommendation = new Map<string, string[]>();
    for (const reference of references) {
      const current = byRecommendation.get(reference.entity_id) ?? [];
      current.push(reference.source_id);
      byRecommendation.set(reference.entity_id, current);
    }
    return {
      request_id: input.requestId,
      items: kept.map((row) =>
        recommendationDto(
          row,
          [...new Set(byRecommendation.get(row.id) ?? [])],
          now,
        ),
      ),
    };
  }
}

/** Source rows for the provider calls behind the evaluated options. */
function routeSourceRows(args: {
  tripId: string;
  evaluation: MobilityEvaluation;
  collected: GatheredEvaluation["collected"];
  origin: ContextPointRecord;
  destination: ContextPointRecord;
  departureAt: string;
  arrivalDeadline: string | null;
  retrievedAt: string;
  expiresAt: string;
}): { rows: SourceRow[]; idByKey: Map<string, string> } {
  const rows: SourceRow[] = [];
  const idByKey = new Map<string, string>();
  for (const key of new Set(
    args.evaluation.options.map((option) => option.source_key),
  )) {
    const audit = args.collected.audits.get(key);
    const id = randomUUID();
    idByKey.set(key, id);
    const isTransit = key === "here_intermodal_v8:transit";
    const mode = audit?.mode ?? "car";
    rows.push({
      id,
      trip_id: args.tripId,
      kind: "provider",
      provider: isTransit ? "here_intermodal_v8" : "here_routing_v8",
      url: null,
      title: isTransit
        ? `HERE Intermodal Routing API v8 transit routes from ${args.origin.label} to ${args.destination.label}`
        : `HERE Routing API v8 ${mode} route from ${args.origin.label} to ${args.destination.label}`,
      retrieved_at: args.retrievedAt,
      freshness: "fresh",
      expires_at: args.expiresAt,
      observed_for: jsonValue({
        from: args.departureAt,
        ...(args.arrivalDeadline ? { to: args.arrivalDeadline } : {}),
        timezone: args.origin.timezone,
      }),
      content_hash: null,
      metadata: jsonValue({
        audit_url: audit?.auditUrl ?? null,
        provider_request_id: audit?.providerRequestId ?? null,
        http_status: audit?.httpStatus ?? null,
      }),
      created_at: args.retrievedAt,
    });
  }
  return { rows, idByKey };
}

function engineError(error: MobilityEngineError): AppError {
  switch (error.code) {
    case "TRAFFIC_FACTS_MISSING":
    case "WEATHER_FACTS_MISSING":
    case "ROUTE_FACTS_MISSING":
    case "INPUT_INVALID":
      return new AppError(error.code, "validation", 422, error.message);
    default:
      return new AppError(error.code, "internal", 500, error.message);
  }
}

function optionRow(
  option: EvaluatedOption,
  context: {
    id: string;
    routeRequestId: string;
    tripId: string;
    sourceId: string;
    weather: WeatherSnapshotRow | null;
    traffic: TrafficSnapshotRow | null;
    policy: string;
    retrievedAt: string;
    expiresAt: string;
  },
): RouteOptionRow {
  const metrics = option.derived_metrics;
  return {
    id: context.id,
    route_request_id: context.routeRequestId,
    trip_id: context.tripId,
    provider: option.provider,
    provider_route_id: option.provider_route_id,
    transport_mode: option.transport_mode,
    source_id: context.sourceId,
    weather_snapshot_id: context.weather?.id ?? null,
    traffic_snapshot_id: context.traffic?.id ?? null,
    provider_facts: jsonValue(option.provider_facts),
    derived_metrics: jsonValue(metrics),
    cost: jsonValue(option.cost),
    risk: jsonValue(option.risk),
    score: option.score
      ? jsonValue({
          total: option.score.total,
          components: option.score.components,
          weights: option.score.weights,
        })
      : null,
    traffic_risk: option.risk.traffic,
    weather_risk: option.risk.weather,
    overall_risk: option.risk.overall,
    duration_seconds: Math.round(option.provider_facts.duration_seconds),
    total_duration_seconds: Math.round(metrics.total_duration_seconds),
    walking_minutes: metrics.walking_minutes,
    transfer_count: metrics.transfer_count,
    departure_at: metrics.departure_at,
    arrive_at: metrics.arrival_at,
    feasible: metrics.feasible,
    rank: option.score?.rank ?? null,
    status: option.status,
    exclusion_reasons: jsonValue(option.exclusion_reasons),
    recommended: option.recommended,
    policy_version: context.policy,
    retrieved_at: context.retrievedAt,
    expires_at: context.expiresAt,
    created_at: context.retrievedAt,
  };
}
