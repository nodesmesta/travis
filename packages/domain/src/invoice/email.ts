import { formatAmount, type InvoiceBookingType } from "./pdf.js";

/**
 * Text of the booking confirmation + invoice email. One message covers both: it
 * confirms the booking and carries the invoice PDF as an attachment.
 */

export interface InvoiceEmailInput {
  bookingReference: string;
  bookingType: InvoiceBookingType;
  itemTitle: string | null;
  invoiceNumber: string;
  currency: string;
  total: number;
  paymentReference: string;
}

export interface InvoiceEmailContent {
  subject: string;
  text: string;
  attachmentFilename: string;
}

const BOOKING_LABEL: Record<InvoiceBookingType, string> = {
  event: "Event booking",
  activity: "Activity booking",
  itinerary_item: "Itinerary item booking",
  hotel: "Hotel booking",
  flight: "Flight booking",
};

function oneLine(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) as number;
    out += code < 0x20 || code === 0x7f ? " " : char;
  }
  return out.trim();
}

export function buildInvoiceEmail(
  input: InvoiceEmailInput,
): InvoiceEmailContent {
  const reference = oneLine(input.bookingReference);
  const item =
    input.itemTitle === null || oneLine(input.itemTitle).length === 0
      ? BOOKING_LABEL[input.bookingType]
      : `${BOOKING_LABEL[input.bookingType]}: ${oneLine(input.itemTitle)}`;
  const attachmentFilename = `invoice-${input.invoiceNumber}.pdf`;
  const lines = [
    "Your TravelFlow booking is confirmed.",
    "",
    `Booking reference: ${reference}`,
    `Booked item: ${item}`,
    `Invoice number: ${input.invoiceNumber}`,
    `Total: ${input.currency} ${formatAmount(input.total)}`,
    `Payment reference: ${oneLine(input.paymentReference)}`,
    "",
    `The invoice is attached as ${attachmentFilename}.`,
    "This is a demo booking paid with a dummy payment. No real money moved.",
  ];
  return {
    subject: `TravelFlow booking ${reference} confirmed - invoice ${input.invoiceNumber}`,
    text: `${lines.join("\n")}\n`,
    attachmentFilename,
  };
}
