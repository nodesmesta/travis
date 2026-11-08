"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiClientError, simulatePayment } from "../../lib/api";
import {
  prebookHotel,
  bookHotel,
  cityBelongsToCountry,
  getHotelDetails,
  getHotelRoomOptions,
  listCountries,
  searchHotels,
  type PlaceCountry,
  type HotelContent,
  type HotelOffer,
  type HotelPrebookAttempt,
  type HotelRateGroup,
  type HotelReview,
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
  CITIES,
  COUNTRIES,
  CURRENCIES,
  countryLabel,
  guessCity,
  guessCountryCode,
  nightsBetween,
} from "./places-options";
import { CityPicker } from "./city-picker";
import { DateRangePopover } from "./date-popover";
import {
  HotelFacts,
  PhotoSheet,
  RoomFactsInline,
  RoomPhotos,
} from "./hotel-facts";
import { GuestStepper, SearchField } from "./search-fields";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
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

interface SearchQuery {
  city: string;
  country_code: string;
  checkin: string;
  checkout: string;
  adults: number;
  currency: string;
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
  onOpen,
}: {
  hotel: HotelSearchResponse["hotels"][number];
  nights: number;
  onOpen: () => void;
}) {
  const { hotel: details, cheapest, offers } = hotel;
  return (
    <article className="result-row">
      {/* The whole card opens the hotel, like the photo and name do on a travel site. */}
      <button
        aria-label={`Open ${details.name}`}
        className="result-open"
        onClick={onOpen}
        type="button"
      />
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
          <span>⌖</span> {details.address ?? details.city ?? "Location unavailable"}
        </p>
        <p className="event-meta">
          <span>▣</span> {cheapest.room_name} ·{" "}
          {offers.length === 1 ? "1 room" : `${offers.length} rooms`}
        </p>
        <div className="result-tags">
          {details.rating ? (
            <span>
              Rating {details.rating}
              {details.review_count ? ` · ${details.review_count} reviews` : ""}
            </span>
          ) : null}
          {cheapest.board_name ? <span>{cheapest.board_name}</span> : null}
          {cheapest.refundable === "refundable" ? (
            <span>Refundable</span>
          ) : null}
        </div>
      </div>
      <div className="result-price">
        <span className="result-price-label">
          {nights > 1 ? `From · ${nights} nights` : "From"}
        </span>
        <strong>{money(cheapest.total)}</strong>
        <span className="button secondary wide">View rooms</span>
      </div>
    </article>
  );
}

/** The provider's deadline string (`2026-11-29 10:00:00`) in readable form. */
function policyDate(value: string): string {
  const [date, time] = value.split(" ");
  if (!date) return value;
  const [year, month, day] = date.split("-");
  const label = `${Number(day)} ${MONTH_NAMES[Number(month) - 1] ?? month}`;
  return time ? `${label} ${year}, ${time.slice(0, 5)}` : `${label} ${year}`;
}

function cancellationLine(offer: HotelOffer): string {
  if (offer.refundable === "non_refundable") return "Non-refundable";
  if (offer.free_cancellation_until)
    return `Free cancellation until ${policyDate(offer.free_cancellation_until)}`;
  const steps = offer.cancellation.steps ?? [];
  const first = steps[0];
  if (first?.before)
    return `Cancel before ${policyDate(first.before)}${
      first.fee ? ` or pay ${money(first.fee)}` : ""
    }`;
  return offer.refundable === "refundable" ? "Refundable" : "See policy";
}

function refundLabel(offer: HotelOffer): string {
  if (offer.refundable === "refundable") {
    return offer.free_cancellation_until
      ? `Free cancellation until ${offer.free_cancellation_until.slice(0, 10)}`
      : "Refundable";
  }
  if (offer.refundable === "non_refundable") return "Non-refundable";
  return "Cancellation policy unavailable";
}

/**
 * The hotel page: the photo and details from the result, then every room sold for
 * the stay so the traveller picks the rate here rather than in the list.
 */
export function HotelDetail({
  entry,
  nights,
  checkin,
  checkout,
  adults,
  countryCode,
  currency,
  busy,
  prebookedOfferId,
  onBack,
  onReserve,
  loadDetails = getHotelDetails,
  loadRates = getHotelRoomOptions,
}: {
  entry: HotelSearchResponse["hotels"][number];
  nights: number;
  checkin: string;
  checkout: string;
  adults: number;
  countryCode: string;
  currency: string;
  busy: boolean;
  prebookedOfferId: string | null;
  onBack: () => void;
  onReserve: (offer: HotelOffer) => void;
  /** Previews replace the content call; production uses the API. */
  loadDetails?: (
    hotelId: string,
  ) => Promise<{ hotel: HotelContent; reviews: HotelReview[] }>;
  /** Previews replace the rate call; production uses the API. */
  loadRates?: typeof getHotelRoomOptions;
}) {
  const { hotel, offers } = entry;
  // The provider's content call is separate from the rate search: it holds the
  // description, photos, facilities, house rules, nearby places and reviews.
  const [content, setContent] = useState<HotelContent | null>(null);
  const [reviews, setReviews] = useState<HotelReview[]>([]);
  const [contentError, setContentError] = useState<string | null>(null);
  const [gallery, setGallery] = useState(false);
  // The search asks for a handful of rates per hotel; every room the provider
  // sells for these nights is fetched here, grouped by the room it belongs to.
  const [groups, setGroups] = useState<HotelRateGroup[] | null>(null);
  const [rateCount, setRateCount] = useState(0);
  const [rateError, setRateError] = useState<string | null>(null);
  // Held in a ref: a caller passing an inline loader must not restart the fetch
  // on every render.
  const loadRatesRef = useRef(loadRates);
  loadRatesRef.current = loadRates;

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setReviews([]);
    setContentError(null);
    loadDetails(hotel.hotel_id)
      .then((result) => {
        if (cancelled) return;
        setContent(result.hotel);
        setReviews(result.reviews);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setContentError(
          caught instanceof ApiClientError
            ? caught.message
            : "Hotel details are unavailable right now.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [hotel.hotel_id, loadDetails]);

  useEffect(() => {
    let cancelled = false;
    setGroups(null);
    setRateCount(0);
    setRateError(null);
    // Without both dates and the city the provider cannot price anything; the
    // rates from the search stand in instead.
    if (!checkin || !checkout || !hotel.city) return;
    loadRatesRef.current(hotel.hotel_id, {
      city: hotel.city ?? "",
      country: countryCode,
      checkin,
      checkout,
      adults,
      currency,
    })
      .then((result) => {
        if (cancelled) return;
        setGroups(result.groups);
        setRateCount(result.offer_count);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setRateError(
          caught instanceof ApiClientError
            ? caught.message
            : "The rooms for these nights could not be loaded.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [hotel.hotel_id, hotel.city, countryCode, checkin, checkout, adults, currency]);

  return (
    <section className="detail-page">
      <button className="button ghost detail-back" onClick={onBack} type="button">
        ← Back to results
      </button>
      <div className="detail-hero">
        <button
          className="detail-photo"
          onClick={() => {
            if (content) setGallery(true);
          }}
          type="button"
        >
          {hotel.photo_url ? (
            <img alt={hotel.name} src={hotel.photo_url} />
          ) : (
            <span aria-hidden="true" className="result-media-fallback">
              {hotel.name.slice(0, 1)}
            </span>
          )}
          {content ? (
            <span className="detail-photo-badge">
              {content.images.length} photos
            </span>
          ) : null}
        </button>
        <div className="detail-info">
          <div className="result-title">
            <h2>{hotel.name}</h2>
            {hotel.stars ? (
              <span className="tag sage">{hotel.stars} stars</span>
            ) : null}
          </div>
          <p className="event-meta">
            <span>⌖</span> {hotel.address ?? hotel.city ?? "Location unavailable"}
          </p>
          <p className="event-meta">
            <span>▦</span> {checkin} → {checkout} · {nights}{" "}
            {nights === 1 ? "night" : "nights"} · {adults}{" "}
            {adults === 1 ? "adult" : "adults"}
          </p>
          {hotel.rating ? (
            <p className="event-meta">
              <span>★</span> Rating {hotel.rating}
              {hotel.review_count
                ? ` · ${hotel.review_count} reviews`
                : ""}
            </p>
          ) : null}
          {content?.checkin_from || content?.checkout_until ? (
            <p className="event-meta">
              <span>◷</span> Check-in {content?.checkin_from ?? "—"} · check-out{" "}
              {content?.checkout_until ?? "—"}
            </p>
          ) : null}
          {content?.policies.length ? (
            <p className="event-meta">
              <span>⚑</span> {content.policies.join(" · ")}
            </p>
          ) : null}
        </div>
      </div>
      {contentError ? (
        <p className="helper-text" role="status">
          {contentError}
        </p>
      ) : null}
      <HotelFacts
        content={content}
        openGallery={() => setGallery(true)}
        reviews={reviews}
      />
      <h3 className="detail-subhead">
        {groups && groups.length > 0
          ? `Choose a room · ${rateCount} ${
              rateCount === 1 ? "rate" : "rates"
            } in ${groups.length} ${groups.length === 1 ? "room" : "rooms"} for these nights`
          : !checkin || !checkout || !hotel.city || rateError
            ? `Choose a room · ${offers.length} ${
                offers.length === 1 ? "rate" : "rates"
              } from your search`
            : "Loading every room the provider sells…"}
      </h3>
      {rateError ? (
        <p className="helper-text" role="status">
          {rateError}
        </p>
      ) : null}
      {groups && groups.length > 0 ? (
        <div className="room-list">
          {groups.map((group) => (
            <article className="room-card" key={group.key}>
              <RoomPhotos
                name={group.name}
                photos={group.room?.photos ?? []}
              />
              <div className="room-body">
                <div className="result-title">
                  <h3>{group.name}</h3>
                  {group.offers[0]?.board_name ? (
                    <span className="tag indigo">
                      {group.offers[0].board_name}
                    </span>
                  ) : null}
                </div>
                <RoomFactsInline room={group.room} />
                <div className="room-offers">
                  {group.offers.map((offer) => {
                    const reserved = prebookedOfferId === offer.offer_id;
                    return (
                      <div className="room-offer" key={offer.offer_id}>
                        <div className="offer-terms">
                          <strong>{offer.board_name ?? "Room only"}</strong>
                          <span
                            className={`offer-cancel ${
                              offer.refundable === "non_refundable" ? "strict" : ""
                            }`}
                          >
                            {cancellationLine(offer)}
                          </span>
                          <span className="offer-meta">
                            {offer.max_occupancy !== null
                              ? `Sleeps ${offer.max_occupancy}`
                              : null}
                            {offer.children !== null && offer.children > 0
                              ? ` · ${offer.children} child`
                              : null}
                            {offer.supplier ? ` · via ${offer.supplier}` : ""}
                          </span>
                          {offer.perks.length > 0 ? (
                            <span className="chip-row">
                              {offer.perks.map((perk) => (
                                <span className="chip sage" key={perk}>
                                  {perk}
                                </span>
                              ))}
                            </span>
                          ) : null}
                        </div>
                        <div className="offer-buy">
                          <span className="result-price-label">
                            {nights > 1 ? `Total · ${nights} nights` : "Total"}
                          </span>
                          <strong>{money(offer.total)}</strong>
                          {offer.taxes_included !== null ? (
                            <span className="offer-meta">
                              incl. {money({
                                amount: offer.taxes_included,
                                currency: offer.total.currency,
                              })} taxes
                            </span>
                          ) : null}
                          <button
                            className={`button ${
                              reserved ? "secondary" : "accent"
                            } wide`}
                            disabled={busy || reserved}
                            onClick={() => onReserve(offer)}
                            type="button"
                          >
                            {reserved
                              ? "Rate reserved"
                              : busy
                                ? "Reserving…"
                                : "Reserve"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : null}
      {!groups || groups.length === 0 ? (
        // Until the full list arrives — or when it cannot be loaded — the rates from
        // the search are still bookable, so the room section is never empty.
        <div className="room-list">
          {offers.map((offer) => {
            const reserved = prebookedOfferId === offer.offer_id;
            return (
              <article className="result-row room" key={offer.offer_id}>
                <div className="result-body">
                  <div className="result-title">
                    <h3>{offer.room_name}</h3>
                    {offer.board_name ? (
                      <span className="tag indigo">{offer.board_name}</span>
                    ) : null}
                  </div>
                  <RoomFactsInline
                    room={
                      content?.rooms.find(
                        (room) => room.name === offer.room_name,
                      ) ?? null
                    }
                  />
                  <div className="result-tags">
                    <span>{refundLabel(offer)}</span>
                  </div>
                </div>
                <div className="result-price">
                  <span className="result-price-label">
                    {nights > 1 ? `Total · ${nights} nights` : "Total"}
                  </span>
                  <strong>{money(offer.total)}</strong>
                  <button
                    className={`button ${reserved ? "secondary" : "accent"} wide`}
                    disabled={busy || reserved}
                    onClick={() => onReserve(offer)}
                    type="button"
                  >
                    {reserved
                      ? "Rate reserved"
                      : busy
                        ? "Reserving…"
                        : "Reserve"}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      ) : null}
      {gallery && content ? (
        <PhotoSheet content={content} onClose={() => setGallery(false)} />
      ) : null}
    </section>
  );
}

export default function HotelsView({
  trip,
  onEnsureTrip,
  onOpenInvoices,
  onOpenTrips,
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
  /**
   * The dates, guests and city the shown results belong to. The form can be edited
   * while results stay on screen, so the room page must read this and not the form.
   */
  const [resultQuery, setResultQuery] = useState<SearchQuery | null>(null);
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
  const [detail, setDetail] = useState<
    HotelSearchResponse["hotels"][number] | null
  >(null);
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
    setDetail(null);
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
    setDetail(null);
    setPrebook(null);
    setBooked(null);
    setPrebookedOfferId(null);
    try {
      if (!(await cityMatchesCountry())) return;
      const tripId = await requireTrip();
      const query = {
        city,
        country_code: countryCode,
        checkin,
        checkout,
        adults,
        currency,
        guest_nationality: nationality,
        limit: 20,
      };
      setResult(await searchHotels(tripId, query));
      setResultQuery({
        city,
        country_code: countryCode,
        checkin,
        checkout,
        adults,
        currency,
      });
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  function openHotel(entry: HotelSearchResponse["hotels"][number]) {
    setDetail(entry);
    setPrebook(null);
    setBooked(null);
    setPrebookedOfferId(null);
    setError(null);
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
              pinned={CITIES.filter((item) => item.country === countryCode).map(
                (item) => item.name,
              )}
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
            plain
          >
            <DateRangePopover
              checkin={checkin}
              checkout={checkout}
              minIso={dateFromToday(0)}
              onChange={(next) => {
                setCheckin(next.checkin);
                setCheckout(next.checkout);
              }}
            />
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
                  onClick={onOpenInvoices}
                  type="button"
                >
                  Invoices
                </button>
                {onOpenTrips ? (
                  <button
                    className="button accent"
                    onClick={onOpenTrips}
                    type="button"
                  >
                    Open the trip
                  </button>
                ) : null}
              </div>
              <p className="helper-text">
                This stay is on your trip now and stays there until it is
                cancelled.
              </p>
            </div>
          ) : null}
          {detail ? (
            <HotelDetail
              adults={resultQuery?.adults ?? adults}
              busy={prebookingOffer !== null}
              checkin={resultQuery?.checkin ?? checkin}
              checkout={resultQuery?.checkout ?? checkout}
              countryCode={resultQuery?.country_code ?? countryCode}
              currency={resultQuery?.currency ?? currency}
              entry={detail}
              nights={nights}
              onBack={() => setDetail(null)}
              onReserve={(offer) => void reserve(offer)}
              prebookedOfferId={prebookedOfferId}
            />
          ) : null}
          {!detail && result.hotels.length === 0 ? (
            <div className="empty-state">
              <span className="panel-icon">⌕</span>
              <h3>No hotel rates found</h3>
              <p>Try another date range, city, or country.</p>
            </div>
          ) : null}
          {!detail && result.hotels.length > 0 ? (
            <div className="result-list">
              {result.hotels.map((entry) => (
                <HotelRow
                  hotel={entry}
                  nights={nights}
                  key={entry.cheapest.offer_id}
                  onOpen={() => openHotel(entry)}
                />
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
