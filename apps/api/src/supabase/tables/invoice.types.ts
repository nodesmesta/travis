import type { Json, TableDefinition } from "../database.types.js";

/** Table and function types for Task 11 (migration 0010). */

export type InvoiceStatus = "pending" | "issued" | "failed";

export type InvoiceRow = {
  id: string;
  trip_id: string;
  user_id: string;
  booking_id: string;
  payment_id: string;
  invoice_year: number;
  sequence_number: number;
  invoice_number: string;
  status: InvoiceStatus;
  currency: string;
  subtotal: number;
  tax: number;
  total: number;
  pricing_policy: string;
  pdf_object_id: string | null;
  pdf_sha256: string | null;
  pdf_size_bytes: number | null;
  pdf_error_code: string | null;
  issued_at: string;
  created_at: string;
  updated_at: string;
};

export type DocumentStorageObjectRow = {
  id: string;
  trip_id: string;
  user_id: string;
  document_type: "invoice_pdf";
  bucket: string;
  object_path: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
};

export type EmailDeliveryStatus = "pending" | "sent" | "failed";
export type EmailProviderName = "smtp" | "resend";

export type EmailDeliveryRow = {
  id: string;
  trip_id: string;
  user_id: string;
  invoice_id: string;
  sequence: number;
  recipient_email: string;
  status: EmailDeliveryStatus;
  provider: EmailProviderName | null;
  provider_message_id: string | null;
  error_code: string | null;
  error_message: string | null;
  attachment_sha256: string | null;
  attachment_size_bytes: number | null;
  dedup_key: string;
  requested_at: string;
  attempted_at: string | null;
  sent_at: string | null;
  failed_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Users and the service role only read these tables. Every write goes through the
 * SQL functions in `InvoiceFunctions`, so the Insert and Update shapes are `never`.
 */
export type InvoiceTables = {
  invoices: TableDefinition<InvoiceRow, never, never>;
  document_storage_objects: TableDefinition<
    DocumentStorageObjectRow,
    never,
    never
  >;
  email_deliveries: TableDefinition<EmailDeliveryRow, never, never>;
};

export type InvoiceFunctions = {
  prepare_invoice: {
    Args: { p_booking_id: string; p_user_id: string };
    Returns: Json;
  };
  finalize_invoice_pdf: {
    Args: {
      p_invoice_id: string;
      p_object_path: string;
      p_size_bytes: number;
      p_sha256: string;
    };
    Returns: Json;
  };
  fail_invoice_pdf: {
    Args: { p_invoice_id: string; p_error_code: string };
    Returns: Json;
  };
  create_email_delivery: {
    Args: {
      p_invoice_id: string;
      p_user_id: string;
      p_recipient: string;
      p_idempotency_key: string;
      p_correlation_id: string;
    };
    Returns: Json;
  };
  claim_email_delivery: {
    Args: { p_delivery_id: string; p_provider: string | null };
    Returns: Json;
  };
  complete_email_delivery: {
    Args: {
      p_delivery_id: string;
      p_status: "sent" | "failed";
      p_provider_message_id: string | null;
      p_error_code: string | null;
      p_error_message: string | null;
      p_attachment_sha256: string | null;
      p_attachment_size_bytes: number | null;
    };
    Returns: Json;
  };
  enqueue_invoice_generation: {
    Args: { p_booking_id: string; p_correlation_id: string };
    Returns: boolean;
  };
};

export type { Json, TableDefinition };
