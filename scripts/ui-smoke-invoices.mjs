// Browser smoke test for the Invoices view (Playwright, Chromium).
//
//   CORS_ALLOWED_ORIGINS=http://127.0.0.1:3101 API_PORT=4111 node --env-file=.env.local apps/api/dist/index.js   # API under test
//   WEB_URL=http://127.0.0.1:3101 WEB_API_BASE=http://127.0.0.1:4112/api/v1 \
//     API_BASE_URL=http://127.0.0.1:4111/api/v1 node --env-file=.env.local scripts/ui-smoke-invoices.mjs
//
// WEB_URL is a running web app. WEB_API_BASE is the API address that web app was built with;
// every browser request to it is sent to API_BASE_URL instead, so the UI can be tried against
// the API under test without rebuilding the web app.
//
// It creates a fixture trip with one paid booking (the payment goes through PostgREST), signs in
// as the demo user, and walks through: generate the invoice, download the PDF, email it (a real
// send into Mailpit through a worker started here), and a failed email through a worker with a
// wrong SMTP port. It checks that the booking and payment lines do not change when an email
// fails. Screenshots go to docs/validation/. Everything it creates is removed at the end.

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { api, demoToken, env, sql } from "./lib/validation.mjs";

const webUrl = env.WEB_URL ?? "http://127.0.0.1:3101";
const webApiBase = env.WEB_API_BASE ?? "http://127.0.0.1:4112/api/v1";
const apiBase = env.API_BASE_URL ?? "http://127.0.0.1:4111/api/v1";
const MAILPIT = env.MAILPIT_URL ?? "http://127.0.0.1:55424";
const shotDir = new URL("../docs/validation/", import.meta.url).pathname;
mkdirSync(shotDir, { recursive: true });

const RUN = randomUUID().slice(0, 8);
const TRIP = randomUUID();
const demo = await demoToken();
const demoUserId = (
  await sql(`select id from auth.users where email = '${env.DEMO_EMAIL}'`)
).trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const workers = [];
const mailIds = new Set();
let bookingId;
let invoiceId;
let page;

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
      const file = `${shotDir}ui-invoices-FAILED-${results.length}.png`;
      await page.screenshot({ path: file, fullPage: true }).catch(() => {});
      console.log(`      screenshot of the failure: ${file}`);
    }
  }
}

function startWorker(label, overrides = {}) {
  const lines = [];
  const child = spawn(
    process.execPath,
    ["--enable-source-maps", "apps/worker/dist/index.js"],
    {
      env: {
        ...process.env,
        WORKER_TRIP_IDS: TRIP,
        WORKER_ID: `ui11-${label}-${RUN}`,
        WORKER_POLL_INTERVAL_MS: "300",
        WORKER_SCHEDULE_INTERVAL_MS: "3600000",
        ...overrides,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const entry = { child, lines, exited: false };
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => lines.push(chunk.toString("utf8")));
  }
  child.on("exit", () => {
    entry.exited = true;
  });
  workers.push(entry);
  return entry;
}
async function stop(entry) {
  if (entry.exited) return;
  entry.child.kill("SIGTERM");
  for (let i = 0; i < 100 && !entry.exited; i += 1) await sleep(200);
}

async function cleanup() {
  for (const entry of workers) if (!entry.exited) entry.child.kill("SIGTERM");
  try {
    const objects = invoiceId
      ? await sql(
          `select o.object_path from public.document_storage_objects o join public.invoices i on i.pdf_object_id = o.id where i.id = '${invoiceId}'`,
        )
      : "";
    if (objects) {
      await fetch(`${env.SUPABASE_URL}/storage/v1/object/invoices/${objects}`, {
        method: "DELETE",
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      });
    }
    await sql(`
      delete from public.activity_logs where resource_id in (select id from public.email_deliveries where trip_id = '${TRIP}')
        or resource_id in (select id from public.invoices where trip_id = '${TRIP}')
        or resource_id in (select id from public.bookings where trip_id = '${TRIP}')
        or resource_id in (select p.id from public.payments p join public.bookings b on b.id = p.booking_id where b.trip_id = '${TRIP}')
        or resource_id in (select id from public.background_jobs where trip_id = '${TRIP}');
      delete from public.email_deliveries where trip_id = '${TRIP}';
      delete from public.background_jobs where trip_id = '${TRIP}';
      delete from public.invoices where trip_id = '${TRIP}';
      alter table public.document_storage_objects disable trigger document_objects_forbid_change_trigger;
      delete from public.document_storage_objects where trip_id = '${TRIP}';
      alter table public.document_storage_objects enable trigger document_objects_forbid_change_trigger;
      delete from public.idempotency_records where scope like '%${TRIP}%'
        or scope like '%${bookingId ?? "none"}%';
      delete from public.payments where booking_id in (select id from public.bookings where trip_id = '${TRIP}');
      delete from public.bookings where trip_id = '${TRIP}';
      delete from public.agenda_items where trip_id = '${TRIP}';
      delete from public.trips where id = '${TRIP}';
      update public.invoice_number_counters c
        set last_value = coalesce((select max(sequence_number) from public.invoices i where i.invoice_year = c.invoice_year), 0);
    `);
  } catch (error) {
    console.log(`CLEANUP FAILED: ${error.message}`);
    process.exitCode = 1;
  }
  if (mailIds.size > 0) {
    await fetch(`${MAILPIT}/api/v1/messages`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ IDs: [...mailIds] }),
    }).catch(() => {});
  }
}

let browser;
try {
  // --- fixture: one paid booking in its own trip ---------------------------------
  await sql(`insert into public.trips (id, user_id, name, timezone, status)
    values ('${TRIP}', '${demoUserId}', 'Fixture Task 11 UI Trip', 'Asia/Jakarta', 'draft')`);
  const agenda = randomUUID();
  await sql(`insert into public.agenda_items (id, trip_id, title, type, start_at, end_at, timezone, status)
    values ('${agenda}', '${TRIP}', 'Fixture UI Dinner', 'custom', now() + interval '2 days', now() + interval '2 days 1 hour', 'Asia/Jakarta', 'planned')`);
  process.env.API_BASE_URL = apiBase;
  const created = await api(`/trips/${TRIP}/bookings`, demo, {
    method: "POST",
    body: {
      booking_type: "itinerary_item",
      source_type: "agenda_item",
      source_id: agenda,
    },
  });
  assert.equal(created.status, 201, created.text);
  bookingId = created.body.id;
  const pay = await fetch(
    `${env.SUPABASE_URL}/rest/v1/rpc/simulate_dummy_payment`,
    {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        authorization: `Bearer ${demo}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        p_booking_id: bookingId,
        p_outcome: "succeeded",
        p_failure_code: null,
        p_idempotency_key: `ui-smoke-${randomUUID()}`,
        p_request_hash: randomUUID(),
        p_scope: `payment.simulate:${bookingId}`,
      }),
    },
  );
  assert.equal(pay.status, 200, await pay.text());

  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
    acceptDownloads: true,
  });
  page = await context.newPage();
  // Send the web app's API calls to the API under test.
  await page.route(`${webApiBase}/**`, (route) => {
    const request = route.request();
    route.continue({
      url: `${apiBase}${request.url().slice(webApiBase.length)}`,
    });
  });
  const goodWorker = startWorker("smtp");

  await step(
    "sign in and open the Invoices view of the fixture trip",
    async () => {
      await page.goto(webUrl);
      await page.getByLabel("Email").fill(env.DEMO_EMAIL);
      await page.getByLabel("Password").fill(env.DEMO_PASSWORD);
      await page.getByRole("button", { name: "Sign in" }).click();
      const nav = page.getByRole("navigation", {
        name: "Workspace navigation",
      });
      await nav.waitFor({ timeout: 30_000 });
      await page
        .getByLabel("Active trip")
        .selectOption({ label: "Fixture Task 11 UI Trip" });
      await nav.getByRole("link", { name: "Invoices" }).click();
      await page
        .getByRole("heading", { name: "Invoices", exact: true })
        .waitFor();
      await page
        .getByRole("heading", { name: "Fixture UI Dinner" })
        .waitFor({ timeout: 15_000 })
        .catch(() => {});
      await page
        .getByText("Itinerary item booking")
        .first()
        .waitFor({ timeout: 15_000 });
      assert.ok(
        (await page.getByText("Not issued yet").count()) >= 1,
        "no invoice number yet",
      );
      assert.ok(
        (await page.getByText("Succeeded").count()) >= 1,
        "payment status shown",
      );
      assert.ok(
        await page
          .getByRole("button", { name: "Generate invoice" })
          .isEnabled(),
      );
      await page.screenshot({
        path: `${shotDir}ui-invoices-1-before.png`,
        fullPage: true,
      });
    },
  );

  await step(
    "Generate invoice shows the number, PDF ready, and a download button",
    async () => {
      await page.getByRole("button", { name: "Generate invoice" }).click();
      await page.getByText("PDF ready").waitFor({ timeout: 15_000 });
      const text = await page.locator(".inv-facts").first().innerText();
      assert.ok(text.includes("INV-"), text);
      await page.getByRole("button", { name: "Download PDF" }).waitFor();
      await page.getByLabel("Send to (email address you confirm)").waitFor();
      const state = await api(
        `/trips/${TRIP}/bookings/${bookingId}/invoice`,
        demo,
      );
      invoiceId = state.body.invoice.id;
      assert.ok(text.includes(state.body.invoice.invoice_number));
      await page.screenshot({
        path: `${shotDir}ui-invoices-2-issued.png`,
        fullPage: true,
      });
    },
  );

  await step(
    "Download PDF saves the file through the authorized endpoint",
    async () => {
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("button", { name: "Download PDF" }).click(),
      ]);
      assert.ok(download.suggestedFilename().startsWith("invoice-INV-"));
      const stream = await download.createReadStream();
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      assert.equal(bytes.subarray(0, 5).toString("latin1"), "%PDF-");
      const state = await api(
        `/trips/${TRIP}/bookings/${bookingId}/invoice`,
        demo,
      );
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        state.body.invoice.pdf.sha256,
      );
    },
  );

  await step(
    "Send invoice delivers a real email; the status moves from sending to sent",
    async () => {
      const address = `ui11-${RUN}@example.com`;
      await page
        .getByLabel("Send to (email address you confirm)")
        .fill(address);
      await page.getByRole("button", { name: "Send invoice" }).click();
      await page
        .getByText("Sent", { exact: true })
        .waitFor({ timeout: 20_000 });
      assert.ok((await page.getByText(address).count()) >= 1);
      const list = await (
        await fetch(`${MAILPIT}/api/v1/messages?limit=200`)
      ).json();
      const mine = list.messages.filter((m) =>
        m.To.some((t) => t.Address === address),
      );
      assert.equal(mine.length, 1);
      mailIds.add(mine[0].ID);
      assert.equal(mine[0].Attachments, 1);
      await page.screenshot({
        path: `${shotDir}ui-invoices-3-sent.png`,
        fullPage: true,
      });
    },
  );

  await stop(goodWorker);
  const brokenWorker = startWorker("smtp-broken", { SMTP_PORT: "1" });

  await step(
    "a failed email shows Failed and leaves the booking and payment lines unchanged",
    async () => {
      const before = await page.locator(".inv-facts").first().innerText();
      const address = `ui11-fail-${RUN}@example.com`;
      await page
        .getByLabel("Send to (email address you confirm)")
        .fill(address);
      await page.getByRole("button", { name: "Send again" }).click();
      await page
        .getByText("This email was not delivered")
        .waitFor({ timeout: 25_000 });
      assert.ok((await page.getByText("Failed", { exact: true }).count()) >= 1);
      const after = await page.locator(".inv-facts").first().innerText();
      assert.equal(
        after,
        before,
        "booking, payment, and invoice facts did not change",
      );
      assert.ok(after.includes("confirmed"), after);
      assert.ok(after.includes("Succeeded"), after);
      await page.screenshot({
        path: `${shotDir}ui-invoices-4-failed.png`,
        fullPage: true,
      });
    },
  );

  await step(
    "the form refuses an invalid address in the browser and from the server",
    async () => {
      const input = page.getByLabel("Send to (email address you confirm)");
      await input.fill("not-an-email");
      await page.getByRole("button", { name: "Send again" }).click();
      const valid = await input.evaluate((element) => element.checkValidity());
      assert.equal(valid, false, "the browser marks the field invalid");
      const server = await api(
        `/trips/${TRIP}/invoices/${invoiceId}/email`,
        demo,
        {
          method: "POST",
          body: { recipient_email: "a@@b.co" },
        },
      );
      assert.equal(server.status, 400);
    },
  );
  await stop(brokenWorker);
} finally {
  await browser?.close().catch(() => {});
  await cleanup();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\nRESULT: ${results.length - failed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
