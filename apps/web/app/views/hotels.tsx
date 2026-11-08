"use client";

import { useEffect, useState, type FormEvent } from "react";
import { ApiClientError, simulatePayment } from "../../lib/api";
import {
  prebookHotel,
  bookHotel,
  searchHotels,
  type HotelOffer,
  type HotelPrebookAttempt,
  type HotelSearchResponse,
  type ProviderActionResponse,
} from "../../lib/api-liteapi";
import {
  ProviderBookingActions,
  ProviderBookingStatus,
  cancellableState,
  providerStateLabel,
  providerStateTone,
} from "./provider-booking-parts";
import {
  COUNTRIES,
  CURRENCIES,
  guessCity,
  guessCountryCode,
} from "./places-options";
import { useTraveller } from "./use-traveller";
import type { ViewProps } from "./types";

function datePart(value: string | null): string {
  return value ? value.slice(0, 10) : "";
}

function money(value: { amount: number; currency: string }): string {
  return `${value.currency} ${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
  }).format(value.amount)}`;
}

function errorText(error: unknown): string {
  if (error instanceof ApiClientError) return error.message;
  return error instanceof Error ? error.message : "Hotel request failed.";
}

function HotelCard({
  hotel,
  selected,
  busy,
  onPrebook,
}: {
  hotel: HotelSearchResponse["hotels"][number];
  selected: boolean;
  busy: boolean;
  onPrebook: (offer: HotelOffer) => void;
}) {
  const { hotel: details, cheapest } = hotel;
  return (
    <article className={`event-card ${selected ? "selected" : ""}`}>
      <div className="event-card-topline">
        <span className="tag sage">
          {details.stars ? `${details.stars} stars` : "Hotel"}
        </span>
        <span className="fresh-label">
          {details.rating ? `Rating ${details.rating}` : "Rate available"}
        </span>
      </div>
      <h3>{details.name}</h3>
      <p className="event-meta">
        <span>⌖</span>{" "}
        {details.address ?? details.city ?? "Location unavailable"}
      </p>
      <p className="event-meta">
        <span>▣</span> {cheapest.room_name} · {money(cheapest.total)}
      </p>
      <p className="event-description">
        {cheapest.board_name ?? "Board details unavailable"} ·{" "}
        {cheapest.refundable === "refundable"
          ? "Refundable"
          : cheapest.refundable === "non_refundable"
            ? "Non-refundable"
            : "Cancellation policy unavailable"}
      </p>
      <button
        className={`button ${selected ? "secondary" : "accent"} wide`}
        disabled={busy || selected}
        onClick={() => onPrebook(cheapest)}
        type="button"
      >
        {selected
          ? "Rate reserved"
          : busy
            ? "Reserving…"
            : "Reserve this rate"}
      </button>
    </article>
  );
}

export default function HotelsView({
  trip,
  onOpenInvoices,
  onOpenBookings,
}: ViewProps) {
  const traveller = useTraveller();
  const [city, setCity] = useState("");
  const [countryCode, setCountryCode] = useState("");
  const [checkin, setCheckin] = useState("");
  const [checkout, setCheckout] = useState("");
  const [adults, setAdults] = useState("1");
  const [nationality, setNationality] = useState("ID");
  const [currency, setCurrency] = useState("USD");
  const [holderFirstName, setHolderFirstName] = useState("");
  const [holderLastName, setHolderLastName] = useState("");
  const [holderEmail, setHolderEmail] = useState("");
  const [holderPhone, setHolderPhone] = useState("");
  const [result, setResult] = useState<HotelSearchResponse | null>(null);
  const [prebook, setPrebook] = useState<HotelPrebookAttempt | null>(null);
  const [booked, setBooked] = useState<ProviderActionResponse | null>(null);
  const [prebookedOfferId, setPrebookedOfferId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [prebookingOffer, setPrebookingOffer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The trip answers the questions the traveller should not have to answer:
  // where, when, and (when the destination names a country) which country.
  useEffect(() => {
    setCity(guessCity(trip.destination_summary));
    setCountryCode(guessCountryCode(trip.destination_summary));
    setCheckin(datePart(trip.start_at));
    setCheckout(datePart(trip.end_at));
    setResult(null);
    setPrebook(null);
    setBooked(null);
    setPrebookedOfferId(null);
    setError(null);
  }, [trip]);

  // The session answers the holder block; the traveller only adds a phone.
  useEffect(() => {
    setHolderFirstName((current) => current || traveller.firstName);
    setHolderLastName((current) => current || traveller.lastName);
    setHolderEmail((current) => current || traveller.email);
  }, [traveller]);

  const holderMissing = [
    holderFirstName.trim() ? null : "first name",
    holderLastName.trim() ? null : "last name",
    holderEmail.trim() ? null : "email",
    holderPhone.trim() ? null : "phone",
  ].filter((value): value is string => value !== null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setPrebook(null);
    setBooked(null);
    setPrebookedOfferId(null);
    try {
      setResult(
        await searchHotels(trip.id, {
          city,
          country_code: countryCode,
          checkin,
          checkout,
          adults: Number(adults),
          currency,
          guest_nationality: nationality,
          limit: 20,
        }),
      );
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  async function reserve(offer: HotelOffer) {
    setPrebookingOffer(offer.offer_id);
    setError(null);
    try {
      setPrebook(await prebookHotel(trip.id, offer.offer_id));
      setPrebookedOfferId(offer.offer_id);
      setBooked(null);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setPrebookingOffer(null);
    }
  }

  async function payAndBook() {
    if (!prebook || holderMissing.length > 0) return;
    setBusy(true);
    setError(null);
    try {
      await simulatePayment(trip.id, prebook.booking.id, "succeeded");
      const bookingResult = await bookHotel(
        trip.id,
        prebook.provider_booking.id,
        {
          holder: {
            first_name: holderFirstName.trim(),
            last_name: holderLastName.trim(),
            email: holderEmail.trim(),
            phone: holderPhone.trim(),
          },
          guests: [
            {
              occupancy_number: 1,
              first_name: holderFirstName.trim(),
              last_name: holderLastName.trim(),
              email: holderEmail.trim(),
            },
          ],
        },
      );
      setBooked(bookingResult);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="view-stack">
      {error ? <div className="status-banner error">{error}</div> : null}
      <section
        className="panel discovery-panel"
        aria-labelledby="hotel-search-title"
      >
        <div className="section-heading">
          <div>
            <p className="eyebrow">STEP 1 · FIND A RATE</p>
            <h2 id="hotel-search-title">
              {city ? `Hotels in ${city}` : "Search hotels"}
            </h2>
          </div>
          <span className="tag sage">LiteAPI sandbox</span>
        </div>
        <form className="discovery-form" onSubmit={submit}>
          <label>
            City
            <input
              value={city}
              onChange={(event) => setCity(event.target.value)}
              required
            />
          </label>
          <label>
            Country
            <select
              value={countryCode}
              onChange={(event) => setCountryCode(event.target.value)}
              required
            >
              <option value="">Choose</option>
              {COUNTRIES.map((country) => (
                <option key={country.code} value={country.code}>
                  {country.code} · {country.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Check-in
            <input
              type="date"
              value={checkin}
              onChange={(event) => setCheckin(event.target.value)}
              required
            />
          </label>
          <label>
            Check-out
            <input
              type="date"
              value={checkout}
              onChange={(event) => setCheckout(event.target.value)}
              required
            />
          </label>
          <button
            className="button accent search-button"
            disabled={busy}
            type="submit"
          >
            {busy ? "Searching…" : "Search hotels"}
          </button>
        </form>
        <details className="limitations">
          <summary>Guests and rate settings</summary>
          <div className="discovery-form">
            <label>
              Adults
              <input
                min="1"
                max="9"
                type="number"
                value={adults}
                onChange={(event) => setAdults(event.target.value)}
                required
              />
            </label>
            <label>
              Guest nationality
              <select
                value={nationality}
                onChange={(event) => setNationality(event.target.value)}
                required
              >
                {COUNTRIES.map((country) => (
                  <option key={country.code} value={country.code}>
                    {country.code} · {country.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Currency
              <select
                value={currency}
                onChange={(event) => setCurrency(event.target.value)}
                required
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
      </section>
      {result ? (
        <section className="results-section" aria-live="polite">
          <div className="section-heading">
            <div>
              <p className="eyebrow">
                {prebook ? "STEP 3 · GUEST DETAILS" : "STEP 2 · PICK A RATE"}
              </p>
              <h2>
                {result.total_found && result.total_found > result.hotels.length
                  ? `${result.hotels.length} of ${result.total_found} hotels`
                  : `${result.hotels.length} hotels found`}
              </h2>
            </div>
            <span className="fresh-label">
              {result.sandbox ? "sandbox" : "live"} · Retrieved{" "}
              {result.retrieved_at}
            </span>
          </div>
          {prebook ? (
            <div className="status-banner success">
              <strong>Rate reserved.</strong> {money(prebook.prebook.total)}{" "}
              from {prebook.prebook.checkin} to {prebook.prebook.checkout}. Add
              the phone number to book it with the sandbox card.
            </div>
          ) : null}
          {prebook && booked === null ? (
            <div className="panel payment-choice">
              <p className="eyebrow">GUEST DETAILS</p>
              <p>
                Reserved rate{" "}
                {prebookedOfferId
                  ? `· ${prebookedOfferId.slice(0, 12)}…`
                  : ""}{" "}
                · {money(prebook.prebook.total)} ·{" "}
                {prebook.prebook.checkin} → {prebook.prebook.checkout}
              </p>
              <div className="discovery-form">
                <label>
                  First name
                  <input
                    value={holderFirstName}
                    onChange={(event) => setHolderFirstName(event.target.value)}
                    required
                  />
                </label>
                <label>
                  Last name
                  <input
                    value={holderLastName}
                    onChange={(event) => setHolderLastName(event.target.value)}
                    required
                  />
                </label>
                <label>
                  Email
                  <input
                    type="email"
                    value={holderEmail}
                    onChange={(event) => setHolderEmail(event.target.value)}
                    required
                  />
                </label>
                <label>
                  Phone
                  <input
                    value={holderPhone}
                    onChange={(event) => setHolderPhone(event.target.value)}
                    placeholder="digits only, no +"
                    required
                  />
                </label>
              </div>
              <button
                className="button accent"
                disabled={busy || holderMissing.length > 0}
                onClick={() => void payAndBook()}
                type="button"
              >
                {busy ? "Paying and booking…" : "Pay sandbox payment and book"}
              </button>
              {holderMissing.length > 0 ? (
                <p className="helper-text" role="status">
                  Still needed: {holderMissing.join(", ")}.
                </p>
              ) : (
                <p className="helper-text">
                  The sandbox card pays {currency} and the provider returns a
                  confirmation code.
                </p>
              )}
            </div>
          ) : null}
          {booked ? (
            <div className="provider-result">
              <div className="provider-result-head">
                <div>
                  <p className="eyebrow">STEP 4 · BOOKED</p>
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
              <ProviderBookingStatus
                provider={booked.provider_booking}
                bookingType="hotel"
              />
              <ProviderBookingActions
                tripId={trip.id}
                bookingType="hotel"
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
          {result.hotels.length === 0 ? (
            <div className="empty-state">
              <span className="panel-icon">⌕</span>
              <h3>No hotel rates found</h3>
              <p>Try another date range, city, or country.</p>
            </div>
          ) : (
            <div className="event-grid">
              {result.hotels.map((entry) => (
                <HotelCard
                  hotel={entry}
                  key={entry.cheapest.offer_id}
                  selected={prebookedOfferId === entry.cheapest.offer_id}
                  busy={prebookingOffer !== null}
                  onPrebook={(offer) => void reserve(offer)}
                />
              ))}
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
