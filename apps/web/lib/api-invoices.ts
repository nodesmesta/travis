import { request, requestBlob } from "./api";
import type { Booking } from "./types";
import type {
  BookingInvoiceState,
  EmailDeliveryView,
  InvoiceResult,
  InvoiceView,
} from "./types-invoices";

const trip = (tripId: string) => `/trips/${encodeURIComponent(tripId)}`;

export function listTripBookings(
  tripId: string,
): Promise<{ items: Booking[]; request_id: string }> {
  return request(`${trip(tripId)}/bookings`);
}

export function getBookingInvoice(
  tripId: string,
  bookingId: string,
): Promise<BookingInvoiceState> {
  return request(
    `${trip(tripId)}/bookings/${encodeURIComponent(bookingId)}/invoice`,
  );
}

export function generateInvoice(
  tripId: string,
  bookingId: string,
): Promise<InvoiceResult> {
  return request(
    `${trip(tripId)}/bookings/${encodeURIComponent(bookingId)}/invoice/generate`,
    { method: "POST", body: "{}" },
    true,
  );
}

export function listEmailDeliveries(
  tripId: string,
  invoiceId: string,
): Promise<{ request_id: string; items: EmailDeliveryView[] }> {
  return request(
    `${trip(tripId)}/invoices/${encodeURIComponent(invoiceId)}/email-deliveries`,
  );
}

/** Every call is a new request with its own Idempotency-Key, so "Send again" is a new delivery. */
export function requestInvoiceEmail(
  tripId: string,
  invoiceId: string,
  recipientEmail: string,
): Promise<{ request_id: string; delivery: EmailDeliveryView }> {
  return request(
    `${trip(tripId)}/invoices/${encodeURIComponent(invoiceId)}/email`,
    {
      method: "POST",
      body: JSON.stringify({ recipient_email: recipientEmail }),
    },
    true,
  );
}

/** Downloads the PDF through the authorized endpoint and starts a browser download. */
export async function downloadInvoicePdf(invoice: InvoiceView): Promise<void> {
  if (!invoice.pdf) throw new Error("The invoice PDF is not ready.");
  // download_path already starts with /api/v1, which the request base URL contains.
  const apiPrefix = "/api/v1";
  const path = invoice.pdf.download_path.startsWith(apiPrefix)
    ? invoice.pdf.download_path.slice(apiPrefix.length)
    : invoice.pdf.download_path;
  const blob = await requestBlob(path);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `invoice-${invoice.invoice_number}.pdf`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
