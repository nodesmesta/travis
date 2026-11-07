/**
 * Booking price policy.
 *
 * Prices are decided by the server, never by the client, because invoices are
 * issued from these amounts. The catalog is a demo catalog: the provider results
 * (events, activities) carry no price, so every booking type has one fixed
 * price and the dummy payment never moves real money.
 *
 * Amounts are whole rupiah. Tax is rounded to whole rupiah.
 */

export const PRICING_POLICY_VERSION = "demo-pricing-v1";
export const PRICING_CURRENCY = "IDR";
/** Demo tax rate, in percent. */
export const PRICING_TAX_PERCENT = 10;

export type PricedBookingType = "event" | "activity" | "itinerary_item";

const CATALOG: Record<PricedBookingType, number> = {
  event: 250_000,
  activity: 150_000,
  itinerary_item: 100_000,
};

export interface BookingQuote {
  policy_version: string;
  booking_type: PricedBookingType;
  currency: string;
  subtotal: number;
  tax: number;
  total: number;
}

export function isPricedBookingType(value: string): value is PricedBookingType {
  return value in CATALOG;
}

export function quoteBooking(bookingType: PricedBookingType): BookingQuote {
  const subtotal = CATALOG[bookingType];
  const tax = Math.round((subtotal * PRICING_TAX_PERCENT) / 100);
  return {
    policy_version: PRICING_POLICY_VERSION,
    booking_type: bookingType,
    currency: PRICING_CURRENCY,
    subtotal,
    tax,
    total: subtotal + tax,
  };
}
