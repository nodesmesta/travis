"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiClientError, simulatePayment } from "../../lib/api";
import {
  prebookHotel,
  bookHotel,
  cityBelongsToCountry,
  listCountries,
  searchHotels,
  type PlaceCountry,
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
  countryLabel,
  guessCity,
  guessCountryCode,
  nightsBetween,
} from "./places-options";
import { CityPicker } from "./city-picker";
import { GuestStepper, SearchField } from "./search-fields";
import { useTraveller } from "./use-traveller";
import type { ExploreViewProps } from "./types";

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
  return `${value.currency} ${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
  }).format(value.amount)}`;
}

function errorText(error: unknown): string {
  if (error instanceof ApiClientError) return error.message;
  return error instanceof Error ? error.message : "Hotel request failed.";
}

type HotelErrors = {
  city?: string;
  country?: string;
  checkin?: string;
  checkout?: string;
};

export function HotelRow({
  hotel,
  nights,
  selected,
  busy,
  onPrebook,
}: {
  hotel: HotelSearchResponse["hotels"][number];
  nights: number;
  selected: boolean;
  busy: boolean;
  onPrebook: (offer: HotelOffer) => void;
}) {
  const { hotel: details, cheapest } = hotel;
  const refundable =
    cheapest.refundable === "refundable"
      ? "Refundable"
      : cheapest.refundable === "non_refundable"
        ? "Non-refundable"
        : "Cancellation policy unavailable";
  return (
    <article className={`result-row ${selected ? "selected" : ""}`}>
      <div className="result-media">
        {details.photo_url ? (
          // Provider photos are hot-linked; a broken one falls back to the panel.
          <img alt={details.name} loading="lazy" src={details.photo_url} />
        ) : (
          <span aria-hidden="true" className="result-media-fallback">
            {details.name.slice(0, 1)}
          </span>
        )}
      </div>
      <div className="result-body">
        <div className="result-title">
          <h3>{details.name}</h3>
          {details.stars ? (
            <span className="tag sage">{details.stars} stars</span>
          ) : null}
        </div>
        <p className="event-meta">
          <span>⌖</span>{" "}
          {details.address ?? details.city ?? "Location unavailable"}
        </p>
        <p className="event-meta">
          <span>▣</span> {cheapest.room_name}
        </p>
        <div className="result-tags">
          <span>{cheapest.board_name ?? "Board details unavailable"}</span>
          <span>{refundable}</span>
          {details.rating ? (
            <span>
              Rating {details.rating}
              {details.review_count ? ` · ${details.review_count} reviews` : ""}
            </span>
          ) : null}
        </div>
      </div>
      <div className="result-price">
        <span className="result-price-label">
          {nights > 1 ? `Total · ${nights} nights` : "Total"}
        </span>
        <strong>{money(cheapest.total)}</strong>
        <button
          className={`button ${selected ? "secondary" : "accent"} wide`}
          disabled={busy || selected}
          onClick={() => onPrebook(cheapest)}
          type="button"
        >
          {selected ? "Rate reserved" : busy ? "Reserving…" : "Reserve"}
        </button>
      </div>
    </article>
  );
}

export default function HotelsView({
  trip,
  onEnsureTrip,
  onOpenInvoices,
  onOpenBookings,
}: ExploreViewProps) {
  const traveller = useTraveller();
  const [activeTripId, setActiveTripId] = useState<string | null>(null);
  /** The trip this search opened itself; re-rendering must not wipe the results. */
  const openedTripId = useRef<string | null>(null);
  const [city, setCity] = useState("");
  const [countryCode, setCountryCode] = useState("");
  const [checkin, setCheckin] = useState("");
  const [checkout, setCheckout] = useState("");
  const [adults, setAdults] = useState(1);
  const [nationality, setNationality] = useState("ID");
  const [currency, setCurrency] = useState("USD");
  const [errors, setErrors] = useState<HotelErrors>({});
  // The provider owns the country list; the static one is only a fallback for
  // the moment before it arrives or when it cannot be reached.
  const [countries, setCountries] = useState<PlaceCountry[]>(
    COUNTRIES.map((country) => ({ code: country.code, name: country.label })),
  );
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
  // where, when, and (when the destination names a country) which country. With
  // no trip yet the search still opens on usable defaults.
  useEffect(() => {
    if (trip && openedTripId.current === trip.id) {
      setActiveTripId(trip.id);
      return;
    }
    const start = datePart(trip?.start_at ?? null) || dateFromToday(1);
    const end = datePart(trip?.end_at ?? null) || dateFromToday(3);
    setActiveTripId(trip?.id ?? null);
    setCity(guessCity(trip?.destination_summary ?? null));
    setCountryCode(guessCountryCode(trip?.destination_summary ?? null));
    setCheckin(start);
    setCheckout(end > start ? end : dateFromToday(2));
    setResult(null);
    setPrebook(null);
    setBooked(null);
    setPrebookedOfferId(null);
    setErrors({});
    setError(null);
  }, [trip]);

  useEffect(() => {
    let cancelled = false;
    listCountries()
      .then((result) => {
        if (!cancelled && result.countries.length > 0)
          setCountries(result.countries);
      })
      .catch(() => {
        // Keep the static list: a country still has to be pickable.
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  const nights = nightsBetween(checkin, checkout);
  const countryName =
    countries.find((country) => country.code === countryCode)?.name ??
    countryLabel(countryCode);

  /** Hotels are booked into a trip; open one from the search when there is none. */
  async function requireTrip(): Promise<string> {
    if (activeTripId) return activeTripId;
    const label = countryLabel(countryCode);
    const created = await onEnsureTrip({
      name: `${city} stay`.slice(0, 160),
      destination: (label ? `${city}, ${label}` : city).slice(0, 500),
      startDate: checkin,
      endDate: checkout,
    });
    openedTripId.current = created.id;
    setActiveTripId(created.id);
    return created.id;
  }

  function validate(): boolean {
    const next: HotelErrors = {};
    if (!countryCode) next.country = "Choose the country first.";
    if (!city.trim()) next.city = "Choose a city.";
    else if (!countryCode) next.city = "Choose the country first.";
    if (!checkin) next.checkin = "Choose a check-in date.";
    if (!checkout) next.checkout = "Choose a check-out date.";
    else if (nights <= 0) next.checkout = "Check-out must be after check-in.";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  /**
   * The provider only knows its own city names, so a city from another country
   * would come back as an empty result list instead of an error.
   */
  async function cityMatchesCountry(): Promise<boolean> {
    try {
      if (await cityBelongsToCountry(countryCode, city)) return true;
      setErrors((current) => ({
        ...current,
        city: `“${city.trim()}” is not a city in ${countryName}. Pick one from the list.`,
      }));
      return false;
    } catch {
      // The provider is the final judge; a failed lookup must not block search.
      return true;
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validate()) return;
    setBusy(true);
    setError(null);
    setPrebook(null);
    setBooked(null);
    setPrebookedOfferId(null);
    try {
      if (!(await cityMatchesCountry())) return;
      const tripId = await requireTrip();
      setResult(
        await searchHotels(tripId, {
          city,
          country_code: countryCode,
          checkin,
          checkout,
          adults,
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
      const tripId = await requireTrip();
      setPrebook(await prebookHotel(tripId, offer.offer_id));
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
      const tripId = await requireTrip();
      await simulatePayment(tripId, prebook.booking.id, "succeeded");
      const bookingResult = await bookHotel(
        tripId,
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
        aria-labelledby="hotel-search-title"
        className="panel search-panel"
      >
        <h2 className="sr-only" id="hotel-search-title">
          Search stays
        </h2>
        <form className="search-bar stays" onSubmit={submit} noValidate>
          <SearchField error={errors.country} icon="⌂" label="Country">
            <select
              onChange={(event) => {
                setCountryCode(event.target.value);
                setCity("");
              }}
              value={countryCode}
            >
              <option value="">Choose</option>
              {countries.map((country) => (
                <option key={country.code} value={country.code}>
                  {country.name}
                </option>
              ))}
            </select>
          </SearchField>
          <SearchField
            className="grow"
            error={errors.city}
            hint={countryCode ? undefined : "Pick a country first"}
            icon="⌖"
            label="City"
          >
            <CityPicker
              country={countryCode}
              countryName={countryName}
              disabled={!countryCode}
              onChange={setCity}
              value={city}
            />
          </SearchField>
          <SearchField
            error={errors.checkin ?? errors.checkout}
            hint={
              nights > 0
                ? `${nights} ${nights === 1 ? "night" : "nights"}`
                : undefined
            }
            icon="▦"
            label="Check-in → Check-out"
          >
            <span className="date-range">
              <input
                aria-label="Check-in"
                min={dateFromToday(0)}
                onChange={(event) => {
                  const value = event.target.value;
                  setCheckin(value);
                  if (checkout && value >= checkout) setCheckout("");
                }}
                type="date"
                value={checkin}
              />
              <span aria-hidden="true" className="date-arrow">
                →
              </span>
              <input
                aria-label="Check-out"
                min={checkin || dateFromToday(1)}
                onChange={(event) => setCheckout(event.target.value)}
                type="date"
                value={checkout}
              />
            </span>
          </SearchField>
          <SearchField icon="☺" label="Guests">
            <GuestStepper onChange={setAdults} value={adults} />
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
            <span>{city.trim() || "Anywhere"}</span>
            {nights > 0 ? (
              <span>
                {nights} {nights === 1 ? "night" : "nights"}
              </span>
            ) : null}
            <span>
              {adults} {adults === 1 ? "adult" : "adults"}
            </span>
            <span>Rates in {currency}</span>
          </span>
          <details className="search-options">
            <summary>Rate settings</summary>
            <div className="search-options-body">
              <label>
                Guest nationality
                <select
                  onChange={(event) => setNationality(event.target.value)}
                  value={nationality}
                >
                  {COUNTRIES.map((country) => (
                    <option key={country.code} value={country.code}>
                      {country.label}
                    </option>
                  ))}
                </select>
              </label>
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
                {prebook ? "STEP 3 · GUEST DETAILS" : "STEP 2 · PICK A RATE"}
              </p>
              <h2>
                {result.total_found && result.total_found > result.hotels.length
                  ? `${result.hotels.length} of ${result.total_found} hotels`
                  : `${result.hotels.length} hotels`}{" "}
                in {city}
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
            <div className="panel checkout-panel">
              <div className="checkout-head">
                <div>
                  <p className="eyebrow">GUEST DETAILS</p>
                  <h3>
                    {city} stay · {adults} {adults === 1 ? "adult" : "adults"}
                  </h3>
                  <p>
                    {prebook.prebook.checkin} → {prebook.prebook.checkout} ·{" "}
                    {nights} {nights === 1 ? "night" : "nights"}
                  </p>
                </div>
                <div className="checkout-price">
                  <span>Total</span>
                  <strong>{money(prebook.prebook.total)}</strong>
                </div>
              </div>
              <div className="search-bar checkout">
                <SearchField label="First name">
                  <input
                    autoComplete="given-name"
                    onChange={(event) => setHolderFirstName(event.target.value)}
                    value={holderFirstName}
                  />
                </SearchField>
                <SearchField label="Last name">
                  <input
                    autoComplete="family-name"
                    onChange={(event) => setHolderLastName(event.target.value)}
                    value={holderLastName}
                  />
                </SearchField>
                <SearchField label="Email">
                  <input
                    autoComplete="email"
                    onChange={(event) => setHolderEmail(event.target.value)}
                    type="email"
                    value={holderEmail}
                  />
                </SearchField>
                <SearchField hint="digits only, no +" label="Phone">
                  <input
                    autoComplete="tel-national"
                    inputMode="tel"
                    onChange={(event) => setHolderPhone(event.target.value)}
                    value={holderPhone}
                  />
                </SearchField>
              </div>
              <div className="checkout-actions">
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
                    The sandbox card pays {currency}. No real card is charged.
                  </p>
                )}
              </div>
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
                tripId={activeTripId ?? ""}
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
            <div className="result-list">
              {result.hotels.map((entry) => (
                <HotelRow
                  hotel={entry}
                  nights={nights}
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
