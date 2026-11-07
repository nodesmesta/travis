import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { EmailProviderError } from "@travelflow/integrations";
import { AppError } from "../dist/errors.js";
import { EmailDeliveryService } from "../dist/services/email-delivery-service.js";
import {
  InvoiceService,
  invoiceObjectPath,
  sha256Hex,
} from "../dist/services/invoice-service.js";

// Everything here is FIXTURE data and in-memory stand-ins for the repository, the
// private bucket, and the email provider. The SQL behind the repository is checked
// against the real database by scripts/validate-task-11.mjs.

const TRIP = "00000000-0000-0000-0000-0000000000a1";
const USER = "00000000-0000-0000-0000-0000000000b1";
const OTHER = "00000000-0000-0000-0000-0000000000b2";
const BOOKING = "00000000-0000-0000-0000-0000000000c1";
const PAYMENT = "00000000-0000-0000-0000-0000000000d1";
const NOW = "2026-11-07T14:00:00.000Z";

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

class FakeRepo {
  constructor({
    paymentStatus = "succeeded",
    bookingStatus = "confirmed",
  } = {}) {
    this.booking = {
      id: BOOKING,
      user_id: USER,
      trip_id: TRIP,
      booking_type: "event",
      source_type: "event_discovery_result",
      source_id: "00000000-0000-0000-0000-0000000000e1",
      confirmation_code: "TF-ABCDEF1234",
      status: bookingStatus,
      currency: "IDR",
      subtotal: 250000,
      tax: 25000,
      total: 275000,
      pricing_policy: "demo-pricing-v1",
    };
    this.payment = {
      id: PAYMENT,
      booking_id: BOOKING,
      payment_reference: "dummy_0123456789abcdef",
      status: paymentStatus,
      amount: 275000,
      currency: "IDR",
      paid_at: NOW,
      created_at: NOW,
    };
    this.invoices = new Map();
    this.objects = new Map();
    this.deliveries = new Map();
    this.counter = 0;
    this.prepareCalls = 0;
    this.busy = 0;
    this.mutations = { booking: 0, payment: 0 };
  }

  async getBooking(id, tripId) {
    return id === BOOKING && tripId === TRIP ? this.booking : null;
  }
  async listPayments() {
    return [this.payment];
  }
  async getPayment(id) {
    return id === PAYMENT ? this.payment : null;
  }
  async getItemTitle() {
    return "Fixture Conference";
  }
  async getInvoiceByBooking() {
    return [...this.invoices.values()][0] ?? null;
  }
  async getInvoice(id, tripId) {
    const invoice = this.invoices.get(id);
    return invoice && invoice.trip_id === tripId ? invoice : null;
  }
  async getInvoiceById(id) {
    return this.invoices.get(id) ?? null;
  }
  async getDocumentObject(id) {
    return this.objects.get(id) ?? null;
  }
  async getEmailDelivery(id) {
    return this.deliveries.get(id) ?? null;
  }
  async listEmailDeliveries(invoiceId) {
    return [...this.deliveries.values()]
      .filter((row) => row.invoice_id === invoiceId)
      .sort((a, b) => b.sequence - a.sequence);
  }

  async prepareInvoice(bookingId, userId) {
    this.prepareCalls += 1;
    if (bookingId !== BOOKING || userId !== USER) {
      throw new AppError("RESOURCE_NOT_FOUND", "not_found", 404, "no");
    }
    const existing = await this.getInvoiceByBooking();
    if (existing) {
      if (existing.status === "failed") {
        existing.status = "pending";
        existing.pdf_error_code = null;
      }
      if (existing.status === "pending" && this.busy > 0) {
        this.busy -= 1;
        return { created: false, in_progress: true, invoice: existing };
      }
      return { created: false, in_progress: false, invoice: existing };
    }
    this.counter += 1;
    const invoice = {
      id: "00000000-0000-0000-0000-0000000000f1",
      trip_id: TRIP,
      user_id: USER,
      booking_id: BOOKING,
      payment_id: PAYMENT,
      invoice_year: 2026,
      sequence_number: this.counter,
      invoice_number: `INV-2026-${String(this.counter).padStart(6, "0")}`,
      status: "pending",
      currency: "IDR",
      subtotal: 250000,
      tax: 25000,
      total: 275000,
      pricing_policy: "demo-pricing-v1",
      pdf_object_id: null,
      pdf_sha256: null,
      pdf_size_bytes: null,
      pdf_error_code: null,
      issued_at: NOW,
      created_at: NOW,
      updated_at: NOW,
    };
    this.invoices.set(invoice.id, invoice);
    return { created: true, in_progress: false, invoice };
  }
  async finalizeInvoice({ invoiceId, objectPath, sizeBytes, sha256 }) {
    const invoice = this.invoices.get(invoiceId);
    const object = {
      id: "00000000-0000-0000-0000-0000000000f2",
      object_path: objectPath,
    };
    this.objects.set(object.id, object);
    Object.assign(invoice, {
      status: "issued",
      pdf_object_id: object.id,
      pdf_sha256: sha256,
      pdf_size_bytes: sizeBytes,
      pdf_error_code: null,
    });
    return invoice;
  }
  async failInvoice(invoiceId, code) {
    const invoice = this.invoices.get(invoiceId);
    Object.assign(invoice, { status: "failed", pdf_error_code: code });
    return invoice;
  }
  async createEmailDelivery({ invoiceId, userId, recipient, idempotencyKey }) {
    const dedup = `invoice-email:${invoiceId}:${recipient.toLowerCase()}:${idempotencyKey}`;
    const existing = [...this.deliveries.values()].find(
      (row) => row.dedup_key === dedup,
    );
    if (existing) return { created: false, delivery: existing };
    const sequence = this.deliveries.size + 1;
    const delivery = {
      id: `00000000-0000-0000-0000-00000000010${sequence}`,
      trip_id: TRIP,
      user_id: userId,
      invoice_id: invoiceId,
      sequence,
      recipient_email: recipient,
      status: "pending",
      provider: null,
      provider_message_id: null,
      error_code: null,
      error_message: null,
      attachment_sha256: null,
      attachment_size_bytes: null,
      dedup_key: dedup,
      requested_at: NOW,
      attempted_at: null,
      sent_at: null,
      failed_at: null,
    };
    this.deliveries.set(delivery.id, delivery);
    return { created: true, delivery };
  }
  async claimEmailDelivery(id, provider) {
    const delivery = this.deliveries.get(id);
    if (!delivery || delivery.status !== "pending" || delivery.attempted_at) {
      return null;
    }
    delivery.provider = provider;
    delivery.attempted_at = NOW;
    return { ...delivery };
  }
  async completeEmailDelivery(input) {
    const delivery = this.deliveries.get(input.deliveryId);
    Object.assign(delivery, {
      status: input.status,
      provider_message_id: input.providerMessageId,
      error_code: input.errorCode,
      error_message: input.errorMessage,
      attachment_sha256: input.attachmentSha256,
      attachment_size_bytes: input.attachmentSizeBytes,
      sent_at: input.status === "sent" ? NOW : null,
      failed_at: input.status === "failed" ? NOW : null,
    });
    return { ...delivery };
  }
}

class FakeStorage {
  constructor() {
    this.files = new Map();
    this.uploads = 0;
    this.failUpload = false;
    this.corruptOnRead = false;
  }
  async upload(path, bytes) {
    this.uploads += 1;
    if (this.failUpload) {
      throw new AppError("INVOICE_STORAGE_FAILED", "persistence", 502, "no");
    }
    this.files.set(path, Uint8Array.from(bytes));
  }
  async download(path) {
    const bytes = this.files.get(path);
    if (!bytes) return null;
    if (this.corruptOnRead) {
      const copy = Uint8Array.from(bytes);
      copy[copy.length - 1] ^= 0xff;
      return copy;
    }
    return bytes;
  }
}

class FakeIdempotency {
  constructor() {
    this.records = new Map();
  }
  async execute(scope, context, operation) {
    const key = `${scope}|${context.idempotencyKey}`;
    const existing = this.records.get(key);
    if (existing) {
      if (existing.hash !== context.requestHash) {
        throw new AppError("IDEMPOTENCY_CONFLICT", "conflict", 409, "no");
      }
      return existing.result;
    }
    const result = await operation();
    this.records.set(key, { hash: context.requestHash, result });
    return result;
  }
}

function setup(options = {}) {
  const repo = new FakeRepo(options);
  const storage = new FakeStorage();
  const service = new InvoiceService({
    reads: repo,
    writes: repo,
    storage,
    logger,
    emailConfigured: () => options.emailConfigured ?? true,
    generationWaitMs: options.generationWaitMs ?? 1000,
  });
  return { repo, storage, service };
}

const actor = { tripId: TRIP, userId: USER };
const command = (key, body = {}) => ({
  actorUserId: USER,
  idempotencyKey: key,
  requestHash: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
});

async function rejectsWith(promise, code, status) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof AppError, `not an AppError: ${error}`);
    assert.equal(error.code, code);
    if (status) assert.equal(error.statusCode, status);
    return true;
  });
}

test("generate: issues the invoice, stores the PDF, and the checksum matches the stored bytes", async () => {
  const { repo, storage, service } = setup();
  const result = await service.generate(actor, BOOKING);
  assert.equal(result.created, true);
  const invoice = result.invoice;
  assert.equal(invoice.status, "issued");
  assert.equal(invoice.invoice_number, "INV-2026-000001");
  assert.equal(invoice.booking_reference, "TF-ABCDEF1234");
  assert.equal(invoice.payment_status, "succeeded");
  assert.equal(invoice.subtotal, 250000);
  assert.equal(invoice.tax, 25000);
  assert.equal(invoice.total, 275000);
  assert.equal(invoice.item_title, "Fixture Conference");
  const stored = storage.files.get(invoiceObjectPath(TRIP, invoice.id));
  assert.ok(stored, "the PDF is in the bucket");
  assert.equal(invoice.pdf.sha256, sha256Hex(stored));
  assert.equal(invoice.pdf.size_bytes, stored.length);
  assert.equal(
    invoice.pdf.download_path,
    `/api/v1/trips/${TRIP}/invoices/${invoice.id}/download`,
  );
  assert.equal(repo.mutations.booking + repo.mutations.payment, 0);
});

test("generate twice returns the same invoice and stores one PDF", async () => {
  const { repo, storage, service } = setup();
  const first = await service.generate(actor, BOOKING);
  const second = await service.generate(actor, BOOKING);
  assert.equal(second.created, false);
  assert.equal(second.invoice.id, first.invoice.id);
  assert.equal(second.invoice.invoice_number, first.invoice.invoice_number);
  assert.equal(repo.invoices.size, 1);
  assert.equal(repo.counter, 1, "no number was used up by the second call");
  assert.equal(storage.uploads, 1);
});

test("payment state guard: failed, pending, cancelled, and refunded payments issue no invoice", async () => {
  for (const status of ["failed", "pending", "cancelled", "refunded"]) {
    const { repo, storage, service } = setup({ paymentStatus: status });
    await rejectsWith(
      service.generate(actor, BOOKING),
      "INVOICE_NOT_ELIGIBLE",
      409,
    );
    assert.equal(repo.prepareCalls, 0, `${status}: nothing was numbered`);
    assert.equal(repo.invoices.size, 0);
    assert.equal(storage.uploads, 0);
  }
  const unconfirmed = setup({ bookingStatus: "pending_payment" });
  await rejectsWith(
    unconfirmed.service.generate(actor, BOOKING),
    "INVOICE_NOT_ELIGIBLE",
    409,
  );
});

test("another user gets 404 for generate, download, email, and deliveries", async () => {
  const { service } = setup();
  const issued = await service.generate(actor, BOOKING);
  const stranger = { tripId: TRIP, userId: OTHER };
  await rejectsWith(
    service.generate(stranger, BOOKING),
    "RESOURCE_NOT_FOUND",
    404,
  );
  await rejectsWith(
    service.download(stranger, issued.invoice.id),
    "RESOURCE_NOT_FOUND",
    404,
  );
  await rejectsWith(
    service.requestEmail(
      stranger,
      issued.invoice.id,
      "person@example.com",
      command("key-aaaaaaaaaaaaaaaa"),
      new FakeIdempotency(),
      "req-1",
    ),
    "RESOURCE_NOT_FOUND",
    404,
  );
  await rejectsWith(
    service.listEmailDeliveries(stranger, issued.invoice.id),
    "RESOURCE_NOT_FOUND",
    404,
  );
});

test("a storage failure marks the invoice failed and a new call resumes the same number", async () => {
  const { repo, storage, service } = setup();
  storage.failUpload = true;
  await rejectsWith(
    service.generate(actor, BOOKING),
    "INVOICE_STORAGE_FAILED",
    502,
  );
  const failed = [...repo.invoices.values()][0];
  assert.equal(failed.status, "failed");
  assert.equal(failed.pdf_error_code, "INVOICE_STORAGE_FAILED");

  storage.failUpload = false;
  const resumed = await service.generate(actor, BOOKING);
  assert.equal(resumed.invoice.status, "issued");
  assert.equal(resumed.invoice.invoice_number, failed.invoice_number);
  assert.equal(repo.counter, 1);
});

test("a PDF that reads back different from what was written is not issued", async () => {
  const { repo, storage, service } = setup();
  storage.corruptOnRead = true;
  await rejectsWith(service.generate(actor, BOOKING), "INVOICE_STORAGE_FAILED");
  const invoice = [...repo.invoices.values()][0];
  assert.equal(invoice.status, "failed");
  assert.equal(invoice.pdf_object_id, null);
});

test("download: returns verified bytes and refuses a stored object whose checksum differs", async () => {
  const { storage, service } = setup();
  const { invoice } = await service.generate(actor, BOOKING);
  const downloaded = await service.download(actor, invoice.id);
  assert.equal(downloaded.pdf.sha256, invoice.pdf.sha256);
  assert.equal(sha256Hex(downloaded.pdf.bytes), invoice.pdf.sha256);

  storage.corruptOnRead = true;
  await rejectsWith(
    service.download(actor, invoice.id),
    "INVOICE_CHECKSUM_MISMATCH",
    500,
  );
  storage.corruptOnRead = false;
  storage.files.clear();
  await rejectsWith(
    service.download(actor, invoice.id),
    "INVOICE_PDF_UNAVAILABLE",
    503,
  );
});

test("download is refused while the PDF is not issued", async () => {
  const { repo, storage, service } = setup();
  storage.failUpload = true;
  await rejectsWith(service.generate(actor, BOOKING), "INVOICE_STORAGE_FAILED");
  const [invoice] = [...repo.invoices.values()];
  await rejectsWith(
    service.download(actor, invoice.id),
    "INVOICE_NOT_READY",
    409,
  );
});

test("email request: invalid recipients are refused before anything is recorded", async () => {
  const { repo, service } = setup();
  const { invoice } = await service.generate(actor, BOOKING);
  const idempotency = new FakeIdempotency();
  for (const bad of [
    "",
    "not-an-email",
    "a@b",
    "two@@example.com",
    "sp ace@example.com",
    "a@example.com\r\nBcc: x@example.com",
    "<a@example.com>",
  ]) {
    await rejectsWith(
      service.requestEmail(
        actor,
        invoice.id,
        bad,
        command("bad-key-aaaaaaaaaaaa"),
        idempotency,
        "req-1",
      ),
      "EMAIL_RECIPIENT_INVALID",
      400,
    );
  }
  assert.equal(repo.deliveries.size, 0);
});

test("email request: not configured is 503 and records nothing; not issued is 409", async () => {
  const off = setup({ emailConfigured: false });
  const { invoice } = await off.service.generate(actor, BOOKING);
  await rejectsWith(
    off.service.requestEmail(
      actor,
      invoice.id,
      "person@example.com",
      command("conf-key-aaaaaaaaaaaa"),
      new FakeIdempotency(),
      "req-1",
    ),
    "EMAIL_PROVIDER_NOT_CONFIGURED",
    503,
  );
  assert.equal(off.repo.deliveries.size, 0);

  const pending = setup();
  pending.storage.failUpload = true;
  await rejectsWith(
    pending.service.generate(actor, BOOKING),
    "INVOICE_STORAGE_FAILED",
  );
  const [row] = [...pending.repo.invoices.values()];
  await rejectsWith(
    pending.service.requestEmail(
      actor,
      row.id,
      "person@example.com",
      command("ready-key-aaaaaaaaaaa"),
      new FakeIdempotency(),
      "req-1",
    ),
    "INVOICE_NOT_READY",
    409,
  );
});

test("email deduplication: the same request is one delivery, a new key is a new delivery", async () => {
  const { repo, service } = setup();
  const { invoice } = await service.generate(actor, BOOKING);
  const idempotency = new FakeIdempotency();
  const body = { recipient_email: "Person@Example.com" };
  const first = await service.requestEmail(
    actor,
    invoice.id,
    "Person@Example.com",
    command("dedup-key-aaaaaaaaaa", body),
    idempotency,
    "req-1",
  );
  const same = await service.requestEmail(
    actor,
    invoice.id,
    "Person@Example.com",
    command("dedup-key-aaaaaaaaaa", body),
    idempotency,
    "req-2",
  );
  assert.equal(same.id, first.id);
  assert.equal(repo.deliveries.size, 1);
  assert.equal(first.status, "pending");
  assert.equal(first.sequence, 1);
  assert.equal(first.recipient_email, "Person@example.com");

  // Same key with another body is a conflict.
  await rejectsWith(
    service.requestEmail(
      actor,
      invoice.id,
      "other@example.com",
      command("dedup-key-aaaaaaaaaa", { recipient_email: "other@example.com" }),
      idempotency,
      "req-3",
    ),
    "IDEMPOTENCY_CONFLICT",
    409,
  );

  // Even without the idempotency store the database dedup key returns the same row.
  const bypass = await repo.createEmailDelivery({
    invoiceId: invoice.id,
    userId: USER,
    recipient: "person@example.com",
    idempotencyKey: "dedup-key-aaaaaaaaaa",
    correlationId: "req-4",
  });
  assert.equal(bypass.created, false);
  assert.equal(bypass.delivery.id, first.id);

  // A resend uses a new key: a new delivery that is recorded next to the first.
  const resend = await service.requestEmail(
    actor,
    invoice.id,
    "Person@Example.com",
    command("resend-key-aaaaaaaaa", body),
    idempotency,
    "req-5",
  );
  assert.notEqual(resend.id, first.id);
  assert.equal(resend.sequence, 2);
  const listed = await service.listEmailDeliveries(actor, invoice.id);
  assert.deepEqual(
    listed.map((row) => row.sequence),
    [2, 1],
  );
});

function emailSetup({ providerFails = null, configured = true } = {}) {
  const base = setup();
  const sends = [];
  const provider = {
    name: "smtp",
    async send(email) {
      sends.push(email);
      if (providerFails) throw new EmailProviderError(providerFails, "smtp");
      return { provider: "smtp", messageId: `<fixture-${sends.length}@local>` };
    },
  };
  const dispatcher = new EmailDeliveryService({
    repo: base.repo,
    invoices: base.service,
    providerName: "smtp",
    provider: () => {
      if (!configured) {
        throw new EmailProviderError("EMAIL_PROVIDER_NOT_CONFIGURED", "none");
      }
      return provider;
    },
    from: "TravelFlow <noreply@travelflow.local>",
    logger,
  });
  return { ...base, dispatcher, sends };
}

async function pendingDelivery(setupResult, key = "send-key-aaaaaaaaaaa") {
  const { service, repo } = setupResult;
  const { invoice } = await service.generate(actor, BOOKING);
  const delivery = await service.requestEmail(
    actor,
    invoice.id,
    "person@example.com",
    command(key),
    new FakeIdempotency(),
    "req-1",
  );
  return { invoice, delivery, repo };
}

test("dispatch: sends once with the verified PDF attached and records the provider id", async () => {
  const ctx = emailSetup();
  const { invoice, delivery } = await pendingDelivery(ctx);
  const result = await ctx.dispatcher.dispatch(delivery.id, actor);
  assert.equal(result.outcome, "sent");
  assert.equal(result.delivery.status, "sent");
  assert.equal(result.delivery.provider, "smtp");
  assert.equal(result.delivery.provider_message_id, "<fixture-1@local>");
  assert.equal(result.delivery.attachment_sha256, invoice.pdf.sha256);
  assert.equal(ctx.sends.length, 1);
  const [sent] = ctx.sends;
  assert.equal(sent.to, "person@example.com");
  assert.equal(sent.attachments.length, 1);
  assert.equal(sent.attachments[0].filename, "invoice-INV-2026-000001.pdf");
  assert.equal(sha256Hex(sent.attachments[0].content), invoice.pdf.sha256);
  assert.equal(sent.idempotencyKey, `invoice-email-${delivery.id}`);
  assert.ok(sent.subject.includes("TF-ABCDEF1234"));
});

test("duplicate jobs never send a second email", async () => {
  const ctx = emailSetup();
  const { delivery } = await pendingDelivery(ctx);
  const [a, b] = await Promise.all([
    ctx.dispatcher.dispatch(delivery.id, actor),
    ctx.dispatcher.dispatch(delivery.id, actor),
  ]);
  assert.equal(ctx.sends.length, 1, "two concurrent jobs, one message");
  assert.deepEqual([a.outcome, b.outcome].sort(), ["not_pending", "sent"]);
  const later = await ctx.dispatcher.dispatch(delivery.id, actor);
  assert.equal(later.outcome, "already_sent");
  assert.equal(ctx.sends.length, 1);
});

test("provider failure: the delivery fails with a safe code and booking and payment are untouched", async () => {
  const ctx = emailSetup({ providerFails: "EMAIL_PROVIDER_UNREACHABLE" });
  const { delivery, repo } = await pendingDelivery(ctx);
  const bookingBefore = JSON.stringify(repo.booking);
  const paymentBefore = JSON.stringify(repo.payment);
  const result = await ctx.dispatcher.dispatch(delivery.id, actor);
  assert.equal(result.outcome, "failed");
  assert.equal(result.delivery.status, "failed");
  assert.equal(result.delivery.error_code, "EMAIL_PROVIDER_UNREACHABLE");
  assert.equal(result.delivery.provider_message_id, null);
  assert.ok(!result.delivery.error_message.includes("127.0.0.1"));
  assert.equal(JSON.stringify(repo.booking), bookingBefore);
  assert.equal(JSON.stringify(repo.payment), paymentBefore);
  assert.equal(repo.booking.status, "confirmed");
  assert.equal(repo.payment.status, "succeeded");
  // The invoice is still issued and a failed delivery is never sent again by a repeat.
  assert.equal([...repo.invoices.values()][0].status, "issued");
  const again = await ctx.dispatcher.dispatch(delivery.id, actor);
  assert.equal(again.outcome, "not_pending");
  assert.equal(ctx.sends.length, 1, "no automatic retry");
});

test("a missing provider configuration fails the delivery without a send", async () => {
  const ctx = emailSetup({ configured: false });
  const { delivery } = await pendingDelivery(ctx);
  const result = await ctx.dispatcher.dispatch(delivery.id, actor);
  assert.equal(result.outcome, "failed");
  assert.equal(result.delivery.error_code, "EMAIL_PROVIDER_NOT_CONFIGURED");
  assert.equal(ctx.sends.length, 0);
});

test("no email is sent when the stored PDF fails its check", async () => {
  const ctx = emailSetup();
  const { delivery } = await pendingDelivery(ctx);
  ctx.storage.corruptOnRead = true;
  const result = await ctx.dispatcher.dispatch(delivery.id, actor);
  assert.equal(result.outcome, "failed");
  assert.equal(result.delivery.error_code, "EMAIL_ATTACHMENT_INVALID");
  assert.equal(ctx.sends.length, 0);
});

test("dispatch refuses a delivery of another user or trip", async () => {
  const ctx = emailSetup();
  const { delivery } = await pendingDelivery(ctx);
  await rejectsWith(
    ctx.dispatcher.dispatch(delivery.id, { tripId: TRIP, userId: OTHER }),
    "RESOURCE_NOT_FOUND",
    404,
  );
  assert.equal(ctx.sends.length, 0);
});

test("generate waits while another request is storing the same PDF", async () => {
  const { repo, storage, service } = setup();
  await repo.prepareInvoice(BOOKING, USER); // a pending invoice owned by another request
  repo.busy = 2;
  const result = await service.generate(actor, BOOKING);
  assert.equal(result.invoice.status, "issued");
  assert.equal(result.invoice.invoice_number, "INV-2026-000001");
  assert.equal(repo.counter, 1);
  assert.equal(storage.uploads, 1);
});

test("generate gives up with 409 when the other request does not finish in time", async () => {
  const { repo, storage, service } = setup({ generationWaitMs: 300 });
  await repo.prepareInvoice(BOOKING, USER);
  repo.busy = 10_000;
  await rejectsWith(
    service.generate(actor, BOOKING),
    "INVOICE_GENERATION_IN_PROGRESS",
    409,
  );
  assert.equal(
    storage.uploads,
    0,
    "it did not write while the other request held the invoice",
  );
});
