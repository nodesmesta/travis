// Validator for Task 07 (end-to-end core demo validation).
//
//   npm run build
//   node --env-file=.env.local scripts/validate-task-07.mjs [--skip-smoke] [--skip-live]
//
// Run it from a clean state (see the runbook in plan/tasks/07-end-to-end-demo-validation.md):
//   supabase start && supabase db reset --yes && npm run bootstrap:local
//
// The script starts its own API instances on free ports and a fixture server, so it
// needs nothing running. It writes docs/validation/task-07-result.md.
//
// What is live and what is a fixture:
//   LIVE     the provider smoke test and one event discovery against the real Bright Data.
//            A live provider answer that is empty or an explicit provider error is a valid
//            outcome (acceptance: "found, or the failure is shown explicitly"); a silent or
//            malformed answer is a failure.
//   FIXTURE  the golden path, payment failure, duplicate mutation, ownership, and
//            provider-failure checks run against scripts/lib/harness.mjs, a stand-in for
//            Bright Data that returns schema.org Event markup. They prove the backend
//            behavior. They are not evidence that Bright Data returns events for Jakarta.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  DEMO_TRIP_ID,
  api,
  blocked,
  check,
  demoToken,
  env,
  getResults,
  otherUserToken,
  requireEnv,
  sql,
} from "./lib/validation.mjs";
import {
  brightDataFixtureEnv,
  startApi,
  startBrightDataFixture,
  stopAll,
} from "./lib/harness.mjs";

requireEnv("SUPABASE_URL", "SUPABASE_ANON_KEY", "DEMO_EMAIL", "DEMO_PASSWORD");
const skipSmoke = process.argv.includes("--skip-smoke");
const skipLive = process.argv.includes("--skip-live");

const TRIP = DEMO_TRIP_ID;
const JCC = "00000000-0000-0000-0000-000000000012";
const root = new URL("..", import.meta.url).pathname;
const startedAt = new Date().toISOString();
const notes = [];
const createdBookingIds = [];

const discoveryBody = (category) => ({
  context_point_id: JCC,
  observed_for: {
    from: "2026-11-12T18:00:00+07:00",
    to: "2026-11-12T23:00:00+07:00",
    timezone: "Asia/Jakarta",
  },
  filters: { category, radius_preference: "nearby", language: "en" },
});

const secretValues = [
  env.BRIGHT_DATA_API_KEY,
  env.VULTR_INFERENCE_API_KEY,
  env.SUPABASE_SERVICE_ROLE_KEY,
  env.DEMO_PASSWORD,
].filter((value) => value && value.length >= 8);

function assertNoSecrets(text, label) {
  for (const secret of secretValues) {
    assert.ok(!text.includes(secret), `${label} contains a secret value`);
  }
}

async function ids(path, token) {
  const response = await api(path, token);
  assert.equal(response.status, 200, response.text);
  return response.body;
}

let fixture = null;
let fixtureApi = null;
let unconfiguredApi = null;
let liveApi = null;
let demo = null;
let other = null;

try {
  demo = await demoToken();
  other = await otherUserToken();

  // --- 0. environment -----------------------------------------------------------
  await check(
    "clean state: migrations 0001-0010 applied and every public table has RLS",
    async () => {
      const tables = Number(
        await sql(
          "select count(*) from pg_tables where schemaname = 'public';",
        ),
      );
      assert.ok(tables >= 28, `expected at least 28 tables, found ${tables}`);
      const withoutRls = await sql(
        "select coalesce(string_agg(c.relname, ','), '') from pg_class c where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity;",
      );
      assert.equal(withoutRls, "", `tables without RLS: ${withoutRls}`);
      const seed = await sql(
        `select count(*) from trips where id = '${TRIP}';`,
      );
      assert.equal(seed, "1", "the demo trip seed is missing");
    },
  );

  // --- 1. provider smoke test ---------------------------------------------------
  let smokeSummary = "skipped (--skip-smoke)";
  if (!skipSmoke) {
    const smoke = spawnSync(
      "bash",
      [
        "-c",
        "set -a; . ./.env.local; set +a; bash scripts/provider-smoke-test.sh",
      ],
      { cwd: root, encoding: "utf8", timeout: 240_000 },
    );
    const lines = smoke.stdout
      .split("\n")
      .filter(
        (line) =>
          line.startsWith("PASS") ||
          line.startsWith("FAIL") ||
          line.startsWith("BLOCKED") ||
          line.startsWith("RESULT") ||
          line.includes("diagnostic:"),
      );
    smokeSummary = lines.join("\n");
    console.log(`\nLIVE provider smoke test:\n${smokeSummary}\n`);
    const brightDataName =
      "LIVE: Bright Data SERP request returns Full JSON with organic results";
    const brightDataPassed = lines.some(
      (line) => line.startsWith("PASS") && line.includes("Bright Data"),
    );
    const brightDataRejected = lines.some(
      (line) => line.includes("diagnostic:") && line.includes("x-brd-"),
    );
    if (brightDataPassed) {
      await check(brightDataName, async () => {});
    } else if (brightDataRejected) {
      // Observed live: the same request succeeds on some calls and is rejected on others.
      // The backend maps a rejection to an explicit error (checked below). By policy
      // nothing retries, so this run records the outcome as not verified.
      blocked(
        brightDataName,
        "the provider rejected this single request (reason in x-brd-* headers, see the smoke output); not retried by policy; rerun to try again",
      );
      notes.push(
        "LIVE Bright Data smoke request was rejected by the provider in this run. Other runs of the same request returned 22 KB of Full JSON; the provider is intermittent.",
      );
    } else {
      await check(brightDataName, async () => {
        assert.fail(`smoke test did not pass Bright Data:\n${smokeSummary}`);
      });
    }
    await check(
      "LIVE: Vultr Serverless Inference tool call and structured output",
      async () => {
        assert.ok(
          lines.some(
            (line) => line.startsWith("PASS") && line.includes("tool call"),
          ),
        );
        assert.ok(
          lines.some(
            (line) =>
              line.startsWith("PASS") && line.includes("structured output"),
          ),
        );
      },
    );
    for (const line of lines.filter((entry) => entry.startsWith("BLOCKED"))) {
      blocked(line.slice("BLOCKED: ".length), "not needed by the core demo");
    }
  }

  // --- 2. provider unavailable (no configuration) -------------------------------
  unconfiguredApi = await startApi({
    BRIGHT_DATA_API_KEY: "",
    BRIGHT_DATA_SERP_ZONE: "",
    BRIGHT_DATA_UNLOCKER_ZONE: "",
    BRIGHT_DATA_ENDPOINT_OVERRIDE: "",
  });
  await check(
    "provider unavailable: missing Bright Data configuration is an explicit 503, not an empty list",
    async () => {
      process.env.API_BASE_URL = unconfiguredApi.base;
      const result = await api(`/trips/${TRIP}/event-discoveries`, demo, {
        method: "POST",
        body: discoveryBody("unconfigured_events"),
      });
      assert.equal(result.status, 503, result.text);
      assert.equal(result.body.error.code, "EXTERNAL_CONFIGURATION_MISSING");
      assert.ok(result.body.error.request_id, "the error carries a request id");
      assert.equal(result.body.items, undefined, "no item list is returned");
      assertNoSecrets(result.text, "unconfigured error response");
    },
  );

  // --- 3. FIXTURE golden path ---------------------------------------------------
  fixture = await startBrightDataFixture();
  fixtureApi = await startApi(brightDataFixtureEnv(fixture));
  process.env.API_BASE_URL = fixtureApi.base;
  notes.push(
    "FIXTURE: sections 3 to 7 run against scripts/lib/harness.mjs (schema.org Event markup). They are not live Bright Data results.",
  );

  let discovery = null;
  await check(
    "FIXTURE golden path: sign in, open the demo trip, and choose a context point",
    async () => {
      const me = await api("/auth/me", demo);
      assert.equal(me.status, 200);
      const trips = await ids("/trips", demo);
      assert.ok(trips.items.some((trip) => trip.id === TRIP));
      const points = await ids(`/trips/${TRIP}/context-points`, demo);
      const jcc = points.items.find((point) => point.id === JCC);
      assert.ok(jcc, "the Jakarta Convention Center context point exists");
      assert.equal(jcc.resolution_status, "resolved");
    },
  );

  await check(
    "FIXTURE golden path: event discovery returns validated, sourced events and drops cancelled and off-site ones",
    async () => {
      const result = await api(`/trips/${TRIP}/event-discoveries`, demo, {
        method: "POST",
        body: discoveryBody("fixture_events"),
      });
      assert.equal(result.status, 200, result.text);
      discovery = result.body;
      assert.equal(discovery.items.length, 2, JSON.stringify(discovery.items));
      for (const item of discovery.items) {
        assert.ok(item.starts_at, "start time present");
        assert.ok(!Number.isNaN(Date.parse(item.starts_at)), "valid timestamp");
        assert.equal(
          Date.parse(item.starts_at) % 60_000,
          0,
          "whole-minute start",
        );
        assert.equal(item.status, "suggested");
        assert.ok(item.source_ids.length > 0, "each event has a source");
      }
      assert.ok(discovery.sources.length > 0);
      for (const source of discovery.sources) {
        assert.ok(source.url, "source URL present");
        assert.ok(source.retrieved_at, "retrieval time present");
        assert.equal(source.freshness, "fresh");
      }
      assert.ok(discovery.retrieved_at);
      assert.ok(discovery.expires_at);
      const titles = discovery.items.map((item) => item.title).join("|");
      assert.ok(!titles.includes("Cancelled"));
      assert.ok(!titles.includes("Bandung"));
      // No raw provider payload and no secret reaches the client.
      for (const rawKey of ['"organic"', '"general"', "ld+json", "<html"]) {
        assert.ok(
          !result.text.includes(rawKey),
          `raw provider data leaked: ${rawKey}`,
        );
      }
      assertNoSecrets(result.text, "discovery response");
      notes.push(
        `FIXTURE discovery: 2 events kept; the fixture page also held a cancelled event and an event at another venue, both dropped. Limitations reported: ${JSON.stringify(discovery.limitations ?? [])}`,
      );
    },
  );

  await check(
    "FIXTURE golden path: a repeated search inside the validity window uses the stored result (no provider call)",
    async () => {
      const before = fixture.state.requests.length;
      const again = await api(`/trips/${TRIP}/event-discoveries`, demo, {
        method: "POST",
        body: discoveryBody("fixture_events"),
      });
      assert.equal(again.status, 200, again.text);
      assert.equal(
        fixture.state.requests.length,
        before,
        "the provider was not called again",
      );
      assert.deepEqual(
        again.body.items.map((item) => item.id).sort(),
        discovery.items.map((item) => item.id).sort(),
      );
    },
  );

  let quote = null;
  let booking = null;
  await check(
    "FIXTURE golden path: the server quotes the price and creates a pending booking with the same amounts",
    async () => {
      const quoted = await api(
        `/trips/${TRIP}/booking-quote?booking_type=event`,
        demo,
      );
      assert.equal(quoted.status, 200, quoted.text);
      quote = quoted.body;
      assert.equal(quote.currency, "IDR");
      assert.equal(quote.total, quote.subtotal + quote.tax);
      const event = discovery.items[0];
      const created = await api(`/trips/${TRIP}/bookings`, demo, {
        method: "POST",
        body: {
          booking_type: "event",
          source_type: "event_discovery_result",
          source_id: event.id,
          starts_at: event.starts_at,
          ...(event.ends_at ? { ends_at: event.ends_at } : {}),
        },
      });
      assert.equal(created.status, 201, created.text);
      booking = created.body;
      createdBookingIds.push(booking.id);
      assert.equal(
        booking.status,
        "pending_payment",
        "a new booking is never confirmed",
      );
      assert.equal(booking.total, quote.total);
      assert.equal(booking.pricing_policy, quote.policy_version);
      assert.equal(booking.confirmation_code, undefined);
    },
  );

  await check(
    "FIXTURE golden path: a client cannot set the price",
    async () => {
      const event = discovery.items[1];
      const attempt = await api(`/trips/${TRIP}/bookings`, demo, {
        method: "POST",
        body: {
          booking_type: "event",
          source_type: "event_discovery_result",
          source_id: event.id,
          currency: "IDR",
          subtotal: 1,
          tax: 0,
          total: 1,
        },
      });
      assert.equal(attempt.status, 400, attempt.text);
      assert.equal(attempt.body.error.code, "BOOKING_INVALID");
    },
  );

  await check(
    "FIXTURE golden path: dummy payment success confirms the booking",
    async () => {
      const paid = await api(
        `/trips/${TRIP}/bookings/${booking.id}/payments`,
        demo,
        {
          method: "POST",
          body: { outcome: "succeeded" },
        },
      );
      assert.equal(paid.status, 201, paid.text);
      assert.equal(paid.body.payment.status, "succeeded");
      assert.equal(paid.body.payment.amount, quote.total);
      assert.equal(paid.body.payment.mode, "simulated");
      assert.equal(paid.body.booking.status, "confirmed");
      assert.ok(
        paid.body.booking.confirmation_code,
        "a confirmation code is issued",
      );
      const stored = await ids(`/trips/${TRIP}/bookings/${booking.id}`, demo);
      assert.equal(stored.status, "confirmed");
      const payments = await ids(
        `/trips/${TRIP}/bookings/${booking.id}/payments`,
        demo,
      );
      assert.equal(payments.items.length, 1);
    },
  );

  // --- 4. payment failure -------------------------------------------------------
  await check(
    "FIXTURE payment failure: a declined payment never produces a confirmed booking",
    async () => {
      const event = discovery.items[1];
      const created = await api(`/trips/${TRIP}/bookings`, demo, {
        method: "POST",
        body: {
          booking_type: "event",
          source_type: "event_discovery_result",
          source_id: event.id,
          starts_at: event.starts_at,
        },
      });
      assert.equal(created.status, 201, created.text);
      createdBookingIds.push(created.body.id);
      const failed = await api(
        `/trips/${TRIP}/bookings/${created.body.id}/payments`,
        demo,
        {
          method: "POST",
          body: { outcome: "failed", failure_code: "DEMO_DECLINED" },
        },
      );
      assert.equal(failed.status, 201, failed.text);
      assert.equal(failed.body.payment.status, "failed");
      assert.notEqual(failed.body.booking.status, "confirmed");
      assert.equal(failed.body.booking.confirmation_code, undefined);
      const refreshed = await ids(
        `/trips/${TRIP}/bookings/${created.body.id}`,
        demo,
      );
      assert.notEqual(refreshed.status, "confirmed");
      assert.equal(
        await sql(
          `select count(*) from payments where booking_id = '${created.body.id}' and status = 'succeeded';`,
        ),
        "0",
      );
    },
  );

  // --- 5. ownership -------------------------------------------------------------
  await check(
    "ownership: another user cannot read or change this trip, its events, bookings, or payments",
    async () => {
      const reads = [
        `/trips/${TRIP}`,
        `/trips/${TRIP}/bookings`,
        `/trips/${TRIP}/bookings/${booking.id}`,
        `/trips/${TRIP}/bookings/${booking.id}/payments`,
        `/trips/${TRIP}/context-points`,
      ];
      for (const path of reads) {
        const response = await api(path, other);
        assert.ok(
          [403, 404].includes(response.status),
          `${path} -> ${response.status}`,
        );
        assert.equal(response.body?.items, undefined, `${path} returned data`);
        assert.equal(response.body?.id, undefined, `${path} returned a record`);
      }
      const discover = await api(`/trips/${TRIP}/event-discoveries`, other, {
        method: "POST",
        body: discoveryBody("fixture_events"),
      });
      assert.ok(
        [403, 404].includes(discover.status),
        `discovery -> ${discover.status}`,
      );
      const book = await api(`/trips/${TRIP}/bookings`, other, {
        method: "POST",
        body: {
          booking_type: "event",
          source_type: "event_discovery_result",
          source_id: discovery.items[0].id,
        },
      });
      assert.ok([403, 404].includes(book.status), `booking -> ${book.status}`);
      const pay = await api(
        `/trips/${TRIP}/bookings/${booking.id}/payments`,
        other,
        {
          method: "POST",
          body: { outcome: "failed" },
        },
      );
      assert.ok([403, 404].includes(pay.status), `payment -> ${pay.status}`);
      const refund = await api(
        `/trips/${TRIP}/bookings/${booking.id}/payments/${randomId()}/refund`,
        other,
        { method: "POST", body: {} },
      );
      assert.ok(
        [403, 404].includes(refund.status),
        `refund -> ${refund.status}`,
      );
      const list = await api("/trips", other);
      assert.equal(list.status, 200);
      assert.ok(!list.body.items.some((trip) => trip.id === TRIP));
      const unauth = await fetch(`${fixtureApi.base}/trips/${TRIP}`);
      assert.equal(unauth.status, 401);
      // Row level security itself, bypassing the API.
      const direct = await fetch(
        `${env.SUPABASE_URL}/rest/v1/bookings?select=id`,
        {
          headers: {
            apikey: env.SUPABASE_ANON_KEY,
            authorization: `Bearer ${other}`,
          },
        },
      );
      assert.deepEqual(await direct.json(), []);
      assert.equal(
        await sql(`select status from bookings where id = '${booking.id}';`),
        "confirmed",
        "the booking was not changed by the other user",
      );
    },
  );

  // --- 6. provider failure ------------------------------------------------------
  await check(
    "FIXTURE provider failure: a rejected search is an explicit error with no events (HTTP 200 + empty body + header, as observed live)",
    async () => {
      fixture.state.mode = "captcha";
      try {
        const result = await api(`/trips/${TRIP}/event-discoveries`, demo, {
          method: "POST",
          body: discoveryBody("fixture_captcha"),
        });
        assert.equal(result.status, 502, result.text);
        assert.equal(result.body.error.code, "EXTERNAL_PROVIDER_REJECTED");
        assert.equal(result.body.error.details?.provider_error_code, "captcha");
        assert.equal(result.body.items, undefined);
        assertNoSecrets(result.text, "provider failure response");
        const stored = await sql(
          "select count(*) from event_discovery_results where title like '%fixture_captcha%';",
        );
        assert.equal(stored, "0");
      } finally {
        fixture.state.mode = "ok";
      }
    },
  );

  await check(
    "FIXTURE provider failure: a search with no results is a valid empty answer, distinct from an error",
    async () => {
      fixture.state.mode = "no-results";
      try {
        const result = await api(`/trips/${TRIP}/event-discoveries`, demo, {
          method: "POST",
          body: discoveryBody("fixture_no_results"),
        });
        assert.equal(result.status, 200, result.text);
        assert.deepEqual(result.body.items, []);
        assert.ok(
          (result.body.limitations ?? []).length > 0,
          "the empty answer explains itself",
        );
      } finally {
        fixture.state.mode = "ok";
      }
    },
  );

  await check(
    "FIXTURE provider failure: a booking cannot be made from an event that does not exist",
    async () => {
      const result = await api(`/trips/${TRIP}/bookings`, demo, {
        method: "POST",
        body: {
          booking_type: "event",
          source_type: "event_discovery_result",
          source_id: randomId(),
        },
      });
      assert.equal(result.status, 409, result.text);
      assert.equal(result.body.error.code, "BOOKING_RESOURCE_MISMATCH");
    },
  );

  // --- 7. duplicate mutations ---------------------------------------------------
  await check(
    "duplicate mutation: the same Idempotency-Key and body returns the same booking (one row)",
    async () => {
      const created = await api(`/trips/${TRIP}/event-discoveries`, demo, {
        method: "POST",
        body: discoveryBody("fixture_events_dup"),
      });
      assert.equal(created.status, 200, created.text);
      const event = created.body.items[0];
      const body = {
        booking_type: "event",
        source_type: "event_discovery_result",
        source_id: event.id,
      };
      const key = `task07-dup-${Date.now()}-0123456789`;
      const first = await api(`/trips/${TRIP}/bookings`, demo, {
        method: "POST",
        body,
        idempotencyKey: key,
      });
      const second = await api(`/trips/${TRIP}/bookings`, demo, {
        method: "POST",
        body,
        idempotencyKey: key,
      });
      assert.equal(first.status, 201, first.text);
      assert.equal(second.status, 201, second.text);
      assert.equal(
        second.body.id,
        first.body.id,
        "replay returns the stored booking",
      );
      createdBookingIds.push(first.body.id);
      assert.equal(
        await sql(
          `select count(*) from bookings where trip_id = '${TRIP}' and source_id = '${event.id}';`,
        ),
        "1",
      );
      // Same key, different request.
      const conflict = await api(`/trips/${TRIP}/bookings`, demo, {
        method: "POST",
        body: { ...body, source_id: discovery.items[1].id },
        idempotencyKey: key,
      });
      assert.equal(conflict.status, 409, conflict.text);
      assert.equal(conflict.body.error.code, "IDEMPOTENCY_CONFLICT");
      // A new key for a source that already has an active booking.
      const duplicate = await api(`/trips/${TRIP}/bookings`, demo, {
        method: "POST",
        body,
      });
      assert.equal(duplicate.status, 409, duplicate.text);
      // Payment replay with the same key does not create a second payment.
      const payKey = `task07-pay-${Date.now()}-0123456789`;
      const pay1 = await api(
        `/trips/${TRIP}/bookings/${first.body.id}/payments`,
        demo,
        {
          method: "POST",
          body: { outcome: "succeeded" },
          idempotencyKey: payKey,
        },
      );
      const pay2 = await api(
        `/trips/${TRIP}/bookings/${first.body.id}/payments`,
        demo,
        {
          method: "POST",
          body: { outcome: "succeeded" },
          idempotencyKey: payKey,
        },
      );
      assert.equal(pay1.status, 201, pay1.text);
      assert.equal(pay2.status, 201, pay2.text);
      assert.equal(pay2.body.payment.id, pay1.body.payment.id);
      // A second successful payment with a new key is refused.
      const third = await api(
        `/trips/${TRIP}/bookings/${first.body.id}/payments`,
        demo,
        {
          method: "POST",
          body: { outcome: "succeeded" },
        },
      );
      assert.equal(third.status, 409, third.text);
      assert.equal(
        await sql(
          `select count(*) from payments where booking_id = '${first.body.id}' and status = 'succeeded';`,
        ),
        "1",
      );
      const missingKey = await fetch(
        `${fixtureApi.base}/trips/${TRIP}/bookings`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${demo}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
      assert.equal(missingKey.status, 400);
    },
  );

  // --- 8. LIVE event discovery ---------------------------------------------------
  let liveSummary = "skipped (--skip-live)";
  if (!skipLive) {
    liveApi = await startApi({ BRIGHT_DATA_ENDPOINT_OVERRIDE: "" });
    await check(
      "LIVE: event discovery through the real Bright Data ends in events or an explicit, structured outcome",
      async () => {
        process.env.API_BASE_URL = liveApi.base;
        const started = Date.now();
        const result = await api(`/trips/${TRIP}/event-discoveries`, demo, {
          method: "POST",
          body: discoveryBody("business_events"),
        });
        const seconds = Math.round((Date.now() - started) / 1000);
        assertNoSecrets(result.text, "live discovery response");
        assert.ok(result.body, `non-JSON answer: ${result.text.slice(0, 200)}`);
        if (result.status === 200) {
          assert.ok(Array.isArray(result.body.items));
          for (const source of result.body.sources) {
            assert.ok(
              source.url && source.retrieved_at,
              "every source has a URL and retrieval time",
            );
          }
          liveSummary = `HTTP 200 in ${seconds}s: ${result.body.items.length} event(s), ${result.body.sources.length} source(s). Limitations: ${JSON.stringify(result.body.limitations ?? [])}`;
        } else {
          assert.ok(result.body.error?.code, "failure has an error code");
          assert.ok(result.body.error?.request_id, "failure has a request id");
          assert.equal(result.body.items, undefined);
          liveSummary = `HTTP ${result.status} in ${seconds}s: ${result.body.error.code} (${result.body.error.message})`;
        }
        console.log(`      live outcome: ${liveSummary}`);
      },
    );
    process.env.API_BASE_URL = fixtureApi.base;
  }

  // --- result file -----------------------------------------------------------------
  const results = getResults();
  const failed = results.filter((entry) => entry.status === "FAIL");
  const passed = results.filter((entry) => entry.status === "PASS");
  const blockedChecks = results.filter((entry) => entry.status === "BLOCKED");
  const decision =
    failed.length === 0
      ? "GO for the core demo backend, with the limitations below."
      : "NO-GO: at least one check failed.";
  mkdirSync(new URL("../docs/validation/", import.meta.url), {
    recursive: true,
  });
  const report = [
    "# Task 07 validation result",
    "",
    `Run started ${startedAt}. Command: \`node --env-file=.env.local scripts/validate-task-07.mjs\`.`,
    "",
    `**Result:** ${passed.length} passed, ${failed.length} failed, ${blockedChecks.length} blocked.`,
    "",
    `**Decision:** ${decision}`,
    "",
    "## Live provider smoke test",
    "",
    "```text",
    smokeSummary,
    "```",
    "",
    "## Live event discovery (real Bright Data)",
    "",
    liveSummary,
    "",
    "## Checks",
    "",
    ...results.map(
      (entry) =>
        `- ${entry.status}: ${entry.name}${entry.error ? `\n  - ${entry.error}` : ""}${entry.reason ? ` (${entry.reason})` : ""}`,
    ),
    "",
    "## Notes",
    "",
    ...notes.map((note) => `- ${note}`),
    "",
  ].join("\n");
  writeFileSync(
    new URL("../docs/validation/task-07-result.md", import.meta.url),
    report,
  );
  console.log("\nWrote docs/validation/task-07-result.md");
} finally {
  // --- cleanup ---------------------------------------------------------------------
  try {
    if (createdBookingIds.length > 0) {
      const list = createdBookingIds.map((id) => `'${id}'`).join(",");
      await sql(`
        delete from background_jobs where payload->>'booking_id' in (${list});
        delete from payments where booking_id in (${list});
        delete from bookings where id in (${list});`);
    }
    await sql(`
      delete from event_discovery_results where run_id in (
        select id from event_discovery_runs where left(category, 8) = 'fixture_' or category = 'unconfigured_events');
      delete from event_discovery_runs where left(category, 8) = 'fixture_' or category = 'unconfigured_events';
      delete from event_discovery_results where run_id in (
        select id from event_discovery_runs where category = 'business_events' and retrieved_at >= '${startedAt}');
      delete from event_discovery_runs where category = 'business_events' and retrieved_at >= '${startedAt}';
      delete from source_references where source_id in (select id from sources where retrieved_at >= '${startedAt}' and provider = 'bright_data');
      delete from sources where retrieved_at >= '${startedAt}' and provider = 'bright_data';
      delete from source_references where source_id in (select id from sources where left(url, 17) = 'http://127.0.0.1:');
      delete from sources where left(url, 17) = 'http://127.0.0.1:';`);
  } catch (error) {
    console.error(
      `cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  stopAll();
  if (fixture) await fixture.close();
}

const failedCount = getResults().filter(
  (entry) => entry.status === "FAIL",
).length;
const passedCount = getResults().filter(
  (entry) => entry.status === "PASS",
).length;
const blockedCount = getResults().filter(
  (entry) => entry.status === "BLOCKED",
).length;
console.log(
  `\nRESULT: ${passedCount} passed, ${failedCount} failed, ${blockedCount} blocked`,
);
process.exit(failedCount > 0 ? 1 : 0);

function randomId() {
  return crypto.randomUUID();
}
