import assert from "node:assert/strict";
import test from "node:test";
import { AlertService } from "../dist/services/alert-service.js";
import { alertDto, jobDto } from "../dist/services/alert-serializers.js";
import { AppError } from "../dist/errors.js";

// All data below is FIXTURE data for unit tests, not provider output.
const TRIP = "00000000-0000-0000-0000-0000000000a1";
const USER = "00000000-0000-0000-0000-0000000000b1";
const SOURCE = "00000000-0000-0000-0000-0000000000c1";
const NOW = new Date("2026-11-12T00:00:00.000Z");
const at = (minutes) =>
  new Date(NOW.getTime() + minutes * 60_000).toISOString();

const alert = (n, overrides = {}) => ({
  id: `00000000-0000-0000-0000-00000000010${n}`,
  trip_id: TRIP,
  agenda_item_id: null,
  journey_leg_id: "leg",
  job_id: null,
  alert_type: "traffic_risk",
  severity: "medium",
  title: `Fixture alert ${n}`,
  factual_summary: "Fixture fact.",
  recommendation_summary: "Fixture advice.",
  source_ids: [SOURCE],
  retrieved_at: at(-3),
  expires_at: at(7),
  triggered_at: at(-3),
  deduplication_key: `key-${n}-xxxxxxxx`,
  policy_version: "alerts-v1",
  reason_codes: ["TRAFFIC_LEVEL_MEDIUM"],
  status: "unread",
  read_at: null,
  dismissed_at: null,
  metadata: { internal: true },
  created_at: at(-3),
  updated_at: at(-3),
  ...overrides,
});

const source = {
  id: SOURCE,
  trip_id: TRIP,
  kind: "provider",
  provider: "here_traffic_v7",
  url: null,
  title: "Fixture source",
  retrieved_at: at(-3),
  freshness: "fresh",
  expires_at: at(7),
  observed_for: null,
  content_hash: null,
  metadata: { audit_url: "https://secret.example/?apiKey=hidden" },
  created_at: at(-3),
};

const job = (n, status, overrides = {}) => ({
  id: `00000000-0000-0000-0000-00000000020${n}`,
  trip_id: TRIP,
  user_id: USER,
  job_type: "refresh_traffic",
  payload: { journey_leg_id: "leg" },
  status,
  idempotency_key: `key-${n}-xxxxxxxxxxxxxx`,
  run_at: at(-1),
  attempts: status === "queued" ? 0 : 1,
  lease_owner: "worker-secret-id",
  lease_expires_at: null,
  heartbeat_at: null,
  parent_job_id: null,
  correlation_id: `corr-${n}`,
  execution_id: null,
  created_by: null,
  result_summary: null,
  error_code: status === "failed" ? "JOB_PROVIDER_ERROR" : null,
  error_message: status === "failed" ? "HERE did not answer in time." : null,
  provider_request_ids: ["internal-id"],
  started_at: null,
  completed_at: null,
  created_at: at(-2),
  updated_at: at(-1),
  ...overrides,
});

function service({
  alerts = [],
  jobs = [],
  active = new Set(),
  tripOwner = true,
  inserted = [],
} = {}) {
  const log = [];
  const rows = [...alerts];
  return {
    log,
    inserted,
    instance: new AlertService({
      now: () => NOW,
      trips: {
        getTripRowForUser: async () => (tripOwner ? { id: TRIP } : null),
      },
      alerts: {
        listForTrip: async () => rows,
        get: async (_trip, id) => rows.find((row) => row.id === id) ?? null,
        transition: async (_trip, id, to) => {
          const row = rows.find((entry) => entry.id === id);
          const allowed =
            to === "read"
              ? row.status === "unread"
              : row.status !== "dismissed";
          if (!allowed) return false;
          row.status = to;
          if (to === "read") row.read_at = NOW.toISOString();
          else row.dismissed_at = NOW.toISOString();
          return true;
        },
        sourcesByIds: async () => [source],
      },
      jobs: {
        listForTrip: async () => jobs,
        get: async (_trip, id) => jobs.find((row) => row.id === id) ?? null,
        parentsWithActiveRerun: async (_trip, ids) =>
          new Set(ids.filter((id) => active.has(id))),
        insertRerun: async (input) => {
          inserted.push(input);
          return job(9, "queued", {
            id: "new-job",
            parent_job_id: input.parentJobId,
            correlation_id: input.correlationId,
          });
        },
      },
      idempotency: {
        execute: async (_scope, _command, operation) => operation(),
      },
      activityLog: { append: async (entry) => log.push(entry) },
    }),
  };
}

const command = {
  actorUserId: USER,
  idempotencyKey: "validator-key-0000001",
  requestHash: "hash",
};
const list = (instance, extra = {}) =>
  instance.list({
    tripId: TRIP,
    userId: USER,
    requestId: "req",
    includeDismissed: false,
    includeExpired: false,
    ...extra,
  });

test("the alert view separates facts from advice, shows sources with retrieval time, and hides internals", () => {
  const dto = alertDto(alert(1), new Map([[SOURCE, source]]), NOW);
  assert.equal(dto.factual_summary, "Fixture fact.");
  assert.equal(dto.recommendation_summary, "Fixture advice.");
  assert.equal(dto.freshness, "fresh");
  assert.equal(dto.sources.length, 1);
  assert.equal(dto.sources[0].provider, "here_traffic_v7");
  assert.equal(dto.sources[0].retrieved_at, at(-3));
  assert.equal(
    dto.sources[0].metadata,
    undefined,
    "provider audit metadata is not exposed",
  );
  assert.equal(dto.metadata, undefined);
  assert.equal(dto.deduplication_key, undefined);
  assert.equal(
    alertDto(alert(1, { expires_at: at(0) }), new Map(), NOW).freshness,
    "expired",
    "expiry at the current instant counts as expired",
  );
});

test("the job view hides the payload, the lease owner, and provider request ids", () => {
  const dto = jobDto(job(1, "failed"), true);
  assert.equal(dto.payload, undefined);
  assert.equal(dto.lease_owner, undefined);
  assert.equal(dto.provider_request_ids, undefined);
  assert.equal(dto.error_code, "JOB_PROVIDER_ERROR");
  assert.equal(dto.can_rerun, true);
});

test("the list leaves out expired and dismissed alerts and says how many", async () => {
  const { instance } = service({
    alerts: [
      alert(1),
      alert(2, { expires_at: at(-1) }),
      alert(3, { status: "dismissed", dismissed_at: at(-1) }),
      alert(4, {
        status: "dismissed",
        dismissed_at: at(-1),
        expires_at: at(-5),
      }),
    ],
  });
  const result = await list(instance);
  assert.deepEqual(
    result.items.map((item) => item.title),
    ["Fixture alert 1"],
  );
  assert.equal(result.hidden_expired_count, 1);
  assert.equal(result.hidden_dismissed_count, 2);
  const everything = await list(instance, {
    includeDismissed: true,
    includeExpired: true,
  });
  assert.equal(everything.items.length, 4);
  const expired = everything.items.find(
    (item) => item.title === "Fixture alert 2",
  );
  assert.equal(expired.freshness, "expired");
});

test("a trip the user does not own is a 404, never data", async () => {
  const { instance } = service({ alerts: [alert(1)], tripOwner: false });
  await assert.rejects(
    list(instance),
    (error) => error instanceof AppError && error.statusCode === 404,
  );
  await assert.rejects(
    instance.changeState(
      {
        tripId: TRIP,
        alertId: alert(1).id,
        userId: USER,
        requestId: "r",
        to: "read",
      },
      command,
    ),
    (error) => error.statusCode === 404,
  );
  await assert.rejects(
    instance.rerunJob(
      {
        tripId: TRIP,
        jobId: job(1, "failed").id,
        userId: USER,
        requestId: "r",
      },
      command,
    ),
    (error) => error.statusCode === 404,
  );
});

test("read and dismiss only move forward and are logged once", async () => {
  const { instance, log } = service({ alerts: [alert(1)] });
  const input = {
    tripId: TRIP,
    alertId: alert(1).id,
    userId: USER,
    requestId: "r",
  };
  const read = await instance.changeState({ ...input, to: "read" }, command);
  assert.equal(read.alert.status, "read");
  await instance.changeState({ ...input, to: "read" }, command);
  assert.equal(
    log.filter((entry) => entry.action === "alert.read").length,
    1,
    "the repeated call changed nothing and logged nothing",
  );
  const dismissed = await instance.changeState(
    { ...input, to: "dismissed" },
    command,
  );
  assert.equal(dismissed.alert.status, "dismissed");
  const readAfter = await instance.changeState(
    { ...input, to: "read" },
    command,
  );
  assert.equal(readAfter.alert.status, "dismissed");
  await assert.rejects(
    instance.changeState(
      { ...input, alertId: "00000000-0000-0000-0000-00000000ffff", to: "read" },
      command,
    ),
    (error) => error.statusCode === 404,
  );
});

test("rerun creates a job pointing at the parent and refuses jobs that are not failed or interrupted", async () => {
  const failed = job(1, "failed");
  const { instance, inserted, log } = service({
    jobs: [
      failed,
      job(2, "succeeded"),
      job(3, "queued"),
      job(4, "interrupted", { error_code: "JOB_INTERRUPTED" }),
    ],
  });
  const input = (jobId) => ({
    tripId: TRIP,
    jobId,
    userId: USER,
    requestId: "req-rerun",
  });
  const result = await instance.rerunJob(input(failed.id), command);
  assert.equal(result.job.parent_job_id, failed.id);
  assert.equal(result.job.status, "queued");
  assert.equal(inserted[0].parentJobId, failed.id);
  assert.equal(inserted[0].correlationId, "req-rerun");
  assert.equal(
    inserted[0].idempotencyKey,
    `rerun:${failed.id}:${command.idempotencyKey}`,
  );
  assert.equal(inserted[0].jobType, "refresh_traffic");
  assert.equal(log[0].action, "job.rerun_requested");
  await instance.rerunJob(input(job(4, "interrupted").id), command);
  for (const [n, status] of [
    [2, "succeeded"],
    [3, "queued"],
  ]) {
    await assert.rejects(
      instance.rerunJob(input(job(n, status).id), command),
      (error) =>
        error.statusCode === 409 && error.code === "JOB_RERUN_NOT_ALLOWED",
    );
  }
});

test("a job that already has an active rerun cannot be rerun again, and can_rerun says so", async () => {
  const failed = job(1, "failed");
  const { instance } = service({
    jobs: [failed],
    active: new Set([failed.id]),
  });
  await assert.rejects(
    instance.rerunJob(
      { tripId: TRIP, jobId: failed.id, userId: USER, requestId: "r" },
      command,
    ),
    (error) =>
      error.statusCode === 409 && error.code === "JOB_RERUN_ALREADY_ACTIVE",
  );
  const listed = await instance.listJobs({
    tripId: TRIP,
    userId: USER,
    requestId: "r",
    limit: 10,
  });
  assert.equal(listed.items[0].can_rerun, false);
});
