"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getBookingInvoice, listTripBookings } from "../../lib/api-invoices";
import type { Booking } from "../../lib/types";
import type { BookingInvoiceState } from "../../lib/types-invoices";
import { InvoiceCard, invoiceError } from "./invoices-parts";
import type { ViewProps } from "./types";

/** Bookings that can have a succeeded payment. A refunded booking keeps the invoice it already has. */
const INVOICE_BOOKING_STATUSES = ["confirmed", "refunded"];

interface Row {
  booking: Booking;
  state: BookingInvoiceState | null;
  error: string | null;
}

type Load =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; rows: Row[] };

/**
 * Invoices and email (Segment 01, 6.11). Lists the bookings of the trip that were paid,
 * with the invoice, the PDF, and the email deliveries of each. A booking whose invoice
 * information cannot be read is shown as unavailable, never as "no invoice".
 */
export default function InvoicesView({ trip }: ViewProps) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const token = useRef(0);

  const refresh = useCallback(async () => {
    const mine = (token.current += 1);
    try {
      const list = await listTripBookings(trip.id);
      const paid = list.items.filter((booking) =>
        INVOICE_BOOKING_STATUSES.includes(booking.status),
      );
      const rows = await Promise.all(
        paid.map(async (booking): Promise<Row> => {
          try {
            return {
              booking,
              state: await getBookingInvoice(trip.id, booking.id),
              error: null,
            };
          } catch (caught) {
            return { booking, state: null, error: invoiceError(caught) };
          }
        }),
      );
      if (mine === token.current) setLoad({ state: "ready", rows });
    } catch (caught) {
      if (mine === token.current) {
        setLoad({ state: "error", message: invoiceError(caught) });
      }
    }
  }, [trip.id]);

  useEffect(() => {
    setLoad({ state: "loading" });
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  return (
    <section className="panel inv-view" aria-labelledby="invoices-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">RECEIPTS AND EMAIL</p>
          <h2 id="invoices-title">Invoices</h2>
          <p className="helper-text">
            An invoice is issued only for a booking whose payment succeeded.
            Download the PDF here or have it emailed to an address you confirm.
            An email problem never changes your booking or payment.
          </p>
        </div>
      </div>

      {load.state === "loading" ? (
        <p className="helper-text" role="status">
          Loading your bookings…
        </p>
      ) : null}

      {load.state === "error" ? (
        <div className="status-banner error" role="alert">
          <strong>Invoices are unavailable</strong>
          <span>{load.message}</span>
          <button
            className="button secondary"
            onClick={() => void refresh()}
            type="button"
          >
            Try again
          </button>
        </div>
      ) : null}

      {load.state === "ready" && load.rows.length === 0 ? (
        <div className="empty-state">
          <h3>No paid bookings yet</h3>
          <p>
            Book an event or an activity and pay with the dummy payment. The
            invoice appears here once the payment succeeds.
          </p>
        </div>
      ) : null}

      {load.state === "ready"
        ? load.rows.map((row) =>
            row.state ? (
              <InvoiceCard
                key={row.booking.id}
                tripId={trip.id}
                timezone={trip.timezone}
                booking={row.booking}
                state={row.state}
                onChanged={refresh}
              />
            ) : (
              <article key={row.booking.id} className="inv-card">
                <h3>
                  Booking {row.booking.confirmation_code ?? row.booking.id}
                </h3>
                <div className="status-banner error" role="alert">
                  <strong>Invoice information is unavailable</strong>
                  <span>{row.error}</span>
                  <button
                    className="button secondary"
                    onClick={() => void refresh()}
                    type="button"
                  >
                    Try again
                  </button>
                </div>
              </article>
            ),
          )
        : null}
    </section>
  );
}
