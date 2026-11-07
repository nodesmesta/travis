import type { Booking, Payment } from "../supabase/database.types.js";
import type {
  EmailDeliveryRow,
  InvoiceRow,
} from "../supabase/tables/invoice.types.js";

/** Response shapes of `contracts/schemas/invoice.schema.json` and `email-delivery.schema.json`. */

export interface InvoiceView {
  id: string;
  trip_id: string;
  booking_id: string;
  payment_id: string;
  invoice_number: string;
  status: InvoiceRow["status"];
  currency: string;
  subtotal: number;
  tax: number;
  total: number;
  pricing_policy: string;
  booking_type: Booking["booking_type"];
  item_title: string | null;
  booking_reference: string;
  payment_reference: string;
  payment_status: Payment["status"];
  issued_at: string;
  pdf: {
    sha256: string;
    size_bytes: number;
    content_type: "application/pdf";
    download_path: string;
  } | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmailDeliveryView {
  id: string;
  trip_id: string;
  invoice_id: string;
  sequence: number;
  recipient_email: string;
  status: EmailDeliveryRow["status"];
  provider: EmailDeliveryRow["provider"];
  provider_message_id: string | null;
  error_code: string | null;
  error_message: string | null;
  attachment_sha256: string | null;
  attachment_size_bytes: number | null;
  requested_at: string;
  attempted_at: string | null;
  sent_at: string | null;
  failed_at: string | null;
}

export function downloadPath(tripId: string, invoiceId: string): string {
  return `/api/v1/trips/${tripId}/invoices/${invoiceId}/download`;
}

export function serializeInvoice(
  invoice: InvoiceRow,
  booking: Booking,
  payment: Payment,
  itemTitle: string | null,
): InvoiceView {
  const pdf =
    invoice.status === "issued" &&
    invoice.pdf_sha256 !== null &&
    invoice.pdf_size_bytes !== null
      ? {
          sha256: invoice.pdf_sha256,
          size_bytes: invoice.pdf_size_bytes,
          content_type: "application/pdf" as const,
          download_path: downloadPath(invoice.trip_id, invoice.id),
        }
      : null;
  return {
    id: invoice.id,
    trip_id: invoice.trip_id,
    booking_id: invoice.booking_id,
    payment_id: invoice.payment_id,
    invoice_number: invoice.invoice_number,
    status: invoice.status,
    currency: invoice.currency,
    subtotal: invoice.subtotal,
    tax: invoice.tax,
    total: invoice.total,
    pricing_policy: invoice.pricing_policy,
    booking_type: booking.booking_type,
    item_title: itemTitle,
    booking_reference: booking.confirmation_code ?? "",
    payment_reference: payment.payment_reference,
    payment_status: payment.status,
    issued_at: invoice.issued_at,
    pdf,
    error_code: invoice.pdf_error_code,
    created_at: invoice.created_at,
    updated_at: invoice.updated_at,
  };
}

export function serializeDelivery(row: EmailDeliveryRow): EmailDeliveryView {
  return {
    id: row.id,
    trip_id: row.trip_id,
    invoice_id: row.invoice_id,
    sequence: row.sequence,
    recipient_email: row.recipient_email,
    status: row.status,
    provider: row.provider,
    provider_message_id: row.provider_message_id,
    error_code: row.error_code,
    error_message: row.error_message,
    attachment_sha256: row.attachment_sha256,
    attachment_size_bytes: row.attachment_size_bytes,
    requested_at: row.requested_at,
    attempted_at: row.attempted_at,
    sent_at: row.sent_at,
    failed_at: row.failed_at,
  };
}
