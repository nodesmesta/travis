"use client";

import { useEffect, useState } from "react";
import { listAgendaItems } from "../../lib/api-assistant";
import { listTripBookings } from "../../lib/api-invoices";
import { formatInZone } from "../../lib/trips-time";
import type { Booking } from "../../lib/types";
import type { AgendaItemView } from "../../lib/types-trips";
import { statusLabel } from "./trips-parts";
import type { TripsViewProps } from "./types";

/**
 * Trips are written by the tickets themselves: a paid hotel or flight booking
 * adds its agenda item to the trip it belongs to. This page only reads that, so
 * there is no form to fill in and nothing to confirm.
 */

const TYPE_LABEL: Record<string, string> = {
  hotel_check_in: "Stay",
  hotel_check_out: "Check-out",
  flight: "Flight",
  event: "Event",
  transport: "Transfer",
};

function typeIcon(type: string): string {
  if (type.startsWith("hotel")) return "🛏";
  if (type === "flight") return "✈";
  if (type === "event") return "🎟";
  return "◈";
}

function metaString(
  metadata: Record<string, unknown>,
  key: string,
): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function metaNumber(
  metadata: Record<string, unknown>,
  key: string,
): number | null {
  const value = metadata[key];
  return typeof value === "number" ? value : null;
}

function money(amount: number | null, currency: string | null): string | null {
  if (amount === null || !currency) return null;
  return `${currency} ${amount.toFixed(2)}`;
}

export default function TripsView({
  trip,
  trips: allTrips,
  onSelectTrip,
  onOpenBookings,
}: TripsViewProps) {
  const trips = allTrips ?? (trip ? [trip] : []);
  const [agenda, setAgenda] = useState<AgendaItemView[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!trip) {
      setAgenda([]);
      setBookings([]);
      setError(null);
      return;
    }
    let current = true;
    setLoading(true);
    setError(null);
    Promise.allSettled([listAgendaItems(trip.id), listTripBookings(trip.id)])
      .then(([agendaResult, bookingResult]) => {
        if (!current) return;
        if (agendaResult.status === "fulfilled") {
          setAgenda(agendaResult.value.items);
        }
        if (bookingResult.status === "fulfilled") {
          setBookings(bookingResult.value.items);
        }
        if (
          agendaResult.status === "rejected" &&
          bookingResult.status === "rejected"
        ) {
          setError("This trip could not be loaded. Refresh to try again.");
        }
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [trip]);

  const sorted = [...agenda].sort(
    (left, right) => Date.parse(left.start_at) - Date.parse(right.start_at),
  );
  const timezone = trip?.timezone ?? "UTC";
  const days =
    trip === null
      ? []
      : [...new Set(sorted.map((item) => formatInZone(item.start_at, timezone).slice(0, 10)))];

  return (
    <section className="panel trp-view" aria-labelledby="trips-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">YOUR TRIPS</p>
          <h2 id="trips-title">Trips</h2>
        </div>
        <span className="count-badge" aria-label={`${trips.length} trips`}>
          {trips.length}
        </span>
      </div>
      <p className="helper-text">
        A trip gathers the tickets you booked. Book a stay or a flight and it
        appears here on its own — nothing to confirm, nothing to fill in.
      </p>

      {trips.length === 0 ? (
        <div className="empty-state">
          <h3>No trip yet</h3>
          <p>
            Search a hotel or a flight, complete the sandbox payment, and the trip
            appears here with its first ticket.
          </p>
        </div>
      ) : (
        <div className="trip-cards">
          {trips.map((item) => {
            const active = item.id === trip?.id;
            return (
              <button
                className={`trip-card ${active ? "active" : ""}`}
                key={item.id}
                onClick={() => onSelectTrip?.(item.id)}
                type="button"
              >
                <span className="trip-card-top">
                  <strong>{item.name}</strong>
                  <span
                    className={`tag ${item.status === "active" ? "sage" : "indigo"}`}
                  >
                    {statusLabel(item.status)}
                  </span>
                </span>
                <span className="event-meta">
                  {item.destination_summary ?? "Destination not set"}
                </span>
                <span className="event-meta">
                  {item.start_at ? item.start_at.slice(0, 10) : "—"} →{" "}
                  {item.end_at ? item.end_at.slice(0, 10) : "—"} · {item.timezone}
                </span>
                <span className="trip-card-open">
                  {active ? "Open now" : "Open this trip"}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {trip ? (
        <div className="trp-detail" key={trip.id}>
          <div className="section-heading">
            <div>
              <p className="eyebrow">
                {statusLabel(trip.status).toUpperCase()} · {trip.timezone}
              </p>
              <h2>{trip.name}</h2>
              <p className="event-meta">
                {trip.destination_summary ?? "Destination not set"} ·{" "}
                {trip.start_at ? trip.start_at.slice(0, 10) : "—"} →{" "}
                {trip.end_at ? trip.end_at.slice(0, 10) : "—"}
              </p>
            </div>
            {onOpenBookings ? (
              <button
                className="button ghost"
                onClick={onOpenBookings}
                type="button"
              >
                All bookings
              </button>
            ) : null}
          </div>

          {error ? (
            <p className="field-error" role="status">
              {error}
            </p>
          ) : null}
          {loading ? (
            <p className="helper-text" role="status">
              Loading this trip…
            </p>
          ) : null}

          {!loading && sorted.length === 0 ? (
            <div className="empty-state">
              <h3>Nothing booked on this trip yet</h3>
              <p>
                Its tickets appear here as soon as a booking on this trip
                succeeds.
              </p>
            </div>
          ) : null}

          {days.map((day) => (
            <section className="plan-day" key={day}>
              <p className="eyebrow">{day}</p>
              <ol className="plan-list">
                {sorted
                  .filter(
                    (item) =>
                      formatInZone(item.start_at, timezone).slice(0, 10) === day,
                  )
                  .map((item) => {
                    const confirmation = metaString(
                      item.metadata,
                      "confirmation_code",
                    );
                    const total = metaNumber(item.metadata, "total");
                    const currency = metaString(item.metadata, "currency");
                    const provider = metaString(item.metadata, "provider");
                    const cancelled = item.status === "cancelled";
                    return (
                      <li
                        className={`plan-row ${cancelled ? "cancelled" : ""}`}
                        key={item.id}
                      >
                        <span className="plan-icon" aria-hidden="true">
                          {typeIcon(item.type)}
                        </span>
                        <div className="plan-body">
                          <div className="result-title">
                            <strong>{item.title}</strong>
                            <span className="tag indigo">
                              {TYPE_LABEL[item.type] ?? item.type}
                            </span>
                            {cancelled ? (
                              <span className="tag coral">Cancelled</span>
                            ) : null}
                          </div>
                          <span className="event-meta">
                            {formatInZone(item.start_at, timezone)} →{" "}
                            {formatInZone(item.end_at, timezone)}
                          </span>
                          <span className="event-meta">
                            {confirmation
                              ? `Confirmation ${confirmation}`
                              : "Confirmation pending"}
                            {provider ? ` · ${provider}` : ""}
                            {money(total, currency)
                              ? ` · ${money(total, currency)}`
                              : ""}
                          </span>
                        </div>
                      </li>
                    );
                  })}
              </ol>
            </section>
          ))}

          {bookings.length > 0 ? (
            <section className="trp-card">
              <h3>Bookings on this trip</h3>
              <ul className="plan-bookings">
                {bookings.map((booking) => (
                  <li key={booking.id}>
                    <span className="tag indigo">{booking.booking_type}</span>
                    <span>{booking.status}</span>
                    <span className="event-meta">
                      {money(booking.total, booking.currency) ?? "—"}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
