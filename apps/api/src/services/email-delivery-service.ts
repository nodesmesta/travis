import {
  EmailProviderError,
  type EmailProvider,
  type EmailProviderName,
} from "@travelflow/integrations";
import { buildInvoiceEmail } from "@travelflow/domain";
import { AppError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { SupabaseInvoiceRepository } from "../repositories/invoice-repository.js";
import type { EmailDeliveryRow } from "../supabase/tables/invoice.types.js";
import type { InvoiceService } from "./invoice-service.js";

export type DispatchOutcome =
  | { outcome: "sent"; delivery: EmailDeliveryRow }
  | { outcome: "failed"; delivery: EmailDeliveryRow }
  | { outcome: "already_sent"; delivery: EmailDeliveryRow }
  | { outcome: "not_pending"; delivery: EmailDeliveryRow };

export interface EmailDeliveryServiceDeps {
  repo: SupabaseInvoiceRepository;
  invoices: InvoiceService;
  /** Name of the configured provider, or null when none is configured. */
  providerName: EmailProviderName | null;
  /** Builds the provider on first use. Throws EMAIL_PROVIDER_NOT_CONFIGURED when it is not configured. */
  provider: () => EmailProvider;
  from: string | undefined;
  logger: Logger;
}

const EMAIL_ATTACHMENT_INVALID = "EMAIL_ATTACHMENT_INVALID";
const EMAIL_INVOICE_NOT_READY = "INVOICE_NOT_READY";
const EMAIL_INTERNAL_ERROR = "EMAIL_DELIVERY_INTERNAL_ERROR";

/**
 * Sends one pending delivery. The attempt is taken atomically in the database
 * (`claim_email_delivery`), so a duplicate job or a second worker finds nothing to send.
 * The message is only handed to the provider after the stored PDF was read back and
 * proved against its checksum. A provider failure marks the delivery `failed`; the
 * booking, the payment, and the invoice are never touched. There is no retry.
 */
export class EmailDeliveryService {
  public constructor(private readonly deps: EmailDeliveryServiceDeps) {}

  public async dispatch(
    deliveryId: string,
    actor: { tripId: string; userId: string },
  ): Promise<DispatchOutcome> {
    const { repo, invoices, logger } = this.deps;
    const delivery = await repo.getEmailDelivery(deliveryId);
    if (
      !delivery ||
      delivery.trip_id !== actor.tripId ||
      delivery.user_id !== actor.userId
    ) {
      throw new AppError(
        "RESOURCE_NOT_FOUND",
        "not_found",
        404,
        "Email delivery was not found.",
      );
    }
    if (delivery.status === "sent") {
      return { outcome: "already_sent", delivery };
    }
    if (delivery.status === "failed") {
      return { outcome: "not_pending", delivery };
    }

    const claimed = await repo.claimEmailDelivery(
      delivery.id,
      this.deps.providerName,
    );
    if (!claimed) {
      const current = (await repo.getEmailDelivery(delivery.id)) ?? delivery;
      return current.status === "sent"
        ? { outcome: "already_sent", delivery: current }
        : { outcome: "not_pending", delivery: current };
    }

    const fields = {
      email_delivery_id: claimed.id,
      invoice_id: claimed.invoice_id,
      trip_id: claimed.trip_id,
      provider: this.deps.providerName,
    };

    const invoice = await repo.getInvoiceById(claimed.invoice_id);
    if (!invoice || invoice.status !== "issued") {
      return this.fail(
        claimed,
        EMAIL_INVOICE_NOT_READY,
        "The invoice PDF is not ready.",
        null,
      );
    }

    let pdf;
    try {
      pdf = await invoices.loadVerifiedPdf(invoice);
    } catch (error) {
      if (error instanceof AppError) {
        logger.error("email.attachment_invalid", {
          ...fields,
          error_code: error.code,
        });
        return this.fail(
          claimed,
          EMAIL_ATTACHMENT_INVALID,
          "The invoice PDF could not be verified, so no email was sent.",
          null,
        );
      }
      await this.fail(
        claimed,
        EMAIL_INTERNAL_ERROR,
        "The email could not be prepared.",
        null,
      );
      throw error;
    }
    const attachment = { sha256: pdf.sha256, size: pdf.bytes.length };

    const booking = await repo.getBooking(invoice.booking_id, invoice.trip_id);
    const payment = await repo.getPayment(invoice.payment_id);
    if (!booking || !payment) {
      return this.fail(
        claimed,
        EMAIL_INTERNAL_ERROR,
        "The booking could not be read.",
        attachment,
      );
    }
    const content = buildInvoiceEmail({
      bookingReference: booking.confirmation_code ?? "",
      bookingType: booking.booking_type,
      itemTitle: await repo.getItemTitle(booking),
      invoiceNumber: invoice.invoice_number,
      currency: invoice.currency,
      total: invoice.total,
      paymentReference: payment.payment_reference,
    });

    try {
      const provider = this.deps.provider();
      if (!this.deps.from) {
        throw new EmailProviderError(
          "EMAIL_PROVIDER_NOT_CONFIGURED",
          provider.name,
        );
      }
      const sent = await provider.send({
        from: this.deps.from,
        to: claimed.recipient_email,
        subject: content.subject,
        text: content.text,
        attachments: [
          {
            filename: content.attachmentFilename,
            contentType: "application/pdf",
            content: pdf.bytes,
          },
        ],
        idempotencyKey: `invoice-email-${claimed.id}`,
      });
      const done = await repo.completeEmailDelivery({
        deliveryId: claimed.id,
        status: "sent",
        providerMessageId: sent.messageId,
        errorCode: null,
        errorMessage: null,
        attachmentSha256: attachment.sha256,
        attachmentSizeBytes: attachment.size,
      });
      logger.info("email.sent", {
        ...fields,
        provider_message_id: sent.messageId,
      });
      return { outcome: "sent", delivery: done };
    } catch (error) {
      if (error instanceof EmailProviderError) {
        logger.error("email.failed", {
          ...fields,
          error_code: error.code,
          http_status: error.httpStatus ?? null,
        });
        return this.fail(claimed, error.code, error.message, attachment);
      }
      await this.fail(
        claimed,
        EMAIL_INTERNAL_ERROR,
        "The email could not be sent.",
        attachment,
      );
      throw error;
    }
  }

  private async fail(
    delivery: EmailDeliveryRow,
    code: string,
    message: string,
    attachment: { sha256: string; size: number } | null,
  ): Promise<DispatchOutcome> {
    const done = await this.deps.repo.completeEmailDelivery({
      deliveryId: delivery.id,
      status: "failed",
      providerMessageId: null,
      errorCode: code,
      errorMessage: message,
      attachmentSha256: attachment?.sha256 ?? null,
      attachmentSizeBytes: attachment?.size ?? null,
    });
    return { outcome: "failed", delivery: done };
  }
}
