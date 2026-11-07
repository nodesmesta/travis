import assert from "node:assert/strict";
import test from "node:test";
import { TripContextService } from "../dist/index.js";

const context = {
  actorUserId: "user-1",
  idempotencyKey: "task03-test-key-0001",
  requestHash: "hash-1",
};

function createHarness() {
  const contextPoints = new Map();
  const agendaItems = new Map();
  const journeyLegs = new Map();
  const logs = [];
  let sequence = 1;
  const repository = {
    async getTripForUser(tripId, userId) {
      return tripId === "trip-1" && userId === "user-1"
        ? { id: tripId, userId, timezone: "Asia/Jakarta", status: "confirmed" }
        : null;
    },
    async updateTripStatus(tripId, status) {
      return { id: tripId, userId: "user-1", timezone: "Asia/Jakarta", status };
    },
    async getContextPoint(id) {
      return contextPoints.get(id) ?? null;
    },
    async createContextPoint(input) {
      const result = { id: `context-${sequence++}`, ...input };
      contextPoints.set(result.id, result);
      return result;
    },
    async updateContextPoint(id, patch) {
      const result = { ...contextPoints.get(id), ...patch };
      contextPoints.set(id, result);
      return result;
    },
    async getAgendaItem(id) {
      return agendaItems.get(id) ?? null;
    },
    async createAgendaItem(input) {
      const result = { id: `agenda-${sequence++}`, ...input };
      agendaItems.set(result.id, result);
      return result;
    },
    async updateAgendaItem(id, patch) {
      const result = { ...agendaItems.get(id), ...patch };
      agendaItems.set(id, result);
      return result;
    },
    async getJourneyLeg(id) {
      return journeyLegs.get(id) ?? null;
    },
    async updateJourneyLeg(id, patch) {
      const result = { ...journeyLegs.get(id), ...patch };
      journeyLegs.set(id, result);
      return result;
    },
    async createJourneyLeg(input) {
      const result = { id: `leg-${sequence++}`, ...input };
      journeyLegs.set(result.id, result);
      return result;
    },
  };
  const idempotency = {
    results: new Map(),
    async execute(scope, command, operation) {
      const key = `${scope}:${command.idempotencyKey}`;
      if (this.results.has(key)) return this.results.get(key);
      const result = await operation();
      this.results.set(key, result);
      return result;
    },
  };
  const activityLog = {
    append: async (entry) => logs.push(entry),
  };
  return {
    service: new TripContextService({ repository, idempotency, activityLog }),
    repository,
    logs,
  };
}

test("unresolved context returns clarification without provider work", async () => {
  const harness = createHarness();
  const result = await harness.service.createContextPoint(
    {
      tripId: "trip-1",
      type: "hotel",
      label: "Hotel near meeting",
      timezone: "Asia/Jakarta",
      source: "user_input",
    },
    context,
  );

  assert.equal(result.kind, "awaiting_clarification");
  assert.equal(result.contextPoint.resolutionStatus, "unresolved");
  assert.equal(harness.logs[0].action, "context_point.created");
});

test("agenda discovery item follows suggested to planned to confirmed", async () => {
  const harness = createHarness();
  const agenda = await harness.service.createAgendaItem(
    {
      tripId: "trip-1",
      title: "Jakarta evening event",
      type: "event",
      startAt: "2026-11-12T19:00:00+07:00",
      endAt: "2026-11-12T21:00:00+07:00",
      timezone: "Asia/Jakarta",
      source: "event_discovery",
    },
    context,
  );
  assert.equal(agenda.status, "suggested");

  const planned = await harness.service.planAgendaItem(agenda.id, {
    ...context,
    idempotencyKey: "task03-plan-key-0001",
  });
  assert.equal(planned.status, "planned");

  const confirmed = await harness.service.confirmAgendaItem(agenda.id, {
    ...context,
    idempotencyKey: "task03-confirm-key-01",
  });
  assert.equal(confirmed.status, "confirmed");

  await assert.rejects(
    harness.service.confirmAgendaItem(agenda.id, {
      ...context,
      idempotencyKey: "task03-confirm-key-02",
    }),
    (error) => error.code === "DOMAIN_STATE_INVALID",
  );
});

test("journey leg rejects unresolved context points and validates timezone", async () => {
  const harness = createHarness();
  const unresolved = await harness.service.createContextPoint(
    {
      tripId: "trip-1",
      type: "hotel",
      label: "Unresolved hotel",
      timezone: "Asia/Jakarta",
      source: "user_input",
    },
    { ...context, idempotencyKey: "task03-unresolved-01" },
  );
  const resolved = await harness.service.createContextPoint(
    {
      tripId: "trip-1",
      type: "meeting",
      label: "Meeting venue",
      timezone: "Asia/Jakarta",
      latitude: -6.2,
      longitude: 106.8,
      externalPlaceId: "here-venue",
      source: "user_input",
    },
    { ...context, idempotencyKey: "task03-resolved-0001" },
  );

  await assert.rejects(
    harness.service.createJourneyLeg(
      {
        tripId: "trip-1",
        originContextPointId: unresolved.contextPoint.id,
        destinationContextPointId: resolved.contextPoint.id,
        departureAt: "2026-11-12T07:00:00+07:00",
        arrivalDeadline: "2026-11-12T08:00:00+07:00",
      },
      { ...context, idempotencyKey: "task03-leg-invalid-01" },
    ),
    (error) => error.code === "JOURNEY_LEG_INVALID",
  );

  await assert.rejects(
    harness.service.createAgendaItem(
      {
        tripId: "trip-1",
        title: "Invalid timezone",
        type: "meeting",
        startAt: "2026-11-12T07:00:00",
        endAt: "2026-11-12T08:00:00+07:00",
        timezone: "Asia/Jakarta",
        source: "user_input",
      },
      { ...context, idempotencyKey: "task03-timezone-01" },
    ),
    (error) => error.code === "DATETIME_TIMEZONE_REQUIRED",
  );
});
