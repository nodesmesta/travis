import {
  MobilityEngineError,
  type ComfortPriority,
  type Criticality,
  type TransportMode,
} from "./types.js";

/**
 * Versioned mobility policy. Every number the engine uses to judge risk,
 * buffer, or ranking lives here, so a stored recommendation can be explained
 * and reproduced from its `policy_version`.
 *
 * These are product policy values chosen for the demo, not provider facts.
 * Change a value only together with a new `version`.
 */
export interface MobilityPolicy {
  version: string;
  /** Label for amounts that are known without a provider, such as walking at zero cost. */
  currency: string;
  minimum_buffer_minutes: Record<Criticality, number>;
  transfer_buffer_minutes: number;
  /** Added when walking exposure meets high weather risk. */
  weather_buffer_minutes: number;
  traffic_buffer_minutes: { medium: number; high: number };
  /** Walking at or above this many minutes counts as exposure to weather. */
  weather_exposure_walking_minutes: number;
  traffic_thresholds: {
    delay_ratio_medium: number;
    delay_ratio_high: number;
    jam_factor_medium: number;
    jam_factor_high: number;
  };
  weather_thresholds: {
    precipitation_probability_medium: number;
    precipitation_probability_high: number;
    precipitation_mm_medium: number;
    precipitation_mm_high: number;
    wind_speed_ms_medium: number;
    wind_speed_ms_high: number;
    /** Visibility at or below these meters raises risk. */
    visibility_m_medium: number;
    visibility_m_high: number;
  };
  /** OpenWeather condition ids. Ranges are inclusive. */
  weather_condition_rules: {
    high_ids: number[];
    high_ranges: Array<[number, number]>;
    medium_ids: number[];
    medium_ranges: Array<[number, number]>;
  };
  /** Max distance between the arrival time and an hourly forecast point. */
  forecast_match_tolerance_minutes: number;
  /**
   * Area traffic describes conditions now. It is only used for a leg that
   * departs within this many minutes; a later leg gets no traffic fact.
   */
  traffic_live_horizon_minutes: number;
  weights: {
    time: number;
    cost: number;
    walking: number;
    transfers: number;
    traffic: number;
    weather: number;
    comfort: number;
    preference: number;
  };
  /** Score for a risk the engine could not determine. Never treated as low. */
  unknown_risk_score: number;
  mode_comfort: Record<TransportMode, number>;
  comfort_priority_multiplier: Record<ComfortPriority, number>;
  /** Multiplier on the traffic weight when the user avoids heavy traffic. */
  avoid_heavy_traffic_multiplier: number;
  ttl_minutes: {
    route: number;
    traffic: number;
    weather: number;
    recommendation: number;
  };
  defaults: {
    max_walking_minutes: number;
    max_transfers: number;
  };
}

export const MOBILITY_POLICY_V1: MobilityPolicy = {
  version: "mobility-v1",
  currency: "IDR",
  minimum_buffer_minutes: {
    normal: 10,
    important_meeting: 20,
    airport_departure: 45,
  },
  transfer_buffer_minutes: 5,
  weather_buffer_minutes: 5,
  traffic_buffer_minutes: { medium: 5, high: 10 },
  weather_exposure_walking_minutes: 5,
  traffic_thresholds: {
    delay_ratio_medium: 0.15,
    delay_ratio_high: 0.4,
    jam_factor_medium: 4,
    jam_factor_high: 7,
  },
  weather_thresholds: {
    precipitation_probability_medium: 0.4,
    precipitation_probability_high: 0.7,
    precipitation_mm_medium: 1,
    precipitation_mm_high: 4,
    wind_speed_ms_medium: 8,
    wind_speed_ms_high: 14,
    visibility_m_medium: 4000,
    visibility_m_high: 1000,
  },
  weather_condition_rules: {
    high_ids: [502, 503, 504, 511, 522, 531, 781],
    high_ranges: [[200, 232]],
    medium_ids: [500, 501, 520, 521, 602, 611, 612, 613, 615, 616, 620, 621],
    medium_ranges: [],
  },
  forecast_match_tolerance_minutes: 90,
  traffic_live_horizon_minutes: 180,
  weights: {
    time: 0.3,
    cost: 0.1,
    walking: 0.1,
    transfers: 0.1,
    traffic: 0.15,
    weather: 0.1,
    comfort: 0.1,
    preference: 0.05,
  },
  unknown_risk_score: 0.5,
  mode_comfort: { taxi: 1, car: 0.9, transit: 0.6, pedestrian: 0.4 },
  comfort_priority_multiplier: { low: 0.5, medium: 1, high: 2 },
  avoid_heavy_traffic_multiplier: 2,
  ttl_minutes: { route: 15, traffic: 10, weather: 30, recommendation: 15 },
  defaults: { max_walking_minutes: 15, max_transfers: 2 },
};

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Fails when a value the engine needs is missing. The engine never falls back
 * to a hidden default (Segment 06: BUFFER_POLICY_MISSING).
 */
export function assertPolicyComplete(policy: MobilityPolicy): void {
  const bufferValues: unknown[] = [
    policy.minimum_buffer_minutes?.normal,
    policy.minimum_buffer_minutes?.important_meeting,
    policy.minimum_buffer_minutes?.airport_departure,
    policy.transfer_buffer_minutes,
    policy.weather_buffer_minutes,
    policy.traffic_buffer_minutes?.medium,
    policy.traffic_buffer_minutes?.high,
  ];
  if (!bufferValues.every(isNonNegativeNumber)) {
    throw new MobilityEngineError(
      "BUFFER_POLICY_MISSING",
      "The mobility policy does not define every safety buffer value.",
    );
  }
  if (!policy.version || policy.version.trim().length === 0) {
    throw new MobilityEngineError(
      "POLICY_INVALID",
      "The mobility policy has no version.",
    );
  }
  const weights = Object.values(policy.weights ?? {});
  if (weights.length === 0 || !weights.every(isNonNegativeNumber)) {
    throw new MobilityEngineError(
      "POLICY_INVALID",
      "The mobility policy has invalid scoring weights.",
    );
  }
  const total = weights.reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - 1) > 1e-9) {
    throw new MobilityEngineError(
      "POLICY_INVALID",
      "The scoring weights of the mobility policy must sum to 1.",
    );
  }
  const thresholds = [
    ...Object.values(policy.traffic_thresholds ?? {}),
    ...Object.values(policy.weather_thresholds ?? {}),
    policy.forecast_match_tolerance_minutes,
    policy.traffic_live_horizon_minutes,
    policy.weather_exposure_walking_minutes,
    policy.unknown_risk_score,
    policy.avoid_heavy_traffic_multiplier,
  ];
  if (!thresholds.every(isNonNegativeNumber)) {
    throw new MobilityEngineError(
      "POLICY_INVALID",
      "The mobility policy has invalid thresholds.",
    );
  }
}
