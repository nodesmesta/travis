// Validator for Task 10 (notifications and background jobs).
//
//   API_BASE_URL=http://127.0.0.1:4110/api/v1 node --env-file=.env.local scripts/validate-task-10.mjs
//
// It needs the API running from apps/api/dist, the worker built into apps/worker/dist, and
// the local Supabase database with migration 0009. It starts its own worker processes.
//
// Three kinds of check, and the output never mixes them:
//   DATABASE   talks to Postgres and PostgREST directly (constraints, functions, RLS).
//   API        talks to the running API with the demo user and a second user.
//   FIXTURE    starts worker processes whose HERE Traffic and OpenWeather hosts point at a
//              local server (scripts/lib/task10-fixture-server.mjs) that answers with
//              documented response shapes. It proves the worker, scheduler, rules, and
//              persistence wiring. It is not a provider check. The live HERE and
//              OpenWeather checks are reported BLOCKED while their keys are empty.
//
// Everything is created under one trip named "Fixture Task 10 Trip", and removed at the end.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
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
import { startTask10Fixture } from "./lib/task10-fixture-server.mjs";

requireEnv(
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "DEMO_EMAIL",
  "DEMO_PASSWORD",
);
process.env.API_BASE_URL ??= "http://127.0.0.1:4110/api/v1";

const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const demo = await demoToken();
const other = await otherUserToken();
const demoUserId = (
  await sql(`select id from auth.users where email = '${env.DEMO_EMAIL}'`)
).trim();
const otherUserId = (
  await sql(
    "select id from auth.users where email = 'other-user@travelflow.local'",
  )
).trim();

// --- helpers ------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const minutes = (n) => new Date(Date.now() + n * 60_000).toISOString();

async function waitFor(
  label,
  fn,
  { timeoutMs = 30_000, intervalMs = 400 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Runs a query and returns its rows as parsed JSON. */
async function rows(query) {
  const text = await sql(
    `select coalesce(json_agg(t), '[]'::json)::text from (${query}) t`,
  );
  return JSON.parse(text);
}

async function rest(path, token, { method = "GET", body, prefer } = {}) {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      apikey: token === SERVICE ? SERVICE : env.SUPABASE_ANON_KEY,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(prefer ? { prefer } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const rpc = (name, args) =>
  rest(`/rpc/${name}`, SERVICE, { method: "POST", body: args });

// --- fixture trip ---------------------------------------------------------------

const TRIP = randomUUID();
const P = {
  hotel: randomUUID(),
  hall: randomUUID(),
  garden: randomUUID(),
  nyA: randomUUID(),
  nyB: randomUUID(),
  unresolved: randomUUID(),
  remote: randomUUID(),
};
const LEG = {
  a: randomUUID(),
  ny: randomUUID(),
  far: randomUUID(),
  cancelled: randomUUID(),
  c: randomUUID(),
  e: randomUUID(),
  m: randomUUID(),
  /** Departs in about two days, beyond the schedule horizon, so the worker never plans anything for it. */
  db: randomUUID(),
};
const AGENDA = { outdoor: randomUUID(), indoor: randomUUID() };

function pointSql(id, type, label, lat, lng, tz, resolved) {
  return `insert into public.context_points
    (id, trip_id, type, label, latitude, longitude, timezone, external_place_id, resolution_status)
    values ('${id}', '${TRIP}', '${type}', 'Fixture ${label}', ${resolved ? lat : "null"}, ${resolved ? lng : "null"},
            '${tz}', ${resolved ? `'fixture-${label.split(" ").join("-")}'` : "null"}, '${resolved ? "resolved" : "unresolved"}');`;
}

function legSql(
  id,
  origin,
  destination,
  departIn,
  status = "planned",
  deadlineIn = null,
) {
  return `insert into public.journey_legs
    (id, trip_id, origin_context_point_id, destination_context_point_id, departure_at, arrival_deadline, status)
    values ('${id}', '${TRIP}', '${origin}', '${destination}', '${minutes(departIn)}',
            ${deadlineIn === null ? "null" : `'${minutes(deadlineIn)}'`}, '${status}');`;
}

async function createFixtureTrip() {
  await sql(`
    insert into public.trips (id, user_id, name, timezone, status)
    values ('${TRIP}', '${demoUserId}', 'Fixture Task 10 Trip', 'Asia/Jakarta', 'confirmed');
    ${pointSql(P.hotel, "hotel", "Hotel Satu", -6.1954, 106.823, "Asia/Jakarta", true)}
    ${pointSql(P.hall, "conference", "Hall Dua", -6.2147, 106.8097, "Asia/Jakarta", true)}
    ${pointSql(P.garden, "attraction", "Garden Tiga", -6.3, 106.9, "Asia/Jakarta", true)}
    ${pointSql(P.nyA, "hotel", "New York A", 40.7128, -74.006, "America/New_York", true)}
    ${pointSql(P.nyB, "meeting", "New York B", 40.7306, -73.9352, "America/New_York", true)}
    ${pointSql(P.unresolved, "custom_location", "Unresolved Origin", 0, 0, "Asia/Jakarta", false)}
    ${pointSql(P.remote, "custom_location", "Remote Empat", -6.4, 107.1, "Asia/Jakarta", true)}
    ${legSql(LEG.db, P.hotel, P.hall, 3000)}
  `);
}

async function removeFixtureTrip() {
  await sql(`
    delete from public.activity_logs where metadata->>'trip_id' = '${TRIP}';
    delete from public.alerts where trip_id = '${TRIP}';
    delete from public.background_jobs where trip_id = '${TRIP}' and parent_job_id is not null;
    delete from public.background_jobs where trip_id = '${TRIP}';
    delete from public.traffic_snapshots where trip_id = '${TRIP}';
    delete from public.weather_snapshots where trip_id = '${TRIP}';
    delete from public.sources where trip_id = '${TRIP}';
    delete from public.journey_legs where trip_id = '${TRIP}';
    delete from public.agenda_items where trip_id = '${TRIP}';
    delete from public.idempotency_records where scope like '%${TRIP}%';
    delete from public.context_points where trip_id = '${TRIP}';
    delete from public.trips where id = '${TRIP}';
  `);
}

async function sqlExpectError(statement, fragment) {
  let message = "";
  try {
    await sql(statement);
  } catch (error) {
    message = String(error.message);
  }
  assert.ok(
    message.includes(fragment),
    `expected "${fragment}" but got: ${message.slice(0, 300) || "no error"}`,
  );
}

function queueJobSql({
  id = randomUUID(),
  type,
  payload,
  runIn = 0,
  key,
  correlation = "validator-queue",
  parent = null,
}) {
  return {
    id,
    statement: `insert into public.background_jobs
      (id, trip_id, user_id, job_type, payload, idempotency_key, run_at, correlation_id, parent_job_id)
      values ('${id}', '${TRIP}', '${demoUserId}', '${type}', '${JSON.stringify(payload)}'::jsonb,
              '${key ?? `validator:${id}`}', '${minutes(runIn)}', '${correlation}',
              ${parent ? `'${parent}'` : "null"});`,
  };
}

async function queueJob(options) {
  const job = queueJobSql(options);
  await sql(job.statement);
  return job.id;
}

const SOURCE = randomUUID();
async function insertSource(
  id = SOURCE,
  tripId = TRIP,
  retrievedMinutesAgo = 2,
  expiresIn = 8,
) {
  await sql(`insert into public.sources
    (id, trip_id, kind, provider, title, retrieved_at, freshness, expires_at)
    values ('${id}', '${tripId}', 'provider', 'here_traffic_v7', 'Fixture traffic source',
            '${minutes(-retrievedMinutesAgo)}', 'fresh', '${minutes(expiresIn)}');`);
}

function alertBody(overrides = {}) {
  return {
    trip_id: TRIP,
    journey_leg_id: LEG.db,
    alert_type: "traffic_risk",
    severity: "medium",
    title: "Fixture alert",
    factual_summary: "Fixture fact.",
    recommendation_summary: "Fixture recommendation.",
    source_ids: [SOURCE],
    retrieved_at: minutes(-2),
    expires_at: minutes(8),
    deduplication_key: `fixture:${randomUUID()}`,
    policy_version: "alerts-v1",
    reason_codes: ["FIXTURE"],
    metadata: {},
    ...overrides,
  };
}

// --- worker processes -----------------------------------------------------------

function startWorker(fixture, extra = {}) {
  const workerId = extra.WORKER_ID ?? `validator-${randomUUID().slice(0, 8)}`;
  const child = spawn(
    process.execPath,
    ["--env-file=.env.local", "apps/worker/dist/index.js"],
    {
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        ...process.env,
        HERE_API_KEY: "fixture-here-key",
        HERE_BASE_URL_OVERRIDE: `${fixture.origin}/here`,
        OPENWEATHER_API_KEY: "fixture-owm-key",
        OPENWEATHER_BASE_URL_OVERRIDE: `${fixture.origin}/owm`,
        WORKER_ID: workerId,
        WORKER_TRIP_IDS: TRIP,
        WORKER_CONCURRENCY: "2",
        WORKER_POLL_INTERVAL_MS: "300",
        WORKER_SCHEDULE_INTERVAL_MS: "2500",
        WORKER_LEASE_SECONDS: "10",
        WORKER_HEARTBEAT_INTERVAL_MS: "2000",
        WORKER_JOB_TIMEOUT_MS: "60000",
        WORKER_SHUTDOWN_GRACE_MS: "5000",
        LOG_LEVEL: "info",
        ...extra,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const handle = { child, workerId, logs: [], raw: "", exited: null };
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      handle.raw += `${line}\n`;
      try {
        handle.logs.push(JSON.parse(line));
      } catch {
        // A non-JSON line is kept in raw for the failure message.
      }
      newline = buffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk) => (handle.raw += chunk));
  handle.exited = new Promise((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );
  return handle;
}

const jobsOf = (where) =>
  rows(`select id, job_type, status, error_code, error_message, result_summary, attempts, parent_job_id,
               correlation_id, execution_id, lease_owner, idempotency_key, run_at, payload
        from public.background_jobs where trip_id = '${TRIP}' and ${where} order by created_at`);

const alertsOf = (where = "true") =>
  rows(`select id, alert_type, severity, status, journey_leg_id, agenda_item_id, job_id, deduplication_key,
               factual_summary, recommendation_summary, source_ids, retrieved_at, expires_at, read_at, dismissed_at
        from public.alerts where trip_id = '${TRIP}' and ${where} order by triggered_at`);

// =============================================================================
// DATABASE
// =============================================================================

await createFixtureTrip();
let mainWorker = null;
let secondWorker = null;
let fixture = null;

try {
  await check(
    "DATABASE: jobs and alerts exist with row level security and no user insert policy",
    async () => {
      for (const table of ["background_jobs", "alerts"]) {
        assert.equal(
          await sql(
            `select relrowsecurity from pg_class where oid = 'public.${table}'::regclass`,
          ),
          "t",
        );
      }
      const policies = await rows(
        "select tablename, cmd, roles::text from pg_policies where schemaname = 'public' and tablename in ('background_jobs','alerts')",
      );
      const cmds = (table) =>
        policies
          .filter((p) => p.tablename === table)
          .map((p) => p.cmd)
          .sort();
      assert.deepEqual(
        cmds("background_jobs"),
        ["SELECT"],
        "users may only read jobs",
      );
      assert.deepEqual(
        cmds("alerts"),
        ["SELECT", "UPDATE"],
        "users may read alerts and move them to read or dismissed",
      );
      const grants = await rows(
        `select table_name, privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and table_name in ('background_jobs','alerts') and grantee = 'authenticated'`,
      );
      const privileges = (table) =>
        grants
          .filter((g) => g.table_name === table)
          .map((g) => g.privilege_type)
          .sort();
      assert.deepEqual(privileges("background_jobs"), ["SELECT"]);
      assert.ok(
        !privileges("alerts").includes("INSERT") &&
          !privileges("alerts").includes("DELETE"),
      );
      const columns = await rows(
        `select column_name from information_schema.column_privileges
       where table_schema = 'public' and table_name = 'alerts' and grantee = 'authenticated' and privilege_type = 'UPDATE'`,
      );
      assert.deepEqual(columns.map((c) => c.column_name).sort(), [
        "dismissed_at",
        "read_at",
        "status",
      ]);
    },
  );

  await check(
    "DATABASE: alerts carry the full evidence columns and a unique deduplication key per trip",
    async () => {
      const columns = (
        await sql(
          "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'alerts'",
        )
      ).split("\n");
      for (const column of [
        "trip_id",
        "agenda_item_id",
        "journey_leg_id",
        "job_id",
        "alert_type",
        "severity",
        "title",
        "factual_summary",
        "recommendation_summary",
        "source_ids",
        "retrieved_at",
        "expires_at",
        "deduplication_key",
        "read_at",
        "dismissed_at",
        "policy_version",
        "reason_codes",
      ]) {
        assert.ok(columns.includes(column), `alerts.${column}`);
      }
      const unique = await sql(
        "select indexdef from pg_indexes where schemaname = 'public' and indexname = 'alerts_trip_dedup_unique'",
      );
      assert.ok(
        unique.includes("UNIQUE") &&
          unique.includes("trip_id, deduplication_key"),
        unique,
      );
      const jobColumns = (
        await sql(
          "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'background_jobs'",
        )
      ).split("\n");
      for (const column of [
        "job_type",
        "trip_id",
        "payload",
        "status",
        "idempotency_key",
        "run_at",
        "attempts",
        "lease_owner",
        "lease_expires_at",
        "heartbeat_at",
        "parent_job_id",
        "correlation_id",
        "error_code",
        "error_message",
      ]) {
        assert.ok(jobColumns.includes(column), `background_jobs.${column}`);
      }
    },
  );

  await check(
    "DATABASE: job lifecycle rules reject shortcuts, a second attempt, and a foreign owner",
    async () => {
      const id = randomUUID();
      await sqlExpectError(
        `insert into public.background_jobs (id, trip_id, user_id, job_type, payload, idempotency_key, correlation_id, status)
       values ('${id}', '${TRIP}', '${demoUserId}', 'refresh_weather', '{}', 'validator:running-insert-${id}', 'c', 'running');`,
        "JOB_MUST_START_QUEUED",
      );
      await sqlExpectError(
        `insert into public.background_jobs (trip_id, user_id, job_type, payload, idempotency_key, correlation_id)
       values ('${TRIP}', '${otherUserId}', 'refresh_weather', '{}', 'validator:foreign-owner-${id}', 'c');`,
        "JOB_OWNER_MISMATCH",
      );
      await sqlExpectError(
        `insert into public.background_jobs (trip_id, user_id, job_type, payload, idempotency_key, correlation_id)
       values ('${TRIP}', '${demoUserId}', 'send_email', '{}', 'validator:bad-type-${id}', 'c');`,
        "background_jobs_type_check",
      );
      const jobId = await queueJob({
        type: "refresh_weather",
        payload: { context_point_id: P.hall },
        runIn: 600,
        key: `validator:lifecycle-${id}`,
      });
      await sqlExpectError(
        `update public.background_jobs set status = 'succeeded' where id = '${jobId}';`,
        "JOB_TRANSITION_INVALID",
      );
      await sqlExpectError(
        `update public.background_jobs set attempts = 2 where id = '${jobId}';`,
        "background_jobs_",
      );
      await sqlExpectError(
        `update public.background_jobs set job_type = 'refresh_traffic' where id = '${jobId}';`,
        "JOB_IMMUTABLE_COLUMN",
      );
      await sqlExpectError(
        `insert into public.background_jobs (trip_id, user_id, job_type, payload, idempotency_key, correlation_id)
       values ('${TRIP}', '${demoUserId}', 'refresh_weather', '{}', 'validator:lifecycle-${id}', 'c');`,
        "background_jobs_idempotency_key_unique",
      );
      assert.equal(
        await sql(
          `select cancel_queued_background_job('${jobId}', 'validator')`,
        ),
        "t",
      );
      await sqlExpectError(
        `update public.background_jobs set status = 'queued' where id = '${jobId}';`,
        "JOB_TERMINAL_STATE",
      );
    },
  );

  await check(
    "DATABASE: two claimers can never receive the same job (parallel claim)",
    async () => {
      await sql(
        `update public.background_jobs set run_at = now() + interval '10 years' where trip_id = '${TRIP}' and status = 'queued';`,
      );
      const one = await queueJob({
        type: "refresh_weather",
        payload: { context_point_id: P.hall },
        runIn: -1,
        key: `validator:claim-one-${randomUUID()}`,
      });
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          rpc("claim_background_jobs", {
            p_worker_id: `claimer-${index}`,
            p_limit: 1,
            p_lease_seconds: 30,
          }),
        ),
      );
      for (const result of results)
        assert.equal(result.status, 200, JSON.stringify(result.body));
      const claimed = results
        .flatMap((result) => result.body)
        .filter((job) => job.trip_id === TRIP);
      assert.equal(
        claimed.length,
        1,
        `exactly one claimer wins, got ${claimed.length}`,
      );
      assert.equal(claimed[0].id, one);
      assert.equal(claimed[0].status, "running");
      assert.equal(claimed[0].attempts, 1);
      assert.ok(
        claimed[0].execution_id &&
          claimed[0].lease_expires_at &&
          claimed[0].heartbeat_at,
      );

      // Many jobs and many claimers: every job is claimed once, none twice.
      const ids = [];
      for (let index = 0; index < 12; index += 1) {
        ids.push(
          await queueJob({
            type: "refresh_weather",
            payload: { context_point_id: P.hall },
            runIn: -1,
            key: `validator:claim-many-${index}-${randomUUID()}`,
          }),
        );
      }
      const many = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          rpc("claim_background_jobs", {
            p_worker_id: `many-${index}`,
            p_limit: 4,
            p_lease_seconds: 30,
          }),
        ),
      );
      const got = many
        .flatMap((result) => result.body)
        .filter((job) => ids.includes(job.id))
        .map((job) => job.id);
      assert.equal(got.length, 12);
      assert.equal(new Set(got).size, 12, "no job was claimed twice");
      // Close these jobs so they do not linger as running.
      await sql(
        `update public.background_jobs set lease_expires_at = now() - interval '1 second' where trip_id = '${TRIP}' and status = 'running';`,
      );
      await sql("select count(*) from reclaim_expired_background_jobs()");
    },
  );

  await check(
    "DATABASE: lease expiry marks the job interrupted, never successful, and it is not claimed again",
    async () => {
      const id = await queueJob({
        type: "refresh_traffic",
        payload: { journey_leg_id: LEG.a },
        runIn: -1,
        key: `validator:lease-${randomUUID()}`,
        correlation: "validator-lease",
      });
      const claimed = await rpc("claim_background_jobs", {
        p_worker_id: "lease-worker",
        p_limit: 1,
        p_lease_seconds: 5,
      });
      assert.equal(claimed.body.filter((job) => job.id === id).length, 1);
      // A heartbeat before expiry extends the lease: reclaim finds nothing.
      const renewed = await rpc("heartbeat_background_job", {
        p_job_id: id,
        p_worker_id: "lease-worker",
        p_lease_seconds: 30,
      });
      assert.equal(renewed.body, true);
      const early = await rpc("reclaim_expired_background_jobs", {});
      assert.equal(
        early.body.filter((job) => job.id === id).length,
        0,
        "a renewed lease is not reclaimed",
      );
      // A heartbeat from a different worker is refused.
      const stranger = await rpc("heartbeat_background_job", {
        p_job_id: id,
        p_worker_id: "someone-else",
        p_lease_seconds: 30,
      });
      assert.equal(stranger.body, false);
      // Let a real 5 second lease run out without a heartbeat.
      await sql(
        `update public.background_jobs set lease_expires_at = now() + interval '5 seconds' where id = '${id}';`,
      );
      await sleep(6500);
      const late = await rpc("heartbeat_background_job", {
        p_job_id: id,
        p_worker_id: "lease-worker",
        p_lease_seconds: 30,
      });
      assert.equal(late.body, false, "an expired lease cannot be renewed");
      const reclaimed = await rpc("reclaim_expired_background_jobs", {});
      const job = reclaimed.body.find((entry) => entry.id === id);
      assert.ok(job, "the expired job is reclaimed");
      assert.equal(job.status, "interrupted");
      assert.equal(job.error_code, "JOB_INTERRUPTED");
      assert.ok(job.completed_at);
      const completion = await rpc("complete_background_job", {
        p_job_id: id,
        p_worker_id: "lease-worker",
        p_status: "succeeded",
        p_result: { outcome: "fake" },
        p_error_code: null,
        p_error_message: null,
        p_provider_request_ids: [],
      });
      assert.equal(
        completion.body,
        false,
        "an interrupted job cannot be completed as a success",
      );
      const [row] = await jobsOf(`id = '${id}'`);
      assert.equal(row.status, "interrupted");
      assert.equal(row.result_summary, null);
      const again = await rpc("claim_background_jobs", {
        p_worker_id: "lease-worker-2",
        p_limit: 5,
        p_lease_seconds: 30,
      });
      assert.equal(
        again.body.filter((entry) => entry.id === id).length,
        0,
        "an interrupted job is never run again",
      );
      await sqlExpectError(
        `update public.background_jobs set status = 'queued' where id = '${id}';`,
        "JOB_TERMINAL_STATE",
      );
      const log = await sql(
        `select count(*) from public.activity_logs where resource_id = '${id}' and action = 'job.interrupted'`,
      );
      assert.equal(log, "1");
    },
  );

  await check(
    "DATABASE: duplicate alerts collapse into one record, even from parallel writers",
    async () => {
      await insertSource();
      const body = alertBody({
        deduplication_key: `fixture:dedup:${randomUUID()}`,
      });
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          rpc("create_alert", { p_alert: body, p_sources: [] }),
        ),
      );
      for (const result of results)
        assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(
        results.filter((result) => result.body.created === true).length,
        1,
        "exactly one writer creates the row",
      );
      const count = await sql(
        `select count(*) from public.alerts where trip_id = '${TRIP}' and deduplication_key = '${body.deduplication_key}'`,
      );
      assert.equal(count, "1");
      // A second key is a second alert.
      const second = await rpc("create_alert", {
        p_alert: alertBody(),
        p_sources: [],
      });
      assert.equal(second.body.created, true);
    },
  );

  await check(
    "DATABASE: newer evidence renews an alert in place, and a dismissed alert is left alone",
    async () => {
      const key = `fixture:renew:${randomUUID()}`;
      const oldRetrieved = minutes(-5);
      const oldExpires = minutes(5);
      const first = await rpc("create_alert", {
        p_alert: alertBody({
          deduplication_key: key,
          retrieved_at: oldRetrieved,
          expires_at: oldExpires,
          factual_summary: "Old fact.",
        }),
        p_sources: [],
      });
      assert.equal(first.body.created, true);
      const same = await rpc("create_alert", {
        p_alert: alertBody({
          deduplication_key: key,
          retrieved_at: oldRetrieved,
          expires_at: oldExpires,
          factual_summary: "Same time.",
        }),
        p_sources: [],
      });
      assert.equal(same.body.created, false);
      assert.equal(
        same.body.refreshed,
        false,
        "evidence that is not newer changes nothing",
      );
      const renewed = await rpc("create_alert", {
        p_alert: alertBody({
          deduplication_key: key,
          retrieved_at: minutes(-1),
          expires_at: minutes(9),
          factual_summary: "New fact.",
        }),
        p_sources: [],
      });
      assert.equal(renewed.body.created, false);
      assert.equal(renewed.body.refreshed, true);
      const [row] = await alertsOf(`deduplication_key = '${key}'`);
      assert.equal(row.factual_summary, "New fact.");
      assert.equal((await alertsOf(`deduplication_key = '${key}'`)).length, 1);
      await sql(
        `update public.alerts set status = 'dismissed' where id = '${row.id}';`,
      );
      const afterDismiss = await rpc("create_alert", {
        p_alert: alertBody({
          deduplication_key: key,
          retrieved_at: minutes(0.5),
          expires_at: minutes(9),
          factual_summary: "Even newer.",
        }),
        p_sources: [],
      });
      assert.equal(afterDismiss.body.created, false);
      assert.equal(
        afterDismiss.body.refreshed,
        false,
        "a dismissed alert is not renewed or recreated",
      );
      const [dismissed] = await alertsOf(`deduplication_key = '${key}'`);
      assert.equal(dismissed.status, "dismissed");
      assert.equal(dismissed.factual_summary, "New fact.");
    },
  );

  await check(
    "DATABASE: an alert needs a source of its own trip and a valid window",
    async () => {
      const foreignSource = randomUUID();
      await insertSource(foreignSource, "00000000-0000-0000-0000-000000000001");
      try {
        const wrongTrip = await rpc("create_alert", {
          p_alert: alertBody({ source_ids: [foreignSource] }),
          p_sources: [],
        });
        assert.notEqual(wrongTrip.status, 200);
        assert.ok(
          JSON.stringify(wrongTrip.body).includes("ALERT_SOURCE_NOT_IN_TRIP"),
          JSON.stringify(wrongTrip.body),
        );
      } finally {
        await sql(`delete from public.sources where id = '${foreignSource}'`);
      }
      const noSource = await rpc("create_alert", {
        p_alert: alertBody({ source_ids: [] }),
        p_sources: [],
      });
      assert.notEqual(noSource.status, 200);
      assert.ok(
        JSON.stringify(noSource.body).includes("alerts_sources_required"),
      );
      const badWindow = await rpc("create_alert", {
        p_alert: alertBody({
          retrieved_at: minutes(5),
          expires_at: minutes(1),
        }),
        p_sources: [],
      });
      assert.notEqual(badWindow.status, 200);
      assert.ok(JSON.stringify(badWindow.body).includes("alerts_expiry_check"));
      const blank = await rpc("create_alert", {
        p_alert: alertBody({ recommendation_summary: "   " }),
        p_sources: [],
      });
      assert.notEqual(blank.status, 200);
    },
  );

  await check(
    "DATABASE: RLS keeps jobs and alerts inside the owner's trips, and users cannot create or edit them",
    async () => {
      const [mine] = await alertsOf("true");
      assert.ok(mine, "fixture alerts exist");
      const jobId = (await jobsOf("true"))[0].id;

      const ownAlerts = await rest(
        `/alerts?trip_id=eq.${TRIP}&select=id`,
        demo,
      );
      assert.equal(ownAlerts.status, 200);
      assert.ok(ownAlerts.body.length >= 1);
      const foreignAlerts = await rest(
        `/alerts?trip_id=eq.${TRIP}&select=id`,
        other,
      );
      assert.deepEqual(
        foreignAlerts.body,
        [],
        "another user reads no alert of this trip",
      );
      const ownJobs = await rest(
        `/background_jobs?trip_id=eq.${TRIP}&select=id`,
        demo,
      );
      assert.ok(ownJobs.body.length >= 1);
      const foreignJobs = await rest(
        `/background_jobs?trip_id=eq.${TRIP}&select=id`,
        other,
      );
      assert.deepEqual(foreignJobs.body, []);

      // Another user cannot touch the alert.
      const foreignUpdate = await rest(`/alerts?id=eq.${mine.id}`, other, {
        method: "PATCH",
        body: { status: "read" },
        prefer: "return=representation",
      });
      assert.deepEqual(foreignUpdate.body, [], "no row is visible to update");
      assert.equal((await alertsOf(`id = '${mine.id}'`))[0].status, "unread");

      // The owner cannot create jobs or alerts, edit evidence, or delete.
      const insertJob = await rest("/background_jobs", demo, {
        method: "POST",
        body: {
          trip_id: TRIP,
          user_id: demoUserId,
          job_type: "refresh_weather",
          payload: { context_point_id: P.hall },
          idempotency_key: `validator:user-insert-${randomUUID()}`,
          correlation_id: "user",
        },
      });
      assert.ok(
        insertJob.status === 401 || insertJob.status === 403,
        `job insert status ${insertJob.status}`,
      );
      const updateJob = await rest(`/background_jobs?id=eq.${jobId}`, demo, {
        method: "PATCH",
        body: { status: "cancelled" },
      });
      assert.ok(
        updateJob.status === 401 || updateJob.status === 403,
        `job update status ${updateJob.status}`,
      );
      const insertAlert = await rest("/alerts", demo, {
        method: "POST",
        body: alertBody({
          deduplication_key: `fixture:user-insert-${randomUUID()}`,
          status: "unread",
        }),
      });
      assert.ok(
        insertAlert.status === 401 || insertAlert.status === 403,
        `alert insert status ${insertAlert.status}`,
      );
      const editTitle = await rest(`/alerts?id=eq.${mine.id}`, demo, {
        method: "PATCH",
        body: { title: "Edited" },
      });
      assert.ok(
        editTitle.status === 401 || editTitle.status === 403,
        `title edit status ${editTitle.status}`,
      );
      const deleteAlert = await rest(`/alerts?id=eq.${mine.id}`, demo, {
        method: "DELETE",
      });
      assert.ok(
        deleteAlert.status === 401 || deleteAlert.status === 403,
        `alert delete status ${deleteAlert.status}`,
      );
      for (const name of [
        "claim_background_jobs",
        "create_alert",
        "reclaim_expired_background_jobs",
      ]) {
        const call = await rest(`/rpc/${name}`, demo, {
          method: "POST",
          body:
            name === "claim_background_jobs"
              ? { p_worker_id: "x", p_limit: 1, p_lease_seconds: 30 }
              : name === "create_alert"
                ? { p_alert: {}, p_sources: [] }
                : {},
        });
        assert.ok(
          call.status === 401 || call.status === 403 || call.status === 404,
          `${name} must not be callable by a user, got ${call.status}`,
        );
      }
      assert.equal(
        (await rows(`select 1 from public.alerts where id = '${mine.id}'`))
          .length,
        1,
      );
    },
  );

  await check(
    "DATABASE: the owner moves an alert forward only, and the server stamps the times",
    async () => {
      const [target] = await alertsOf("status = 'unread'");
      const read = await rest(`/alerts?id=eq.${target.id}`, demo, {
        method: "PATCH",
        body: { status: "read", read_at: "2000-01-01T00:00:00Z" },
        prefer: "return=representation",
      });
      assert.equal(read.status, 200, JSON.stringify(read.body));
      assert.equal(read.body[0].status, "read");
      assert.ok(
        Date.parse(read.body[0].read_at) > Date.now() - 60_000,
        "read_at is the server time, not the client value",
      );
      const back = await rest(`/alerts?id=eq.${target.id}`, demo, {
        method: "PATCH",
        body: { status: "unread" },
      });
      assert.notEqual(back.status, 200);
      assert.ok(
        JSON.stringify(back.body).includes("ALERT_READ_IS_FINAL"),
        JSON.stringify(back.body),
      );
      const dismiss = await rest(`/alerts?id=eq.${target.id}`, demo, {
        method: "PATCH",
        body: { status: "dismissed" },
        prefer: "return=representation",
      });
      assert.equal(dismiss.body[0].status, "dismissed");
      assert.ok(dismiss.body[0].dismissed_at);
      assert.equal(
        dismiss.body[0].read_at,
        read.body[0].read_at,
        "the first read time is kept",
      );
      const revive = await rest(`/alerts?id=eq.${target.id}`, demo, {
        method: "PATCH",
        body: { status: "read" },
      });
      assert.notEqual(revive.status, 200);
      assert.ok(
        JSON.stringify(revive.body).includes("ALERT_DISMISSED_IS_FINAL"),
      );
    },
  );

  // ===========================================================================
  // API: access control
  // ===========================================================================

  await check(
    "API: another user and a missing token get no alert or job of this trip",
    async () => {
      const [alert] = await alertsOf("true");
      const [job] = await jobsOf("true");
      const base = `/trips/${TRIP}`;
      for (const [method, path] of [
        ["GET", `${base}/alerts`],
        ["POST", `${base}/alerts/${alert.id}/read`],
        ["POST", `${base}/alerts/${alert.id}/dismiss`],
        ["GET", `${base}/jobs`],
        ["POST", `${base}/jobs/${job.id}/rerun`],
      ]) {
        const foreign = await api(path, other, { method });
        assert.equal(
          foreign.status,
          404,
          `${method} ${path} as another user: ${foreign.status} ${foreign.text}`,
        );
        const anonymous = await api(path, "not-a-token", { method });
        assert.equal(
          anonymous.status,
          401,
          `${method} ${path} without a valid token: ${anonymous.status}`,
        );
      }
      const badId = await api(`${base}/alerts/not-a-uuid/read`, demo, {
        method: "POST",
      });
      assert.equal(badId.status, 404);
      const missing = await api(`${base}/alerts/${randomUUID()}/read`, demo, {
        method: "POST",
      });
      assert.equal(missing.status, 404);
      const missingKey = await fetch(
        `${process.env.API_BASE_URL}${base}/alerts/${alert.id}/read`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${demo}` },
        },
      );
      assert.equal(
        missingKey.status,
        400,
        "a mutation needs an Idempotency-Key",
      );
    },
  );

  await check(
    "API: expired alerts are not listed unless asked for, and dismissed ones are counted",
    async () => {
      const key = `fixture:expired:${randomUUID()}`;
      const created = await rpc("create_alert", {
        p_alert: alertBody({
          deduplication_key: key,
          retrieved_at: minutes(-120),
          expires_at: minutes(-60),
          title: "Fixture expired alert",
        }),
        p_sources: [],
      });
      assert.equal(created.body.created, true);
      const listed = await api(`/trips/${TRIP}/alerts`, demo);
      assert.equal(listed.status, 200);
      assert.ok(
        !listed.body.items.some(
          (item) => item.title === "Fixture expired alert",
        ),
        "expired data is not shown",
      );
      assert.ok(listed.body.hidden_expired_count >= 1);
      assert.ok(listed.body.hidden_dismissed_count >= 1);
      assert.ok(
        listed.body.items.every(
          (item) => item.freshness === "fresh" && item.status !== "dismissed",
        ),
      );
      const all = await api(
        `/trips/${TRIP}/alerts?include_expired=true&include_dismissed=true`,
        demo,
      );
      const expired = all.body.items.find(
        (item) => item.title === "Fixture expired alert",
      );
      assert.ok(expired);
      assert.equal(expired.freshness, "expired");
      const invalid = await api(
        `/trips/${TRIP}/alerts?include_expired=maybe`,
        demo,
      );
      assert.equal(invalid.status, 400);
    },
  );

  // ===========================================================================
  // FIXTURE: worker, scheduler, rules, persistence
  // ===========================================================================

  fixture = await startTask10Fixture();
  fixture.setTraffic("medium");
  fixture.setWeather("rain");

  // Clean the database section's leftovers so the worker sees only the scenario below.
  await sql(`delete from public.alerts where trip_id = '${TRIP}';`);
  await sql(
    `delete from public.background_jobs where trip_id = '${TRIP}' and status in ('queued','cancelled');`,
  );

  await sql(`
    ${legSql(LEG.a, P.hotel, P.hall, 25, "planned", 90)}
    ${legSql(LEG.ny, P.nyA, P.nyB, 50)}
    ${legSql(LEG.far, P.hotel, P.hall, 600)}
    ${legSql(LEG.cancelled, P.hotel, P.hall, 30, "cancelled")}
    insert into public.agenda_items (id, trip_id, context_point_id, title, type, start_at, end_at, timezone, status, metadata)
    values ('${AGENDA.outdoor}', '${TRIP}', '${P.hall}', 'Fixture Outdoor Walk', 'event', '${minutes(60)}', '${minutes(120)}', 'Asia/Jakarta', 'planned', '{"indoor_outdoor":"outdoor"}'),
           ('${AGENDA.indoor}', '${TRIP}', '${P.hall}', 'Fixture Indoor Talk', 'meeting', '${minutes(60)}', '${minutes(120)}', 'Asia/Jakarta', 'planned', '{"indoor_outdoor":"indoor"}');
  `);
  // Every agenda item and the three legs that the validator never edits afterwards.
  const itineraryDigest = async () =>
    sql(`select md5(coalesce((select string_agg(t::text, '|' order by id) from public.agenda_items t where trip_id = '${TRIP}'), '')
                  || coalesce((select string_agg(t::text, '|' order by id) from public.journey_legs t
                               where trip_id = '${TRIP}' and id in ('${LEG.a}', '${LEG.far}', '${LEG.cancelled}')), ''))`);
  const digestBefore = await itineraryDigest();

  mainWorker = startWorker(fixture, { WORKER_ID: "validator-main" });
  await waitFor("worker.started", async () =>
    mainWorker.logs.find((log) => log.event === "worker.started"),
  );

  await check(
    "FIXTURE: the worker starts with the concurrency and lease settings from the environment",
    async () => {
      const started = mainWorker.logs.find(
        (log) => log.event === "worker.started",
      );
      assert.equal(started.worker_id, "validator-main");
      assert.equal(started.concurrency, 2);
      assert.equal(started.lease_seconds, 10);
      assert.equal(started.trip_filter, 1);
      for (const secret of ["fixture-here-key", "fixture-owm-key", SERVICE]) {
        assert.ok(
          !mainWorker.raw.includes(secret),
          "no key appears in the worker log",
        );
      }
    },
  );

  await check(
    "FIXTURE: refresh, evaluate, and reminder jobs create traffic, weather, and reminder alerts",
    async () => {
      await waitFor(
        "traffic, weather, and reminder alerts",
        async () => {
          const found = await alertsOf("true");
          const types = new Set(found.map((alert) => alert.alert_type));
          return types.has("traffic_risk") &&
            types.has("weather_risk") &&
            types.has("departure_reminder")
            ? found
            : null;
        },
        { timeoutMs: 40_000 },
      );
      const found = await alertsOf("true");

      const traffic = found.find(
        (alert) => alert.alert_type === "traffic_risk",
      );
      assert.equal(traffic.journey_leg_id, LEG.a);
      assert.equal(traffic.severity, "medium");
      assert.ok(traffic.factual_summary.includes("rated medium"));
      assert.ok(
        !traffic.factual_summary.includes("Consider"),
        "facts do not contain the recommendation",
      );
      assert.ok(traffic.recommendation_summary.includes("earlier"));
      assert.ok(traffic.source_ids.length >= 1);
      assert.ok(
        Date.parse(traffic.expires_at) > Date.parse(traffic.retrieved_at),
      );

      const weather = found.find(
        (alert) => alert.alert_type === "weather_risk",
      );
      assert.equal(weather.agenda_item_id, AGENDA.outdoor);
      assert.equal(weather.severity, "high");
      assert.ok(weather.factual_summary.includes("heavy intensity rain"));
      assert.ok(
        weather.recommendation_summary.includes(
          "itinerary has not been changed",
        ),
      );
      assert.equal(
        found.filter((alert) => alert.agenda_item_id === AGENDA.indoor).length,
        0,
        "an indoor item gets no weather alert",
      );

      const reminder = found.find(
        (alert) =>
          alert.alert_type === "departure_reminder" &&
          alert.journey_leg_id === LEG.a,
      );
      assert.ok(reminder);
      assert.equal(reminder.severity, "info");
      assert.ok(
        !reminder.factual_summary.toLowerCase().includes("traffic"),
        "a time based reminder makes no traffic claim",
      );
      const [source] = await rows(
        `select kind, provider, retrieved_at, expires_at from public.sources where id = '${reminder.source_ids[0]}'`,
      );
      assert.equal(source.kind, "internal");
      assert.equal(source.provider, "travelflow_journey_leg");

      // The API shows the same alert with its sources.
      const listed = await api(`/trips/${TRIP}/alerts`, demo);
      assert.equal(listed.status, 200);
      const shown = listed.body.items.find((item) => item.id === traffic.id);
      assert.ok(
        shown.sources.length >= 1 &&
          shown.sources[0].retrieved_at &&
          shown.sources[0].provider === "here_traffic_v7",
      );
      assert.equal(shown.freshness, "fresh");
      assert.equal(shown.policy_version, "alerts-v1");
    },
  );

  await check(
    "FIXTURE: a chain of jobs shares one correlation id and carries execution metadata",
    async () => {
      const done = await jobsOf(
        "job_type = 'refresh_traffic' and status = 'succeeded'",
      );
      assert.ok(done.length >= 1);
      const refresh = done.find((job) => job.payload.journey_leg_id === LEG.a);
      const evaluations = await jobsOf(
        `job_type = 'evaluate_alerts' and payload->>'trigger_job_id' = '${refresh.id}'`,
      );
      assert.equal(evaluations.length, 1, "one evaluation per refresh");
      assert.equal(evaluations[0].correlation_id, refresh.correlation_id);
      assert.ok(
        refresh.execution_id && refresh.lease_owner === "validator-main",
      );
      assert.equal(refresh.attempts, 1);
      const finished = mainWorker.logs.find(
        (log) => log.event === "job.finished" && log.job_id === refresh.id,
      );
      assert.ok(finished, "the worker logged the finished job");
      for (const field of [
        "correlation_id",
        "execution_id",
        "worker_id",
        "trip_id",
        "job_type",
        "latency_ms",
        "status",
      ]) {
        assert.notEqual(finished[field], undefined, `log field ${field}`);
      }
      assert.equal(finished.correlation_id, refresh.correlation_id);
      const log = await sql(
        `select count(*) from public.activity_logs where resource_id = '${refresh.id}' and action = 'job.succeeded'`,
      );
      assert.equal(log, "1");
      assert.ok(
        Number(
          await sql(
            `select count(*) from public.activity_logs where action = 'alert.created' and metadata->>'trip_id' = '${TRIP}'`,
          ),
        ) >= 3,
      );
    },
  );

  await check(
    "FIXTURE: repeated scheduler passes create each job and each alert once",
    async () => {
      await sleep(6000); // two more scheduler passes (2.5 s interval)
      const ticks = mainWorker.logs.filter(
        (log) => log.event === "scheduler.tick",
      );
      assert.ok(ticks.length >= 3, `scheduler ran ${ticks.length} times`);
      const reminders = await jobsOf(
        `job_type = 'departure_reminder' and payload->>'journey_leg_id' = '${LEG.a}'`,
      );
      assert.equal(
        reminders.length,
        1,
        "one reminder job for the leg however often the scheduler ran",
      );
      assert.equal(ticks.at(-1).failed_trips, 0);
      const counts = await rows(
        `select deduplication_key, count(*)::int as n from public.alerts where trip_id = '${TRIP}' group by 1 having count(*) > 1`,
      );
      assert.deepEqual(counts, [], "no deduplication key has two rows");
      assert.equal(
        (
          await alertsOf(
            `alert_type = 'departure_reminder' and journey_leg_id = '${LEG.a}'`,
          )
        ).length,
        1,
      );
    },
  );

  await check(
    "FIXTURE: no job is planned for a cancelled leg, and a far departure gets a reminder but no traffic refresh",
    async () => {
      assert.equal(
        (await jobsOf(`payload->>'journey_leg_id' = '${LEG.cancelled}'`))
          .length,
        0,
      );
      const far = await jobsOf(`payload->>'journey_leg_id' = '${LEG.far}'`);
      assert.deepEqual(
        far.map((job) => job.job_type),
        ["departure_reminder"],
      );
      assert.equal(far[0].status, "queued");
      const due = Date.parse(far[0].run_at);
      assert.ok(
        Math.abs(due - (Date.now() + 570 * 60_000)) < 120_000,
        "the reminder is due 30 minutes before departure, not now",
      );
    },
  );

  await check(
    "FIXTURE: reminders are scheduled in the time zone of the origin, and a moved departure replaces the old reminder",
    async () => {
      const [jakarta] = await jobsOf(
        `job_type = 'departure_reminder' and payload->>'journey_leg_id' = '${LEG.far}'`,
      );
      assert.ok(
        jakarta.idempotency_key.endsWith("+07:00"),
        jakarta.idempotency_key,
      );
      const [ny] = await jobsOf(
        `job_type = 'departure_reminder' and payload->>'journey_leg_id' = '${LEG.ny}' and status = 'queued'`,
      );
      assert.ok(
        ny.idempotency_key.endsWith("-05:00"),
        `New York key must carry the New York offset: ${ny.idempotency_key}`,
      );
      const [leg] = await rows(
        `select departure_at from public.journey_legs where id = '${LEG.ny}'`,
      );
      const expectedDue = Date.parse(leg.departure_at) - 30 * 60_000;
      assert.equal(
        Date.parse(ny.run_at),
        expectedDue,
        "due time is exactly departure minus the 30 minute lead",
      );
      // The same local wall clock time, written from the instant, matches the key.
      const localWall = new Intl.DateTimeFormat("sv-SE", {
        timeZone: "America/New_York",
        dateStyle: "short",
        timeStyle: "medium",
      }).format(new Date(expectedDue));
      assert.ok(
        ny.idempotency_key.includes(localWall.split(" ").join("T")),
        `${ny.idempotency_key} vs ${localWall}`,
      );

      await sql(
        `update public.journey_legs set departure_at = '${minutes(80)}' where id = '${LEG.ny}';`,
      );
      await waitFor(
        "old reminder cancelled",
        async () =>
          (await jobsOf(`id = '${ny.id}' and status = 'cancelled'`))[0],
        { timeoutMs: 15_000 },
      );
      const [cancelled] = await jobsOf(`id = '${ny.id}'`);
      assert.equal(cancelled.result_summary.reason, "DEPARTURE_CHANGED");
      const fresh = await waitFor(
        "new reminder",
        async () =>
          (
            await jobsOf(
              `job_type = 'departure_reminder' and payload->>'journey_leg_id' = '${LEG.ny}' and status = 'queued'`,
            )
          )[0],
        { timeoutMs: 15_000 },
      );
      assert.notEqual(fresh.idempotency_key, ny.idempotency_key);
      assert.ok(fresh.idempotency_key.endsWith("-05:00"));
    },
  );

  await check("FIXTURE: the worker never edits the itinerary", async () => {
    assert.equal(
      await itineraryDigest(),
      digestBefore,
      "agenda items and untouched legs are byte for byte the same",
    );
    const statuses = await rows(
      `select status from public.agenda_items where trip_id = '${TRIP}'`,
    );
    assert.ok(
      statuses.every((row) => row.status === "planned"),
      "no agenda item was confirmed, completed, or cancelled",
    );
  });

  // --- provider unavailable, then manual rerun ---------------------------------

  let failedTrafficJobId = null;
  await check(
    "FIXTURE: a provider failure fails the job with an error code, creates no alert, and is not retried",
    async () => {
      fixture.failAlways("flow");
      const flowBefore = fixture.counters.flow;
      await sql(`${legSql(LEG.c, P.hall, P.hotel, 35)}`);
      const failed = await waitFor(
        "failed refresh_traffic",
        async () =>
          (
            await jobsOf(
              `job_type = 'refresh_traffic' and status = 'failed' and payload->>'journey_leg_id' = '${LEG.c}'`,
            )
          )[0],
        { timeoutMs: 30_000 },
      );
      failedTrafficJobId = failed.id;
      assert.equal(failed.error_code, "JOB_PROVIDER_ERROR");
      assert.ok(failed.error_message && failed.error_message.length > 0);
      assert.equal(failed.result_summary.outcome, "failed");
      assert.ok(
        failed.result_summary.provider_error_code,
        "the provider's own code is kept",
      );
      assert.equal(failed.attempts, 1);
      await sleep(5000); // two more worker polls and scheduler passes
      const [again] = await jobsOf(`id = '${failed.id}'`);
      assert.equal(again.status, "failed");
      assert.equal(
        again.execution_id,
        failed.execution_id,
        "the job was not executed a second time",
      );
      assert.equal(
        (
          await jobsOf(
            `job_type = 'evaluate_alerts' and payload->>'trigger_job_id' = '${failed.id}'`,
          )
        ).length,
        0,
        "a failed refresh does not queue an evaluation",
      );
      assert.equal(
        (
          await alertsOf(
            `journey_leg_id = '${LEG.c}' and alert_type = 'traffic_risk'`,
          )
        ).length,
        0,
        "no traffic alert from a failed provider",
      );
      assert.equal(
        Number(
          await sql(
            `select count(*) from public.traffic_snapshots where trip_id = '${TRIP}' and origin_context_point_id = '${P.hall}' and destination_context_point_id = '${P.hotel}'`,
          ),
        ),
        0,
        "no stale or substitute snapshot",
      );
      assert.ok(
        fixture.counters.flow > flowBefore,
        "the provider was actually asked",
      );
      const finished = mainWorker.logs.find(
        (log) => log.event === "job.finished" && log.job_id === failed.id,
      );
      assert.equal(finished.status, "failed");
      assert.equal(finished.error_code, "JOB_PROVIDER_ERROR");
      assert.equal(finished.level, "error");
    },
  );

  await check(
    "API: a failed job is listed with can_rerun, and a manual rerun creates a new job with parent_job_id",
    async () => {
      fixture.recover("flow");
      const listed = await api(`/trips/${TRIP}/jobs`, demo);
      assert.equal(listed.status, 200);
      const failed = listed.body.items.find(
        (job) => job.id === failedTrafficJobId,
      );
      assert.ok(failed && failed.status === "failed");
      assert.equal(failed.can_rerun, true);
      assert.equal(failed.payload, undefined, "the payload is not exposed");
      assert.equal(failed.lease_owner, undefined);
      const succeeded = listed.body.items.find(
        (job) => job.status === "succeeded",
      );
      assert.equal(succeeded.can_rerun, false);

      const rerunKey = `validator-rerun-${randomUUID()}`;
      const rerun = await api(`/trips/${TRIP}/jobs/${failed.id}/rerun`, demo, {
        method: "POST",
        idempotencyKey: rerunKey,
      });
      assert.equal(rerun.status, 201, rerun.text);
      assert.equal(rerun.body.job.parent_job_id, failed.id);
      assert.equal(rerun.body.job.job_type, "refresh_traffic");
      assert.notEqual(rerun.body.job.id, failed.id);
      assert.ok(
        ["queued", "running", "succeeded"].includes(rerun.body.job.status),
      );
      assert.equal(rerun.body.job.correlation_id, rerun.body.request_id);
      // Same Idempotency-Key replays the same job and creates nothing new.
      const replay = await api(`/trips/${TRIP}/jobs/${failed.id}/rerun`, demo, {
        method: "POST",
        idempotencyKey: rerunKey,
      });
      assert.equal(replay.status, 201);
      assert.equal(replay.body.job.id, rerun.body.job.id);
      assert.equal((await jobsOf(`parent_job_id = '${failed.id}'`)).length, 1);

      // The original job is untouched, and the new job runs under the worker and succeeds.
      const [original] = await jobsOf(`id = '${failed.id}'`);
      assert.equal(original.status, "failed");
      assert.equal(original.error_code, "JOB_PROVIDER_ERROR");
      const child = await waitFor(
        "rerun job to finish",
        async () =>
          (
            await jobsOf(
              `id = '${rerun.body.job.id}' and status in ('succeeded','failed')`,
            )
          )[0],
        { timeoutMs: 30_000 },
      );
      assert.equal(child.status, "succeeded", JSON.stringify(child));
      assert.equal(child.parent_job_id, failed.id);
      await waitFor(
        "traffic alert from the rerun",
        async () =>
          (
            await alertsOf(
              `journey_leg_id = '${LEG.c}' and alert_type = 'traffic_risk'`,
            )
          )[0],
        { timeoutMs: 20_000 },
      );
      const log = await sql(
        `select count(*) from public.activity_logs where resource_id = '${rerun.body.job.id}' and action = 'job.rerun_requested'`,
      );
      assert.equal(log, "1");
    },
  );

  await check(
    "API: only a failed or interrupted job can be rerun, and a job with an active rerun cannot be rerun again",
    async () => {
      const succeeded = (await jobsOf("status = 'succeeded'"))[0];
      const refused = await api(
        `/trips/${TRIP}/jobs/${succeeded.id}/rerun`,
        demo,
        { method: "POST" },
      );
      assert.equal(refused.status, 409);
      assert.equal(refused.body.error.code, "JOB_RERUN_NOT_ALLOWED");
      const queued = (await jobsOf("status = 'queued'"))[0];
      const queuedRefused = await api(
        `/trips/${TRIP}/jobs/${queued.id}/rerun`,
        demo,
        { method: "POST" },
      );
      assert.equal(queuedRefused.status, 409);
      const failed = (await jobsOf(`id = '${failedTrafficJobId}'`))[0];
      const hold = await queueJob({
        type: failed.job_type,
        payload: failed.payload,
        runIn: 600,
        parent: failed.id,
        key: `validator:active-rerun-${randomUUID()}`,
      });
      const second = await api(`/trips/${TRIP}/jobs/${failed.id}/rerun`, demo, {
        method: "POST",
      });
      assert.equal(second.status, 409);
      assert.equal(second.body.error.code, "JOB_RERUN_ALREADY_ACTIVE");
      const listed = await api(`/trips/${TRIP}/jobs`, demo);
      assert.equal(
        listed.body.items.find((job) => job.id === failed.id).can_rerun,
        false,
      );
      await sql(`select cancel_queued_background_job('${hold}', 'validator')`);
      // A child can only point at a failed or interrupted parent.
      await sqlExpectError(
        `insert into public.background_jobs (trip_id, user_id, job_type, payload, idempotency_key, correlation_id, parent_job_id)
       values ('${TRIP}', '${demoUserId}', 'refresh_weather', '{}', 'validator:bad-parent-${randomUUID()}', 'c', '${succeeded.id}');`,
        "JOB_PARENT_NOT_RERUNNABLE",
      );
    },
  );

  // --- expired data -----------------------------------------------------------

  await check(
    "FIXTURE: an expired traffic snapshot fails the evaluation and no alert is created from it",
    async () => {
      const sourceId = randomUUID();
      await sql(`
      insert into public.sources (id, trip_id, kind, provider, title, retrieved_at, freshness, expires_at)
      values ('${sourceId}', '${TRIP}', 'provider', 'here_traffic_v7', 'Fixture expired traffic', '${minutes(-120)}', 'expired', '${minutes(-60)}');
      ${legSql(LEG.e, P.unresolved, P.hall, 100)}
      insert into public.traffic_snapshots
        (id, trip_id, journey_leg_id, origin_context_point_id, destination_context_point_id, source_id, request_fingerprint,
         policy_version, traffic_level, center_latitude, center_longitude, radius_meters, valid_from, valid_to, payload,
         retrieved_at, expires_at)
      values ('${randomUUID()}', '${TRIP}', '${LEG.e}', '${P.unresolved}', '${P.hall}', '${sourceId}', 'fixture-expired',
              'mobility-v1', 'high', -6.2, 106.8, 2000, '${minutes(-120)}', '${minutes(-60)}',
              '{"summary":{"segment_count":10,"average_jam_factor":9,"max_jam_factor":10,"closed_segment_count":0,"incident_count":1},"incidents":[]}',
              '${minutes(-120)}', '${minutes(-60)}');
    `);
      // The leg is within the live horizon, so a fresh snapshot would have produced a high traffic alert.
      const jobId = await queueJob({
        type: "evaluate_alerts",
        payload: {
          trigger_job_id: randomUUID(),
          journey_leg_id: LEG.e,
          context_point_id: null,
        },
        runIn: -1,
        key: `validator:expired-evaluate-${randomUUID()}`,
        correlation: "validator-expired",
      });
      const job = await waitFor(
        "expired evaluation to finish",
        async () =>
          (
            await jobsOf(`id = '${jobId}' and status in ('succeeded','failed')`)
          )[0],
        { timeoutMs: 20_000 },
      );
      assert.equal(
        job.status,
        "failed",
        "expired data is a visible failure, not a success",
      );
      assert.equal(job.error_code, "JOB_PROVIDER_DATA_EXPIRED");
      assert.equal(job.result_summary.outcome, "blocked");
      assert.equal(
        (
          await alertsOf(
            `journey_leg_id = '${LEG.e}' and alert_type = 'traffic_risk'`,
          )
        ).length,
        0,
      );
      assert.equal(
        Number(
          await sql(
            `select count(*) from public.traffic_snapshots where trip_id = '${TRIP}' and journey_leg_id = '${LEG.e}' and expires_at > now()`,
          ),
        ),
        0,
        "no fresh snapshot was invented",
      );
    },
  );

  await check(
    "FIXTURE: a missing snapshot is a precondition failure, and a far departure is only a no_action",
    async () => {
      await sql(`${legSql(LEG.m, P.unresolved, P.remote, 20)}`);
      const missingId = await queueJob({
        type: "evaluate_alerts",
        payload: {
          trigger_job_id: randomUUID(),
          journey_leg_id: LEG.m,
          context_point_id: null,
        },
        runIn: -1,
        key: `validator:no-snapshot-${randomUUID()}`,
      });
      const missing = await waitFor(
        "missing snapshot evaluation",
        async () =>
          (
            await jobsOf(
              `id = '${missingId}' and status in ('succeeded','failed')`,
            )
          )[0],
        { timeoutMs: 20_000 },
      );
      assert.equal(missing.status, "failed");
      assert.equal(missing.error_code, "JOB_PRECONDITION_FAILED");
      assert.equal(
        (
          await alertsOf(
            `journey_leg_id = '${LEG.m}' and alert_type = 'traffic_risk'`,
          )
        ).length,
        0,
      );

      const farId = await queueJob({
        type: "evaluate_alerts",
        payload: {
          trigger_job_id: randomUUID(),
          journey_leg_id: LEG.far,
          context_point_id: null,
        },
        runIn: -1,
        key: `validator:far-${randomUUID()}`,
      });
      const far = await waitFor(
        "far evaluation",
        async () =>
          (
            await jobsOf(`id = '${farId}' and status in ('succeeded','failed')`)
          )[0],
        { timeoutMs: 20_000 },
      );
      assert.equal(far.status, "succeeded");
      assert.equal(far.result_summary.outcome, "no_action");
      assert.deepEqual(far.result_summary.evaluated[0].reason_codes, [
        "TRAFFIC_OUTSIDE_LIVE_HORIZON",
      ]);
    },
  );

  // --- API: read and dismiss ---------------------------------------------------

  await check(
    "API: read and dismiss move an alert forward, are idempotent, and a dismissed alert stays hidden",
    async () => {
      const listed = await api(`/trips/${TRIP}/alerts`, demo);
      const target = listed.body.items.find(
        (item) =>
          item.alert_type === "traffic_risk" &&
          item.status === "unread" &&
          item.journey_leg_id === LEG.a,
      );
      assert.ok(target, "an unread traffic alert exists");
      const keyRead = `validator-read-${randomUUID()}`;
      const read = await api(`/trips/${TRIP}/alerts/${target.id}/read`, demo, {
        method: "POST",
        idempotencyKey: keyRead,
      });
      assert.equal(read.status, 200, read.text);
      assert.equal(read.body.alert.status, "read");
      assert.ok(read.body.alert.read_at);
      const readAgain = await api(
        `/trips/${TRIP}/alerts/${target.id}/read`,
        demo,
        { method: "POST" },
      );
      assert.equal(
        readAgain.body.alert.read_at,
        read.body.alert.read_at,
        "the first read time is kept",
      );
      const replay = await api(
        `/trips/${TRIP}/alerts/${target.id}/read`,
        demo,
        { method: "POST", idempotencyKey: keyRead },
      );
      assert.deepEqual(
        replay.body,
        read.body,
        "the same key replays the same response",
      );

      const dismissed = await api(
        `/trips/${TRIP}/alerts/${target.id}/dismiss`,
        demo,
        { method: "POST" },
      );
      assert.equal(dismissed.status, 200);
      assert.equal(dismissed.body.alert.status, "dismissed");
      const readDismissed = await api(
        `/trips/${TRIP}/alerts/${target.id}/read`,
        demo,
        { method: "POST" },
      );
      assert.equal(
        readDismissed.body.alert.status,
        "dismissed",
        "a dismissed alert does not come back as read",
      );
      const after = await api(`/trips/${TRIP}/alerts`, demo);
      assert.ok(!after.body.items.some((item) => item.id === target.id));
      const withDismissed = await api(
        `/trips/${TRIP}/alerts?include_dismissed=true`,
        demo,
      );
      assert.equal(
        withDismissed.body.items.find((item) => item.id === target.id).status,
        "dismissed",
      );
      assert.ok(
        Number(
          await sql(
            `select count(*) from public.activity_logs where resource_id = '${target.id}' and action in ('alert.read','alert.dismissed')`,
          ),
        ) === 2,
      );
    },
  );

  await check(
    "FIXTURE: after a dismissal the same condition and window does not create the alert again",
    async () => {
      const scope = `journey_leg_id = '${LEG.a}' and alert_type = 'traffic_risk'`;
      const before = await alertsOf(scope);
      // A fresh refresh and evaluation of the same leg, while the condition still holds.
      fixture.setTraffic("medium");
      const refreshId = await queueJob({
        type: "refresh_traffic",
        payload: { journey_leg_id: LEG.a },
        runIn: -1,
        key: `validator:again-${randomUUID()}`,
        correlation: "validator-again",
      });
      await waitFor(
        "refresh to finish",
        async () =>
          (
            await jobsOf(
              `id = '${refreshId}' and status in ('succeeded','failed')`,
            )
          )[0],
        { timeoutMs: 20_000 },
      );
      await waitFor(
        "evaluation to finish",
        async () =>
          (
            await jobsOf(
              `job_type = 'evaluate_alerts' and payload->>'trigger_job_id' = '${refreshId}' and status in ('succeeded','failed')`,
            )
          )[0],
        { timeoutMs: 20_000 },
      );
      const afterAlerts = await alertsOf(scope);
      assert.equal(
        afterAlerts.length,
        before.length,
        "no new traffic alert row for the same leg and window",
      );
      const dismissed = afterAlerts.filter(
        (alert) =>
          alert.status === "dismissed" &&
          alert.alert_type === "traffic_risk" &&
          alert.journey_leg_id === LEG.a,
      );
      assert.equal(dismissed.length, 1);
    },
  );

  // --- interruption and shutdown ------------------------------------------------

  await check(
    "FIXTURE: a worker killed in the middle of a job is detected as interrupted, never as a success",
    async () => {
      fixture.hold("weather", 120_000);
      const jobId = await queueJob({
        type: "refresh_weather",
        payload: { context_point_id: P.remote },
        runIn: -1,
        key: `validator:kill-${randomUUID()}`,
        correlation: "validator-kill",
      });
      await waitFor(
        "job running under the main worker",
        async () => (await jobsOf(`id = '${jobId}' and status = 'running'`))[0],
        { timeoutMs: 20_000 },
      );
      mainWorker.child.kill("SIGKILL");
      const exit = await mainWorker.exited;
      assert.equal(exit.signal, "SIGKILL");
      fixture.hold("weather", 0);
      secondWorker = startWorker(fixture, { WORKER_ID: "validator-second" });
      const interrupted = await waitFor(
        "interrupted state",
        async () =>
          (await jobsOf(`id = '${jobId}' and status = 'interrupted'`))[0],
        { timeoutMs: 40_000, intervalMs: 500 },
      );
      assert.equal(interrupted.error_code, "JOB_INTERRUPTED");
      assert.equal(interrupted.attempts, 1);
      assert.equal(interrupted.result_summary, null);
      assert.equal(
        Number(
          await sql(
            `select count(*) from public.weather_snapshots where trip_id = '${TRIP}' and context_point_id = '${P.remote}'`,
          ),
        ),
        0,
        "no half finished snapshot",
      );
      const logged = await waitFor(
        "interruption log line",
        async () =>
          secondWorker.logs.find(
            (log) => log.event === "job.interrupted" && log.job_id === jobId,
          ),
        { timeoutMs: 5000, intervalMs: 100 },
      );
      assert.equal(logged.correlation_id, "validator-kill");
      assert.equal(logged.lease_owner, "validator-main");
      await sleep(3000);
      const [still] = await jobsOf(`id = '${jobId}'`);
      assert.equal(
        still.status,
        "interrupted",
        "an interrupted job is not run again by the surviving worker",
      );
      const listed = await api(`/trips/${TRIP}/jobs`, demo);
      assert.equal(
        listed.body.items.find((job) => job.id === jobId).can_rerun,
        true,
      );
    },
  );

  await check(
    "FIXTURE: SIGTERM stops the worker cleanly after logging its counters",
    async () => {
      secondWorker.child.kill("SIGTERM");
      const exit = await Promise.race([
        secondWorker.exited,
        sleep(15_000).then(() => ({ code: "timeout" })),
      ]);
      assert.equal(exit.code, 0, secondWorker.raw.slice(-500));
      assert.ok(
        secondWorker.logs.some(
          (log) => log.event === "worker.shutdown_requested",
        ),
      );
      const stopped = secondWorker.logs.find(
        (log) => log.event === "worker.stopped",
      );
      assert.ok(stopped && stopped.counters, "counters are logged on stop");
      secondWorker = null;
    },
  );

  // --- live providers -----------------------------------------------------------

  if (!env.HERE_API_KEY) {
    blocked(
      "LIVE: worker traffic refresh against HERE Traffic API v7",
      "HERE_API_KEY is empty in .env.local",
    );
  } else {
    blocked(
      "LIVE: worker traffic refresh against HERE Traffic API v7",
      "a live key is set but this validator only runs the fixture worker; run the worker with the key and check the alerts by hand",
    );
  }
  if (!env.OPENWEATHER_API_KEY) {
    blocked(
      "LIVE: worker weather refresh against OpenWeather current weather and forecast",
      "OPENWEATHER_API_KEY is empty in .env.local",
    );
  } else {
    blocked(
      "LIVE: worker weather refresh against OpenWeather current weather and forecast",
      "a live key is set but this validator only runs the fixture worker; run the worker with the key and check the alerts by hand",
    );
  }
} finally {
  for (const handle of [mainWorker, secondWorker]) {
    if (
      handle &&
      handle.child.exitCode === null &&
      handle.child.signalCode === null
    ) {
      handle.child.kill("SIGKILL");
    }
  }
  if (fixture) await fixture.close();
  await removeFixtureTrip();
}

finish();
