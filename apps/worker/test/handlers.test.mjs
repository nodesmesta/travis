import assert from "node:assert/strict";
import test from "node:test";
import { runHandler } from "../dist/handlers.js";
import { runScheduleTick } from "../dist/scheduler.js";
import { toJobError } from "../dist/errors.js";
import { ExternalDataError } from "@travelflow/integrations";
import { parseJobPayload } from "@travelflow/domain";

// Everything here is a FIXTURE: in-memory data, a fake alert writer, and a fake mobility service.

const TRIP = "00000000-0000-0000-0000-0000000000a1";
const LEG = "00000000-0000-0000-0000-0000000000b1";
const AGENDA = "00000000-0000-0000-0000-0000000000c1";
const POINT = "00000000-0000-0000-0000-0000000000d1";
const ORIGIN = "00000000-0000-0000-0000-0000000000d2";
const SOURCE = "00000000-0000-0000-0000-0000000000e1";
const NOW = new Date("2026-11-12T00:00:00.000Z");
const at = (minutes) =>
  new Date(NOW.getTime() + minutes * 60_000).toISOString();

const jobRow = (type, payload, overrides = {}) => ({
  id: "00000000-0000-0000-0000-000000000501",
  trip_id: TRIP,
  user_id: "00000000-0000-0000-0000-000000000009",
  job_type: type,
  payload,
  status: "running",
  correlation_id: "corr-test",
  parent_job_id: null,
  ...overrides,
});

const leg = (overrides = {}) => ({
  id: LEG,
  trip_id: TRIP,
  status: "planned",
  departure_at: at(60),
  arrival_deadline: at(120),
  origin_context_point_id: ORIGIN,
  destination_context_point_id: POINT,
  origin_label: "Fixture Hotel",
  destination_label: "Fixture Hall",
  timezone: "Asia/Jakarta",
  origin_resolved: true,
  destination_resolved: true,
  ...overrides,
});

const traffic = (overrides = {}) => ({
  id: "t1",
  source_id: SOURCE,
  provider: "here_traffic_v7",
  traffic_level: "high",
  average_jam_factor: 7.5,
  max_jam_factor: 9,
  closed_segment_count: 0,
  incident_count: 1,
  segment_count: 30,
  retrieved_at: at(-2),
  expires_at: at(8),
  ...overrides,
});

function fakeData({
  trip = {
    id: TRIP,
    user_id: "u",
    timezone: "Asia/Jakarta",
    status: "confirmed",
  },
  legs = [leg()],
  agenda = [],
  trafficSnapshot = traffic(),
  weatherSnapshot = null,
} = {}) {
  return {
    async trip() {
      return trip;
    },
    async schedulableTrips() {
      return [trip];
    },
    async legs(_tripId, onlyId) {
      return onlyId ? legs.filter((l) => l.id === onlyId) : legs;
    },
    async agenda(_tripId, contextPointId) {
      return contextPointId
        ? agenda.filter((a) => a.context_point_id === contextPointId)
        : agenda;
    },
    async latestTraffic() {
      return trafficSnapshot;
    },
    async latestWeather() {
      return weatherSnapshot;
    },
    async providerRequestIds() {
      return ["req-1"];
    },
  };
}

function fakeAlerts() {
  const store = new Map();
  const writer = {
    calls: 0,
    async create({ tripId, jobId, draft }) {
      writer.calls += 1;
      const key = `${tripId}:${draft.deduplication_key}`;
      if (store.has(key))
        return { created: false, refreshed: false, alertId: store.get(key) };
      store.set(key, `alert-${store.size + 1}`);
      return {
        created: true,
        refreshed: false,
        alertId: store.get(key),
        jobId,
      };
    },
    rows: store,
  };
  return writer;
}

const context = (job) => ({ job, assertActive() {} });

function deps(overrides = {}) {
  return {
    data: fakeData(),
    alerts: fakeAlerts(),
    mobility: {
      async weatherFor() {
        throw new Error("not used");
      },
      async refreshTraffic() {
        throw new Error("not used");
      },
    },
    contextPoint: async () => null,
    now: () => NOW,
    ...overrides,
  };
}

test("evaluate_alerts creates a traffic alert from a fresh snapshot, and a second evaluation adds no row", async () => {
  const d = deps();
  const job = jobRow("evaluate_alerts", {
    trigger_job_id: LEG,
    journey_leg_id: LEG,
    context_point_id: null,
  });
  const parsed = parseJobPayload(job.job_type, job.payload);
  const first = await runHandler(d, context(job), parsed);
  assert.equal(first.result.outcome, "alert_created");
  assert.equal(first.result.alerts_created, 1);
  const second = await runHandler(d, context(job), parsed);
  assert.equal(second.result.outcome, "alert_deduplicated");
  assert.equal(d.alerts.rows.size, 1, "one record for the same condition");
  assert.equal(d.alerts.calls, 2);
});

test("an expired snapshot fails the job with JOB_PROVIDER_DATA_EXPIRED and writes no alert", async () => {
  const d = deps({
    data: fakeData({ trafficSnapshot: traffic({ expires_at: at(-1) }) }),
  });
  const job = jobRow("evaluate_alerts", {
    trigger_job_id: LEG,
    journey_leg_id: LEG,
    context_point_id: null,
  });
  await assert.rejects(
    runHandler(d, context(job), parseJobPayload(job.job_type, job.payload)),
    (error) =>
      error.code === "JOB_PROVIDER_DATA_EXPIRED" &&
      error.details.outcome === "blocked",
  );
  assert.equal(d.alerts.calls, 0);
});

test("a missing snapshot fails the job as a precondition failure", async () => {
  const d = deps({ data: fakeData({ trafficSnapshot: null }) });
  const job = jobRow("evaluate_alerts", {
    trigger_job_id: LEG,
    journey_leg_id: LEG,
    context_point_id: null,
  });
  await assert.rejects(
    runHandler(d, context(job), parseJobPayload(job.job_type, job.payload)),
    (error) => error.code === "JOB_PRECONDITION_FAILED",
  );
  assert.equal(d.alerts.calls, 0);
});

test("a low traffic level ends as no_action and writes nothing", async () => {
  const d = deps({
    data: fakeData({ trafficSnapshot: traffic({ traffic_level: "low" }) }),
  });
  const job = jobRow("evaluate_alerts", {
    trigger_job_id: LEG,
    journey_leg_id: LEG,
    context_point_id: null,
  });
  const outcome = await runHandler(
    d,
    context(job),
    parseJobPayload(job.job_type, job.payload),
  );
  assert.equal(outcome.result.outcome, "no_action");
  assert.equal(d.alerts.calls, 0);
});

test("weather evaluation covers outdoor agenda items at the location and skips indoor ones", async () => {
  const agenda = (id, exposure) => ({
    id,
    trip_id: TRIP,
    title: "Fixture Walk",
    status: "planned",
    start_at: at(120),
    end_at: at(240),
    timezone: "Asia/Jakarta",
    context_point_id: POINT,
    context_label: "Fixture Garden",
    context_resolved: true,
    exposure,
  });
  const hourly = {
    at: at(120),
    granularity: "hourly",
    temperature_c: 27,
    precipitation_probability: 0.9,
    precipitation_mm: 5,
    wind_speed_ms: 4,
    visibility_m: 8000,
    condition_id: 502,
    condition: "Rain",
    description: "heavy intensity rain",
  };
  const weatherSnapshot = {
    id: "w1",
    source_id: SOURCE,
    provider: "openweather_free_2_5",
    context_point_id: POINT,
    timezone: "Asia/Jakarta",
    observed_at: at(-5),
    current: null,
    hourly: [hourly],
    daily: [],
    retrieved_at: at(-2),
    expires_at: at(28),
  };
  const d = deps({
    data: fakeData({
      agenda: [agenda(AGENDA, "outdoor"), agenda("indoor-one", "indoor")],
      weatherSnapshot,
    }),
  });
  const job = jobRow("evaluate_alerts", {
    trigger_job_id: LEG,
    journey_leg_id: null,
    context_point_id: POINT,
  });
  const outcome = await runHandler(
    d,
    context(job),
    parseJobPayload(job.job_type, job.payload),
  );
  assert.equal(outcome.result.outcome, "alert_created");
  assert.equal(
    outcome.result.evaluated.length,
    1,
    "the indoor item is not evaluated",
  );
  assert.equal(outcome.result.evaluated[0].subject.id, AGENDA);
});

test("departure_reminder creates one reminder, and the same reminder is not stored twice", async () => {
  const d = deps();
  const job = jobRow("departure_reminder", {
    journey_leg_id: LEG,
    departure_at: at(60),
    scheduled_at: at(30),
    policy_version: "alerts-v1",
  });
  const parsed = parseJobPayload(job.job_type, job.payload);
  const first = await runHandler(d, context(job), parsed);
  const second = await runHandler(d, context(job), parsed);
  assert.equal(first.result.outcome, "alert_created");
  assert.equal(second.result.outcome, "alert_deduplicated");
  assert.equal(d.alerts.rows.size, 1);
});

test("departure_reminder for a moved departure creates nothing", async () => {
  const d = deps({ data: fakeData({ legs: [leg({ departure_at: at(90) })] }) });
  const job = jobRow("departure_reminder", {
    journey_leg_id: LEG,
    departure_at: at(60),
    scheduled_at: at(30),
    policy_version: "alerts-v1",
  });
  const outcome = await runHandler(
    d,
    context(job),
    parseJobPayload(job.job_type, job.payload),
  );
  assert.equal(outcome.result.outcome, "no_action");
  assert.deepEqual(outcome.result.evaluated[0].reason_codes, [
    "SCHEDULE_CHANGED",
  ]);
  assert.equal(d.alerts.calls, 0);
});

test("a job for a trip that is no longer confirmed or active fails its precondition", async () => {
  const d = deps({
    data: fakeData({
      trip: { id: TRIP, user_id: "u", timezone: "UTC", status: "completed" },
    }),
  });
  const job = jobRow("departure_reminder", {
    journey_leg_id: LEG,
    departure_at: at(60),
    scheduled_at: at(30),
    policy_version: "alerts-v1",
  });
  await assert.rejects(
    runHandler(d, context(job), parseJobPayload(job.job_type, job.payload)),
    (error) => error.code === "JOB_PRECONDITION_FAILED",
  );
});

test("refresh_traffic: a provider failure is a failed job with no follow-up and no cached substitute", async () => {
  const d = deps({
    mobility: {
      async weatherFor() {
        throw new Error("unused");
      },
      async refreshTraffic() {
        throw new ExternalDataError(
          "EXTERNAL_CONFIGURATION_MISSING",
          "here",
          "HERE_API_KEY is not configured.",
          503,
        );
      },
    },
  });
  const job = jobRow("refresh_traffic", { journey_leg_id: LEG });
  await assert.rejects(
    runHandler(d, context(job), parseJobPayload(job.job_type, job.payload)),
    (error) => {
      const mapped = toJobError(error);
      return (
        mapped.code === "JOB_PROVIDER_ERROR" &&
        mapped.details.provider_error_code === "EXTERNAL_CONFIGURATION_MISSING"
      );
    },
  );
});

test("refresh_traffic success queues exactly one evaluation under the same correlation id", async () => {
  const d = deps({
    mobility: {
      async weatherFor() {
        throw new Error("unused");
      },
      async refreshTraffic() {
        return {
          items: [
            {
              id: "t9",
              source_id: SOURCE,
              provider: "here_traffic_v7",
              cache_status: "miss",
              traffic_level: "high",
              retrieved_at: at(0),
              expires_at: at(10),
            },
          ],
        };
      },
    },
  });
  const job = jobRow("refresh_traffic", { journey_leg_id: LEG });
  const outcome = await runHandler(
    d,
    context(job),
    parseJobPayload(job.job_type, job.payload),
  );
  assert.equal(outcome.result.outcome, "snapshot_refreshed");
  assert.deepEqual(outcome.providerRequestIds, ["req-1"]);
  assert.equal(outcome.followUps.length, 1);
  assert.equal(outcome.followUps[0].jobType, "evaluate_alerts");
  assert.equal(outcome.followUps[0].correlationId, "corr-test");
  assert.equal(
    outcome.followUps[0].idempotencyKey,
    `evaluate_alerts:${job.id}`,
  );
  assert.deepEqual(outcome.followUps[0].payload, {
    trigger_job_id: job.id,
    journey_leg_id: LEG,
    context_point_id: null,
  });
});

test("refresh_weather rejects an unresolved or foreign context point", async () => {
  const job = jobRow("refresh_weather", { context_point_id: POINT });
  const parsed = parseJobPayload(job.job_type, job.payload);
  await assert.rejects(
    runHandler(deps({ contextPoint: async () => null }), context(job), parsed),
    (e) => e.code === "JOB_CONTEXT_NOT_FOUND",
  );
  await assert.rejects(
    runHandler(
      deps({
        contextPoint: async () => ({
          id: POINT,
          tripId: "other-trip",
          label: "x",
          status: "active",
          resolutionStatus: "resolved",
          latitude: 1,
          longitude: 1,
        }),
      }),
      context(job),
      parsed,
    ),
    (e) => e.code === "JOB_CONTEXT_NOT_FOUND",
  );
  await assert.rejects(
    runHandler(
      deps({
        contextPoint: async () => ({
          id: POINT,
          tripId: TRIP,
          label: "Somewhere",
          status: "active",
          resolutionStatus: "unresolved",
          latitude: null,
          longitude: null,
        }),
      }),
      context(job),
      parsed,
    ),
    (e) => e.code === "JOB_CONTEXT_UNRESOLVED",
  );
});

test("a handler stops before writing when the lease was lost", async () => {
  const d = deps();
  const job = jobRow("departure_reminder", {
    journey_leg_id: LEG,
    departure_at: at(60),
    scheduled_at: at(30),
    policy_version: "alerts-v1",
  });
  const lost = {
    job,
    assertActive() {
      throw Object.assign(new Error("lost"), { code: "JOB_INTERRUPTED" });
    },
  };
  await assert.rejects(
    runHandler(d, lost, parseJobPayload(job.job_type, job.payload)),
    (e) => e.code === "JOB_INTERRUPTED",
  );
  assert.equal(d.alerts.calls, 0);
});

// --- scheduler -----------------------------------------------------------------

function fakeJobs() {
  const keys = new Set();
  const jobs = {
    created: [],
    cancelled: [],
    queued: [],
    async enqueue(job) {
      if (keys.has(job.idempotencyKey)) return false;
      keys.add(job.idempotencyKey);
      jobs.created.push(job);
      return true;
    },
    async cancelQueued(id, reason) {
      jobs.cancelled.push({ id, reason });
      return true;
    },
    async queuedReminders() {
      return jobs.queued;
    },
  };
  return jobs;
}

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };

test("the scheduler creates each job once, even when two passes run at the same moment", async () => {
  const jobs = fakeJobs();
  const base = {
    data: fakeData({ legs: [leg({ departure_at: at(120) })] }),
    jobs,
    logger: quietLogger,
    now: () => NOW,
  };
  const first = await runScheduleTick(base);
  const second = await runScheduleTick(base);
  assert.equal(first.created, 2, "a reminder and a traffic refresh");
  assert.equal(second.created, 0);
  assert.equal(second.existing, 2);
  const reminder = jobs.created.find((j) => j.jobType === "departure_reminder");
  assert.equal(reminder.runAt, at(90));
  assert.ok(reminder.correlationId.startsWith("sched-"));
});

test("the scheduler cancels a queued reminder whose departure time changed", async () => {
  const jobs = fakeJobs();
  jobs.queued.push({
    id: "old",
    job_type: "departure_reminder",
    payload: { journey_leg_id: LEG, departure_at: at(30) },
  });
  const result = await runScheduleTick({
    data: fakeData({ legs: [leg({ departure_at: at(120) })] }),
    jobs,
    logger: quietLogger,
    now: () => NOW,
  });
  assert.equal(result.cancelled, 1);
  assert.deepEqual(jobs.cancelled, [
    { id: "old", reason: "DEPARTURE_CHANGED" },
  ]);
});

test("the scheduler plans nothing for a completed trip and reports a failing trip instead of hiding it", async () => {
  const jobs = fakeJobs();
  const done = await runScheduleTick({
    data: fakeData({
      trip: { id: TRIP, user_id: "u", timezone: "UTC", status: "completed" },
    }),
    jobs,
    logger: quietLogger,
    now: () => NOW,
  });
  assert.equal(done.created, 0);
  const broken = fakeData();
  broken.legs = async () => {
    throw new Error("database offline");
  };
  const errors = [];
  const result = await runScheduleTick({
    data: broken,
    jobs,
    logger: { ...quietLogger, error: (event) => errors.push(event) },
    now: () => NOW,
  });
  assert.equal(result.failed_trips, 1);
  assert.deepEqual(errors, ["scheduler.trip_failed"]);
});
