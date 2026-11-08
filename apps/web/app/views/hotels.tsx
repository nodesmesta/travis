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
} from "../../lib/api-liteapi";
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
          ? "Prebooked in sandbox"
          : busy
            ? "Reserving…"
            : "Prebook rate"}
      </button>
    </article>
  );
}

export default function HotelsView({ trip }: ViewProps) {
  const [city, setCity] = useState(trip.destination_summary ?? "");
  const [countryCode, setCountryCode] = useState("");
  const [checkin, setCheckin] = useState(datePart(trip.start_at));
  const [checkout, setCheckout] = useState(datePart(trip.end_at));
  const [adults, setAdults] = useState("1");
  const [nationality, setNationality] = useState("");
  const [currency, setCurrency] = useState("");
  const [holderFirstName, setHolderFirstName] = useState("");
  const [holderLastName, setHolderLastName] = useState("");
  const [holderEmail, setHolderEmail] = useState("");
  const [holderPhone, setHolderPhone] = useState("");
  const [result, setResult] = useState<HotelSearchResponse | null>(null);
  const [prebook, setPrebook] = useState<HotelPrebookAttempt | null>(null);
  const [booked, setBooked] = useState(false);
  const [prebookedOfferId, setPrebookedOfferId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [prebookingOffer, setPrebookingOffer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCity(trip.destination_summary ?? "");
    setCheckin(datePart(trip.start_at));
    setCheckout(datePart(trip.end_at));
    setNationality("");
    setCurrency("");
    setResult(null);
    setPrebook(null);
    setBooked(false);
    setPrebookedOfferId(null);
    setError(null);
  }, [trip]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setPrebook(null);
    setBooked(false);
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
      setBooked(false);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setPrebookingOffer(null);
    }
  }

  async function payAndBook() {
    if (!prebook) return;
    setBusy(true);
    setError(null);
    try {
      await simulatePayment(trip.id, prebook.booking.id, "succeeded");
      await bookHotel(trip.id, prebook.provider_booking.id, {
        holder: {
          first_name: holderFirstName,
          last_name: holderLastName,
          email: holderEmail,
          phone: holderPhone,
        },
        guests: [
          {
            occupancy_number: 1,
            first_name: holderFirstName,
            last_name: holderLastName,
            email: holderEmail,
          },
        ],
      });
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
          <p className="eyebrow">LITEAPI HOTEL SEARCH</p>
          <h1>Find a stay that fits the trip.</h1>
          <p className="lede">
            Rates come from LiteAPI. Search results are live snapshots and a
            prebook reserves the provider rate in the sandbox only.
          </p>
        </div>
        <span className="sun-badge">⌂</span>
      </div>
      {error ? <div className="status-banner error">{error}</div> : null}
      <section
        className="panel discovery-panel"
        aria-labelledby="hotel-search-title"
      >
        <div className="section-heading">
          <div>
            <p className="eyebrow">HOTEL AVAILABILITY</p>
            <h2 id="hotel-search-title">Search by city and dates</h2>
          </div>
          <span className="tag sage">Server-side provider</span>
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
            Country code
            <input
              maxLength={2}
              value={countryCode}
              onChange={(event) =>
                setCountryCode(event.target.value.toUpperCase())
              }
              required
            />
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
            {busy ? "Searching…" : "Search hotels"}
          </button>
        </form>
      </section>
      {result ? (
        <section className="results-section" aria-live="polite">
          <div className="section-heading">
            <div>
              <p className="eyebrow">AVAILABLE RATES</p>
              <h2>{result.hotels.length} hotels found</h2>
            </div>
            <span className="fresh-label">
              {result.sandbox ? "sandbox" : "live"} · Retrieved{" "}
              {result.retrieved_at}
            </span>
          </div>
          {prebook ? (
            <div className="status-banner success">
              <strong>
                {booked ? "Sandbox booking confirmed." : "Rate prebooked."}
              </strong>{" "}
              {money(prebook.prebook.total)} through {prebook.prebook.checkin}{" "}
              to {prebook.prebook.checkout}.
              {!booked
                ? " Complete the guest details and sandbox payment to book it."
                : " Invoice generation has been queued."}
            </div>
          ) : null}
          {prebook && !booked ? (
            <div className="panel payment-choice">
              <p className="eyebrow">GUEST DETAILS</p>
              <div className="discovery-form">
                <label>
                  First name
                  <input
                    value={holderFirstName}
                    onChange={(event) => setHolderFirstName(event.target.value)}
                  />
                </label>
                <label>
                  Last name
                  <input
                    value={holderLastName}
                    onChange={(event) => setHolderLastName(event.target.value)}
                  />
                </label>
                <label>
                  Email
                  <input
                    type="email"
                    value={holderEmail}
                    onChange={(event) => setHolderEmail(event.target.value)}
                  />
                </label>
                <label>
                  Phone
                  <input
                    value={holderPhone}
                    onChange={(event) => setHolderPhone(event.target.value)}
                  />
                </label>
              </div>
              <button
                className="button accent"
                disabled={busy}
                onClick={() => void payAndBook()}
                type="button"
              >
                {busy ? "Paying and booking…" : "Pay sandbox payment and book"}
              </button>
            </div>
          ) : null}
          {result.hotels.length === 0 ? (
            <div className="empty-state">
              <span className="panel-icon">⌕</span>
              <h3>No hotel rates found</h3>
              <p>Try another date range or city.</p>
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
