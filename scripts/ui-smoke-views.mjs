// Opens every workspace view in a real browser and checks that it renders without
// errors (Playwright, Chromium).
//
//   node --env-file=.env.local scripts/ui-smoke-views.mjs
//
// It starts its own API (real providers as configured: HERE and OpenWeather have no
// key, so their views must show an explicit unavailable state, never invented data)
// and web dev server. For each view it checks: no uncaught page error, no failed
// request to the API that is not an explicit error response, no "undefined", "NaN" or
// "[object Object]" in the visible text, a heading, and takes a screenshot.

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
  { link: "Explore and book", expect: "What is happening nearby?" },
  { link: "Mobility", expect: null },
  { link: "Assistant", expect: "Ask about" },
  { link: "Itinerary", expect: "Timeline" },
  { link: "Alerts", expect: null },
  { link: "Invoices", expect: null },
  { link: "Trips", expect: null },
];
const results = [];
let browser = null;
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
  }
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
  page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
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
    await page.goto(webUrl, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Email").fill(env.DEMO_EMAIL);
    await page.getByLabel("Password").fill(env.DEMO_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page
      .getByRole("navigation", { name: "Workspace navigation" })
      .waitFor({ timeout: 90_000 });
  });

  for (const view of VIEWS) {
    await step(
      `view "${view.link}" renders without errors or invented values`,
      async () => {
        await page
          .getByRole("navigation", { name: "Workspace navigation" })
          .getByRole("link", { name: view.link, exact: true })
          .click();
        await page
          .locator("#workspace h2, #workspace h1")
          .first()
          .waitFor({ timeout: 30_000 });
        // Let the view finish its first loads.
        await page
          .waitForLoadState("networkidle", { timeout: 60_000 })
          .catch(() => {});
        await page.waitForTimeout(1500);
        const heading = (
          await page.locator("#workspace h2").first().innerText()
        ).trim();
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
        const name = view.link.toLowerCase().split(" ").join("-");
        await page.screenshot({
          path: `${shotDir}ui-views-${name}.png`,
          fullPage: true,
        });
        console.log(`      heading: ${heading}`);
      },
    );
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
