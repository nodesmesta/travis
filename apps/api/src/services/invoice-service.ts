import { createHash } from "node:crypto";
import {
  buildInvoicePdf,
  evaluateInvoiceEligibility,
  inspectPdf,
  parseEmailAddress,
  type CommandContext,
} from "@travelflow/domain";
import { AppError } from "../errors.js";
import type { Logger } from "../logger.js";
import type {
  PreparedInvoice,
  SupabaseInvoiceRepository,
  SupabaseInvoiceStorage,
} from "../repositories/invoice-repository.js";
import type { SupabaseIdempotencyStore } from "../repositories/domain-persistence.js";
import type { Booking, Payment } from "../supabase/database.types.js";
import type { InvoiceRow } from "../supabase/tables/invoice.types.js";
import {
  serializeDelivery,
  serializeInvoice,
  type EmailDeliveryView,
  type InvoiceView,
} from "./invoice-serializers.js";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function invoiceObjectPath(tripId: string, invoiceId: string): string {
  return `${tripId}/${invoiceId}.pdf`;
}

export interface InvoiceServiceDeps {
  /** Reads. A user-scoped client in the API (row level security applies), the admin client in the worker. */
  reads: SupabaseInvoiceRepository;
  /** Writes and private storage. Always the admin client. */
  writes: SupabaseInvoiceRepository;
  storage: SupabaseInvoiceStorage;
  logger: Logger;
  /** True when the selected email provider has everything it needs. */
  emailConfigured: () => boolean;
  /** How long a generate request waits for another request that is storing the same PDF. */
  generationWaitMs: number;
}

export interface Actor {
  tripId: string;
  userId: string;
}

export interface VerifiedPdf {
  bytes: Uint8Array;
  sha256: string;
  objectPath: string;
}

export interface BookingInvoiceState {
  booking_id: string;
  eligible: boolean;
  ineligible_reason: string | null;
  payment: {
    id: string;
    payment_reference: string;
    status: Payment["status"];
    amount: number;
    currency: string;
    paid_at: string | null;
  } | null;
  invoice: InvoiceView | null;
}

function notFound(label: string): AppError {
  return new AppError(
    "RESOURCE_NOT_FOUND",
    "not_found",
    404,
    `${label} was not found.`,
  );
}

/**
 * Issues invoices and serves their PDFs. The API and the worker use this same class,
 * so a generate request and a `generate_invoice` job behave identically.
 */
export class InvoiceService {
  public constructor(private readonly deps: InvoiceServiceDeps) {}

  private async requireBooking(
    actor: Actor,
    bookingId: string,
  ): Promise<Booking> {
    const booking = await this.deps.reads.getBooking(bookingId, actor.tripId);
    if (!booking || booking.user_id !== actor.userId) {
      throw notFound("Booking");
    }
    return booking;
  }

  private async requireInvoice(
    actor: Actor,
    invoiceId: string,
  ): Promise<InvoiceRow> {
    const invoice = await this.deps.reads.getInvoice(invoiceId, actor.tripId);
    if (!invoice || invoice.user_id !== actor.userId) {
      throw notFound("Invoice");
    }
    return invoice;
  }

  private async view(invoice: InvoiceRow): Promise<InvoiceView> {
    const { reads } = this.deps;
    const booking = await reads.getBooking(invoice.booking_id, invoice.trip_id);
    const payment = await reads.getPayment(invoice.payment_id);
    if (!booking || !payment) throw notFound("Booking");
    return serializeInvoice(
      invoice,
      booking,
      payment,
      await reads.getItemTitle(booking),
    );
  }

  /** Eligibility, latest payment, and the invoice of a booking. */
  public async getBookingInvoice(
    actor: Actor,
    bookingId: string,
  ): Promise<BookingInvoiceState> {
    const { reads } = this.deps;
    const booking = await this.requireBooking(actor, bookingId);
    const payments = await reads.listPayments(booking.id);
    const eligibility = evaluateInvoiceEligibility(booking, payments);
    const shown = eligibility.eligible ? eligibility.payment : payments[0];
    const existing = await reads.getInvoiceByBooking(booking.id, actor.tripId);
    return {
      booking_id: booking.id,
      // A booking that already has an invoice stays invoiced even after a refund.
      eligible: eligibility.eligible,
      ineligible_reason: eligibility.eligible ? null : eligibility.message,
      payment: shown
        ? {
            id: shown.id,
            payment_reference: shown.payment_reference,
            status: shown.status,
            amount: shown.amount,
            currency: shown.currency,
            paid_at: shown.paid_at,
          }
        : null,
      invoice: existing ? await this.view(existing) : null,
    };
  }

  /**
   * Numbers the invoice or finds it. While another request is storing the PDF of the
   * same invoice, this waits for it (up to the wait limit) instead of writing a second time.
   */
  private async prepare(
    bookingId: string,
    userId: string,
  ): Promise<PreparedInvoice> {
    const deadline = Date.now() + this.deps.generationWaitMs;
    for (;;) {
      const prepared = await this.deps.writes.prepareInvoice(bookingId, userId);
      if (!prepared.in_progress) return prepared;
      if (Date.now() >= deadline) {
        throw new AppError(
          "INVOICE_GENERATION_IN_PROGRESS",
          "conflict",
          409,
          "The invoice is still being created by another request. Try again in a moment.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  /**
   * Issues the invoice of a booking, once. A second call returns the same invoice. The
   * order is: check the payment, number the invoice in the database, build and check
   * the PDF, store it, read it back and compare the checksum, then mark it issued.
   */
  public async generate(
    actor: Actor,
    bookingId: string,
  ): Promise<{ created: boolean; invoice: InvoiceView }> {
    const { reads, writes, storage, logger } = this.deps;
    const booking = await this.requireBooking(actor, bookingId);
    const payments = await reads.listPayments(booking.id);
    const eligibility = evaluateInvoiceEligibility(booking, payments);
    if (!eligibility.eligible) {
      throw new AppError(
        "INVOICE_NOT_ELIGIBLE",
        "conflict",
        409,
        eligibility.message,
        { reason: eligibility.reason },
      );
    }
    const payment = eligibility.payment;

    const prepared = await this.prepare(booking.id, actor.userId);
    let invoice = prepared.invoice;
    if (invoice.status === "issued") {
      return { created: prepared.created, invoice: await this.view(invoice) };
    }

    const itemTitle = await reads.getItemTitle(booking);
    const bytes = buildInvoicePdf({
      invoiceNumber: invoice.invoice_number,
      issuedAt: invoice.issued_at,
      bookingReference: booking.confirmation_code ?? "",
      bookingType: booking.booking_type,
      itemTitle,
      currency: invoice.currency,
      subtotal: invoice.subtotal,
      tax: invoice.tax,
      total: invoice.total,
      paymentReference: payment.payment_reference,
      paymentStatus: payment.status,
      paidAt: payment.paid_at,
      pricingPolicy: invoice.pricing_policy,
    });
    const inspection = inspectPdf(bytes);
    if (!inspection.valid) {
      await writes.failInvoice(invoice.id, "INVOICE_PDF_INVALID");
      logger.error("invoice.pdf_invalid", {
        invoice_id: invoice.id,
        reason: inspection.reason,
      });
      throw new AppError(
        "INVOICE_PDF_INVALID",
        "internal",
        500,
        "The invoice PDF could not be built.",
      );
    }
    const checksum = sha256Hex(bytes);
    const objectPath = invoiceObjectPath(invoice.trip_id, invoice.id);

    try {
      await storage.upload(objectPath, bytes);
    } catch (error) {
      await writes.failInvoice(invoice.id, "INVOICE_STORAGE_FAILED");
      throw error;
    }
    const stored = await storage.download(objectPath);
    if (!stored || sha256Hex(stored) !== checksum) {
      await writes.failInvoice(invoice.id, "INVOICE_STORAGE_VERIFY_FAILED");
      throw new AppError(
        "INVOICE_STORAGE_FAILED",
        "persistence",
        502,
        "The stored invoice PDF did not match what was written.",
      );
    }

    invoice = await writes.finalizeInvoice({
      invoiceId: invoice.id,
      objectPath,
      sizeBytes: bytes.length,
      sha256: checksum,
    });
    logger.info("invoice.issued", {
      invoice_id: invoice.id,
      trip_id: invoice.trip_id,
      booking_id: invoice.booking_id,
      invoice_number: invoice.invoice_number,
      pdf_size_bytes: bytes.length,
    });
    return { created: prepared.created, invoice: await this.view(invoice) };
  }

  /**
   * Reads the stored PDF and proves it: the object exists, its SHA-256 and size equal the
   * recorded values, and the structure is a valid PDF. Nothing is returned otherwise.
   */
  public async loadVerifiedPdf(invoice: InvoiceRow): Promise<VerifiedPdf> {
    const { reads, storage, logger } = this.deps;
    if (invoice.status !== "issued" || invoice.pdf_object_id === null) {
      throw new AppError(
        "INVOICE_NOT_READY",
        "conflict",
        409,
        "The invoice PDF is not ready yet.",
      );
    }
    const object = await reads.getDocumentObject(invoice.pdf_object_id);
    if (!object) {
      throw new AppError(
        "INVOICE_PDF_UNAVAILABLE",
        "persistence",
        503,
        "The invoice PDF record is missing.",
      );
    }
    const bytes = await storage.download(object.object_path);
    if (!bytes) {
      throw new AppError(
        "INVOICE_PDF_UNAVAILABLE",
        "persistence",
        503,
        "The invoice PDF could not be read from storage.",
      );
    }
    const checksum = sha256Hex(bytes);
    if (
      checksum !== invoice.pdf_sha256 ||
      bytes.length !== invoice.pdf_size_bytes
    ) {
      logger.error("invoice.checksum_mismatch", { invoice_id: invoice.id });
      throw new AppError(
        "INVOICE_CHECKSUM_MISMATCH",
        "internal",
        500,
        "The stored invoice PDF does not match its checksum, so it was not sent.",
      );
    }
    const inspection = inspectPdf(bytes);
    if (!inspection.valid) {
      throw new AppError(
        "INVOICE_PDF_INVALID",
        "internal",
        500,
        "The stored invoice PDF is not a valid PDF.",
      );
    }
    return { bytes, sha256: checksum, objectPath: object.object_path };
  }

  public async download(
    actor: Actor,
    invoiceId: string,
  ): Promise<{ invoice: InvoiceRow; pdf: VerifiedPdf }> {
    const invoice = await this.requireInvoice(actor, invoiceId);
    return { invoice, pdf: await this.loadVerifiedPdf(invoice) };
  }

  /**
   * Records an email request and queues the job that sends it. The recipient is the
   * address the user typed. Nothing is sent here.
   */
  public async requestEmail(
    actor: Actor,
    invoiceId: string,
    recipient: string,
    context: CommandContext,
    idempotency: SupabaseIdempotencyStore,
    correlationId: string,
  ): Promise<EmailDeliveryView> {
    const parsed = parseEmailAddress(recipient);
    if (!parsed.ok) {
      throw new AppError(
        "EMAIL_RECIPIENT_INVALID",
        "validation",
        400,
        parsed.message,
        { problem: parsed.problem },
      );
    }
    const invoice = await this.requireInvoice(actor, invoiceId);
    if (invoice.status !== "issued") {
      throw new AppError(
        "INVOICE_NOT_READY",
        "conflict",
        409,
        "The invoice PDF is not ready yet, so it cannot be emailed.",
      );
    }
    if (!this.deps.emailConfigured()) {
      throw new AppError(
        "EMAIL_PROVIDER_NOT_CONFIGURED",
        "internal",
        503,
        "Email delivery is not configured on this server.",
      );
    }
    return idempotency.execute(
      `invoice.email:${invoice.id}`,
      context,
      async () => {
        const request = await this.deps.writes.createEmailDelivery({
          invoiceId: invoice.id,
          userId: actor.userId,
          recipient: parsed.address,
          idempotencyKey: context.idempotencyKey,
          correlationId,
        });
        return serializeDelivery(request.delivery);
      },
    );
  }

  public async listEmailDeliveries(
    actor: Actor,
    invoiceId: string,
  ): Promise<EmailDeliveryView[]> {
    const invoice = await this.requireInvoice(actor, invoiceId);
    const rows = await this.deps.reads.listEmailDeliveries(
      invoice.id,
      actor.tripId,
    );
    return rows.map(serializeDelivery);
  }
}
