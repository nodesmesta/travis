"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiClientError, simulatePayment } from "../../lib/api";
import {
  bookFlight,
  getFlightBooking,
  prebookFlight,
  searchFlights,
  type FlightJourney,
  type FlightPrebookAttempt,
  type FlightSearchResponse,
  type ProviderActionResponse,
} from "../../lib/api-liteapi";
import {
  ProviderBookingActions,
  ProviderBookingStatus,
  cancellableState,
  providerStateLabel,
  providerStateTone,
} from "./provider-booking-parts";
import { CURRENCIES } from "./places-options";
import { SearchField } from "./search-fields";
import { useTraveller } from "./use-traveller";
import type { ExploreViewProps } from "./types";

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function datePart(value: string | null): string {
  return value ? value.slice(0, 10) : "";
}

/** A date `days` from today, in the browser timezone, as `YYYY-MM-DD`. */
function dateFromToday(days: number): string {
  const target = new Date();
  target.setDate(target.getDate() + days);
  const year = target.getFullYear();
  const month = `${target.getMonth() + 1}`.padStart(2, "0");
  const day = `${target.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}
function money(value: { amount: number; currency: string }): string {
  return `${value.currency} ${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value.amount)}`;
}
function errorText(error: unknown): string {
  if (error instanceof ApiClientError) return error.message;
  return error instanceof Error ? error.message : "Flight request failed.";
}

export function JourneyCard({
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
  const hours = Math.floor(journey.duration_minutes / 60);
  const minutes = journey.duration_minutes % 60;
  return (
    <article className={`result-row flight ${selected ? "selected" : ""}`}>
      <div className="result-body">
        <div className="result-title">
          <h3>
            {first.carrier_name} · {first.flight_number}
          </h3>
          <span className="tag coral">
            {journey.stops === 0 ? "Direct" : `${journey.stops} stop`}
          </span>
        </div>
        <p className="event-meta">
          <span>✈</span> {first.origin_code} {first.departs_local} →{" "}
          {last.destination_code} {last.arrives_local}
        </p>
        <p className="event-meta">
          <span>◷</span> {hours}h {minutes}m ·{" "}
          {journey.cheapest.cabin ?? "Cabin unavailable"}
        </p>
        <div className="result-tags">
          <span>
            {journey.cheapest.carry_on_included
              ? "Carry-on included"
              : "Carry-on unavailable"}
          </span>
          <span>
            {journey.cheapest.checked_bag_included
              ? "Checked bag included"
              : "Checked bag extra"}
          </span>
        </div>
      </div>
      <div className="result-price">
        <span className="result-price-label">Total fare</span>
        <strong>{money(journey.cheapest.total)}</strong>
        <button
          className={`button ${selected ? "secondary" : "accent"} wide`}
          onClick={onSelect}
          type="button"
        >
          {selected ? "Selected" : "Select flight"}
        </button>
      </div>
    </article>
  );
}

export default function FlightsView({
  trip,
  onEnsureTrip,
  onOpenInvoices,
  onOpenBookings,
}: ExploreViewProps) {
  const traveller = useTraveller();
  const [activeTripId, setActiveTripId] = useState<string | null>(null);
  /** The trip this search opened itself; re-rendering must not wipe the results. */
  const openedTripId = useRef<string | null>(null);
  const [origin, setOrigin] = useState("");
  const [destination, setDestination] = useState("");
  const [date, setDate] = useState("");
  const [result, setResult] = useState<FlightSearchResponse | null>(null);
  const [selected, setSelected] = useState<FlightJourney | null>(null);
  const [prebook, setPrebook] = useState<FlightPrebookAttempt | null>(null);
  const [booked, setBooked] = useState<ProviderActionResponse | null>(null);
  const [polling, setPolling] = useState(false);
  const pollToken = useRef(0);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [birthday, setBirthday] = useState("");
  const [nationality, setNationality] = useState("ID");
  const [passportNumber, setPassportNumber] = useState("");
  const [passportExpiry, setPassportExpiry] = useState("");
  const [issueCountry, setIssueCountry] = useState("ID");
  const [currency, setCurrency] = useState("USD");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<{
    origin?: string;
    destination?: string;
    date?: string;
  }>({});

  useEffect(() => {
    if (trip && openedTripId.current === trip.id) {
      setActiveTripId(trip.id);
      return;
    }
    setActiveTripId(trip?.id ?? null);
    setOrigin("");
    setDestination("");
    setDate(datePart(trip?.start_at ?? null) || dateFromToday(7));
    setResult(null);
    setSelected(null);
    setPrebook(null);
    setBooked(null);
    setPolling(false);
    pollToken.current += 1;
    setError(null);
  }, [trip?.id, trip?.start_at]);

  useEffect(() => {
    setFirstName((current) => current || traveller.firstName);
    setLastName((current) => current || traveller.lastName);
    setEmail((current) => current || traveller.email);
  }, [traveller]);

  const passengerMissing = [
    firstName.trim() ? null : "first name",
    lastName.trim() ? null : "last name",
    email.trim() ? null : "email",
    phone.trim() ? null : "phone",
    birthday ? null : "birthday",
    nationality.trim().length === 2 ? null : "nationality (2 letters)",
    passportNumber.trim() ? null : "passport number",
    passportExpiry ? null : "passport expiry",
    issueCountry.trim().length === 2 ? null : "passport issue country",
  ].filter((value): value is string => value !== null);

  /** Flights are ticketed into a trip; open one from the route when there is none. */
  async function requireTrip(): Promise<string> {
    if (activeTripId) return activeTripId;
    const created = await onEnsureTrip({
      name: `${origin} → ${destination} flight`.slice(0, 160),
      destination: `${origin} → ${destination}`.slice(0, 500),
      startDate: date,
      endDate: date,
    });
    openedTripId.current = created.id;
    setActiveTripId(created.id);
    return created.id;
  }

  function swapAirports() {
    setOrigin(destination);
    setDestination(origin);
  }

  function validate(): boolean {
    const next: { origin?: string; destination?: string; date?: string } = {};
    if (origin.trim().length !== 3) next.origin = "Three-letter airport code.";
    if (destination.trim().length !== 3)
      next.destination = "Three-letter airport code.";
    if (origin && origin === destination)
      next.destination = "Origin and destination are the same.";
    if (!date) next.date = "Choose a departure date.";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validate()) return;
    setBusy(true);
    setError(null);
    setSelected(null);
    setPrebook(null);
    setBooked(null);
    setPolling(false);
    pollToken.current += 1;
    try {
      const tripId = await requireTrip();
      setResult(
        await searchFlights(tripId, {
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
    if (!selected || passengerMissing.length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const passenger = {
        type: "adult" as const,
        title: "MR" as const,
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        birthday,
        gender: "M" as const,
        nationality: nationality.trim().toUpperCase(),
        document: {
          type: "passport" as const,
          number: passportNumber.trim(),
          issue_country: issueCountry.trim().toUpperCase(),
          expiry: passportExpiry,
        },
      };
      const tripId = await requireTrip();
      const next = await prebookFlight(tripId, {
        offer_id: selected.cheapest.offer_id,
        purpose: "BUSINESS",
        contact: {
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          email: email.trim(),
          phone_country_code: "62",
          phone_number: phone.trim(),
        },
        passengers: [passenger],
      });
      setPrebook(next);
      await simulatePayment(tripId, next.booking.id, "succeeded");
      const bookingResult = await bookFlight(tripId, next.provider_booking.id);
      setBooked(bookingResult);
      if (
        bookingResult.provider_booking.state === "pending" ||
        bookingResult.provider_booking.state === "booking"
      ) {
        void pollProviderStatus(bookingResult.provider_booking.id);
      }
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  async function pollProviderStatus(providerBookingId: string) {
    const token = pollToken.current + 1;
    pollToken.current = token;
    setPolling(true);
    try {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await wait(attempt === 0 ? 3000 : 5000);
        if (token !== pollToken.current) return;
        const response = await getFlightBooking(
          activeTripId ?? "",
          providerBookingId,
        );
        if (token !== pollToken.current) return;
        setBooked(response);
        const state = response.provider_booking.state;
        if (state !== "pending" && state !== "booking") return;
      }
    } catch (caught) {
      if (token === pollToken.current) setError(errorText(caught));
    } finally {
      if (token === pollToken.current) setPolling(false);
    }
  }

  return (
    <div className="view-stack">
      {error ? <div className="status-banner error">{error}</div> : null}
      <section
        aria-labelledby="flight-search-title"
        className="panel search-panel"
      >
        <h2 className="sr-only" id="flight-search-title">
          Search flights
        </h2>
        <form className="search-bar flights" onSubmit={search} noValidate>
          <SearchField className="grow" error={errors.origin} icon="✈" label="From">
            <input
              autoComplete="off"
              maxLength={3}
              onChange={(event) => setOrigin(event.target.value.toUpperCase())}
              placeholder="CGK"
              value={origin}
            />
          </SearchField>
          <button
            aria-label="Swap origin and destination"
            className="swap-button"
            onClick={swapAirports}
            type="button"
          >
            ⇄
          </button>
          <SearchField className="grow" error={errors.destination} icon="✈" label="To">
            <input
              autoComplete="off"
              maxLength={3}
              onChange={(event) =>
                setDestination(event.target.value.toUpperCase())
              }
              placeholder="SIN"
              value={destination}
            />
          </SearchField>
          <SearchField error={errors.date} hint="One way" icon="◷" label="Departure">
            <input
              min={dateFromToday(0)}
              onChange={(event) => setDate(event.target.value)}
              type="date"
              value={date}
            />
          </SearchField>
          <SearchField icon="☺" label="Travellers">
            <span className="stepper">
              <span className="stepper-value">1 adult</span>
            </span>
          </SearchField>
          <button
            className="button accent search-bar-submit"
            disabled={busy}
            type="submit"
          >
            {busy ? "Searching…" : "Search"}
          </button>
        </form>
        <div className="search-foot">
          <span className="search-chips">
            <span>
              {origin || "From"} → {destination || "To"}
            </span>
            {date ? <span>{date}</span> : null}
            <span>1 adult</span>
            <span>One way</span>
            <span>Fares in {currency}</span>
          </span>
          <details className="search-options">
            <summary>Fare settings</summary>
            <div className="search-options-body">
              <label>
                Currency
                <select
                  onChange={(event) => setCurrency(event.target.value)}
                  value={currency}
                >
                  {CURRENCIES.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </details>
        </div>
      </section>
      {result ? (
        <section className="results-section" aria-live="polite">
          <div className="section-heading">
            <div>
              <p className="eyebrow">
                {selected
                  ? "STEP 3 · PASSENGER AND SANDBOX CHECKOUT"
                  : "STEP 2 · PICK A JOURNEY"}
              </p>
              <h2>{result.journeys.length} journeys shown</h2>
            </div>
            <span className="fresh-label">
              {result.total_found} found · {result.retrieved_at}
            </span>
          </div>
          <div className="result-list">
            {result.journeys.map((journey) => (
              <JourneyCard
                key={journey.journey_key}
                journey={journey}
                selected={selected?.journey_key === journey.journey_key}
                onSelect={() => {
                  setSelected(journey);
                  setPrebook(null);
                  setBooked(null);
                  pollToken.current += 1;
                }}
              />
            ))}
          </div>
        </section>
      ) : null}
      {selected ? (
        <section className="panel checkout-panel">
          <div className="checkout-head">
            <div>
              <p className="eyebrow">STEP 3 · PASSENGER DETAILS</p>
              <h3>
                {selected.segments[0]?.carrier_name ?? "Selected flight"} ·{" "}
                {selected.segments[0]?.origin_code} →{" "}
                {selected.segments[selected.segments.length - 1]?.destination_code}
              </h3>
              <p>
                {date} · one adult · the provider requires a passport for this
                fare
              </p>
            </div>
            <div className="checkout-price">
              <span>Total</span>
              <strong>{money(selected.cheapest.total)}</strong>
            </div>
          </div>
          <div className="checkout-grid">
            <label>
              First name
              <input
                value={firstName}
                onChange={(event) => setFirstName(event.target.value)}
                required
              />
            </label>
            <label>
              Last name
              <input
                value={lastName}
                onChange={(event) => setLastName(event.target.value)}
                required
              />
            </label>
            <label>
              Email
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>
            <label>
              Phone number
              <input
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="digits only, no +"
                required
              />
            </label>
            <label>
              Birthday
              <input
                type="date"
                value={birthday}
                onChange={(event) => setBirthday(event.target.value)}
                required
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
                required
              />
            </label>
            <label>
              Passport number
              <input
                value={passportNumber}
                onChange={(event) => setPassportNumber(event.target.value)}
                required
              />
            </label>
            <label>
              Passport expiry
              <input
                type="date"
                value={passportExpiry}
                onChange={(event) => setPassportExpiry(event.target.value)}
                required
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
                required
              />
            </label>
          </div>
          <button
            className="button accent"
            disabled={busy || booked !== null || passengerMissing.length > 0}
            onClick={() => void checkout()}
            type="button"
          >
            {booked
              ? "Sandbox payment completed"
              : busy
                ? "Prebooking and ticketing…"
                : "Pay sandbox payment and book"}
          </button>
          {passengerMissing.length > 0 ? (
            <p className="helper-text" role="status">
              Still needed: {passengerMissing.join(", ")}.
            </p>
          ) : null}
          {prebook?.verification ? (
            <p className="helper-text">
              {prebook.verification.changed
                ? `Price changed since the search (${prebook.verification.messages[0] ?? "provider update"}). Verified total ${prebook.verification.total.currency} ${prebook.verification.total.amount}.`
                : `Price verified at ${prebook.verification.total.currency} ${prebook.verification.total.amount} just now.`}
            </p>
          ) : null}
          {prebook ? (
            <p className="helper-text">
              Prebook {prebook.prebook.prebook_id} · local booking{" "}
              {prebook.booking.id}
            </p>
          ) : null}
          {booked ? (
            <div className="provider-result">
              <div className="provider-result-head">
                <div>
                  <p className="eyebrow">STEP 4 · TICKETED</p>
                  <span className="provider-label">Confirmation code</span>
                  <strong className="provider-code">
                    {booked.provider_booking.confirmation_code ??
                      booked.booking.confirmation_code ??
                      "Not issued yet"}
                  </strong>
                </div>
                <span
                  className={`booking-status ${providerStateTone(booked.provider_booking.state)}`}
                >
                  {providerStateLabel(booked.provider_booking.state)}
                </span>
              </div>
              {polling ? (
                <p className="helper-text" role="status">
                  Checking the provider for the ticket status…
                </p>
              ) : null}
              <ProviderBookingStatus
                provider={booked.provider_booking}
                bookingType="flight"
              />
              <ProviderBookingActions
                tripId={activeTripId ?? ""}
                bookingType="flight"
                providerBookingId={booked.provider_booking.id}
                canCancel={cancellableState(booked.provider_booking.state)}
                onUpdated={setBooked}
              />
              <div className="provider-action-row">
                <button
                  className="button ghost"
                  onClick={onOpenBookings}
                  type="button"
                >
                  All reservations
                </button>
                <button
                  className="button ghost"
                  onClick={onOpenInvoices}
                  type="button"
                >
                  Invoices
                </button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
