// Browser test of the Task 07 core demo golden path (Playwright, Chromium).
//
//   node --env-file=.env.local scripts/ui-golden-path.mjs
//
// Login -> open the demo trip -> choose a context point -> search events -> choose an
// event -> create the internal booking -> dummy payment -> confirmed (and the failure
// path). It starts its own API and web dev server.
//
// FIXTURE: events come from scripts/lib/harness.mjs (schema.org Event markup), a
// stand-in for Bright Data, because the live search currently returns no readable
// event pages (see docs/validation/task-07-result.md). Everything after the search is
// the real backend and the real database. Screenshots go to docs/validation/.

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { DEMO_TRIP_ID, env, sql } from "./lib/validation.mjs";
import {
  brightDataFixtureEnv,
  freePort,
  launch,
  startApi,
  startBrightDataFixture,
  stopAll,
  waitFor,
} from "./lib/harness.mjs";

const TRIP = DEMO_TRIP_ID;
const shotDir = new URL("../docs/validation/", import.meta.url).pathname;
mkdirSync(shotDir, { recursive: true });
const prefix = "ui-golden-path";
const CATEGORY = "ui golden path events";
const FAIL_CATEGORY = "ui golden path rejected";

const results = [];
let page = null;
async function step(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS: ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`FAIL: ${name}`);
    console.log(
      `      ${error instanceof Error ? error.message : String(error)}`,
    );
    if (page) {
      await page.screenshot({
        path: `${shotDir}${prefix}-FAILED-${results.length}.png`,
        fullPage: true,
      });
    }
  }
}

let fixture = null;
let browser = null;
try {
  fixture = await startBrightDataFixture();
  const webPort = await freePort();
  const webUrl = `http://127.0.0.1:${webPort}`;
  const apiHandle = await startApi({
    ...brightDataFixtureEnv(fixture),
    CORS_ALLOWED_ORIGINS: webUrl,
  });
  launch(
    [
      "--env-file=.env.local",
      "node_modules/next/dist/bin/next",
      "dev",
      "apps/web",
      "-p",
      String(webPort),
    ],
    { NEXT_PUBLIC_API_BASE_URL: apiHandle.base },
  );
  await waitFor(webUrl, "web dev server");
  console.log(`API ${apiHandle.base} (FIXTURE Bright Data), web ${webUrl}`);

  browser = await chromium.launch({ headless: true, channel: "chromium" });
  page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const shot = (name) =>
    page.screenshot({
      path: `${shotDir}${prefix}-${name}.png`,
      fullPage: true,
    });

  await step("login with the demo account", async () => {
    await page.goto(webUrl, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Email").fill(env.DEMO_EMAIL);
    await page.getByLabel("Password").fill(env.DEMO_PASSWORD);
    await shot("1-login");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page
      .getByRole("navigation", { name: "Workspace navigation" })
      .waitFor({ timeout: 90_000 });
  });

  await step("the demo trip and its context points are open", async () => {
    const active = page.getByLabel("Active trip");
    await active.waitFor({ timeout: 30_000 });
    assert.equal(
      await active.locator("option:checked").innerText(),
      "Jakarta Business Trip",
    );
    await page
      .locator(".context-option")
      .filter({ hasText: "Jakarta Convention Center" })
      .waitFor();
  });

  await step("choose the Jakarta Convention Center context point", async () => {
    await page
      .locator(".context-option")
      .filter({ hasText: "Jakarta Convention Center" })
      .click();
    await page.getByText("Searching around").waitFor({ timeout: 15_000 });
    const text = await page
      .locator(".helper-text", { hasText: "Searching around" })
      .first()
      .innerText();
    assert.ok(text.includes("Jakarta Convention Center"), text);
  });

  await step(
    "search events (FIXTURE provider) and see sourced results",
    async () => {
      await page.getByLabel("Category").fill(CATEGORY);
      await page.getByRole("button", { name: "Find nearby" }).click();
      await page.locator(".event-card").first().waitFor({ timeout: 90_000 });
      assert.equal(await page.locator(".event-card").count(), 2);
      const titles = await page.locator(".event-card h3").allInnerTexts();
      assert.ok(
        titles.some((title) => title.includes("Indonesia Business Forum")),
      );
      assert.ok(!titles.some((title) => title.includes("Cancelled")));
      assert.ok(!titles.some((title) => title.includes("Bandung")));
      await page.locator(".event-card summary").first().click();
      await page.getByText("Retrieved").first().waitFor();
      await shot("2-events-found");
    },
  );

  await step(
    "no secret and no raw provider payload is visible in the page",
    async () => {
      const html = await page.content();
      for (const secret of [
        env.BRIGHT_DATA_API_KEY,
        env.VULTR_INFERENCE_API_KEY,
        env.SUPABASE_SERVICE_ROLE_KEY,
        env.DEMO_PASSWORD,
      ]) {
        if (secret && secret.length >= 8) {
          assert.ok(
            !html.includes(secret),
            "a secret value appears in the page",
          );
        }
      }
      const text = await page.locator("body").innerText();
      for (const raw of ['"organic"', "ld+json", "x-brd-"]) {
        assert.ok(!text.includes(raw), `raw provider data in the page: ${raw}`);
      }
    },
  );

  await step(
    "review the booking: the price comes from the server",
    async () => {
      await page
        .getByRole("button", { name: "Review booking" })
        .first()
        .click();
      await page
        .locator("#booking-title")
        .filter({ hasText: "Indonesia Business Forum" })
        .waitFor();
      await page.getByText("IDR 275,000").waitFor({ timeout: 15_000 });
      await page.getByText("demo-pricing-v1").waitFor();
      await shot("3-booking-review");
    },
  );

  await step("create the booking: it stays pending until payment", async () => {
    await page.getByRole("button", { name: "Confirm booking details" }).click();
    await page
      .getByRole("button", { name: "Pay successfully" })
      .waitFor({ timeout: 30_000 });
    const status = await page
      .locator(".status-line strong")
      .first()
      .innerText();
    assert.ok(status.toLowerCase().includes("pending"), status);
    const rows = await sql(
      `select status from bookings where trip_id = '${TRIP}' order by created_at desc limit 1;`,
    );
    assert.equal(rows, "pending_payment");
    await shot("4-booking-pending");
  });

  await step("dummy payment success confirms the booking", async () => {
    await page.getByRole("button", { name: "Pay successfully" }).click();
    await page.getByText("Booking confirmed").waitFor({ timeout: 30_000 });
    const rows = await sql(
      `select b.status || '|' || p.status from bookings b join payments p on p.booking_id = b.id where b.trip_id = '${TRIP}' order by b.created_at desc limit 1;`,
    );
    assert.equal(rows, "confirmed|succeeded");
    await shot("5-booking-confirmed");
  });

  await step(
    "payment failure does not confirm the second booking",
    async () => {
      await page
        .getByRole("button", { name: "Review booking" })
        .first()
        .click();
      await page
        .locator("#booking-title")
        .filter({ hasText: "Networking Night" })
        .waitFor();
      assert.equal(
        await page.getByText("Booking confirmed").count(),
        0,
        "the previous booking must not carry over to another event",
      );
      await page
        .getByRole("button", { name: "Confirm booking details" })
        .click();
      await page
        .getByRole("button", { name: "Simulate failure" })
        .waitFor({ timeout: 30_000 });
      await page.getByRole("button", { name: "Simulate failure" }).click();
      await page.getByText("Payment failed").waitFor({ timeout: 30_000 });
      assert.equal(await page.getByText("Booking confirmed").count(), 0);
      const rows = await sql(
        `select b.status || '|' || p.status from bookings b join payments p on p.booking_id = b.id where b.trip_id = '${TRIP}' order by b.created_at desc limit 1;`,
      );
      assert.equal(rows, "failed|failed");
      await shot("6-payment-failed");
    },
  );

  await step(
    "provider failure is shown explicitly, with no events",
    async () => {
      fixture.state.mode = "captcha";
      await page.getByLabel("Category").fill(FAIL_CATEGORY);
      await page.getByRole("button", { name: "Find nearby" }).click();
      await page
        .locator(".status-banner.error, [role=alert]")
        .first()
        .waitFor({ timeout: 90_000 });
      assert.equal(await page.locator(".event-card").count(), 0);
      fixture.state.mode = "ok";
      await shot("7-provider-failure");
    },
  );

  assert.equal(pageErrors.length, 0, `page errors: ${pageErrors.join("; ")}`);
} finally {
  try {
    const runs = `select id from event_discovery_runs where category in ('${CATEGORY}', '${FAIL_CATEGORY}')`;
    const results = `select id from event_discovery_results where run_id in (${runs})`;
    await sql(`
      delete from background_jobs where payload->>'booking_id' in (select id::text from bookings where trip_id = '${TRIP}' and source_id in (${results}));
      delete from payments where booking_id in (select id from bookings where trip_id = '${TRIP}' and source_id in (${results}));
      delete from bookings where trip_id = '${TRIP}' and source_id in (${results});
      delete from event_discovery_results where run_id in (${runs});
      delete from event_discovery_runs where category in ('${CATEGORY}', '${FAIL_CATEGORY}');
      delete from source_references where source_id in (select id from sources where left(url, 17) = 'http://127.0.0.1:');
      delete from sources where left(url, 17) = 'http://127.0.0.1:';`);
  } catch (error) {
    console.error(
      `cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (browser) await browser.close();
  stopAll();
  if (fixture) await fixture.close();
}
const failed = results.filter((entry) => !entry.ok).length;
console.log(`\nRESULT: ${results.length - failed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
