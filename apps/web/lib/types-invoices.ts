import type { Booking } from "./types";

/** Shapes of contracts/schemas/invoice.schema.json and email-delivery.schema.json. */

export type InvoiceStatus = "pending" | "issued" | "failed";

export interface InvoicePdf {
  sha256: string;
  size_bytes: number;
  content_type: "application/pdf";
  /** API path of the authorized download endpoint. */
  download_path: string;
}

export interface InvoiceView {
  id: string;
  trip_id: string;
  booking_id: string;
  payment_id: string;
  invoice_number: string;
  status: InvoiceStatus;
  currency: string;
  subtotal: number;
  tax: number;
  total: number;
  pricing_policy: string;
  booking_type: Booking["booking_type"];
  item_title: string | null;
  booking_reference: string;
  payment_reference: string;
  payment_status: "pending" | "succeeded" | "failed" | "cancelled" | "refunded";
  issued_at: string;
  pdf: InvoicePdf | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

export interface InvoicePaymentSummary {
  id: string;
  payment_reference: string;
  status: InvoiceView["payment_status"];
  amount: number;
  currency: string;
  paid_at: string | null;
}

export interface BookingInvoiceState {
  request_id: string;
  booking_id: string;
  eligible: boolean;
  ineligible_reason: string | null;
  payment: InvoicePaymentSummary | null;
  invoice: InvoiceView | null;
}

export interface InvoiceResult {
  request_id: string;
  created: boolean;
  invoice: InvoiceView;
}

export type EmailDeliveryStatus = "pending" | "sent" | "failed";

export interface EmailDeliveryView {
  id: string;
  trip_id: string;
  invoice_id: string;
  sequence: number;
  recipient_email: string;
  status: EmailDeliveryStatus;
  provider: "smtp" | "resend" | null;
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
