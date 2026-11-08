"use client";

import { useCallback, useEffect, useState } from "react";
import { listTripBookings } from "../../lib/api-invoices";
import type { Booking, ProviderBookingSummary } from "../../lib/types";
import {
  ProviderBookingActions,
  ProviderBookingStatus,
  cancellableState,
  isoTime,
  providerStateLabel,
  providerStateTone,
} from "./provider-booking-parts";
import type { ViewProps } from "./types";

const LABELS: Record<Booking["booking_type"], string> = {
  event: "Event",
  activity: "Activity",
  itinerary_item: "Itinerary",
  hotel: "Hotel",
  flight: "Flight",
};

function money(booking: Booking): string {
  return `${booking.currency} ${new Intl.NumberFormat("en-US").format(booking.total)}`;
}

function statusClass(status: string): string {
  if (status === "confirmed") return "booking-status confirmed";
  if (status === "failed" || status === "cancelled")
    return "booking-status failed";
  return "booking-status pending";
}

export default function BookingsView({ trip, onOpenInvoices }: ViewProps) {
  const [items, setItems] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems((await listTripBookings(trip.id)).items);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Bookings could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }, [trip.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function applyProviderUpdate(
    bookingId: string,
    booking: Booking,
    providerBooking: ProviderBookingSummary,
  ) {
    setItems((current) =>
      current.map((item) =>
        item.id === bookingId
          ? { ...booking, provider_booking: providerBooking }
          : item,
      ),
    );
  }

  return (
    <div className="view-stack bookings-view">
      <div className="welcome-row">
        <div>
          <p className="eyebrow">TRIP RESERVATIONS</p>
          <h1>Everything booked for this trip.</h1>
          <p className="lede">
            Events, activities, hotels, and flights stay together here. Provider
            status, cancellation, and invoice actions remain attached to each
            reservation.
          </p>
        </div>
        <span className="sun-badge">▣</span>
      </div>
      {error ? <div className="status-banner error">{error}</div> : null}
      {loading ? (
        <p className="helper-text" role="status">
          Loading reservations…
        </p>
      ) : null}
      {!loading && items.length === 0 ? (
        <div className="empty-state">
          <span className="panel-icon">▣</span>
          <h3>No reservations yet</h3>
          <p>
            Explore nearby events, search a stay, or compare flights to add the
            first reservation.
          </p>
        </div>
      ) : null}
      <div className="booking-list" aria-live="polite">
        {items.map((booking) => {
          const provider = booking.provider_booking ?? null;
          const isProviderBooking =
            provider !== null &&
            (booking.booking_type === "hotel" ||
              booking.booking_type === "flight");
          return (
            <article className="booking-record" key={booking.id}>
              <div className="booking-record-main">
                <div className="booking-record-kicker">
                  <span className="tag sage">
                    {LABELS[booking.booking_type]}
                  </span>
                  {provider ? (
                    <span
                      className={`booking-status ${providerStateTone(provider.state)}`}
                    >
                      {providerStateLabel(provider.state)}
                    </span>
                  ) : (
                    <span className={statusClass(booking.status)}>
                      {booking.status.replaceAll("_", " ")}
                    </span>
                  )}
                </div>
                <h2>
                  {booking.confirmation_code ??
                    provider?.confirmation_code ??
                    `${LABELS[booking.booking_type]} reservation`}
                </h2>
                <p>
                  {booking.provider_name === "liteapi"
                    ? "LiteAPI sandbox provider"
                    : "TravelFlow internal reservation"}
                  {booking.starts_at
                    ? ` · starts ${isoTime(booking.starts_at)}`
                    : ""}
                </p>
                {provider && provider.state !== booking.status ? (
                  <p className="provider-note">
                    Local booking status: {booking.status.replaceAll("_", " ")}
                  </p>
                ) : null}
                {isProviderBooking && provider ? (
                  <ProviderBookingStatus
                    provider={provider}
                    bookingType={provider.booking_type}
                  />
                ) : null}
              </div>
              <div className="booking-record-side">
                <strong>{money(booking)}</strong>
                <small>{booking.pricing_policy}</small>
                {booking.status === "confirmed" ||
                booking.status === "refunded" ? (
                  <button
                    className="button secondary"
                    onClick={onOpenInvoices}
                    type="button"
                  >
                    Open invoice
                  </button>
                ) : null}
                {isProviderBooking && provider ? (
                  <ProviderBookingActions
                    tripId={trip.id}
                    bookingType={provider.booking_type}
                    providerBookingId={provider.id}
                    canCancel={cancellableState(provider.state)}
                    onUpdated={(response) => {
                      applyProviderUpdate(
                        booking.id,
                        response.booking,
                        response.provider_booking,
                      );
                    }}
                  />
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
