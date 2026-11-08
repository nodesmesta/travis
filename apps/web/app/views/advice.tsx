"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { listAgendaItems } from "../../lib/api-assistant";
import { listTripBookings } from "../../lib/api-invoices";
import { discoverEvents } from "../../lib/api";
import {
  createRouteRequest,
  getRouteRequest,
  listJourneyLegs,
  listRouteRequests,
  refreshWeather,
} from "../../lib/api-mobility";
import { formatInZone } from "../../lib/trips-time";
import type {
  Booking,
  ContextPoint,
  EventDiscoveryResponse,
} from "../../lib/types";
import type { AgendaItemView, JourneyLegView } from "../../lib/types-assistant";
import type {
  RouteRequestResult,
  WeatherSnapshotView,
} from "../../lib/types-mobility";
import type { ViewProps } from "./types";

const ADVICE_WINDOW_DAYS = 7;
const ROUTE_WINDOW_HOURS = 72;

const TYPE_LABEL: Record<string, string> = {
  flight: "Flight",
  train: "Train",
  meeting: "Meeting",
  conference: "Conference",
  event: "Event",
  meal: "Meal",
  hotel_check_in: "Hotel check-in",
  hotel_check_out: "Hotel check-out",
  free_time: "Free time",
  custom: "Ticket",
};

type SectionState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready" }
  | { state: "error"; message: string };

function when(value: string | null | undefined, timezone: string): string {
  if (!value) return "Time not set";
  const formatted = formatInZone(value, timezone);
  return `${formatted.slice(0, 10)} ${formatted.slice(11, 16)}`;
}

function weatherLine(
  weather: WeatherSnapshotView | null,
  timezone: string,
): string | null {
  if (!weather) return null;
  const current = weather.current;
  const day = weather.daily[0] ?? null;
  const rain = day?.precipitation_probability ?? null;
  if (current) {
    const temperature = current.temperature_c;
    const condition = current.description ?? current.condition ?? "";
    if (temperature === null) return condition || null;
    const rainNote =
      rain !== null && rain >= 0.5
        ? " Rain is likely later, so keep extra time."
        : "";
    return `${temperature} °C, ${condition || "current conditions"}.${rainNote}`;
  }
  if (day && day.temperature_c !== null) {
    return `${day.temperature_c} °C, ${day.description ?? day.condition ?? "forecast"}.`;
  }
  return `Forecast for ${timezone}.`;
}

function bookingLabel(booking: Booking): string {
  if (booking.confirmation_code) return booking.confirmation_code;
  return `${booking.booking_type} ${booking.id.slice(0, 8)}`;
}

/**
 * Advice is produced from the traveller's own tickets, not from a question.
 * When the trip has a ticket, the view asks Bright Data for what is happening
 * around its place, OpenWeather for the forecast, and the mobility engine for
 * the ride. Nothing is typed by the traveller and nothing is invented.
 */
export default function AdviceView({
  trip,
  contexts,
  context,
  onSelectContext,
}: ViewProps) {
  const [tickets, setTickets] = useState<AgendaItemView[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [legs, setLegs] = useState<JourneyLegView[]>([]);
  const [placeId, setPlaceId] = useState<string | null>(context?.id ?? null);
  const [weather, setWeather] = useState<WeatherSnapshotView | null>(null);
  const [events, setEvents] = useState<EventDiscoveryResponse | null>(null);
  const [route, setRoute] = useState<RouteRequestResult | null>(null);
  const [weatherState, setWeatherState] = useState<SectionState>({
    state: "idle",
  });
  const [eventState, setEventState] = useState<SectionState>({ state: "idle" });
  const [routeState, setRouteState] = useState<SectionState>({ state: "idle" });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingTickets, setLoadingTickets] = useState(true);
  const [tick, setTick] = useState(0);

  const placeOf = useCallback(
    (id: string | null | undefined): ContextPoint | null =>
      id ? (contexts.find((point) => point.id === id) ?? null) : null,
    [contexts],
  );

  const ticketPlaces = useMemo(
    () =>
      tickets
        .map((ticket) => placeOf(ticket.context_point_id))
        .filter((point): point is ContextPoint => point !== null),
    [tickets, placeOf],
  );

  const selectedPlace = placeOf(placeId) ?? ticketPlaces[0] ?? null;
  const hasTicket = tickets.length > 0 || bookings.length > 0;

  useEffect(() => {
    let current = true;
    setLoadingTickets(true);
    setLoadError(null);
    Promise.allSettled([
      listAgendaItems(trip.id),
      listTripBookings(trip.id),
      listJourneyLegs(trip.id),
    ])
      .then(([agendaResult, bookingResult, legResult]) => {
        if (!current) return;
        if (agendaResult.status === "fulfilled") {
          const upcoming = agendaResult.value.items
            .filter((item) => item.status !== "cancelled")
            .sort(
              (left, right) =>
                Date.parse(left.start_at) - Date.parse(right.start_at),
            );
          setTickets(upcoming);
        } else {
          setLoadError("Your tickets could not be loaded.");
        }
        if (bookingResult.status === "fulfilled") {
          setBookings(bookingResult.value.items);
        }
        if (legResult.status === "fulfilled") {
          setLegs(legResult.value.items);
        }
      })
      .finally(() => {
        if (current) setLoadingTickets(false);
      });
    return () => {
      current = false;
    };
  }, [trip.id]);

  useEffect(() => {
    if (loadingTickets || !hasTicket) return;
    const point = selectedPlace;
    if (!point) return;
    let current = true;

    const eventWindowFrom = new Date();
    const eventWindowTo = new Date(
      eventWindowFrom.getTime() + ADVICE_WINDOW_DAYS * 86_400_000,
    );
    setWeatherState({ state: "loading" });
    setEventState({ state: "loading" });
    setRouteState({ state: "idle" });
    setWeather(null);
    setEvents(null);
    setRoute(null);

    void refreshWeather(trip.id, point.id)
      .then((list) => {
        if (!current) return;
        setWeather(
          list.items.find((item) => item.context_point_id === point.id) ?? null,
        );
        setWeatherState({ state: "ready" });
      })
      .catch((error: unknown) => {
        if (!current) return;
        setWeatherState({
          state: "error",
          message:
            error instanceof Error
              ? error.message
              : "The forecast is unavailable.",
        });
      });

    void discoverEvents(trip.id, {
      context_point_id: point.id,
      observed_for: {
        from: eventWindowFrom.toISOString(),
        to: eventWindowTo.toISOString(),
        timezone: trip.timezone,
      },
      filters: { category: "business_events", language: "en" },
    })
      .then((result) => {
        if (!current) return;
        setEvents(result);
        setEventState({ state: "ready" });
      })
      .catch((error: unknown) => {
        if (!current) return;
        setEventState({
          state: "error",
          message:
            error instanceof Error
              ? error.message
              : "Live advice could not be scraped right now.",
        });
      });

    const leg = legs
      .filter(
        (candidate) =>
          (candidate.status === "planned" ||
            candidate.status === "in_progress") &&
          Date.parse(candidate.departure_at) - Date.now() <=
            ROUTE_WINDOW_HOURS * 3_600_000,
      )
      .sort(
        (left, right) =>
          Date.parse(left.departure_at) - Date.parse(right.departure_at),
      )[0];
    if (leg) {
      setRouteState({ state: "loading" });
      void listRouteRequests(trip.id, leg.id)
        .then(async (list) => {
          const latest = list.items[0];
          if (latest) return getRouteRequest(trip.id, latest.id);
          return createRouteRequest(trip.id, leg.id, {
            required_facts: ["route", "traffic", "weather"],
          });
        })
        .then((result) => {
          if (!current) return;
          setRoute(result);
          setRouteState({ state: "ready" });
        })
        .catch((error: unknown) => {
          if (!current) return;
          setRouteState({
            state: "error",
            message:
              error instanceof Error
                ? error.message
                : "The ride advice is unavailable.",
          });
        });
    }

    return () => {
      current = false;
    };
  }, [
    trip.id,
    trip.timezone,
    loadingTickets,
    hasTicket,
    selectedPlace,
    legs,
    tick,
  ]);

  function choosePlace(point: ContextPoint) {
    setPlaceId(point.id);
    onSelectContext(point);
  }

  const recommended =
    route?.options.find((option) => option.recommended) ?? null;
  const eventSources = events?.sources ?? [];

  return (
    <section className="panel adv-view" aria-labelledby="advice-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">ADVICE</p>
          <h2 id="advice-title">Advice from your tickets</h2>
          <p className="helper-text">
            Created automatically from the tickets on this trip. No question
            needed.
          </p>
        </div>
        <button
          type="button"
          className="button ghost"
          onClick={() => setTick((value) => value + 1)}
          disabled={!hasTicket || eventState.state === "loading"}
        >
          Refresh advice
        </button>
      </div>

      {loadError ? (
        <div className="status-banner error" role="alert">
          {loadError}
        </div>
      ) : null}

      {loadingTickets ? (
        <p className="helper-text" role="status">
          Reading your tickets…
        </p>
      ) : !hasTicket ? (
        <div className="empty-state">
          <h3>No ticket yet</h3>
          <p>
            Advice appears as soon as this trip has a ticket. Search a stay or a
            flight, and the trip will carry the place and time.
          </p>
        </div>
      ) : (
        <>
          <div className="adv-tickets" aria-label="Tickets on this trip">
            {tickets.map((ticket) => {
              const point = placeOf(ticket.context_point_id);
              return (
                <article className="adv-ticket" key={ticket.id}>
                  <span className="tag sage">
                    {TYPE_LABEL[ticket.type] ?? ticket.type}
                  </span>
                  <strong>{ticket.title}</strong>
                  <small>
                    {when(ticket.start_at, trip.timezone)}
                    {point ? ` · ${point.label}` : " · place not resolved"}
                  </small>
                </article>
              );
            })}
          </div>

          {ticketPlaces.length > 1 ? (
            <div className="adv-places" role="group" aria-label="Advice place">
              {ticketPlaces.map((point) => (
                <button
                  key={point.id}
                  type="button"
                  className={`asst-chip${selectedPlace?.id === point.id ? " selected" : ""}`}
                  onClick={() => choosePlace(point)}
                >
                  {point.label}
                </button>
              ))}
            </div>
          ) : null}

          <div className="adv-grid">
            <article className="adv-card" aria-labelledby="adv-weather">
              <div className="adv-card-head">
                <span className="tag indigo">Weather</span>
                <h3 id="adv-weather">
                  {selectedPlace ? selectedPlace.label : "Your place"}
                </h3>
              </div>
              {weatherState.state === "loading" ? (
                <p className="helper-text" role="status">
                  Checking the forecast…
                </p>
              ) : weatherState.state === "error" ? (
                <p className="field-error">{weatherState.message}</p>
              ) : weather ? (
                <>
                  <p className="adv-lead">
                    {weatherLine(weather, trip.timezone)}
                  </p>
                  <dl className="asst-fields">
                    {weather.daily.slice(0, 3).map((day) => (
                      <div key={day.at}>
                        <dt>
                          {formatInZone(day.at, trip.timezone).slice(0, 10)}
                        </dt>
                        <dd>
                          {day.temperature_c ?? "n/a"} °C ·{" "}
                          {day.description ?? day.condition ?? "forecast"}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <p className="adv-source">
                    OpenWeather · retrieved{" "}
                    {when(weather.retrieved_at, trip.timezone)}
                  </p>
                </>
              ) : (
                <p className="helper-text">No forecast for this place yet.</p>
              )}
            </article>

            <article className="adv-card" aria-labelledby="adv-events">
              <div className="adv-card-head">
                <span className="tag sage">Around you</span>
                <h3 id="adv-events">
                  {selectedPlace ? selectedPlace.label : "Near the ticket"}
                </h3>
              </div>
              {eventState.state === "loading" ? (
                <p className="helper-text" role="status">
                  Reading live pages near this place…
                </p>
              ) : eventState.state === "error" ? (
                <p className="field-error">{eventState.message}</p>
              ) : events && events.items.length > 0 ? (
                <ul className="adv-events">
                  {events.items.slice(0, 6).map((event) => {
                    const source = eventSources.find((entry) =>
                      event.source_ids.includes(entry.id),
                    );
                    return (
                      <li key={event.id}>
                        <strong>{event.title}</strong>
                        <small>
                          {when(event.starts_at, trip.timezone)}
                          {event.venue_name ? ` · ${event.venue_name}` : ""}
                        </small>
                        {source?.url ? (
                          <a
                            href={source.url}
                            target="_blank"
                            rel="noreferrer noopener"
                          >
                            {source.title ?? "Source"}
                          </a>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="helper-text">
                  No readable event was found near this place. The search ran;
                  it found nothing that could be checked.
                </p>
              )}
              {events ? (
                <p className="adv-source">
                  Bright Data · retrieved{" "}
                  {when(events.retrieved_at, trip.timezone)}
                </p>
              ) : null}
            </article>

            <article className="adv-card" aria-labelledby="adv-route">
              <div className="adv-card-head">
                <span className="tag indigo">Getting there</span>
                <h3 id="adv-route">From place to place</h3>
              </div>
              {routeState.state === "loading" ? (
                <p className="helper-text" role="status">
                  Comparing the ride…
                </p>
              ) : routeState.state === "error" ? (
                <p className="field-error">{routeState.message}</p>
              ) : route && recommended ? (
                <>
                  <p className="adv-lead">
                    Leave by{" "}
                    {route.departure_recommendation
                      ? when(
                          route.departure_recommendation.depart_at,
                          trip.timezone,
                        )
                      : route.options[0]
                        ? when(
                            route.options[0].derived_metrics.departure_at,
                            trip.timezone,
                          )
                        : "the recommended time"}
                    . Best option: {recommended.transport_mode},{" "}
                    {Math.round(
                      recommended.derived_metrics.total_duration_seconds / 60,
                    )}{" "}
                    min.
                  </p>
                  <p className="adv-source">
                    TravelFlow mobility engine · traffic and weather included
                  </p>
                </>
              ) : (
                <p className="helper-text">
                  No ride is due in the next {ROUTE_WINDOW_HOURS} hours.
                </p>
              )}
            </article>
          </div>

          {bookings.length > 0 ? (
            <div className="adv-bookings">
              <p className="asst-who">Your tickets</p>
              <ul>
                {bookings.slice(0, 6).map((booking) => (
                  <li key={booking.id}>
                    <span>{bookingLabel(booking)}</span>
                    <small>
                      {booking.status} · {booking.currency}{" "}
                      {booking.total.toFixed(2)}
                    </small>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
