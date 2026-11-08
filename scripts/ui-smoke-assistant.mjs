// Browser smoke test for the Assistant view (Playwright, Chromium).
//
//   CORS_ALLOWED_ORIGINS=http://127.0.0.1:3100 API_PORT=4109 node --env-file=.env.local apps/api/dist/index.js   # in another terminal
//   node --env-file=.env.local scripts/ui-smoke-assistant.mjs               # real providers as configured
//   node --env-file=.env.local scripts/ui-smoke-assistant.mjs --fixture-providers
//
// It signs in as the demo user, opens the Assistant view, picks a place, sends
// "Summarize my trip.", and checks the answer and a card. It also opens the
// confirmation dialog for an event result and confirms it.
//
// FIXTURES, labelled as such everywhere:
//   * The event result and the stored assistant message that shows it are database
//     rows titled "[ui-smoke fixture]". They exist only so the dialog can be
//     exercised without a live Bright Data search. They are removed at the end.
//   * With --fixture-providers the script starts scripts/lib/task08-fixture-server.mjs
//     and its own API instance whose HERE and OpenWeather requests go to that
//     server (the model is still the real Vultr model). Route, weather and traffic
//     cards seen in that mode are fixture data, not live provider data.
//
// Screenshots go to docs/validation/. The script exits non-zero when a check fails.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { api, demoToken, DEMO_TRIP_ID, env, sql } from "./lib/validation.mjs";
import { startFixtureServer } from "./lib/task08-fixture-server.mjs";

const TRIP = DEMO_TRIP_ID;
const JCC = "00000000-0000-0000-0000-000000000012";
const useFixtureProviders = process.argv.includes("--fixture-providers");
const webPort = Number(env.WEB_PORT ?? 3100);
const webUrl = `http://127.0.0.1:${webPort}`;
const shotDir = new URL("../docs/validation/", import.meta.url).pathname;
const shotPrefix = useFixtureProviders
  ? "ui-assistant-fixture-providers"
  : "ui-assistant";
const startedAt = new Date().toISOString();
mkdirSync(shotDir, { recursive: true });

const results = [];
let activePage = null;
async function step(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS: ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`FAIL: ${name}`);
    if (activePage) {
      const file = `${shotDir}${shotPrefix}-FAILED-${results.length}.png`;
      await activePage.screenshot({ path: file, fullPage: true });
      console.log(`      screenshot of the failure: ${file}`);
    }
    console.log(
      `      ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const freePort = () =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

async function waitFor(url, label, attempts = 240) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch (error) {
      assert.ok(error instanceof Error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} did not become ready at ${url}`);
}

const processes = [];
function launch(args, extraEnv) {
  const child = spawn(process.execPath, args, {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let log = "";
  child.stdout.on("data", (chunk) => (log += chunk));
  child.stderr.on("data", (chunk) => (log += chunk));
  processes.push(child);
  return { child, log: () => log };
}

let apiBase = env.API_BASE_URL ?? "http://127.0.0.1:4109/api/v1";
let fixtureServer = null;
let browser = null;
let fixtureResultId = null;
let conversationId = null;
const startedAtSql = startedAt;

try {
  if (useFixtureProviders) {
    fixtureServer = await startFixtureServer();
    const port = await freePort();
    launch(["--env-file=.env.local", "apps/api/dist/index.js"], {
      API_PORT: String(port),
      LOG_LEVEL: "warn",
      CORS_ALLOWED_ORIGINS: webUrl,
      HERE_API_KEY: "fixture-here-key",
      HERE_BASE_URL_OVERRIDE: `${fixtureServer.origin}/here`,
      OPENWEATHER_API_KEY: "fixture-owm-key",
      OPENWEATHER_BASE_URL_OVERRIDE: `${fixtureServer.origin}/owm`,
    });
    apiBase = `http://127.0.0.1:${port}/api/v1`;
  }
  env.API_BASE_URL = apiBase; // the validation helpers read it
  await waitFor(`${apiBase}/health`, "API", 120);
  console.log(
    `API: ${apiBase}${useFixtureProviders ? " (FIXTURE HERE and OpenWeather)" : ""}`,
  );

  // Web dev server on 3100 pointing at that API.
  launch(
    [
      "--env-file=.env.local",
      "node_modules/next/dist/bin/next",
      "dev",
      "apps/web",
      "-p",
      String(webPort),
    ],
    {
      NEXT_PUBLIC_API_BASE_URL: apiBase,
    },
  );
  await waitFor(webUrl, "web dev server");

  // --- fixture rows -------------------------------------------------------------
  const token = await demoToken();
  const created = await api(`/trips/${TRIP}/conversations`, token, {
    method: "POST",
    body: { title: "UI smoke (fixture)" },
  });
  assert.equal(created.status, 201, created.text);
  conversationId = created.body.id;
  const ids = (
    await sql(`
    with r as (
      insert into event_discovery_runs (trip_id, context_point_id, request_id, request_fingerprint, category,
        observed_from, observed_to, timezone, status, retrieved_at, expires_at, metadata)
      values ('${TRIP}', '${JCC}', 'ui-smoke-${randomUUID()}', 'ui-smoke-${randomUUID()}', 'business_events',
        now(), now() + interval '1 day', 'Asia/Jakarta', 'ok', now(), now() + interval '6 hours',
        '{"ui_smoke_fixture": true}'::jsonb)
      returning id),
    s as (
      insert into sources (trip_id, kind, provider, url, title, retrieved_at, freshness, expires_at, metadata)
      values ('${TRIP}', 'search_result', 'ui_smoke_fixture', 'https://example.com/ui-smoke-fixture',
        '[ui-smoke fixture] source', now(), 'fresh', now() + interval '6 hours', '{"ui_smoke_fixture": true}'::jsonb)
      returning id)
    insert into event_discovery_results (run_id, trip_id, context_point_id, source_id, title, starts_at, ends_at,
      category, retrieved_at, expires_at, metadata)
    select r.id, '${TRIP}', '${JCC}', s.id, '[ui-smoke fixture] Networking Evening', now() + interval '3 days',
      now() + interval '3 days 2 hours', 'business_events', now(), now() + interval '6 hours',
      '{"ui_smoke_fixture": true}'::jsonb
    from r, s returning id, source_id;`)
  )
    .split("\n")[0]
    .split("|");
  fixtureResultId = ids[0];
  const sourceId = ids[1];
  const nowIso = new Date().toISOString();
  const fixtureResponse = {
    message: "FIXTURE: one stored event result for the UI smoke test.",
    intent: "find_nearby_event",
    context: {
      context_point_ids: [JCC],
      agenda_item_ids: [],
      event_result_ids: [fixtureResultId],
    },
    cards: [
      {
        type: "event",
        id: fixtureResultId,
        title: "[ui-smoke fixture] Networking Evening",
        subtitle: "Jakarta Convention Center",
        status: "suggested",
        starts_at: new Date(Date.now() + 3 * 86400_000).toISOString(),
        ends_at: new Date(Date.now() + 3 * 86400_000 + 7200_000).toISOString(),
        fields: [{ label: "Category", value: "business_events" }],
        source_ids: [sourceId],
        retrieved_at: nowIso,
        actions: [{ action: "save_event_result", label: "Add to itinerary" }],
      },
    ],
    facts: [],
    recommendations: [],
    clarification: null,
    confirmation_request: null,
    sources: [
      {
        id: sourceId,
        kind: "search_result",
        provider: "ui_smoke_fixture",
        url: "https://example.com/ui-smoke-fixture",
        title: "[ui-smoke fixture] source",
        retrieved_at: nowIso,
        freshness: "fresh",
      },
    ],
    limitations: [
      "FIXTURE row created by scripts/ui-smoke-assistant.mjs. It is not live data.",
    ],
    follow_up_actions: [],
    freshness_status: "fresh",
    retrieved_at: nowIso,
  };
  await sql(`
    insert into conversation_messages (conversation_id, trip_id, role, content, status)
    values ('${conversationId}', '${TRIP}', 'user', 'Show me events at the JCC (fixture)', 'received');
    insert into conversation_messages (conversation_id, trip_id, role, content, status, intent, request_id, execution_id, response)
    values ('${conversationId}', '${TRIP}', 'assistant', 'FIXTURE: one stored event result for the UI smoke test.', 'completed',
      'find_nearby_event', 'ui-smoke-${randomUUID()}', '${randomUUID()}', $json$${JSON.stringify(fixtureResponse)}$json$::jsonb);`);

  browser = await chromium.launch({ headless: true, channel: "chromium" });
  const page = await browser.newPage({
    viewport: { width: 1360, height: 1000 },
  });
  activePage = page;
  const consoleErrors = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  const shot = (name) =>
    page.screenshot({
      path: `${shotDir}${shotPrefix}-${name}.png`,
      fullPage: true,
    });

  await step("sign in as the demo user", async () => {
    await page.goto(webUrl, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Email").fill(env.DEMO_EMAIL);
    await page.getByLabel("Password").fill(env.DEMO_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page
      .getByRole("navigation", { name: "Workspace navigation" })
      .waitFor({ timeout: 60_000 });
  });

  await step(
    "open the Assistant view and choose the Jakarta Convention Center",
    async () => {
      await page
        .getByRole("navigation", { name: "Workspace navigation" })
        .getByRole("link", { name: "Assistant" })
        .click();
      await page
        .getByRole("heading", { name: "Ask about" })
        .waitFor({ timeout: 30_000 });
      await page
        .locator("label.asst-chip", { hasText: "Jakarta Convention Center" })
        .click();
      await page.getByText("(about Jakarta Convention Center)").waitFor();
      await page
        .locator(".asst-msg.assistant")
        .first()
        .waitFor({ timeout: 30_000 });
      await shot("1-assistant-opened");
    },
  );

  const fixtureCard = page.locator('[data-card-type="event"]', {
    hasText: "[ui-smoke fixture] Networking Evening",
  });
  await step("confirmation dialog: cancel changes nothing", async () => {
    await fixtureCard.getByRole("button", { name: "Add to itinerary" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ timeout: 30_000 });
    assert.ok((await dialog.innerText()).includes("PLEASE CONFIRM"));
    assert.ok(
      (await dialog.innerText()).includes("Nothing changes until you confirm"),
    );
    await shot("2-confirm-dialog");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "hidden" });
    const status = await sql(
      `select status from event_discovery_results where id='${fixtureResultId}';`,
    );
    assert.equal(status, "suggested");
    const agenda = await sql(
      `select count(*) from agenda_items where trip_id='${TRIP}' and metadata->>'event_discovery_result_id'='${fixtureResultId}';`,
    );
    assert.equal(agenda, "0");
  });

  await step("confirmation dialog: confirm adds the item once", async () => {
    await fixtureCard.getByRole("button", { name: "Add to itinerary" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ timeout: 30_000 });
    await dialog.getByRole("button", { name: "Confirm" }).click();
    await page
      .getByText("Done. The item was added to your itinerary.")
      .waitFor({ timeout: 30_000 });
    await shot("3-confirmed");
    const status = await sql(
      `select status from event_discovery_results where id='${fixtureResultId}';`,
    );
    assert.equal(status, "selected");
    const agenda = await sql(
      `select count(*) from agenda_items where trip_id='${TRIP}' and metadata->>'event_discovery_result_id'='${fixtureResultId}';`,
    );
    assert.equal(agenda, "1");
    assert.equal(
      await fixtureCard
        .getByRole("button", { name: "Add to itinerary" })
        .count(),
      0,
    );
  });

  async function ask(text) {
    const before = await page
      .locator(".asst-msg.assistant, .asst-msg.failed")
      .count();
    await page.locator("#asst-input").fill(text);
    await page.getByRole("button", { name: "Send" }).click();
    await page.waitForFunction(
      (count) =>
        document.querySelectorAll(".asst-msg.assistant, .asst-msg.failed")
          .length > count || document.querySelector(".asst-failure"),
      before,
      { timeout: 120_000 },
    );
  }

  await step(
    'send "Summarize my trip." and see the answer with a card',
    async () => {
      await ask("Summarize my trip.");
      const failure = await page.locator(".asst-failure").count();
      assert.equal(
        failure,
        0,
        "the question failed: " +
          (failure ? await page.locator(".asst-failure").innerText() : ""),
      );
      const last = page.locator(".asst-msg.assistant").last();
      const text = await last.locator("p").first().innerText();
      assert.ok(text.length > 20, "an answer is shown");
      const cards = last.locator(".asst-card");
      assert.ok((await cards.count()) >= 1, "at least one card is shown");
      const firstCard = await cards.first().innerText();
      assert.ok(
        firstCard.includes("Source") || firstCard.includes("Retrieved"),
        "the card shows its source or retrieval time",
      );
      console.log(`      answer: ${JSON.stringify(text)}`);
      console.log(
        `      cards: ${(await cards.allInnerTexts()).map((t) => t.split("\n")[0]).join(" | ")}`,
      );
      await shot("4-summarize-answer");
    },
  );

  await step(
    "a route question shows a card (fixture providers) or a structured error (no key)",
    async () => {
      await ask("How do I get from my hotel to the Jakarta Convention Center?");
      if (useFixtureProviders) {
        const last = page.locator(".asst-msg.assistant").last();
        const routes = last.locator('[data-card-type="route"]');
        assert.ok((await routes.count()) >= 2, "route cards are shown");
        assert.equal(
          await last.locator('[data-card-type="route"].recommended').count(),
          1,
        );
        const text = await routes.first().innerText();
        assert.ok(
          text.includes("Duration") &&
            text.includes("Source") &&
            (text.includes("retrieved") || text.includes("Retrieved")),
        );
        console.log(
          `      FIXTURE route cards: ${(await routes.allInnerTexts()).map((t) => t.split("\n").slice(0, 3).join(" ")).join(" | ")}`,
        );
      } else if (!env.HERE_API_KEY) {
        const banner = page.locator(".asst-failure");
        await banner.waitFor({ timeout: 30_000 });
        const text = await banner.innerText();
        assert.ok(text.includes("EXTERNAL_CONFIGURATION_MISSING"));
        assert.ok(text.includes("No answer was made up"));
        assert.equal(
          await banner.getByRole("button", { name: "Ask again" }).count(),
          0,
        );
        console.log(
          `      structured error shown: ${JSON.stringify(text.split("\n").join(" "))}`,
        );
      } else {
        const last = page.locator(".asst-msg.assistant").last();
        assert.ok(
          (await last.locator('[data-card-type="route"]').count()) >= 1,
        );
      }
      await shot("5-route-question");
    },
  );

  if (useFixtureProviders) {
    await step(
      "weather question shows a weather card with source and time (fixture providers)",
      async () => {
        await ask("What is the weather around the Jakarta Convention Center?");
        const card = page.locator('[data-card-type="weather"]').last();
        await card.waitFor({ timeout: 30_000 });
        const text = await card.innerText();
        assert.ok(text.includes("Now") && text.includes("30 °C"));
        assert.ok(
          text.includes("OpenWeather") &&
            text.toLowerCase().includes("retrieved"),
        );
        await shot("6-weather-question");
      },
    );
  }

  await step("no page error was raised in the browser", async () => {
    assert.deepEqual(consoleErrors, []);
  });
} catch (error) {
  results.push({ name: "harness", ok: false });
  console.log("FAIL: harness");
  console.log(`      ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  if (browser) await browser.close();
  for (const child of processes) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      assert.ok(error instanceof Error);
    }
  }
  if (fixtureServer) await fixtureServer.close();
  const ids = (list) =>
    list.length
      ? list.map((id) => `'${id}'`).join(",")
      : "'00000000-0000-0000-0000-000000000000'";
  try {
    await sql(`
      create temporary table ui_smoke_sources as select id from public.sources where trip_id='${TRIP}' and (provider='ui_smoke_fixture' or ${fixtureServer ? `position('${fixtureServer.origin}' in coalesce(metadata::text,'')) > 0` : "false"});
      delete from public.agenda_items where trip_id='${TRIP}' and metadata->>'event_discovery_result_id' in (${ids(fixtureResultId ? [fixtureResultId] : [])});
      delete from public.assistant_confirmations where trip_id='${TRIP}' and created_at >= '${startedAtSql}';
      delete from public.conversation_messages where trip_id='${TRIP}' and conversation_id in (select id from public.conversations where trip_id='${TRIP}' and created_at >= '${startedAtSql}');
      delete from public.conversations where trip_id='${TRIP}' and created_at >= '${startedAtSql}';
      delete from public.event_discovery_results where metadata->>'ui_smoke_fixture'='true';
      delete from public.event_discovery_runs where metadata->>'ui_smoke_fixture'='true';
      delete from public.source_references where source_id in (select id from ui_smoke_sources);
      delete from public.weather_snapshots where source_id in (select id from ui_smoke_sources);
      delete from public.traffic_snapshots where source_id in (select id from ui_smoke_sources);
      delete from public.sources where id in (select id from ui_smoke_sources);
      delete from public.activity_logs where created_at >= '${startedAtSql}' and (metadata->>'trip_id'='${TRIP}' or resource_id in (${ids(fixtureResultId ? [fixtureResultId] : [])}));
      delete from public.idempotency_records where created_at >= '${startedAtSql}' and left(scope, 10) = 'assistant.';`);
  } catch (error) {
    console.log(`CLEANUP FAILED: ${error.message}`);
    results.push({ name: "cleanup", ok: false });
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nRESULT: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
