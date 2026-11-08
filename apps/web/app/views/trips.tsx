"use client";

import { useEffect, useMemo, useState } from "react";
import { listAgendaItems } from "../../lib/api-assistant";
import { listTripBookings } from "../../lib/api-invoices";
import { getHotelDetails, type HotelContent } from "../../lib/api-liteapi";
import {
  createRouteRequest,
  getRouteRequest,
  listJourneyLegs,
  listRouteRequests,
  listWeather,
  refreshWeather,
} from "../../lib/api-mobility";
import { formatInZone } from "../../lib/trips-time";
import type { Booking, Trip } from "../../lib/types";
import type { AgendaItemView } from "../../lib/types-trips";
import type {
  JourneyLeg,
  RouteRequestResult,
  WeatherList,
  WeatherSnapshotView,
} from "../../lib/types-mobility";
import { statusLabel } from "./trips-parts";
import type { TripsViewProps } from "./types";

/**
 * A trip is advice, not a second list of bookings. It shows what the traveller
 * actually lives: the tickets in detail, the places they put them in, and the
 * travel between those places with its route, its traffic and its weather.
 * Bookings stays the transaction record; this page is what happens on the ground.
 */

const TYPE_LABEL: Record<string, string> = {
  hotel_check_in: "Stay",
  hotel_check_out: "Check-out",
  flight: "Flight",
  event: "Event",
  transport: "Transfer",
};

const MODE_LABEL: Record<string, string> = {
  car: "Drive",
  taxi: "Taxi",
  pedestrian: "Walk",
  transit: "Public transit",
};

const ADVICE_WINDOW_HOURS = 72;

type Advice =
  | { state: "loading" }
  | { state: "ready"; result: RouteRequestResult }
  | { state: "error"; message: string };

function typeIcon(type: string): string {
  if (type.startsWith("hotel")) return "🛏";
  if (type === "flight") return "✈";
  if (type === "event") return "🎟";
  return "◈";
}

function metaString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function metaNumber(metadata: Record<string, unknown>, key: string): number | null {
  const value = metadata[key];
  return typeof value === "number" ? value : null;
}

function money(amount: number | null, currency: string | null): string | null {
  if (amount === null || !currency) return null;
  return `${currency} ${amount.toFixed(2)}`;
}

function minutes(seconds: number | null): string {
  if (seconds === null) return "—";
  const total = Math.round(seconds / 60);
  if (total < 60) return `${total} min`;
  return `${Math.floor(total / 60)} h ${total % 60} min`;
}

/** `10 Nov 15:00` in the trip's zone, built from the formatter the app already uses. */
function when(value: string, timezone: string): string {
  const formatted = formatInZone(value, timezone);
  const day = formatted.slice(0, 10);
  const clock = formatted.slice(11, 16);
  const date = new Date(`${day}T00:00:00Z`);
  const label = Number.isNaN(date.getTime())
    ? day
    : date.toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        timeZone: "UTC",
      });
  return `${label} ${clock}`;
}

function clock(value: string, timezone: string): string {
  return formatInZone(value, timezone).slice(11, 16);
}

function dayOf(value: string, timezone: string): string {
  return formatInZone(value, timezone).slice(0, 10);
}

function nightsBetween(start: string, end: string, timezone: string): number {
  const from = Date.parse(`${dayOf(start, timezone)}T00:00:00Z`);
  const to = Date.parse(`${dayOf(end, timezone)}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

/** What the forecast looks like in one line, written from the numbers only. */
function weatherLine(weather: WeatherSnapshotView | null): string | null {
  if (!weather) return null;
  const window = weather.hourly.slice(0, 12);
  const rain = window.reduce(
    (max, point) => Math.max(max, point.precipitation_probability ?? 0),
    0,
  );
  const temps = window
    .map((point) => point.temperature_c)
    .filter((value): value is number => typeof value === "number");
  const low = temps.length > 0 ? Math.min(...temps) : null;
  const high = temps.length > 0 ? Math.max(...temps) : null;
  const condition =
    weather.current?.description ??
    weather.current?.condition ??
    window[0]?.description ??
    window[0]?.condition ??
    null;
  const parts: string[] = [];
  if (condition) parts.push(condition);
  if (low !== null && high !== null)
    parts.push(`${Math.round(low)}–${Math.round(high)}°C`);
  if (rain > 0) parts.push(`rain ${Math.round(rain * 100)}%`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function recommendedOf(result: RouteRequestResult) {
  if (!result.recommended_option_id) return null;
  return (
    result.options.find((option) => option.id === result.recommended_option_id) ?? null
  );
}

/** What the forecast asks of the traveller, written from the numbers only. */
function weatherAdvice(view: WeatherSnapshotView): string {
  const window = view.hourly.slice(0, 12);
  const rain = window.reduce(
    (max, point) => Math.max(max, point.precipitation_probability ?? 0),
    0,
  );
  const temps = window
    .map((point) => point.temperature_c)
    .filter((value): value is number => typeof value === "number");
  const low = temps.length > 0 ? Math.min(...temps) : null;
  const high = temps.length > 0 ? Math.max(...temps) : null;
  if (rain >= 0.6)
    return "Rain is likely in the next hours: keep the transfers indoors where you can and allow extra time.";
  if (rain >= 0.3)
    return "Showers are possible: carry something waterproof for the walk between places.";
  if (high !== null && high >= 33)
    return "It will be hot: do the outdoor parts early or late and carry water.";
  if (low !== null && low <= 18)
    return "It will be cool: bring a layer for the evening.";
  return "No weather risk stands out for the next hours.";
}

function PlaceForecast({
  place,
  view,
  busy,
  onRefresh,
}: {
  place: { context_point_id: string; label: string; type: string };
  view: WeatherSnapshotView | null;
  busy: boolean;
  onRefresh: () => void;
}) {
  return (
    <li className="advice-row">
      <div className="advice-head">
        <span className="plan-icon" aria-hidden="true">
          {place.type === "hotel" ? "🛏" : place.type === "airport" ? "✈" : "◈"}
        </span>
        <div className="advice-title">
          <strong>{place.label}</strong>
          {view ? (
            <span className="event-meta">
              {weatherLine(view) ?? "Forecast available"}
            </span>
          ) : (
            <span className="event-meta">No forecast fetched for this place yet.</span>
          )}
        </div>
        <button className="button ghost" onClick={onRefresh} type="button">
          {busy ? "Checking…" : view ? "Refresh" : "Get forecast"}
        </button>
      </div>
      {view ? (
        <div className="advice-body">
          <p className="advice-advise">{weatherAdvice(view)}</p>
          <p className="event-meta">
            Fetched {when(view.retrieved_at, view.timezone)} · valid until{" "}
            {when(view.expires_at, view.timezone)}
          </p>
        </div>
      ) : null}
    </li>
  );
}

function PlanDetail({ item, timezone }: { item: AgendaItemView; timezone: string }) {
  const segments = Array.isArray(item.metadata.segments)
    ? (item.metadata.segments as Array<Record<string, unknown>>)
    : [];
  const hotelId = metaString(item.metadata, "hotel_id");
  const [hotel, setHotel] = useState<HotelContent | null>(null);
  const [hotelError, setHotelError] = useState(false);

  useEffect(() => {
    if (!hotelId) return;
    let current = true;
    getHotelDetails(hotelId)
      .then((result) => {
        if (current) setHotel(result.hotel);
      })
      .catch(() => {
        if (current) setHotelError(true);
      });
    return () => {
      current = false;
    };
  }, [hotelId]);

  if (item.type === "flight") {
    if (segments.length === 0) {
      return (
        <span className="event-meta">
          The schedule was not stored with this ticket.
        </span>
      );
    }
    return (
      <ol className="plan-segments">
        {segments.map((segment, index) => (
          <li key={`${String(segment.from)}-${String(index)}`}>
            <span className="plan-segment-route">
              {metaString(segment, "from")} → {metaString(segment, "to")}
            </span>
            <span className="event-meta">
              {metaString(segment, "departs_at")} → {metaString(segment, "arrives_at")} ·{" "}
              {metaString(segment, "carrier")} {metaString(segment, "flight_number")}
            </span>
          </li>
        ))}
      </ol>
    );
  }

  if (!item.type.startsWith("hotel")) return null;

  return (
    <div className="plan-hotel">
      {hotel?.images?.[0]?.url ? (
        <img
          alt={hotel.name}
          className="plan-hotel-photo"
          loading="lazy"
          src={hotel.images[0].url}
        />
      ) : null}
      <div className="plan-hotel-text">
        <strong>{hotel?.name ?? item.title}</strong>
        {hotel?.stars ? <span className="event-meta">{hotel.stars}★</span> : null}
        {hotel?.address ? <span className="event-meta">{hotel.address}</span> : null}
        <span className="event-meta">
          Check-in from {hotel?.checkin_from ?? "15:00"}
          {hotel?.checkin_until ? ` until ${hotel.checkin_until}` : ""} · Check-out by{" "}
          {hotel?.checkout_until ?? "12:00"} ·{" "}
          {nightsBetween(item.start_at, item.end_at, timezone)} nights
        </span>
        {hotelError ? (
          <span className="event-meta">
            The hotel page is unavailable; the times below come from your ticket.
          </span>
        ) : null}
      </div>
    </div>
  );
}

function AdviceBody({
  result,
  timezone,
}: {
  result: RouteRequestResult;
  timezone: string;
}) {
  const option = recommendedOf(result);
  const departure = result.departure_recommendation;
  const weather = weatherLine(result.weather);
  return (
    <div className="advice-body">
      {departure ? (
        <p className="advice-advise">
          <strong>Leave by {clock(departure.depart_at, timezone)}</strong>
          {departure.latest_departure_at
            ? ` · latest ${clock(departure.latest_departure_at, timezone)}`
            : ""}
          {departure.buffer_seconds > 0
            ? ` · ${minutes(departure.buffer_seconds)} spare`
            : ""}
        </p>
      ) : null}

      {option ? (
        <p className="advice-route">
          <strong>{MODE_LABEL[option.transport_mode] ?? option.transport_mode}</strong>{" "}
          {minutes(option.provider_facts.duration_seconds)} · arrive{" "}
          {clock(option.derived_metrics.arrival_at, timezone)} · traffic{" "}
          {option.risk.traffic} · weather {option.risk.weather}
        </p>
      ) : (
        <p className="advice-route">No route is recommended for this leg yet.</p>
      )}

      {weather ? <p className="event-meta">Forecast for the arrival: {weather}</p> : null}

      {result.facts.length > 0 ? (
        <ul className="advice-facts">
          {result.facts.slice(0, 3).map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
        </ul>
      ) : null}

      {result.limitations.length > 0 ? (
        <p className="event-meta">
          Not known: {result.limitations.slice(0, 2).join("; ")}
        </p>
      ) : null}
    </div>
  );
}

function LegRow({
  leg,
  trip,
  advice,
  onLoad,
}: {
  leg: JourneyLeg;
  trip: Trip;
  advice: Advice | undefined;
  onLoad: (force: boolean) => void;
}) {
  return (
    <li className="advice-row">
      <div className="advice-head">
        <span className="plan-icon" aria-hidden="true">
          ⇄
        </span>
        <div className="advice-title">
          <strong>
            {leg.origin_label ?? "Origin"} → {leg.destination_label ?? "Destination"}
          </strong>
          <span className="event-meta">
            Planned departure {when(leg.departure_at, trip.timezone)}
            {leg.status !== "planned" ? ` · ${leg.status}` : ""}
          </span>
        </div>
        <button className="button ghost" onClick={() => onLoad(true)} type="button">
          {advice?.state === "loading" ? "Checking…" : "Refresh advice"}
        </button>
      </div>

      {advice === undefined ? (
        <button
          className="button secondary advice-load"
          onClick={() => onLoad(false)}
          type="button"
        >
          Get route, traffic and weather
        </button>
      ) : null}

      {advice?.state === "loading" ? (
        <p className="helper-text" role="status">
          Comparing routes, traffic and weather…
        </p>
      ) : null}

      {advice?.state === "error" ? (
        <p className="field-error" role="status">
          {advice.message}
        </p>
      ) : null}

      {advice?.state === "ready" ? (
        <AdviceBody result={advice.result} timezone={trip.timezone} />
      ) : null}
    </li>
  );
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
  const [legs, setLegs] = useState<JourneyLeg[]>([]);
  const [weather, setWeather] = useState<WeatherList | null>(null);
  const [fetching, setFetching] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advice, setAdvice] = useState<Record<string, Advice>>({});

  useEffect(() => {
    if (!trip) {
      setAgenda([]);
      setBookings([]);
      setLegs([]);
      setWeather(null);
      setError(null);
      return;
    }
    let current = true;
    setLoading(true);
    setError(null);
    setAdvice({});
    Promise.allSettled([
      listAgendaItems(trip.id),
      listTripBookings(trip.id),
      listJourneyLegs(trip.id),
      listWeather(trip.id),
    ])
      .then(([agendaResult, bookingResult, legResult, weatherResult]) => {
        if (!current) return;
        if (agendaResult.status === "fulfilled") setAgenda(agendaResult.value.items);
        if (bookingResult.status === "fulfilled")
          setBookings(bookingResult.value.items);
        if (legResult.status === "fulfilled") setLegs(legResult.value.items);
        if (weatherResult.status === "fulfilled") setWeather(weatherResult.value);
        if (
          agendaResult.status === "rejected" &&
          bookingResult.status === "rejected" &&
          legResult.status === "rejected" &&
          weatherResult.status === "rejected"
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

  const sorted = useMemo(
    () =>
      [...agenda].sort(
        (left, right) => Date.parse(left.start_at) - Date.parse(right.start_at),
      ),
    [agenda],
  );
  const timezone = trip?.timezone ?? "UTC";
  const days = useMemo(
    () => [...new Set(sorted.map((item) => dayOf(item.start_at, timezone)))],
    [sorted, timezone],
  );

  async function loadAdvice(leg: JourneyLeg, force: boolean) {
    if (!trip) return;
    const tripId = trip.id;
    setAdvice((current) => ({ ...current, [leg.id]: { state: "loading" } }));
    try {
      let result: RouteRequestResult | null = null;
      if (!force) {
        const existing = await listRouteRequests(tripId, leg.id);
        const latest = existing.items[0] ?? null;
        if (latest) result = await getRouteRequest(tripId, latest.id);
      }
      if (!result) {
        result = await createRouteRequest(tripId, leg.id, {
          required_facts: ["route", "traffic", "weather"],
        });
      }
      setAdvice((current) => ({
        ...current,
        [leg.id]: { state: "ready", result: result as RouteRequestResult },
      }));
    } catch (caught) {
      setAdvice((current) => ({
        ...current,
        [leg.id]: {
          state: "error",
          message:
            caught instanceof Error
              ? caught.message
              : "Advice is unavailable right now.",
        },
      }));
    }
  }

  async function loadForecast(contextPointId: string) {
    if (!trip) return;
    const tripId = trip.id;
    setFetching((current) => ({ ...current, [contextPointId]: true }));
    try {
      await refreshWeather(tripId, contextPointId);
      const next = await listWeather(tripId);
      setWeather(next);
    } catch {
      // The previous forecast stays on screen; the button can be pressed again.
    } finally {
      setFetching((current) => ({ ...current, [contextPointId]: false }));
    }
  }

  // A leg inside the advice window is answered without a click. Further out the
  // forecast would be guesswork, so the traveller asks when it is worth asking.
  useEffect(() => {
    if (!trip || legs.length === 0) return;
    const now = Date.now();
    for (const leg of legs) {
      if (advice[leg.id] !== undefined) continue;
      if (Date.parse(leg.departure_at) - now > ADVICE_WINDOW_HOURS * 3_600_000) continue;
      void loadAdvice(leg, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legs, trip]);

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
        A trip is the plan you will live: the tickets in detail, the travel between
        your places, and what the traffic and the weather mean for each one.
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
                  {item.start_at ? dayOf(item.start_at, item.timezone) : "—"} →{" "}
                  {item.end_at ? dayOf(item.end_at, item.timezone) : "—"}
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
                {trip.start_at ? dayOf(trip.start_at, timezone) : "—"} →{" "}
                {trip.end_at ? dayOf(trip.end_at, timezone) : "—"}
              </p>
            </div>
            {onOpenBookings ? (
              <button className="button ghost" onClick={onOpenBookings} type="button">
                Bookings & invoices
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
              <p>Its tickets appear here as soon as a booking on this trip succeeds.</p>
            </div>
          ) : null}

          {days.map((day) => (
            <section className="plan-day" key={day}>
              <p className="eyebrow">{day}</p>
              <ol className="plan-list">
                {sorted
                  .filter((item) => dayOf(item.start_at, timezone) === day)
                  .map((item) => {
                    const confirmation = metaString(item.metadata, "confirmation_code");
                    const total = metaNumber(item.metadata, "total");
                    const currency = metaString(item.metadata, "currency");
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
                            {when(item.start_at, timezone)} → {when(item.end_at, timezone)}
                            {confirmation ? ` · Confirmation ${confirmation}` : ""}
                            {money(total, currency) ? ` · ${money(total, currency)}` : ""}
                          </span>
                          {!cancelled ? (
                            <PlanDetail item={item} timezone={timezone} />
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
              </ol>
            </section>
          ))}

          <section className="trp-card">
            <h3>Getting around</h3>
            <p className="event-meta">
              The transfers your tickets imply, with the route, the traffic and the
              weather for each one.
            </p>
            {legs.length === 0 ? (
              <p className="helper-text">
                This trip has no flight, so there is no airport transfer to plan. A
                stay plus a flight gives you the route, the traffic and the weather for
                the way in and the way back.
              </p>
            ) : (
              <ul className="advice-list">
                {legs.map((leg) => (
                  <LegRow
                    advice={advice[leg.id]}
                    key={leg.id}
                    leg={leg}
                    onLoad={(force) => void loadAdvice(leg, force)}
                    trip={trip}
                  />
                ))}
              </ul>
            )}
          </section>

          <section className="trp-card">
            <h3>Places & forecast</h3>
            <p className="event-meta">
              Every place your tickets put you in, and what the weather asks of you
              there.
            </p>
            {weather === null || weather.places.length === 0 ? (
              <p className="helper-text">
                A place appears here once a booking adds one to this trip.
              </p>
            ) : (
              <ul className="advice-list">
                {weather.places.map((place) => (
                  <PlaceForecast
                    busy={fetching[place.context_point_id] === true}
                    key={place.context_point_id}
                    onRefresh={() => void loadForecast(place.context_point_id)}
                    place={place}
                    view={
                      weather.items.find(
                        (item) => item.context_point_id === place.context_point_id,
                      ) ?? null
                    }
                  />
                ))}
              </ul>
            )}
          </section>

          {bookings.length > 0 ? (
            <section className="trp-card">
              <h3>What you paid</h3>
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
