import { MOBILITY_POLICY_V1, type MobilityPolicy } from "../mobility/policy.js";
import {
  classifyWeatherPoint,
  selectForecastPoint,
} from "../mobility/engine.js";
import type { WeatherFacts, WeatherPoint } from "../mobility/types.js";
import { ALERT_POLICY_V1, type AlertPolicy } from "./policy.js";
import { localIso, localLabel } from "./time.js";
import type {
  AgendaInput,
  AlertDecision,
  LegInput,
  TrafficSnapshotInput,
  WeatherSnapshotInput,
} from "./types.js";

/**
 * Alert rules. Each function takes facts that were already loaded and a clock
 * value and returns one decision. Nothing here reads a database or a provider,
 * and no language model decides whether an alert exists.
 *
 * Shared rules for every decision:
 *  - A snapshot that is missing or past `expires_at` blocks the rule. It never
 *    produces an alert and never produces "all clear".
 *  - `factual_summary` states only values from the snapshot or the journey leg.
 *    `recommendation_summary` is the suggestion and is written separately.
 *  - The deduplication key names the trip, the entity, the alert type, the level,
 *    the local time window, and the policy version.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export interface RuleContext {
  now: Date;
  alertPolicy?: AlertPolicy;
  mobilityPolicy?: MobilityPolicy;
}

function policies(context: RuleContext): {
  alert: AlertPolicy;
  mobility: MobilityPolicy;
  nowMs: number;
} {
  return {
    alert: context.alertPolicy ?? ALERT_POLICY_V1,
    mobility: context.mobilityPolicy ?? MOBILITY_POLICY_V1,
    nowMs: context.now.getTime(),
  };
}

function noAction(codes: string[], summary: string): AlertDecision {
  return { decision: "no_action", reason_codes: codes, summary };
}

function blockedMissing(codes: string[], summary: string): AlertDecision {
  return {
    decision: "blocked",
    error_code: "JOB_PRECONDITION_FAILED",
    reason_codes: codes,
    summary,
  };
}

function blockedExpired(codes: string[], summary: string): AlertDecision {
  return {
    decision: "blocked",
    error_code: "JOB_PROVIDER_DATA_EXPIRED",
    reason_codes: codes,
    summary,
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Key shared by all three alert types: trip, entity, type, level, local window, policy. */
export function deduplicationKey(parts: {
  tripId: string;
  entityId: string;
  alertType: string;
  level: string;
  windowMs: number;
  timeZone: string;
  policyVersion: string;
}): string {
  return [
    parts.tripId,
    parts.entityId,
    parts.alertType,
    parts.level,
    localIso(parts.windowMs, parts.timeZone),
    parts.policyVersion,
  ].join(":");
}

// ---------------------------------------------------------------------------
// Departure reminder

export interface DepartureReminderInput {
  leg: LegInput;
  /** Departure time named by the job, as it was when the job was planned. */
  plannedDepartureAt: string;
}

export function evaluateDepartureReminder(
  input: DepartureReminderInput,
  context: RuleContext,
): AlertDecision {
  const { alert: policy, nowMs } = policies(context);
  const { leg } = input;
  if (leg.status !== "planned") {
    return noAction(
      ["LEG_NOT_PLANNED"],
      `The journey leg is ${leg.status}, so no reminder is needed.`,
    );
  }
  const departureMs = Date.parse(leg.departure_at);
  if (departureMs !== Date.parse(input.plannedDepartureAt)) {
    return noAction(
      ["SCHEDULE_CHANGED"],
      "The departure time changed after this reminder was planned. A reminder for the new time is planned separately.",
    );
  }
  if (nowMs >= departureMs) {
    return noAction(
      ["DEPARTURE_ALREADY_PASSED"],
      "The planned departure time has passed, so the reminder was not created.",
    );
  }
  const minutesLeft = Math.floor((departureMs - nowMs) / MINUTE_MS);
  const when = localLabel(departureMs, leg.timezone);
  const deadline =
    leg.arrival_deadline === null
      ? ""
      : ` You need to arrive by ${localLabel(Date.parse(leg.arrival_deadline), leg.timezone)}.`;
  const retrievedAt = iso(nowMs);
  const expiresAt = iso(departureMs);
  return {
    decision: "create_alert",
    alert: {
      alert_type: "departure_reminder",
      severity: "info",
      title: `Time to head to ${leg.destination_label}`,
      factual_summary: `Your journey from ${leg.origin_label} to ${leg.destination_label} is planned to depart at ${when}.${deadline}`,
      recommendation_summary: `Leave within ${minutesLeft} ${minutesLeft === 1 ? "minute" : "minutes"} to keep to your plan. Open Mobility for the latest route options.`,
      source_ids: [],
      internal_source: {
        title: `Journey leg from ${leg.origin_label} to ${leg.destination_label}`,
        provider: "travis_journey_leg",
        retrieved_at: retrievedAt,
        expires_at: expiresAt,
        observed_for: {
          from: retrievedAt,
          to: expiresAt,
          timezone: leg.timezone,
        },
      },
      retrieved_at: retrievedAt,
      expires_at: expiresAt,
      deduplication_key: deduplicationKey({
        tripId: leg.trip_id,
        entityId: leg.id,
        alertType: "departure_reminder",
        level: "info",
        windowMs: departureMs,
        timeZone: leg.timezone,
        policyVersion: policy.version,
      }),
      reason_codes: ["DEPARTURE_APPROACHING"],
      policy_version: policy.version,
      agenda_item_id: null,
      journey_leg_id: leg.id,
      metadata: {
        departure_at: leg.departure_at,
        departure_local: localIso(departureMs, leg.timezone),
        minutes_until_departure: minutesLeft,
        basis: "journey_leg_time_only",
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Traffic risk

export interface TrafficRiskInput {
  leg: LegInput;
  /** Latest stored snapshot for the leg's origin and destination, expired or not. Null when none exists. */
  snapshot: TrafficSnapshotInput | null;
}

function jamText(snapshot: TrafficSnapshotInput): string {
  const parts: string[] = [];
  if (snapshot.average_jam_factor !== null) {
    parts.push(
      `an average jam factor of ${snapshot.average_jam_factor.toFixed(1)} out of 10`,
    );
  }
  if (snapshot.incident_count > 0) {
    parts.push(
      `${snapshot.incident_count} reported ${snapshot.incident_count === 1 ? "incident" : "incidents"}`,
    );
  }
  if (snapshot.closed_segment_count > 0) {
    parts.push(
      `${snapshot.closed_segment_count} closed road ${snapshot.closed_segment_count === 1 ? "segment" : "segments"}`,
    );
  }
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

export function evaluateTrafficRisk(
  input: TrafficRiskInput,
  context: RuleContext,
): AlertDecision {
  const { alert: policy, nowMs } = policies(context);
  const { leg, snapshot } = input;
  if (leg.status !== "planned" && leg.status !== "in_progress") {
    return noAction(
      ["LEG_NOT_ACTIVE"],
      `The journey leg is ${leg.status}, so traffic is not evaluated.`,
    );
  }
  const departureMs = Date.parse(leg.departure_at);
  if (departureMs <= nowMs) {
    return noAction(
      ["LEG_ALREADY_DEPARTED"],
      "The journey leg has already departed.",
    );
  }
  if (departureMs - nowMs > policy.traffic_horizon_minutes * MINUTE_MS) {
    return noAction(
      ["TRAFFIC_OUTSIDE_LIVE_HORIZON"],
      `Area traffic describes conditions now. The leg departs in more than ${policy.traffic_horizon_minutes} minutes, so it is not evaluated yet.`,
    );
  }
  if (snapshot === null) {
    return blockedMissing(
      ["TRAFFIC_SNAPSHOT_MISSING"],
      "No traffic snapshot exists for this journey leg, so no alert was created.",
    );
  }
  if (Date.parse(snapshot.expires_at) <= nowMs) {
    return blockedExpired(
      ["TRAFFIC_SNAPSHOT_EXPIRED"],
      "The latest traffic snapshot has expired, so no alert was created from it.",
    );
  }
  if (snapshot.traffic_level === "unknown") {
    return noAction(
      ["TRAFFIC_LEVEL_UNKNOWN"],
      "The provider data was not enough to rate traffic, so no alert was created.",
    );
  }
  if (snapshot.traffic_level === "low") {
    return noAction(
      ["TRAFFIC_LEVEL_LOW"],
      "Traffic around the route is below the alert threshold.",
    );
  }
  const level = snapshot.traffic_level;
  const retrievedMs = Date.parse(snapshot.retrieved_at);
  const expiresMs = Math.min(Date.parse(snapshot.expires_at), departureMs);
  if (expiresMs <= retrievedMs) {
    return noAction(
      ["WINDOW_CLOSED"],
      "The snapshot is not valid until the departure time.",
    );
  }
  const extra = policy.traffic_extra_minutes[level];
  const deadline =
    leg.arrival_deadline === null
      ? ""
      : ` Your arrival deadline is ${localLabel(Date.parse(leg.arrival_deadline), leg.timezone)}.`;
  const codes = [
    level === "high" ? "TRAFFIC_LEVEL_HIGH" : "TRAFFIC_LEVEL_MEDIUM",
  ];
  if (snapshot.incident_count > 0) codes.push("TRAFFIC_INCIDENTS_PRESENT");
  if (snapshot.closed_segment_count > 0) codes.push("TRAFFIC_ROAD_CLOSURE");
  return {
    decision: "create_alert",
    alert: {
      alert_type: "traffic_risk",
      severity: level === "high" ? "high" : "medium",
      title:
        level === "high"
          ? `Heavy traffic on the way to ${leg.destination_label}`
          : `Traffic is building on the way to ${leg.destination_label}`,
      factual_summary: `Traffic around the route from ${leg.origin_label} to ${leg.destination_label} is rated ${level}${jamText(snapshot)}. Planned departure: ${localLabel(departureMs, leg.timezone)}.`,
      recommendation_summary: `Consider leaving about ${extra} minutes earlier than planned, or compare routes in Mobility before you go.${deadline}`,
      source_ids: [snapshot.source_id],
      internal_source: null,
      retrieved_at: snapshot.retrieved_at,
      expires_at: iso(expiresMs),
      deduplication_key: deduplicationKey({
        tripId: leg.trip_id,
        entityId: leg.id,
        alertType: "traffic_risk",
        level,
        windowMs: departureMs,
        timeZone: leg.timezone,
        policyVersion: policy.version,
      }),
      reason_codes: codes,
      policy_version: policy.version,
      agenda_item_id: null,
      journey_leg_id: leg.id,
      metadata: {
        traffic_snapshot_id: snapshot.id,
        traffic_level: level,
        average_jam_factor: snapshot.average_jam_factor,
        incident_count: snapshot.incident_count,
        closed_segment_count: snapshot.closed_segment_count,
        departure_local: localIso(departureMs, leg.timezone),
        suggested_extra_minutes: extra,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Weather risk

export interface WeatherRiskInput {
  agenda: AgendaInput;
  /** Latest stored snapshot for the agenda's context point, expired or not. Null when none exists. */
  snapshot: WeatherSnapshotInput | null;
}

function weatherFactsOf(snapshot: WeatherSnapshotInput): WeatherFacts {
  return {
    latitude: 0,
    longitude: 0,
    timezone: snapshot.timezone,
    observed_at: snapshot.observed_at,
    current: snapshot.current,
    hourly: snapshot.hourly,
    daily: snapshot.daily,
    alerts: [],
    retrieved_at: snapshot.retrieved_at,
    expires_at: snapshot.expires_at,
  };
}

interface WeatherDrivers {
  precipitation: boolean;
  wind: boolean;
  visibility: boolean;
  condition: boolean;
}

/** Which measured values reached at least the medium threshold of the mobility policy. */
export function weatherDrivers(
  point: WeatherPoint,
  policy: MobilityPolicy,
): WeatherDrivers {
  const t = policy.weather_thresholds;
  const rules = policy.weather_condition_rules;
  const id = point.condition_id;
  const inRange = (ranges: Array<[number, number]>): boolean =>
    id !== null && ranges.some(([from, to]) => id >= from && id <= to);
  const rainy =
    id !== null &&
    (rules.high_ids.includes(id) ||
      rules.medium_ids.includes(id) ||
      inRange(rules.high_ranges) ||
      inRange(rules.medium_ranges));
  return {
    precipitation:
      (point.precipitation_probability !== null &&
        point.precipitation_probability >=
          t.precipitation_probability_medium) ||
      (point.precipitation_mm !== null &&
        point.precipitation_mm >= t.precipitation_mm_medium),
    wind:
      point.wind_speed_ms !== null &&
      point.wind_speed_ms >= t.wind_speed_ms_medium,
    visibility:
      point.visibility_m !== null &&
      point.visibility_m <= t.visibility_m_medium,
    condition: rainy,
  };
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function weatherFactText(point: WeatherPoint): string {
  const parts: string[] = [];
  if (point.description) parts.push(point.description);
  else if (point.condition) parts.push(point.condition);
  if (point.precipitation_probability !== null) {
    parts.push(
      `${percent(point.precipitation_probability)} chance of precipitation`,
    );
  }
  if (point.precipitation_mm !== null && point.precipitation_mm > 0) {
    parts.push(`${point.precipitation_mm} mm/h expected`);
  }
  if (point.wind_speed_ms !== null) {
    parts.push(`wind ${point.wind_speed_ms} m/s`);
  }
  if (point.visibility_m !== null) {
    parts.push(`visibility ${point.visibility_m} m`);
  }
  return parts.join(", ");
}

export function evaluateWeatherRisk(
  input: WeatherRiskInput,
  context: RuleContext,
): AlertDecision {
  const { alert: policy, mobility, nowMs } = policies(context);
  const { agenda, snapshot } = input;
  if (agenda.status !== "planned" && agenda.status !== "confirmed") {
    return noAction(
      ["AGENDA_NOT_ACTIVE"],
      `The agenda item is ${agenda.status}, so weather is not evaluated.`,
    );
  }
  if (agenda.exposure !== "outdoor" && agenda.exposure !== "both") {
    return noAction(
      [agenda.exposure === null ? "EXPOSURE_NOT_RECORDED" : "EXPOSURE_INDOOR"],
      "The agenda item is not recorded as an outdoor activity, so weather is not evaluated.",
    );
  }
  const startMs = Date.parse(agenda.start_at);
  const endMs = Date.parse(agenda.end_at);
  if (endMs <= nowMs) {
    return noAction(["AGENDA_ALREADY_ENDED"], "The agenda item has ended.");
  }
  if (startMs - nowMs > policy.weather_horizon_hours * HOUR_MS) {
    return noAction(
      ["WEATHER_OUTSIDE_HORIZON"],
      `The activity starts in more than ${policy.weather_horizon_hours} hours, so it is not evaluated yet.`,
    );
  }
  if (!agenda.context_resolved || agenda.context_point_id === null) {
    return blockedMissing(
      ["CONTEXT_UNRESOLVED"],
      "The agenda item has no resolved location, so weather cannot be checked.",
    );
  }
  if (snapshot === null) {
    return blockedMissing(
      ["WEATHER_SNAPSHOT_MISSING"],
      "No weather snapshot exists for this location, so no alert was created.",
    );
  }
  if (Date.parse(snapshot.expires_at) <= nowMs) {
    return blockedExpired(
      ["WEATHER_SNAPSHOT_EXPIRED"],
      "The latest weather snapshot has expired, so no alert was created from it.",
    );
  }
  const atMs = Math.max(startMs, nowMs);
  const point = selectForecastPoint(weatherFactsOf(snapshot), atMs, mobility);
  if (point === null) {
    return noAction(
      ["FORECAST_NOT_AVAILABLE_FOR_TIME"],
      "The forecast does not cover the start of the activity.",
    );
  }
  const assessment = classifyWeatherPoint(point, mobility);
  if (assessment.level === "unknown") {
    return noAction(
      ["WEATHER_LEVEL_UNKNOWN"],
      "The forecast did not contain enough values to rate the weather.",
    );
  }
  if (assessment.level === "low") {
    return noAction(
      ["WEATHER_LEVEL_LOW"],
      "The forecast is below the alert threshold.",
    );
  }
  const level = assessment.level;
  const retrievedMs = Date.parse(snapshot.retrieved_at);
  const expiresMs = Math.min(Date.parse(snapshot.expires_at), endMs);
  if (expiresMs <= retrievedMs) {
    return noAction(
      ["WINDOW_CLOSED"],
      "The snapshot is not valid until the end of the activity.",
    );
  }
  const drivers = weatherDrivers(point, mobility);
  const codes = [
    level === "high" ? "WEATHER_LEVEL_HIGH" : "WEATHER_LEVEL_MEDIUM",
  ];
  if (drivers.precipitation || drivers.condition)
    codes.push("WEATHER_PRECIPITATION");
  if (drivers.wind) codes.push("WEATHER_WIND");
  if (drivers.visibility) codes.push("WEATHER_LOW_VISIBILITY");
  const place = agenda.context_label ?? "the activity location";
  const advice =
    drivers.precipitation || drivers.condition
      ? "Take rain protection, or consider moving the activity indoors or to another time."
      : "Consider moving the activity indoors or to another time.";
  return {
    decision: "create_alert",
    alert: {
      alert_type: "weather_risk",
      severity: level === "high" ? "high" : "medium",
      title:
        level === "high"
          ? `Severe weather expected for ${agenda.title}`
          : `Weather may affect ${agenda.title}`,
      factual_summary: `The forecast for ${place} around ${localLabel(atMs, agenda.timezone)} shows ${weatherFactText(point)}. The activity starts at ${localLabel(startMs, agenda.timezone)}.`,
      recommendation_summary: `${advice} Your itinerary has not been changed.`,
      source_ids: [snapshot.source_id],
      internal_source: null,
      retrieved_at: snapshot.retrieved_at,
      expires_at: iso(expiresMs),
      deduplication_key: deduplicationKey({
        tripId: agenda.trip_id,
        entityId: agenda.id,
        alertType: "weather_risk",
        level,
        windowMs: startMs,
        timeZone: agenda.timezone,
        policyVersion: policy.version,
      }),
      reason_codes: codes,
      policy_version: policy.version,
      agenda_item_id: agenda.id,
      journey_leg_id: null,
      metadata: {
        weather_snapshot_id: snapshot.id,
        weather_level: level,
        forecast_point_at: point.at,
        forecast_granularity: point.granularity,
        start_local: localIso(startMs, agenda.timezone),
      },
    },
  };
}
