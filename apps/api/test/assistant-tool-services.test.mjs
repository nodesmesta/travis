// The adapter between the assistant's tools and the Task 08 services: it must
// route a stored leg to createRouteRequest, a bare pair to previewRoutes, and
// reshape results without adding or changing any figure.
import assert from "node:assert/strict";
import test from "node:test";
import { createToolServices } from "../dist/services/assistant/tool-services.js";

function build(overrides = {}) {
  const calls = [];
  const record = (name, value) => {
    calls.push({ name, value });
    return value;
  };
  const mobility = {
    async createRouteRequest(input, command) {
      record("createRouteRequest", { input, command });
      return {
        route_request: {
          id: "rr-1",
          origin_context_point_id: "o",
          destination_context_point_id: "d",
          departure_at: "2026-11-12T00:45:00.000Z",
          arrival_deadline: "2026-11-12T02:00:00.000Z",
        },
        options: [{ id: "opt-1" }],
        recommended_option_id: "opt-1",
        departure_recommendation: null,
        facts: ["fact"],
        limitations: ["limit"],
        sources: [{ id: "s1" }],
        weather: null,
        traffic: null,
      };
    },
    async previewRoutes(input) {
      record("previewRoutes", input);
      return {
        preview: true,
        origin_context_point_id: "o",
        destination_context_point_id: "d",
        departure_at: "2026-11-07T12:00:00.000Z",
        departure_basis: "now",
        options: [{ id: "opt-9" }],
        recommended_option_id: "opt-9",
        departure_recommendation: null,
        facts: [],
        limitations: [],
        sources: [{ id: "s9" }],
        weather: null,
        traffic: null,
      };
    },
    async refreshWeather(input) {
      record("refreshWeather", input);
      return { items: [{ id: "w1", source_id: "sw" }] };
    },
    async refreshTraffic(input) {
      record("refreshTraffic", input);
      return {
        items: [
          {
            id: "t1",
            source_id: "st",
            origin_context_point_id: "o",
            destination_context_point_id: "d",
          },
        ],
      };
    },
    async refreshTrafficForPair(input) {
      record("refreshTrafficForPair", input);
      return {
        items: [
          {
            id: "t2",
            source_id: "st",
            origin_context_point_id: input.originContextPointId,
            destination_context_point_id: input.destinationContextPointId,
          },
        ],
      };
    },
    async sourceViews(tripId, ids) {
      record("sourceViews", { tripId, ids });
      return ids.map((id) => ({ id }));
    },
    ...overrides,
  };
  const places = {
    async discover(input) {
      record("discover", input);
      return { category: input.category, items: [] };
    },
  };
  const services = createToolServices({
    mobility,
    places,
    events: { async discover() {} },
    async listBookings() {
      return [];
    },
    async listRecommendations() {
      return [];
    },
  });
  return { services, calls };
}

const base = {
  requestId: "req",
  executionId: "exec-1",
  userId: "user-1",
  tripId: "trip-1",
};

test("a stored leg is routed through createRouteRequest with a per-execution idempotency key", async () => {
  const { services, calls } = build();
  const view = await services.compareRoutes({
    ...base,
    journeyLegId: "leg-1",
    departureAt: null,
    modes: ["car"],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "createRouteRequest");
  assert.deepEqual(calls[0].value.input.body, { modes: ["car"] });
  assert.equal(calls[0].value.command.actorUserId, "user-1");
  assert.equal(calls[0].value.command.idempotencyKey, "assistant:exec-1:leg-1");
  assert.equal(view.preview, false);
  assert.equal(view.routeRequestId, "rr-1");
  assert.equal(view.departureBasis, "leg");
  assert.equal(view.arrivalDeadline, "2026-11-12T02:00:00.000Z");
  assert.equal(view.recommendedOptionId, "opt-1");
  assert.deepEqual(view.options, [{ id: "opt-1" }]);
});

test("a bare pair is previewed, never stored, and keeps the service's departure basis", async () => {
  const { services, calls } = build();
  const view = await services.compareRoutes({
    ...base,
    originContextPointId: "o",
    destinationContextPointId: "d",
    departureAt: null,
  });
  assert.deepEqual(
    calls.map((call) => call.name),
    ["previewRoutes"],
  );
  assert.equal(calls[0].value.departureAt, null);
  assert.equal(calls[0].value.modes, undefined);
  assert.equal(view.preview, true);
  assert.equal(view.routeRequestId, null);
  assert.equal(view.departureBasis, "now");
  assert.equal(view.recommendedOptionId, "opt-9");
});

test("weather and traffic return the service's rows with their source records", async () => {
  const { services, calls } = build();
  const weather = await services.getWeather({
    ...base,
    contextPointId: "jcc",
  });
  assert.equal(weather.weather.id, "w1");
  assert.deepEqual(weather.sources, [{ id: "sw" }]);
  const leg = await services.getTraffic({ ...base, journeyLegId: "leg-1" });
  assert.equal(leg.traffic.id, "t1");
  assert.equal(leg.originContextPointId, "o");
  const pair = await services.getTraffic({
    ...base,
    originContextPointId: "a",
    destinationContextPointId: "b",
  });
  assert.equal(pair.traffic.id, "t2");
  assert.equal(pair.destinationContextPointId, "b");
  assert.deepEqual(
    calls.map((call) => call.name).filter((name) => name.startsWith("refresh")),
    ["refreshWeather", "refreshTraffic", "refreshTrafficForPair"],
  );
});

test("place discovery passes the category and radius through unchanged", async () => {
  const { services, calls } = build();
  await services.discoverPlaces({
    ...base,
    contextPointId: "jcc",
    category: "restaurant",
    radiusMeters: 800,
    language: "en",
  });
  const call = calls.at(-1).value;
  assert.equal(call.category, "restaurant");
  assert.equal(call.radiusMeters, 800);
  assert.equal(call.language, "en");
});

test("an error from a service reaches the caller untouched", async () => {
  const failure = new Error("boom");
  const { services } = build({
    async previewRoutes() {
      throw failure;
    },
  });
  await assert.rejects(
    services.compareRoutes({
      ...base,
      originContextPointId: "o",
      destinationContextPointId: "d",
      departureAt: null,
    }),
    (error) => error === failure,
  );
});
