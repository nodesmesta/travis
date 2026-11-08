"use client";

import { useEffect, useState, type FormEvent } from "react";
import { ApiClientError, simulatePayment } from "../../lib/api";
import {
  bookFlight,
  prebookFlight,
  searchFlights,
  type FlightJourney,
  type FlightPrebookAttempt,
  type FlightSearchResponse,
} from "../../lib/api-liteapi";
import type { ViewProps } from "./types";

function datePart(value: string | null): string {
  return value ? value.slice(0, 10) : "";
}
function money(value: { amount: number; currency: string }): string {
  return `${value.currency} ${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value.amount)}`;
}
function errorText(error: unknown): string {
  if (error instanceof ApiClientError) return error.message;
  return error instanceof Error ? error.message : "Flight request failed.";
}

function JourneyCard({
  journey,
  selected,
  onSelect,
}: {
  journey: FlightJourney;
  selected: boolean;
  onSelect: () => void;
}) {
  const first = journey.segments[0];
  const last = journey.segments[journey.segments.length - 1];
  if (!first || !last) return null;
  return (
    <article className={`event-card ${selected ? "selected" : ""}`}>
      <div className="event-card-topline">
        <span className="tag coral">{first.carrier_name}</span>
        <span className="fresh-label">
          {journey.stops === 0 ? "Direct" : `${journey.stops} stop(s)`}
        </span>
      </div>
      <h3>
        {first.flight_number} · {first.origin_code} → {last.destination_code}
      </h3>
      <p className="event-meta">
        ◷ {first.departs_local} → {last.arrives_local}
      </p>
      <p className="event-meta">
        {Math.round(journey.duration_minutes / 60)}h{" "}
        {journey.duration_minutes % 60}m · {money(journey.cheapest.total)}
      </p>
      <p className="event-description">
        {journey.cheapest.cabin ?? "Cabin unavailable"} ·{" "}
        {journey.cheapest.carry_on_included
          ? "Carry-on included"
          : "Carry-on unavailable"}
      </p>
      <button
        className={`button ${selected ? "secondary" : "accent"} wide`}
        onClick={onSelect}
        type="button"
      >
        {selected ? "Selected" : "Select flight"}
      </button>
    </article>
  );
}

export default function FlightsView({ trip }: ViewProps) {
  const [origin, setOrigin] = useState("");
  const [destination, setDestination] = useState("");
  const [date, setDate] = useState(datePart(trip.start_at));
  const [result, setResult] = useState<FlightSearchResponse | null>(null);
  const [selected, setSelected] = useState<FlightJourney | null>(null);
  const [prebook, setPrebook] = useState<FlightPrebookAttempt | null>(null);
  const [booked, setBooked] = useState(false);
  const [bookedState, setBookedState] = useState<string | null>(null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [birthday, setBirthday] = useState("");
  const [nationality, setNationality] = useState("");
  const [passportNumber, setPassportNumber] = useState("");
  const [passportExpiry, setPassportExpiry] = useState("");
  const [issueCountry, setIssueCountry] = useState("");
  const [currency, setCurrency] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOrigin("");
    setDestination("");
    setDate(datePart(trip.start_at));
    setResult(null);
    setSelected(null);
    setPrebook(null);
    setBooked(false);
    setBookedState(null);
    setError(null);
  }, [trip.id, trip.start_at]);

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSelected(null);
    setPrebook(null);
    setBooked(false);
    setBookedState(null);
    try {
      setResult(
        await searchFlights(trip.id, {
          origin,
          destination,
          date,
          adults: 1,
          currency,
          limit: 20,
        }),
      );
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  async function checkout() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const passenger = {
        type: "adult" as const,
        title: "MR" as const,
        first_name: firstName,
        last_name: lastName,
        birthday,
        gender: "M" as const,
        nationality,
        document: {
          type: "passport" as const,
          number: passportNumber,
          issue_country: issueCountry,
          expiry: passportExpiry,
        },
      };
      const next = await prebookFlight(trip.id, {
        offer_id: selected.cheapest.offer_id,
        purpose: "BUSINESS",
        contact: {
          first_name: firstName,
          last_name: lastName,
          email,
          phone_country_code: "62",
          phone_number: phone,
        },
        passengers: [passenger],
      });
      setPrebook(next);
      await simulatePayment(trip.id, next.booking.id, "succeeded");
      const bookingResult = await bookFlight(trip.id, next.provider_booking.id);
      setBookedState(bookingResult.provider_booking.state);
      setBooked(true);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="view-stack">
      <div className="welcome-row">
        <div>
          <p className="eyebrow">LITEAPI FLIGHT SEARCH</p>
          <h1>Compare flights for the trip.</h1>
          <p className="lede">
            Searches use live LiteAPI sandbox inventory. Ticketing uses the
            provider sandbox card and never charges a real card.
          </p>
        </div>
        <span className="sun-badge">✈</span>
      </div>
      {error ? <div className="status-banner error">{error}</div> : null}
      <section
        className="panel discovery-panel"
        aria-labelledby="flight-search-title"
      >
        <div className="section-heading">
          <div>
            <p className="eyebrow">FLIGHT AVAILABILITY</p>
            <h2 id="flight-search-title">Search a route</h2>
          </div>
          <span className="tag coral">Sandbox provider</span>
        </div>
        <form className="discovery-form" onSubmit={search}>
          <label>
            Origin
            <input
              maxLength={3}
              value={origin}
              onChange={(event) => setOrigin(event.target.value.toUpperCase())}
              required
            />
          </label>
          <label>
            Destination
            <input
              maxLength={3}
              value={destination}
              onChange={(event) =>
                setDestination(event.target.value.toUpperCase())
              }
              required
            />
          </label>
          <label>
            Departure
            <input
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              required
            />
          </label>
          <label>
            Currency
            <input
              maxLength={3}
              value={currency}
              onChange={(event) =>
                setCurrency(event.target.value.toUpperCase())
              }
              required
            />
          </label>
          <button
            className="button accent search-button"
            disabled={busy}
            type="submit"
          >
            {busy ? "Searching…" : "Search flights"}
          </button>
        </form>
      </section>
      {result ? (
        <section className="results-section" aria-live="polite">
          <div className="section-heading">
            <div>
              <p className="eyebrow">AVAILABLE JOURNEYS</p>
              <h2>{result.journeys.length} journeys shown</h2>
            </div>
            <span className="fresh-label">
              {result.total_found} found · {result.retrieved_at}
            </span>
          </div>
          <div className="event-grid">
            {result.journeys.map((journey) => (
              <JourneyCard
                key={journey.journey_key}
                journey={journey}
                selected={selected?.journey_key === journey.journey_key}
                onSelect={() => {
                  setSelected(journey);
                  setPrebook(null);
                  setBooked(false);
                  setBookedState(null);
                }}
              />
            ))}
          </div>
        </section>
      ) : null}
      {selected ? (
        <section className="panel payment-choice">
          <p className="eyebrow">PASSENGER AND SANDBOX CHECKOUT</p>
          <p>
            {selected.segments[0]?.carrier_name ?? "Selected flight"} ·{" "}
            {money(selected.cheapest.total)}. The provider may require a travel
            document.
          </p>
          <div className="discovery-form">
            <label>
              First name
              <input
                value={firstName}
                onChange={(event) => setFirstName(event.target.value)}
              />
            </label>
            <label>
              Last name
              <input
                value={lastName}
                onChange={(event) => setLastName(event.target.value)}
              />
            </label>
            <label>
              Email
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label>
              Phone number
              <input
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
              />
            </label>
            <label>
              Birthday
              <input
                type="date"
                value={birthday}
                onChange={(event) => setBirthday(event.target.value)}
              />
            </label>
            <label>
              Nationality
              <input
                maxLength={2}
                value={nationality}
                onChange={(event) =>
                  setNationality(event.target.value.toUpperCase())
                }
              />
            </label>
            <label>
              Passport number
              <input
                value={passportNumber}
                onChange={(event) => setPassportNumber(event.target.value)}
              />
            </label>
            <label>
              Passport expiry
              <input
                type="date"
                value={passportExpiry}
                onChange={(event) => setPassportExpiry(event.target.value)}
              />
            </label>
            <label>
              Issue country
              <input
                maxLength={2}
                value={issueCountry}
                onChange={(event) =>
                  setIssueCountry(event.target.value.toUpperCase())
                }
              />
            </label>
          </div>
          <button
            className="button accent"
            disabled={busy || booked}
            onClick={() => void checkout()}
            type="button"
          >
            {booked
              ? bookedState === "confirmed"
                ? "Sandbox booking confirmed"
                : `Provider status: ${bookedState ?? "pending"}`
              : busy
                ? "Prebooking and ticketing…"
                : "Pay sandbox payment and book"}
          </button>
          {prebook ? (
            <p className="helper-text">
              Prebook {prebook.prebook.prebook_id} · local booking{" "}
              {prebook.booking.id}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
