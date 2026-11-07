import assert from "node:assert/strict";
import test from "node:test";
import { JobRunner } from "../dist/runner.js";
import { toJobError } from "../dist/errors.js";
import { loadWorkerConfig } from "../dist/config.js";
import { ExternalDataError } from "@travelflow/integrations";
import { JobError } from "@travelflow/domain";

// Everything here is a FIXTURE: an in-memory job store and handler. No database, no provider.

const TRIP = "00000000-0000-0000-0000-0000000000a1";
const LEG = "00000000-0000-0000-0000-0000000000b1";

function job(n, overrides = {}) {
  return {
    id: `00000000-0000-0000-0000-00000000010${n}`,
    trip_id: TRIP,
    user_id: "u",
    job_type: "refresh_traffic",
    payload: { journey_leg_id: LEG },
    status: "running",
    idempotency_key: `key-${n}-xxxxxxxxxxxx`,
    run_at: new Date().toISOString(),
    attempts: 1,
    lease_owner: "w1",
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    heartbeat_at: new Date().toISOString(),
    parent_job_id: null,
    correlation_id: `corr-${n}`,
    execution_id: `00000000-0000-0000-0000-00000000020${n}`,
    created_by: null,
    result_summary: null,
    error_code: null,
    error_message: null,
    provider_request_ids: [],
    started_at: new Date().toISOString(),
    completed_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function fakeLogger() {
  const events = [];
  const write =
    (level) =>
    (event, metadata = {}) =>
      events.push({ level, event, ...metadata });
  return {
    events,
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
  };
}

function fakeStore({
  queue = [],
  heartbeat = async () => true,
  complete = async () => true,
  enqueue = async () => true,
} = {}) {
  const store = {
    queue: [...queue],
    claimCalls: [],
    completed: [],
    enqueued: [],
    reclaimed: [],
    async claim(workerId, limit, leaseSeconds) {
      store.claimCalls.push({ workerId, limit, leaseSeconds });
      return store.queue.splice(0, limit);
    },
    async heartbeat(...args) {
      return heartbeat(...args);
    },
    async complete(input) {
      store.completed.push(input);
      return complete(input);
    },
    async reclaimExpired() {
      return store.reclaimed.splice(0);
    },
    async enqueue(input) {
      store.enqueued.push(input);
      return enqueue(input);
    },
  };
  return store;
}

const settings = {
  workerId: "w1",
  concurrency: 2,
  pollIntervalMs: 20,
  leaseSeconds: 60,
  heartbeatIntervalMs: 15,
  jobTimeoutMs: 500,
  shutdownGraceMs: 200,
};

const outcome = (extra = {}) => ({
  result: { outcome: "snapshot_refreshed" },
  providerRequestIds: [],
  followUps: [],
  ...extra,
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function drain(runner) {
  while (runner.activeJobs > 0) await sleep(5);
}

test("the runner never runs more jobs at once than the concurrency limit, and claims only the free capacity", async () => {
  const store = fakeStore({ queue: [job(1), job(2), job(3), job(4), job(5)] });
  let running = 0;
  let peak = 0;
  const runner = new JobRunner({
    settings,
    store,
    logger: fakeLogger(),
    handle: async () => {
      running += 1;
      peak = Math.max(peak, running);
      await sleep(40);
      running -= 1;
      return outcome();
    },
  });
  assert.equal(await runner.pollOnce(), 2);
  assert.equal(
    await runner.pollOnce(),
    0,
    "no free capacity while two jobs are running",
  );
  assert.deepEqual(
    store.claimCalls.map((call) => call.limit),
    [2],
  );
  await drain(runner);
  assert.equal(await runner.pollOnce(), 2);
  await drain(runner);
  assert.equal(await runner.pollOnce(), 1);
  await drain(runner);
  assert.equal(peak, 2);
  assert.equal(store.completed.length, 5);
  assert.equal(runner.counters.succeeded, 5);
});

test("a throwing handler records the job as failed with an error code, and nothing runs it again", async () => {
  const store = fakeStore({ queue: [job(1)] });
  let calls = 0;
  const logger = fakeLogger();
  const runner = new JobRunner({
    settings,
    store,
    logger,
    handle: async () => {
      calls += 1;
      throw new ExternalDataError(
        "EXTERNAL_PROVIDER_TIMEOUT",
        "here",
        "HERE did not answer in time.",
        504,
        true,
      );
    },
  });
  await runner.pollOnce();
  await drain(runner);
  await runner.pollOnce();
  await drain(runner);
  assert.equal(calls, 1, "no automatic retry");
  assert.equal(store.completed.length, 1);
  const done = store.completed[0];
  assert.equal(done.status, "failed");
  assert.equal(done.errorCode, "JOB_PROVIDER_ERROR");
  assert.equal(done.result.provider_error_code, "EXTERNAL_PROVIDER_TIMEOUT");
  assert.equal(done.result.outcome, "failed");
  assert.equal(runner.counters.failed, 1);
  const finished = logger.events.find((e) => e.event === "job.finished");
  assert.equal(finished.status, "failed");
  assert.equal(finished.correlation_id, "corr-1");
  assert.equal(finished.job_id, job(1).id);
  assert.equal(finished.execution_id, job(1).execution_id);
});

test("an invalid payload fails the job before any handler runs", async () => {
  const store = fakeStore({
    queue: [job(1, { payload: { journey_leg_id: "not-a-uuid" } })],
  });
  let calls = 0;
  const runner = new JobRunner({
    settings,
    store,
    logger: fakeLogger(),
    handle: async () => {
      calls += 1;
      return outcome();
    },
  });
  await runner.pollOnce();
  await drain(runner);
  assert.equal(calls, 0);
  assert.equal(store.completed[0].status, "failed");
  assert.equal(store.completed[0].errorCode, "JOB_PAYLOAD_INVALID");
});

test("a job that outlives the timeout fails with JOB_TIMEOUT and its late side effects are blocked", async () => {
  const store = fakeStore({ queue: [job(1)] });
  let lateError = null;
  const runner = new JobRunner({
    settings: { ...settings, jobTimeoutMs: 40 },
    store,
    logger: fakeLogger(),
    handle: async (_parsed, context) => {
      await sleep(120);
      try {
        context.assertActive();
      } catch (error) {
        lateError = error;
        throw error;
      }
      return outcome();
    },
  });
  await runner.pollOnce();
  await drain(runner);
  assert.equal(store.completed[0].status, "failed");
  assert.equal(store.completed[0].errorCode, "JOB_TIMEOUT");
  await sleep(150);
  assert.ok(lateError instanceof JobError);
  assert.equal(lateError.code, "JOB_TIMEOUT");
});

test("a refused heartbeat abandons the job: it is not recorded as a success", async () => {
  const store = fakeStore({ queue: [job(1)], heartbeat: async () => false });
  const logger = fakeLogger();
  const runner = new JobRunner({
    settings,
    store,
    logger,
    handle: async (_parsed, context) => {
      await sleep(60);
      context.assertActive();
      return outcome();
    },
  });
  await runner.pollOnce();
  await drain(runner);
  assert.equal(
    store.completed.length,
    0,
    "nothing is written for a job whose lease is gone",
  );
  assert.equal(runner.counters.succeeded, 0);
  assert.equal(runner.counters.abandoned, 1);
  assert.ok(logger.events.some((e) => e.event === "job.lease_lost"));
  assert.ok(logger.events.some((e) => e.event === "job.abandoned"));
});

test("when the database refuses the completion, the job is not counted as a success", async () => {
  const store = fakeStore({ queue: [job(1)], complete: async () => false });
  const logger = fakeLogger();
  const runner = new JobRunner({
    settings,
    store,
    logger,
    handle: async () => outcome(),
  });
  await runner.pollOnce();
  await drain(runner);
  assert.equal(runner.counters.succeeded, 0);
  assert.equal(runner.counters.abandoned, 1);
  assert.ok(logger.events.some((e) => e.event === "job.completion_rejected"));
});

test("expired leases found by a poll are logged as interrupted with their correlation data", async () => {
  const store = fakeStore();
  store.reclaimed.push(
    job(7, { status: "interrupted", error_code: "JOB_INTERRUPTED" }),
  );
  const logger = fakeLogger();
  const runner = new JobRunner({
    settings,
    store,
    logger,
    handle: async () => outcome(),
  });
  await runner.pollOnce();
  assert.equal(runner.counters.interrupted, 1);
  const event = logger.events.find((e) => e.event === "job.interrupted");
  assert.equal(event.level, "error");
  assert.equal(event.correlation_id, "corr-7");
  assert.equal(event.error_code, "JOB_INTERRUPTED");
});

test("follow-up jobs are queued before the result is recorded, and a failed enqueue fails the job", async () => {
  const followUp = {
    tripId: TRIP,
    userId: "u",
    jobType: "evaluate_alerts",
    payload: {},
    idempotencyKey: "evaluate_alerts:x",
    runAt: new Date().toISOString(),
    correlationId: "corr-1",
  };
  const order = [];
  const store = fakeStore({
    queue: [job(1)],
    enqueue: async () => {
      order.push("enqueue");
      return true;
    },
    complete: async () => {
      order.push("complete");
      return true;
    },
  });
  const runner = new JobRunner({
    settings,
    store,
    logger: fakeLogger(),
    handle: async () => outcome({ followUps: [followUp] }),
  });
  await runner.pollOnce();
  await drain(runner);
  assert.deepEqual(order, ["enqueue", "complete"]);

  const failing = fakeStore({
    queue: [job(2)],
    enqueue: async () => {
      throw new Error("db down");
    },
  });
  const second = new JobRunner({
    settings,
    store: failing,
    logger: fakeLogger(),
    handle: async () => outcome({ followUps: [followUp] }),
  });
  await second.pollOnce();
  await drain(second);
  assert.equal(failing.completed[0].status, "failed");
  assert.equal(failing.completed[0].errorCode, "JOB_INTERNAL_ERROR");
});

test("stop waits for running jobs and reports the ones that outlast the grace period", async () => {
  const store = fakeStore({ queue: [job(1)] });
  const finishing = new JobRunner({
    settings,
    store,
    logger: fakeLogger(),
    handle: async () => {
      await sleep(40);
      return outcome();
    },
  });
  await finishing.pollOnce();
  assert.deepEqual(await finishing.stop(), []);
  assert.equal(store.completed.length, 1);

  const slowStore = fakeStore({ queue: [job(2)] });
  const slow = new JobRunner({
    settings: { ...settings, shutdownGraceMs: 30 },
    store: slowStore,
    logger: fakeLogger(),
    handle: async () => {
      await sleep(200);
      return outcome();
    },
  });
  await slow.pollOnce();
  assert.deepEqual(await slow.stop(), [job(2).id]);
  assert.equal(await slow.pollOnce(), 0, "a stopping runner claims nothing");
  await drain(slow);
});

test("errors map to stable job error codes without leaking unknown messages", () => {
  assert.equal(
    toJobError(new Error("secret stack detail")).message,
    "The job failed unexpectedly.",
  );
  assert.equal(toJobError(new Error("x")).code, "JOB_INTERNAL_ERROR");
  const provider = toJobError(
    new ExternalDataError(
      "EXTERNAL_CONFIGURATION_MISSING",
      "here",
      "HERE_API_KEY is not configured.",
      503,
    ),
  );
  assert.equal(provider.code, "JOB_PROVIDER_ERROR");
  assert.equal(
    provider.details.provider_error_code,
    "EXTERNAL_CONFIGURATION_MISSING",
  );
});

test("worker settings are validated", () => {
  const base = {
    SUPABASE_URL: "http://127.0.0.1:1",
    WORKER_LEASE_SECONDS: "60",
  };
  assert.equal(loadWorkerConfig({ ...base }).concurrency, 2);
  assert.equal(
    loadWorkerConfig({ ...base, WORKER_CONCURRENCY: "4" }).concurrency,
    4,
  );
  assert.throws(
    () => loadWorkerConfig({ ...base, WORKER_CONCURRENCY: "0" }),
    (e) => e.message.includes("WORKER_CONCURRENCY"),
  );
  assert.throws(
    () => loadWorkerConfig({ ...base, WORKER_HEARTBEAT_INTERVAL_MS: "40000" }),
    (e) => e.message.includes("half of WORKER_LEASE_SECONDS"),
  );
  assert.ok(
    loadWorkerConfig({ ...base, WORKER_ID: "fixed" }).workerId === "fixed",
  );
});
