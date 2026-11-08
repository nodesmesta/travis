"use client";

import { useEffect, useState } from "react";
import {
  ApiClientError,
  getBookingQuote,
  simulatePayment,
} from "../../lib/api";
import { createActivityBooking, discoverPlaces } from "../../lib/api-mobility";
import type { Booking, BookingQuote, Payment } from "../../lib/types";
import type {
  MobilitySource,
  PlaceDiscoveryView,
  PlaceItemView,
  RiskLevel,
  TrafficSnapshotView,
  WeatherSnapshotView,
} from "../../lib/types-mobility";
import type { ContextPoint } from "../../lib/types";

export function formatWhen(
  value: string | null | undefined,
  timezone = "Asia/Jakarta",
): string {
  if (!value) return "Not provided";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(new Date(value));
}

export function minutesOf(seconds: number): string {
  return `${Math.round(seconds / 60)} min`;
}

/** Message for a failed call. Provider errors say so instead of showing an empty state. */
export function describeError(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 401)
      return "Your session has expired. Please sign in again.";
    if (error.code === "EXTERNAL_CONFIGURATION_MISSING") {
      return "This data provider is not configured on the server, so no data can be shown. Nothing was estimated.";
    }
    if (error.code === "RATE_LIMITED")
      return "Too many requests. Wait a moment and try again.";
    if (error.status === 502 || error.status === 503 || error.status === 504) {
      return `The data provider did not answer (${error.code}). Nothing was estimated; try again later.`;
    }
    return `${error.message} (${error.code})`;
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}

const RISK_TEXT: Record<RiskLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  unknown: "Unknown",
};

export function RiskTag({ label, level }: { label: string; level: RiskLevel }) {
  const tone =
    level === "low" ? "sage" : level === "unknown" ? "muted" : "coral";
  return (
    <span className={`tag ${tone}`}>
      {label}: {RISK_TEXT[level]}
    </span>
  );
}

export function SourceList({
  sourceIds,
  sources,
}: {
  sourceIds: string[];
  sources: MobilitySource[];
}) {
  const used = sources.filter((source) => sourceIds.includes(source.id));
  return (
    <details className="source-details">
      <summary>Source and freshness</summary>
      {used.length === 0 ? (
        <small>Source metadata is not available.</small>
      ) : null}
      {used.map((source) => (
        <div className="source-row" key={source.id}>
          <span>
            {source.title ?? source.provider} · {source.freshness}
          </span>
          <small>Retrieved {formatWhen(source.retrieved_at, "UTC")} UTC</small>
          {source.url ? (
            <a href={source.url} target="_blank" rel="noreferrer">
              Open source ↗
            </a>
          ) : null}
        </div>
      ))}
    </details>
  );
}

// ---------------------------------------------------------------------------

export function WeatherCard({
  snapshot,
  label,
  timezone,
}: {
  snapshot: WeatherSnapshotView;
  label: string;
  timezone: string;
}) {
  const current = snapshot.current;
  const next = snapshot.hourly[0] ?? null;
  const day = snapshot.daily[0] ?? null;
  const chance = (value: number | null) =>
    value === null ? "Not reported" : `${Math.round(value * 100)}%`;
  return (
    <article className="mobility-card" aria-label={`Weather at ${label}`}>
      <div className="event-card-topline">
        <span className="tag sage">Weather</span>
        <span className="fresh-label">
          {snapshot.freshness} · retrieved{" "}
          {formatWhen(snapshot.retrieved_at, timezone)}
        </span>
      </div>
      <h3>{label}</h3>
      {current ? (
        <p className="event-meta">
          Now: {current.condition ?? "Condition not reported"}
          {current.temperature_c !== null
            ? `, ${Math.round(current.temperature_c)}°C`
            : ""}
        </p>
      ) : (
        <p className="event-meta">Current conditions were not reported.</p>
      )}
      {next ? (
        <p className="event-meta">
          Forecast for {formatWhen(next.at, timezone)}: chance of rain{" "}
          {chance(next.precipitation_probability)}
          {snapshot.forecast_interval_minutes
            ? ` (one forecast every ${snapshot.forecast_interval_minutes / 60} hours)`
            : ""}
        </p>
      ) : (
        <p className="event-meta">The provider returned no forecast.</p>
      )}
      {snapshot.forecast_ends_at ? (
        <p className="event-meta">
          The forecast ends {formatWhen(snapshot.forecast_ends_at, timezone)}.
          Later times have no forecast.
        </p>
      ) : null}
      {day ? (
        <p className="event-meta">
          Daily forecast ({formatWhen(day.at, timezone)}):{" "}
          {day.condition ?? "n/a"}, chance of rain{" "}
          {chance(day.precipitation_probability)}
        </p>
      ) : null}
      {snapshot.alerts.length > 0 ? (
        <ul className="mobility-list">
          {snapshot.alerts.map((alert) => (
            <li key={`${alert.event}-${alert.start}`}>
              Alert: {alert.event}
              {alert.sender ? ` (${alert.sender})` : ""}
            </li>
          ))}
        </ul>
      ) : null}
      <small>
        Weather data from OpenWeather (current weather and 5-day forecast) ·
        valid until {formatWhen(snapshot.expires_at, timezone)}
      </small>
    </article>
  );
}

export function TrafficCard({
  snapshot,
  label,
  timezone,
}: {
  snapshot: TrafficSnapshotView;
  label: string;
  timezone: string;
}) {
  return (
    <article className="mobility-card" aria-label={`Traffic for ${label}`}>
      <div className="event-card-topline">
        <span className="tag sage">Traffic</span>
        <span className="fresh-label">
          {snapshot.freshness} · retrieved{" "}
          {formatWhen(snapshot.retrieved_at, timezone)}
        </span>
      </div>
      <h3>{label}</h3>
      <p>
        <RiskTag label="Area traffic" level={snapshot.traffic_level} />
      </p>
      <p className="event-meta">
        {snapshot.summary.segment_count} road segments · average jam factor{" "}
        {snapshot.summary.average_jam_factor ?? "not reported"} ·{" "}
        {snapshot.summary.incident_count} incident(s)
      </p>
      {snapshot.incidents.slice(0, 3).map((incident) => (
        <p className="event-meta" key={incident.id}>
          {incident.type ?? "Incident"}
          {incident.criticality ? ` (${incident.criticality})` : ""}
          {incident.summary ? `: ${incident.summary}` : ""}
        </p>
      ))}
      <small>
        Source: HERE Traffic API v7 · area around the leg, not one route ·
        policy {snapshot.policy_version}
      </small>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Nearby places

function PlaceCard({
  place,
  sources,
  onBook,
  timezone,
}: {
  place: PlaceItemView;
  sources: MobilitySource[];
  onBook?: () => void;
  timezone: string;
}) {
  const expired = place.freshness === "expired";
  return (
    <article className="event-card">
      <div className="event-card-topline">
        <span className="tag coral">
          {place.category === "restaurant"
            ? "Restaurant"
            : (place.activity_type ?? "Activity")}
        </span>
        <span className="fresh-label">
          {place.freshness} · {formatWhen(place.retrieved_at, timezone)}
        </span>
      </div>
      <h3>{place.name}</h3>
      {place.address ? <p className="event-meta">{place.address}</p> : null}
      {place.distance_meters != null ? (
        <p className="event-meta">
          {place.distance_meters} m in a straight line
        </p>
      ) : null}
      {place.description ? (
        <p className="event-description">{place.description}</p>
      ) : null}
      {place.category === "activity" ? (
        <ul className="mobility-list">
          <li>Setting: {place.indoor_outdoor ?? "unknown"}</li>
          <li>Weather sensitivity: {place.weather_sensitivity ?? "unknown"}</li>
          <li>
            Suggested time:{" "}
            {place.recommended_duration_minutes
              ? `${place.recommended_duration_minutes} min`
              : "not stated by the source"}
          </li>
          <li>
            Booking:{" "}
            {place.booking_required === true
              ? "required, per the source"
              : place.booking_required === false
                ? "not required, per the source"
                : "not stated by the source"}
          </li>
        </ul>
      ) : place.cuisines && place.cuisines.length > 0 ? (
        <p className="event-meta">Cuisine: {place.cuisines.join(", ")}</p>
      ) : null}
      {place.opening_hours ? (
        <ul
          className="mobility-list"
          aria-label="Opening hours from the source"
        >
          {place.opening_hours.text.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : (
        <p className="event-meta">Opening hours: not provided by the source.</p>
      )}
      {place.official_url ? (
        <a href={place.official_url} target="_blank" rel="noreferrer">
          Website ↗
        </a>
      ) : null}
      <SourceList sourceIds={place.source_ids} sources={sources} />
      {onBook ? (
        <button
          className="button accent wide"
          disabled={expired}
          onClick={onBook}
          type="button"
        >
          {expired ? "Expired, search again" : "Book this"}
        </button>
      ) : null}
    </article>
  );
}

function ActivityBooking({
  tripId,
  place,
  onClose,
  onOpenInvoices,
}: {
  tripId: string;
  place: PlaceItemView;
  onClose: () => void;
  onOpenInvoices?: () => void;
}) {
  const [booking, setBooking] = useState<Booking | null>(null);
  const [payment, setPayment] = useState<Payment | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quote, setQuote] = useState<BookingQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    getBookingQuote(tripId, "activity").then(
      (result) => {
        if (current) setQuote(result);
      },
      (caught: unknown) => {
        if (current) setQuoteError(describeError(caught));
      },
    );
    return () => {
      current = false;
    };
  }, [tripId]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      setBooking(
        await createActivityBooking(tripId, {
          source_id: place.id,
        }),
      );
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function pay(outcome: "succeeded" | "failed") {
    if (!booking) return;
    setBusy(true);
    setError(null);
    try {
      const result = await simulatePayment(tripId, booking.id, outcome);
      setBooking(result.booking);
      setPayment(result.payment);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  const confirmed =
    payment?.status === "succeeded" && booking?.status === "confirmed";
  const failed = payment?.status === "failed" || booking?.status === "failed";
  return (
    <aside
      className="panel booking-panel"
      aria-labelledby="activity-booking-title"
    >
      <p className="eyebrow">INTERNAL BOOKING</p>
      <h2 id="activity-booking-title">{place.name}</h2>
      <div className="price-summary">
        <span>Demo activity price</span>
        {quote ? (
          <>
            <strong>
              {quote.currency}{" "}
              {new Intl.NumberFormat("en-US").format(quote.total)}
            </strong>
            <small>
              Includes {quote.currency}{" "}
              {new Intl.NumberFormat("en-US").format(quote.tax)} tax · Price
              policy {quote.policy_version} · No real money moves
            </small>
          </>
        ) : quoteError ? (
          <small role="alert">Price unavailable: {quoteError}</small>
        ) : (
          <small role="status">Getting the price…</small>
        )}
      </div>
      {error ? (
        <div className="status-banner error" role="alert">
          {error}
        </div>
      ) : null}
      {!booking ? (
        <button
          className="button primary wide"
          disabled={busy || !quote}
          onClick={() => void create()}
          type="button"
        >
          {busy ? "Creating booking…" : "Confirm booking details"}
        </button>
      ) : confirmed ? (
        <div className="status-banner success" role="status">
          <strong>Booking confirmed</strong>
          <span>
            Confirmation {booking.confirmation_code ?? booking.id.slice(0, 8)}
          </span>
          {onOpenInvoices ? (
            <button
              className="button secondary"
              onClick={onOpenInvoices}
              type="button"
            >
              View invoice
            </button>
          ) : null}
        </div>
      ) : failed ? (
        <div className="status-banner error" role="alert">
          <strong>Payment failed</strong>
          <span>This booking was not confirmed.</span>
        </div>
      ) : (
        <div className="payment-choice">
          <p className="eyebrow">DUMMY PAYMENT</p>
          <div className="button-row">
            <button
              className="button primary"
              disabled={busy}
              onClick={() => void pay("succeeded")}
              type="button"
            >
              Pay successfully
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() => void pay("failed")}
              type="button"
            >
              Simulate failure
            </button>
          </div>
        </div>
      )}
      <button className="button ghost" onClick={onClose} type="button">
        Close
      </button>
    </aside>
  );
}

export function NearbyPlaces({
  tripId,
  context,
  onOpenInvoices,
}: {
  tripId: string;
  context: ContextPoint | null;
  onOpenInvoices?: () => void;
}) {
  const [category, setCategory] = useState<"activity" | "restaurant">(
    "activity",
  );
  const [result, setResult] = useState<PlaceDiscoveryView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [booking, setBooking] = useState<PlaceItemView | null>(null);

  async function search() {
    if (!context) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setBooking(null);
    try {
      setResult(
        await discoverPlaces(tripId, {
          context_point_id: context.id,
          category,
        }),
      );
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="nearby-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">AROUND YOUR CONTEXT POINT</p>
          <h2 id="nearby-title">Activities and restaurants</h2>
        </div>
      </div>
      <div className="mobility-controls">
        <label>
          Type
          <select
            value={category}
            onChange={(event) => {
              setCategory(
                event.target.value === "restaurant" ? "restaurant" : "activity",
              );
              setResult(null);
              setError(null);
            }}
          >
            <option value="activity">Activities (web sources)</option>
            <option value="restaurant">Restaurants (HERE)</option>
          </select>
        </label>
        <button
          className="button accent"
          disabled={busy || !context}
          onClick={() => void search()}
          type="button"
        >
          {busy ? "Searching…" : "Find nearby"}
        </button>
      </div>
      <p className="helper-text">
        {context ? (
          <>
            Searching around <strong>{context.label}</strong>.
          </>
        ) : (
          "Choose a resolved context point first."
        )}
      </p>
      <div aria-live="polite">
        {busy ? (
          <p className="helper-text">
            <span className="spinner" /> Asking the live provider. Activities
            can take up to a minute.
          </p>
        ) : null}
        {error ? (
          <div className="status-banner error" role="alert">
            {error}
          </div>
        ) : null}
        {result ? (
          <>
            <p className="fresh-label">
              {result.freshness} · retrieved{" "}
              {formatWhen(result.retrieved_at, context?.timezone)} · valid until{" "}
              {formatWhen(result.expires_at, context?.timezone)}
              {result.cache_status === "hit"
                ? " · from a still-valid earlier search"
                : ""}
            </p>
            {result.limitations.length > 0 ? (
              <details className="limitations">
                <summary>About this search</summary>
                {result.limitations.map((text) => (
                  <p key={text}>{text}</p>
                ))}
              </details>
            ) : null}
            {result.items.length === 0 ? (
              <div className="empty-state">
                <h3>No sourced result</h3>
                <p>
                  The provider answered, but nothing passed the source and
                  location checks. Nothing was invented.
                </p>
              </div>
            ) : (
              <div className="event-grid">
                {result.items.map((place) => (
                  <PlaceCard
                    key={place.id}
                    place={place}
                    sources={result.sources}
                    timezone={context?.timezone ?? "Asia/Jakarta"}
                    {...(place.category === "activity"
                      ? { onBook: () => setBooking(place) }
                      : {})}
                  />
                ))}
              </div>
            )}
          </>
        ) : null}
      </div>
      {booking ? (
        <ActivityBooking
          tripId={tripId}
          place={booking}
          onClose={() => setBooking(null)}
          {...(onOpenInvoices ? { onOpenInvoices } : {})}
        />
      ) : null}
    </section>
  );
}
