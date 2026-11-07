import { ExternalDataError } from "./errors.js";
import {
  asRecord,
  callProviderJson,
  finiteNumber,
  invalidResponse,
  missingConfiguration,
  nonBlankString,
  type ProviderJson,
} from "./provider-http.js";

export const OPENWEATHER_PROVIDER = "openweather";

/** Provider id stored on sources and weather snapshots. */
export const OPENWEATHER_SNAPSHOT_PROVIDER = "openweather_free_2_5";

/** The free forecast has one point every three hours. */
export const OPENWEATHER_FORECAST_STEP_MINUTES = 180;

export interface OpenWeatherConfig {
  apiKey: string | undefined;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
  /** Replaces the host. Only the validation harness uses this. */
  baseUrl?: string;
}

export interface OpenWeatherSnapshot {
  current: ProviderJson;
  forecast: ProviderJson;
}

/**
 * OpenWeather client for the plan that needs no subscription: current weather
 * (`data/2.5/weather`) and the 5 day / 3 hour forecast (`data/2.5/forecast`).
 * Metric units. A snapshot needs both requests; if either fails the whole
 * snapshot fails. No retry and no other weather provider.
 */
export class OpenWeatherClient {
  public readonly provider = OPENWEATHER_PROVIDER;

  public constructor(private readonly config: OpenWeatherConfig) {}

  public get configured(): boolean {
    return Boolean(this.config.apiKey);
  }

  public currentWeather(point: Coordinate): Promise<ProviderJson> {
    return this.get("data/2.5/weather", "OpenWeather current weather", point);
  }

  public forecast(point: Coordinate): Promise<ProviderJson> {
    return this.get("data/2.5/forecast", "OpenWeather forecast", point);
  }

  public async snapshot(point: Coordinate): Promise<OpenWeatherSnapshot> {
    const [current, forecast] = await Promise.all([
      this.currentWeather(point),
      this.forecast(point),
    ]);
    return { current, forecast };
  }

  private get(
    path: string,
    label: string,
    point: Coordinate,
  ): Promise<ProviderJson> {
    if (!this.config.apiKey) {
      throw missingConfiguration(OPENWEATHER_PROVIDER, "OpenWeather");
    }
    if (
      !Number.isFinite(point.latitude) ||
      !Number.isFinite(point.longitude) ||
      Math.abs(point.latitude) > 90 ||
      Math.abs(point.longitude) > 180
    ) {
      throw new ExternalDataError(
        "EXTERNAL_QUERY_INVALID",
        OPENWEATHER_PROVIDER,
        "Weather needs a valid coordinate.",
        422,
      );
    }
    const base = this.config.baseUrl ?? "https://api.openweathermap.org";
    const url = new URL(path, base.endsWith("/") ? base : `${base}/`);
    url.searchParams.set("lat", String(point.latitude));
    url.searchParams.set("lon", String(point.longitude));
    url.searchParams.set("units", "metric");
    url.searchParams.set("appid", this.config.apiKey);
    return callProviderJson({
      provider: OPENWEATHER_PROVIDER,
      label,
      url,
      timeoutMs: this.config.timeoutMs ?? 15_000,
      maxResponseBytes: this.config.maxResponseBytes ?? 2_000_000,
      fetchImpl: this.config.fetchImpl ?? fetch,
      keyParam: "appid",
    });
  }
}

export interface Coordinate {
  latitude: number;
  longitude: number;
}

// ---------------------------------------------------------------------------
// Normalization

export interface NormalizedWeatherPoint {
  at: string;
  granularity: "current" | "hourly" | "three_hourly" | "daily";
  /** Minutes between forecast points. Absent for current and daily points. */
  interval_minutes?: number;
  temperature_c: number | null;
  precipitation_probability: number | null;
  /** Average millimeters per hour over the point's interval. */
  precipitation_mm: number | null;
  wind_speed_ms: number | null;
  visibility_m: number | null;
  condition_id: number | null;
  condition: string | null;
  description: string | null;
}

export interface NormalizedWeather {
  latitude: number;
  longitude: number;
  timezone: string;
  observed_at: string | null;
  current: NormalizedWeatherPoint | null;
  /** Forecast points. Three hours apart on the plan without a subscription. */
  hourly: NormalizedWeatherPoint[];
  daily: NormalizedWeatherPoint[];
  alerts: Array<{
    sender: string | null;
    event: string;
    start: string | null;
    end: string | null;
  }>;
  forecast_interval_minutes: number | null;
  /** Time of the last forecast point; later moments have no forecast. */
  forecast_ends_at: string | null;
}

const MAX_FORECAST_POINTS = 40;

function epoch(value: unknown, field: string): string {
  const seconds = finiteNumber(value);
  if (seconds === null || seconds <= 0) {
    throw invalidResponse(
      OPENWEATHER_PROVIDER,
      `OpenWeather returned ${field} without a valid timestamp.`,
    );
  }
  return new Date(seconds * 1000).toISOString();
}

function ranged(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | null {
  if (value === undefined || value === null) return null;
  const number = finiteNumber(value);
  if (number === null || number < min || number > max) {
    throw invalidResponse(
      OPENWEATHER_PROVIDER,
      `OpenWeather returned ${field} outside the plausible range.`,
    );
  }
  return number;
}

/** Thunderstorm, drizzle, rain, and snow condition ids. */
function isPrecipitationCondition(id: number | null): boolean {
  return id !== null && id >= 200 && id < 700;
}

/**
 * OpenWeather leaves `rain` out when there is none. A dry condition without
 * a `rain` object is read as 0 mm. A precipitation condition without an amount
 * stays null, because the amount is genuinely unknown.
 */
function rainPerHour(
  rain: unknown,
  window: "1h" | "3h",
  conditionId: number | null,
): number | null {
  const record = asRecord(rain);
  const raw = record ? record[window] : undefined;
  if (raw === undefined || raw === null) {
    return isPrecipitationCondition(conditionId) ? null : 0;
  }
  const volume = ranged(raw, `rain.${window}`, 0, 3000);
  if (volume === null) return null;
  const perHour = window === "3h" ? volume / 3 : volume;
  return Math.round(perHour * 100) / 100;
}

function readPoint(
  value: unknown,
  kind: "current" | "forecast",
): NormalizedWeatherPoint {
  const point = asRecord(value);
  if (!point) {
    throw invalidResponse(
      OPENWEATHER_PROVIDER,
      "OpenWeather returned a malformed weather entry.",
    );
  }
  const main = asRecord(point.main);
  if (!main) {
    throw invalidResponse(
      OPENWEATHER_PROVIDER,
      "OpenWeather returned a weather entry without measurements.",
    );
  }
  const weather = Array.isArray(point.weather)
    ? asRecord(point.weather[0])
    : null;
  const rawConditionId = weather ? finiteNumber(weather.id) : null;
  const conditionId =
    rawConditionId !== null && Number.isInteger(rawConditionId)
      ? rawConditionId
      : null;
  return {
    at: epoch(point.dt, "dt"),
    granularity: kind === "current" ? "current" : "three_hourly",
    ...(kind === "forecast"
      ? { interval_minutes: OPENWEATHER_FORECAST_STEP_MINUTES }
      : {}),
    temperature_c: ranged(main.temp, "main.temp", -90, 70),
    precipitation_probability:
      kind === "forecast" ? ranged(point.pop, "pop", 0, 1) : null,
    precipitation_mm: rainPerHour(
      point.rain,
      kind === "current" ? "1h" : "3h",
      conditionId,
    ),
    wind_speed_ms: ranged(asRecord(point.wind)?.speed, "wind.speed", 0, 150),
    visibility_m: ranged(point.visibility, "visibility", 0, 100000),
    condition_id: conditionId,
    condition: weather ? nonBlankString(weather.main) : null,
    description: weather ? nonBlankString(weather.description) : null,
  };
}

/**
 * Reads the two free-plan answers requested with `units=metric`.
 *
 * `timezone` is the IANA zone of the place (from the context point), because
 * OpenWeather returns only a UTC offset. Missing optional fields stay null; a
 * malformed field is an error, not a guess. The forecast covers about five
 * days, so `forecast_ends_at` marks where it stops.
 */
export function normalizeFreeTier(input: {
  current: unknown;
  forecast: unknown;
  timezone: string;
}): NormalizedWeather {
  const currentRoot = asRecord(input.current);
  const forecastRoot = asRecord(input.forecast);
  if (!currentRoot || !forecastRoot) {
    throw invalidResponse(
      OPENWEATHER_PROVIDER,
      "OpenWeather answer was not a JSON object.",
    );
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: input.timezone }).format();
  } catch {
    throw invalidResponse(
      OPENWEATHER_PROVIDER,
      "Weather needs a valid IANA timezone for the place.",
    );
  }
  const coord = asRecord(currentRoot.coord);
  const latitude = finiteNumber(coord?.lat);
  const longitude = finiteNumber(coord?.lon);
  if (latitude === null || longitude === null) {
    throw invalidResponse(
      OPENWEATHER_PROVIDER,
      "OpenWeather answer had no location.",
    );
  }
  const list = forecastRoot.list;
  if (!Array.isArray(list)) {
    throw invalidResponse(
      OPENWEATHER_PROVIDER,
      "OpenWeather forecast had no entries array.",
    );
  }
  const current = readPoint(currentRoot, "current");
  const hourly = list
    .slice(0, MAX_FORECAST_POINTS)
    .map((entry) => readPoint(entry, "forecast"));
  return {
    latitude,
    longitude,
    timezone: input.timezone,
    observed_at: current.at,
    current,
    hourly,
    daily: [],
    alerts: [],
    forecast_interval_minutes:
      hourly.length > 0 ? OPENWEATHER_FORECAST_STEP_MINUTES : null,
    forecast_ends_at:
      hourly.length > 0
        ? (hourly[hourly.length - 1] as NormalizedWeatherPoint).at
        : null,
  };
}

export function isEmptyWeather(weather: NormalizedWeather): boolean {
  return (
    weather.current === null &&
    weather.hourly.length === 0 &&
    weather.daily.length === 0
  );
}
