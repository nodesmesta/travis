import assert from "node:assert/strict";
import test from "node:test";
import {
  ConfirmationService,
  hashConfirmationPayload,
  hashConfirmationToken,
} from "../dist/services/assistant/confirmation-service.js";
import { refusalError } from "../dist/repositories/confirmation-repository.js";

const TRIP = "00000000-0000-4000-8000-000000000001";
const REC = "00000000-0000-4000-8000-0000000000a1";
const NOW = new Date("2026-11-07T12:00:00Z");

/**
 * In-memory stand-in for the confirmation table. It mirrors the atomic
 * UPDATE ... WHERE consumed_at IS NULL AND expires_at > now() AND user_id = caller
 * of migration 0008. The real SQL is exercised by scripts/validate-task-09.mjs.
 */
function createStore() {
  return { rows: [], consumeCalls: 0 };
}

function confirmationsFor(store, userId, clock) {
  return {
    async insert(input) {
      store.rows.push({ ...input, consumedAt: null });
    },
    async consume(input) {
      store.consumeCalls += 1;
      const row = store.rows.find(
        (candidate) =>
          candidate.tokenHash === input.tokenHash &&
          candidate.userId === userId &&
          candidate.tripId === input.tripId &&
          candidate.action === input.action &&
          candidate.entityType === input.entityType &&
          candidate.entityId === input.entityId &&
          candidate.payloadHash === input.payloadHash &&
          candidate.consumedAt === null &&
          Date.parse(candidate.expiresAt) > clock().getTime(),
      );
      if (!row) return null;
      row.consumedAt = clock().toISOString();
      return "confirmation-id";
    },
    async explainRefusal(tokenHash) {
      const row = store.rows.find(
        (candidate) =>
          candidate.tokenHash === tokenHash && candidate.userId === userId,
      );
      if (!row) return "invalid";
      if (row.consumedAt) return "used";
      if (Date.parse(row.expiresAt) <= clock().getTime()) return "expired";
      return "invalid";
    },
    async getEventResult() {
      return null;
    },
  };
}

function recommendationStore(overrides = {}) {
  return {
    record: {
      id: REC,
      trip_id: TRIP,
      conversation_id: null,
      context_point_id: null,
      recommendation_type: "mobility",
      context_snapshot: {},
      payload: {
        title: "Leave 20 minutes earlier",
        itinerary_item: {
          title: "Depart for the meeting",
          start_at: "2026-11-13T07:40:00+07:00",
          end_at: "2026-11-13T08:10:00+07:00",
          timezone: "Asia/Jakarta",
        },
      },
      reason: "Traffic is heavy.",
      created_at: "2026-11-07T11:00:00Z",
      expires_at: "2026-11-13T00:00:00Z",
      status: "proposed",
      ...overrides,
    },
  };
}

function build({
  store,
  userId,
  recommendation,
  clock = () => NOW,
  routeSource,
}) {
  const agendaCreated = [];
  const activity = [];
  const service = new ConfirmationService({
    confirmations: confirmationsFor(store, userId, clock),
    recommendations: {
      async get(_trip, id) {
        return id === recommendation.record.id
          ? { ...recommendation.record }
          : null;
      },
      async transition(_trip, _id, expected, next) {
        if (recommendation.record.status !== expected) return null;
        recommendation.record.status = next;
        return { ...recommendation.record };
      },
      async list() {
        return [{ ...recommendation.record }];
      },
      async routeItinerarySource() {
        return routeSource ?? null;
      },
    },
    activityLog: {
      async append(entry) {
        activity.push(entry);
      },
    },
    async createAgendaItem(input) {
      agendaCreated.push(input);
      return { id: "agenda-1" };
    },
    ttlMinutes: 15,
    now: clock,
  });
  return { service, agendaCreated, activity };
}

const command = { idempotencyKey: "idem-key-0123456789", requestHash: "x" };

function issue(service, userId, action = "apply_recommendation") {
  return service.issue({
    userId,
    tripId: TRIP,
    tripTimezone: "Asia/Jakarta",
    conversationId: null,
    action,
    entityId: REC,
  });
}

test("only the SHA-256 hash of the token is stored", async () => {
  const store = createStore();
  const { service } = build({
    store,
    userId: "alice",
    recommendation: recommendationStore(),
  });
  const request = await issue(service, "alice");
  assert.equal(request.confirmation_token.length, 43);
  assert.equal(store.rows.length, 1);
  assert.equal(
    store.rows[0].tokenHash,
    hashConfirmationToken(request.confirmation_token),
  );
  assert.equal(store.rows[0].tokenHash.length, 64);
  assert.ok(!JSON.stringify(store.rows).includes(request.confirmation_token));
  assert.equal(request.expires_at, "2026-11-07T12:15:00.000Z");
});

test("a valid token applies the recommendation once; replay is refused as used", async () => {
  const store = createStore();
  const recommendation = recommendationStore();
  const { service, agendaCreated, activity } = build({
    store,
    userId: "alice",
    recommendation,
  });
  const request = await issue(service, "alice");
  const result = await service.runRecommendationAction({
    userId: "alice",
    tripId: TRIP,
    recommendationId: REC,
    action: "apply",
    token: request.confirmation_token,
    command,
  });
  assert.equal(result.status, "applied");
  assert.equal(result.agendaItemId, "agenda-1");
  assert.equal(agendaCreated.length, 1);
  assert.equal(agendaCreated[0].source, "assistant_suggestion");
  assert.equal(activity[0].action, "assistant.recommendation_applied");

  await assert.rejects(
    service.runRecommendationAction({
      userId: "alice",
      tripId: TRIP,
      recommendationId: REC,
      action: "apply",
      token: request.confirmation_token,
      command,
    }),
    // The recommendation is already applied, so the state check fires first.
    (error) => error.code === "RECOMMENDATION_STATE_INVALID",
  );
  assert.equal(agendaCreated.length, 1, "no second agenda item");
});

test("replaying a used token against a still-open recommendation is CONFIRMATION_TOKEN_USED", async () => {
  const store = createStore();
  const recommendation = recommendationStore();
  const { service } = build({ store, userId: "alice", recommendation });
  const request = await issue(service, "alice", "save_recommendation");
  await service.runRecommendationAction({
    userId: "alice",
    tripId: TRIP,
    recommendationId: REC,
    action: "save",
    token: request.confirmation_token,
    command,
  });
  // Put the recommendation back to its earlier state to isolate the token check.
  recommendation.record.status = "proposed";
  await assert.rejects(
    service.runRecommendationAction({
      userId: "alice",
      tripId: TRIP,
      recommendationId: REC,
      action: "save",
      token: request.confirmation_token,
      command,
    }),
    (error) =>
      error.code === "CONFIRMATION_TOKEN_USED" && error.statusCode === 409,
  );
});

test("a token issued to another user is refused and stays unused", async () => {
  const store = createStore();
  const recommendation = recommendationStore();
  const alice = build({ store, userId: "alice", recommendation });
  const mallory = build({ store, userId: "mallory", recommendation });
  const request = await issue(alice.service, "alice");
  await assert.rejects(
    mallory.service.runRecommendationAction({
      userId: "mallory",
      tripId: TRIP,
      recommendationId: REC,
      action: "apply",
      token: request.confirmation_token,
      command,
    }),
    (error) =>
      error.code === "CONFIRMATION_TOKEN_INVALID" && error.statusCode === 403,
  );
  assert.equal(mallory.agendaCreated.length, 0);
  assert.equal(recommendation.record.status, "proposed");
  assert.equal(store.rows[0].consumedAt, null, "the owner can still use it");
});

test("a token is bound to its action: a save token cannot dismiss or apply", async () => {
  const store = createStore();
  const recommendation = recommendationStore();
  const { service, agendaCreated } = build({
    store,
    userId: "alice",
    recommendation,
  });
  const request = await issue(service, "alice", "save_recommendation");
  for (const action of ["apply", "dismiss"]) {
    await assert.rejects(
      service.runRecommendationAction({
        userId: "alice",
        tripId: TRIP,
        recommendationId: REC,
        action,
        token: request.confirmation_token,
        command,
      }),
      (error) => error.code === "CONFIRMATION_TOKEN_INVALID",
    );
  }
  assert.equal(agendaCreated.length, 0);
  assert.equal(recommendation.record.status, "proposed");
});

test("an expired token is refused with CONFIRMATION_TOKEN_EXPIRED", async () => {
  const store = createStore();
  let now = NOW;
  const recommendation = recommendationStore();
  const { service } = build({
    store,
    userId: "alice",
    recommendation,
    clock: () => now,
  });
  const request = await issue(service, "alice");
  now = new Date(NOW.getTime() + 16 * 60_000);
  await assert.rejects(
    service.runRecommendationAction({
      userId: "alice",
      tripId: TRIP,
      recommendationId: REC,
      action: "apply",
      token: request.confirmation_token,
      command,
    }),
    (error) => error.code === "CONFIRMATION_TOKEN_EXPIRED",
  );
});

test("a token no longer matches once what the user saw has changed", async () => {
  const store = createStore();
  const recommendation = recommendationStore();
  const { service } = build({ store, userId: "alice", recommendation });
  const request = await issue(service, "alice");
  recommendation.record.payload = {
    ...recommendation.record.payload,
    title: "Something else",
  };
  await assert.rejects(
    service.runRecommendationAction({
      userId: "alice",
      tripId: TRIP,
      recommendationId: REC,
      action: "apply",
      token: request.confirmation_token,
      command,
    }),
    (error) => error.code === "CONFIRMATION_TOKEN_INVALID",
  );
});

test("a made-up token is invalid and nothing changes", async () => {
  const store = createStore();
  const recommendation = recommendationStore();
  const { service, agendaCreated } = build({
    store,
    userId: "alice",
    recommendation,
  });
  await issue(service, "alice");
  await assert.rejects(
    service.runRecommendationAction({
      userId: "alice",
      tripId: TRIP,
      recommendationId: REC,
      action: "apply",
      token: "z".repeat(43),
      command,
    }),
    (error) => error.code === "CONFIRMATION_TOKEN_INVALID",
  );
  assert.equal(agendaCreated.length, 0);
});

test("a recommendation without an itinerary item cannot be confirmed for apply, and no token is issued", async () => {
  const store = createStore();
  const recommendation = recommendationStore({
    payload: { title: "Take the train" },
  });
  const { service, agendaCreated } = build({
    store,
    userId: "alice",
    recommendation,
  });
  await assert.rejects(
    issue(service, "alice"),
    (error) => error.code === "RECOMMENDATION_NOT_APPLICABLE",
  );
  assert.equal(store.rows.length, 0);
  assert.equal(agendaCreated.length, 0);
  // Saving or dismissing it is still possible.
  const save = await issue(service, "alice", "save_recommendation");
  assert.equal(store.rows.length, 1);
  assert.ok(save.confirmation_token);
});

test("dismissed, applied, and expired recommendations cannot be actioned or confirmed", async () => {
  for (const status of ["dismissed", "applied", "expired"]) {
    const store = createStore();
    const { service } = build({
      store,
      userId: "alice",
      recommendation: recommendationStore({ status }),
    });
    await assert.rejects(
      issue(service, "alice"),
      (error) => error.code === "RECOMMENDATION_STATE_INVALID",
      status,
    );
    assert.equal(
      store.rows.length,
      0,
      "no token is issued for a closed recommendation",
    );
  }
  const store = createStore();
  const { service } = build({
    store,
    userId: "alice",
    recommendation: recommendationStore({ expires_at: "2026-11-07T11:59:00Z" }),
  });
  await assert.rejects(
    issue(service, "alice"),
    (error) => error.code === "RECOMMENDATION_EXPIRED",
  );
});

test("an unknown recommendation is not found and issues no token", async () => {
  const store = createStore();
  const { service } = build({
    store,
    userId: "alice",
    recommendation: recommendationStore(),
  });
  await assert.rejects(
    service.issue({
      userId: "alice",
      tripId: TRIP,
      tripTimezone: "Asia/Jakarta",
      conversationId: null,
      action: "apply_recommendation",
      entityId: "00000000-0000-4000-8000-0000000000ff",
    }),
    (error) => error.code === "RESOURCE_NOT_FOUND",
  );
  assert.equal(store.rows.length, 0);
});

test("payload hashes are stable for equal content regardless of key order", () => {
  assert.equal(
    hashConfirmationPayload({ a: 1, b: { c: 2, d: 3 } }),
    hashConfirmationPayload({ b: { d: 3, c: 2 }, a: 1 }),
  );
  assert.notEqual(
    hashConfirmationPayload({ a: 1 }),
    hashConfirmationPayload({ a: 2 }),
  );
});

test("refusal reasons map to distinct, safe errors", () => {
  assert.equal(refusalError("used").code, "CONFIRMATION_TOKEN_USED");
  assert.equal(refusalError("used").statusCode, 409);
  assert.equal(refusalError("expired").code, "CONFIRMATION_TOKEN_EXPIRED");
  assert.equal(refusalError("invalid").code, "CONFIRMATION_TOKEN_INVALID");
  assert.equal(refusalError("invalid").statusCode, 403);
});

const routeSource = {
  routeRequestId: "rr-1",
  routeOptionId: "ro-1",
  journeyLegId: "leg-1",
  transportMode: "car",
  departureAt: "2026-11-13T00:40:00.000Z",
  arriveAt: "2026-11-13T01:05:00.000Z",
  originLabel: "Hotel Indonesia Kempinski",
  destinationLabel: "Jakarta Convention Center",
  destinationContextPointId: "jcc",
  timezone: "Asia/Jakarta",
};

test("a route recommendation becomes a travel block built from its stored route option", async () => {
  const store = createStore();
  const recommendation = recommendationStore({
    recommendation_type: "route",
    route_request_id: "rr-1",
    route_option_id: "ro-1",
    payload: { title: "Take the car" },
  });
  const { service, agendaCreated } = build({
    store,
    userId: "alice",
    recommendation,
    routeSource,
  });
  const request = await issue(service, "alice");
  const result = await service.runRecommendationAction({
    userId: "alice",
    tripId: TRIP,
    recommendationId: REC,
    action: "apply",
    token: request.confirmation_token,
    command,
  });
  assert.equal(result.status, "applied");
  const item = agendaCreated[0];
  assert.equal(
    item.title,
    "Travel: Hotel Indonesia Kempinski to Jakarta Convention Center (car)",
  );
  assert.equal(item.startAt, routeSource.departureAt);
  assert.equal(item.endAt, routeSource.arriveAt);
  assert.equal(item.contextPointId, "jcc");
  assert.equal(item.source, "assistant_suggestion");
  assert.equal(item.metadata.route_option_id, "ro-1");
});

test("a route recommendation whose route option is no longer valid cannot be confirmed or applied", async () => {
  const store = createStore();
  const recommendation = recommendationStore({
    recommendation_type: "route",
    route_request_id: "rr-1",
    route_option_id: "ro-1",
    payload: { title: "Take the car" },
  });
  const { service, agendaCreated } = build({
    store,
    userId: "alice",
    recommendation,
    routeSource: null,
  });
  await assert.rejects(
    issue(service, "alice"),
    (error) => error.code === "RECOMMENDATION_NOT_APPLICABLE",
  );
  assert.equal(store.rows.length, 0, "no token is issued");
  assert.equal(agendaCreated.length, 0);
});
