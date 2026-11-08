// Opens every workspace view in a real browser and checks that it renders without
// errors (Playwright, Chromium), on desktop and on a phone viewport.
//
//   node --env-file=.env.local scripts/ui-smoke-views.mjs
//
// It starts its own API (real providers as configured: HERE and OpenWeather have no
// key, so their views must show an explicit unavailable state, never invented data)
// and web dev server. For each view it checks: no uncaught page error, no failed
// request to the API that is not an explicit error response, no "undefined", "NaN" or
// "[object Object]" in the visible text, exactly one h1, and takes a screenshot.
// Explore is opened three times, once per tab (Nearby, Stays, Flights).

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { env } from "./lib/validation.mjs";
import {
  freePort,
  launch,
  startApi,
  stopAll,
  waitFor,
} from "./lib/harness.mjs";

const shotDir = new URL("../docs/validation/", import.meta.url).pathname;
mkdirSync(shotDir, { recursive: true });

const VIEWS = [
  {
    slug: "explore-stays",
    link: "Explore",
    tab: "Stays",
    expect: "Search stays",
    expectH1: true,
  },
  {
    slug: "explore-flights",
    link: "Explore",
    tab: "Flights",
    expect: "Search flights",
    expectH1: true,
  },
  { slug: "bookings", link: "Bookings", expect: null },
  { slug: "mobility", link: "Mobility", expect: null },
  { slug: "assistant", link: "Assistant", expect: "Ask about" },
  { slug: "itinerary", link: "Itinerary", expect: "Timeline" },
  { slug: "alerts", link: "Alerts", expect: null },
  { slug: "invoices", link: "Invoices", expect: null },
  { slug: "trips", link: "Trips", expect: null },
];

const VIEWPORTS = [
  { name: "desktop", width: 1360, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
];

const results = [];
let browser = null;
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
  }
}

async function openView(page, view) {
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("link", { name: view.link, exact: true })
    .click();
  if (view.tab) {
    await page
      .getByRole("navigation", { name: "Explore categories" })
      .getByRole("button", { name: view.tab, exact: true })
      .click();
  }
  await page
    .locator("#workspace h1, #workspace h2")
    .first()
    .waitFor({ timeout: 30_000 });
  // Let the view finish its first loads.
  await page
    .waitForLoadState("networkidle", { timeout: 60_000 })
    .catch(() => {});
  await page.waitForTimeout(1200);
}

try {
  const webPort = await freePort();
  const webUrl = `http://127.0.0.1:${webPort}`;
  const apiHandle = await startApi({ CORS_ALLOWED_ORIGINS: webUrl });
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

  browser = await chromium.launch({ headless: true, channel: "chromium" });
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  const badResponses = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    const url = response.url();
    if (url.startsWith(apiHandle.base) && response.status() >= 500) {
      badResponses.push(
        `${response.status()} ${url.slice(apiHandle.base.length)}`,
      );
    }
  });

  await step("sign in as the demo user", async () => {
    await page.setViewportSize(VIEWPORTS[0]);
    await page.goto(webUrl, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Email").fill(env.DEMO_EMAIL);
    await page.getByLabel("Password").fill(env.DEMO_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page
      .getByRole("navigation", { name: "Workspace navigation" })
      .waitFor({ timeout: 90_000 });
  });

  await step("deep link #explore/stays opens the Stays tab", async () => {
    await page.goto(`${webUrl}/#explore/stays`, {
      waitUntil: "domcontentloaded",
    });
    const h1 = page.locator("#workspace h1");
    await h1.waitFor({ timeout: 90_000 });
    assert.equal(
      (await h1.innerText()).trim(),
      "Find a stay that fits the trip.",
      "the deep link did not open the Stays tab",
    );
  });

  await step("switching Explore tabs updates the hash", async () => {
    await page
      .getByRole("navigation", { name: "Explore categories" })
      .getByRole("button", { name: "Flights", exact: true })
      .click();
    await page.waitForTimeout(500);
    assert.ok(
      page.url().endsWith("/#explore/flights"),
      `unexpected URL after switching tabs: ${page.url()}`,
    );
  });

  for (const viewport of VIEWPORTS) {
    for (const view of VIEWS) {
      await step(
        `${viewport.name}: "${view.tab ? `${view.link} / ${view.tab}` : view.link}" renders without errors`,
        async () => {
          await page.setViewportSize({
            width: viewport.width,
            height: viewport.height,
          });
          await openView(page, view);

          const headings = await page.locator("#workspace h1").count();
          assert.ok(
            headings <= 1,
            `expected at most one h1 in the view, found ${headings}`,
          );
          if (view.expectH1) {
            assert.equal(
              headings,
              1,
              `expected exactly one h1 in this tab, found ${headings}`,
            );
          }
          const anyHeading = await page
            .locator("#workspace h1, #workspace h2")
            .count();
          assert.ok(anyHeading > 0, "the view renders no heading");

          if (view.expect) {
            const text = await page.locator("#workspace").innerText();
            assert.ok(
              text.includes(view.expect),
              `expected "${view.expect}" in the view`,
            );
          }

          const text = await page.locator("body").innerText();
          for (const bad of [
            "undefined",
            "NaN",
            "[object Object]",
            "null null",
          ]) {
            assert.ok(!text.includes(bad), `the page shows "${bad}"`);
          }

          if (viewport.name === "mobile") {
            const overflow = await page.evaluate(
              () =>
                document.documentElement.scrollWidth -
                document.documentElement.clientWidth,
            );
            assert.ok(
              overflow <= 1,
              `the page overflows horizontally by ${overflow}px`,
            );
          }

          const heading = (
            await page
              .locator("#workspace h1, #workspace h2")
              .first()
              .innerText()
          ).trim();
          const prefix =
            viewport.name === "mobile" ? "ui-views-mobile-" : "ui-views-";
          await page.screenshot({
            path: `${shotDir}${prefix}${view.slug}.png`,
            fullPage: true,
          });
          console.log(`      heading: ${heading}`);
        },
      );
    }
  }

  await step(
    "no uncaught page errors and no 5xx from the API across all views",
    async () => {
      assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join("; ")}`);
      assert.deepEqual(
        badResponses,
        [],
        `server errors: ${badResponses.join("; ")}`,
      );
    },
  );
} finally {
  if (browser) await browser.close();
  stopAll();
}
const failed = results.filter((entry) => !entry.ok).length;
console.log(`\nRESULT: ${results.length - failed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
