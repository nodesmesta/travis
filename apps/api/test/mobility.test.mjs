import assert from "node:assert/strict";
import test from "node:test";
import { ExternalDataError } from "@travelflow/integrations";
import { FixedWindowLimiter } from "../dist/rate-limit.js";
import { isUuid } from "../dist/routes/mobility.js";
import {
  MobilityService,
  corridorArea,
  parseRouteRequestBody,
} from "../dist/services/mobility-service.js";
import {
  freshnessAt,
  recommendationDto,
  routeOptionDto,
} from "../dist/services/mobility-serializers.js";
import { MOBILITY_POLICY_V1 } from "@travelflow/domain";

// All data below is FIXTURE data for unit tests, not provider output.
const TRIP = "00000000-0000-0000-0000-000000000001";
const LEG = "00000000-0000-0000-0000-0000000000a1";
const ORIGIN = "00000000-0000-0000-0000-000000000011";
const DEST = "00000000-0000-0000-0000-000000000012";
const NOW = new Date("2026-11-12T00:00:00.000Z");

test("isUuid accepts canonical UUIDs only", () => {
  assert.equal(isUuid("123e4567-e89b-12d3-a456-426614174000"), true);
  assert.equal(isUuid("123E4567-E89B-12D3-A456-426614174000"), true);
  assert.equal(isUuid("not-a-uuid"), false);
  assert.equal(isUuid("123e4567e89b12d3a456426614174000"), false);
  assert.equal(isUuid("123e4567-e89b-12d3-a456-42661417400g"), false);
});

test("rate limiter blocks after the limit and reopens after the window", () => {
  let clock = 0;
  const limiter = new FixedWindowLimiter(2, 1000, () => clock);
  assert.equal(limiter.take("a"), 0);
  assert.equal(limiter.take("a"), 0);
  assert.equal(limiter.take("a"), 1);
  assert.equal(limiter.take("b"), 0, "keys are independent");
  clock = 1000;
  assert.equal(limiter.take("a"), 0);
});

test("route request body: defaults come from the policy and bad values are refused", () => {
  const parsed = parseRouteRequestBody({}, MOBILITY_POLICY_V1);
  assert.deepEqual(parsed.requiredFacts, ["route"]);
  assert.deepEqual(parsed.modes, ["car", "pedestrian", "transit"]);
  assert.equal(parsed.preferences.max_walking_minutes, 15);
  assert.equal(parsed.preferences.max_transfers, 2);
  const custom = parseRouteRequestBody(
    {
      required_facts: ["weather"],
      modes: ["taxi"],
      preferences: { avoid_heavy_traffic: true, comfort_priority: "high" },
    },
    MOBILITY_POLICY_V1,
  );
  assert.deepEqual(custom.requiredFacts, ["route", "weather"]);
  assert.equal(custom.preferences.avoid_heavy_traffic, true);
  for (const body of [
    { derived_metrics: {} },
    { modes: ["boat"] },
    { required_facts: "route" },
    { preferences: { max_transfers: 1.5 } },
    { preferences: { max_walking_minutes: -3 } },
    { preferences: { comfort_priority: "extreme" } },
  ]) {
    assert.throws(
      () => parseRouteRequestBody(body, MOBILITY_POLICY_V1),
      (error) => error.code === "REQUEST_INVALID",
    );
  }
});

test("traffic corridor is centered on the leg and bounded", () => {
  const area = corridorArea(
    { latitude: -6.1954, longitude: 106.823 },
    { latitude: -6.2147, longitude: 106.8097 },
  );
  assert.equal(area.latitude, -6.20505);
  assert.ok(area.radiusMeters >= 1000 && area.radiusMeters <= 20000);
  const long = corridorArea(
    { latitude: -6, longitude: 100 },
    { latitude: -7, longitude: 110 },
  );
  assert.equal(long.radiusMeters, 20000);
});

const optionRow = (overrides = {}) => ({
  id: "o1",
  route_request_id: "r1",
  trip_id: TRIP,
  provider: "here_routing_v8",
  provider_route_id: "p1",
  transport_mode: "car",
  source_id: "s1",
  weather_snapshot_id: null,
  traffic_snapshot_id: null,
  provider_facts: {},
  derived_metrics: {},
  cost: {},
  risk: {},
  score: { total: 0.8, components: {}, weights: {} },
  rank: 1,
  status: "valid",
  exclusion_reasons: [],
  recommended: true,
  policy_version: "mobility-v1",
  retrieved_at: "2026-11-11T23:50:00.000Z",
  expires_at: "2026-11-12T00:05:00.000Z",
  ...overrides,
});

test("freshness is decided from expires_at at read time", () => {
  assert.equal(freshnessAt("2026-11-12T00:00:01.000Z", NOW), "fresh");
  assert.equal(freshnessAt("2026-11-12T00:00:00.000Z", NOW), "expired");
});

test("an expired option is reported as expired and never as recommended", () => {
  const request = { selected_option_id: null };
  const fresh = routeOptionDto(optionRow(), request, NOW, {
    weather: null,
    traffic: null,
  });
  assert.equal(fresh.status, "valid");
  assert.equal(fresh.recommended, true);
  assert.equal(fresh.score.rank, 1);
  const expired = routeOptionDto(
    optionRow({ expires_at: "2026-11-11T23:59:00.000Z" }),
    request,
    NOW,
    { weather: null, traffic: null },
  );
  assert.equal(expired.status, "expired");
  assert.equal(expired.recommended, false);
  assert.equal(expired.freshness, "expired");
  const excluded = routeOptionDto(
    optionRow({
      status: "excluded",
      recommended: false,
      expires_at: "2026-11-11T23:59:00.000Z",
    }),
    request,
    NOW,
    { weather: null, traffic: null },
  );
  assert.equal(excluded.status, "excluded");
});

test("a recommendation past its expiry is reported as expired", () => {
  const row = {
    id: "rec1",
    trip_id: TRIP,
    conversation_id: null,
    context_point_id: DEST,
    recommendation_type: "route",
    route_request_id: "r1",
    route_option_id: "o1",
    status: "suggested",
    reason: "x",
    payload: {},
    context_snapshot: {},
    policy_version: "mobility-v1",
    created_at: "2026-11-11T23:00:00.000Z",
    expires_at: "2026-11-11T23:15:00.000Z",
  };
  const dto = recommendationDto(row, ["s1"], NOW);
  assert.equal(dto.freshness, "expired");
  assert.equal(dto.status, "expired");
  assert.deepEqual(dto.source_ids, ["s1"]);
});

// --- service with in-memory fakes ---------------------------------------------

function memoryRepo() {
  const rows = {
    sources: [],
    weather: [],
    traffic: [],
    requests: [],
    options: [],
    recommendations: [],
    references: [],
  };
  return {
    rows,
    batches: [],
    async persistBatch(batch) {
      this.batches.push(batch);
      rows.sources.push(...(batch.sources ?? []));
      rows.weather.push(...(batch.weather_snapshots ?? []));
      rows.traffic.push(...(batch.traffic_snapshots ?? []));
      rows.requests.push(...(batch.route_requests ?? []));
      rows.options.push(...(batch.route_options ?? []));
      rows.recommendations.push(...(batch.recommendations ?? []));
      rows.references.push(...(batch.source_references ?? []));
    },
    async findFreshWeather(_trip, fingerprint, now) {
      return (
        rows.weather.find(
          (row) =>
            row.request_fingerprint === fingerprint && row.expires_at > now,
        ) ?? null
      );
    },
    async findFreshTraffic(_trip, fingerprint, now) {
      return (
        rows.traffic.find(
          (row) =>
            row.request_fingerprint === fingerprint && row.expires_at > now,
        ) ?? null
      );
    },
    async getRouteRequest(_trip, id) {
      return rows.requests.find((row) => row.id === id) ?? null;
    },
    async listRouteOptions(_trip, id) {
      return rows.options.filter((row) => row.route_request_id === id);
    },
    async getWeatherById(_trip, id) {
      return rows.weather.find((row) => row.id === id) ?? null;
    },
    async getTrafficById(_trip, id) {
      return rows.traffic.find((row) => row.id === id) ?? null;
    },
    async getSourcesByIds(_trip, ids) {
      return rows.sources.filter((row) => ids.includes(row.id));
    },
  };
}

const point = (id, label, latitude, longitude, type = "hotel") => ({
  id,
  tripId: TRIP,
  type,
  label,
  address: null,
  latitude,
  longitude,
  timezone: "Asia/Jakarta",
  externalPlaceId: `fixture-${id}`,
  status: "active",
  resolutionStatus: "resolved",
  confirmationStatus: "confirmed",
  source: "user_input",
  metadata: {},
});

const leg = (overrides = {}) => ({
  id: LEG,
  tripId: TRIP,
  originContextPointId: ORIGIN,
  destinationContextPointId: DEST,
  relatedAgendaId: null,
  departureAt: "2026-11-12T00:45:00.000Z",
  arrivalDeadline: "2026-11-12T02:00:00.000Z",
  status: "planned",
  ...overrides,
});

const carAnswer = () => ({
  routes: [
    {
      id: "fixture-car",
      sections: [
        {
          id: "s",
          type: "vehicle",
          departure: {
            time: "2026-11-12T00:45:00Z",
            place: { type: "place", location: { lat: -6.1954, lng: 106.823 } },
          },
          arrival: {
            time: "2026-11-12T01:20:00Z",
            place: { type: "place", location: { lat: -6.2147, lng: 106.8097 } },
          },
          summary: { duration: 2100, length: 4800, baseDuration: 1500 },
          transport: { mode: "car" },
        },
      ],
    },
  ],
});

const currentAnswer = () => ({
  coord: { lat: -6.2147, lon: 106.8097 },
  dt: 1794960000,
  main: { temp: 30 },
  weather: [{ id: 800, main: "Clear", description: "clear sky" }],
  wind: { speed: 1.5 },
  visibility: 10000,
});

const forecastAnswer = () => ({
  cod: "200",
  list: [
    {
      dt: 1794963600,
      main: { temp: 30 },
      pop: 0.1,
      weather: [{ id: 800, main: "Clear", description: "clear" }],
    },
    {
      dt: 1794974400,
      main: { temp: 29 },
      pop: 0.3,
      weather: [{ id: 801, main: "Clouds", description: "few clouds" }],
    },
  ],
});

function harness({
  here = {},
  weather = {},
  nowDate = NOW,
  legRecord = leg(),
} = {}) {
  const repo = memoryRepo();
  const calls = { road: 0, weather: 0 };
  const service = new MobilityService({
    trips: {
      async getTripRowForUser(tripId, userId) {
        return tripId === TRIP && userId === "user-1" ? { id: TRIP } : null;
      },
      async getJourneyLeg(id) {
        return id === LEG ? legRecord : null;
      },
      async getContextPoint(id) {
        if (id === ORIGIN)
          return point(ORIGIN, "Fixture Hotel", -6.1954, 106.823);
        if (id === DEST)
          return point(DEST, "Fixture Venue", -6.2147, 106.8097, "conference");
        return null;
      },
      async getAgendaItem() {
        return null;
      },
      async listContextPointsForTrip() {
        return [];
      },
    },
    repo,
    here: {
      async roadRoutes() {
        calls.road += 1;
        if (here.fail) throw here.fail;
        return {
          json: carAnswer(),
          auditUrl: "https://router.example/v8/routes?x=1",
          providerRequestId: null,
          httpStatus: 200,
        };
      },
      async intermodalRoutes() {
        throw new Error("not requested");
      },
      async trafficFlow() {
        throw new Error("not requested");
      },
      async trafficIncidents() {
        throw new Error("not requested");
      },
    },
    weather: {
      async snapshot() {
        calls.weather += 1;
        if (weather.fail) throw weather.fail;
        return {
          current: {
            json: currentAnswer(),
            auditUrl: "https://owm.example/data/2.5/weather?units=metric",
            providerRequestId: "req-current",
            httpStatus: 200,
          },
          forecast: {
            json: forecastAnswer(),
            auditUrl: "https://owm.example/data/2.5/forecast?units=metric",
            providerRequestId: "req-forecast",
            httpStatus: 200,
          },
        };
      },
    },
    idempotency: {
      execute: async (_scope, _context, operation) => operation(),
    },
    activityLog: { async append() {} },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    now: () => nowDate,
  });
  return { service, repo, calls };
}

const command = {
  actorUserId: "user-1",
  idempotencyKey: "fixture-key-0000001",
  requestHash: "h",
};
const input = (body = {}) => ({
  tripId: TRIP,
  userId: "user-1",
  journeyLegId: LEG,
  requestId: "req-1",
  body,
});

test("service: a route request stores options, one recommendation, and returns them", async () => {
  const { service, repo } = harness();
  const result = await service.createRouteRequest(
    input({ modes: ["car"] }),
    command,
  );
  assert.equal(result.options.length, 1);
  assert.equal(result.options[0].status, "valid");
  assert.equal(result.options[0].recommended, true);
  assert.equal(result.recommended_option_id, result.options[0].id);
  assert.equal(repo.rows.recommendations.length, 1);
  assert.equal(
    repo.rows.recommendations[0].route_option_id,
    result.options[0].id,
  );
  assert.equal(repo.rows.requests[0].status, "completed");
  assert.equal(repo.batches.length, 1, "one transaction for the whole result");
});

test("service: a provider failure stores a failed request and no option, then rethrows", async () => {
  const failure = new ExternalDataError(
    "EXTERNAL_PROVIDER_TIMEOUT",
    "here",
    "timed out",
    504,
    true,
  );
  const { service, repo } = harness({ here: { fail: failure } });
  await assert.rejects(
    service.createRouteRequest(input({ modes: ["car"] }), command),
    (error) => error === failure,
  );
  assert.equal(repo.rows.requests.length, 1);
  assert.equal(repo.rows.requests[0].status, "failed");
  assert.equal(repo.rows.requests[0].error_code, "EXTERNAL_PROVIDER_TIMEOUT");
  assert.equal(repo.rows.options.length, 0);
  assert.equal(repo.rows.recommendations.length, 0);
});

test("service: a leg outside the trip or a finished leg is refused", async () => {
  const { service } = harness();
  await assert.rejects(
    service.createRouteRequest(
      { ...input(), journeyLegId: "00000000-0000-0000-0000-0000000000ff" },
      command,
    ),
    (error) => error.code === "RESOURCE_NOT_FOUND" && error.statusCode === 404,
  );
  const other = harness({
    legRecord: leg({ tripId: "00000000-0000-0000-0000-000000000099" }),
  });
  await assert.rejects(
    other.service.createRouteRequest(input(), command),
    (error) => error.statusCode === 404,
  );
  const done = harness({ legRecord: leg({ status: "completed" }) });
  await assert.rejects(
    done.service.createRouteRequest(input(), command),
    (error) => error.code === "JOURNEY_LEG_STATE_INVALID",
  );
  const stranger = harness();
  await assert.rejects(
    stranger.service.createRouteRequest(
      { ...input(), userId: "user-2" },
      command,
    ),
    (error) => error.statusCode === 404,
  );
});

test("service: required traffic for a leg that departs later is an error, not a guess", async () => {
  const { service, repo } = harness({
    legRecord: leg({
      departureAt: "2026-11-17T00:45:00.000Z",
      arrivalDeadline: "2026-11-17T02:00:00.000Z",
    }),
  });
  await assert.rejects(
    service.createRouteRequest(
      input({ required_facts: ["route", "traffic"], modes: ["car"] }),
      command,
    ),
    (error) =>
      error.code === "TRAFFIC_FACTS_MISSING" &&
      error.details.reason === "departure_beyond_live_horizon",
  );
  assert.equal(repo.rows.requests[0].status, "failed");
  assert.equal(repo.rows.requests[0].error_code, "TRAFFIC_FACTS_MISSING");
});

test("service: weather uses a valid snapshot and calls the provider again once it has expired", async () => {
  const { service, repo, calls } = harness();
  const point1 = point(DEST, "Fixture Venue", -6.2147, 106.8097, "conference");
  const first = await service.weatherFor(TRIP, point1);
  assert.equal(first.cache, "miss");
  assert.equal(calls.weather, 1);
  const second = await service.weatherFor(TRIP, point1);
  assert.equal(second.cache, "hit");
  assert.equal(second.row.id, first.row.id);
  assert.equal(calls.weather, 1);
  // Make the stored snapshot expired.
  repo.rows.weather[0].expires_at = "2026-11-11T23:00:00.000Z";
  const third = await service.weatherFor(TRIP, point1);
  assert.equal(third.cache, "miss");
  assert.equal(calls.weather, 2);
  assert.notEqual(third.row.id, first.row.id);
  // A moved context point is a different query.
  const moved = await service.weatherFor(
    TRIP,
    point(DEST, "Fixture Venue", -6.3, 106.9, "conference"),
  );
  assert.equal(moved.cache, "miss");
});

test("service: a weather snapshot records both requests, the 3-hour forecast, and where it ends", async () => {
  const { service, repo } = harness();
  const venue = point(DEST, "Fixture Venue", -6.2147, 106.8097, "conference");
  const { row } = await service.weatherFor(TRIP, venue);

  assert.equal(row.provider, "openweather_free_2_5");
  assert.equal(row.timezone, "Asia/Jakarta");
  assert.equal(row.payload.forecast_interval_minutes, 180);
  assert.equal(row.payload.forecast_ends_at, "2026-11-18T04:00:00.000Z");
  assert.equal(row.payload.hourly.length, 2);
  assert.equal(row.payload.hourly[0].granularity, "three_hourly");
  assert.deepEqual(row.payload.daily, []);
  assert.equal(row.max_precipitation_probability, 0.3);

  const source = repo.rows.sources.find((entry) => entry.id === row.source_id);
  assert.equal(source.provider, "openweather_free_2_5");
  assert.deepEqual(
    source.metadata.requests.map((request) => request.provider_request_id),
    ["req-current", "req-forecast"],
  );
  assert.deepEqual(source.metadata.provider_request_ids, [
    "req-current",
    "req-forecast",
  ]);
  assert.ok(
    source.metadata.requests.every(
      (request) => !request.audit_url.includes("appid"),
    ),
  );
});

test("service: weather provider errors are not replaced by an expired snapshot", async () => {
  const failure = new ExternalDataError(
    "EXTERNAL_PROVIDER_ERROR",
    "openweather",
    "boom",
    502,
    true,
  );
  const { service, repo, calls } = harness();
  const venue = point(DEST, "Fixture Venue", -6.2147, 106.8097, "conference");
  await service.weatherFor(TRIP, venue);
  repo.rows.weather[0].expires_at = "2026-11-11T23:00:00.000Z";
  const broken = harness({ weather: { fail: failure } });
  broken.repo.rows.weather.push(...repo.rows.weather);
  await assert.rejects(
    broken.service.weatherFor(TRIP, venue),
    (error) => error === failure,
  );
  assert.equal(calls.weather, 1);
});

test("service: the policy buffer is applied to a stored option", async () => {
  const { service } = harness();
  const result = await service.createRouteRequest(
    input({ modes: ["car"] }),
    command,
  );
  const metrics = result.options[0].derived_metrics;
  // Conference destination without a related meeting: normal criticality, 10 min, plus 10 min for high traffic delay.
  assert.equal(metrics.safety_buffer_seconds, 20 * 60);
  assert.equal(metrics.feasible, true);
  assert.equal(result.options[0].risk.traffic, "high");
  assert.equal(result.options[0].cost.source_type, "unavailable");
});

const previewInput = (overrides = {}) => ({
  tripId: TRIP,
  userId: "user-1",
  requestId: "req-1",
  originContextPointId: ORIGIN,
  destinationContextPointId: DEST,
  departureAt: "2026-11-12T00:45:00.000Z",
  modes: ["car"],
  ...overrides,
});

test("service: a preview ranks like a stored request and writes nothing", async () => {
  const stored = harness({ legRecord: leg({ arrivalDeadline: null }) });
  const storedResult = await stored.service.createRouteRequest(
    input({ modes: ["car"] }),
    command,
  );
  const { service, repo, calls } = harness();
  const preview = await service.previewRoutes(previewInput());
  assert.equal(preview.preview, true);
  assert.equal(preview.departure_basis, "requested");
  assert.equal(preview.options.length, 1);
  assert.equal(preview.recommended_option_id, preview.options[0].id);
  assert.equal(preview.options[0].recommended, true);
  assert.equal(preview.options[0].score.rank, 1);
  // The same engine produced the same figures.
  assert.deepEqual(
    preview.options[0].derived_metrics,
    storedResult.options[0].derived_metrics,
  );
  assert.deepEqual(preview.options[0].risk, storedResult.options[0].risk);
  assert.equal(calls.road, 1);
  assert.equal(repo.batches.length, 0, "a preview stores nothing");
  assert.equal(preview.sources.length >= 1, true);
  for (const id of preview.options[0].source_ids) {
    assert.ok(preview.sources.some((source) => source.id === id));
  }
});

test("service: a preview without a time leaves now, and a past time is refused", async () => {
  const { service } = harness();
  const now = await service.previewRoutes(previewInput({ departureAt: null }));
  assert.equal(now.departure_basis, "now");
  assert.equal(now.departure_at, NOW.toISOString());
  await assert.rejects(
    service.previewRoutes(
      previewInput({ departureAt: "2026-11-11T20:00:00.000Z" }),
    ),
    (error) => error.code === "REQUEST_INVALID",
  );
  await assert.rejects(
    service.previewRoutes(previewInput({ destinationContextPointId: ORIGIN })),
    (error) => error.code === "REQUEST_INVALID",
  );
});

test("service: a preview provider failure is rethrown and stores nothing", async () => {
  const failure = new ExternalDataError(
    "EXTERNAL_CONFIGURATION_MISSING",
    "here",
    "HERE Routing is not configured.",
    503,
  );
  const { service, repo } = harness({ here: { fail: failure } });
  await assert.rejects(
    service.previewRoutes(previewInput()),
    (error) => error === failure,
  );
  assert.equal(repo.batches.length, 0);
});
