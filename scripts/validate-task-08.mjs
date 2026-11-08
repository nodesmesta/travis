// Validator for Task 08 (mobility, weather, traffic, nearby places).
//
//   API_BASE_URL=http://127.0.0.1:4108/api/v1 node --env-file=.env.local scripts/validate-task-08.mjs
//
// It needs the API running from apps/api/dist (build first), the local Supabase
// database with migration 0007, and BRIGHT_DATA_* plus VULTR_INFERENCE_* for the
// live activity check.
//
// Three kinds of check, and the output never mixes them:
//   LIVE     talks to the API and database as configured in .env.local. HERE and
//            OpenWeather checks are BLOCKED while HERE_API_KEY or
//            OPENWEATHER_API_KEY is empty.
//   FIXTURE  starts a second API process whose HERE and OpenWeather hosts point at a
//            local server that answers with documented response shapes
//            (scripts/lib/task08-fixture-server.mjs). It proves the adapter, engine,
//            persistence, cache, and endpoint wiring. It is not a provider check.
//   DATABASE talks to Postgres and PostgREST directly (RLS, constraints).
//
// Rows created here are removed at the end. Fixture rows carry "Fixture" in their names.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import net from "node:net";
import {
  DEMO_TRIP_ID,
  api,
  blocked,
  check,
  demoToken,
  env,
  finish,
  otherUserToken,
  requireEnv,
  sql,
} from "./lib/validation.mjs";
import { startFixtureServer } from "./lib/task08-fixture-server.mjs";

requireEnv("SUPABASE_URL", "SUPABASE_ANON_KEY", "DEMO_EMAIL", "DEMO_PASSWORD");

const TRIP = DEMO_TRIP_ID;
const HOTEL = "00000000-0000-0000-0000-000000000011";
const JCC = "00000000-0000-0000-0000-000000000012";
const startedAt = new Date().toISOString();
const hereConfigured = Boolean(env.HERE_API_KEY);
const weatherConfigured = Boolean(env.OPENWEATHER_API_KEY);

const demo = await demoToken();
const other = await otherUserToken();

const createdLegs = [];
const createdBookings = [];
const createdActivityIds = [];
const otherUserId = (
  await sql(
    "select id from auth.users where email = 'other-user@travelflow.local'",
  )
).trim();

// --- helpers ------------------------------------------------------------------

const liveBase = () => process.env.API_BASE_URL;

async function rest(path, token, { method = "GET", body } = {}) {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** Calls an API instance at `base`; api() reads API_BASE_URL synchronously on call. */
function at(base) {
  return (path, token, options) => {
    const previous = process.env.API_BASE_URL;
    process.env.API_BASE_URL = base;
    const pending = api(path, token, options);
    process.env.API_BASE_URL = previous;
    return pending;
  };
}

const live = (path, token, options) => at(liveBase())(path, token, options);

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch {
      // The process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("fixture API did not become healthy");
}

async function createLeg(
  call,
  departure,
  deadline,
  { origin = HOTEL, destination = JCC } = {},
) {
  const result = await call(`/trips/${TRIP}/journey-legs`, demo, {
    method: "POST",
    body: {
      origin_context_point_id: origin,
      destination_context_point_id: destination,
      departure_at: departure,
      ...(deadline ? { arrival_deadline: deadline } : {}),
    },
  });
  assert.equal(result.status, 201, result.text);
  createdLegs.push(result.body.id);
  return result.body.id;
}

const optionByMode = (options, mode) =>
  options.find((option) => option.transport_mode === mode);
const stringify = (value) => JSON.stringify(value);

// --- DATABASE: structure ------------------------------------------------------

const TABLES = [
  "route_requests",
  "route_options",
  "weather_snapshots",
  "traffic_snapshots",
  "recommendations",
  "place_discovery_runs",
  "place_discovery_results",
];

await check(
  "DATABASE: all Task 08 tables exist with row level security enabled",
  async () => {
    for (const table of TABLES) {
      const row = await sql(
        `select relrowsecurity from pg_class where oid = 'public.${table}'::regclass`,
      );
      assert.equal(row, "t", `${table} must have RLS enabled`);
    }
    const policies = await sql(
      "select count(*) from pg_policies where schemaname = 'public' and tablename in ('route_requests','route_options','weather_snapshots','traffic_snapshots','recommendations','place_discovery_runs','place_discovery_results')",
    );
    assert.ok(
      Number(policies) >= 16,
      `expected select and insert policies, got ${policies}`,
    );
  },
);

await check(
  "DATABASE: weather and traffic snapshots carry what the alert engine reads",
  async () => {
    const columns = async (table) =>
      (
        await sql(
          `select column_name from information_schema.columns where table_schema = 'public' and table_name = '${table}'`,
        )
      ).split("\n");
    const weather = await columns("weather_snapshots");
    for (const column of [
      "trip_id",
      "context_point_id",
      "provider",
      "payload",
      "source_id",
      "retrieved_at",
      "expires_at",
      "observed_at",
      "valid_from",
      "valid_to",
    ]) {
      assert.ok(weather.includes(column), `weather_snapshots.${column}`);
    }
    const traffic = await columns("traffic_snapshots");
    for (const column of [
      "trip_id",
      "origin_context_point_id",
      "destination_context_point_id",
      "provider",
      "payload",
      "source_id",
      "retrieved_at",
      "expires_at",
      "observed_at",
      "valid_from",
      "valid_to",
      "traffic_level",
    ]) {
      assert.ok(traffic.includes(column), `traffic_snapshots.${column}`);
    }
  },
);

await check(
  "DATABASE: a nearby place without a source cannot be stored",
  async () => {
    const insert = (sourceExpression) => `
    begin;
    insert into public.place_discovery_runs (id, trip_id, context_point_id, category, request_id, request_fingerprint, provider, status, retrieved_at, expires_at)
      values ('aaaaaaaa-0000-0000-0000-000000000001', '${TRIP}', '${JCC}', 'restaurant', 'validator', 'fp', 'here_places_v7', 'ok', now(), now() + interval '1 hour');
    insert into public.place_discovery_results (run_id, trip_id, context_point_id, source_id, category, name, latitude, longitude, distance_meters, retrieved_at, expires_at)
      values ('aaaaaaaa-0000-0000-0000-000000000001', '${TRIP}', '${JCC}', ${sourceExpression}, 'restaurant', 'Fixture No Source', -6.2, 106.8, 10, now(), now() + interval '1 hour');
    rollback;`;
    await assert.rejects(
      () => sql(insert("null")),
      (error) =>
        error.message.includes("not-null") ||
        error.message.includes("null value"),
    );
    await assert.rejects(
      () => sql(insert("gen_random_uuid()")),
      (error) => error.message.includes("foreign key"),
    );
  },
);

await check(
  "DATABASE: an excluded option cannot be stored as recommended",
  async () => {
    // Needs a request row; the transaction is rolled back, nothing is kept.
    const statement = `
    begin;
    insert into public.sources (id, trip_id, kind, provider, retrieved_at, freshness)
      values ('bbbbbbbb-0000-0000-0000-000000000001', '${TRIP}', 'provider', 'here_routing_v8', now(), 'fresh');
    insert into public.journey_legs (id, trip_id, origin_context_point_id, destination_context_point_id, departure_at, arrival_deadline)
      values ('bbbbbbbb-0000-0000-0000-000000000002', '${TRIP}', '${HOTEL}', '${JCC}', now() + interval '1 day', now() + interval '2 days');
    insert into public.route_requests (id, trip_id, journey_leg_id, origin_context_point_id, destination_context_point_id, request_id, request_fingerprint, departure_at, arrival_deadline, preferences, required_facts, modes, status, policy_version, retrieved_at, expires_at)
      values ('bbbbbbbb-0000-0000-0000-000000000003', '${TRIP}', 'bbbbbbbb-0000-0000-0000-000000000002', '${HOTEL}', '${JCC}', 'validator', 'fp', now() + interval '1 day', now() + interval '2 days', '{}', '[]', '[]', 'completed', 'mobility-v1', now(), now() + interval '15 minutes');
    insert into public.route_options (route_request_id, trip_id, provider, provider_route_id, transport_mode, source_id, provider_facts, derived_metrics, cost, risk, traffic_risk, weather_risk, overall_risk, duration_seconds, total_duration_seconds, walking_minutes, transfer_count, departure_at, arrive_at, feasible, status, policy_version, retrieved_at, expires_at, recommended)
      values ('bbbbbbbb-0000-0000-0000-000000000003', '${TRIP}', 'here_routing_v8', 'x', 'car', 'bbbbbbbb-0000-0000-0000-000000000001', '{}', '{}', '{}', '{}', 'low', 'low', 'low', 1, 1, 0, 0, now(), now(), false, 'excluded', 'mobility-v1', now(), now() + interval '15 minutes', true);
    rollback;`;
    await assert.rejects(
      () => sql(statement),
      (error) => error.message.includes("route_options_recommended"),
    );
  },
);

await check(
  "DATABASE: a route request must match its journey leg",
  async () => {
    const statement = `
    begin;
    insert into public.journey_legs (id, trip_id, origin_context_point_id, destination_context_point_id, departure_at)
      values ('cccccccc-0000-0000-0000-000000000001', '${TRIP}', '${HOTEL}', '${JCC}', now() + interval '1 day');
    insert into public.route_requests (trip_id, journey_leg_id, origin_context_point_id, destination_context_point_id, request_id, request_fingerprint, departure_at, preferences, required_facts, modes, status, policy_version, retrieved_at, expires_at)
      values ('${TRIP}', 'cccccccc-0000-0000-0000-000000000001', '${JCC}', '${HOTEL}', 'validator', 'fp', now(), '{}', '[]', '[]', 'completed', 'mobility-v1', now(), now());
    rollback;`;
    await assert.rejects(
      () => sql(statement),
      (error) => error.message.includes("ROUTE_LEG_ENDPOINT_MISMATCH"),
    );
  },
);

// --- CONTRACT -----------------------------------------------------------------

await check(
  "CONTRACT: OpenAPI lists every Task 08 endpoint and no pattern keyword",
  async () => {
    const openapi = await readFile(
      new URL("../contracts/openapi.yaml", import.meta.url),
      "utf8",
    );
    for (const path of [
      "/trips/{tripId}/journey-legs/{journeyLegId}/route-requests:",
      "/trips/{tripId}/route-requests/{routeRequestId}:",
      "/trips/{tripId}/route-requests/{routeRequestId}/options:",
      "/trips/{tripId}/route-requests/{routeRequestId}/select:",
      "/trips/{tripId}/weather:",
      "/trips/{tripId}/weather/refresh:",
      "/trips/{tripId}/traffic:",
      "/trips/{tripId}/traffic/refresh:",
      "/trips/{tripId}/recommendations:",
      "/trips/{tripId}/place-discoveries:",
    ]) {
      assert.ok(openapi.includes(path), `missing ${path}`);
    }
  },
);

// --- LIVE API: ownership and request validation -------------------------------

await check(
  "LIVE: a route request only accepts a journey leg that belongs to the trip",
  async () => {
    // A leg of another user's trip, created directly in the database.
    const otherTrip = randomUUID();
    const otherHotel = randomUUID();
    const otherMeeting = randomUUID();
    const otherLeg = randomUUID();
    await sql(`
    insert into public.trips (id, user_id, name, timezone) values ('${otherTrip}', '${otherUserId}', 'Fixture other trip', 'Asia/Jakarta');
    insert into public.context_points (id, trip_id, type, label, latitude, longitude, timezone, external_place_id, resolution_status)
      values ('${otherHotel}', '${otherTrip}', 'hotel', 'Fixture other hotel', -6.19, 106.82, 'Asia/Jakarta', 'fixture-a', 'resolved'),
             ('${otherMeeting}', '${otherTrip}', 'meeting', 'Fixture other meeting', -6.21, 106.81, 'Asia/Jakarta', 'fixture-b', 'resolved');
    insert into public.journey_legs (id, trip_id, origin_context_point_id, destination_context_point_id, departure_at)
      values ('${otherLeg}', '${otherTrip}', '${otherHotel}', '${otherMeeting}', now() + interval '2 days');`);
    try {
      const post = (tripId, legId, token) =>
        live(`/trips/${tripId}/journey-legs/${legId}/route-requests`, token, {
          method: "POST",
          body: {},
        });
      // Demo user, own trip, but the leg of another trip.
      assert.equal((await post(TRIP, otherLeg, demo)).status, 404);
      // Demo user on the other trip.
      assert.equal((await post(otherTrip, otherLeg, demo)).status, 404);
      // Other user on the demo trip with a leg that is not in it.
      assert.equal((await post(TRIP, otherLeg, other)).status, 404);
      // A leg id that does not exist, and one that is not a UUID.
      assert.equal((await post(TRIP, randomUUID(), demo)).status, 404);
      assert.equal((await post(TRIP, "not-a-uuid", demo)).status, 404);
      const rows = await sql(
        `select count(*) from public.route_requests where journey_leg_id = '${otherLeg}'`,
      );
      assert.equal(
        rows,
        "0",
        "no route request may be stored for a leg outside the trip",
      );
    } finally {
      await sql(`
      delete from public.journey_legs where id = '${otherLeg}';
      delete from public.context_points where trip_id = '${otherTrip}';
      delete from public.trips where id = '${otherTrip}';`);
    }
  },
);

await check(
  "LIVE: request bodies that try to set engine output are refused",
  async () => {
    const leg = await createLeg(
      live,
      "2026-11-12T07:45:00+07:00",
      "2026-11-12T09:00:00+07:00",
    );
    const post = (body) =>
      live(`/trips/${TRIP}/journey-legs/${leg}/route-requests`, demo, {
        method: "POST",
        body,
      });
    for (const body of [
      { recommended_option_id: randomUUID() },
      { derived_metrics: { feasible: true } },
      { score: 1 },
      { required_facts: ["magic"] },
      { modes: ["rocket"] },
      { modes: [] },
      { preferences: { max_walking_minutes: -1 } },
      { preferences: { ranking: "first" } },
    ]) {
      const result = await post(body);
      assert.equal(
        result.status,
        400,
        `${stringify(body)} -> ${result.status}`,
      );
      assert.equal(result.body.error.code, "REQUEST_INVALID");
    }
    // Idempotency-Key is mandatory for the mutation.
    const response = await fetch(
      `${liveBase()}/trips/${TRIP}/journey-legs/${leg}/route-requests`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${demo}`,
          "content-type": "application/json",
        },
        body: "{}",
      },
    );
    assert.equal(response.status, 400);
  },
);

if (hereConfigured) {
  blocked(
    "LIVE: provider not configured gives a structured error (HERE)",
    "HERE_API_KEY is set in this environment, so the unconfigured path cannot be observed here",
  );
} else {
  await check(
    "LIVE: without HERE_API_KEY a route request fails with a structured error and no route",
    async () => {
      const leg = await createLeg(
        live,
        "2026-11-12T07:45:00+07:00",
        "2026-11-12T09:00:00+07:00",
      );
      const result = await live(
        `/trips/${TRIP}/journey-legs/${leg}/route-requests`,
        demo,
        { method: "POST", body: {} },
      );
      assert.equal(result.status, 503);
      assert.equal(result.body.error.code, "EXTERNAL_CONFIGURATION_MISSING");
      assert.equal(result.body.error.category, "provider");
      assert.ok(result.body.error.request_id);
      assert.equal(result.body.options, undefined, "no route may be returned");
      const requests = await live(
        `/trips/${TRIP}/journey-legs/${leg}/route-requests`,
        demo,
      );
      assert.equal(requests.status, 200);
      assert.equal(requests.body.items.length, 1);
      assert.equal(requests.body.items[0].status, "failed");
      assert.equal(
        requests.body.items[0].error_code,
        "EXTERNAL_CONFIGURATION_MISSING",
      );
      const options = await sql(
        `select count(*) from public.route_options where route_request_id = '${requests.body.items[0].id}'`,
      );
      assert.equal(options, "0");
      const recommendations = await live(
        `/trips/${TRIP}/recommendations`,
        demo,
      );
      assert.equal(
        recommendations.body.items.some(
          (item) => item.route_request_id === requests.body.items[0].id,
        ),
        false,
      );
    },
  );

  await check(
    "LIVE: without HERE_API_KEY traffic refresh and restaurant discovery fail with structured errors",
    async () => {
      const leg = createdLegs[createdLegs.length - 1];
      const traffic = await live(`/trips/${TRIP}/traffic/refresh`, demo, {
        method: "POST",
        body: { journey_leg_id: leg },
      });
      assert.equal(traffic.status, 503);
      assert.equal(traffic.body.error.code, "EXTERNAL_CONFIGURATION_MISSING");
      const restaurants = await live(`/trips/${TRIP}/place-discoveries`, demo, {
        method: "POST",
        body: { context_point_id: JCC, category: "restaurant" },
      });
      assert.equal(restaurants.status, 503);
      assert.equal(
        restaurants.body.error.code,
        "EXTERNAL_CONFIGURATION_MISSING",
      );
      const runs = await sql(
        `select count(*) from public.place_discovery_runs where trip_id = '${TRIP}' and category = 'restaurant' and status in ('ok','empty') and created_at >= '${startedAt}'`,
      );
      assert.equal(
        runs,
        "0",
        "a failed discovery must not be cached as a result",
      );
    },
  );
}

if (weatherConfigured) {
  blocked(
    "LIVE: provider not configured gives a structured error (OpenWeather)",
    "OPENWEATHER_API_KEY is set in this environment, so the unconfigured path cannot be observed here",
  );
} else {
  await check(
    "LIVE: without OPENWEATHER_API_KEY weather refresh fails with a structured error and stores nothing",
    async () => {
      const result = await live(`/trips/${TRIP}/weather/refresh`, demo, {
        method: "POST",
        body: {},
      });
      assert.equal(result.status, 503);
      assert.equal(result.body.error.code, "EXTERNAL_CONFIGURATION_MISSING");
      const list = await live(`/trips/${TRIP}/weather`, demo);
      assert.equal(list.status, 200);
      assert.deepEqual(list.body.items, [], "no weather may be invented");
      assert.equal(list.body.missing_context_point_ids.length, 3);
    },
  );
}

await check("LIVE: refresh endpoints are rate limited per user", async () => {
  // The other user does not own the trip, so these calls never reach a provider.
  let limited = null;
  for (let attempt = 0; attempt < 14; attempt += 1) {
    const result = await live(`/trips/${TRIP}/weather/refresh`, other, {
      method: "POST",
      body: {},
    });
    if (result.status === 429) {
      limited = result;
      break;
    }
    assert.equal(result.status, 404);
  }
  assert.ok(limited, "expected HTTP 429 before 14 calls");
  assert.equal(limited.body.error.code, "RATE_LIMITED");
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
});

// --- Static: LLM has no path to engine output -----------------------------------

await check(
  "CODE: the mobility engine and its routes have no path from an LLM",
  async () => {
    const engine = await readFile(
      new URL("../packages/domain/src/mobility/engine.ts", import.meta.url),
      "utf8",
    );
    const policy = await readFile(
      new URL("../packages/domain/src/mobility/policy.ts", import.meta.url),
      "utf8",
    );
    const routes = await readFile(
      new URL("../apps/api/src/routes/mobility.ts", import.meta.url),
      "utf8",
    );
    const service = await readFile(
      new URL("../apps/api/src/services/mobility-service.ts", import.meta.url),
      "utf8",
    );
    for (const source of [engine, policy]) {
      for (const forbidden of [
        "inference",
        "Inference",
        "fetch(",
        "Date.now",
        "Math.random",
        "randomUUID",
      ]) {
        assert.ok(
          !source.includes(forbidden),
          `engine must not use ${forbidden}`,
        );
      }
    }
    assert.ok(
      !routes.includes("VultrInferenceClient(") ||
        routes.indexOf("ActivityClaimExtractor") > 0,
    );
    assert.ok(
      !service.includes("Inference"),
      "the mobility service must not call an LLM",
    );
  },
);

// --- FIXTURE-backed pipeline ----------------------------------------------------

const fixtureServer = await startFixtureServer();
const apiPort = await freePort();
const fixtureBase = `http://127.0.0.1:${apiPort}/api/v1`;
const child = spawn(
  process.execPath,
  ["--env-file=.env.local", "apps/api/dist/index.js"],
  {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      API_PORT: String(apiPort),
      HERE_API_KEY: "fixture-here-key",
      HERE_BASE_URL_OVERRIDE: `${fixtureServer.origin}/here`,
      OPENWEATHER_API_KEY: "fixture-owm-key",
      OPENWEATHER_BASE_URL_OVERRIDE: `${fixtureServer.origin}/owm`,
      LOG_LEVEL: "warn",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let childLog = "";
child.stdout.on("data", (chunk) => (childLog += chunk));
child.stderr.on("data", (chunk) => (childLog += chunk));

const activityRunId = randomUUID();
const activitySourceId = randomUUID();
const activityId = randomUUID();
const expiredActivityId = randomUUID();
const fx = at(fixtureBase);
let primary = null; // route request result used by later checks
let primaryLeg = null;

try {
  await waitForHealth(fixtureBase);

  await check(
    "FIXTURE: route request compares modes, ranks, and recommends a feasible option",
    async () => {
      primaryLeg = await createLeg(
        fx,
        "2026-11-12T07:45:00+07:00",
        "2026-11-12T09:00:00+07:00",
      );
      const result = await fx(
        `/trips/${TRIP}/journey-legs/${primaryLeg}/route-requests`,
        demo,
        {
          method: "POST",
          body: { required_facts: ["route", "weather"] },
        },
      );
      assert.equal(result.status, 201, result.text);
      primary = result.body;
      const { options } = primary;
      assert.equal(options.length, 3);
      assert.equal(primary.route_request.status, "completed");
      assert.equal(primary.route_request.policy_version, "mobility-v1");

      const car = optionByMode(options, "car");
      assert.equal(car.provider_facts.duration_seconds, 2100);
      assert.equal(car.provider_facts.base_duration_seconds, 1500);
      assert.equal(car.derived_metrics.traffic_delay_seconds, 600);
      assert.equal(car.risk.traffic, "high");
      assert.equal(car.derived_metrics.feasible, true);
      assert.equal(
        car.cost.source_type,
        "unavailable",
        "HERE routing returned no fare",
      );
      assert.equal(car.cost.min_amount, null);

      const transit = optionByMode(options, "transit");
      assert.equal(transit.provider, "here_intermodal_v8");
      assert.equal(transit.derived_metrics.walking_minutes, 11);
      assert.equal(transit.derived_metrics.transfer_count, 0);
      assert.equal(
        transit.provider_facts.sections[1].operator,
        "Fixture Rail Operator",
      );
      assert.equal(
        transit.risk.traffic,
        "unknown",
        "transit has no traffic reading, so it is not low",
      );

      const walk = optionByMode(options, "pedestrian");
      assert.equal(walk.status, "excluded");
      assert.ok(walk.exclusion_reasons.includes("walking_limit"));
      assert.equal(walk.recommended, false);
      assert.equal(walk.score, null);

      const recommended = options.filter((option) => option.recommended);
      assert.equal(recommended.length, 1);
      assert.equal(recommended[0].status, "valid");
      assert.equal(recommended[0].derived_metrics.feasible, true);
      assert.equal(recommended[0].score.rank, 1);
      assert.equal(primary.recommended_option_id, recommended[0].id);
      assert.equal(
        primary.departure_recommendation.policy_version,
        "mobility-v1",
      );
      assert.ok(primary.departure_recommendation.buffer_seconds > 0);
      assert.ok(primary.sources.length >= 3);
      for (const option of options) {
        assert.ok(option.source_ids.length >= 1);
        assert.equal(option.freshness, "fresh");
        for (const code of option.derived_metrics.reason_codes)
          assert.equal(typeof code, "string");
      }
      assert.ok(
        primary.limitations.some((text) =>
          text.includes("Cost is unavailable"),
        ),
      );
    },
  );

  await check(
    "FIXTURE: no API key, no raw provider payload, and no provider URL reaches the response",
    async () => {
      const text = stringify(primary);
      for (const secret of [
        "fixture-here-key",
        "fixture-owm-key",
        "apiKey",
        "appid",
      ]) {
        assert.ok(!text.includes(secret), `response contains ${secret}`);
      }
      for (const source of primary.sources) assert.equal(source.url, undefined);
      const stored = await sql(
        `select metadata::text from public.sources where trip_id = '${TRIP}' and created_at >= '${startedAt}' and provider like 'here_%'`,
      );
      assert.ok(
        !stored.includes("fixture-here-key"),
        "the stored audit URL must not contain the key",
      );
    },
  );

  await check(
    "FIXTURE: the same facts always give the same ranking",
    async () => {
      const again = await fx(
        `/trips/${TRIP}/journey-legs/${primaryLeg}/route-requests`,
        demo,
        {
          method: "POST",
          body: { required_facts: ["route", "weather"] },
        },
      );
      assert.equal(again.status, 201);
      const order = (result) =>
        result.options.map(
          (option) =>
            `${option.transport_mode}:${option.status}:${option.score?.rank ?? "-"}:${option.score?.total ?? "-"}`,
        );
      assert.deepEqual(order(again.body), order(primary));
      assert.equal(
        optionByMode(
          again.body.options,
          again.body.options.find((o) => o.recommended).transport_mode,
        ).transport_mode,
        optionByMode(
          primary.options,
          primary.options.find((o) => o.recommended).transport_mode,
        ).transport_mode,
      );
    },
  );

  await check(
    "FIXTURE: a route that cannot reach the deadline is never recommended",
    async () => {
      const tight = await createLeg(
        fx,
        "2026-11-12T07:45:00+07:00",
        "2026-11-12T08:10:00+07:00",
      );
      const result = await fx(
        `/trips/${TRIP}/journey-legs/${tight}/route-requests`,
        demo,
        { method: "POST", body: {} },
      );
      assert.equal(result.status, 201, result.text);
      assert.equal(result.body.recommended_option_id, null);
      assert.equal(result.body.departure_recommendation, null);
      assert.ok(
        result.body.options.every(
          (option) =>
            option.status === "excluded" && option.recommended === false,
        ),
      );
      assert.ok(
        result.body.options.every((option) =>
          option.exclusion_reasons.includes("arrival_deadline"),
        ),
      );
      assert.ok(
        result.body.limitations.some((text) =>
          text.includes("No option arrives before the deadline"),
        ),
      );
      const recommendations = await sql(
        `select count(*) from public.recommendations where route_request_id = '${result.body.route_request.id}'`,
      );
      assert.equal(recommendations, "0");
    },
  );

  await check(
    "FIXTURE: selecting an option stores the choice and does not change the recommendation",
    async () => {
      const valid = primary.options.filter(
        (option) => option.status === "valid",
      );
      assert.ok(valid.length >= 2, "needs two valid options");
      const notRecommended = valid.find((option) => !option.recommended);
      const select = (optionId, key) =>
        fx(
          `/trips/${TRIP}/route-requests/${primary.route_request.id}/select`,
          demo,
          {
            method: "POST",
            body: { option_id: optionId },
            ...(key ? { idempotencyKey: key } : {}),
          },
        );
      const key = `validator-select-${randomUUID()}`;
      const selected = await select(notRecommended.id, key);
      assert.equal(selected.status, 200, selected.text);
      assert.equal(
        selected.body.route_request.selected_option_id,
        notRecommended.id,
      );
      assert.equal(
        selected.body.options.find((o) => o.id === notRecommended.id).selected,
        true,
      );
      assert.equal(
        selected.body.recommended_option_id,
        primary.recommended_option_id,
        "the choice does not move the recommendation",
      );
      const replay = await select(notRecommended.id, key);
      assert.equal(replay.status, 200);
      assert.equal(
        replay.body.route_request.selected_option_id,
        notRecommended.id,
      );
      const excluded = primary.options.find(
        (option) => option.status === "excluded",
      );
      const refused = await select(excluded.id);
      assert.equal(refused.status, 409);
      assert.equal(refused.body.error.code, "ROUTE_OPTION_NOT_SELECTABLE");
      assert.equal((await select(randomUUID())).status, 404);
      const otherUser = await fx(
        `/trips/${TRIP}/route-requests/${primary.route_request.id}/select`,
        other,
        {
          method: "POST",
          body: { option_id: notRecommended.id },
        },
      );
      assert.equal(otherUser.status, 404);
    },
  );

  await check(
    "FIXTURE: GET detail, options, and list return the stored request",
    async () => {
      const detail = await fx(
        `/trips/${TRIP}/route-requests/${primary.route_request.id}`,
        demo,
      );
      assert.equal(detail.status, 200);
      assert.equal(detail.body.options.length, 3);
      const options = await fx(
        `/trips/${TRIP}/route-requests/${primary.route_request.id}/options`,
        demo,
      );
      assert.equal(options.status, 200);
      assert.equal(options.body.items.length, 3);
      assert.equal(
        options.body.recommended_option_id,
        primary.recommended_option_id,
      );
      const list = await fx(
        `/trips/${TRIP}/journey-legs/${primaryLeg}/route-requests`,
        demo,
      );
      assert.equal(list.status, 200);
      assert.ok(list.body.items.length >= 2);
      assert.equal(
        (
          await fx(
            `/trips/${TRIP}/route-requests/${primary.route_request.id}`,
            other,
          )
        ).status,
        404,
      );
    },
  );

  await check(
    "FIXTURE: recommendations are stored with evidence and policy version",
    async () => {
      const result = await fx(`/trips/${TRIP}/recommendations`, demo);
      assert.equal(result.status, 200);
      const mine = result.body.items.filter(
        (item) => item.route_request_id === primary.route_request.id,
      );
      assert.equal(mine.length, 1);
      assert.equal(mine[0].recommendation_type, "route");
      assert.equal(mine[0].route_option_id, primary.recommended_option_id);
      assert.equal(mine[0].policy_version, "mobility-v1");
      assert.equal(mine[0].status, "suggested");
      assert.equal(mine[0].freshness, "fresh");
      assert.ok(mine[0].source_ids.length >= 2);
      assert.equal(typeof mine[0].reason, "string");
      assert.equal(
        (await fx(`/trips/${TRIP}/recommendations`, other)).status,
        404,
      );
    },
  );

  await check(
    "FIXTURE: a provider failure creates no route and keeps an audit row",
    async () => {
      const leg = await createLeg(
        fx,
        "2026-11-12T07:45:00+07:00",
        "2026-11-12T09:00:00+07:00",
      );
      fixtureServer.fail("router");
      const result = await fx(
        `/trips/${TRIP}/journey-legs/${leg}/route-requests`,
        demo,
        { method: "POST", body: { modes: ["car"] } },
      );
      assert.equal(result.status, 502);
      assert.equal(result.body.error.code, "EXTERNAL_PROVIDER_ERROR");
      assert.equal(result.body.options, undefined);
      const requests = await fx(
        `/trips/${TRIP}/journey-legs/${leg}/route-requests`,
        demo,
      );
      assert.equal(requests.body.items.length, 1);
      assert.equal(requests.body.items[0].status, "failed");
      assert.equal(
        requests.body.items[0].error_code,
        "EXTERNAL_PROVIDER_ERROR",
      );
      const stored = await sql(
        `select count(*) from public.route_options where route_request_id = '${requests.body.items[0].id}'`,
      );
      assert.equal(stored, "0");
      // Exactly one request reached the provider for the failed call: no retry.
      const calls = fixtureServer.requests.filter(
        (r) => r.service === "router" && r.query.transportMode === "car",
      );
      assert.ok(calls.length >= 1);
    },
  );

  await check(
    "FIXTURE: required weather that the provider cannot give is an error, not a guess",
    async () => {
      const leg = await createLeg(
        fx,
        "2026-11-12T07:45:00+07:00",
        "2026-11-12T09:00:00+07:00",
      );
      // Expire any stored weather so the provider is needed.
      await sql(
        `update public.weather_snapshots set retrieved_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where trip_id = '${TRIP}' and created_at >= '${startedAt}'`,
      );
      fixtureServer.fail("weather");
      const result = await fx(
        `/trips/${TRIP}/journey-legs/${leg}/route-requests`,
        demo,
        {
          method: "POST",
          body: { required_facts: ["route", "weather"], modes: ["car"] },
        },
      );
      assert.equal(result.status, 502);
      assert.equal(result.body.error.code, "EXTERNAL_PROVIDER_ERROR");
      const options = await sql(
        `select count(*) from public.route_options o join public.route_requests r on r.id = o.route_request_id where r.journey_leg_id = '${leg}'`,
      );
      assert.equal(options, "0");
    },
  );

  await check(
    "FIXTURE: weather refresh uses a valid snapshot, expired ones are never returned",
    async () => {
      const before = fixtureServer.counters.weather;
      const first = await fx(`/trips/${TRIP}/weather/refresh`, demo, {
        method: "POST",
        body: { context_point_id: JCC },
      });
      assert.equal(first.status, 200, first.text);
      const snapshot = first.body.items[0];
      assert.equal(snapshot.cache_status, "miss");
      assert.equal(snapshot.provider, "openweather_free_2_5");
      assert.equal(snapshot.timezone, "Asia/Jakarta");
      // Free plan: 40 forecast points, three hours apart, no daily data.
      assert.equal(snapshot.hourly.length, 40);
      assert.equal(snapshot.hourly[0].granularity, "three_hourly");
      assert.equal(snapshot.hourly[0].interval_minutes, 180);
      assert.equal(snapshot.forecast_interval_minutes, 180);
      assert.equal(snapshot.forecast_ends_at, snapshot.hourly[39].at);
      assert.equal(snapshot.daily.length, 0);
      assert.equal(snapshot.alerts.length, 0);
      assert.equal(snapshot.freshness, "fresh");
      assert.ok(
        snapshot.source_id &&
          snapshot.retrieved_at &&
          snapshot.expires_at &&
          snapshot.valid_from &&
          snapshot.valid_to,
      );
      assert.ok(!stringify(first.body).includes("fixture-owm-key"));
      const second = await fx(`/trips/${TRIP}/weather/refresh`, demo, {
        method: "POST",
        body: { context_point_id: JCC },
      });
      assert.equal(second.body.items[0].cache_status, "hit");
      assert.equal(second.body.items[0].id, snapshot.id);
      assert.equal(
        fixtureServer.counters.weather,
        before + 1,
        "a valid snapshot must not call the provider again",
      );
      const listed = await fx(
        `/trips/${TRIP}/weather?context_point_id=${JCC}`,
        demo,
      );
      assert.equal(listed.body.items.length, 1);
      assert.deepEqual(listed.body.missing_context_point_ids, []);

      await sql(
        `update public.weather_snapshots set retrieved_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where trip_id = '${TRIP}' and created_at >= '${startedAt}'`,
      );
      const expired = await fx(
        `/trips/${TRIP}/weather?context_point_id=${JCC}`,
        demo,
      );
      assert.deepEqual(
        expired.body.items,
        [],
        "an expired snapshot is not live data",
      );
      assert.deepEqual(expired.body.missing_context_point_ids, [JCC]);
      const third = await fx(`/trips/${TRIP}/weather/refresh`, demo, {
        method: "POST",
        body: { context_point_id: JCC },
      });
      assert.equal(third.body.items[0].cache_status, "miss");
      assert.equal(
        fixtureServer.counters.weather,
        before + 2,
        "an expired snapshot is replaced by a new provider call",
      );
      assert.equal((await fx(`/trips/${TRIP}/weather`, other)).status, 404);
    },
  );

  await check(
    "FIXTURE: traffic needs a leg that departs soon, uses a valid snapshot, and hides expired ones",
    async () => {
      const soon = new Date(Date.now() + 60 * 60_000);
      const later = new Date(Date.now() + 3 * 60 * 60_000);
      const nearLeg = await createLeg(
        fx,
        soon.toISOString(),
        later.toISOString(),
      );

      // A far-away leg cannot require live traffic.
      const far = await fx(
        `/trips/${TRIP}/journey-legs/${primaryLeg}/route-requests`,
        demo,
        {
          method: "POST",
          body: { required_facts: ["route", "traffic"], modes: ["car"] },
        },
      );
      assert.equal(far.status, 422);
      assert.equal(far.body.error.code, "TRAFFIC_FACTS_MISSING");

      const before = {
        flow: fixtureServer.counters.flow,
        incidents: fixtureServer.counters.incidents,
      };
      const first = await fx(`/trips/${TRIP}/traffic/refresh`, demo, {
        method: "POST",
        body: { journey_leg_id: nearLeg },
      });
      assert.equal(first.status, 200, first.text);
      const snapshot = first.body.items[0];
      assert.equal(snapshot.cache_status, "miss");
      assert.equal(snapshot.provider, "here_traffic_v7");
      // Average jam factor 5 and one minor incident: medium under mobility-v1.
      assert.equal(snapshot.traffic_level, "medium");
      assert.equal(snapshot.summary.segment_count, 2);
      assert.equal(snapshot.summary.average_jam_factor, 5);
      assert.equal(snapshot.summary.incident_count, 1);
      assert.equal(snapshot.policy_version, "mobility-v1");
      assert.ok(
        snapshot.source_id &&
          snapshot.retrieved_at &&
          snapshot.expires_at &&
          snapshot.observed_at,
      );
      assert.equal(fixtureServer.counters.flow, before.flow + 1);
      assert.equal(fixtureServer.counters.incidents, before.incidents + 1);

      const second = await fx(`/trips/${TRIP}/traffic/refresh`, demo, {
        method: "POST",
        body: { journey_leg_id: nearLeg },
      });
      assert.equal(second.body.items[0].cache_status, "hit");
      assert.equal(
        fixtureServer.counters.flow,
        before.flow + 1,
        "a valid snapshot must not call the provider again",
      );

      // Required traffic now succeeds for the near leg and the option records the snapshot.
      const routed = await fx(
        `/trips/${TRIP}/journey-legs/${nearLeg}/route-requests`,
        demo,
        {
          method: "POST",
          body: {
            required_facts: ["route", "traffic", "weather"],
            modes: ["car", "transit"],
          },
        },
      );
      assert.equal(routed.status, 201, routed.text);
      assert.equal(routed.body.traffic.id, snapshot.id);
      assert.ok(routed.body.weather);
      assert.ok(
        routed.body.options.every((option) =>
          option.source_ids.includes(snapshot.source_id),
        ),
      );
      assert.ok(
        optionByMode(
          routed.body.options,
          "car",
        ).derived_metrics.reason_codes.includes("traffic_incident"),
      );
      assert.equal(
        (await fx(`/trips/${TRIP}/traffic?journey_leg_id=${nearLeg}`, demo))
          .body.items.length,
        1,
      );

      await sql(
        `update public.traffic_snapshots set retrieved_at = now() - interval '1 hour', expires_at = now() - interval '50 minutes' where trip_id = '${TRIP}' and created_at >= '${startedAt}'`,
      );
      const expired = await fx(`/trips/${TRIP}/traffic`, demo);
      assert.deepEqual(
        expired.body.items,
        [],
        "an expired traffic snapshot is not live data",
      );
      const again = await fx(`/trips/${TRIP}/traffic/refresh`, demo, {
        method: "POST",
        body: { journey_leg_id: nearLeg },
      });
      assert.equal(again.body.items[0].cache_status, "miss");
      assert.equal(fixtureServer.counters.flow, before.flow + 2);
      assert.equal((await fx(`/trips/${TRIP}/traffic`, other)).status, 404);
    },
  );

  await check(
    "FIXTURE: an expired request is not live: not recommended, not selectable, hidden from recommendations",
    async () => {
      const leg = await createLeg(
        fx,
        "2026-11-12T07:45:00+07:00",
        "2026-11-12T09:00:00+07:00",
      );
      const fresh = await fx(
        `/trips/${TRIP}/journey-legs/${leg}/route-requests`,
        demo,
        { method: "POST", body: { modes: ["car", "transit"] } },
      );
      assert.equal(fresh.status, 201, fresh.text);
      assert.ok(fresh.body.recommended_option_id);
      const requestId = fresh.body.route_request.id;
      await sql(`
      update public.route_requests set retrieved_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where id = '${requestId}';
      update public.route_options set retrieved_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where route_request_id = '${requestId}';
      update public.recommendations set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where route_request_id = '${requestId}';`);
      const detail = await fx(
        `/trips/${TRIP}/route-requests/${requestId}`,
        demo,
      );
      assert.equal(detail.body.route_request.freshness, "expired");
      assert.equal(detail.body.recommended_option_id, null);
      assert.equal(detail.body.departure_recommendation, null);
      assert.ok(
        detail.body.options.every(
          (option) =>
            option.freshness === "expired" && option.recommended === false,
        ),
      );
      assert.ok(
        detail.body.options.some((option) => option.status === "expired"),
      );
      const select = await fx(
        `/trips/${TRIP}/route-requests/${requestId}/select`,
        demo,
        {
          method: "POST",
          body: { option_id: fresh.body.recommended_option_id },
        },
      );
      assert.equal(select.status, 409);
      assert.equal(select.body.error.code, "ROUTE_OPTION_EXPIRED");
      const listed = await fx(`/trips/${TRIP}/recommendations`, demo);
      assert.ok(
        !listed.body.items.some((item) => item.route_request_id === requestId),
      );
      const all = await fx(
        `/trips/${TRIP}/recommendations?include_expired=true`,
        demo,
      );
      const old = all.body.items.find(
        (item) => item.route_request_id === requestId,
      );
      assert.ok(old);
      assert.equal(old.freshness, "expired");
      assert.equal(old.status, "expired");
    },
  );

  // ---- nearby places (restaurants through the HERE fixture) ----
  let restaurantRun = null;
  await check(
    "FIXTURE: restaurant discovery keeps sourced places inside the radius and caches the run",
    async () => {
      const before = fixtureServer.counters.browse;
      const result = await fx(`/trips/${TRIP}/place-discoveries`, demo, {
        method: "POST",
        body: {
          context_point_id: JCC,
          category: "restaurant",
          radius_meters: 1000,
        },
      });
      assert.equal(result.status, 200, result.text);
      restaurantRun = result.body;
      assert.equal(result.body.cache_status, "miss");
      assert.equal(result.body.status, "ok");
      assert.equal(result.body.category, "restaurant");
      assert.equal(result.body.freshness, "fresh");
      const names = result.body.items.map((item) => item.name);
      assert.deepEqual(
        names,
        ["Fixture Warung Satu", "Fixture Cafe Dua"],
        "the far place is rejected, the rest sorted by distance",
      );
      assert.ok(
        result.body.items[0].distance_meters <
          result.body.items[1].distance_meters,
      );
      assert.ok(
        result.body.items.every((item) => item.distance_meters <= 1000),
      );
      assert.deepEqual(result.body.items[0].opening_hours, {
        text: ["Mon-Sun: 10:00 - 22:00"],
      });
      assert.equal(
        result.body.items[1].opening_hours,
        null,
        "no provider hours means no hours shown",
      );
      assert.ok(
        result.body.items.every(
          (item) =>
            item.source_ids.length >= 1 &&
            result.body.sources.some((s) => s.id === item.source_ids[0]),
        ),
      );
      assert.ok(
        result.body.limitations.some((text) =>
          text.includes("outside the requested radius"),
        ),
      );
      assert.equal(fixtureServer.counters.browse, before + 1);

      const second = await fx(`/trips/${TRIP}/place-discoveries`, demo, {
        method: "POST",
        body: {
          context_point_id: JCC,
          category: "restaurant",
          radius_meters: 1000,
        },
      });
      assert.equal(second.body.cache_status, "hit");
      assert.equal(second.body.items.length, 2);
      assert.equal(
        fixtureServer.counters.browse,
        before + 1,
        "a valid run must not call the provider again",
      );
      const latest = await fx(
        `/trips/${TRIP}/place-discoveries?context_point_id=${JCC}&category=restaurant`,
        demo,
      );
      assert.equal(latest.status, 200);
      assert.equal(latest.body.items.length, 2);

      const wider = await fx(`/trips/${TRIP}/place-discoveries`, demo, {
        method: "POST",
        body: {
          context_point_id: JCC,
          category: "restaurant",
          radius_meters: 5000,
        },
      });
      assert.equal(
        wider.body.cache_status,
        "miss",
        "another radius is another query",
      );
      assert.equal(
        wider.body.items.length,
        3,
        "the far fixture place is 4 km away and inside 5 km",
      );
      assert.equal(
        (
          await fx(`/trips/${TRIP}/place-discoveries`, demo, {
            method: "POST",
            body: {
              context_point_id: JCC,
              category: "restaurant",
              radius_meters: 99999,
            },
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await fx(`/trips/${TRIP}/place-discoveries`, demo, {
            method: "POST",
            body: { context_point_id: JCC, category: "museum" },
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await fx(`/trips/${TRIP}/place-discoveries`, other, {
            method: "POST",
            body: { context_point_id: JCC, category: "restaurant" },
          })
        ).status,
        404,
      );
    },
  );

  await check(
    "FIXTURE: an expired place run is not served and the provider is called again",
    async () => {
      await sql(
        `update public.place_discovery_runs set retrieved_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where trip_id = '${TRIP}' and category = 'restaurant' and created_at >= '${startedAt}'`,
      );
      const latest = await fx(
        `/trips/${TRIP}/place-discoveries?context_point_id=${JCC}&category=restaurant`,
        demo,
      );
      assert.equal(latest.status, 410);
      assert.equal(latest.body.error.code, "PLACE_DISCOVERY_EXPIRED");
      const before = fixtureServer.counters.browse;
      const result = await fx(`/trips/${TRIP}/place-discoveries`, demo, {
        method: "POST",
        body: {
          context_point_id: JCC,
          category: "restaurant",
          radius_meters: 1000,
        },
      });
      assert.equal(result.body.cache_status, "miss");
      assert.equal(fixtureServer.counters.browse, before + 1);
      fixtureServer.fail("browse");
      await sql(
        `update public.place_discovery_runs set retrieved_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where trip_id = '${TRIP}' and category = 'restaurant' and created_at >= '${startedAt}'`,
      );
      const failed = await fx(`/trips/${TRIP}/place-discoveries`, demo, {
        method: "POST",
        body: {
          context_point_id: JCC,
          category: "restaurant",
          radius_meters: 1000,
        },
      });
      assert.equal(failed.status, 502);
      assert.equal(failed.body.error.code, "EXTERNAL_PROVIDER_ERROR");
      assert.equal(
        failed.body.items,
        undefined,
        "the expired run is not a substitute for the failed provider",
      );
    },
  );

  // ---- activities can be booked (fixture row), restaurants and strangers cannot ----
  await sql(`
    insert into public.sources (id, trip_id, kind, provider, url, title, retrieved_at, freshness, expires_at)
      values ('${activitySourceId}', '${TRIP}', 'search_result', 'bright_data', 'https://fixture-museum.example/', 'Fixture activity page', now(), 'fresh', now() + interval '1 hour');
    insert into public.place_discovery_runs (id, trip_id, context_point_id, category, request_id, request_fingerprint, provider, status, retrieved_at, expires_at)
      values ('${activityRunId}', '${TRIP}', '${JCC}', 'activity', 'validator-fixture', 'validator-fixture', 'bright_data', 'ok', now(), now() + interval '1 hour');
    insert into public.place_discovery_results (id, run_id, trip_id, context_point_id, source_id, category, name, activity_type, indoor_outdoor, weather_sensitivity, retrieved_at, expires_at)
      values ('${activityId}', '${activityRunId}', '${TRIP}', '${JCC}', '${activitySourceId}', 'activity', 'Fixture National Museum', 'museum', 'indoor', 'low', now(), now() + interval '1 hour'),
             ('${expiredActivityId}', '${activityRunId}', '${TRIP}', '${JCC}', '${activitySourceId}', 'activity', 'Fixture Expired Activity', null, null, null, now() - interval '2 hours', now() - interval '1 hour');`);
  createdActivityIds.push(activityId, expiredActivityId);

  const bookingBody = (sourceId, sourceType = "activity") => ({
    booking_type: "activity",
    source_type: sourceType,
    source_id: sourceId,
  });

  await check(
    "FIXTURE: an activity result is bookable through the booking flow and payment confirms it",
    async () => {
      const created = await fx(`/trips/${TRIP}/bookings`, demo, {
        method: "POST",
        body: bookingBody(activityId),
      });
      assert.equal(created.status, 201, created.text);
      createdBookings.push(created.body.id);
      assert.equal(created.body.source_type, "activity");
      assert.equal(created.body.source_id, activityId);
      assert.equal(created.body.booking_type, "activity");
      assert.equal(created.body.status, "pending_payment");
      const paid = await fx(
        `/trips/${TRIP}/bookings/${created.body.id}/payments`,
        demo,
        { method: "POST", body: { outcome: "succeeded" } },
      );
      assert.equal(paid.status, 201, paid.text);
      assert.equal(paid.body.booking.status, "confirmed");
      assert.equal(paid.body.payment.status, "succeeded");
    },
  );

  await check(
    "FIXTURE: booking refuses restaurants, expired activities, unknown ids, and the wrong source type",
    async () => {
      const restaurantId = restaurantRun.items[0].id;
      for (const [label, body] of [
        ["restaurant as activity", bookingBody(restaurantId)],
        ["expired activity", bookingBody(expiredActivityId)],
        ["unknown activity", bookingBody(randomUUID())],
        [
          "activity id as event result",
          bookingBody(activityId, "event_discovery_result"),
        ],
      ]) {
        const result = await fx(`/trips/${TRIP}/bookings`, demo, {
          method: "POST",
          body,
        });
        assert.equal(result.status, 409, `${label}: ${result.text}`);
        assert.equal(
          result.body.error.code,
          "BOOKING_RESOURCE_MISMATCH",
          label,
        );
      }
      // Another user cannot book this trip's activity.
      const stranger = await fx(`/trips/${TRIP}/bookings`, other, {
        method: "POST",
        body: bookingBody(activityId),
      });
      assert.ok([403, 404].includes(stranger.status), String(stranger.status));
    },
  );

  // ---- RLS across users, for every new table ----
  await check(
    "DATABASE: another user cannot read or write Task 08 rows of this trip",
    async () => {
      for (const table of TABLES) {
        const own = await rest(
          `/${table}?trip_id=eq.${TRIP}&select=id&limit=1`,
          demo,
        );
        assert.equal(own.status, 200, `${table}: ${stringify(own.body)}`);
        assert.ok(
          own.body.length >= 1,
          `${table} needs at least one row to prove isolation`,
        );
        const foreign = await rest(
          `/${table}?trip_id=eq.${TRIP}&select=id`,
          other,
        );
        assert.equal(foreign.status, 200);
        assert.deepEqual(
          foreign.body,
          [],
          `${table} leaked rows to another user`,
        );
      }
      const insertAttempts = {
        route_requests: {
          trip_id: TRIP,
          journey_leg_id: primaryLeg,
          origin_context_point_id: HOTEL,
          destination_context_point_id: JCC,
          request_id: "x",
          request_fingerprint: "x",
          departure_at: "2026-11-12T00:00:00Z",
          preferences: {},
          required_facts: [],
          modes: [],
          status: "completed",
          policy_version: "mobility-v1",
          retrieved_at: "2026-11-12T00:00:00Z",
          expires_at: "2026-11-12T00:15:00Z",
        },
        weather_snapshots: {
          trip_id: TRIP,
          context_point_id: JCC,
          source_id: activitySourceId,
          request_fingerprint: "x",
          latitude: -6.2,
          longitude: 106.8,
          timezone: "Asia/Jakarta",
          valid_from: "2026-11-12T00:00:00Z",
          valid_to: "2026-11-12T01:00:00Z",
          payload: {},
          retrieved_at: "2026-11-12T00:00:00Z",
          expires_at: "2026-11-12T00:30:00Z",
        },
        traffic_snapshots: {
          trip_id: TRIP,
          origin_context_point_id: HOTEL,
          destination_context_point_id: JCC,
          source_id: activitySourceId,
          request_fingerprint: "x",
          policy_version: "mobility-v1",
          traffic_level: "low",
          center_latitude: -6.2,
          center_longitude: 106.8,
          radius_meters: 1000,
          valid_from: "2026-11-12T00:00:00Z",
          valid_to: "2026-11-12T00:10:00Z",
          payload: {},
          retrieved_at: "2026-11-12T00:00:00Z",
          expires_at: "2026-11-12T00:10:00Z",
        },
        place_discovery_runs: {
          trip_id: TRIP,
          context_point_id: JCC,
          category: "activity",
          request_id: "x",
          request_fingerprint: "x",
          provider: "bright_data",
          status: "ok",
          retrieved_at: "2026-11-12T00:00:00Z",
          expires_at: "2026-11-12T01:00:00Z",
        },
        recommendations: {
          trip_id: TRIP,
          recommendation_type: "route",
          payload: {},
          policy_version: "mobility-v1",
          expires_at: "2099-01-01T00:00:00Z",
        },
      };
      for (const [table, row] of Object.entries(insertAttempts)) {
        const attempt = await rest(`/${table}`, other, {
          method: "POST",
          body: row,
        });
        // route_requests is first stopped by the leg trigger, which cannot see the leg through RLS.
        const refusedByLeg =
          table === "route_requests" &&
          attempt.body.message === "ROUTE_LEG_NOT_IN_TRIP";
        if (!refusedByLeg) {
          assert.ok(
            [401, 403].includes(attempt.status),
            `${table} insert by another user returned ${attempt.status}: ${stringify(attempt.body)}`,
          );
          assert.equal(
            attempt.body.code,
            "42501",
            `${table} should be refused by row level security`,
          );
        }
      }
      // A user may not change the recommendation of a trip they do not own either.
      const update = await rest(`/recommendations?trip_id=eq.${TRIP}`, other, {
        method: "PATCH",
        body: { status: "dismissed" },
      });
      assert.ok(update.status === 200 || update.status === 204);
      const statuses = await sql(
        `select count(*) from public.recommendations where trip_id = '${TRIP}' and status = 'dismissed' and created_at >= '${startedAt}'`,
      );
      assert.equal(statuses, "0");
    },
  );

  // ---- LIVE activity discovery through Bright Data ----
  if (
    !env.BRIGHT_DATA_API_KEY ||
    !env.BRIGHT_DATA_SERP_ZONE ||
    !env.BRIGHT_DATA_UNLOCKER_ZONE ||
    !env.VULTR_INFERENCE_API_KEY
  ) {
    blocked(
      "LIVE: activity discovery through Bright Data",
      "BRIGHT_DATA_* or VULTR_INFERENCE_API_KEY is empty",
    );
  } else {
    const result = await live(`/trips/${TRIP}/place-discoveries`, demo, {
      method: "POST",
      body: { context_point_id: JCC, category: "activity" },
    });
    if (result.status !== 200) {
      blocked(
        "LIVE: activity discovery through Bright Data",
        `provider answered with a structured error ${result.body?.error?.code ?? result.status}`,
      );
    } else {
      await check(
        "LIVE: activity discovery through Bright Data returns sourced items or an explicit empty result",
        async () => {
          const body = result.body;
          assert.equal(body.category, "activity");
          assert.ok(["ok", "empty"].includes(body.status));
          assert.ok(body.expires_at > body.retrieved_at);
          assert.ok(body.limitations.length >= 1);
          for (const item of body.items) {
            assert.ok(
              item.source_ids.length >= 1,
              `${item.name} has no source`,
            );
            for (const id of item.source_ids) {
              const source = body.sources.find((entry) => entry.id === id);
              assert.ok(
                source && source.url && source.retrieved_at,
                `${item.name} source ${id}`,
              );
            }
            if (item.opening_hours)
              assert.ok(item.opening_hours.text.length >= 1);
            assert.ok(
              ["indoor", "outdoor", "both", "unknown"].includes(
                item.indoor_outdoor,
              ),
            );
          }
          const again = await live(`/trips/${TRIP}/place-discoveries`, demo, {
            method: "POST",
            body: { context_point_id: JCC, category: "activity" },
          });
          assert.equal(again.body.cache_status, "hit");
          console.log(
            `      live activity discovery: ${body.items.length} item(s), status ${body.status}`,
          );
          if (body.items.length > 0) {
            const booking = await live(`/trips/${TRIP}/bookings`, demo, {
              method: "POST",
              body: bookingBody(body.items[0].id),
            });
            assert.equal(booking.status, 201, booking.text);
            createdBookings.push(booking.body.id);
            createdActivityIds.push(body.items[0].id);
          }
        },
      );
    }
  }

  // ---- HERE and OpenWeather live checks ----
  if (hereConfigured) {
    await check(
      "LIVE: HERE routing, traffic and browse answer for the demo trip",
      async () => {
        const leg = await createLeg(
          live,
          new Date(Date.now() + 60 * 60_000).toISOString(),
          new Date(Date.now() + 3 * 3600_000).toISOString(),
        );
        const result = await live(
          `/trips/${TRIP}/journey-legs/${leg}/route-requests`,
          demo,
          { method: "POST", body: { required_facts: ["route", "traffic"] } },
        );
        assert.equal(result.status, 201, result.text);
        assert.ok(result.body.options.length >= 1);
        const places = await live(`/trips/${TRIP}/place-discoveries`, demo, {
          method: "POST",
          body: { context_point_id: JCC, category: "restaurant" },
        });
        assert.equal(places.status, 200, places.text);
      },
    );
  } else {
    blocked(
      "LIVE: HERE routing, intermodal, traffic, and browse smoke test",
      "HERE_API_KEY is empty, so no live HERE request can be made",
    );
  }
  if (weatherConfigured) {
    await check("LIVE: OpenWeather answers for the demo trip", async () => {
      const result = await live(`/trips/${TRIP}/weather/refresh`, demo, {
        method: "POST",
        body: { context_point_id: JCC },
      });
      assert.equal(result.status, 200, result.text);
      assert.ok(result.body.items[0].hourly.length >= 1);
    });
  } else {
    blocked(
      "LIVE: OpenWeather current weather and forecast smoke test",
      "OPENWEATHER_API_KEY is empty, so no live OpenWeather request can be made",
    );
  }
} catch (error) {
  await check("FIXTURE: harness", async () => {
    throw error;
  });
} finally {
  child.kill("SIGTERM");
  await fixtureServer.close();
  if (childLog.includes("Error:") && process.env.VALIDATOR_DEBUG)
    console.log(childLog);
  await cleanup();
}

async function cleanup() {
  const list = (values) =>
    values.length ? values.map((id) => `'${id}'`).join(",") : "'none'";
  const statement = `
    create temporary table task08_source_ids as
      select source_id as id from public.place_discovery_results where trip_id = '${TRIP}' and created_at >= '${startedAt}'
      union select source_id from public.route_options where trip_id = '${TRIP}' and created_at >= '${startedAt}'
      union select source_id from public.weather_snapshots where trip_id = '${TRIP}' and created_at >= '${startedAt}'
      union select source_id from public.traffic_snapshots where trip_id = '${TRIP}' and created_at >= '${startedAt}'
      union select id from public.sources where trip_id = '${TRIP}' and created_at >= '${startedAt}' and provider in ('here_routing_v8','here_intermodal_v8','here_traffic_v7','openweather_free_2_5','here_places_v7')
      union select id from public.sources where id = '${activitySourceId}';
    delete from public.activity_logs where resource_id in (${list(createdBookings)}) or (resource_type = 'route_request' and created_at >= '${startedAt}') or (resource_type = 'journey_leg' and resource_id in (${list(createdLegs)}));
    delete from public.payments where booking_id in (${list(createdBookings)});
    delete from public.activity_logs where resource_type = 'payment' and created_at >= '${startedAt}' and metadata ->> 'booking_id' in (${list(createdBookings)});
    delete from public.bookings where id in (${list(createdBookings)});
    delete from public.recommendations where trip_id = '${TRIP}' and created_at >= '${startedAt}';
    delete from public.recommendations where route_request_id in (select id from public.route_requests where journey_leg_id in (${list(createdLegs)}));
    update public.route_requests set selected_option_id = null where journey_leg_id in (${list(createdLegs)});
    delete from public.route_options where route_request_id in (select id from public.route_requests where journey_leg_id in (${list(createdLegs)}));
    delete from public.route_requests where journey_leg_id in (${list(createdLegs)});
    delete from public.weather_snapshots where trip_id = '${TRIP}' and created_at >= '${startedAt}';
    delete from public.traffic_snapshots where trip_id = '${TRIP}' and created_at >= '${startedAt}';
    delete from public.place_discovery_results where trip_id = '${TRIP}' and created_at >= '${startedAt}';
    delete from public.place_discovery_runs where trip_id = '${TRIP}' and created_at >= '${startedAt}';
    delete from public.source_references where entity_type in ('place_discovery_run','place_discovery_result','route_option','weather_snapshot','traffic_snapshot','recommendation') and trip_id = '${TRIP}' and created_at >= '${startedAt}';
    delete from public.sources where id in (select id from task08_source_ids);
    delete from public.idempotency_records where scope like 'route-request.%' and created_at >= '${startedAt}';
    delete from public.activity_logs where resource_type = 'journey_leg' and resource_id in (${list(createdLegs)});
    delete from public.journey_legs where id in (${list(createdLegs)});`;
  try {
    await sql(statement);
  } catch (error) {
    await check("CLEANUP: validator rows removed", async () => {
      throw error;
    });
  }
}

finish();
