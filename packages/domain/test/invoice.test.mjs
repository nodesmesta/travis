import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildInvoiceEmail,
  buildInvoicePdf,
  evaluateInvoiceEligibility,
  extractPdfText,
  formatAmount,
  formatInvoiceNumber,
  inspectPdf,
  parseEmailAddress,
  parseInvoiceNumber,
  parseJobPayload,
} from "../dist/index.js";

// Everything below is FIXTURE input written by hand for unit tests.
const BOOKING = "00000000-0000-0000-0000-0000000000b1";
const PAYMENT = "00000000-0000-0000-0000-0000000000c1";
const DELIVERY = "00000000-0000-0000-0000-0000000000d1";

const pdfInput = (overrides = {}) => ({
  invoiceNumber: "INV-2026-000007",
  issuedAt: "2026-11-07T14:03:09.000Z",
  bookingReference: "TF-ABCDEF1234",
  bookingType: "event",
  itemTitle: "Fixture Conference (Day 1)",
  currency: "IDR",
  subtotal: 250000,
  tax: 25000,
  total: 275000,
  paymentReference: "dummy_0123456789abcdef",
  paymentStatus: "succeeded",
  paidAt: "2026-11-07T14:02:55.000Z",
  pricingPolicy: "demo-pricing-v1",
  ...overrides,
});

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("invoice number: format, parse, and the limits", () => {
  assert.equal(formatInvoiceNumber(2026, 1), "INV-2026-000001");
  assert.equal(formatInvoiceNumber(2026, 999999), "INV-2026-999999");
  assert.deepEqual(parseInvoiceNumber("INV-2026-000042"), {
    year: 2026,
    sequence: 42,
  });
  for (const bad of [
    "INV-2026-000000",
    "INV-26-000001",
    "INV-2026-00001",
    "INV-2026_000001",
    "XXX-2026-000001",
    "INV-2026-00000a",
    "",
  ]) {
    assert.equal(parseInvoiceNumber(bad), null, bad);
  }
  assert.throws(() => formatInvoiceNumber(2026, 0), RangeError);
  assert.throws(() => formatInvoiceNumber(2026, 1000000), RangeError);
  assert.throws(() => formatInvoiceNumber(1999, 1), RangeError);
});

test("invoice number: consecutive numbers parse back in order", () => {
  const numbers = [1, 2, 3, 10, 99].map((n) => formatInvoiceNumber(2026, n));
  const parsed = numbers.map((value) => parseInvoiceNumber(value).sequence);
  assert.deepEqual(parsed, [1, 2, 3, 10, 99]);
  assert.deepEqual([...numbers].sort(), numbers);
});

test("PDF: valid structure, deterministic bytes, and readable invoice text", () => {
  const bytes = buildInvoicePdf(pdfInput());
  const again = buildInvoicePdf(pdfInput());
  assert.equal(sha(bytes), sha(again), "same input gives the same bytes");

  const text = new TextDecoder("latin1").decode(bytes);
  assert.ok(text.startsWith("%PDF-1.4"));
  assert.ok(text.trimEnd().endsWith("%%EOF"));

  const inspected = inspectPdf(bytes);
  assert.equal(inspected.valid, true, JSON.stringify(inspected));
  assert.equal(inspected.pageCount, 1);

  const lines = extractPdfText(bytes);
  for (const expected of [
    "INV-2026-000007",
    "TF-ABCDEF1234",
    "dummy_0123456789abcdef",
    "succeeded",
    "Event booking",
    "Fixture Conference (Day 1)",
    "250,000",
    "25,000",
    "275,000",
    "Subtotal",
    "Tax",
    "Total (IDR)",
    "2026-11-07 14:03 UTC",
    "Pricing policy: demo-pricing-v1",
    "Dummy payment \u2014 no real money moved.",
  ]) {
    assert.ok(
      lines.some((line) => line === expected || line.includes(expected)),
      `PDF text is missing "${expected}"; got ${JSON.stringify(lines)}`,
    );
  }
});

test("PDF: different input gives different bytes and checksum", () => {
  const first = sha(buildInvoicePdf(pdfInput()));
  const second = sha(buildInvoicePdf(pdfInput({ total: 275001 })));
  assert.notEqual(first, second);
});

test("PDF: parentheses, backslashes, accents, and unsupported characters stay valid", () => {
  const bytes = buildInvoicePdf(
    pdfInput({ itemTitle: "Caf\u00e9 (\\Live\\) \u4e2d\u6587 \u2013 night" }),
  );
  assert.equal(inspectPdf(bytes).valid, true);
  const joined = extractPdfText(bytes).join("|");
  assert.ok(joined.includes("(\\Live\\)"), joined);
  assert.ok(joined.includes("Caf\u00e9"), joined);
  assert.ok(joined.includes("??"), "unsupported characters become ?");
});

test("PDF: a long title wraps and a missing title is left out", () => {
  const long = buildInvoicePdf(pdfInput({ itemTitle: "word ".repeat(80) }));
  assert.equal(inspectPdf(long).valid, true);
  const none = buildInvoicePdf(pdfInput({ itemTitle: null }));
  const lines = extractPdfText(none);
  assert.ok(lines.includes("Event booking"));
  assert.ok(!lines.some((line) => line.includes("Fixture Conference")));
});

test("PDF inspector rejects damaged files", () => {
  const bytes = buildInvoicePdf(pdfInput());
  assert.equal(inspectPdf(new Uint8Array(10)).valid, false);
  assert.equal(inspectPdf(bytes.subarray(0, bytes.length - 8)).valid, false);
  const noHeader = bytes.slice();
  noHeader[1] = 0x58;
  assert.equal(inspectPdf(noHeader).valid, false);

  // Move one object: its xref offset no longer points at "N 0 obj".
  const text = new TextDecoder("latin1").decode(bytes);
  const shifted = new TextEncoder().encode(
    text.replace("%PDF-1.4\n", "%PDF-1.4\n\n"),
  );
  const result = inspectPdf(shifted);
  assert.equal(result.valid, false);
  assert.ok(result.reason.includes("xref"), result.reason);
});

test("PDF opens in poppler when it is installed", (t) => {
  const probe = spawnSync("pdfinfo", ["-v"], { encoding: "utf8" });
  if (probe.error) {
    t.skip("pdfinfo is not installed");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "tf-pdf-"));
  try {
    const file = join(dir, "invoice.pdf");
    writeFileSync(file, buildInvoicePdf(pdfInput()));
    const info = spawnSync("pdfinfo", [file], { encoding: "utf8" });
    assert.equal(info.status, 0, info.stderr);
    assert.ok(info.stdout.includes("Pages:           1"), info.stdout);
    assert.ok(info.stdout.includes("A4"), info.stdout);
    const read = spawnSync("pdftotext", ["-layout", file, "-"], {
      encoding: "utf8",
    });
    assert.equal(read.status, 0, read.stderr);
    for (const expected of [
      "INV-2026-000007",
      "TF-ABCDEF1234",
      "275,000",
      "no real money moved",
    ]) {
      assert.ok(
        read.stdout.includes(expected),
        `${expected} in ${read.stdout}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("amounts are grouped and keep cents only when needed", () => {
  assert.equal(formatAmount(0), "0");
  assert.equal(formatAmount(999), "999");
  assert.equal(formatAmount(1000), "1,000");
  assert.equal(formatAmount(1234567), "1,234,567");
  assert.equal(formatAmount(1234.5), "1,234.50");
});

const booking = (overrides = {}) => ({
  id: BOOKING,
  status: "confirmed",
  currency: "IDR",
  subtotal: 250000,
  tax: 25000,
  total: 275000,
  ...overrides,
});
const payment = (status, overrides = {}) => ({
  id: PAYMENT,
  booking_id: BOOKING,
  status,
  amount: 275000,
  currency: "IDR",
  created_at: "2026-11-07T10:00:00.000Z",
  ...overrides,
});

test("payment state guard: only a succeeded payment on a confirmed booking is eligible", () => {
  const ok = evaluateInvoiceEligibility(booking(), [payment("succeeded")]);
  assert.equal(ok.eligible, true);

  const cases = [
    ["failed", "PAYMENT_FAILED"],
    ["pending", "PAYMENT_PENDING"],
    ["cancelled", "PAYMENT_CANCELLED"],
    ["refunded", "PAYMENT_REFUNDED"],
  ];
  for (const [status, reason] of cases) {
    const result = evaluateInvoiceEligibility(booking(), [payment(status)]);
    assert.equal(result.eligible, false, status);
    assert.equal(result.reason, reason);
  }
  assert.equal(evaluateInvoiceEligibility(booking(), []).reason, "NO_PAYMENT");
  assert.equal(
    evaluateInvoiceEligibility(booking({ status: "refunded" }), [
      payment("succeeded"),
    ]).reason,
    "BOOKING_NOT_CONFIRMED",
  );
});

test("payment state guard: amounts must match to the cent", () => {
  assert.equal(
    evaluateInvoiceEligibility(booking(), [
      payment("succeeded", { amount: 275000.01 }),
    ]).reason,
    "AMOUNT_MISMATCH",
  );
  assert.equal(
    evaluateInvoiceEligibility(booking(), [
      payment("succeeded", { currency: "USD" }),
    ]).reason,
    "AMOUNT_MISMATCH",
  );
  assert.equal(
    evaluateInvoiceEligibility(booking({ tax: 1 }), [payment("succeeded")])
      .reason,
    "AMOUNT_MISMATCH",
  );
  // A payment of another booking does not count.
  assert.equal(
    evaluateInvoiceEligibility(booking(), [
      payment("succeeded", { booking_id: "other" }),
    ]).reason,
    "NO_PAYMENT",
  );
});

test("payment state guard: the newest non-succeeded payment names the reason", () => {
  const result = evaluateInvoiceEligibility(booking(), [
    payment("failed", { id: "a", created_at: "2026-11-07T09:00:00.000Z" }),
    payment("cancelled", { id: "b", created_at: "2026-11-07T11:00:00.000Z" }),
  ]);
  assert.equal(result.reason, "PAYMENT_CANCELLED");
});

test("email address: valid forms are accepted and the domain is lowercased", () => {
  for (const [input, address] of [
    ["person@example.com", "person@example.com"],
    ["  Person.Name+tag@Example.COM  ", "Person.Name+tag@example.com"],
    ["a@b.co", "a@b.co"],
    ["o'neil@mail.example.org", "o'neil@mail.example.org"],
    ["x_y-z@sub.domain.example.id", "x_y-z@sub.domain.example.id"],
  ]) {
    const result = parseEmailAddress(input);
    assert.equal(result.ok, true, input);
    assert.equal(result.address, address);
  }
});

test("email address: invalid forms are refused with a reason", () => {
  const cases = [
    ["", "EMPTY"],
    ["   ", "EMPTY"],
    ["no-at-sign.example.com", "MISSING_AT"],
    ["a@b@example.com", "MULTIPLE_AT"],
    ["@example.com", "LOCAL_PART_INVALID"],
    [".dot@example.com", "LOCAL_PART_INVALID"],
    ["dot.@example.com", "LOCAL_PART_INVALID"],
    ["do..ble@example.com", "LOCAL_PART_INVALID"],
    ["spa ce@example.com", "ILLEGAL_CHARACTER"],
    ["tab\t@example.com", "ILLEGAL_CHARACTER"],
    ["a@example.com\r\nbcc: x@example.com", "ILLEGAL_CHARACTER"],
    ["caf\u00e9@example.com", "ILLEGAL_CHARACTER"],
    ["a@localhost", "DOMAIN_INVALID"],
    ["a@example", "DOMAIN_INVALID"],
    ["a@-example.com", "DOMAIN_INVALID"],
    ["a@example-.com", "DOMAIN_INVALID"],
    ["a@exa_mple.com", "DOMAIN_INVALID"],
    ["a@example..com", "DOMAIN_INVALID"],
    ["a@example.c", "DOMAIN_INVALID"],
    ["a@192.168.0.1", "DOMAIN_INVALID"],
    ['"quoted"@example.com', "LOCAL_PART_INVALID"],
    ["Name <a@example.com>", "ILLEGAL_CHARACTER"],
    [`${"a".repeat(65)}@example.com`, "LOCAL_PART_INVALID"],
    [`a@${"b".repeat(64)}.com`, "DOMAIN_INVALID"],
    [`a@${"b".repeat(250)}.com`, "TOO_LONG"],
  ];
  for (const [input, problem] of cases) {
    const result = parseEmailAddress(input);
    assert.equal(result.ok, false, `${JSON.stringify(input)} must be refused`);
    assert.equal(result.problem, problem, JSON.stringify(input));
    assert.ok(result.message.length > 0);
  }
});

test("email text names the booking, invoice, total, and attachment", () => {
  const content = buildInvoiceEmail({
    bookingReference: "TF-ABCDEF1234",
    bookingType: "event",
    itemTitle: "Fixture Conference",
    invoiceNumber: "INV-2026-000007",
    currency: "IDR",
    total: 275000,
    paymentReference: "dummy_0123456789abcdef",
  });
  assert.ok(content.subject.includes("TF-ABCDEF1234"));
  assert.ok(content.subject.includes("INV-2026-000007"));
  assert.equal(content.attachmentFilename, "invoice-INV-2026-000007.pdf");
  assert.ok(content.text.includes("Total: IDR 275,000"));
  assert.ok(content.text.includes("Event booking: Fixture Conference"));
  assert.ok(content.text.includes("No real money moved."));
  const injected = buildInvoiceEmail({
    bookingReference: "TF-1\r\nBcc: evil@example.com",
    bookingType: "activity",
    itemTitle: null,
    invoiceNumber: "INV-2026-000007",
    currency: "IDR",
    total: 1,
    paymentReference: "p",
  });
  assert.ok(!injected.subject.includes("\n"));
  assert.ok(!injected.subject.includes("\r"));
});

test("invoice job payloads are checked before any work starts", () => {
  const generate = parseJobPayload("generate_invoice", {
    booking_id: BOOKING,
    payment_id: PAYMENT,
  });
  assert.equal(generate.job_type, "generate_invoice");
  assert.equal(generate.payload.booking_id, BOOKING);
  const send = parseJobPayload("send_invoice_email", {
    email_delivery_id: DELIVERY,
  });
  assert.equal(send.payload.email_delivery_id, DELIVERY);

  for (const [type, payload] of [
    ["generate_invoice", { booking_id: BOOKING }],
    ["generate_invoice", { booking_id: BOOKING, payment_id: "nope" }],
    ["generate_invoice", { booking_id: BOOKING, payment_id: PAYMENT, x: 1 }],
    ["send_invoice_email", {}],
    ["send_invoice_email", { email_delivery_id: DELIVERY, to: "a@b.co" }],
  ]) {
    assert.throws(
      () => parseJobPayload(type, payload),
      (error) => error.code === "JOB_PAYLOAD_INVALID",
      `${type} ${JSON.stringify(payload)}`,
    );
  }
});
