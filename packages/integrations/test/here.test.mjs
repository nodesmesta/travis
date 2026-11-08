import assert from "node:assert/strict";
import test from "node:test";
import {
  ExternalDataError,
  HereClient,
  normalizeHereGeocode,
  normalizeHereIntermodalRoutes,
  normalizeHereRoadRoutes,
  normalizeHereTraffic,
} from "../dist/index.js";
import {
  FIXTURE_HERE_CAR_ROUTE,
  FIXTURE_HERE_EMPTY_LIST,
  FIXTURE_HERE_FERRY_ROUTE,
  FIXTURE_HERE_FLOW,
  FIXTURE_HERE_GEOCODE_AMBIGUOUS,
  FIXTURE_HERE_GEOCODE_ONE,
  FIXTURE_HERE_INCIDENTS,
  FIXTURE_HERE_INTERMODAL,
  FIXTURE_HERE_NO_ROUTE,
  FIXTURE_HERE_WALK_ROUTE,
} from "./mobility-fixtures.mjs";
import { has, lacks } from "./helpers.mjs";

const origin = { latitude: -6.1954, longitude: 106.823 };
const destination = { latitude: -6.2147, longitude: 106.8097 };
const departureAt = "2026-11-12T07:45:00+07:00";

function client(fetchImpl, overrides = {}) {
  return new HereClient({
    apiKey: "secret-here-key",
    timeoutMs: 200,
    fetchImpl,
    ...overrides,
  });
}

function json(body, status = 200, headers = {}) {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ExternalDataError, String(error));
    return error;
  }
  assert.fail("expected the call to be rejected");
}

test("HERE without a key fails with a structured error and never calls the network", async () => {
  let called = false;
  const here = new HereClient({
    apiKey: undefined,
    fetchImpl: async () => {
      called = true;
      return new Response("{}");
    },
  });
  assert.equal(here.configured, false);
  const error = await rejection(
    here.roadRoutes({ mode: "car", origin, destination, departureAt }),
  );
  assert.equal(error.code, "EXTERNAL_CONFIGURATION_MISSING");
  assert.equal(error.statusCode, 503);
  assert.equal(called, false);
});

test("road route request uses documented parameters, no traffic override, and hides the key in audit data", async () => {
  let seen;
  const here = client(async (url) => {
    seen = new URL(url);
    return new Response(JSON.stringify(FIXTURE_HERE_CAR_ROUTE), {
      status: 200,
    });
  });
  const result = await here.roadRoutes({
    mode: "taxi",
    origin,
    destination,
    departureAt,
  });
  assert.equal(seen.origin, "https://router.hereapi.com");
  assert.equal(seen.pathname, "/v8/routes");
  assert.equal(seen.searchParams.get("transportMode"), "taxi");
  assert.equal(seen.searchParams.get("origin"), "-6.1954,106.823");
  assert.equal(seen.searchParams.get("destination"), "-6.2147,106.8097");
  assert.equal(seen.searchParams.get("departureTime"), departureAt);
  assert.equal(seen.searchParams.get("return"), "summary,typicalDuration");
  assert.equal(seen.searchParams.get("apiKey"), "secret-here-key");
  assert.equal(seen.searchParams.has("traffic[mode]"), false);
  lacks(result.auditUrl, "secret-here-key");
  lacks(result.auditUrl, "apiKey");
  has(result.auditUrl, "transportMode=taxi");
});

test("intermodal, traffic, geocode, and browse requests target their documented hosts", async () => {
  const urls = [];
  const here = client(async (url) => {
    urls.push(new URL(url));
    return new Response("{}", { status: 200 });
  });
  await here.intermodalRoutes({ origin, destination, departureAt });
  await here.trafficFlow({ ...destination, radiusMeters: 1500.4 });
  await here.trafficIncidents({ ...destination, radiusMeters: 1500 });
  await here.geocode({
    query: "Jakarta Convention Center",
    countryCode: "IDN",
  });
  await here.browse({
    center: destination,
    radiusMeters: 1000,
    categories: ["100-1000-0000"],
    limit: 20,
  });
  assert.equal(urls[0].origin, "https://intermodal.router.hereapi.com");
  assert.equal(urls[0].searchParams.get("alternatives"), "2");
  assert.equal(urls[1].origin, "https://data.traffic.hereapi.com");
  assert.equal(urls[1].pathname, "/v7/flow");
  assert.equal(
    urls[1].searchParams.get("in"),
    "circle:-6.2147,106.8097;r=1500",
  );
  assert.equal(urls[2].pathname, "/v7/incidents");
  assert.equal(urls[3].origin, "https://geocode.search.hereapi.com");
  assert.equal(urls[3].pathname, "/v1/geocode");
  assert.equal(urls[3].searchParams.get("in"), "countryCode:IDN");
  assert.equal(urls[4].origin, "https://browse.search.hereapi.com");
  assert.equal(urls[4].searchParams.get("categories"), "100-1000-0000");
  assert.equal(urls[4].searchParams.get("at"), "-6.2147,106.8097");
});

test("a test base URL replaces the host and keeps the path", async () => {
  let seen;
  const here = client(
    async (url) => {
      seen = new URL(url);
      return new Response("{}", { status: 200 });
    },
    { baseUrls: { router: "http://127.0.0.1:9/here/router" } },
  );
  await here.roadRoutes({ mode: "car", origin, destination, departureAt });
  assert.equal(seen.origin, "http://127.0.0.1:9");
  assert.equal(seen.pathname, "/here/router/v8/routes");
});

test("provider failures map to structured errors without retry", async () => {
  let calls = 0;
  const counting =
    (status, body = "{}", headers = {}) =>
    async () => {
      calls += 1;
      return new Response(body, { status, headers });
    };
  const call = (fetchImpl) =>
    client(fetchImpl).roadRoutes({
      mode: "car",
      origin,
      destination,
      departureAt,
    });

  let error = await rejection(call(counting(401)));
  assert.equal(error.code, "EXTERNAL_PROVIDER_REJECTED");
  error = await rejection(call(counting(429, "{}", { "retry-after": "30" })));
  assert.equal(error.code, "EXTERNAL_PROVIDER_RATE_LIMITED");
  assert.equal(error.details.retry_after_seconds, 30);
  error = await rejection(call(counting(503)));
  assert.equal(error.code, "EXTERNAL_PROVIDER_ERROR");
  assert.equal(error.retryable, true);
  error = await rejection(call(counting(400)));
  assert.equal(error.code, "EXTERNAL_QUERY_INVALID");
  error = await rejection(call(counting(200, "not json")));
  assert.equal(error.code, "EXTERNAL_RESPONSE_INVALID");
  assert.equal(calls, 5, "each failure is exactly one request");

  error = await rejection(
    call(async () => {
      throw new TypeError("fetch failed secret-here-key");
    }),
  );
  assert.equal(error.code, "EXTERNAL_PROVIDER_ERROR");
  lacks(error.message, "secret-here-key");

  error = await rejection(
    call(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            const abort = new Error("aborted");
            abort.name = "AbortError";
            reject(abort);
          });
        }),
    ),
  );
  assert.equal(error.code, "EXTERNAL_PROVIDER_TIMEOUT");
});

test("an oversized answer is refused", async () => {
  const here = client(json({ routes: [] }), { maxResponseBytes: 5 });
  const error = await rejection(
    here.roadRoutes({ mode: "car", origin, destination, departureAt }),
  );
  assert.equal(error.code, "EXTERNAL_RESPONSE_INVALID");
});

test("invalid coordinates are refused before any request", async () => {
  const here = client(async () => assert.fail("no request expected"));
  const error = await rejection(
    here.roadRoutes({
      mode: "car",
      origin: { latitude: 95, longitude: 0 },
      destination,
      departureAt,
    }),
  );
  assert.equal(error.code, "EXTERNAL_QUERY_INVALID");
});

test("road route normalization keeps provider facts and sums sections", () => {
  const { candidates, dropped } = normalizeHereRoadRoutes(
    FIXTURE_HERE_CAR_ROUTE,
    "car",
  );
  assert.equal(dropped.length, 0);
  assert.equal(candidates.length, 1);
  const car = candidates[0];
  assert.equal(car.provider, "here_routing_v8");
  assert.equal(car.provider_route_id, "fixture-route-car-0001");
  assert.equal(car.transport_mode, "car");
  assert.equal(car.duration_seconds, 2100);
  assert.equal(car.base_duration_seconds, 1500);
  assert.equal(car.typical_duration_seconds, 1800);
  assert.equal(car.distance_meters, 4800);
  assert.equal(car.departure_at, "2026-11-12T00:45:00.000Z");
  assert.equal(car.arrival_at, "2026-11-12T01:20:00.000Z");
  assert.equal(car.sections.length, 1);
  assert.equal(car.sections[0].type, "vehicle");
  assert.equal(car.sections[0].operator, null);
  assert.equal(
    car.provider_fare,
    null,
    "HERE routing returns no fare, so none is invented",
  );
  assert.equal(car.source_key, "here_routing_v8:car");
});

test("baseDuration is reported only when every section has one, ferries count by duration", () => {
  const ferry = normalizeHereRoadRoutes(FIXTURE_HERE_FERRY_ROUTE, "car")
    .candidates[0];
  assert.equal(ferry.duration_seconds, 541 + 5449);
  assert.equal(ferry.base_duration_seconds, 501 + 5449);
  assert.equal(ferry.typical_duration_seconds, null);

  const broken = structuredClone(FIXTURE_HERE_CAR_ROUTE);
  delete broken.routes[0].sections[0].summary.baseDuration;
  delete broken.routes[0].sections[0].summary.typicalDuration;
  const candidate = normalizeHereRoadRoutes(broken, "car").candidates[0];
  assert.equal(candidate.base_duration_seconds, null);
  assert.equal(candidate.typical_duration_seconds, null);
});

test("an empty routing answer is an empty list, not an error and not a route", () => {
  assert.deepEqual(
    normalizeHereRoadRoutes(FIXTURE_HERE_NO_ROUTE, "car").candidates,
    [],
  );
});

test("malformed routing answers are rejected, not repaired", () => {
  assert.throws(() => normalizeHereRoadRoutes({}, "car"), ExternalDataError);
  const noDuration = structuredClone(FIXTURE_HERE_CAR_ROUTE);
  delete noDuration.routes[0].sections[0].summary.duration;
  assert.throws(
    () => normalizeHereRoadRoutes(noDuration, "car"),
    (error) =>
      error instanceof ExternalDataError && error.message.includes("duration"),
  );
  const noZone = structuredClone(FIXTURE_HERE_CAR_ROUTE);
  noZone.routes[0].sections[0].departure.time = "2026-11-12T07:45:00";
  assert.throws(
    () => normalizeHereRoadRoutes(noZone, "car"),
    (error) =>
      error instanceof ExternalDataError && error.message.includes("timezone"),
  );
  const noPlace = structuredClone(FIXTURE_HERE_CAR_ROUTE);
  delete noPlace.routes[0].sections[0].arrival.place;
  assert.throws(
    () => normalizeHereRoadRoutes(noPlace, "car"),
    (error) =>
      error instanceof ExternalDataError && error.message.includes("location"),
  );
});

test("pedestrian routing keeps the pedestrian section", () => {
  const walk = normalizeHereRoadRoutes(FIXTURE_HERE_WALK_ROUTE, "pedestrian")
    .candidates[0];
  assert.equal(walk.transport_mode, "pedestrian");
  assert.equal(walk.sections[0].type, "pedestrian");
  assert.equal(walk.duration_seconds, 3900);
});

test("intermodal routes: operators come from agency, pedestrian-only routes are not transit", () => {
  const { candidates, dropped } = normalizeHereIntermodalRoutes(
    FIXTURE_HERE_INTERMODAL,
  );
  assert.equal(candidates.length, 1);
  assert.deepEqual(dropped, [
    { provider_route_id: "R00347b-W0", reason: "no_transit_section" },
  ]);
  const route = candidates[0];
  assert.equal(route.provider, "here_intermodal_v8");
  assert.equal(route.transport_mode, "transit");
  assert.deepEqual(
    route.sections.map((section) => section.type),
    ["pedestrian", "transit", "transit", "transit", "pedestrian"],
  );
  assert.equal(route.sections[1].operator, "Berliner Verkehrsbetriebe");
  assert.equal(route.sections[1].operator_id, "BVG");
  assert.equal(route.sections[1].service_name, "Tram M10");
  assert.equal(route.sections[1].headsign, "S+U Hauptbahnhof");
  assert.equal(
    route.sections[0].operator,
    null,
    "a walking section has no operator",
  );
  assert.equal(route.sections[0].from.provider_place_id, null);
  assert.equal(route.sections[0].to.provider_place_id, "vbb_900100709");
  assert.equal(route.duration_seconds, 58 * 60);
  assert.equal(route.departure_at, "2020-04-28T15:53:00.000Z");
  assert.equal(route.arrival_at, "2020-04-28T16:51:00.000Z");
  assert.deepEqual(route.notices, ["walkOptionViolated"]);
  assert.equal(route.base_duration_seconds, null);
  assert.equal(route.provider_fare, null);
});

test("traffic normalization weights jam factor by length and counts closures and incidents", () => {
  const traffic = normalizeHereTraffic(
    FIXTURE_HERE_FLOW,
    FIXTURE_HERE_INCIDENTS,
  );
  assert.equal(traffic.segment_count, 3);
  // (6*300 + 2*100 + 10*1) / 401
  assert.equal(traffic.average_jam_factor, 5.01);
  assert.equal(traffic.max_jam_factor, 10);
  assert.equal(traffic.closed_segment_count, 1);
  assert.equal(traffic.incident_count, 2);
  assert.equal(traffic.incidents[0].road_closed, true);
  assert.equal(traffic.incidents[0].criticality, "critical");
  assert.equal(traffic.incidents[0].summary, "Closed due to roadwork.");
  assert.equal(traffic.incidents[1].criticality, "minor");
  assert.equal(traffic.incidents[1].start_time, null);
  assert.equal(traffic.observed_at, "2026-11-12T00:40:00.000Z");
});

test("an empty traffic area has zero segments and no average", () => {
  const traffic = normalizeHereTraffic(
    FIXTURE_HERE_EMPTY_LIST,
    FIXTURE_HERE_EMPTY_LIST,
  );
  assert.equal(traffic.segment_count, 0);
  assert.equal(traffic.average_jam_factor, null);
  assert.equal(traffic.incident_count, 0);
});

test("traffic answers with out-of-range values are rejected", () => {
  const bad = structuredClone(FIXTURE_HERE_FLOW);
  bad.results[0].currentFlow.jamFactor = 11;
  assert.throws(
    () => normalizeHereTraffic(bad, FIXTURE_HERE_EMPTY_LIST),
    ExternalDataError,
  );
  assert.throws(
    () => normalizeHereTraffic({}, FIXTURE_HERE_EMPTY_LIST),
    ExternalDataError,
  );
});

test("geocoding resolves one clear match, reports ambiguity, and reports empty", () => {
  const one = normalizeHereGeocode(FIXTURE_HERE_GEOCODE_ONE);
  assert.equal(one.status, "resolved");
  assert.equal(one.place.provider_place_id, "here:pds:place:fixture-jcc");
  assert.equal(one.place.latitude, -6.2147);
  const ambiguous = normalizeHereGeocode(FIXTURE_HERE_GEOCODE_AMBIGUOUS);
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.candidates.length, 2);
  assert.deepEqual(normalizeHereGeocode({ items: [] }), { status: "empty" });
  assert.throws(
    () => normalizeHereGeocode({ items: [{ title: "x" }] }),
    ExternalDataError,
  );
});
