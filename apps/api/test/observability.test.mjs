import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../dist/config.js";
import { Metrics, routeLabel } from "../dist/metrics.js";
import { checkReadiness } from "../dist/readiness.js";

const config = loadConfig({
  NODE_ENV: "test",
  SUPABASE_URL: "http://127.0.0.1:1",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
});

const healthy = {
  database: async () => {},
  auth: async () => {},
  storage: async () => {},
  overdueJobs: async () => 0,
};

test("ready when every probe passes", async () => {
  const result = await checkReadiness(config, healthy);
  assert.equal(result.status, "ready");
  for (const name of [
    "configuration",
    "database",
    "auth",
    "storage",
    "worker",
  ]) {
    assert.equal(result.checks[name].status, "ok", name);
  }
});

test("a failing database makes the instance not ready and names the check", async () => {
  const result = await checkReadiness(config, {
    ...healthy,
    database: async () => {
      throw new Error("connection refused at 10.0.0.5 password=secret");
    },
  });
  assert.equal(result.status, "not_ready");
  assert.equal(result.checks.database.status, "failing");
  assert.equal(result.checks.database.code, "DATABASE_UNREACHABLE");
  // The raw error text, which can hold hosts and credentials, is never returned.
  assert.ok(!JSON.stringify(result).includes("10.0.0.5"));
  assert.ok(!JSON.stringify(result).includes("secret"));
  assert.equal(result.checks.auth.status, "ok");
});

test("auth, storage, and a stuck job queue each fail on their own", async () => {
  const auth = await checkReadiness(config, {
    ...healthy,
    auth: async () => {
      throw new Error("down");
    },
  });
  assert.equal(auth.checks.auth.code, "AUTH_UNREACHABLE");
  const storage = await checkReadiness(config, {
    ...healthy,
    storage: async () => {
      throw new Error("invoices bucket is public");
    },
  });
  assert.equal(storage.checks.storage.code, "STORAGE_UNAVAILABLE");
  const stuck = await checkReadiness(config, {
    ...healthy,
    overdueJobs: async () => 3,
  });
  assert.equal(stuck.status, "not_ready");
  assert.equal(stuck.checks.worker.code, "WORKER_BACKLOG");
  assert.equal(stuck.checks.worker.detail.overdue_jobs, 3);
  const unreadable = await checkReadiness(config, {
    ...healthy,
    overdueJobs: async () => {
      throw new Error("x");
    },
  });
  assert.equal(unreadable.checks.worker.code, "JOBS_UNREADABLE");
});

test("missing Supabase configuration is not ready and lists the missing variables", async () => {
  const bare = loadConfig({ NODE_ENV: "test" });
  const result = await checkReadiness(bare, null);
  assert.equal(result.status, "not_ready");
  assert.deepEqual(result.checks.configuration.detail.missing, [
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ]);
});

test("a missing provider key does not make the instance not ready", async () => {
  const result = await checkReadiness(config, healthy);
  assert.equal(result.status, "ready");
  assert.equal(result.checks.providers.detail.here, "not_configured");
  assert.equal(result.checks.providers.detail.bright_data, "not_configured");
  const keyed = loadConfig({
    NODE_ENV: "test",
    SUPABASE_URL: "http://127.0.0.1:1",
    SUPABASE_ANON_KEY: "a",
    SUPABASE_SERVICE_ROLE_KEY: "b",
    HERE_API_KEY: "key",
  });
  const withKey = await checkReadiness(keyed, healthy);
  assert.equal(withKey.checks.providers.detail.here, "ok");
  assert.ok(
    !JSON.stringify(withKey).includes('"key"'),
    "a key value is never reported",
  );
});

test("route labels replace ids so metric labels stay few", () => {
  assert.equal(
    routeLabel("/api/v1/trips/00000000-0000-0000-0000-000000000001/bookings"),
    "/api/v1/trips/:id/bookings",
  );
  assert.equal(routeLabel("/api/v1/trips"), "/api/v1/trips");
  assert.equal(routeLabel("/health"), "/health");
});

test("metrics render counters, a duration histogram, provider errors, and process gauges", () => {
  const metrics = new Metrics();
  metrics.recordRequest({
    method: "GET",
    route: "/api/v1/trips",
    status: 200,
    seconds: 0.04,
  });
  metrics.recordRequest({
    method: "GET",
    route: "/api/v1/trips",
    status: 200,
    seconds: 0.3,
  });
  metrics.recordRequest({
    method: "POST",
    route: "/api/v1/trips/:id/bookings",
    status: 409,
    seconds: 1.2,
  });
  metrics.recordProviderError("bright_data", "EXTERNAL_PROVIDER_REJECTED");
  const text = metrics.render({ rss: 1000, heapUsed: 500 });
  assert.ok(
    text.includes(
      'travelflow_http_requests_total{method="GET",route="/api/v1/trips",status="2xx"} 2',
    ),
  );
  assert.ok(text.includes('status="4xx"} 1'));
  assert.ok(
    text.includes(
      'travelflow_http_request_duration_seconds_bucket{method="GET",route="/api/v1/trips",le="0.05"} 1',
    ),
  );
  assert.ok(
    text.includes(
      'travelflow_http_request_duration_seconds_bucket{method="GET",route="/api/v1/trips",le="+Inf"} 2',
    ),
  );
  assert.ok(
    text.includes(
      'travelflow_http_request_duration_seconds_count{method="GET",route="/api/v1/trips"} 2',
    ),
  );
  assert.ok(
    text.includes(
      'travelflow_provider_errors_total{provider="bright_data",code="EXTERNAL_PROVIDER_REJECTED"} 1',
    ),
  );
  assert.ok(text.includes("travelflow_process_resident_memory_bytes 1000"));
  assert.ok(!text.includes("Bearer"), "no credential material in metrics");
});
