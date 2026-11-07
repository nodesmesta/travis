// Browser smoke test for Trip setup (screen 6.3), with Playwright and Chromium.
//
//   API_PORT=4112 CORS_ALLOWED_ORIGINS=http://127.0.0.1:3101 node --env-file=.env.local apps/api/dist/index.js   # one terminal
//   NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:4112/api/v1 node --env-file=.env.local node_modules/next/dist/bin/next dev apps/web -p 3101   # another
//   node --env-file=.env.local scripts/ui-smoke-trips.mjs
//
// When the API or the web server is not reachable the script starts it (API on
// 4112, web on 3101) and stops only what it started.
//
// It signs in as the demo user, opens the Trips view, checks form validation,
// creates a trip, checks that the trip is listed and can be chosen (topbar
// selector and the other views), adds places (resolved and needing
// clarification, then resolved), an agenda item, and a journey leg, edits the
// trip, and walks the status flow with a confirmation dialog, including a
// server error shown as received. Screenshots go to docs/validation/.
//
// Every trip is named "[ui-smoke trips] ..." and is removed at the end together
// with its places, agenda items, journey legs, activity logs, and idempotency
// records.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { api, demoToken, env } from "./lib/validation.mjs";
import {
  UI_SMOKE_PREFIX,
  cleanupTestTrips,
  countTestTrips,
} from "./lib/trips-cleanup.mjs";

const apiPort = Number(env.TRIPS_API_PORT ?? 4112);
const webPort = Number(env.TRIPS_WEB_PORT ?? 3101);
const apiBase = `http://127.0.0.1:${apiPort}/api/v1`;
const webUrl = `http://127.0.0.1:${webPort}`;
env.API_BASE_URL = apiBase; // the validation helpers read it
const shotDir = new URL("../docs/validation/", import.meta.url).pathname;
const startedAt = new Date(Date.now() - 5_000).toISOString();
const run = randomUUID().slice(0, 6);
const tripName = `${UI_SMOKE_PREFIX}Surabaya ${run}`;
const renamed = `${tripName} renamed`;
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
      const file = `${shotDir}ui-trips-FAILED-${results.length}.png`;
      await activePage.screenshot({ path: file, fullPage: true });
      console.log(`      screenshot of the failure: ${file}`);
    }
    console.log(
      `      ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function reachable(url) {
  try {
    const response = await fetch(url);
    return response.status < 500;
  } catch {
    return false;
  }
}

async function waitFor(url, label, attempts = 240) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await reachable(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} did not become ready at ${url}`);
}

const started = [];
function launch(args, extraEnv) {
  const child = spawn(process.execPath, args, {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, ...extraEnv },
    stdio: "ignore",
    detached: true,
  });
  started.push(child);
}

let browser = null;
try {
  if (!(await reachable(`${apiBase}/health`))) {
    launch(["--env-file=.env.local", "apps/api/dist/index.js"], {
      API_PORT: String(apiPort),
      LOG_LEVEL: "warn",
      CORS_ALLOWED_ORIGINS: webUrl,
    });
  }
  await waitFor(`${apiBase}/health`, "API", 120);
  if (!(await reachable(webUrl))) {
    launch(
      [
        "--env-file=.env.local",
        "node_modules/next/dist/bin/next",
        "dev",
        "apps/web",
        "-p",
        String(webPort),
      ],
      { NEXT_PUBLIC_API_BASE_URL: apiBase },
    );
  }
  await waitFor(webUrl, "web dev server");
  console.log(`API: ${apiBase}   Web: ${webUrl}`);

  const token = await demoToken();
  const seedTrips = (await api("/trips", token)).body.items;

  browser = await chromium.launch({ headless: true, channel: "chromium" });
  const page = await browser.newPage({
    viewport: { width: 1360, height: 1000 },
  });
  activePage = page;
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const shot = (name) =>
    page.screenshot({ path: `${shotDir}ui-trips-${name}.png`, fullPage: true });
  const nav = page.getByRole("navigation", { name: "Workspace navigation" });
  const createForm = page.locator(
    'section[aria-labelledby="trp-create-heading"] form',
  );
  const tripRow = (name) =>
    page.locator("li.trp-trip", { has: page.getByText(name, { exact: true }) });
  const live = page.locator('.trp-view > [aria-live="polite"]');
  const selector = page.getByLabel("Active trip");
  const selectedTripName = () =>
    selector.evaluate((element) => element.options[element.selectedIndex].text);
  const addPointForm = page.locator("form", {
    has: page.getByRole("heading", { name: "Add a place" }),
  });
  let createdTripId = null;

  await step("sign in as the demo user and open the Trips view", async () => {
    await page.goto(webUrl, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Email").fill(env.DEMO_EMAIL);
    await page.getByLabel("Password").fill(env.DEMO_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await nav.waitFor({ timeout: 60_000 });
    await nav.getByRole("link", { name: "Trips" }).click();
    await page.getByRole("heading", { name: "Your trips" }).waitFor();
    assert.ok(seedTrips.length >= 1, "the demo user has a seed trip");
    await tripRow(seedTrips[0].name).waitFor();
    const status = await tripRow(seedTrips[0].name).textContent();
    assert.ok(
      status.includes("Open in workspace"),
      "first trip is the open one",
    );
    assert.ok(
      (await page.locator("#trp-timezone-options option").count()) > 300,
      "timezone list comes from Intl.supportedValuesOf",
    );
    assert.ok(
      (await page
        .locator('#trp-timezone-options option[value="Asia/Jakarta"]')
        .count()) === 1,
    );
    await shot("1-trips-view");
  });

  await step(
    "an empty form shows messages next to the fields and focuses the first",
    async () => {
      await createForm.getByLabel("Timezone").fill("");
      await createForm.getByRole("button", { name: "Create trip" }).click();
      await createForm.getByText("Problem: Enter a trip name.").waitFor();
      await createForm.getByText("Problem: Choose a timezone.").waitFor();
      assert.equal(
        await page.evaluate(() => document.activeElement?.id),
        "trp-create-name",
      );
      assert.equal(
        await createForm.getByLabel("Trip name").getAttribute("aria-invalid"),
        "true",
      );
      await shot("2-validation-empty");
    },
  );

  await step(
    "a bad timezone and an end before the start are refused before sending",
    async () => {
      await createForm.getByLabel("Trip name").fill(tripName);
      await createForm.getByLabel("Timezone").fill("+07:00");
      await createForm.getByLabel("Start").fill("2026-11-22T18:00");
      await createForm.getByLabel("End").fill("2026-11-20T09:00");
      await createForm.getByRole("button", { name: "Create trip" }).click();
      await createForm
        .getByText("A UTC offset like +07:00 is not accepted", { exact: false })
        .waitFor();
      await createForm.getByLabel("Timezone").fill("Mars/Olympus");
      await createForm.getByRole("button", { name: "Create trip" }).click();
      await createForm
        .getByText("Use an IANA timezone", { exact: false })
        .waitFor();
      await createForm.getByLabel("Timezone").fill("Asia/Jakarta");
      await createForm.getByRole("button", { name: "Create trip" }).click();
      await createForm
        .getByText("Problem: The end must be after the start.")
        .waitFor();
      const created = (await api("/trips", token)).body.items.filter((trip) =>
        trip.name.includes(run),
      );
      assert.equal(created.length, 0, "nothing was sent to the server");
      await shot("3-validation-dates");
    },
  );

  await step(
    "creating a trip lists it, announces it, and opens it in the workspace",
    async () => {
      await createForm.getByLabel("Destination").fill("Surabaya, Indonesia");
      await createForm.getByLabel("Start").fill("2026-11-20T09:00");
      await createForm.getByLabel("End").fill("2026-11-22T18:00");
      await createForm.getByRole("button", { name: "Create trip" }).click();
      await live.getByText("was created as a draft", { exact: false }).waitFor({
        timeout: 30_000,
      });
      const row = tripRow(tripName);
      await row.waitFor();
      const text = await row.textContent();
      assert.ok(text.includes("Draft"), "status is written out");
      assert.ok(text.includes("Surabaya, Indonesia"));
      assert.ok(text.includes("Open in workspace"));
      assert.equal(
        await selectedTripName(),
        tripName,
        "topbar selector follows",
      );
      assert.equal(
        await page.locator(".trip-summary h2").textContent(),
        tripName,
        "sidebar follows",
      );
      // The form is empty again, so a second click cannot create a duplicate.
      assert.equal(await createForm.getByLabel("Trip name").inputValue(), "");
      const stored = (await api("/trips", token)).body.items.filter(
        (trip) => trip.name === tripName,
      );
      assert.equal(stored.length, 1, "exactly one trip was created");
      createdTripId = stored[0].id;
      assert.equal(stored[0].status, "draft");
      assert.equal(
        Date.parse(stored[0].start_at),
        Date.parse("2026-11-20T09:00:00+07:00"),
        "the wall-clock time was sent with the Asia/Jakarta offset",
      );
      assert.equal(stored[0].timezone, "Asia/Jakarta");
      await shot("4-trip-created");
    },
  );

  await step(
    "the trip can be chosen again from the topbar and from the list",
    async () => {
      await selector.selectOption({ label: seedTrips[0].name });
      await page.waitForFunction(
        (name) =>
          document.querySelector(".trip-summary h2")?.textContent === name,
        seedTrips[0].name,
      );
      assert.ok(
        (await tripRow(seedTrips[0].name).textContent()).includes(
          "Open in workspace",
        ),
      );
      assert.ok(
        !(await tripRow(tripName).textContent()).includes("Open in workspace"),
      );
      await page.getByRole("button", { name: `Open ${tripName}` }).click();
      await page.waitForFunction(
        (name) =>
          document.querySelector(".trip-summary h2")?.textContent === name,
        tripName,
      );
      assert.equal(await selectedTripName(), tripName);
      await live
        .getByText("is now open in the workspace", { exact: false })
        .waitFor();
    },
  );

  await step(
    "a place with coordinates and a place reference is resolved",
    async () => {
      await addPointForm.getByLabel("Type").selectOption("hotel");
      await addPointForm.getByLabel("Name").fill("Smoke Hotel");
      await addPointForm
        .getByLabel("Address")
        .fill("Jl. Tunjungan 1, Surabaya");
      await addPointForm.getByLabel("Latitude").fill("-7.2575");
      await addPointForm.getByLabel("Longitude").fill("112.7521");
      await addPointForm.getByLabel("Timezone").fill("Asia/Jakarta");
      await addPointForm
        .getByLabel("Place reference")
        .fill(`ui-smoke-hotel-${run}`);
      await addPointForm.getByRole("button", { name: "Add place" }).click();
      const row = page.locator("li.trp-point", { hasText: "Smoke Hotel" });
      await row.waitFor({ timeout: 30_000 });
      const text = await row.textContent();
      assert.ok(text.includes("Resolved"), text);
      assert.ok(text.includes("Not confirmed"), text);
      await row.getByRole("button", { name: "Confirm Smoke Hotel" }).click();
      await row.getByText("Confirmed", { exact: true }).waitFor();
    },
  );

  await step(
    "a place without coordinates needs clarification, then is resolved with the clarification form",
    async () => {
      await addPointForm.getByLabel("Type").selectOption("meeting");
      await addPointForm.getByLabel("Name").fill("Smoke Meeting Room");
      await addPointForm.getByRole("button", { name: "Add place" }).click();
      const row = page.locator("li.trp-point", {
        hasText: "Smoke Meeting Room",
      });
      await row.waitFor({ timeout: 30_000 });
      assert.ok((await row.textContent()).includes("Needs clarification"));
      await live.getByText("needs clarification", { exact: false }).waitFor();
      assert.equal(
        await row
          .getByRole("button", { name: "Confirm Smoke Meeting Room" })
          .count(),
        0,
        "an unresolved place cannot be confirmed",
      );
      await shot("5-needs-clarification");
      const resolve = row.locator("form");
      await resolve.waitFor();
      await resolve.getByRole("button", { name: "Resolve place" }).click();
      await resolve.getByText("Problem: Enter the latitude.").waitFor();
      await resolve.getByLabel("Latitude").fill("-7.2653");
      await resolve.getByLabel("Longitude").fill("112.7487");
      await resolve
        .getByLabel("Place reference")
        .fill(`ui-smoke-meeting-${run}`);
      await resolve.getByRole("button", { name: "Resolve place" }).click();
      await row
        .getByText("Resolved", { exact: true })
        .waitFor({ timeout: 30_000 });
      assert.ok(!(await row.textContent()).includes("Needs clarification"));
    },
  );

  await step(
    "a third place is archived through the confirmation dialog",
    async () => {
      await addPointForm.getByLabel("Type").selectOption("airport");
      await addPointForm.getByLabel("Name").fill("Smoke Airport");
      await addPointForm.getByLabel("Latitude").fill("-7.3798");
      await addPointForm.getByLabel("Longitude").fill("112.7878");
      await addPointForm
        .getByLabel("Place reference")
        .fill(`ui-smoke-airport-${run}`);
      await addPointForm.getByRole("button", { name: "Add place" }).click();
      const row = page.locator("li.trp-point", { hasText: "Smoke Airport" });
      await row.waitFor({ timeout: 30_000 });
      await row.getByRole("button", { name: "Archive Smoke Airport" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      assert.ok((await dialog.textContent()).includes("cannot be undone"));
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(await row.count(), 1, "cancel changes nothing");
      await row.getByRole("button", { name: "Archive Smoke Airport" }).click();
      await dialog.getByRole("button", { name: "Archive place" }).click();
      await dialog.waitFor({ state: "hidden", timeout: 30_000 });
      await page.getByText("Archived places (1)").waitFor();
      assert.equal(
        await page
          .locator("li.trp-point", { hasText: "Smoke Airport" })
          .count(),
        0,
      );
    },
  );

  await step(
    "the places reach the other views (Explore lists them)",
    async () => {
      await nav.getByRole("link", { name: "Explore and book" }).click();
      const options = page.locator(".context-option");
      await options.first().waitFor();
      const hotel = page.locator(".context-option", { hasText: "Smoke Hotel" });
      assert.equal(await hotel.count(), 1);
      assert.equal(
        await hotel.isDisabled(),
        false,
        "a resolved place can be chosen",
      );
      assert.equal(
        await page
          .locator(".context-option", { hasText: "Smoke Airport" })
          .isDisabled(),
        true,
        "an archived place is shown but cannot be chosen",
      );
      await shot("6-explore-uses-new-places");
      await nav.getByRole("link", { name: "Trips" }).click();
      await page.getByRole("heading", { name: "Your trips" }).waitFor();
    },
  );

  await step(
    "journey leg: origin and destination start empty and are chosen by the user",
    async () => {
      const legForm = page.locator("form", {
        has: page.getByLabel("From"),
      });
      assert.equal(await legForm.getByLabel("From").inputValue(), "");
      assert.equal(await legForm.getByLabel("To").inputValue(), "");
      await legForm.getByRole("button", { name: "Add journey leg" }).click();
      await legForm
        .getByText("Problem: Choose where the trip starts.")
        .waitFor();
      await legForm
        .getByLabel("From")
        .selectOption({ label: "Smoke Hotel (hotel)" });
      await legForm
        .getByLabel("To")
        .selectOption({ label: "Smoke Hotel (hotel)" });
      await legForm.getByLabel("Departure").fill("2026-11-20T07:30");
      await legForm.getByRole("button", { name: "Add journey leg" }).click();
      await legForm
        .getByText("Problem: Origin and destination must be different places.")
        .waitFor();
      await legForm
        .getByLabel("From")
        .selectOption({ label: "Smoke Meeting Room (meeting)" });
      await legForm
        .getByLabel("To")
        .selectOption({ label: "Smoke Hotel (hotel)" });
      await legForm.getByRole("button", { name: "Add journey leg" }).click();
      await page
        .getByText("The journey leg was added.")
        .waitFor({ timeout: 30_000 });
      const legs = (await api(`/trips/${createdTripId}/journey-legs`, token))
        .body.items;
      assert.equal(legs.length, 1);
      const places = (
        await api(`/trips/${createdTripId}/context-points`, token)
      ).body.items;
      const labelOf = (id) => places.find((point) => point.id === id)?.label;
      assert.equal(
        labelOf(legs[0].origin_context_point_id),
        "Smoke Meeting Room",
      );
      assert.equal(
        labelOf(legs[0].destination_context_point_id),
        "Smoke Hotel",
      );
    },
  );

  await step(
    "agenda item: validated, saved, and shown in the timeline",
    async () => {
      const agendaForm = page.locator("form", {
        has: page.getByLabel("Title"),
      });
      await agendaForm.getByRole("button", { name: "Add agenda item" }).click();
      await agendaForm.getByText("Problem: Enter a title.").waitFor();
      await agendaForm.getByLabel("Title").fill("Smoke kick-off meeting");
      await agendaForm.getByLabel("Type").selectOption("meeting");
      await agendaForm.getByLabel("Starts").fill("2026-11-20T10:00");
      await agendaForm.getByLabel("Ends").fill("2026-11-20T09:00");
      await agendaForm.getByRole("button", { name: "Add agenda item" }).click();
      await agendaForm
        .getByText("Problem: The end must be after the start.")
        .waitFor();
      await agendaForm.getByLabel("Ends").fill("2026-11-20T11:30");
      await agendaForm
        .getByLabel("Place")
        .selectOption({ label: "Smoke Meeting Room" });
      await agendaForm.getByRole("button", { name: "Add agenda item" }).click();
      await page
        .getByText("“Smoke kick-off meeting” was added to the agenda.")
        .waitFor({
          timeout: 30_000,
        });
      const timeline = page.getByRole("list", {
        name: "Agenda items and journey legs",
      });
      await timeline.getByText("Smoke kick-off meeting").waitFor();
      const text = await timeline.textContent();
      assert.ok(text.includes("Smoke Meeting Room → Smoke Hotel"), text);
      assert.ok(
        text.indexOf("Smoke Meeting Room → Smoke Hotel") <
          text.indexOf("Smoke kick-off meeting"),
        "sorted by time",
      );
      const agenda = (await api(`/trips/${createdTripId}/agenda-items`, token))
        .body.items;
      assert.equal(agenda.length, 1);
      assert.equal(
        Date.parse(agenda[0].start_at),
        Date.parse("2026-11-20T10:00:00+07:00"),
      );
      await shot("7-places-agenda-leg");
    },
  );

  await step("the Itinerary view uses the open trip", async () => {
    await nav.getByRole("link", { name: "Itinerary" }).click();
    await page
      .locator("#itinerary-title", { hasText: tripName })
      .waitFor({ timeout: 30_000 });
    await page
      .getByText("Smoke kick-off meeting")
      .first()
      .waitFor({ timeout: 30_000 });
    await nav.getByRole("link", { name: "Trips" }).click();
    await page.getByRole("heading", { name: "Your trips" }).waitFor();
  });

  await step(
    "editing a trip: no change is reported, then a rename is saved",
    async () => {
      await page.getByRole("button", { name: `Edit ${tripName}` }).click();
      const editor = tripRow(tripName).locator("form");
      await editor.waitFor();
      assert.equal(await editor.getByLabel("Trip name").inputValue(), tripName);
      assert.equal(
        await editor.getByLabel("Start").inputValue(),
        "2026-11-20T09:00",
      );
      await editor.getByRole("button", { name: "Save changes" }).click();
      const alert = editor.getByRole("alert");
      await alert.waitFor();
      assert.ok((await alert.textContent()).includes("Nothing has changed"));
      await editor.getByLabel("Trip name").fill(renamed);
      await editor.getByLabel("End").fill("2026-11-19T09:00");
      await editor.getByRole("button", { name: "Save changes" }).click();
      await editor
        .getByText("Problem: The end must be after the start.")
        .waitFor();
      await editor.getByLabel("End").fill("2026-11-23T18:00");
      await editor.getByRole("button", { name: "Save changes" }).click();
      await live
        .getByText("was updated", { exact: false })
        .waitFor({ timeout: 30_000 });
      await tripRow(renamed).waitFor();
      assert.equal(await selectedTripName(), renamed);
      const stored = (await api(`/trips/${createdTripId}`, token)).body;
      assert.equal(stored.name, renamed);
      assert.equal(
        Date.parse(stored.end_at),
        Date.parse("2026-11-23T18:00:00+07:00"),
      );
    },
  );

  await step(
    "status flow: cancel changes nothing; a server conflict is shown as received",
    async () => {
      await page
        .getByRole("button", { name: `Confirm trip: ${renamed}` })
        .click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      const body = await dialog.textContent();
      assert.ok(body.includes("Draft") && body.includes("Confirmed"), body);
      await shot("8-confirm-dialog");
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(
        (await api(`/trips/${createdTripId}`, token)).body.status,
        "draft",
      );

      // Someone else moves the trip first (another tab); the dialog is still open.
      await page
        .getByRole("button", { name: `Confirm trip: ${renamed}` })
        .click();
      await dialog.waitFor();
      const other = await api(`/trips/${createdTripId}/transition`, token, {
        method: "POST",
        body: { status: "confirmed" },
      });
      assert.equal(other.status, 200, other.text);
      await dialog.getByRole("button", { name: "Confirm trip" }).click();
      const error = dialog.getByRole("alert");
      await error.waitFor({ timeout: 30_000 });
      const text = await error.textContent();
      assert.ok(text.includes("Only a draft trip can become confirmed."), text);
      assert.ok(text.includes("Code: DOMAIN_STATE_INVALID"), text);
      assert.ok(text.includes("Request ID: "), text);
      await shot("9-server-error");
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await dialog.waitFor({ state: "hidden" });
      // The list shows the real status after the conflict.
      await tripRow(renamed)
        .getByText("Confirmed", { exact: true })
        .waitFor({ timeout: 30_000 });
    },
  );

  await step(
    "status flow: confirmed → active → completed through the dialog",
    async () => {
      const dialog = page.getByRole("dialog");
      await page
        .getByRole("button", { name: `Start trip: ${renamed}` })
        .click();
      await dialog.getByRole("button", { name: "Start trip" }).click();
      await dialog.waitFor({ state: "hidden", timeout: 30_000 });
      await tripRow(renamed).getByText("Active", { exact: true }).waitFor();
      await page
        .getByRole("button", { name: `Complete trip: ${renamed}` })
        .click();
      await dialog.getByRole("button", { name: "Complete trip" }).click();
      await dialog.waitFor({ state: "hidden", timeout: 30_000 });
      await tripRow(renamed).getByText("Completed", { exact: true }).waitFor();
      assert.equal(
        await tripRow(renamed).locator('button[aria-label*="trip: "]').count(),
        0,
        "a completed trip has no further step",
      );
      assert.equal(
        (await api(`/trips/${createdTripId}`, token)).body.status,
        "completed",
      );
      await live.getByText("is now Completed", { exact: false }).waitFor();
      await shot("10-completed");
    },
  );

  await step("no page error was raised in the browser", async () => {
    assert.deepEqual(pageErrors, []);
  });
} catch (error) {
  results.push({ name: "harness", ok: false });
  console.log("FAIL: harness");
  console.log(`      ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  if (browser) await browser.close();
  for (const child of started) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      assert.ok(error instanceof Error);
    }
  }
  try {
    const removed = await cleanupTestTrips([UI_SMOKE_PREFIX], startedAt);
    const left = await countTestTrips([UI_SMOKE_PREFIX], startedAt);
    console.log(`cleanup: removed ${removed} test trip(s), ${left} left`);
    results.push({ name: "cleanup", ok: left === 0 });
  } catch (error) {
    console.log(`CLEANUP FAILED: ${error.message}`);
    results.push({ name: "cleanup", ok: false });
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nRESULT: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
