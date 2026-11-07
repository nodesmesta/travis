/**
 * Payment state guard. An invoice may be issued only for a booking that is
 * `confirmed` and has a payment with status `succeeded` whose amount and currency
 * equal the booking total. The database enforces the same rule with a trigger
 * (migration 0010); this function gives the reason in words before a write is tried.
 */

export interface EligibilityBooking {
  id: string;
  status: string;
  currency: string;
  subtotal: number;
  tax: number;
  total: number;
}

export interface EligibilityPayment {
  id: string;
  booking_id: string;
  status: string;
  amount: number;
  currency: string;
  created_at: string;
}

export type IneligibleReason =
  | "NO_PAYMENT"
  | "PAYMENT_PENDING"
  | "PAYMENT_FAILED"
  | "PAYMENT_CANCELLED"
  | "PAYMENT_REFUNDED"
  | "BOOKING_NOT_CONFIRMED"
  | "AMOUNT_MISMATCH";

export type InvoiceEligibility<P extends EligibilityPayment> =
  | { eligible: true; payment: P }
  | { eligible: false; reason: IneligibleReason; message: string };

const MESSAGES: Record<IneligibleReason, string> = {
  NO_PAYMENT: "The booking has no payment yet.",
  PAYMENT_PENDING: "The payment is still pending.",
  PAYMENT_FAILED: "The payment failed, so no invoice is issued.",
  PAYMENT_CANCELLED: "The payment was cancelled, so no invoice is issued.",
  PAYMENT_REFUNDED: "The payment was refunded, so no new invoice is issued.",
  BOOKING_NOT_CONFIRMED: "The booking is not confirmed.",
  AMOUNT_MISMATCH:
    "The payment amount does not equal the booking total, so no invoice is issued.",
};

function cents(value: number): number {
  return Math.round(value * 100);
}

function no<P extends EligibilityPayment>(
  reason: IneligibleReason,
): InvoiceEligibility<P> {
  return { eligible: false, reason, message: MESSAGES[reason] };
}

export function evaluateInvoiceEligibility<P extends EligibilityPayment>(
  booking: EligibilityBooking,
  payments: readonly P[],
): InvoiceEligibility<P> {
  const succeeded = payments.find(
    (payment) =>
      payment.status === "succeeded" && payment.booking_id === booking.id,
  );
  if (!succeeded) {
    const latest = [...payments]
      .filter((payment) => payment.booking_id === booking.id)
      .sort((left, right) =>
        right.created_at.localeCompare(left.created_at),
      )[0];
    if (!latest) return no("NO_PAYMENT");
    switch (latest.status) {
      case "failed":
        return no("PAYMENT_FAILED");
      case "cancelled":
        return no("PAYMENT_CANCELLED");
      case "refunded":
        return no("PAYMENT_REFUNDED");
      default:
        return no("PAYMENT_PENDING");
    }
  }
  if (booking.status !== "confirmed") return no("BOOKING_NOT_CONFIRMED");
  if (
    cents(booking.subtotal) + cents(booking.tax) !== cents(booking.total) ||
    cents(succeeded.amount) !== cents(booking.total) ||
    succeeded.currency !== booking.currency
  ) {
    return no("AMOUNT_MISMATCH");
  }
  return { eligible: true, payment: succeeded };
}
