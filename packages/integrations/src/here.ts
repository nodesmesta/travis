import {
  callProviderJson,
  missingConfiguration,
  type ProviderJson,
} from "./provider-http.js";
import { ExternalDataError } from "./errors.js";

export type HereService =
  "router" | "intermodal" | "traffic" | "geocode" | "browse";

export const HERE_PROVIDER = "here";

const DEFAULT_BASE_URLS: Record<HereService, string> = {
  router: "https://router.hereapi.com",
  intermodal: "https://intermodal.router.hereapi.com",
  traffic: "https://data.traffic.hereapi.com",
  geocode: "https://geocode.search.hereapi.com",
  browse: "https://browse.search.hereapi.com",
};

export interface HereConfig {
  apiKey: string | undefined;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
  /**
   * Replaces provider hosts. Only the validation harness uses this, to point
   * the adapter at a local server that serves documented response shapes.
   */
  baseUrls?: Partial<Record<HereService, string>>;
}

export interface LatLng {
  latitude: number;
  longitude: number;
}

export type HereRoadMode = "car" | "taxi" | "pedestrian";

function assertCoordinate(point: LatLng, field: string): void {
  if (
    !Number.isFinite(point.latitude) ||
    !Number.isFinite(point.longitude) ||
    Math.abs(point.latitude) > 90 ||
    Math.abs(point.longitude) > 180
  ) {
    throw new ExternalDataError(
      "EXTERNAL_QUERY_INVALID",
      HERE_PROVIDER,
      `${field} must be a valid coordinate.`,
      422,
    );
  }
}

function assertZoned(value: string, field: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new ExternalDataError(
      "EXTERNAL_QUERY_INVALID",
      HERE_PROVIDER,
      `${field} must be an ISO date-time.`,
      422,
    );
  }
}

function pair(point: LatLng): string {
  return `${point.latitude},${point.longitude}`;
}

/**
 * One client for every HERE API (routing, intermodal, traffic, geocoding,
 * browse). Each method makes exactly one request. A missing key, a timeout, or
 * any provider error is thrown as an ExternalDataError; nothing is retried and
 * no other provider is tried.
 */
export class HereClient {
  public readonly provider = HERE_PROVIDER;

  public constructor(private readonly config: HereConfig) {}

  public get configured(): boolean {
    return Boolean(this.config.apiKey);
  }

  private async get(
    service: HereService,
    path: string,
    label: string,
    params: Array<[string, string]>,
  ): Promise<ProviderJson> {
    if (!this.config.apiKey) throw missingConfiguration(HERE_PROVIDER, "HERE");
    const base = this.config.baseUrls?.[service] ?? DEFAULT_BASE_URLS[service];
    const url = new URL(path, base.endsWith("/") ? base : `${base}/`);
    // `path` is relative to the host; keep it from escaping a test prefix.
    for (const [name, value] of params) url.searchParams.set(name, value);
    url.searchParams.set("apiKey", this.config.apiKey);
    return callProviderJson({
      provider: HERE_PROVIDER,
      label,
      url,
      timeoutMs: this.config.timeoutMs ?? 15_000,
      maxResponseBytes: this.config.maxResponseBytes ?? 2_000_000,
      fetchImpl: this.config.fetchImpl ?? fetch,
      keyParam: "apiKey",
    });
  }

  /** HERE Routing API v8, `GET /v8/routes`. Traffic-aware by default for a set departure time. */
  public async roadRoutes(request: {
    mode: HereRoadMode;
    origin: LatLng;
    destination: LatLng;
    departureAt: string;
  }): Promise<ProviderJson> {
    assertCoordinate(request.origin, "origin");
    assertCoordinate(request.destination, "destination");
    assertZoned(request.departureAt, "departureAt");
    return this.get("router", "v8/routes", "HERE Routing", [
      ["transportMode", request.mode],
      ["origin", pair(request.origin)],
      ["destination", pair(request.destination)],
      ["departureTime", request.departureAt],
      ["return", "summary,typicalDuration"],
    ]);
  }

  /** HERE Intermodal Routing API v8, `GET /v8/routes`. */
  public async intermodalRoutes(request: {
    origin: LatLng;
    destination: LatLng;
    departureAt: string;
    alternatives?: number;
  }): Promise<ProviderJson> {
    assertCoordinate(request.origin, "origin");
    assertCoordinate(request.destination, "destination");
    assertZoned(request.departureAt, "departureAt");
    return this.get("intermodal", "v8/routes", "HERE Intermodal Routing", [
      ["origin", pair(request.origin)],
      ["destination", pair(request.destination)],
      ["departureTime", request.departureAt],
      ["alternatives", String(request.alternatives ?? 2)],
    ]);
  }

  /** HERE Traffic API v7 flow for a circular area. */
  public async trafficFlow(
    area: LatLng & { radiusMeters: number },
  ): Promise<ProviderJson> {
    assertCoordinate(area, "area");
    return this.get("traffic", "v7/flow", "HERE Traffic flow", [
      ["in", `circle:${pair(area)};r=${Math.round(area.radiusMeters)}`],
      ["locationReferencing", "none"],
    ]);
  }

  /** HERE Traffic API v7 incidents for a circular area. */
  public async trafficIncidents(
    area: LatLng & { radiusMeters: number },
  ): Promise<ProviderJson> {
    assertCoordinate(area, "area");
    return this.get("traffic", "v7/incidents", "HERE Traffic incidents", [
      ["in", `circle:${pair(area)};r=${Math.round(area.radiusMeters)}`],
      ["locationReferencing", "none"],
    ]);
  }

  /** HERE Geocoding and Search API v7 `GET /v1/geocode`. */
  public async geocode(request: {
    query: string;
    countryCode?: string;
    limit?: number;
    language?: string;
  }): Promise<ProviderJson> {
    if (request.query.trim().length === 0) {
      throw new ExternalDataError(
        "EXTERNAL_QUERY_INVALID",
        HERE_PROVIDER,
        "Geocoding needs a non-blank query.",
        422,
      );
    }
    const params: Array<[string, string]> = [
      ["q", request.query],
      ["limit", String(request.limit ?? 5)],
    ];
    if (request.countryCode)
      params.push(["in", `countryCode:${request.countryCode}`]);
    if (request.language) params.push(["lang", request.language]);
    return this.get("geocode", "v1/geocode", "HERE Geocoding", params);
  }

  /** HERE Geocoding and Search API v7 `GET /v1/browse`, ranked by distance from the center. */
  public async browse(request: {
    center: LatLng;
    radiusMeters: number;
    categories: string[];
    limit: number;
    language?: string;
  }): Promise<ProviderJson> {
    assertCoordinate(request.center, "center");
    const params: Array<[string, string]> = [
      ["at", pair(request.center)],
      [
        "in",
        `circle:${pair(request.center)};r=${Math.round(request.radiusMeters)}`,
      ],
      ["categories", request.categories.join(",")],
      ["limit", String(request.limit)],
    ];
    if (request.language) params.push(["lang", request.language]);
    return this.get("browse", "v1/browse", "HERE Browse", params);
  }
}
