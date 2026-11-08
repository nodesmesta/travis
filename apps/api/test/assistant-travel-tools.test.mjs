// Unit tests for the route, weather, traffic, and nearby-place tools. The model
// and the services are fakes; the registry, planner validation, synthesis
// validation, and response composition are the real ones.
import assert from "node:assert/strict";
import test from "node:test";
import { ExternalDataError } from "@travelflow/integrations";
import { AssistantOrchestrator } from "../dist/services/assistant/orchestrator.js";
import { OrchestrationFailure } from "../dist/services/assistant/errors.js";
import { createAssistantToolRegistry } from "../dist/services/assistant/tools/registry.js";

const SECRET = "vultr-secret-key-abcdef123456";
const TRIP_ID = "00000000-0000-4000-8000-000000000001";
const NOW = "2026-11-07T12:00:00.000Z";

function point(id, label, type, overrides = {}) {
  return {
    id,
    tripId: TRIP_ID,
    type,
    label,
    address: `${label}, Jakarta`,
    latitude: -6.2,
    longitude: 106.8,
    timezone: "Asia/Jakarta",
    externalPlaceId: `here:${id}`,
    status: "active",
    resolutionStatus: "resolved",
    confirmationStatus: "confirmed",
    source: "user_input",
    metadata: {},
    ...overrides,
  };
}

const snapshot = {
  trip: {
    id: TRIP_ID,
    name: "Jakarta Business Trip",
    timezone: "Asia/Jakarta",
    status: "confirmed",
  },
  destinationSummary: "Jakarta, Indonesia",
  contextPoints: [
    point("hotel-1", "Hotel Indonesia Kempinski", "hotel"),
    point("jcc", "Jakarta Convention Center", "conference"),
    point("air", "Soekarno-Hatta International Airport", "airport"),
    point("m1", "Sudirman Office Tower", "meeting"),
    point("m2", "Kuningan Client Office", "meeting"),
  ],
  agenda: [],
  bookings: [],
  journeyLegs: [
    {
      id: "leg-1",
      tripId: TRIP_ID,
      originContextPointId: "hotel-1",
      destinationContextPointId: "jcc",
      relatedAgendaId: null,
      departureAt: "2026-11-12T07:30:00+07:00",
      arrivalDeadline: "2026-11-12T08:30:00+07:00",
      status: "planned",
    },
  ],
};

// --- fake provider data --------------------------------------------------------

const DEPART = NOW;
function arrival(minutes) {
  return new Date(Date.parse(DEPART) + minutes * 60_000).toISOString();
}

function routeSource(id, provider) {
  return {
    id,
    kind: "provider",
    provider,
    title: `${provider} route`,
    retrieved_at: NOW,
    freshness: "fresh",
    expires_at: "2026-11-07T12:30:00.000Z",
  };
}

function option(id, mode, minutes, rank, recommended, overrides = {}) {
  return {
    id,
    transport_mode: mode,
    provider_facts: {
      distance_meters: 4200,
      duration_seconds: minutes * 60,
      base_duration_seconds: null,
      typical_duration_seconds: null,
      departure_at: DEPART,
      arrival_at: arrival(minutes),
      sections: [],
      notices: [],
    },
    derived_metrics: {
      departure_at: DEPART,
      arrival_at: arrival(minutes),
      total_duration_seconds: minutes * 60,
      traffic_delay_seconds: null,
      traffic_delay_ratio: null,
      walking_minutes: mode === "pedestrian" ? minutes : 0,
      transfer_count: 0,
      safety_buffer_seconds: 600,
      deadline_slack_seconds: null,
      feasible: null,
      latest_departure_at: null,
      reason_codes: [],
    },
    cost: {
      min_amount: null,
      max_amount: null,
      currency: "IDR",
      source_type: "unavailable",
      is_estimate: false,
    },
    risk: { traffic: "unknown", weather: "unknown", overall: "unknown" },
    score: { total: 0.9 - rank / 10, rank },
    status: "valid",
    exclusion_reasons: [],
    recommended,
    source_ids: [`src-${mode}`],
    retrieved_at: NOW,
    expires_at: "2026-11-07T12:30:00.000Z",
    freshness: "fresh",
    ...overrides,
  };
}

function routeView(overrides = {}) {
  return {
    preview: true,
    routeRequestId: null,
    originContextPointId: "hotel-1",
    destinationContextPointId: "jcc",
    departureAt: DEPART,
    arrivalDeadline: null,
    departureBasis: "now",
    options: [
      option("opt-car", "car", 18, 1, true),
      option("opt-walk", "pedestrian", 55, 2, false),
      option("opt-transit", "transit", 31, 3, false),
    ],
    recommendedOptionId: "opt-car",
    departureRecommendation: null,
    facts: [],
    limitations: ["Cost is not provided for these options."],
    sources: [
      routeSource("src-car", "here_routing_v8"),
      routeSource("src-pedestrian", "here_routing_v8"),
      routeSource("src-transit", "here_intermodal_v8"),
    ],
    weather: null,
    traffic: null,
    ...overrides,
  };
}

function weatherPoint(at, temp, probability, condition) {
  return {
    at,
    granularity: "three_hourly",
    interval_minutes: 180,
    temperature_c: temp,
    precipitation_probability: probability,
    precipitation_mm: null,
    wind_speed_ms: 3.2,
    visibility_m: 10000,
    condition_id: 500,
    condition,
    description: condition,
  };
}

const weatherSource = {
  id: "src-weather",
  kind: "provider",
  provider: "openweather_free_2_5",
  title:
    "OpenWeather current weather and 5-day forecast for Jakarta Convention Center",
  retrieved_at: NOW,
  freshness: "fresh",
  expires_at: "2026-11-07T13:00:00.000Z",
};

function weatherView(overrides = {}) {
  return {
    weather: {
      id: "wx-1",
      context_point_id: "jcc",
      source_id: "src-weather",
      timezone: "Asia/Jakarta",
      observed_at: NOW,
      retrieved_at: NOW,
      expires_at: "2026-11-07T13:00:00.000Z",
      freshness: "fresh",
      cache_status: "miss",
      current: {
        ...weatherPoint(NOW, 31.4, null, "light rain"),
        granularity: "current",
      },
      hourly: [
        weatherPoint("2026-11-07T12:00:00Z", 31.4, 0.35, "light rain"),
        weatherPoint("2026-11-07T13:00:00Z", 30.1, 0.6, "light rain"),
      ],
      daily: [
        {
          ...weatherPoint("2026-11-07T05:00:00Z", 29.8, 0.7, "moderate rain"),
          granularity: "daily",
        },
      ],
      alerts: [],
      forecast_interval_minutes: 180,
      forecast_ends_at: "2026-11-12T18:00:00.000Z",
      ...overrides.weather,
    },
    sources: [weatherSource],
  };
}

const trafficSource = {
  id: "src-traffic",
  kind: "provider",
  provider: "here_traffic_v7",
  title: "HERE Traffic API v7 flow and incidents",
  retrieved_at: NOW,
  freshness: "fresh",
  expires_at: "2026-11-07T12:10:00.000Z",
};

function trafficView(overrides = {}) {
  return {
    traffic: {
      id: "tr-1",
      source_id: "src-traffic",
      traffic_level: "heavy",
      observed_at: NOW,
      retrieved_at: NOW,
      expires_at: "2026-11-07T12:10:00.000Z",
      freshness: "fresh",
      cache_status: "miss",
      area: { latitude: -6.2, longitude: 106.8, radius_meters: 3500 },
      summary: {
        segment_count: 42,
        average_jam_factor: 6.4,
        max_jam_factor: 9.1,
        closed_segment_count: 1,
        incident_count: 1,
      },
      incidents: [
        {
          id: "inc-1",
          type: "accident",
          criticality: "major",
          road_closed: false,
          summary: "Accident near the Semanggi interchange",
          start_time: null,
          end_time: null,
        },
      ],
      ...overrides.traffic,
    },
    originContextPointId: "hotel-1",
    destinationContextPointId: "jcc",
    sources: [trafficSource],
  };
}

function placeView(category, overrides = {}) {
  const source = {
    id: `src-${category}`,
    kind: category === "restaurant" ? "provider" : "official_page",
    provider: category === "restaurant" ? "here_places_v7" : "bright_data",
    ...(category === "activity" ? { url: "https://example.com/museum" } : {}),
    title:
      category === "restaurant" ? "HERE Browse restaurants" : "Museum page",
    retrieved_at: NOW,
    freshness: "fresh",
    expires_at: "2026-11-08T12:00:00.000Z",
  };
  const item =
    category === "restaurant"
      ? {
          id: "pl-1",
          name: "Warung Nusantara",
          description: null,
          address: "Jl. Gatot Subroto 12, Jakarta",
          distance_meters: 450,
          official_url: null,
          cuisines: ["indonesian"],
          opening_hours: { text: ["Mon-Sun 10:00-22:00"] },
          status: "suggested",
          source_ids: ["src-restaurant"],
          retrieved_at: NOW,
          expires_at: "2026-11-08T12:00:00.000Z",
          freshness: "fresh",
        }
      : {
          id: "pl-2",
          name: "National Museum",
          description: "Large museum of Indonesian history.",
          address: "Jl. Medan Merdeka Barat 12",
          distance_meters: 1800,
          official_url: "https://example.com/museum",
          activity_type: "museum",
          indoor_outdoor: "indoor",
          recommended_duration_minutes: 90,
          weather_sensitivity: "low",
          booking_required: false,
          opening_hours: null,
          status: "suggested",
          source_ids: ["src-activity"],
          retrieved_at: NOW,
          expires_at: "2026-11-08T12:00:00.000Z",
          freshness: "fresh",
        };
  return {
    category,
    status: "ok",
    cache_status: "miss",
    items: [item],
    sources: [source],
    retrieved_at: NOW,
    expires_at: "2026-11-08T12:00:00.000Z",
    freshness: "fresh",
    limitations: [
      category === "restaurant"
        ? "Distance is measured in a straight line from the context point."
        : "Activities come from web pages and are not verified.",
    ],
    ...overrides,
  };
}

function fakeServices(overrides = {}) {
  const calls = [];
  const services = {
    calls,
    async compareRoutes(request) {
      calls.push({ tool: "compareRoutes", request });
      return routeView();
    },
    async getWeather(request) {
      calls.push({ tool: "getWeather", request });
      return weatherView();
    },
    async getTraffic(request) {
      calls.push({ tool: "getTraffic", request });
      return trafficView();
    },
    async discoverPlaces(request) {
      calls.push({ tool: "discoverPlaces", request });
      return placeView(request.category);
    },
    ...overrides,
  };
  return services;
}

// --- harness -------------------------------------------------------------------

function makeModel({ plan, synth }, counters) {
  return {
    modelId: "test-model",
    async plan(request) {
      counters.plan += 1;
      counters.plannerPrompts.push(JSON.stringify(request.messages));
      return {
        arguments: typeof plan === "function" ? plan(request) : plan,
        meta: { model: "test-model", latencyMs: 1, usage: { totalTokens: 10 } },
      };
    },
    async synthesize(request) {
      counters.synth += 1;
      counters.synthesisPrompts.push(JSON.stringify(request.messages));
      return {
        value: typeof synth === "function" ? synth(request) : synth,
        meta: { model: "test-model", latencyMs: 1, usage: { totalTokens: 20 } },
      };
    },
  };
}

function build({ plan, synth }) {
  const counters = {
    plan: 0,
    synth: 0,
    plannerPrompts: [],
    synthesisPrompts: [],
  };
  const orchestrator = new AssistantOrchestrator({
    model: makeModel({ plan, synth }, counters),
    tools: createAssistantToolRegistry({
      aiToolTimeoutMs: 1000,
      aiEventToolTimeoutMs: 1000,
      aiMobilityToolTimeoutMs: 1000,
    }),
    limits: {
      plannerTimeoutMs: 1000,
      synthesisTimeoutMs: 1000,
      plannerReasoningEffort: "low",
      synthesisReasoningEffort: "low",
      plannerMaxTokens: 1000,
      synthesisMaxTokens: 1000,
      maxToolCalls: 3,
      maxProviderCalls: 4,
      maxParallelTools: 3,
      maxToolResultBytes: 60000,
      maxContextMessages: 8,
      maxMessageChars: 2000,
      totalTimeoutMs: 10000,
    },
    secrets: [SECRET],
    now: () => new Date(NOW),
  });
  return { orchestrator, counters };
}

function input(message, services, overrides = {}) {
  const tripSnapshot = overrides.snapshot ?? snapshot;
  return {
    requestId: "req-1",
    executionId: "exec-1",
    userId: "user-1",
    tripId: TRIP_ID,
    message,
    activeContextPointId: null,
    history: [],
    previousEventResults: [],
    actionableEntities: { event_discovery_result: [], recommendation: [] },
    snapshot: tripSnapshot,
    toolRuntime: {
      requestId: "req-1",
      executionId: "exec-1",
      userId: "user-1",
      tripId: TRIP_ID,
      snapshot: tripSnapshot,
      services,
      maxItems: 8,
    },
    confirmations: {
      async issue() {
        throw new Error("no confirmation expected");
      },
    },
    ...overrides,
  };
}

function plan(intent, toolName, args) {
  return {
    intent,
    needs_clarification: false,
    clarification_question: null,
    tool_calls: [{ tool_name: toolName, arguments: args }],
    proposed_action: null,
  };
}

function synthesis(message, overrides = {}) {
  return {
    message,
    recommendations: [],
    travel_tips: [],
    limitations: [],
    follow_up_actions: [],
    recommended_option_id: null,
    ranked_option_ids: [],
    ...overrides,
  };
}

async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof OrchestrationFailure, String(error));
    return error;
  }
  assert.fail("the execution should have failed");
}

const ROUTE_ARGS = {
  origin_context_point_id: "hotel-1",
  destination_context_point_id: "jcc",
};
const ROUTE_MESSAGE = "bagaimana dari hotel ke Jakarta Convention Center";
const ROUTE_ANSWER = synthesis(
  "Mengemudi direkomendasikan: 18 menit, tiba sekitar Nov 7, 2026, 7:18 PM.",
  {
    recommended_option_id: "opt-car",
    ranked_option_ids: ["opt-car", "opt-walk", "opt-transit"],
  },
);

// --- registry ------------------------------------------------------------------

test("the registry allowlists exactly the nine tools, all read-only with correct provider counts", () => {
  const registry = createAssistantToolRegistry({
    aiToolTimeoutMs: 1,
    aiEventToolTimeoutMs: 2,
    aiMobilityToolTimeoutMs: 3,
  });
  assert.deepEqual(registry.names().sort(), [
    "compare_routes",
    "discover_events",
    "find_nearby_activities",
    "find_nearby_restaurants",
    "get_recommendations",
    "get_traffic",
    "get_trip_advice",
    "get_trip_summary",
    "get_weather",
  ]);
  const tool = (name) => registry.get(name);
  for (const definition of registry.list()) {
    assert.equal(definition.category, "read");
    assert.ok(definition.timeoutMs > 0);
    assert.equal(
      definition.parallelSafe === true || definition.parallelSafe === false,
      true,
    );
  }
  assert.equal(tool("compare_routes").providerCalls, 3);
  assert.equal(tool("get_traffic").providerCalls, 2);
  assert.equal(tool("get_weather").providerCalls, 1);
  assert.equal(tool("get_trip_advice").providerCalls, 3);
  assert.equal(tool("find_nearby_activities").providerCalls, 1);
  assert.equal(tool("find_nearby_restaurants").providerCalls, 1);
  // Tools that call a paid provider run one at a time.
  for (const name of [
    "compare_routes",
    "get_weather",
    "get_traffic",
    "get_trip_advice",
    "find_nearby_activities",
    "find_nearby_restaurants",
  ]) {
    assert.equal(tool(name).live, true);
    assert.equal(tool(name).parallelSafe, false, name);
  }
  assert.deepEqual(tool("compare_routes").intents, ["compare_transport"]);
  assert.deepEqual(tool("get_weather").intents, ["check_weather"]);
  assert.deepEqual(tool("get_traffic").intents, ["check_traffic"]);
  assert.deepEqual(tool("find_nearby_activities").intents, [
    "find_nearby_activity",
  ]);
  assert.deepEqual(tool("find_nearby_restaurants").intents, [
    "find_restaurant",
  ]);
  assert.equal(tool("get_weather").timeoutMs, 3);
  assert.equal(tool("find_nearby_activities").timeoutMs, 2);
  // The planner is told about every new tool.
  const catalog = JSON.stringify(registry.catalog());
  for (const name of registry.names()) assert.ok(catalog.includes(name));
});

// --- compare_routes ------------------------------------------------------------

test("compare_routes: the planner picks the tool, the engine's ranking is locked, and cards carry the engine's figures", async () => {
  const services = fakeServices();
  const { orchestrator, counters } = build({
    plan: plan("compare_transport", "compare_routes", ROUTE_ARGS),
    synth: ROUTE_ANSWER,
  });
  const outcome = await orchestrator.run(input(ROUTE_MESSAGE, services));
  assert.equal(outcome.intent, "compare_transport");
  assert.equal(outcome.state, "completed");
  assert.equal(services.calls.length, 1);
  const call = services.calls[0].request;
  assert.equal(call.originContextPointId, "hotel-1");
  assert.equal(call.destinationContextPointId, "jcc");
  assert.equal(call.departureAt, null);
  assert.equal(call.journeyLegId, undefined);

  const cards = outcome.response.cards;
  assert.deepEqual(
    cards.map((card) => card.type),
    ["route", "route", "route"],
  );
  assert.deepEqual(
    cards.map((card) => card.rank),
    [1, 2, 3],
  );
  assert.deepEqual(
    cards.map((card) => card.recommended),
    [true, undefined, undefined],
  );
  assert.equal(cards[0].title, "Drive: 18 min");
  assert.equal(cards[1].title, "Walk: 55 min");
  const duration = cards[0].fields.find((field) => field.label === "Duration");
  assert.equal(duration.value, "18 min");
  assert.equal(
    cards[0].fields.find((field) => field.label === "Cost").value,
    "Not provided",
  );
  assert.equal(
    cards[0].fields.find((field) => field.label === "Distance").value,
    "4.2 km",
  );
  for (const card of cards) {
    assert.ok(card.source_ids.length > 0);
    assert.ok(card.retrieved_at);
  }
  // Sources and retrieved_at reach the response; so do limitations from the engine and the tool.
  assert.ok(outcome.response.sources.length >= 3);
  assert.equal(outcome.response.retrieved_at, NOW);
  assert.ok(
    outcome.response.limitations.includes(
      "Cost is not provided for these options.",
    ),
  );
  assert.ok(
    outcome.response.limitations.some((text) => text.includes("leaving now")),
  );
  assert.ok(
    outcome.response.limitations.some((text) => text.includes("not saved")),
  );
  assert.equal(outcome.trace.providerCallCount, 3);
  assert.equal(counters.synth, 1);
  // The model sees the locked order and the figures in display units.
  const prompt = counters.synthesisPrompts[0];
  assert.ok(prompt.includes("opt-car"));
  assert.ok(
    prompt.includes("ranked_option_ids") || prompt.includes("rankedOptionIds"),
  );
  assert.ok(prompt.includes("duration_minutes"));
});

test("compare_routes: a synthesis that changes the ranking is rejected", async () => {
  const swapped = synthesis("Berjalan kaki direkomendasikan: 55 menit.", {
    recommended_option_id: "opt-walk",
    ranked_option_ids: ["opt-walk", "opt-car", "opt-transit"],
  });
  const { orchestrator } = build({
    plan: plan("compare_transport", "compare_routes", ROUTE_ARGS),
    synth: swapped,
  });
  const failed = await failure(
    orchestrator.run(input(ROUTE_MESSAGE, fakeServices())),
  );
  assert.equal(failed.code, "RECOMMENDATION_INCONSISTENT");

  const reordered = build({
    plan: plan("compare_transport", "compare_routes", ROUTE_ARGS),
    synth: synthesis("Mengemudi direkomendasikan: 18 menit.", {
      recommended_option_id: "opt-car",
      ranked_option_ids: ["opt-car", "opt-transit", "opt-walk"],
    }),
  });
  assert.equal(
    (
      await failure(
        reordered.orchestrator.run(input(ROUTE_MESSAGE, fakeServices())),
      )
    ).code,
    "RECOMMENDATION_INCONSISTENT",
  );

  const dropped = build({
    plan: plan("compare_transport", "compare_routes", ROUTE_ARGS),
    synth: synthesis("Mengemudi direkomendasikan: 18 menit."),
  });
  assert.equal(
    (
      await failure(
        dropped.orchestrator.run(input(ROUTE_MESSAGE, fakeServices())),
      )
    ).code,
    "RECOMMENDATION_INCONSISTENT",
  );
});

test("compare_routes: a synthesis that changes a number is rejected", async () => {
  const { orchestrator } = build({
    plan: plan("compare_transport", "compare_routes", ROUTE_ARGS),
    synth: synthesis("Mengemudi direkomendasikan: hanya 17 menit.", {
      recommended_option_id: "opt-car",
      ranked_option_ids: ["opt-car", "opt-walk", "opt-transit"],
    }),
  });
  const failed = await failure(
    orchestrator.run(input(ROUTE_MESSAGE, fakeServices())),
  );
  assert.equal(failed.code, "SYNTHESIS_INVALID_OUTPUT");
});

test("compare_routes: a stored journey leg is routed with the leg's own ends", async () => {
  const services = fakeServices({
    async compareRoutes(request) {
      services.calls.push({ tool: "compareRoutes", request });
      return routeView({
        preview: false,
        routeRequestId: "rr-1",
        departureBasis: "leg",
      });
    },
  });
  const { orchestrator } = build({
    plan: plan("compare_transport", "compare_routes", {
      journey_leg_id: "leg-1",
    }),
    synth: ROUTE_ANSWER,
  });
  const outcome = await orchestrator.run(
    input("rute untuk perjalanan hotel ke Jakarta Convention Center", services),
  );
  assert.equal(services.calls[0].request.journeyLegId, "leg-1");
  assert.equal(services.calls[0].request.originContextPointId, undefined);
  assert.ok(
    !outcome.response.limitations.some((text) => text.includes("not saved")),
  );
  assert.ok(
    !outcome.response.limitations.some((text) => text.includes("leaving now")),
  );
});

test("compare_routes: a date and time become the departure in the origin's zone", async () => {
  const services = fakeServices();
  const { orchestrator } = build({
    plan: plan("compare_transport", "compare_routes", {
      ...ROUTE_ARGS,
      date: "2026-11-12",
      time: "07:30",
      modes: ["car", "transit"],
    }),
    synth: ROUTE_ANSWER,
  });
  const outcome = await orchestrator
    .run(input(ROUTE_MESSAGE, services))
    .catch((error) => error);
  assert.equal(
    services.calls[0].request.departureAt,
    "2026-11-12T07:30:00+07:00",
  );
  assert.deepEqual(services.calls[0].request.modes, ["car", "transit"]);
  // Two requested modes make two provider calls.
  if (!(outcome instanceof Error))
    assert.equal(outcome.trace.providerCallCount, 2);
});

test("compare_routes: a date without a time is refused before any provider call", async () => {
  const services = fakeServices();
  const { orchestrator } = build({
    plan: plan("compare_transport", "compare_routes", {
      ...ROUTE_ARGS,
      date: "2026-11-12",
    }),
    synth: ROUTE_ANSWER,
  });
  const failed = await failure(
    orchestrator.run(input(ROUTE_MESSAGE, services)),
  );
  assert.equal(failed.code, "PLANNER_TOOL_ARGUMENT_INVALID");
  assert.equal(services.calls.length, 0);
});

test("compare_routes: unestablished start or end asks the user and calls nothing", async () => {
  for (const message of [
    "how do I get to the airport",
    "route between the hotel and the airport",
    "bagaimana rute ke Jakarta Convention Center",
  ]) {
    const services = fakeServices();
    const { orchestrator, counters } = build({
      plan: plan("compare_transport", "compare_routes", {
        origin_context_point_id: "hotel-1",
        destination_context_point_id: "air",
      }),
      synth: ROUTE_ANSWER,
    });
    const outcome = await orchestrator.run(input(message, services));
    assert.equal(outcome.state, "awaiting_clarification", message);
    assert.ok(outcome.response.clarification, message);
    assert.ok(outcome.response.clarification.options.length >= 3);
    assert.equal(services.calls.length, 0, message);
    assert.equal(counters.synth, 0, message);
    assert.equal(outcome.trace.providerCallCount, 0);
  }
});

test("compare_routes: an ambiguous place name is clarified before the planner runs", async () => {
  const services = fakeServices();
  const { orchestrator, counters } = build({
    plan: plan("compare_transport", "compare_routes", ROUTE_ARGS),
    synth: ROUTE_ANSWER,
  });
  const outcome = await orchestrator.run(
    input("how do I get from the hotel to my office", services),
  );
  assert.equal(outcome.state, "awaiting_clarification");
  assert.equal(counters.plan, 0);
  assert.equal(services.calls.length, 0);
});

test("compare_routes: a planner that swaps the ends or invents a place is rejected", async () => {
  for (const args of [
    { origin_context_point_id: "jcc", destination_context_point_id: "hotel-1" },
    {
      origin_context_point_id: "hotel-1",
      destination_context_point_id: "elsewhere",
    },
    { journey_leg_id: "leg-unknown" },
  ]) {
    const services = fakeServices();
    const { orchestrator } = build({
      plan: plan("compare_transport", "compare_routes", args),
      synth: ROUTE_ANSWER,
    });
    const failed = await failure(
      orchestrator.run(input(ROUTE_MESSAGE, services)),
    );
    assert.equal(
      failed.code,
      "PLANNER_TOOL_ARGUMENT_INVALID",
      JSON.stringify(args),
    );
    assert.equal(services.calls.length, 0);
  }
});

test("compare_routes: a missing HERE key is a structured error, not an answer", async () => {
  const services = fakeServices({
    async compareRoutes() {
      throw new ExternalDataError(
        "EXTERNAL_CONFIGURATION_MISSING",
        "here",
        "HERE Routing is not configured.",
        503,
      );
    },
  });
  const { orchestrator, counters } = build({
    plan: plan("compare_transport", "compare_routes", ROUTE_ARGS),
    synth: ROUTE_ANSWER,
  });
  const failed = await failure(
    orchestrator.run(input(ROUTE_MESSAGE, services)),
  );
  assert.equal(failed.code, "EXTERNAL_CONFIGURATION_MISSING");
  assert.equal(failed.statusCode, 503);
  assert.equal(counters.synth, 0);
  assert.equal(failed.trace.toolCalls[0].status, "failed");
  assert.equal(
    failed.trace.toolCalls[0].error_code,
    "EXTERNAL_CONFIGURATION_MISSING",
  );
  assert.equal(failed.trace.providerCallCount, 3);
});

test("compare_routes: an expired option ends the execution instead of being shown", async () => {
  const services = fakeServices({
    async compareRoutes() {
      return routeView({
        options: [
          option("opt-car", "car", 18, 1, true, { freshness: "expired" }),
        ],
        recommendedOptionId: "opt-car",
      });
    },
  });
  const { orchestrator } = build({
    plan: plan("compare_transport", "compare_routes", ROUTE_ARGS),
    synth: ROUTE_ANSWER,
  });
  const failed = await failure(
    orchestrator.run(input(ROUTE_MESSAGE, services)),
  );
  assert.equal(failed.code, "TOOL_RESULT_INVALID");
});

test("compare_routes: with no recommended option the model may not name one", async () => {
  const services = fakeServices({
    async compareRoutes() {
      return routeView({
        options: [
          option("opt-car", "car", 18, 1, false, {
            status: "excluded",
            exclusion_reasons: ["arrival_deadline"],
            score: null,
          }),
        ],
        recommendedOptionId: null,
      });
    },
  });
  const named = build({
    plan: plan("compare_transport", "compare_routes", ROUTE_ARGS),
    synth: synthesis("Mengemudi 18 menit.", {
      recommended_option_id: "opt-car",
    }),
  });
  assert.equal(
    (await failure(named.orchestrator.run(input(ROUTE_MESSAGE, services))))
      .code,
    "RECOMMENDATION_INCONSISTENT",
  );
  const honest = build({
    plan: plan("compare_transport", "compare_routes", ROUTE_ARGS),
    synth: synthesis(
      "Tidak ada opsi yang direkomendasikan; mengemudi memakan 18 menit.",
    ),
  });
  const outcome = await honest.orchestrator.run(input(ROUTE_MESSAGE, services));
  assert.equal(outcome.response.cards[0].status, "excluded");
  assert.equal(outcome.response.cards[0].recommended, undefined);
  assert.equal(
    outcome.response.cards[0].fields.find(
      (field) => field.label === "Excluded because",
    ).value,
    "arrival_deadline",
  );
});

// --- get_weather ---------------------------------------------------------------

test("get_weather: figures appear as the provider gave them, with source and time", async () => {
  const services = fakeServices();
  const { orchestrator } = build({
    plan: plan("check_weather", "get_weather", { context_point_id: "jcc" }),
    synth: synthesis(
      "Di sekitar Jakarta Convention Center saat ini 31.4 derajat dengan hujan ringan; peluang hujan hingga 60%.",
    ),
  });
  const outcome = await orchestrator.run(
    input("cuaca di sekitar JCC", services),
  );
  assert.equal(outcome.intent, "check_weather");
  assert.equal(services.calls[0].request.contextPointId, "jcc");
  const card = outcome.response.cards[0];
  assert.equal(card.type, "weather");
  assert.equal(card.title, "Weather at Jakarta Convention Center");
  assert.equal(
    card.fields.find((field) => field.label === "Now").value,
    "31.4 °C, light rain",
  );
  assert.equal(
    card.fields
      .find((field) => field.label === "Next 24 h")
      .value.includes("up to 60%"),
    true,
  );
  assert.equal(card.retrieved_at, NOW);
  assert.deepEqual(card.source_ids, ["src-weather"]);
  assert.equal(outcome.response.sources[0].provider, "openweather_free_2_5");
  assert.equal(outcome.response.retrieved_at, NOW);
  assert.equal(outcome.trace.providerCallCount, 1);
});

test("get_weather: only the next 24 hours are summarized, and the forecast end is stated", async () => {
  const view = weatherView();
  view.weather.hourly = [
    weatherPoint("2026-11-07T12:00:00Z", 31.4, 0.35, "light rain"),
    weatherPoint("2026-11-08T09:00:00Z", 28.0, 0.2, "light rain"),
    // 3 days later: outside the 24 hour window, must not shape the summary.
    weatherPoint("2026-11-10T12:00:00Z", 22.0, 0.95, "heavy rain"),
  ];
  const services = fakeServices({
    async getWeather() {
      return view;
    },
  });
  const { orchestrator } = build({
    plan: plan("check_weather", "get_weather", { context_point_id: "jcc" }),
    synth: synthesis("Hujan ringan, peluang hingga 35%."),
  });
  const outcome = await orchestrator.run(
    input("cuaca di sekitar JCC", services),
  );
  const summary = outcome.response.cards[0].fields.find(
    (field) => field.label === "Next 24 h",
  );
  assert.ok(summary.value.includes("up to 35%"), summary.value);
  assert.ok(!summary.value.includes("95"), summary.value);
  const notes = outcome.response.limitations.join(" | ");
  assert.ok(notes.includes("3 hours apart, not hourly"), notes);
  assert.ok(notes.includes("The forecast ends"), notes);
  assert.ok(notes.includes("Later times have no forecast"), notes);
  assert.ok(notes.includes("Weather data from OpenWeather"), notes);
});

test("get_weather: a cached snapshot counts no provider call", async () => {
  const cached = weatherView();
  cached.weather.cache_status = "hit";
  const services = fakeServices({
    async getWeather() {
      return cached;
    },
  });
  const { orchestrator } = build({
    plan: plan("check_weather", "get_weather", { context_point_id: "jcc" }),
    synth: synthesis("Saat ini 31.4 derajat."),
  });
  const outcome = await orchestrator.run(
    input("cuaca di sekitar JCC", services),
  );
  assert.equal(outcome.trace.providerCallCount, 0);
});

test("get_weather: a number the provider did not give is rejected", async () => {
  const { orchestrator } = build({
    plan: plan("check_weather", "get_weather", { context_point_id: "jcc" }),
    synth: synthesis("Saat ini 35 derajat dengan hujan ringan."),
  });
  const failed = await failure(
    orchestrator.run(input("cuaca di sekitar JCC", fakeServices())),
  );
  assert.equal(failed.code, "SYNTHESIS_INVALID_OUTPUT");
});

test("get_weather: a missing OpenWeather key is a structured error", async () => {
  const services = fakeServices({
    async getWeather() {
      throw new ExternalDataError(
        "EXTERNAL_CONFIGURATION_MISSING",
        "openweather",
        "OpenWeather is not configured.",
        503,
      );
    },
  });
  const { orchestrator, counters } = build({
    plan: plan("check_weather", "get_weather", { context_point_id: "jcc" }),
    synth: synthesis("unused"),
  });
  const failed = await failure(
    orchestrator.run(input("cuaca di sekitar JCC", services)),
  );
  assert.equal(failed.code, "EXTERNAL_CONFIGURATION_MISSING");
  assert.equal(counters.synth, 0);
});

test("get_weather: with no place named or selected the user is asked", async () => {
  const services = fakeServices();
  const { orchestrator } = build({
    plan: plan("check_weather", "get_weather", { context_point_id: "jcc" }),
    synth: synthesis("unused"),
  });
  const outcome = await orchestrator.run(
    input("bagaimana cuacanya?", services),
  );
  assert.equal(outcome.state, "awaiting_clarification");
  assert.equal(services.calls.length, 0);
  // The place selected in the interface is used when the message names none.
  const selected = await build({
    plan: plan("check_weather", "get_weather", { context_point_id: "jcc" }),
    synth: synthesis("Saat ini 31.4 derajat."),
  }).orchestrator.run(
    input("bagaimana cuacanya?", fakeServices(), {
      activeContextPointId: "jcc",
    }),
  );
  assert.equal(selected.state, "completed");
});

// --- get_traffic ---------------------------------------------------------------

test("get_traffic: the level and jam factors are shown as given, and a missing key is an error", async () => {
  const services = fakeServices();
  const { orchestrator } = build({
    plan: plan("check_traffic", "get_traffic", ROUTE_ARGS),
    synth: synthesis(
      "Lalu lintas antara hotel dan Jakarta Convention Center padat dengan faktor kemacetan rata-rata 6.4 dari 10.",
    ),
  });
  const outcome = await orchestrator.run(
    input(
      "bagaimana lalu lintas dari hotel ke Jakarta Convention Center",
      services,
    ),
  );
  assert.equal(outcome.intent, "check_traffic");
  const card = outcome.response.cards[0];
  assert.equal(card.type, "traffic");
  assert.equal(card.status, "heavy");
  assert.equal(
    card.fields.find((field) => field.label === "Average jam factor").value,
    "6.4 of 10",
  );
  assert.equal(
    card.fields.find((field) => field.label === "Incidents").value,
    "1",
  );
  assert.ok(
    outcome.response.limitations.some((text) => text.includes("snapshot")),
  );
  assert.equal(outcome.trace.providerCallCount, 2);

  const missing = fakeServices({
    async getTraffic() {
      throw new ExternalDataError(
        "EXTERNAL_CONFIGURATION_MISSING",
        "here",
        "HERE Traffic is not configured.",
        503,
      );
    },
  });
  const failed = await failure(
    build({
      plan: plan("check_traffic", "get_traffic", ROUTE_ARGS),
      synth: synthesis("unused"),
    }).orchestrator.run(
      input(
        "bagaimana lalu lintas dari hotel ke Jakarta Convention Center",
        missing,
      ),
    ),
  );
  assert.equal(failed.code, "EXTERNAL_CONFIGURATION_MISSING");
});

test("get_traffic: the ends must come from the message", async () => {
  const outcome = await build({
    plan: plan("check_traffic", "get_traffic", ROUTE_ARGS),
    synth: synthesis("unused"),
  }).orchestrator.run(input("is there traffic today?", fakeServices()));
  assert.equal(outcome.state, "awaiting_clarification");
});

// --- nearby places -------------------------------------------------------------

test("find_nearby_restaurants: straight-line distances and hours come from the provider", async () => {
  const services = fakeServices();
  const { orchestrator } = build({
    plan: plan("find_restaurant", "find_nearby_restaurants", {
      search_context_point_id: "jcc",
      radius_meters: 800,
    }),
    synth: synthesis(
      "Warung Nusantara berjarak 450 m dari Jakarta Convention Center, buka 10:00-22:00.",
    ),
  });
  const outcome = await orchestrator.run(
    input("restoran dekat Jakarta Convention Center", services),
  );
  assert.equal(outcome.intent, "find_restaurant");
  assert.equal(services.calls[0].request.category, "restaurant");
  assert.equal(services.calls[0].request.radiusMeters, 800);
  const card = outcome.response.cards[0];
  assert.equal(card.type, "restaurant");
  assert.equal(
    card.fields.find((field) => field.label === "Distance").value,
    "450 m straight line",
  );
  assert.equal(
    card.fields.find((field) => field.label === "Cuisine").value,
    "indonesian",
  );
  assert.equal(
    card.fields.find((field) => field.label === "Opening hours").value,
    "Mon-Sun 10:00-22:00",
  );
  assert.ok(outcome.response.limitations[0].includes("straight line"));
  assert.equal(outcome.trace.providerCallCount, 1);
});

test("find_nearby_activities: sourced candidates become activity cards, cache hits count no call", async () => {
  const services = fakeServices();
  const { orchestrator } = build({
    plan: plan("find_nearby_activity", "find_nearby_activities", {
      search_context_point_id: "jcc",
    }),
    synth: synthesis(
      "National Museum berjarak 1.8 km dan disarankan sekitar 90 menit.",
    ),
  });
  const outcome = await orchestrator.run(
    input(
      "apa yang bisa dilakukan di sekitar Jakarta Convention Center",
      services,
    ),
  );
  const card = outcome.response.cards[0];
  assert.equal(card.type, "activity");
  assert.equal(
    card.fields.find((field) => field.label === "Distance").value,
    "1.8 km straight line",
  );
  assert.equal(
    card.fields.find((field) => field.label === "Suggested time").value,
    "90 min",
  );
  assert.equal(
    card.fields.find((field) => field.label === "Booking required").value,
    "No",
  );
  assert.equal(card.actions, undefined);

  const cached = fakeServices({
    async discoverPlaces(request) {
      return placeView(request.category, {
        retrieved_at: "2026-11-07T11:00:00.000Z",
      });
    },
  });
  const second = await build({
    plan: plan("find_nearby_activity", "find_nearby_activities", {
      search_context_point_id: "jcc",
    }),
    synth: synthesis("National Museum berjarak 1.8 km."),
  }).orchestrator.run(
    input(
      "apa yang bisa dilakukan di sekitar Jakarta Convention Center",
      cached,
    ),
  );
  assert.equal(second.trace.providerCallCount, 0);
});

test("find_nearby_restaurants: an empty result is reported as empty, with no cards", async () => {
  const services = fakeServices({
    async discoverPlaces(request) {
      return placeView(request.category, { items: [], status: "empty" });
    },
  });
  const { orchestrator } = build({
    plan: plan("find_restaurant", "find_nearby_restaurants", {
      search_context_point_id: "jcc",
    }),
    synth: synthesis(
      "Tidak ada restoran ditemukan di dekat Jakarta Convention Center.",
    ),
  });
  const outcome = await orchestrator.run(
    input("restoran dekat Jakarta Convention Center", services),
  );
  assert.equal(outcome.response.cards.length, 0);
});

test("the tools refuse an intent that does not belong to them", async () => {
  const { orchestrator } = build({
    plan: plan("check_weather", "compare_routes", ROUTE_ARGS),
    synth: ROUTE_ANSWER,
  });
  const failed = await failure(
    orchestrator.run(input(ROUTE_MESSAGE, fakeServices())),
  );
  assert.equal(failed.code, "PLANNER_INVALID_OUTPUT");
});

test("a plan that needs more provider calls than allowed is rejected before any call", async () => {
  const services = fakeServices();
  const { orchestrator } = build({
    plan: {
      intent: "compare_transport",
      needs_clarification: false,
      clarification_question: null,
      tool_calls: [
        { tool_name: "compare_routes", arguments: ROUTE_ARGS },
        { tool_name: "get_traffic", arguments: ROUTE_ARGS },
      ],
      proposed_action: null,
    },
    synth: ROUTE_ANSWER,
  });
  const failed = await failure(
    orchestrator.run(input(ROUTE_MESSAGE, services)),
  );
  // get_traffic does not serve compare_transport, and 3 + 2 calls exceed the limit of 4.
  assert.ok(
    ["PLANNER_INVALID_OUTPUT", "PLANNER_LIMIT_EXCEEDED"].includes(failed.code),
    failed.code,
  );
  assert.equal(services.calls.length, 0);
});

// --- get_trip_advice -----------------------------------------------------------

const adviceSnapshot = {
  ...snapshot,
  agenda: [
    {
      id: "agenda-1",
      tripId: TRIP_ID,
      contextPointId: "jcc",
      title: "Opening keynote",
      type: "conference",
      startAt: "2026-11-12T09:00:00+07:00",
      endAt: "2026-11-12T10:00:00+07:00",
      timezone: "Asia/Jakarta",
      status: "confirmed",
      source: "user_input",
      metadata: {},
    },
    {
      id: "agenda-2",
      tripId: TRIP_ID,
      contextPointId: "hotel-1",
      title: "Client dinner",
      type: "meal",
      startAt: "2026-11-12T18:00:00+07:00",
      endAt: "2026-11-12T19:30:00+07:00",
      timezone: "Asia/Jakarta",
      status: "planned",
      source: "user_input",
      metadata: {},
    },
  ],
};

test("get_trip_advice: one day of agenda, weather and the ride, with a sourced travel tip", async () => {
  const services = fakeServices();
  const { orchestrator } = build({
    plan: plan("get_trip_advice", "get_trip_advice", { date: "2026-11-12" }),
    synth: synthesis("Leave earlier because rain is likely.", {
      travel_tips: [
        {
          title: "Leave earlier",
          detail: "Rain is likely, so keep extra time for the ride.",
          source_ids: ["src-weather"],
        },
      ],
    }),
  });
  const outcome = await orchestrator.run(
    input("What should I know for 12 November?", services, {
      snapshot: adviceSnapshot,
    }),
  );
  assert.equal(outcome.intent, "get_trip_advice");
  assert.equal(outcome.state, "completed");
  assert.deepEqual(
    services.calls.map((call) => call.tool),
    ["getWeather", "compareRoutes"],
  );
  assert.equal(outcome.response.travel_tips.length, 1);
  assert.equal(outcome.response.travel_tips[0].source_ids[0], "src-weather");
  assert.ok(
    outcome.response.cards.some((card) => card.type === "agenda"),
    "the day's agenda is shown as cards",
  );
  assert.ok(
    outcome.response.cards.some((card) => card.type === "weather"),
    "the day's weather is shown as a card",
  );
  assert.ok(
    outcome.response.facts.some(
      (fact) => fact.label === "Getting between places",
    ),
    "the ride is reported as a fact",
  );
});
