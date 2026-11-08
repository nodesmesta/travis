import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../errors.js";
import type { Booking, Database, Payment } from "../supabase/database.types.js";
import type {
  DocumentStorageObjectRow,
  EmailDeliveryRow,
  InvoiceRow,
} from "../supabase/tables/invoice.types.js";

type Client = SupabaseClient<Database>;

export const INVOICE_BUCKET = "invoices";

function persistenceFailure(operation: string): AppError {
  return new AppError(
    "PERSISTENCE_ERROR",
    "persistence",
    500,
    "Invoice persistence failed.",
    { operation },
  );
}

/** Maps the codes the SQL functions raise to API errors. Anything else is a persistence failure. */
function mapRpcError(message: string, operation: string): AppError {
  if (message.includes("RESOURCE_NOT_FOUND")) {
    return new AppError(
      "RESOURCE_NOT_FOUND",
      "not_found",
      404,
      "The booking or invoice was not found.",
    );
  }
  if (
    message.includes("INVOICE_PAYMENT_NOT_SUCCEEDED") ||
    message.includes("INVOICE_BOOKING_NOT_CONFIRMED")
  ) {
    return new AppError(
      "INVOICE_NOT_ELIGIBLE",
      "conflict",
      409,
      "An invoice needs a booking with a succeeded payment.",
    );
  }
  if (message.includes("INVOICE_NOT_READY")) {
    return new AppError(
      "INVOICE_NOT_READY",
      "conflict",
      409,
      "The invoice PDF is not ready yet.",
    );
  }
  if (message.includes("INVOICE_PDF_MISMATCH")) {
    return new AppError(
      "INVOICE_PDF_MISMATCH",
      "conflict",
      409,
      "The invoice was issued with a different PDF.",
    );
  }
  return persistenceFailure(operation);
}

export interface PreparedInvoice {
  created: boolean;
  /** True when another request is storing the PDF of this invoice right now. */
  in_progress: boolean;
  invoice: InvoiceRow;
}

export interface EmailDeliveryRequest {
  created: boolean;
  delivery: EmailDeliveryRow;
}

/**
 * Reads work with a user-scoped client (row level security applies) or the admin
 * client. Writes go through SQL functions and need the admin client.
 */
export class SupabaseInvoiceRepository {
  public constructor(private readonly client: Client) {}

  // --- reads -----------------------------------------------------------------

  public async getBooking(
    bookingId: string,
    tripId: string,
  ): Promise<Booking | null> {
    const { data, error } = await this.client
      .from("bookings")
      .select("*")
      .eq("id", bookingId)
      .eq("trip_id", tripId)
      .maybeSingle();
    if (error) throw persistenceFailure("bookings.get");
    return data;
  }

  public async listPayments(bookingId: string): Promise<Payment[]> {
    const { data, error } = await this.client
      .from("payments")
      .select("*")
      .eq("booking_id", bookingId)
      .order("created_at", { ascending: false });
    if (error) throw persistenceFailure("payments.list");
    return data ?? [];
  }

  public async getPayment(paymentId: string): Promise<Payment | null> {
    const { data, error } = await this.client
      .from("payments")
      .select("*")
      .eq("id", paymentId)
      .maybeSingle();
    if (error) throw persistenceFailure("payments.get");
    return data;
  }

  public async getInvoiceByBooking(
    bookingId: string,
    tripId: string,
  ): Promise<InvoiceRow | null> {
    const { data, error } = await this.client
      .from("invoices")
      .select("*")
      .eq("booking_id", bookingId)
      .eq("trip_id", tripId)
      .maybeSingle();
    if (error) throw persistenceFailure("invoices.get_by_booking");
    return data;
  }

  public async getInvoice(
    invoiceId: string,
    tripId: string,
  ): Promise<InvoiceRow | null> {
    const { data, error } = await this.client
      .from("invoices")
      .select("*")
      .eq("id", invoiceId)
      .eq("trip_id", tripId)
      .maybeSingle();
    if (error) throw persistenceFailure("invoices.get");
    return data;
  }

  public async getInvoiceById(invoiceId: string): Promise<InvoiceRow | null> {
    const { data, error } = await this.client
      .from("invoices")
      .select("*")
      .eq("id", invoiceId)
      .maybeSingle();
    if (error) throw persistenceFailure("invoices.get_by_id");
    return data;
  }

  public async getDocumentObject(
    objectId: string,
  ): Promise<DocumentStorageObjectRow | null> {
    const { data, error } = await this.client
      .from("document_storage_objects")
      .select("*")
      .eq("id", objectId)
      .maybeSingle();
    if (error) throw persistenceFailure("document_objects.get");
    return data;
  }

  /** Title of the booked item, or null when the source row no longer exists. */
  public async getItemTitle(booking: Booking): Promise<string | null> {
    if (booking.source_type === "event_discovery_result") {
      const { data, error } = await this.client
        .from("event_discovery_results")
        .select("title")
        .eq("id", booking.source_id)
        .eq("trip_id", booking.trip_id)
        .maybeSingle();
      if (error) throw persistenceFailure("event_results.title");
      return data?.title ?? null;
    }
    if (booking.source_type === "agenda_item") {
      const { data, error } = await this.client
        .from("agenda_items")
        .select("title")
        .eq("id", booking.source_id)
        .eq("trip_id", booking.trip_id)
        .maybeSingle();
      if (error) throw persistenceFailure("agenda_items.title");
      return data?.title ?? null;
    }
    if (booking.source_type === "liteapi_offer") return null;
    const { data, error } = await this.client
      .from("place_discovery_results")
      .select("name")
      .eq("id", booking.source_id)
      .eq("trip_id", booking.trip_id)
      .maybeSingle();
    if (error) throw persistenceFailure("place_results.title");
    return data?.name ?? null;
  }

  public async getEmailDelivery(
    deliveryId: string,
  ): Promise<EmailDeliveryRow | null> {
    const { data, error } = await this.client
      .from("email_deliveries")
      .select("*")
      .eq("id", deliveryId)
      .maybeSingle();
    if (error) throw persistenceFailure("email_deliveries.get");
    return data;
  }

  public async listEmailDeliveries(
    invoiceId: string,
    tripId: string,
  ): Promise<EmailDeliveryRow[]> {
    const { data, error } = await this.client
      .from("email_deliveries")
      .select("*")
      .eq("invoice_id", invoiceId)
      .eq("trip_id", tripId)
      .order("sequence", { ascending: false });
    if (error) throw persistenceFailure("email_deliveries.list");
    return data ?? [];
  }

  // --- writes (admin client) ---------------------------------------------------

  public async prepareInvoice(
    bookingId: string,
    userId: string,
  ): Promise<PreparedInvoice> {
    const { data, error } = await this.client.rpc("prepare_invoice", {
      p_booking_id: bookingId,
      p_user_id: userId,
    });
    if (error || !data) {
      throw mapRpcError(error?.message ?? "", "invoices.prepare");
    }
    return data as unknown as PreparedInvoice;
  }

  public async finalizeInvoice(input: {
    invoiceId: string;
    objectPath: string;
    sizeBytes: number;
    sha256: string;
  }): Promise<InvoiceRow> {
    const { data, error } = await this.client.rpc("finalize_invoice_pdf", {
      p_invoice_id: input.invoiceId,
      p_object_path: input.objectPath,
      p_size_bytes: input.sizeBytes,
      p_sha256: input.sha256,
    });
    if (error || !data) {
      throw mapRpcError(error?.message ?? "", "invoices.finalize");
    }
    return data as unknown as InvoiceRow;
  }

  public async failInvoice(
    invoiceId: string,
    errorCode: string,
  ): Promise<InvoiceRow> {
    const { data, error } = await this.client.rpc("fail_invoice_pdf", {
      p_invoice_id: invoiceId,
      p_error_code: errorCode,
    });
    if (error || !data) {
      throw mapRpcError(error?.message ?? "", "invoices.fail");
    }
    return data as unknown as InvoiceRow;
  }

  public async createEmailDelivery(input: {
    invoiceId: string;
    userId: string;
    recipient: string;
    idempotencyKey: string;
    correlationId: string;
  }): Promise<EmailDeliveryRequest> {
    const { data, error } = await this.client.rpc("create_email_delivery", {
      p_invoice_id: input.invoiceId,
      p_user_id: input.userId,
      p_recipient: input.recipient,
      p_idempotency_key: input.idempotencyKey,
      p_correlation_id: input.correlationId,
    });
    if (error || !data) {
      throw mapRpcError(error?.message ?? "", "email_deliveries.create");
    }
    return data as unknown as EmailDeliveryRequest;
  }

  /** The one attempt of a pending delivery, or null when it is not pending or was already taken. */
  public async claimEmailDelivery(
    deliveryId: string,
    provider: string | null,
  ): Promise<EmailDeliveryRow | null> {
    const { data, error } = await this.client.rpc("claim_email_delivery", {
      p_delivery_id: deliveryId,
      p_provider: provider,
    });
    if (error) throw persistenceFailure("email_deliveries.claim");
    return (data as unknown as EmailDeliveryRow | null) ?? null;
  }

  public async completeEmailDelivery(input: {
    deliveryId: string;
    status: "sent" | "failed";
    providerMessageId: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    attachmentSha256: string | null;
    attachmentSizeBytes: number | null;
  }): Promise<EmailDeliveryRow> {
    const { data, error } = await this.client.rpc("complete_email_delivery", {
      p_delivery_id: input.deliveryId,
      p_status: input.status,
      p_provider_message_id: input.providerMessageId,
      p_error_code: input.errorCode,
      p_error_message: input.errorMessage,
      p_attachment_sha256: input.attachmentSha256,
      p_attachment_size_bytes: input.attachmentSizeBytes,
    });
    if (error || !data) {
      throw mapRpcError(error?.message ?? "", "email_deliveries.complete");
    }
    return data as unknown as EmailDeliveryRow;
  }

  /** True when a job was queued, false when this payment already has one. */
  public async enqueueInvoiceGeneration(
    bookingId: string,
    correlationId: string,
  ): Promise<boolean> {
    const { data, error } = await this.client.rpc(
      "enqueue_invoice_generation",
      { p_booking_id: bookingId, p_correlation_id: correlationId },
    );
    if (error) throw mapRpcError(error.message, "invoices.enqueue");
    return data === true;
  }
}

/** Private bucket access. Needs the admin client; no user has a Storage policy. */
export class SupabaseInvoiceStorage {
  public constructor(private readonly client: Client) {}

  public async upload(path: string, bytes: Uint8Array): Promise<void> {
    const { error } = await this.client.storage
      .from(INVOICE_BUCKET)
      .upload(path, bytes, { contentType: "application/pdf", upsert: true });
    if (error) {
      throw new AppError(
        "INVOICE_STORAGE_FAILED",
        "persistence",
        502,
        "The invoice PDF could not be stored.",
      );
    }
  }

  /** Returns null when the object does not exist. */
  public async download(path: string): Promise<Uint8Array | null> {
    const { data, error } = await this.client.storage
      .from(INVOICE_BUCKET)
      .download(path);
    if (error || !data) return null;
    return new Uint8Array(await data.arrayBuffer());
  }
}
