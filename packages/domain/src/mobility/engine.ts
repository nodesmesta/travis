import {
  MOBILITY_POLICY_V1,
  assertPolicyComplete,
  type MobilityPolicy,
} from "./policy.js";
import {
  MobilityEngineError,
  REASON_CODES,
  type CostObject,
  type DepartureRecommendation,
  type DerivedMetrics,
  type EvaluatedOption,
  type MobilityEvaluation,
  type MobilityInput,
  type ReasonCode,
  type RiskLevel,
  type RiskObject,
  type RouteCandidate,
  type RouteSection,
  type TrafficFacts,
  type WeatherFacts,
  type WeatherPoint,
} from "./types.js";

const SCORE_DECIMALS = 1_000_000;

function round6(value: number): number {
  return Math.round(value * SCORE_DECIMALS) / SCORE_DECIMALS;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function parseTime(value: string, field: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new MobilityEngineError(
      "INPUT_INVALID",
      `${field} is not a valid date-time.`,
    );
  }
  return ms;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// Risk classification

const RISK_ORDER: Record<Exclude<RiskLevel, "unknown">, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

/** Highest known level. Null when every input is unknown. */
function worstKnown(levels: RiskLevel[]): Exclude<RiskLevel, "unknown"> | null {
  let worst: Exclude<RiskLevel, "unknown"> | null = null;
  for (const level of levels) {
    if (level === "unknown") continue;
    if (worst === null || RISK_ORDER[level] > RISK_ORDER[worst]) worst = level;
  }
  return worst;
}

export function classifyTrafficArea(
  traffic: TrafficFacts,
  policy: MobilityPolicy,
): RiskLevel {
  if (traffic.segment_count === 0 && traffic.incident_count === 0) {
    return "unknown";
  }
  const t = policy.traffic_thresholds;
  const severe = traffic.incidents.some(
    (incident) =>
      incident.road_closed ||
      incident.criticality === "critical" ||
      incident.criticality === "major",
  );
  if (
    traffic.closed_segment_count > 0 ||
    severe ||
    (traffic.average_jam_factor !== null &&
      traffic.average_jam_factor >= t.jam_factor_high)
  ) {
    return "high";
  }
  if (
    traffic.incident_count > 0 ||
    (traffic.average_jam_factor !== null &&
      traffic.average_jam_factor >= t.jam_factor_medium)
  ) {
    return "medium";
  }
  return traffic.average_jam_factor === null ? "unknown" : "low";
}

export interface RouteDelay {
  level: RiskLevel;
  delay_seconds: number | null;
  ratio: number | null;
}

/** Traffic delay of a road route from the provider's own duration and baseDuration. */
export function classifyRouteDelay(
  candidate: Pick<RouteCandidate, "duration_seconds" | "base_duration_seconds">,
  policy: MobilityPolicy,
): RouteDelay {
  const base = candidate.base_duration_seconds;
  if (base === null || base <= 0) {
    return { level: "unknown", delay_seconds: null, ratio: null };
  }
  const delay = Math.max(0, candidate.duration_seconds - base);
  const ratio = delay / base;
  const t = policy.traffic_thresholds;
  const level: RiskLevel =
    ratio >= t.delay_ratio_high
      ? "high"
      : ratio >= t.delay_ratio_medium
        ? "medium"
        : "low";
  return { level, delay_seconds: delay, ratio: round4(ratio) };
}

function localDate(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

/**
 * Picks the forecast point for a moment: the nearest hourly point within the
 * policy tolerance, otherwise the daily point for the same local date.
 */
export function selectForecastPoint(
  weather: WeatherFacts,
  atMs: number,
  policy: MobilityPolicy,
): WeatherPoint | null {
  const toleranceMs = policy.forecast_match_tolerance_minutes * 60_000;
  let best: WeatherPoint | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const point of weather.hourly) {
    const gap = Math.abs(Date.parse(point.at) - atMs);
    if (gap < bestGap) {
      best = point;
      bestGap = gap;
    }
  }
  if (best && bestGap <= toleranceMs) return best;
  const wanted = localDate(atMs, weather.timezone);
  for (const point of weather.daily) {
    if (localDate(Date.parse(point.at), weather.timezone) === wanted) {
      return point;
    }
  }
  return null;
}

function inRanges(id: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([from, to]) => id >= from && id <= to);
}

export interface WeatherAssessment {
  level: RiskLevel;
  /** Metrics the provider did not return, so they could not be judged. */
  missing_metrics: string[];
}

export function classifyWeatherPoint(
  point: WeatherPoint,
  policy: MobilityPolicy,
): WeatherAssessment {
  const t = policy.weather_thresholds;
  const rules = policy.weather_condition_rules;
  const levels: RiskLevel[] = [];
  const missing: string[] = [];

  if (point.condition_id === null) {
    missing.push("condition");
  } else if (
    rules.high_ids.includes(point.condition_id) ||
    inRanges(point.condition_id, rules.high_ranges)
  ) {
    levels.push("high");
  } else if (
    rules.medium_ids.includes(point.condition_id) ||
    inRanges(point.condition_id, rules.medium_ranges)
  ) {
    levels.push("medium");
  } else {
    levels.push("low");
  }

  const grade = (
    value: number | null,
    name: string,
    medium: number,
    high: number,
    inverted = false,
  ): void => {
    if (value === null) {
      missing.push(name);
      return;
    }
    if (inverted) {
      levels.push(value <= high ? "high" : value <= medium ? "medium" : "low");
    } else {
      levels.push(value >= high ? "high" : value >= medium ? "medium" : "low");
    }
  };
  grade(
    point.precipitation_probability,
    "precipitation_probability",
    t.precipitation_probability_medium,
    t.precipitation_probability_high,
  );
  grade(
    point.precipitation_mm,
    "precipitation_mm",
    t.precipitation_mm_medium,
    t.precipitation_mm_high,
  );
  grade(
    point.wind_speed_ms,
    "wind_speed",
    t.wind_speed_ms_medium,
    t.wind_speed_ms_high,
  );
  grade(
    point.visibility_m,
    "visibility",
    t.visibility_m_medium,
    t.visibility_m_high,
    true,
  );

  const worst = worstKnown(levels);
  return { level: worst ?? "unknown", missing_metrics: missing };
}

// ---------------------------------------------------------------------------
// Route facts

function serviceIdentity(section: RouteSection): string {
  return [
    section.operator_id ?? "",
    section.mode ?? "",
    section.service_name ?? "",
    section.headsign ?? "",
  ].join("|");
}

/**
 * Transfers are changes between different transit services. Consecutive
 * sections of the same service are one ride, and walking sections are not
 * counted, so the number is not just the length of the section array.
 */
export function countTransfers(sections: RouteSection[]): number {
  let rides = 0;
  let previous: string | null = null;
  for (const section of sections) {
    if (section.type !== "transit") continue;
    const identity = serviceIdentity(section);
    if (identity !== previous) rides += 1;
    previous = identity;
  }
  return Math.max(0, rides - 1);
}

export function walkingSeconds(candidate: RouteCandidate): number {
  const fromSections = candidate.sections
    .filter((section) => section.type === "pedestrian")
    .reduce((sum, section) => sum + section.duration_seconds, 0);
  if (
    candidate.sections.length === 0 &&
    candidate.transport_mode === "pedestrian"
  ) {
    return candidate.duration_seconds;
  }
  return fromSections;
}

function isRoadMode(mode: RouteCandidate["transport_mode"]): boolean {
  return mode === "car" || mode === "taxi";
}

function costFor(
  candidate: RouteCandidate,
  policy: MobilityPolicy,
): CostObject {
  if (candidate.provider_fare) {
    return {
      min_amount: candidate.provider_fare.min_amount,
      max_amount: candidate.provider_fare.max_amount,
      currency: candidate.provider_fare.currency,
      source_type: "provider",
      is_estimate: candidate.provider_fare.is_estimate,
    };
  }
  if (candidate.transport_mode === "pedestrian") {
    return {
      min_amount: 0,
      max_amount: 0,
      currency: policy.currency,
      source_type: "calculated",
      is_estimate: false,
    };
  }
  return {
    min_amount: null,
    max_amount: null,
    currency: policy.currency,
    source_type: "unavailable",
    is_estimate: true,
  };
}

function costMidpoint(cost: CostObject): number | null {
  if (cost.min_amount === null || cost.max_amount === null) return null;
  return (cost.min_amount + cost.max_amount) / 2;
}

interface Draft {
  candidate: RouteCandidate;
  key: string;
  derived: DerivedMetrics;
  cost: CostObject;
  risk: RiskObject;
  exclusion: ReasonCode[];
  trafficUnknownRoad: boolean;
  weatherMissing: string[];
}

function assertReasonCodes(codes: readonly string[]): void {
  for (const code of codes) {
    if (!(REASON_CODES as readonly string[]).includes(code)) {
      throw new MobilityEngineError(
        "INPUT_INVALID",
        `Reason code ${code} is not allowed.`,
      );
    }
  }
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

// ---------------------------------------------------------------------------
// Evaluation

function validateInput(input: MobilityInput): {
  nowMs: number;
  departureMs: number;
  deadlineMs: number | null;
} {
  const nowMs = parseTime(input.now, "now");
  const departureMs = parseTime(input.departure_at, "departure_at");
  const deadlineMs =
    input.arrival_deadline === null
      ? null
      : parseTime(input.arrival_deadline, "arrival_deadline");
  if (deadlineMs !== null && deadlineMs <= departureMs) {
    throw new MobilityEngineError(
      "INPUT_INVALID",
      "arrival_deadline must be after departure_at.",
    );
  }
  const p = input.preferences;
  if (
    !Number.isFinite(p.max_walking_minutes) ||
    p.max_walking_minutes < 0 ||
    !Number.isFinite(p.max_transfers) ||
    p.max_transfers < 0
  ) {
    throw new MobilityEngineError(
      "INPUT_INVALID",
      "max_walking_minutes and max_transfers must not be negative.",
    );
  }
  return { nowMs, departureMs, deadlineMs };
}

function minutes(seconds: number): number {
  return Math.round(seconds / 60);
}

/**
 * Deterministic mobility evaluation. Same input and policy always produce the
 * same options, ranking, and recommendation. Nothing here reads a clock,
 * network, or random source; `input.now` is the only notion of time.
 */
export function evaluateMobility(
  input: MobilityInput,
  policy: MobilityPolicy = MOBILITY_POLICY_V1,
): MobilityEvaluation {
  assertPolicyComplete(policy);
  const { nowMs, deadlineMs } = validateInput(input);
  const limitations: string[] = [];
  const required = new Set(input.required_facts);

  // Expired facts are never used as live facts.
  let traffic = input.traffic;
  if (traffic && Date.parse(traffic.expires_at) <= nowMs) {
    traffic = null;
    limitations.push("The traffic snapshot has expired and was not used.");
  }
  let weather = input.weather;
  if (weather && Date.parse(weather.expires_at) <= nowMs) {
    weather = null;
    limitations.push("The weather snapshot has expired and was not used.");
  }
  const missingFacts: MobilityEvaluation["missing_facts"] = [];
  if (required.has("traffic") && traffic === null) {
    throw new MobilityEngineError(
      "TRAFFIC_FACTS_MISSING",
      "Traffic is required for this request but no valid traffic data is available.",
    );
  }
  if (required.has("weather") && weather === null) {
    throw new MobilityEngineError(
      "WEATHER_FACTS_MISSING",
      "Weather is required for this request but no valid weather data is available.",
    );
  }

  if (traffic === null) missingFacts.push("traffic");
  if (weather === null) missingFacts.push("weather");
  if (input.candidates.length === 0) {
    missingFacts.push("route");
    limitations.push("No route option was available to compare.");
    return {
      policy_version: policy.version,
      options: [],
      recommended_key: null,
      departure_recommendation: null,
      facts: [],
      limitations,
      missing_facts: missingFacts,
      cost_compared: false,
      tie_break_applied: false,
    };
  }

  const trafficArea: RiskLevel = traffic
    ? classifyTrafficArea(traffic, policy)
    : "unknown";
  const bufferBase = policy.minimum_buffer_minutes[input.criticality] * 60;
  const drafts: Draft[] = [];
  let weatherUnavailableNoted = false;
  let weatherGranularityDaily = false;

  for (const candidate of input.candidates) {
    const departureMs = parseTime(
      candidate.departure_at,
      "candidate departure",
    );
    const arrivalMs = parseTime(candidate.arrival_at, "candidate arrival");
    if (arrivalMs < departureMs || candidate.duration_seconds < 0) {
      throw new MobilityEngineError(
        "INPUT_INVALID",
        "A route candidate has a negative duration.",
      );
    }
    const totalSeconds = Math.round((arrivalMs - departureMs) / 1000);
    const walkSec = walkingSeconds(candidate);
    const walkMinutes = Math.ceil(walkSec / 60);
    const transfers =
      candidate.transport_mode === "transit"
        ? countTransfers(candidate.sections)
        : 0;
    const road = isRoadMode(candidate.transport_mode);

    // Traffic risk.
    const delay = road
      ? classifyRouteDelay(candidate, policy)
      : { level: "unknown" as RiskLevel, delay_seconds: null, ratio: null };
    let trafficRisk: RiskLevel;
    if (road) {
      trafficRisk = worstKnown([delay.level, trafficArea]) ?? "unknown";
    } else if (candidate.transport_mode === "pedestrian") {
      // Walking has no exposure to road traffic. This is a rule, not a reading.
      trafficRisk = "low";
    } else {
      trafficRisk = "unknown";
    }

    // Weather risk at the destination around arrival.
    let weatherRisk: RiskLevel = "unknown";
    let weatherMissing: string[] = [];
    let baseWeather: RiskLevel = "unknown";
    const exposed =
      candidate.transport_mode === "pedestrian" ||
      walkMinutes >= policy.weather_exposure_walking_minutes;
    if (weather) {
      const point = selectForecastPoint(weather, arrivalMs, policy);
      if (point) {
        if (point.granularity === "daily") weatherGranularityDaily = true;
        const assessment = classifyWeatherPoint(point, policy);
        baseWeather = assessment.level;
        weatherMissing = assessment.missing_metrics;
        if (baseWeather === "unknown") weatherRisk = "unknown";
        else if (exposed) weatherRisk = baseWeather;
        else weatherRisk = baseWeather === "high" ? "medium" : "low";
      } else if (!weatherUnavailableNoted) {
        weatherUnavailableNoted = true;
        if (required.has("weather")) {
          throw new MobilityEngineError(
            "WEATHER_FACTS_MISSING",
            "The weather forecast does not cover the arrival time.",
          );
        }
        limitations.push(
          "The weather forecast does not cover the arrival time, so weather risk is unknown.",
        );
      }
    }

    // Safety buffer.
    let bufferSeconds = bufferBase;
    bufferSeconds += transfers * policy.transfer_buffer_minutes * 60;
    if (road) {
      if (trafficRisk === "high") {
        bufferSeconds += policy.traffic_buffer_minutes.high * 60;
      } else if (trafficRisk === "medium") {
        bufferSeconds += policy.traffic_buffer_minutes.medium * 60;
      }
    }
    if (exposed && baseWeather === "high") {
      bufferSeconds += policy.weather_buffer_minutes * 60;
    }

    // Deadline feasibility.
    let slack: number | null = null;
    let feasible: boolean | null = null;
    let latestDeparture: string | null = null;
    if (deadlineMs !== null) {
      slack = Math.round((deadlineMs - arrivalMs) / 1000) - bufferSeconds;
      feasible = slack >= 0;
      if (candidate.transport_mode !== "transit") {
        latestDeparture = iso(
          deadlineMs - (bufferSeconds + totalSeconds) * 1000,
        );
      }
    }

    // Reason codes for the option.
    const reasons: ReasonCode[] = [];
    if (deadlineMs !== null) reasons.push("arrival_deadline");
    if (road && (delay.level === "medium" || delay.level === "high")) {
      reasons.push("traffic_delay");
    }
    if (road && traffic && traffic.incident_count > 0) {
      reasons.push("traffic_incident");
    }
    if (weatherRisk === "medium" || weatherRisk === "high") {
      reasons.push("weather_risk");
    }
    if (weather === null || weatherRisk === "unknown") {
      reasons.push("weather_unavailable");
    }
    if (road && trafficRisk === "unknown") reasons.push("traffic_unavailable");
    if (
      candidate.transport_mode === "transit" &&
      input.preferences.preferred_modes.includes("transit")
    ) {
      reasons.push("public_transit_preference");
    }
    if (
      input.preferences.comfort_priority === "high" &&
      policy.mode_comfort[candidate.transport_mode] >= 0.9
    ) {
      reasons.push("comfort_preference");
    }

    const exclusion: ReasonCode[] = [];
    if (feasible === false) exclusion.push("arrival_deadline");
    if (walkMinutes > input.preferences.max_walking_minutes) {
      exclusion.push("walking_limit");
    }
    if (transfers > input.preferences.max_transfers) {
      exclusion.push("transfer_limit");
    }

    const overallKnown = worstKnown([trafficRisk, weatherRisk]);
    const anyUnknown = trafficRisk === "unknown" || weatherRisk === "unknown";
    const overall: RiskLevel =
      overallKnown === null
        ? "unknown"
        : overallKnown === "low" && anyUnknown
          ? "unknown"
          : overallKnown;

    drafts.push({
      candidate,
      key: `${candidate.transport_mode}:${candidate.provider_route_id}`,
      derived: {
        departure_at: iso(departureMs),
        arrival_at: iso(arrivalMs),
        total_duration_seconds: totalSeconds,
        traffic_delay_seconds: delay.delay_seconds,
        traffic_delay_ratio: delay.ratio,
        walking_minutes: walkMinutes,
        transfer_count: transfers,
        safety_buffer_seconds: bufferSeconds,
        deadline_slack_seconds: slack,
        feasible,
        latest_departure_at: latestDeparture,
        reason_codes: unique(reasons),
      },
      cost: costFor(candidate, policy),
      risk: { traffic: trafficRisk, weather: weatherRisk, overall },
      exclusion,
      trafficUnknownRoad: road && trafficRisk === "unknown",
      weatherMissing,
    });
  }

  const valid = drafts.filter((draft) => draft.exclusion.length === 0);

  // Score only valid options.
  const costCompared =
    valid.length > 0 &&
    valid.every((draft) => costMidpoint(draft.cost) !== null);
  const effectiveWeights = effectiveWeightsFor(input, policy, costCompared);
  const minDuration = Math.min(
    ...valid.map((draft) => draft.derived.total_duration_seconds),
  );
  const mids = valid.map((draft) => costMidpoint(draft.cost));
  const minMid = costCompared ? Math.min(...(mids as number[])) : 0;
  const maxMid = costCompared ? Math.max(...(mids as number[])) : 0;

  const riskScore = (level: RiskLevel): number =>
    level === "low"
      ? 1
      : level === "medium"
        ? 0.5
        : level === "high"
          ? 0
          : policy.unknown_risk_score;

  interface Scored {
    draft: Draft;
    total: number;
    components: Record<string, number | null>;
  }
  const scored: Scored[] = valid.map((draft) => {
    const d = draft.derived;
    const maxWalk = input.preferences.max_walking_minutes;
    const maxTransfers = input.preferences.max_transfers;
    const components: Record<string, number | null> = {
      time:
        d.total_duration_seconds > 0
          ? minDuration / d.total_duration_seconds
          : 1,
      cost: null,
      walking:
        maxWalk > 0
          ? Math.max(0, 1 - d.walking_minutes / maxWalk)
          : d.walking_minutes === 0
            ? 1
            : 0,
      transfers:
        maxTransfers > 0
          ? Math.max(0, 1 - d.transfer_count / maxTransfers)
          : d.transfer_count === 0
            ? 1
            : 0,
      traffic: riskScore(draft.risk.traffic),
      weather: riskScore(draft.risk.weather),
      comfort: policy.mode_comfort[draft.candidate.transport_mode],
      preference:
        input.preferences.preferred_modes.length === 0 ||
        input.preferences.preferred_modes.includes(
          draft.candidate.transport_mode,
        )
          ? 1
          : 0,
    };
    if (costCompared) {
      const mid = costMidpoint(draft.cost) as number;
      components.cost =
        maxMid === minMid ? 1 : 1 - (mid - minMid) / (maxMid - minMid);
    }
    let total = 0;
    for (const name of Object.keys(effectiveWeights)) {
      total += (effectiveWeights[name] as number) * (components[name] ?? 0);
    }
    return { draft, total: round6(total), components };
  });

  const trafficOrder: Record<RiskLevel, number> = {
    low: 0,
    medium: 1,
    unknown: 2,
    high: 3,
  };
  scored.sort((a, b) => {
    if (a.total !== b.total) return b.total - a.total;
    const ad = a.draft.derived;
    const bd = b.draft.derived;
    const compare = (left: number, right: number): number => left - right;
    let result = 0;
    if (
      ad.deadline_slack_seconds !== null &&
      bd.deadline_slack_seconds !== null
    ) {
      result = compare(bd.deadline_slack_seconds, ad.deadline_slack_seconds);
    }
    if (result === 0) {
      result = compare(
        trafficOrder[a.draft.risk.traffic],
        trafficOrder[b.draft.risk.traffic],
      );
    }
    if (result === 0) result = compare(ad.walking_minutes, bd.walking_minutes);
    if (result === 0) result = compare(ad.transfer_count, bd.transfer_count);
    if (result === 0) {
      result = compare(ad.total_duration_seconds, bd.total_duration_seconds);
    }
    if (result === 0) {
      result =
        a.draft.key < b.draft.key ? -1 : a.draft.key > b.draft.key ? 1 : 0;
    }
    return result;
  });
  // A tie exists when two neighbours share the same rounded score.
  const tieBreakApplied = scored.some(
    (entry, index) =>
      index > 0 && (scored[index - 1] as Scored).total === entry.total,
  );

  const shortest = scored.reduce<number>(
    (best, entry) => Math.min(best, entry.draft.derived.total_duration_seconds),
    Number.POSITIVE_INFINITY,
  );
  const largestSlack = scored.reduce<number | null>((best, entry) => {
    const slack = entry.draft.derived.deadline_slack_seconds;
    if (slack === null) return best;
    return best === null ? slack : Math.max(best, slack);
  }, null);

  const options: EvaluatedOption[] = [];
  scored.forEach((entry, index) => {
    const { draft } = entry;
    const reasons = [...draft.derived.reason_codes];
    if (index === 0) {
      if (draft.derived.total_duration_seconds === shortest) {
        reasons.push("shorter_duration");
      }
      if (
        largestSlack !== null &&
        draft.derived.deadline_slack_seconds === largestSlack
      ) {
        reasons.push("more_buffer");
      }
    }
    options.push(
      toOption(
        draft,
        "valid",
        reasons,
        [],
        {
          total: entry.total,
          components: Object.fromEntries(
            Object.entries(entry.components).map(([name, value]) => [
              name,
              value === null ? null : round6(value),
            ]),
          ),
          weights: effectiveWeights,
          rank: index + 1,
        },
        index === 0,
      ),
    );
  });
  const excluded = drafts
    .filter((draft) => draft.exclusion.length > 0)
    .sort(
      (a, b) =>
        a.derived.total_duration_seconds - b.derived.total_duration_seconds ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
  for (const draft of excluded) {
    options.push(
      toOption(
        draft,
        "excluded",
        unique([...draft.derived.reason_codes, ...draft.exclusion]),
        draft.exclusion,
        null,
        false,
      ),
    );
  }
  for (const option of options) {
    assertReasonCodes(option.derived_metrics.reason_codes);
    assertReasonCodes(option.exclusion_reasons);
  }

  const recommended = options.find((option) => option.recommended) ?? null;
  const departure = recommended
    ? departureFor(recommended, policy, deadlineMs !== null)
    : null;

  // Facts and limitations are plain statements built from the numbers above.
  const facts: string[] = [];
  for (const option of options) {
    const pf = option.provider_facts;
    const label = option.transport_mode;
    facts.push(
      `${label}: provider duration ${minutes(pf.duration_seconds)} min` +
        (pf.base_duration_seconds !== null
          ? `, base duration without traffic ${minutes(pf.base_duration_seconds)} min`
          : "") +
        `, arrival ${option.derived_metrics.arrival_at}.`,
    );
  }
  if (!recommended) {
    if (deadlineMs !== null) {
      limitations.push(
        "No option arrives before the deadline with the required safety buffer.",
      );
      const hint = excluded
        .filter((draft) => draft.derived.latest_departure_at !== null)
        .map((draft) => draft.derived.latest_departure_at as string)
        .filter((value) => Date.parse(value) > nowMs)
        .sort()
        .pop();
      if (hint) {
        limitations.push(
          `Leaving by ${hint} would meet the deadline for the fastest road option, if travel time stays the same.`,
        );
      }
    } else {
      limitations.push("No option satisfies the walking and transfer limits.");
    }
  }
  const unavailableCost = options.filter(
    (option) => option.cost.source_type === "unavailable",
  ).length;
  if (unavailableCost > 0) {
    limitations.push(
      `Cost is unavailable for ${unavailableCost} option(s). Cost is shown as unavailable and was not estimated.`,
    );
  }
  if (valid.length > 0 && !costCompared) {
    limitations.push(
      "Cost was not used for ranking because not every option has a known cost.",
    );
  }
  if (drafts.some((draft) => draft.trafficUnknownRoad)) {
    limitations.push(
      "Traffic risk is unknown for some road options because the provider returned no baseline duration and no area traffic data was used.",
    );
  }
  if (weather === null) {
    limitations.push("No weather data was used. Weather risk is unknown.");
  } else if (weatherGranularityDaily) {
    limitations.push(
      "Weather risk uses a daily forecast because the arrival time is beyond the hourly forecast.",
    );
  }
  const missingMetrics = unique(
    drafts.flatMap((draft) => draft.weatherMissing),
  );
  if (missingMetrics.length > 0) {
    limitations.push(
      `The weather provider did not return: ${missingMetrics.join(", ")}.`,
    );
  }
  if (deadlineMs === null) {
    limitations.push(
      "The journey leg has no arrival deadline, so no option is judged on time or late.",
    );
  }
  if (traffic) {
    limitations.push(
      "Area traffic describes the corridor around the leg, not a specific route.",
    );
  }

  return {
    policy_version: policy.version,
    options,
    recommended_key: recommended?.key ?? null,
    departure_recommendation: departure,
    facts,
    limitations: unique(limitations),
    missing_facts: missingFacts,
    cost_compared: costCompared,
    tie_break_applied: tieBreakApplied,
  };
}

function effectiveWeightsFor(
  input: MobilityInput,
  policy: MobilityPolicy,
  costCompared: boolean,
): Record<string, number> {
  const raw: Record<string, number> = { ...policy.weights };
  if (!costCompared) raw.cost = 0;
  if (input.preferences.avoid_heavy_traffic) {
    raw.traffic =
      (raw.traffic as number) * policy.avoid_heavy_traffic_multiplier;
  }
  raw.comfort =
    (raw.comfort as number) *
    policy.comfort_priority_multiplier[input.preferences.comfort_priority];
  const total = Object.values(raw).reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(
    Object.entries(raw).map(([name, value]) => [name, round6(value / total)]),
  );
}

function toOption(
  draft: Draft,
  status: EvaluatedOption["status"],
  reasonCodes: ReasonCode[],
  exclusion: ReasonCode[],
  score: EvaluatedOption["score"],
  recommended: boolean,
): EvaluatedOption {
  const c = draft.candidate;
  return {
    key: draft.key,
    provider: c.provider,
    provider_route_id: c.provider_route_id,
    transport_mode: c.transport_mode,
    source_key: c.source_key,
    provider_facts: {
      distance_meters: c.distance_meters,
      duration_seconds: c.duration_seconds,
      base_duration_seconds: c.base_duration_seconds,
      typical_duration_seconds: c.typical_duration_seconds,
      departure_at: c.departure_at,
      arrival_at: c.arrival_at,
      sections: c.sections,
      notices: c.notices,
    },
    derived_metrics: {
      ...draft.derived,
      reason_codes: unique(reasonCodes),
    },
    cost: draft.cost,
    risk: draft.risk,
    score,
    status,
    exclusion_reasons: exclusion,
    recommended,
  };
}

function departureFor(
  option: EvaluatedOption,
  policy: MobilityPolicy,
  hasDeadline: boolean,
): DepartureRecommendation {
  const reasons: ReasonCode[] = [];
  if (hasDeadline) reasons.push("arrival_deadline");
  for (const code of option.derived_metrics.reason_codes) {
    if (code === "traffic_delay" || code === "weather_risk") reasons.push(code);
  }
  return {
    depart_at: option.derived_metrics.departure_at,
    latest_departure_at: option.derived_metrics.latest_departure_at,
    buffer_seconds: option.derived_metrics.safety_buffer_seconds,
    policy_version: policy.version,
    reason_codes: unique(reasons),
  };
}
