// Validator for Task 11 (invoice and email delivery).
//
//   API_BASE_URL=http://127.0.0.1:4111/api/v1 node --env-file=.env.local scripts/validate-task-11.mjs
//
// Needs: the API running from apps/api/dist (INVOICE_AUTO_GENERATE true, EMAIL_PROVIDER=smtp),
// the worker built into apps/worker/dist, migration 0010 applied, and the local Supabase
// stack with Mailpit. The validator starts its own worker processes (restricted by
// WORKER_TRIP_IDS to the scheduler, but a worker claims any queued job).
//
// Kinds of check, never mixed in the output:
//   DATABASE  talks to Postgres and PostgREST (constraints, triggers, RLS, functions).
//   STORAGE   talks to the Supabase Storage API with different credentials.
//   API       talks to the running API as the demo user and a second user.
//   EMAIL     real SMTP delivery into the local Mailpit container, read back through
//             the Mailpit HTTP API. This is a real send, not a fixture.
//   BLOCKED   needs a key or a domain that does not exist here (Resend live).
//
// Everything is created under one trip "Fixture Task 11 Trip" and removed at the end.

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  api,
  apiBase,
  blocked,
  check,
  demoToken,
  env,
  finish,
  otherUserToken,
  requireEnv,
  sql,
} from "./lib/validation.mjs";

requireEnv(
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "DEMO_EMAIL",
  "DEMO_PASSWORD",
);
process.env.API_BASE_URL ??= "http://127.0.0.1:4111/api/v1";

const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = env.SUPABASE_ANON_KEY;
const MAILPIT = env.MAILPIT_URL ?? "http://127.0.0.1:55424";
const RUN = randomUUID().slice(0, 8);
const demo = await demoToken();
const other = await otherUserToken();
const demoUserId = (
  await sql(`select id from auth.users where email = '${env.DEMO_EMAIL}'`)
).trim();

/** Asserts that a promise rejects with a message containing one of the texts. No pattern matching. */
async function rejectsWithText(promise, texts, label = "") {
  try {
    await promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.ok(
      texts.some((text) => message.includes(text)),
      `${label} rejected with "${message.slice(0, 300)}", expected one of ${texts.join(" | ")}`,
    );
    return;
  }
  assert.fail(`${label} was accepted but must be refused`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function waitFor(
  label,
  fn,
  { timeoutMs = 30_000, intervalMs = 300 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}

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
      apikey: token === SERVICE ? SERVICE : ANON,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(prefer ? { prefer } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: response.status, body: json };
}

/** Binary GET against the API (api() returns text, which would corrupt a PDF). */
async function apiBytes(path, token) {
  const response = await fetch(`${apiBase()}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return {
    status: response.status,
    headers: response.headers,
    bytes: new Uint8Array(await response.arrayBuffer()),
  };
}

async function storageGet(path, token, key = token) {
  const response = await fetch(`${env.SUPABASE_URL}/storage/v1${path}`, {
    headers: { apikey: key, authorization: `Bearer ${token}` },
  });
  return {
    status: response.status,
    bytes: new Uint8Array(await response.arrayBuffer()),
  };
}

// --- Mailpit -------------------------------------------------------------------

async function mailpit(path, init) {
  const response = await fetch(`${MAILPIT}${path}`, init);
  const text = await response.text();
  return { status: response.status, text, json: text ? tryJson(text) : null };
}
function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
async function mailpitMessagesTo(address) {
  const list = await mailpit("/api/v1/messages?limit=500");
  assert.equal(list.status, 200, list.text.slice(0, 200));
  return (list.json.messages ?? []).filter((message) =>
    (message.To ?? []).some((to) => to.Address === address),
  );
}

// --- worker processes -----------------------------------------------------------

const workers = [];
function startWorker(label, overrides = {}) {
  const lines = [];
  const child = spawn(
    process.execPath,
    ["--enable-source-maps", "apps/worker/dist/index.js"],
    {
      env: {
        ...process.env,
        WORKER_TRIP_IDS: TRIP,
        WORKER_ID: `task11-${label}-${RUN}`,
        WORKER_POLL_INTERVAL_MS: "300",
        WORKER_SCHEDULE_INTERVAL_MS: "3600000",
        WORKER_CONCURRENCY: "2",
        ...overrides,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const entry = { label, child, lines, exited: false };
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim()) lines.push(line);
      }
    });
  }
  child.on("exit", () => {
    entry.exited = true;
  });
  workers.push(entry);
  return entry;
}
async function stopWorker(entry) {
  if (entry.exited) return;
  entry.child.kill("SIGTERM");
  await waitFor(`worker ${entry.label} to stop`, () => entry.exited, {
    timeoutMs: 30_000,
  });
}

// --- fixtures ---------------------------------------------------------------------

const TRIP = randomUUID();
const bookings = {};
const agendaIds = [];
const createdMail = new Set();

async function setupTrip() {
  await sql(`insert into public.trips (id, user_id, name, timezone, status)
    values ('${TRIP}', '${demoUserId}', 'Fixture Task 11 Trip', 'Asia/Jakarta', 'draft')`);
}

async function newBooking(label, title = `Fixture ${label}`) {
  const agenda = randomUUID();
  agendaIds.push(agenda);
  await sql(`insert into public.agenda_items (id, trip_id, title, type, start_at, end_at, timezone, status)
    values ('${agenda}', '${TRIP}', '${title}', 'custom', now() + interval '2 days',
            now() + interval '2 days 1 hour', 'Asia/Jakarta', 'planned')`);
  const created = await api(`/trips/${TRIP}/bookings`, demo, {
    method: "POST",
    body: {
      booking_type: "itinerary_item",
      source_type: "agenda_item",
      source_id: agenda,
    },
  });
  assert.equal(created.status, 201, created.text);
  bookings[label] = { id: created.body.id, agenda, title };
  return created.body;
}

/** Pays through PostgREST, which does not queue the automatic invoice job. */
async function payDirect(bookingId, outcome) {
  const result = await rest("/rpc/simulate_dummy_payment", demo, {
    method: "POST",
    body: {
      p_booking_id: bookingId,
      p_outcome: outcome,
      p_failure_code: outcome === "failed" ? "FIXTURE_DECLINED" : null,
      p_idempotency_key: `validator-${randomUUID()}`,
      p_request_hash: randomUUID(),
      p_scope: `payment.simulate:${bookingId}`,
    },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}

async function refundDirect(bookingId, paymentId) {
  const result = await rest("/rpc/refund_dummy_payment", demo, {
    method: "POST",
    body: {
      p_booking_id: bookingId,
      p_payment_id: paymentId,
      p_idempotency_key: `validator-${randomUUID()}`,
      p_request_hash: randomUUID(),
      p_scope: `payment.refund:${paymentId}`,
    },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
}

async function generate(bookingId, token = demo) {
  return api(`/trips/${TRIP}/bookings/${bookingId}/invoice/generate`, token, {
    method: "POST",
  });
}

async function cleanup() {
  for (const entry of workers) {
    if (!entry.exited) entry.child.kill("SIGTERM");
  }
  try {
    const invoiceRows = await rows(
      `select i.id, o.object_path from public.invoices i
       left join public.document_storage_objects o on o.id = i.pdf_object_id
       where i.trip_id = '${TRIP}'`,
    );
    for (const row of invoiceRows) {
      if (row.object_path) {
        await fetch(
          `${env.SUPABASE_URL}/storage/v1/object/invoices/${row.object_path}`,
          {
            method: "DELETE",
            headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}` },
          },
        );
      }
    }
    await fetch(
      `${env.SUPABASE_URL}/storage/v1/object/invoices/${TRIP}/forged.pdf`,
      {
        method: "DELETE",
        headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}` },
      },
    );
    const ids = [
      ...Object.values(bookings).map((b) => b.id),
      ...invoiceRows.map((row) => row.id),
    ];
    const idList = ids.map((id) => `'${id}'`).join(", ") || "null";
    await sql(`
      delete from public.activity_logs
        where resource_id in (${idList})
           or resource_id in (select id from public.email_deliveries where trip_id = '${TRIP}')
           or resource_id in (select id from public.payments where booking_id in (${idList}))
           or resource_id in (select id from public.background_jobs where trip_id = '${TRIP}');
      delete from public.email_deliveries where trip_id = '${TRIP}';
      delete from public.background_jobs where trip_id = '${TRIP}';
      delete from public.invoices where trip_id = '${TRIP}';
      alter table public.document_storage_objects disable trigger document_objects_forbid_change_trigger;
      delete from public.document_storage_objects where trip_id = '${TRIP}';
      alter table public.document_storage_objects enable trigger document_objects_forbid_change_trigger;
      delete from public.idempotency_records where scope like '%${TRIP}%'
        ${ids.map((id) => `or scope like '%${id}%'`).join(" ")};
      delete from public.payments where booking_id in (${idList});
      delete from public.bookings where trip_id = '${TRIP}';
      delete from public.agenda_items where trip_id = '${TRIP}';
      delete from public.trips where id = '${TRIP}';
      update public.invoice_number_counters c
        set last_value = coalesce((select max(sequence_number) from public.invoices i
                                   where i.invoice_year = c.invoice_year), 0);
    `);
  } catch (error) {
    console.log(`CLEANUP FAILED: ${error.message}`);
    process.exitCode = 1;
  }
  if (createdMail.size > 0) {
    await mailpit("/api/v1/messages", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ IDs: [...createdMail] }),
    }).catch(() => undefined);
  }
}

process.on("SIGINT", () => {
  cleanup().finally(() => process.exit(130));
});

// ====================================================================================
let ok = {};
try {
  await setupTrip();

  // --- DATABASE: structure ---------------------------------------------------------
  await check(
    "DATABASE: tables exist with row level security enabled",
    async () => {
      const found = await rows(
        `select relname, relrowsecurity from pg_class
       where relnamespace = 'public'::regnamespace
         and relname in ('invoices','document_storage_objects','email_deliveries','invoice_number_counters')`,
      );
      assert.equal(found.length, 4);
      for (const row of found)
        assert.equal(row.relrowsecurity, true, row.relname);
    },
  );

  await check(
    "DATABASE: the invoices bucket is private and no Storage policy opens it",
    async () => {
      const bucket = await rows(
        "select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'invoices'",
      );
      assert.equal(bucket.length, 1);
      assert.equal(bucket[0].public, false);
      assert.deepEqual(bucket[0].allowed_mime_types, ["application/pdf"]);
      const policies = await rows(
        "select policyname, qual, with_check from pg_policies where schemaname = 'storage' and tablename = 'objects'",
      );
      const mentioning = policies.filter((policy) =>
        `${policy.qual ?? ""} ${policy.with_check ?? ""}`.includes("invoices"),
      );
      assert.equal(mentioning.length, 0, JSON.stringify(mentioning));
    },
  );

  await check(
    "DATABASE: job types accept the two invoice jobs and still refuse unknown ones",
    async () => {
      const constraint = await sql(
        "select pg_get_constraintdef(oid) from pg_constraint where conname = 'background_jobs_type_check'",
      );
      for (const type of [
        "refresh_weather",
        "refresh_traffic",
        "evaluate_alerts",
        "departure_reminder",
        "generate_invoice",
        "send_invoice_email",
      ]) {
        assert.ok(
          constraint.includes(type),
          `${type} missing in ${constraint}`,
        );
      }
      await rejectsWithText(
        sql(`insert into public.background_jobs (trip_id, user_id, job_type, idempotency_key, correlation_id)
           values ('${TRIP}', '${demoUserId}', 'send_spam', 'validator-bad-type-${RUN}', 'x')`),
        ["background_jobs_type_check"],
      );
    },
  );

  // --- bookings and payments -------------------------------------------------------
  const paid = await newBooking("paid", "Fixture Dinner (Rooftop)");
  const failedBooking = await newBooking("failed");
  const pendingBooking = await newBooking("pending");
  const cancelledBooking = await newBooking("cancelled");
  const refundedBooking = await newBooking("refunded");
  const unpaidBooking = await newBooking("unpaid");
  const dupJobBooking = await newBooking("dup-job");
  const tamperBooking = await newBooking("tamper");
  const autoBooking = await newBooking("auto");
  const failMailBooking = await newBooking("fail-mail");

  const payments = {};
  for (const [label, outcome] of [
    ["paid", "succeeded"],
    ["failed", "failed"],
    ["pending", "pending"],
    ["cancelled", "cancelled"],
    ["refunded", "succeeded"],
    ["dup-job", "succeeded"],
    ["tamper", "succeeded"],
    ["fail-mail", "succeeded"],
  ]) {
    const result = await payDirect(bookings[label].id, outcome);
    payments[label] = result.payment;
  }
  await refundDirect(bookings.refunded.id, payments.refunded.id);
  const paidConfirmation = (
    await api(`/trips/${TRIP}/bookings/${bookings.paid.id}`, demo)
  ).body.confirmation_code;
  assert.ok(
    paidConfirmation,
    "a succeeded payment gives the booking a confirmation code",
  );

  // --- refusals --------------------------------------------------------------------
  await check(
    "API: failed, pending, cancelled, refunded, and unpaid bookings are refused and create no invoice",
    async () => {
      for (const label of [
        "failed",
        "pending",
        "cancelled",
        "refunded",
        "unpaid",
      ]) {
        const state = await api(
          `/trips/${TRIP}/bookings/${bookings[label].id}/invoice`,
          demo,
        );
        assert.equal(state.status, 200, `${label}: ${state.text}`);
        assert.equal(state.body.eligible, false, label);
        assert.ok(state.body.ineligible_reason.length > 0, label);
        assert.equal(state.body.invoice, null, label);
        const response = await generate(bookings[label].id);
        assert.equal(response.status, 409, `${label}: ${response.text}`);
        assert.equal(response.body.error.code, "INVOICE_NOT_ELIGIBLE", label);
      }
      const count = await sql(
        `select count(*) from public.invoices where booking_id in (${[
          "failed",
          "pending",
          "cancelled",
          "refunded",
          "unpaid",
        ]
          .map((label) => `'${bookings[label].id}'`)
          .join(",")})`,
      );
      assert.equal(count, "0");
    },
  );

  await check(
    "DATABASE: the trigger refuses an invoice for a payment that did not succeed",
    async () => {
      for (const label of ["failed", "pending", "cancelled", "refunded"]) {
        const payment = payments[label];
        await rejectsWithText(
          sql(`insert into public.invoices (trip_id, user_id, booking_id, payment_id, invoice_year, sequence_number,
               invoice_number, currency, subtotal, tax, total, pricing_policy)
             select b.trip_id, b.user_id, b.id, p.id, 2026, 900001, 'INV-2026-900001', b.currency, b.subtotal, b.tax, b.total, b.pricing_policy
             from public.bookings b join public.payments p on p.booking_id = b.id
             where b.id = '${bookings[label].id}' and p.id = '${payment.id}'`),
          ["INVOICE_PAYMENT_NOT_SUCCEEDED", "INVOICE_BOOKING_NOT_CONFIRMED"],
          label,
        );
      }
    },
  );

  // --- generate --------------------------------------------------------------------
  let invoice;
  await check(
    "API: generate from a succeeded payment issues the invoice with the booking and payment amounts",
    async () => {
      const before = await api(
        `/trips/${TRIP}/bookings/${bookings.paid.id}/invoice`,
        demo,
      );
      assert.equal(before.body.eligible, true);
      assert.equal(before.body.invoice, null);
      assert.equal(before.body.payment.status, "succeeded");

      const response = await generate(bookings.paid.id);
      assert.equal(response.status, 201, response.text);
      assert.equal(response.body.created, true);
      invoice = response.body.invoice;
      assert.equal(invoice.status, "issued");
      assert.equal(invoice.booking_id, bookings.paid.id);
      assert.equal(invoice.payment_id, payments.paid.id);
      assert.equal(invoice.invoice_number.length, 15);
      assert.ok(
        invoice.invoice_number.startsWith(
          `INV-${new Date().getUTCFullYear()}-`,
        ),
      );
      assert.equal(invoice.item_title, "Fixture Dinner (Rooftop)");
      assert.equal(invoice.booking_reference, paidConfirmation);
      assert.equal(invoice.payment_reference, payments.paid.payment_reference);
      assert.equal(invoice.payment_status, "succeeded");
      assert.equal(invoice.pricing_policy, "demo-pricing-v1");
      assert.equal(invoice.currency, "IDR");
      assert.equal(invoice.subtotal, 100000);
      assert.equal(invoice.tax, 10000);
      assert.equal(invoice.total, 110000);
      assert.equal(invoice.pdf.content_type, "application/pdf");
      assert.equal(invoice.pdf.sha256.length, 64);
      const text = JSON.stringify(invoice);
      assert.ok(!text.includes("storage/v1"), "no storage URL in the response");
      assert.ok(
        !text.includes("object_path"),
        "no storage path in the response",
      );
    },
  );

  await check(
    "DATABASE: invoice amounts equal the booking and the payment, with valid relations",
    async () => {
      const found = await rows(
        `select i.*, b.subtotal as b_sub, b.tax as b_tax, b.total as b_total, b.currency as b_cur,
              b.pricing_policy as b_policy, b.status as b_status, p.amount as p_amount,
              p.currency as p_cur, p.status as p_status, p.booking_id as p_booking
       from public.invoices i
       join public.bookings b on b.id = i.booking_id
       join public.payments p on p.id = i.payment_id
       where i.id = '${invoice.id}'`,
      );
      assert.equal(found.length, 1);
      const row = found[0];
      assert.equal(Number(row.subtotal), Number(row.b_sub));
      assert.equal(Number(row.tax), Number(row.b_tax));
      assert.equal(Number(row.total), Number(row.b_total));
      assert.equal(Number(row.total), Number(row.p_amount));
      assert.equal(row.currency, row.b_cur);
      assert.equal(row.currency, row.p_cur);
      assert.equal(row.pricing_policy, row.b_policy);
      assert.equal(row.p_status, "succeeded");
      assert.equal(row.b_status, "confirmed");
      assert.equal(row.p_booking, row.booking_id);
      assert.equal(row.trip_id, TRIP);
      assert.equal(row.user_id, demoUserId);
    },
  );

  await check(
    "API: generating again, with the same or another key, returns the same invoice",
    async () => {
      const sameKey = `validator-same-${randomUUID()}`;
      const first = await api(
        `/trips/${TRIP}/bookings/${bookings.paid.id}/invoice/generate`,
        demo,
        {
          method: "POST",
          idempotencyKey: sameKey,
        },
      );
      const replay = await api(
        `/trips/${TRIP}/bookings/${bookings.paid.id}/invoice/generate`,
        demo,
        {
          method: "POST",
          idempotencyKey: sameKey,
        },
      );
      const another = await generate(bookings.paid.id);
      for (const response of [first, replay, another]) {
        assert.ok([200, 201].includes(response.status), response.text);
        assert.equal(response.body.invoice.id, invoice.id);
        assert.equal(
          response.body.invoice.invoice_number,
          invoice.invoice_number,
        );
      }
      assert.equal(another.status, 200);
      assert.equal(another.body.created, false);
      const count = await sql(
        `select count(*) from public.invoices where booking_id = '${bookings.paid.id}'`,
      );
      assert.equal(count, "1");
    },
  );

  await check(
    "API: five parallel generate requests create exactly one invoice",
    async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => generate(bookings["dup-job"].id)),
      );
      for (const response of results) {
        assert.ok([200, 201].includes(response.status), response.text);
      }
      assert.equal(
        results.filter((response) => response.status === 201).length,
        1,
      );
      assert.equal(new Set(results.map((r) => r.body.invoice.id)).size, 1);
      assert.equal(
        await sql(
          `select count(*) from public.invoices where booking_id = '${bookings["dup-job"].id}'`,
        ),
        "1",
      );
      ok.dupInvoice = results[0].body.invoice;
    },
  );

  await check(
    "DATABASE: invoice numbers are unique and the counter has no gaps",
    async () => {
      const year = new Date().getUTCFullYear();
      const numbers = await rows(
        `select invoice_number, sequence_number from public.invoices
       where invoice_year = ${year} order by sequence_number`,
      );
      const maxSeq = Math.max(...numbers.map((row) => row.sequence_number));
      assert.equal(
        maxSeq,
        numbers.length,
        "highest number equals invoice count: no gap",
      );
      assert.equal(
        new Set(numbers.map((row) => row.invoice_number)).size,
        numbers.length,
      );
      for (const row of numbers) {
        assert.equal(
          row.invoice_number,
          `INV-${year}-${String(row.sequence_number).padStart(6, "0")}`,
        );
      }
      const counter = await sql(
        `select last_value from public.invoice_number_counters where invoice_year = ${year}`,
      );
      assert.equal(Number(counter), maxSeq);
    },
  );

  await check(
    "DATABASE: one invoice per booking and per payment; issued invoices cannot change",
    async () => {
      await rejectsWithText(
        sql(`insert into public.invoices (trip_id, user_id, booking_id, payment_id, invoice_year, sequence_number,
             invoice_number, currency, subtotal, tax, total, pricing_policy)
           select trip_id, user_id, booking_id, payment_id, 2026, 900002, 'INV-2026-900002', currency, subtotal, tax, total, pricing_policy
           from public.invoices where id = '${invoice.id}'`),
        ["invoices_booking_unique", "duplicate key"],
        "second invoice for one booking",
      );
      await rejectsWithText(
        sql(
          `update public.invoices set total = total + 1, subtotal = subtotal + 1 where id = '${invoice.id}'`,
        ),
        ["INVOICE_IMMUTABLE_COLUMN"],
        "amount change",
      );
      await rejectsWithText(
        sql(
          `update public.invoices set status = 'failed', pdf_error_code = 'X' where id = '${invoice.id}'`,
        ),
        ["INVOICE_ISSUED_IS_FINAL"],
        "status change of an issued invoice",
      );
      await rejectsWithText(
        sql(
          `update public.invoices set invoice_number = 'INV-2026-000999' where id = '${invoice.id}'`,
        ),
        ["INVOICE_IMMUTABLE_COLUMN", "invoices_number_format_check"],
        "number change",
      );
      // A forged amount does not pass the trigger.
      await rejectsWithText(
        sql(`insert into public.invoices (trip_id, user_id, booking_id, payment_id, invoice_year, sequence_number,
             invoice_number, currency, subtotal, tax, total, pricing_policy)
           select b.trip_id, b.user_id, b.id, p.id, 2026, 900003, 'INV-2026-900003', b.currency, 1, 0, 1, b.pricing_policy
           from public.bookings b join public.payments p on p.booking_id = b.id
           where b.id = '${bookings.tamper.id}'`),
        ["INVOICE_BOOKING_AMOUNT_MISMATCH"],
        "forged amount",
      );
    },
  );

  // --- download ----------------------------------------------------------------------
  let pdfBytes;
  await check(
    "API: download streams the PDF and its SHA-256 equals the stored checksum",
    async () => {
      const response = await apiBytes(
        invoice.pdf.download_path.slice("/api/v1".length),
        demo,
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "application/pdf");
      assert.ok(
        response.headers
          .get("content-disposition")
          .includes(`invoice-${invoice.invoice_number}.pdf`),
      );
      pdfBytes = response.bytes;
      const text = new TextDecoder("latin1").decode(pdfBytes);
      assert.ok(text.startsWith("%PDF-1.4"));
      assert.ok(text.trimEnd().endsWith("%%EOF"));
      assert.equal(sha256(pdfBytes), invoice.pdf.sha256);
      assert.equal(
        response.headers.get("x-content-sha256"),
        invoice.pdf.sha256,
      );
      assert.equal(pdfBytes.length, invoice.pdf.size_bytes);
      const stored = await rows(
        `select o.sha256, o.size_bytes, o.bucket, o.object_path from public.document_storage_objects o
       join public.invoices i on i.pdf_object_id = o.id where i.id = '${invoice.id}'`,
      );
      assert.equal(stored[0].sha256, sha256(pdfBytes));
      assert.equal(stored[0].bucket, "invoices");
      ok.objectPath = stored[0].object_path;
      const direct = await storageGet(
        `/object/invoices/${ok.objectPath}`,
        SERVICE,
      );
      assert.equal(direct.status, 200);
      assert.equal(
        sha256(direct.bytes),
        invoice.pdf.sha256,
        "the object in the bucket has the same bytes",
      );
    },
  );

  await check(
    "API: the PDF opens and shows the invoice (pdfinfo and pdftotext)",
    async () => {
      const probe = spawnSync("pdfinfo", ["-v"], { encoding: "utf8" });
      if (probe.error) throw new Error("pdfinfo is not installed");
      const dir = mkdtempSync(join(tmpdir(), "tf11-"));
      try {
        const file = join(dir, "invoice.pdf");
        writeFileSync(file, pdfBytes);
        const info = spawnSync("pdfinfo", [file], { encoding: "utf8" });
        assert.equal(info.status, 0, info.stderr);
        assert.ok(info.stdout.includes("Pages:           1"), info.stdout);
        assert.ok(info.stdout.includes("A4"), info.stdout);
        const read = spawnSync("pdftotext", ["-layout", file, "-"], {
          encoding: "utf8",
        });
        assert.equal(read.status, 0, read.stderr);
        for (const expected of [
          invoice.invoice_number,
          paidConfirmation,
          payments.paid.payment_reference,
          "succeeded",
          "Itinerary item booking",
          "Fixture Dinner (Rooftop)",
          "100,000",
          "10,000",
          "110,000",
          "Subtotal",
          "Tax",
          "Pricing policy: demo-pricing-v1",
          "no real money moved",
        ]) {
          assert.ok(
            read.stdout.includes(expected),
            `"${expected}" not in PDF text:\n${read.stdout}`,
          );
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  // --- ownership and privacy ------------------------------------------------------------
  await check(
    "API: another user is refused (404) on state, generate, download, email, and deliveries",
    async () => {
      const routes = [
        [
          "GET",
          `/trips/${TRIP}/bookings/${bookings.paid.id}/invoice`,
          undefined,
        ],
        [
          "POST",
          `/trips/${TRIP}/bookings/${bookings.paid.id}/invoice/generate`,
          undefined,
        ],
        [
          "GET",
          `/trips/${TRIP}/invoices/${invoice.id}/email-deliveries`,
          undefined,
        ],
        [
          "POST",
          `/trips/${TRIP}/invoices/${invoice.id}/email`,
          { recipient_email: "x@example.com" },
        ],
      ];
      for (const [method, path, body] of routes) {
        const response = await api(path, other, {
          method,
          ...(body ? { body } : {}),
        });
        assert.equal(
          response.status,
          404,
          `${method} ${path}: ${response.text}`,
        );
      }
      const download = await apiBytes(
        `/trips/${TRIP}/invoices/${invoice.id}/download`,
        other,
      );
      assert.equal(download.status, 404);
      assert.ok(!new TextDecoder().decode(download.bytes).includes("%PDF"));
      const anonymous = await apiBytes(
        `/trips/${TRIP}/invoices/${invoice.id}/download`,
        null,
      );
      assert.equal(anonymous.status, 401);
    },
  );

  await check(
    "STORAGE: the private bucket cannot be read without the service role",
    async () => {
      const path = ok.objectPath;
      const attempts = [
        [
          "public URL",
          await storageGet(`/object/public/invoices/${path}`, ANON),
        ],
        ["anon key", await storageGet(`/object/invoices/${path}`, ANON)],
        [
          "owner user token",
          await storageGet(`/object/invoices/${path}`, demo, ANON),
        ],
        [
          "owner authenticated route",
          await storageGet(
            `/object/authenticated/invoices/${path}`,
            demo,
            ANON,
          ),
        ],
        [
          "other user token",
          await storageGet(`/object/invoices/${path}`, other, ANON),
        ],
      ];
      for (const [label, result] of attempts) {
        assert.notEqual(result.status, 200, `${label} read the PDF`);
        assert.ok(
          !new TextDecoder("latin1").decode(result.bytes).startsWith("%PDF"),
          label,
        );
      }
      for (const [label, token] of [
        ["owner", demo],
        ["other", other],
      ]) {
        const list = await fetch(
          `${env.SUPABASE_URL}/storage/v1/object/list/invoices`,
          {
            method: "POST",
            headers: {
              apikey: ANON,
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ prefix: TRIP, limit: 10 }),
          },
        );
        const body = await list.json().catch(() => null);
        assert.ok(
          !Array.isArray(body) || body.length === 0,
          `${label} listed objects`,
        );
        const sign = await fetch(
          `${env.SUPABASE_URL}/storage/v1/object/sign/invoices/${path}`,
          {
            method: "POST",
            headers: {
              apikey: ANON,
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ expiresIn: 60 }),
          },
        );
        assert.notEqual(sign.status, 200, `${label} created a signed URL`);
        const write = await fetch(
          `${env.SUPABASE_URL}/storage/v1/object/invoices/${TRIP}/forged.pdf`,
          {
            method: "POST",
            headers: {
              apikey: ANON,
              authorization: `Bearer ${token}`,
              "content-type": "application/pdf",
            },
            body: pdfBytes,
          },
        );
        assert.notEqual(write.status, 200, `${label} wrote into the bucket`);
      }
      const reading = await storageGet(`/object/invoices/${path}`, SERVICE);
      assert.equal(
        reading.status,
        200,
        "the object exists, so the refusals above are about access",
      );
    },
  );

  await check(
    "DATABASE: users read only their own invoices and cannot write any invoice table",
    async () => {
      const own = await rest(`/invoices?id=eq.${invoice.id}&select=id`, demo);
      assert.equal(own.status, 200);
      assert.equal(own.body.length, 1);
      for (const table of [
        "invoices",
        "email_deliveries",
        "document_storage_objects",
      ]) {
        const foreign = await rest(
          `/${table}?trip_id=eq.${TRIP}&select=id`,
          other,
        );
        assert.equal(foreign.status, 200, table);
        assert.deepEqual(foreign.body, [], `${table} leaked to another user`);
        const anonymous = await rest(`/${table}?select=id`, ANON);
        assert.ok(
          anonymous.status === 401 ||
            anonymous.status === 403 ||
            (anonymous.status === 200 && anonymous.body.length === 0),
          `${table} anon ${anonymous.status}`,
        );
      }
      for (const [table, body] of [
        ["invoices", { trip_id: TRIP }],
        ["email_deliveries", { trip_id: TRIP }],
        ["document_storage_objects", { trip_id: TRIP }],
      ]) {
        const write = await rest(`/${table}`, demo, { method: "POST", body });
        assert.ok(
          [401, 403].includes(write.status),
          `${table} insert ${write.status}`,
        );
      }
      const counters = await rest("/invoice_number_counters?select=*", demo);
      assert.ok(
        [401, 403].includes(counters.status),
        `counters ${counters.status}`,
      );
      for (const fn of [
        "prepare_invoice",
        "claim_email_delivery",
        "create_email_delivery",
        "enqueue_invoice_generation",
      ]) {
        const call = await rest(`/rpc/${fn}`, demo, {
          method: "POST",
          body: {},
        });
        assert.ok(
          [401, 403, 404].includes(call.status),
          `${fn} callable by a user: ${call.status}`,
        );
      }
    },
  );

  // --- email: real delivery ------------------------------------------------------------
  const recipient = `task11-${RUN}@example.com`;
  const resendRecipient = `task11-resend-${RUN}@example.com`;

  await check(
    "API: invalid recipients are refused and nothing is recorded",
    async () => {
      for (const bad of [
        "",
        "not-an-email",
        "a@b",
        "two@@example.com",
        "sp ace@example.com",
        "a@example.com\r\nBcc: evil@example.com",
        "<a@example.com>",
      ]) {
        const response = await api(
          `/trips/${TRIP}/invoices/${invoice.id}/email`,
          demo,
          {
            method: "POST",
            body: { recipient_email: bad },
          },
        );
        assert.equal(response.status, 400, JSON.stringify(bad));
        assert.ok(
          ["EMAIL_RECIPIENT_INVALID", "REQUEST_INVALID"].includes(
            response.body.error.code,
          ),
          response.text,
        );
      }
      const noKey = await fetch(
        `${apiBase()}/trips/${TRIP}/invoices/${invoice.id}/email`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${demo}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ recipient_email: recipient }),
        },
      );
      assert.equal(noKey.status, 400);
      const extra = await api(
        `/trips/${TRIP}/invoices/${invoice.id}/email`,
        demo,
        {
          method: "POST",
          body: { recipient_email: recipient, cc: "x@example.com" },
        },
      );
      assert.equal(extra.status, 400);
      assert.equal(
        await sql(
          `select count(*) from public.email_deliveries where invoice_id = '${invoice.id}'`,
        ),
        "0",
      );
    },
  );

  const goodWorker = startWorker("smtp");
  await waitFor("the worker to start", () =>
    goodWorker.lines.some((line) => line.includes("worker.started")),
  );

  let delivery;
  await check(
    "EMAIL: the invoice email reaches Mailpit with the PDF attached, identical to the download",
    async () => {
      const key = `validator-email-${randomUUID()}`;
      const response = await api(
        `/trips/${TRIP}/invoices/${invoice.id}/email`,
        demo,
        {
          method: "POST",
          body: { recipient_email: recipient },
          idempotencyKey: key,
        },
      );
      assert.equal(response.status, 202, response.text);
      delivery = response.body.delivery;
      ok.emailKey = key;
      assert.equal(delivery.status, "pending");
      assert.equal(delivery.sequence, 1);
      assert.equal(delivery.recipient_email, recipient);
      delivery = await waitFor("the delivery to finish", async () => {
        const list = await api(
          `/trips/${TRIP}/invoices/${invoice.id}/email-deliveries`,
          demo,
        );
        const found = list.body.items.find((item) => item.id === delivery.id);
        return found && found.status !== "pending" ? found : null;
      });
      assert.equal(delivery.status, "sent", JSON.stringify(delivery));
      assert.equal(delivery.provider, "smtp");
      assert.ok(delivery.provider_message_id.length > 0);
      assert.equal(delivery.error_code, null);
      assert.equal(delivery.attachment_sha256, invoice.pdf.sha256);

      const messages = await mailpitMessagesTo(recipient);
      assert.equal(
        messages.length,
        1,
        `Mailpit holds ${messages.length} messages for ${recipient}`,
      );
      const summary = messages[0];
      createdMail.add(summary.ID);
      const detail = await mailpit(`/api/v1/message/${summary.ID}`);
      assert.equal(detail.status, 200);
      assert.ok(
        detail.json.Subject.includes(invoice.invoice_number),
        detail.json.Subject,
      );
      assert.ok(
        detail.json.Subject.includes(paidConfirmation),
        detail.json.Subject,
      );
      assert.ok(
        detail.json.Text.includes(`Invoice number: ${invoice.invoice_number}`),
      );
      assert.ok(detail.json.Text.includes("Total: IDR 110,000"));
      assert.equal(detail.json.Attachments.length, 1);
      const attachment = detail.json.Attachments[0];
      assert.equal(
        attachment.FileName,
        `invoice-${invoice.invoice_number}.pdf`,
      );
      assert.equal(attachment.ContentType, "application/pdf");
      const part = await fetch(
        `${MAILPIT}/api/v1/message/${summary.ID}/part/${attachment.PartID}`,
      );
      const attached = new Uint8Array(await part.arrayBuffer());
      assert.equal(attached.length, pdfBytes.length);
      assert.equal(
        sha256(attached),
        sha256(pdfBytes),
        "attachment equals the downloaded PDF",
      );
      assert.equal(
        detail.json.MessageID.split("<").join("").split(">").join(""),
        delivery.provider_message_id.split("<").join("").split(">").join(""),
        "provider_message_id is the Message-ID Mailpit received",
      );
      console.log(
        `      EVIDENCE Mailpit: subject="${detail.json.Subject}" to=${detail.json.To.map((to) => to.Address).join(",")} ` +
          `attachment="${attachment.FileName}" size=${attached.length} sha256=${sha256(attached).slice(0, 16)}…`,
      );
    },
  );

  await check(
    "EMAIL: the send_invoice_email job succeeded and booking and payment are unchanged",
    async () => {
      const jobs = await rows(
        `select status, result_summary, error_code from public.background_jobs
       where trip_id = '${TRIP}' and job_type = 'send_invoice_email'
         and payload->>'email_delivery_id' = '${delivery.id}'`,
      );
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].status, "succeeded");
      assert.equal(jobs[0].result_summary.outcome, "email_sent");
      const state = await rows(
        `select b.status as booking_status, p.status as payment_status
       from public.bookings b join public.payments p on p.booking_id = b.id where b.id = '${bookings.paid.id}'`,
      );
      assert.equal(state[0].booking_status, "confirmed");
      assert.equal(state[0].payment_status, "succeeded");
    },
  );

  await check(
    "EMAIL: the same request again is one delivery and sends no second message",
    async () => {
      const replay = await api(
        `/trips/${TRIP}/invoices/${invoice.id}/email`,
        demo,
        {
          method: "POST",
          body: { recipient_email: recipient },
          idempotencyKey: ok.emailKey,
        },
      );
      assert.equal(replay.status, 202, replay.text);
      assert.equal(replay.body.delivery.id, delivery.id);
      const conflict = await api(
        `/trips/${TRIP}/invoices/${invoice.id}/email`,
        demo,
        {
          method: "POST",
          body: { recipient_email: `other-${recipient}` },
          idempotencyKey: ok.emailKey,
        },
      );
      assert.equal(conflict.status, 409);
      await sleep(2500);
      assert.equal((await mailpitMessagesTo(recipient)).length, 1);
      assert.equal(
        await sql(
          `select count(*) from public.email_deliveries where invoice_id = '${invoice.id}'`,
        ),
        "1",
      );
    },
  );

  await check(
    "EMAIL: a duplicate send_invoice_email job for a sent delivery sends nothing",
    async () => {
      await sql(`insert into public.background_jobs (trip_id, user_id, job_type, payload, idempotency_key, correlation_id)
      values ('${TRIP}', '${demoUserId}', 'send_invoice_email',
              jsonb_build_object('email_delivery_id', '${delivery.id}'),
              'validator-duplicate-email-${RUN}', 'validator-${RUN}')`);
      const job = await waitFor("the duplicate job to finish", async () => {
        const found = await rows(
          `select status, result_summary, error_code from public.background_jobs
         where idempotency_key = 'validator-duplicate-email-${RUN}'`,
        );
        return found[0] && !["queued", "running"].includes(found[0].status)
          ? found[0]
          : null;
      });
      assert.equal(job.status, "succeeded", JSON.stringify(job));
      assert.equal(job.result_summary.outcome, "email_already_sent");
      await sleep(1500);
      assert.equal(
        (await mailpitMessagesTo(recipient)).length,
        1,
        "still one message",
      );
      // The database also refuses a second job with the key of the original one.
      await rejectsWithText(
        sql(`insert into public.background_jobs (trip_id, user_id, job_type, payload, idempotency_key, correlation_id)
           values ('${TRIP}', '${demoUserId}', 'send_invoice_email',
                   jsonb_build_object('email_delivery_id', '${delivery.id}'),
                   'send_invoice_email:${delivery.id}', 'validator-${RUN}')`),
        ["background_jobs_idempotency_key_unique", "duplicate key"],
        "second job with the same key",
      );
    },
  );

  await check(
    "EMAIL: Send again is a new request, a new delivery, and a second message",
    async () => {
      const response = await api(
        `/trips/${TRIP}/invoices/${invoice.id}/email`,
        demo,
        {
          method: "POST",
          body: { recipient_email: resendRecipient },
        },
      );
      assert.equal(response.status, 202, response.text);
      assert.notEqual(response.body.delivery.id, delivery.id);
      assert.equal(response.body.delivery.sequence, 2);
      const sent = await waitFor("the second delivery", async () => {
        const list = await api(
          `/trips/${TRIP}/invoices/${invoice.id}/email-deliveries`,
          demo,
        );
        return list.body.items.find(
          (item) =>
            item.id === response.body.delivery.id && item.status !== "pending",
        );
      });
      assert.equal(sent.status, "sent");
      const messages = await mailpitMessagesTo(resendRecipient);
      assert.equal(messages.length, 1);
      createdMail.add(messages[0].ID);
      const list = await api(
        `/trips/${TRIP}/invoices/${invoice.id}/email-deliveries`,
        demo,
      );
      assert.deepEqual(
        list.body.items.map((item) => item.sequence),
        [2, 1],
      );
      assert.notEqual(
        list.body.items[0].provider_message_id,
        list.body.items[1].provider_message_id,
      );
    },
  );

  // --- automatic generation through the job runner ----------------------------------------
  await check(
    "API+WORKER: a payment made through the API queues one generate_invoice job and the worker issues the invoice",
    async () => {
      const payResponse = await api(
        `/trips/${TRIP}/bookings/${bookings.auto.id}/payments`,
        demo,
        {
          method: "POST",
          body: { outcome: "succeeded" },
        },
      );
      assert.equal(payResponse.status, 201, payResponse.text);
      const paymentId = payResponse.body.payment.id;
      const jobKey = `generate_invoice:${paymentId}`;
      const job = await waitFor("the generate_invoice job", async () => {
        const found = await rows(
          `select status, result_summary, error_code from public.background_jobs where idempotency_key = '${jobKey}'`,
        );
        return found[0] && !["queued", "running"].includes(found[0].status)
          ? found[0]
          : null;
      });
      assert.equal(job.status, "succeeded", JSON.stringify(job));
      assert.equal(job.result_summary.outcome, "invoice_issued");
      const state = await api(
        `/trips/${TRIP}/bookings/${bookings.auto.id}/invoice`,
        demo,
      );
      assert.equal(state.body.invoice.status, "issued");
      assert.equal(
        state.body.invoice.invoice_number,
        job.result_summary.invoice_number,
      );
      assert.equal(
        state.body.invoice.pdf.sha256,
        job.result_summary.pdf_sha256,
      );
      assert.equal(
        await sql(
          `select count(*) from public.background_jobs where idempotency_key = '${jobKey}'`,
        ),
        "1",
      );
      ok.autoInvoice = state.body.invoice;
      // The worker and a manual request share one invoice.
      const manual = await generate(bookings.auto.id);
      assert.equal(manual.status, 200);
      assert.equal(manual.body.invoice.id, state.body.invoice.id);
    },
  );

  await check(
    "WORKER: a duplicate generate_invoice job creates no second invoice",
    async () => {
      await sql(`insert into public.background_jobs (trip_id, user_id, job_type, payload, idempotency_key, correlation_id)
      values ('${TRIP}', '${demoUserId}', 'generate_invoice',
              jsonb_build_object('booking_id', '${bookings.auto.id}', 'payment_id', '${ok.autoInvoice.payment_id}'),
              'validator-duplicate-generate-${RUN}', 'validator-${RUN}')`);
      const job = await waitFor("the duplicate generate job", async () => {
        const found = await rows(
          `select status, result_summary from public.background_jobs where idempotency_key = 'validator-duplicate-generate-${RUN}'`,
        );
        return found[0] && !["queued", "running"].includes(found[0].status)
          ? found[0]
          : null;
      });
      assert.equal(job.status, "succeeded");
      assert.equal(job.result_summary.outcome, "invoice_exists");
      assert.equal(
        await sql(
          `select count(*) from public.invoices where booking_id = '${bookings.auto.id}'`,
        ),
        "1",
      );
    },
  );

  await check(
    "WORKER: a generate_invoice job for a booking without a succeeded payment fails and issues nothing",
    async () => {
      await sql(`insert into public.background_jobs (trip_id, user_id, job_type, payload, idempotency_key, correlation_id)
      values ('${TRIP}', '${demoUserId}', 'generate_invoice',
              jsonb_build_object('booking_id', '${bookings.failed.id}', 'payment_id', '${payments.failed.id}'),
              'validator-bad-generate-${RUN}', 'validator-${RUN}')`);
      const job = await waitFor("the refused generate job", async () => {
        const found = await rows(
          `select status, error_code from public.background_jobs where idempotency_key = 'validator-bad-generate-${RUN}'`,
        );
        return found[0] && !["queued", "running"].includes(found[0].status)
          ? found[0]
          : null;
      });
      assert.equal(job.status, "failed");
      assert.equal(job.error_code, "JOB_PRECONDITION_FAILED");
      assert.equal(
        await sql(
          `select count(*) from public.invoices where booking_id = '${bookings.failed.id}'`,
        ),
        "0",
      );
    },
  );

  // --- tamper: no email before the PDF is valid ----------------------------------------------
  await check(
    "EMAIL: a stored PDF that fails its checksum is not downloaded and not emailed",
    async () => {
      const issued = await generate(bookings.tamper.id);
      assert.equal(issued.status, 201, issued.text);
      const tampered = issued.body.invoice;
      const object = (
        await rows(
          `select o.object_path from public.document_storage_objects o
         join public.invoices i on i.pdf_object_id = o.id where i.id = '${tampered.id}'`,
        )
      )[0].object_path;
      const original = (await storageGet(`/object/invoices/${object}`, SERVICE))
        .bytes;
      const replace = async (bytes) => {
        const response = await fetch(
          `${env.SUPABASE_URL}/storage/v1/object/invoices/${object}`,
          {
            method: "PUT",
            headers: {
              apikey: SERVICE,
              authorization: `Bearer ${SERVICE}`,
              "content-type": "application/pdf",
            },
            body: bytes,
          },
        );
        assert.equal(response.status, 200, await response.text());
      };
      const forged = Uint8Array.from(original);
      forged[forged.length - 20] ^= 0x01;
      await replace(forged);
      try {
        const download = await apiBytes(
          `/trips/${TRIP}/invoices/${tampered.id}/download`,
          demo,
        );
        assert.equal(download.status, 500);
        assert.ok(
          !new TextDecoder("latin1").decode(download.bytes).startsWith("%PDF"),
        );
        assert.ok(
          new TextDecoder()
            .decode(download.bytes)
            .includes("INVOICE_CHECKSUM_MISMATCH"),
        );

        const tamperRecipient = `task11-tamper-${RUN}@example.com`;
        const request = await api(
          `/trips/${TRIP}/invoices/${tampered.id}/email`,
          demo,
          {
            method: "POST",
            body: { recipient_email: tamperRecipient },
          },
        );
        assert.equal(request.status, 202);
        const done = await waitFor("the tampered delivery", async () => {
          const list = await api(
            `/trips/${TRIP}/invoices/${tampered.id}/email-deliveries`,
            demo,
          );
          return list.body.items.find((item) => item.status !== "pending");
        });
        assert.equal(done.status, "failed");
        assert.equal(done.error_code, "EMAIL_ATTACHMENT_INVALID");
        assert.equal(done.provider_message_id, null);
        await sleep(1000);
        assert.equal(
          (await mailpitMessagesTo(tamperRecipient)).length,
          0,
          "no message left the system",
        );
      } finally {
        await replace(original);
      }
      const restored = await apiBytes(
        `/trips/${TRIP}/invoices/${tampered.id}/download`,
        demo,
      );
      assert.equal(restored.status, 200);
      assert.equal(sha256(restored.bytes), tampered.pdf.sha256);
    },
  );

  // --- provider failure ---------------------------------------------------------------------
  await stopWorker(goodWorker);
  const brokenWorker = startWorker("smtp-broken", { SMTP_PORT: "1" });
  await waitFor("the broken-SMTP worker to start", () =>
    brokenWorker.lines.some((line) => line.includes("worker.started")),
  );
  const failMailInvoice = (await generate(bookings["fail-mail"].id)).body
    .invoice;

  await check(
    "EMAIL: a provider failure marks the delivery failed and leaves booking, payment, and invoice unchanged",
    async () => {
      const snapshot = () =>
        rows(
          `select b.status as booking_status, b.updated_at as booking_updated, p.status as payment_status,
                p.updated_at as payment_updated, i.status as invoice_status, i.updated_at as invoice_updated,
                i.pdf_sha256
         from public.bookings b join public.payments p on p.booking_id = b.id
         join public.invoices i on i.booking_id = b.id where b.id = '${bookings["fail-mail"].id}'`,
        );
      const before = await snapshot();
      const failRecipient = `task11-fail-${RUN}@example.com`;
      const request = await api(
        `/trips/${TRIP}/invoices/${failMailInvoice.id}/email`,
        demo,
        {
          method: "POST",
          body: { recipient_email: failRecipient },
        },
      );
      assert.equal(request.status, 202, request.text);
      const failed = await waitFor("the failed delivery", async () => {
        const list = await api(
          `/trips/${TRIP}/invoices/${failMailInvoice.id}/email-deliveries`,
          demo,
        );
        return list.body.items.find(
          (item) =>
            item.id === request.body.delivery.id && item.status !== "pending",
        );
      });
      assert.equal(failed.status, "failed", JSON.stringify(failed));
      assert.equal(failed.error_code, "EMAIL_PROVIDER_UNREACHABLE");
      assert.equal(failed.provider, "smtp");
      assert.equal(failed.provider_message_id, null);
      assert.ok(!failed.error_message.includes("127.0.0.1"));
      assert.ok(!failed.error_message.includes("172."));
      assert.deepEqual(
        await snapshot(),
        before,
        "booking, payment, and invoice rows did not change",
      );
      const job = (
        await rows(
          `select status, error_code, result_summary from public.background_jobs
         where trip_id = '${TRIP}' and job_type = 'send_invoice_email'
           and payload->>'email_delivery_id' = '${failed.id}'`,
        )
      )[0];
      assert.equal(job.status, "failed");
      assert.equal(job.error_code, "JOB_PROVIDER_ERROR");
      assert.equal((await mailpitMessagesTo(failRecipient)).length, 0);
      // The failed delivery is final: nothing retried it on its own.
      await sleep(2000);
      const again = await api(
        `/trips/${TRIP}/invoices/${failMailInvoice.id}/email-deliveries`,
        demo,
      );
      assert.equal(again.body.items.length, 1);
      assert.equal(again.body.items[0].status, "failed");
      assert.equal(
        brokenWorker.lines.filter((line) => line.includes("email.failed"))
          .length,
        1,
      );
      ok.failedDelivery = failed;
    },
  );

  await stopWorker(brokenWorker);
  const recoverWorker = startWorker("smtp-recovered");
  await waitFor("the recovered worker to start", () =>
    recoverWorker.lines.some((line) => line.includes("worker.started")),
  );

  await check(
    "EMAIL: after a failure, Send again with a working provider delivers",
    async () => {
      const retryRecipient = `task11-after-fail-${RUN}@example.com`;
      const request = await api(
        `/trips/${TRIP}/invoices/${failMailInvoice.id}/email`,
        demo,
        {
          method: "POST",
          body: { recipient_email: retryRecipient },
        },
      );
      assert.equal(request.status, 202);
      assert.equal(request.body.delivery.sequence, 2);
      const sent = await waitFor("the new delivery", async () => {
        const list = await api(
          `/trips/${TRIP}/invoices/${failMailInvoice.id}/email-deliveries`,
          demo,
        );
        return list.body.items.find(
          (item) =>
            item.id === request.body.delivery.id && item.status !== "pending",
        );
      });
      assert.equal(sent.status, "sent");
      const messages = await mailpitMessagesTo(retryRecipient);
      assert.equal(messages.length, 1);
      createdMail.add(messages[0].ID);
      const list = await api(
        `/trips/${TRIP}/invoices/${failMailInvoice.id}/email-deliveries`,
        demo,
      );
      assert.deepEqual(
        list.body.items.map((item) => item.status),
        ["sent", "failed"],
      );
    },
  );

  // --- totals ----------------------------------------------------------------------------------
  await check(
    "DATABASE: invoices = confirmed bookings = succeeded payments for this trip, none for failed ones",
    async () => {
      const counts = (
        await rows(
          `select
           (select count(*) from public.invoices where trip_id = '${TRIP}') as invoices,
           (select count(*) from public.bookings where trip_id = '${TRIP}' and status = 'confirmed') as confirmed,
           (select count(*) from public.payments p join public.bookings b on b.id = p.booking_id
              where b.trip_id = '${TRIP}' and p.status = 'succeeded') as succeeded`,
        )
      )[0];
      // refunded booking: payment is refunded, so it is neither confirmed nor succeeded.
      assert.equal(Number(counts.invoices), Number(counts.confirmed));
      assert.equal(Number(counts.invoices), Number(counts.succeeded));
      assert.equal(Number(counts.invoices), 5, JSON.stringify(counts));
      const mismatched = await sql(
        `select count(*) from public.invoices i
       join public.bookings b on b.id = i.booking_id join public.payments p on p.id = i.payment_id
       where i.trip_id = '${TRIP}' and (i.total <> b.total or i.total <> p.amount)`,
      );
      assert.equal(mismatched, "0");
    },
  );

  // --- Resend ------------------------------------------------------------------------------------
  if (!env.EMAIL_PROVIDER_API_KEY) {
    blocked(
      "EMAIL (Resend live): send through the Resend API",
      "EMAIL_PROVIDER_API_KEY is empty and no sender domain is verified. The adapter is covered by fixture tests in packages/integrations/test/email.test.mjs, which are not a live check.",
    );
  } else {
    blocked(
      "EMAIL (Resend live): send through the Resend API",
      "EMAIL_PROVIDER_API_KEY is set, but a live send needs a verified EMAIL_FROM domain and a real recipient. Run it by hand with EMAIL_PROVIDER=resend.",
    );
  }
} finally {
  await cleanup();
}

finish();
