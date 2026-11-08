import assert from "node:assert/strict";
import test from "node:test";
import {
  MOBILITY_POLICY_V1,
  MobilityEngineError,
  classifyRouteDelay,
  classifyTrafficArea,
  classifyWeatherPoint,
  countTransfers,
  evaluateMobility,
  haversineMeters,
  selectForecastPoint,
} from "../dist/index.js";

// Everything below is a FIXTURE: hand-written engine input, never provider output.
const NOW = "2026-11-12T00:00:00.000Z";
const DEPART = "2026-11-12T00:45:00+00:00";
const DEADLINE = "2026-11-12T02:00:00+00:00";

const point = (name, latitude, longitude, id = null) => ({
  name,
  latitude,
  longitude,
  provider_place_id: id,
});

function iso(minutesAfterDeparture) {
  return new Date(
    Date.parse(DEPART) + minutesAfterDeparture * 60_000,
  ).toISOString();
}

function road(mode, id, durationMin, baseMin) {
  return {
    provider: "here_routing_v8",
    provider_route_id: id,
    transport_mode: mode,
    distance_meters: 4800,
    duration_seconds: durationMin * 60,
    base_duration_seconds: baseMin === null ? null : baseMin * 60,
    typical_duration_seconds: null,
    departure_at: iso(0),
    arrival_at: iso(durationMin),
    sections: [
      {
        type: "vehicle",
        mode,
        service_name: null,
        operator: null,
        operator_id: null,
        headsign: null,
        departure_at: iso(0),
        arrival_at: iso(durationMin),
        duration_seconds: durationMin * 60,
        distance_meters: 4800,
        from: point(null, -6.1954, 106.823),
        to: point(null, -6.2147, 106.8097),
      },
    ],
    notices: [],
    provider_fare: null,
    source_key: `here_routing_v8:${mode}`,
  };
}

function walk(id, durationMin) {
  const candidate = road("pedestrian", id, durationMin, durationMin);
  candidate.provider = "here_routing_v8";
  candidate.sections[0].type = "pedestrian";
  candidate.sections[0].mode = "pedestrian";
  return candidate;
}

function section(type, name, operatorId, from, to, headsign = "X") {
  return {
    type,
    mode: type === "transit" ? "lightRail" : "pedestrian",
    service_name: type === "transit" ? name : null,
    operator: type === "transit" ? `Operator ${operatorId}` : null,
    operator_id: type === "transit" ? operatorId : null,
    headsign: type === "transit" ? headsign : null,
    departure_at: iso(from),
    arrival_at: iso(to),
    duration_seconds: (to - from) * 60,
    distance_meters: null,
    from: point("A", -6.19, 106.82, "a"),
    to: point("B", -6.21, 106.81, "b"),
  };
}

function transit(id, sections) {
  const last = sections[sections.length - 1];
  const minutes = Math.round(
    (Date.parse(last.arrival_at) - Date.parse(iso(0))) / 60_000,
  );
  return {
    provider: "here_intermodal_v8",
    provider_route_id: id,
    transport_mode: "transit",
    distance_meters: null,
    duration_seconds: minutes * 60,
    base_duration_seconds: null,
    typical_duration_seconds: null,
    departure_at: iso(0),
    arrival_at: last.arrival_at,
    sections,
    notices: [],
    provider_fare: null,
    source_key: "here_intermodal_v8:transit",
  };
}

const preferences = {
  preferred_modes: ["transit", "taxi"],
  max_walking_minutes: 15,
  max_transfers: 2,
  budget_preference: "moderate",
  avoid_heavy_traffic: true,
  comfort_priority: "medium",
};

function input(overrides = {}) {
  return {
    now: NOW,
    departure_at: DEPART,
    arrival_deadline: DEADLINE,
    timezone: "Asia/Jakarta",
    criticality: "important_meeting",
    preferences,
    required_facts: ["route"],
    candidates: [],
    traffic: null,
    weather: null,
    ...overrides,
  };
}

const traffic = (overrides = {}) => ({
  observed_at: NOW,
  segment_count: 40,
  average_jam_factor: 2,
  max_jam_factor: 5,
  closed_segment_count: 0,
  incident_count: 0,
  incidents: [],
  retrieved_at: NOW,
  expires_at: "2026-11-12T00:10:00.000Z",
  ...overrides,
});

function hourly(atMinutes, overrides = {}) {
  return {
    at: iso(atMinutes),
    granularity: "hourly",
    temperature_c: 28,
    precipitation_probability: 0.1,
    precipitation_mm: 0,
    wind_speed_ms: 3,
    visibility_m: 10000,
    condition_id: 800,
    condition: "Clear",
    description: "clear sky",
    ...overrides,
  };
}

const weather = (points, extra = {}) => ({
  latitude: -6.2147,
  longitude: 106.8097,
  timezone: "Asia/Jakarta",
  observed_at: NOW,
  current: null,
  hourly: points,
  daily: [],
  alerts: [],
  retrieved_at: NOW,
  expires_at: "2026-11-12T00:30:00.000Z",
  ...extra,
});

function golden() {
  return [
    road("car", "route-car", 35, 25),
    road("taxi", "route-taxi", 35, 25),
    walk("route-walk", 70),
    transit("route-transit", [
      section("pedestrian", null, null, 0, 8),
      section("transit", "Line 1", "OP1", 10, 40),
      section("pedestrian", null, null, 40, 44),
    ]),
  ];
}

test("golden route fixture: numbers, risk, buffer, and ranking are fixed", () => {
  const result = evaluateMobility(
    input({
      candidates: golden(),
      required_facts: ["route", "traffic", "weather"],
      traffic: traffic(),
      weather: weather([hourly(30), hourly(90)]),
    }),
  );
  assert.equal(result.policy_version, "mobility-v1");
  const car = result.options.find((o) => o.key === "car:route-car");
  assert.equal(car.derived_metrics.traffic_delay_seconds, 600);
  assert.equal(car.derived_metrics.traffic_delay_ratio, 0.4);
  assert.equal(car.risk.traffic, "high");
  // important_meeting 20 min + high traffic 10 min.
  assert.equal(car.derived_metrics.safety_buffer_seconds, 30 * 60);
  // Deadline is 75 min after departure; arrival 35 min; buffer 30 min.
  assert.equal(car.derived_metrics.deadline_slack_seconds, 10 * 60);
  assert.equal(car.derived_metrics.feasible, true);
  assert.equal(car.derived_metrics.latest_departure_at, iso(10));
  assert.deepEqual(car.cost, {
    min_amount: null,
    max_amount: null,
    currency: "IDR",
    source_type: "unavailable",
    is_estimate: true,
  });

  const walkOption = result.options.find(
    (o) => o.key === "pedestrian:route-walk",
  );
  assert.equal(walkOption.status, "excluded");
  assert.ok(walkOption.exclusion_reasons.includes("walking_limit"));
  assert.ok(walkOption.exclusion_reasons.includes("arrival_deadline"));

  const bus = result.options.find((o) => o.key === "transit:route-transit");
  assert.equal(bus.derived_metrics.walking_minutes, 12);
  assert.equal(bus.derived_metrics.transfer_count, 0);
  assert.equal(bus.provider_facts.sections[1].operator, "Operator OP1");

  assert.ok(result.recommended_key);
  const recommended = result.options.find((o) => o.recommended);
  assert.equal(recommended.status, "valid");
  assert.equal(recommended.score.rank, 1);
  assert.equal(result.options.filter((o) => o.recommended).length, 1);
  assert.equal(result.departure_recommendation.policy_version, "mobility-v1");
  assert.equal(
    result.departure_recommendation.depart_at,
    recommended.derived_metrics.departure_at,
  );
  assert.ok(
    result.limitations.some((text) => text.includes("Cost is unavailable")),
  );
});

test("a route that misses the deadline is excluded and never recommended", () => {
  const late = road("car", "late-car", 90, 60);
  const ok = road("taxi", "ok-taxi", 30, 28);
  const result = evaluateMobility(input({ candidates: [late, ok] }));
  const lateOption = result.options.find((o) => o.key === "car:late-car");
  assert.equal(lateOption.status, "excluded");
  assert.equal(lateOption.recommended, false);
  assert.equal(lateOption.score, null);
  assert.deepEqual(lateOption.exclusion_reasons, ["arrival_deadline"]);
  assert.equal(result.recommended_key, "taxi:ok-taxi");
});

test("when every option is late there is no recommendation and no invented departure", () => {
  const result = evaluateMobility(
    input({
      candidates: [road("car", "a", 80, 60), road("taxi", "b", 75, 60)],
    }),
  );
  assert.equal(result.recommended_key, null);
  assert.equal(result.departure_recommendation, null);
  assert.ok(result.options.every((o) => o.status === "excluded"));
  assert.ok(
    result.limitations.some((text) =>
      text.includes("No option arrives before the deadline"),
    ),
  );
});

test("the safety buffer counts: an option that only just fits without it is excluded", () => {
  // Arrival 70 min after departure leaves 5 min before the deadline, below the 20 min buffer.
  const result = evaluateMobility(
    input({ candidates: [road("taxi", "tight", 70, 70)] }),
  );
  const option = result.options[0];
  assert.equal(option.derived_metrics.safety_buffer_seconds, 20 * 60);
  assert.equal(option.derived_metrics.deadline_slack_seconds, -15 * 60);
  assert.equal(option.status, "excluded");
});

test("without an arrival deadline nothing is called on time or late", () => {
  const result = evaluateMobility(
    input({ arrival_deadline: null, candidates: [road("car", "a", 30, 25)] }),
  );
  const option = result.options[0];
  assert.equal(option.derived_metrics.feasible, null);
  assert.equal(option.derived_metrics.deadline_slack_seconds, null);
  assert.equal(option.derived_metrics.latest_departure_at, null);
  assert.equal(option.status, "valid");
  assert.ok(
    result.limitations.some((text) => text.includes("no arrival deadline")),
  );
});

test("missing required traffic or weather is a structured error", () => {
  const base = { candidates: [road("car", "a", 30, 25)] };
  assert.throws(
    () =>
      evaluateMobility(
        input({ ...base, required_facts: ["route", "traffic"] }),
      ),
    (error) =>
      error instanceof MobilityEngineError &&
      error.code === "TRAFFIC_FACTS_MISSING",
  );
  assert.throws(
    () =>
      evaluateMobility(
        input({ ...base, required_facts: ["route", "weather"] }),
      ),
    (error) =>
      error instanceof MobilityEngineError &&
      error.code === "WEATHER_FACTS_MISSING",
  );
});

test("expired traffic or weather is not used as live data", () => {
  const expiredTraffic = traffic({ expires_at: "2026-11-11T23:59:00.000Z" });
  assert.throws(
    () =>
      evaluateMobility(
        input({
          candidates: [road("car", "a", 30, 25)],
          required_facts: ["route", "traffic"],
          traffic: expiredTraffic,
        }),
      ),
    (error) => error.code === "TRAFFIC_FACTS_MISSING",
  );
  const optional = evaluateMobility(
    input({ candidates: [road("car", "a", 30, 29)], traffic: expiredTraffic }),
  );
  assert.deepEqual(optional.missing_facts, ["traffic", "weather"]);
  assert.ok(optional.limitations.some((text) => text.includes("expired")));
});

test("required weather fails when the forecast does not cover the arrival time", () => {
  assert.throws(
    () =>
      evaluateMobility(
        input({
          candidates: [road("car", "a", 30, 25)],
          required_facts: ["route", "weather"],
          weather: weather([hourly(60 * 24 * 3)]),
        }),
      ),
    (error) => error.code === "WEATHER_FACTS_MISSING",
  );
});

test("unknown traffic is never treated as low", () => {
  const result = evaluateMobility(
    input({ candidates: [road("car", "a", 30, null)] }),
  );
  const option = result.options[0];
  assert.equal(option.risk.traffic, "unknown");
  assert.equal(option.risk.overall, "unknown");
  assert.equal(option.derived_metrics.traffic_delay_seconds, null);
  assert.ok(
    option.derived_metrics.reason_codes.includes("traffic_unavailable"),
  );
  assert.ok(
    option.derived_metrics.reason_codes.includes("weather_unavailable"),
  );
});

test("cost: unavailable stays unavailable, walking is zero, a provider fare is kept", () => {
  const fared = road("taxi", "fared", 30, 28);
  fared.provider_fare = {
    min_amount: 30000,
    max_amount: 50000,
    currency: "IDR",
    is_estimate: true,
  };
  const result = evaluateMobility(
    input({
      arrival_deadline: null,
      candidates: [fared, road("car", "plain", 30, 28), walk("w", 10)],
    }),
  );
  const byKey = Object.fromEntries(result.options.map((o) => [o.key, o]));
  assert.equal(byKey["taxi:fared"].cost.source_type, "provider");
  assert.equal(byKey["car:plain"].cost.source_type, "unavailable");
  assert.equal(byKey["car:plain"].cost.min_amount, null);
  assert.equal(byKey["pedestrian:w"].cost.min_amount, 0);
  assert.equal(byKey["pedestrian:w"].cost.source_type, "calculated");
  assert.equal(result.cost_compared, false);
  assert.equal(byKey["taxi:fared"].score.weights.cost, 0);
});

test("cost is compared only when every valid option has a known cost", () => {
  const a = road("taxi", "a", 30, 28);
  a.provider_fare = {
    min_amount: 30000,
    max_amount: 50000,
    currency: "IDR",
    is_estimate: true,
  };
  const b = road("car", "b", 30, 28);
  b.provider_fare = {
    min_amount: 10000,
    max_amount: 20000,
    currency: "IDR",
    is_estimate: true,
  };
  const result = evaluateMobility(
    input({ arrival_deadline: null, candidates: [a, b] }),
  );
  assert.equal(result.cost_compared, true);
  const byKey = Object.fromEntries(result.options.map((o) => [o.key, o]));
  assert.equal(byKey["car:b"].score.components.cost, 1);
  assert.equal(byKey["taxi:a"].score.components.cost, 0);
});

test("ranking and tie-break are reproducible and independent of input order", () => {
  const candidates = [
    road("car", "route-b", 30, 28),
    road("car", "route-a", 30, 28),
    road("taxi", "route-c", 30, 28),
  ];
  const first = evaluateMobility(input({ candidates }));
  const second = evaluateMobility(
    input({ candidates: [...candidates].reverse() }),
  );
  assert.deepEqual(first, second);
  assert.equal(first.tie_break_applied, true);
  // car and car tie on everything; the route id decides. Taxi has higher comfort.
  assert.deepEqual(
    first.options.map((o) => o.key),
    ["taxi:route-c", "car:route-a", "car:route-b"],
  );
  assert.equal(first.recommended_key, "taxi:route-c");
});

test("empty candidate list is an explicit empty result", () => {
  const result = evaluateMobility(input({ candidates: [] }));
  assert.deepEqual(result.options, []);
  assert.equal(result.recommended_key, null);
  assert.equal(result.departure_recommendation, null);
  assert.ok(result.missing_facts.includes("route"));
  assert.ok(
    result.limitations.some((text) => text.includes("No route option")),
  );
});

test("a policy with a missing safety buffer is rejected, never defaulted", () => {
  const broken = {
    ...MOBILITY_POLICY_V1,
    minimum_buffer_minutes: {
      ...MOBILITY_POLICY_V1.minimum_buffer_minutes,
      normal: null,
    },
  };
  assert.throws(
    () =>
      evaluateMobility(
        input({ candidates: [road("car", "a", 30, 25)] }),
        broken,
      ),
    (error) => error.code === "BUFFER_POLICY_MISSING",
  );
  const unweighted = {
    ...MOBILITY_POLICY_V1,
    weights: { ...MOBILITY_POLICY_V1.weights, time: 0.9 },
  };
  assert.throws(
    () =>
      evaluateMobility(
        input({ candidates: [road("car", "a", 30, 25)] }),
        unweighted,
      ),
    (error) => error.code === "POLICY_INVALID",
  );
});

test("the safety buffer is never null for any criticality", () => {
  for (const criticality of [
    "normal",
    "important_meeting",
    "airport_departure",
  ]) {
    const result = evaluateMobility(
      input({ criticality, candidates: [road("car", "a", 20, 20)] }),
    );
    const buffer = result.options[0].derived_metrics.safety_buffer_seconds;
    assert.equal(typeof buffer, "number");
    assert.ok(
      buffer >= MOBILITY_POLICY_V1.minimum_buffer_minutes[criticality] * 60,
    );
  }
});

test("transfers count service changes, not sections", () => {
  const berlin = [
    section("pedestrian", null, null, 0, 4),
    section("transit", "Tram M10", "BVG", 4, 8, "S+U Hauptbahnhof"),
    section("transit", "RE1", "DB", 19, 43, "Magdeburg"),
    section("transit", "Tram 96", "ViP", 49, 56, "Campus"),
    section("pedestrian", null, null, 56, 58),
  ];
  assert.equal(countTransfers(berlin), 2);
  // One ride split into two sections of the same service is not a transfer.
  const split = [
    section("transit", "RE1", "DB", 0, 10, "Magdeburg"),
    section("transit", "RE1", "DB", 10, 20, "Magdeburg"),
  ];
  assert.equal(countTransfers(split), 0);
  assert.equal(countTransfers([section("pedestrian", null, null, 0, 5)]), 0);
});

test("transfer limit excludes an option", () => {
  const sections = [
    section("transit", "A", "O1", 0, 10),
    section("transit", "B", "O2", 12, 22),
    section("transit", "C", "O3", 24, 34),
    section("transit", "D", "O4", 36, 46),
  ];
  const result = evaluateMobility(
    input({ arrival_deadline: null, candidates: [transit("many", sections)] }),
  );
  assert.equal(result.options[0].derived_metrics.transfer_count, 3);
  assert.deepEqual(result.options[0].exclusion_reasons, ["transfer_limit"]);
});

test("route delay classification uses the provider duration and baseDuration", () => {
  const level = (duration, base) =>
    classifyRouteDelay(
      { duration_seconds: duration, base_duration_seconds: base },
      MOBILITY_POLICY_V1,
    );
  assert.equal(level(1000, 1000).level, "low");
  assert.equal(level(1150, 1000).level, "medium");
  assert.equal(level(1400, 1000).level, "high");
  assert.equal(level(1000, null).level, "unknown");
  assert.equal(level(1000, 0).level, "unknown");
  assert.equal(level(900, 1000).delay_seconds, 0);
});

test("area traffic classification covers closures, incidents, and jam factor", () => {
  const level = (overrides) =>
    classifyTrafficArea(traffic(overrides), MOBILITY_POLICY_V1);
  assert.equal(level({}), "low");
  assert.equal(level({ average_jam_factor: 4.5 }), "medium");
  assert.equal(level({ average_jam_factor: 7.5 }), "high");
  assert.equal(level({ closed_segment_count: 1 }), "high");
  assert.equal(
    level({
      incident_count: 1,
      incidents: [
        {
          id: "1",
          type: "accident",
          criticality: "major",
          road_closed: false,
          summary: null,
          start_time: null,
          end_time: null,
        },
      ],
    }),
    "high",
  );
  assert.equal(
    level({
      incident_count: 1,
      incidents: [
        {
          id: "1",
          type: "congestion",
          criticality: "minor",
          road_closed: false,
          summary: null,
          start_time: null,
          end_time: null,
        },
      ],
    }),
    "medium",
  );
  assert.equal(
    level({ segment_count: 0, average_jam_factor: null }),
    "unknown",
  );
});

test("weather: heavy rain on a walking option raises risk and buffer, car is only medium", () => {
  const rainy = weather([
    hourly(35, {
      precipitation_probability: 0.9,
      precipitation_mm: 6,
      condition_id: 502,
      condition: "Rain",
    }),
  ]);
  const result = evaluateMobility(
    input({
      arrival_deadline: null,
      candidates: [
        road("car", "c", 35, 33),
        transit("t", [
          section("pedestrian", null, null, 0, 8),
          section("transit", "Line 1", "OP1", 10, 35),
        ]),
      ],
      weather: rainy,
    }),
  );
  const car = result.options.find((o) => o.key === "car:c");
  const bus = result.options.find((o) => o.key === "transit:t");
  assert.equal(car.risk.weather, "medium");
  assert.equal(bus.risk.weather, "high");
  assert.ok(bus.derived_metrics.reason_codes.includes("weather_risk"));
  // 20 min base + 5 min weather buffer for the exposed option.
  assert.equal(bus.derived_metrics.safety_buffer_seconds, 25 * 60);
  assert.equal(car.derived_metrics.safety_buffer_seconds, 20 * 60);
});

test("forecast selection: hourly within tolerance, then daily for the same local date, else null", () => {
  const w = weather([hourly(0), hourly(60)], {
    daily: [
      {
        at: "2026-11-15T05:00:00.000Z",
        granularity: "daily",
        temperature_c: 30,
        precipitation_probability: 0.8,
        precipitation_mm: 5,
        wind_speed_ms: 4,
        visibility_m: null,
        condition_id: 501,
        condition: "Rain",
        description: "moderate rain",
      },
    ],
  });
  const at = (minutes) => Date.parse(iso(minutes));
  assert.equal(
    selectForecastPoint(w, at(20), MOBILITY_POLICY_V1).granularity,
    "hourly",
  );
  assert.equal(selectForecastPoint(w, at(20), MOBILITY_POLICY_V1).at, iso(0));
  assert.equal(selectForecastPoint(w, at(40), MOBILITY_POLICY_V1).at, iso(60));
  assert.equal(
    selectForecastPoint(
      w,
      Date.parse("2026-11-15T09:00:00Z"),
      MOBILITY_POLICY_V1,
    ).granularity,
    "daily",
  );
  assert.equal(
    selectForecastPoint(
      w,
      Date.parse("2026-11-20T09:00:00Z"),
      MOBILITY_POLICY_V1,
    ),
    null,
  );
});

test("weather metrics the provider omitted are reported, not assumed", () => {
  const assessment = classifyWeatherPoint(
    hourly(0, { precipitation_probability: null, visibility_m: null }),
    MOBILITY_POLICY_V1,
  );
  assert.equal(assessment.level, "low");
  assert.deepEqual(assessment.missing_metrics, [
    "precipitation_probability",
    "visibility",
  ]);
  const none = classifyWeatherPoint(
    {
      at: iso(0),
      granularity: "hourly",
      temperature_c: null,
      precipitation_probability: null,
      precipitation_mm: null,
      wind_speed_ms: null,
      visibility_m: null,
      condition_id: null,
      condition: null,
      description: null,
    },
    MOBILITY_POLICY_V1,
  );
  assert.equal(none.level, "unknown");
});

test("invalid input is rejected with a structured error", () => {
  assert.throws(
    () => evaluateMobility(input({ arrival_deadline: "2026-11-12T00:00:00Z" })),
    (error) => error.code === "INPUT_INVALID",
  );
  assert.throws(
    () =>
      evaluateMobility(
        input({ preferences: { ...preferences, max_walking_minutes: -1 } }),
      ),
    (error) => error.code === "INPUT_INVALID",
  );
});

test("reason codes only come from the allowlist", () => {
  const result = evaluateMobility(
    input({
      candidates: golden(),
      traffic: traffic({ incident_count: 1, incidents: [] }),
      weather: weather([hourly(35)]),
    }),
  );
  const allowed = new Set([
    "arrival_deadline",
    "traffic_delay",
    "traffic_incident",
    "weather_risk",
    "walking_limit",
    "transfer_limit",
    "cost_limit",
    "shorter_duration",
    "more_buffer",
    "public_transit_preference",
    "comfort_preference",
    "route_unavailable",
    "weather_unavailable",
    "traffic_unavailable",
  ]);
  for (const option of result.options) {
    for (const code of [
      ...option.derived_metrics.reason_codes,
      ...option.exclusion_reasons,
    ]) {
      assert.ok(allowed.has(code), code);
    }
  }
});

test("haversine distance between hotel and convention center fixtures", () => {
  const meters = haversineMeters(
    { latitude: -6.1954, longitude: 106.823 },
    { latitude: -6.2147, longitude: 106.8097 },
  );
  assert.ok(meters > 2000 && meters < 3000, String(meters));
  assert.equal(
    haversineMeters(
      { latitude: 1, longitude: 2 },
      { latitude: 1, longitude: 2 },
    ),
    0,
  );
});
