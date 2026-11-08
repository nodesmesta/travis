"use client";

import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { ApiClientError, simulatePayment } from "../../lib/api";
import {
  attachFlightSeats,
  bookFlight,
  getFlightBooking,
  prebookFlight,
  searchFlights,
  type FlightBaggage,
  type FlightJourney,
  type FlightOffer,
  type FlightPrebookAttempt,
  type FlightSeat,
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
  onOpen,
}: {
  journey: FlightJourney;
  onOpen: () => void;
}) {
  const first = journey.segments[0];
  const last = journey.segments[journey.segments.length - 1];
  if (!first || !last) return null;
  const hours = Math.floor(journey.duration_minutes / 60);
  const minutes = journey.duration_minutes % 60;
  return (
    <article className="result-row flight">
      {/* The whole card opens the journey, the way a flight row does on an OTA. */}
      <button
        aria-label={`Open ${first.carrier_name} ${first.flight_number}`}
        className="result-open"
        onClick={onOpen}
        type="button"
      />
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
          {journey.cheapest.cabin ?? "Cabin unavailable"} ·{" "}
          {journey.offers.length === 1
            ? "1 fare"
            : `${journey.offers.length} fares`}
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
        <span className="result-price-label">From</span>
        <strong>{money(journey.cheapest.total)}</strong>
        <span className="button secondary wide">View fares</span>
      </div>
    </article>
  );
}

function baggageText(bag: FlightBaggage | null): string | null {
  if (!bag) return null;
  const parts = [
    bag.pieces !== null ? `${bag.pieces} ×` : null,
    bag.weight_kg !== null ? `${bag.weight_kg} kg` : null,
    bag.size,
  ].filter((value): value is string => value !== null && value.length > 0);
  if (parts.length === 0) return bag.description;
  return `${bag.description ?? "Bag"}: ${parts.join(" ")}`;
}

function seatHint(offer: FlightOffer): string | null {
  if (offer.seats_remaining === null) return null;
  if (offer.seats_remaining <= 0) return "Sold out at this fare";
  return offer.seats_remaining <= 5
    ? `Only ${offer.seats_remaining} seats left`
    : `${offer.seats_remaining} seats left`;
}

/**
 * The flight page: the itinerary the traveller picked, then every fare sold for
 * it. Choosing a fare here replaces the fare carried by the list card.
 */
export function FlightDetail({
  journey,
  date,
  fare,
  busy,
  onBack,
  onSelectFare,
}: {
  journey: FlightJourney;
  date: string;
  fare: FlightOffer | null;
  busy: boolean;
  onBack: () => void;
  onSelectFare: (offer: FlightOffer) => void;
}) {
  const first = journey.segments[0];
  const last = journey.segments[journey.segments.length - 1];
  if (!first || !last) return null;
  return (
    <section className="detail-page">
      <button className="button ghost detail-back" onClick={onBack} type="button">
        ← Back to results
      </button>
      <div className="detail-hero flight">
        <div className="detail-info">
          <div className="result-title">
            <h2>
              {first.origin_code} → {last.destination_code}
            </h2>
            <span className="tag coral">
              {journey.stops === 0 ? "Direct" : `${journey.stops} stop`}
            </span>
          </div>
          <p className="event-meta">
            <span>◷</span> {date} ·{" "}
            {Math.floor(journey.duration_minutes / 60)}h{" "}
            {journey.duration_minutes % 60}m total
            {journey.overnight ? " · overnight" : ""}
          </p>
          {first.operating_carrier_name &&
          first.operating_carrier_name !== first.carrier_name ? (
            <p className="event-meta">
              <span>✈</span> Operated by {first.operating_carrier_name}
            </p>
          ) : null}
          <ol className="segment-timeline">
            {journey.segments.map((segment) => (
              <li key={`${segment.flight_number}-${segment.departs_local}`}>
                <strong>
                  {segment.departs_local} {segment.origin_code}
                </strong>
                <span>
                  {segment.carrier_name} {segment.flight_number} ·{" "}
                  {Math.floor(segment.duration_minutes / 60)}h{" "}
                  {segment.duration_minutes % 60}m
                </span>
                <strong>
                  {segment.arrives_local} {segment.destination_code}
                </strong>
                <span className="segment-airport">
                  {segment.origin_name ?? segment.origin_code} →{" "}
                  {segment.destination_name ?? segment.destination_code}
                  {segment.operating_carrier_name &&
                  segment.operating_carrier_name !== segment.carrier_name
                    ? ` · operated by ${segment.operating_carrier_name}`
                    : ""}
                  {segment.stops_within_segment
                    ? ` · ${segment.stops_within_segment} technical stop(s)`
                    : ""}
                </span>
              </li>
            ))}
          </ol>
        </div>
      </div>
      <h3 className="detail-subhead">
        Choose a fare ·{" "}
        {journey.offers.length === 1
          ? "1 fare"
          : `${journey.offers.length} fares`}{" "}
        on this flight
      </h3>
      <div className="room-list">
        {journey.offers.map((offer) => {
          const chosen = fare?.offer_id === offer.offer_id;
          const soldOut = offer.seats_remaining !== null && offer.seats_remaining <= 0;
          return (
            <article className="result-row room" key={offer.offer_id}>
              <div className="result-body">
                <div className="result-title">
                  <h3>{offer.fare_family ?? offer.cabin ?? "Standard fare"}</h3>
                  <span className="tag indigo">
                    {offer.cabin ?? "Cabin unavailable"}
                  </span>
                </div>
                <div className="result-tags">
                  <span>
                    {offer.carry_on_included
                      ? "Carry-on included"
                      : "Carry-on unavailable"}
                  </span>
                  <span>
                    {offer.checked_bag_included
                      ? "Checked bag included"
                      : "Checked bag extra"}
                  </span>
                  {seatHint(offer) ? <span>{seatHint(offer)}</span> : null}
                  {offer.terms ? (
                    <span>
                      {offer.terms.refundable ? "Refundable" : "Non-refundable"}
                    </span>
                  ) : null}
                  {offer.terms?.changeable ? <span>Changes allowed</span> : null}
                </div>
                <details className="fare-facts">
                  <summary>Fare details</summary>
                  <ul>
                    {baggageText(offer.baggage.cabin) ? (
                      <li>{baggageText(offer.baggage.cabin)}</li>
                    ) : null}
                    {baggageText(offer.baggage.checked) ? (
                      <li>{baggageText(offer.baggage.checked)}</li>
                    ) : (
                      <li>No checked bag in this fare</li>
                    )}
                    {(offer.terms?.messages ?? []).map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                </details>
              </div>
              <div className="result-price">
                <span className="result-price-label">Total fare</span>
                <strong>{money(offer.total)}</strong>
                <button
                  className={`button ${chosen ? "secondary" : "accent"} wide`}
                  disabled={busy || soldOut || chosen}
                  onClick={() => onSelectFare(offer)}
                  type="button"
                >
                  {chosen ? "Fare selected" : soldOut ? "Sold out" : "Select fare"}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Seat picker built from the seats the carrier attached to the prebook. Only the
 * seats that are for sale are shown as taken; every button states its price.
 */
export function SeatMap({
  seats,
  chosen,
  busy,
  onChoose,
}: {
  seats: FlightSeat[];
  chosen: FlightSeat | null;
  busy: boolean;
  onChoose: (seat: FlightSeat) => void;
}) {
  const rows = Array.from(new Set(seats.map((seat) => seat.row))).sort(
    (a, b) => a - b,
  );
  const columns = Array.from(new Set(seats.map((seat) => seat.column))).sort();
  const byKey = new Map(
    seats.map((seat) => [`${seat.row}${seat.column}`, seat]),
  );
  return (
    <div className="seat-map">
      <div className="seat-map-head">
        <p className="eyebrow">SEATS · OPTIONAL</p>
        <p className="helper-text">
          {chosen
            ? `Seat ${chosen.seat_number} selected${
                chosen.price
                  ? ` · ${chosen.price.currency} ${chosen.price.amount}`
                  : " · no extra charge"
              }`
            : "Pick a seat, or pay without one and let the airline assign it."}
        </p>
      </div>
      <div
        className="seat-grid"
        style={{ gridTemplateColumns: `32px repeat(${columns.length}, 1fr)` }}
      >
        <span aria-hidden="true" />
        {columns.map((column) => (
          <span className="seat-column" key={`head-${column}`}>
            {column}
          </span>
        ))}
        {rows.map((row) => (
          <Fragment key={`row-${row}`}>
            <span className="seat-row">{row}</span>
            {columns.map((column) => {
              const seat = byKey.get(`${row}${column}`);
              if (!seat)
                return <span className="seat-gap" key={`${row}${column}`} />;
              const selected = chosen?.service_id === seat.service_id;
              return (
                <button
                  aria-label={`Seat ${seat.seat_number}${
                    seat.price
                      ? `, ${seat.price.currency} ${seat.price.amount}`
                      : ""
                  }`}
                  aria-pressed={selected}
                  className={`seat ${selected ? "selected" : ""} ${
                    seat.available ? "" : "taken"
                  } ${seat.kind === "extra_legroom" ? "legroom" : ""}`}
                  disabled={busy || !seat.available}
                  key={seat.service_id}
                  onClick={() => onChoose(seat)}
                  title={seat.position ?? seat.kind ?? undefined}
                  type="button"
                >
                  {seat.price ? seat.price.amount.toFixed(0) : ""}
                </button>
              );
            })}
          </Fragment>
        ))}
      </div>
      <p className="helper-text">
        Grey seats are unavailable. A number in the seat is the extra charge in{" "}
        {seats[0]?.price?.currency ?? "the fare currency"}.
      </p>
    </div>
  );
}

export default function FlightsView({
  trip,
  onEnsureTrip,
  onOpenInvoices,
  onOpenBookings,
  onOpenTrips,
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
  const [fare, setFare] = useState<FlightOffer | null>(null);
  const [prebook, setPrebook] = useState<FlightPrebookAttempt | null>(null);
  const [booked, setBooked] = useState<ProviderActionResponse | null>(null);
  const [seat, setSeat] = useState<FlightSeat | null>(null);
  const [seatTotal, setSeatTotal] = useState<{ amount: number; currency: string } | null>(null);
  const [seatBusy, setSeatBusy] = useState(false);
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
    setFare(null);
    setPrebook(null);
    setBooked(null);
    setSeat(null);
    setSeatTotal(null);
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
    setFare(null);
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

  /** Reserves the fare with the provider; paying and ticketing is a second step. */
  async function checkout() {
    if (!selected || !fare || passengerMissing.length > 0) return;
    setBusy(true);
    setError(null);
    setSeat(null);
    setSeatTotal(null);
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
        offer_id: fare.offer_id,
        purpose: "BUSINESS",
        contact: {
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          email: email.trim(),
          phone_country_code: "62",
          phone_number: phone.trim(),
        },
        passengers: [passenger],
        // The itinerary the traveller picked, so the trip can show the real times.
        schedule: {
          segments: selected.segments.map((segment) => ({
            origin_code: segment.origin_code,
            origin_name: segment.origin_name,
            destination_code: segment.destination_code,
            destination_name: segment.destination_name,
            departs_at: segment.departs_local,
            arrives_at: segment.arrives_local,
            carrier_name: segment.carrier_name,
            flight_number: segment.flight_number,
          })),
        },
      });
      setPrebook(next);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  /** Attaches the chosen seat to the prebook; the total moves with it. */
  async function chooseSeat(next: FlightSeat) {
    if (!prebook || seatBusy) return;
    setSeatBusy(true);
    setError(null);
    try {
      const attached = await attachFlightSeats(
        activeTripId ?? "",
        prebook.provider_booking.id,
        [{ passenger_index: 0, service_id: next.service_id }],
      );
      setSeat(next);
      setSeatTotal(attached.total);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setSeatBusy(false);
    }
  }

  /** Pays the local amount and asks the provider to ticket the prebook. */
  async function payAndBook() {
    if (!prebook || booked) return;
    setBusy(true);
    setError(null);
    try {
      const tripId = activeTripId ?? "";
      await simulatePayment(tripId, prebook.booking.id, "succeeded");
      const bookingResult = await bookFlight(tripId, prebook.provider_booking.id);
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
                  ? "STEP 2 · PICK A FARE"
                  : "STEP 1 · PICK A JOURNEY"}
              </p>
              <h2>{result.journeys.length} journeys shown</h2>
            </div>
            <span className="fresh-label">
              {result.total_found} found · {result.retrieved_at}
            </span>
          </div>
          {selected ? (
            <FlightDetail
              busy={busy}
              date={date}
              fare={fare}
              journey={selected}
              onBack={() => {
                setSelected(null);
                setFare(null);
                setPrebook(null);
                setBooked(null);
                pollToken.current += 1;
              }}
              onSelectFare={(offer) => {
                setFare(offer);
                setPrebook(null);
                setBooked(null);
                pollToken.current += 1;
              }}
            />
          ) : (
            <div className="result-list">
              {result.journeys.map((journey) => (
                <JourneyCard
                  key={journey.journey_key}
                  journey={journey}
                  onOpen={() => {
                    setSelected(journey);
                    // The fare is the traveller's choice, not a default.
                    setFare(null);
                    setPrebook(null);
                    setBooked(null);
                    pollToken.current += 1;
                  }}
                />
              ))}
            </div>
          )}
        </section>
      ) : null}
      {selected && fare ? (
        <section className="panel checkout-panel">
          <div className="checkout-head">
            <div>
              <p className="eyebrow">STEP 3 · PASSENGER DETAILS</p>
              <h3>
                {selected.segments[0]?.carrier_name ?? "Selected flight"} ·{" "}
                {selected.segments[0]?.origin_code} →{" "}
                {selected.segments[selected.segments.length - 1]?.destination_code}
                {" · "}
                {fare.fare_family ?? fare.cabin ?? "Standard fare"}
              </h3>
              <p>
                {date} · one adult · the provider requires a passport for this
                fare
              </p>
            </div>
            <div className="checkout-price">
              <span>{seatTotal || prebook ? "Total with seat" : "Total"}</span>
              <strong>
                {money(
                  seatTotal ?? prebook?.prebook.total ?? fare.total,
                )}
              </strong>
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
          {prebook && !booked && (prebook.prebook.seats?.length ?? 0) > 0 ? (
            <SeatMap
              busy={seatBusy || busy}
              chosen={seat}
              onChoose={(next) => void chooseSeat(next)}
              seats={prebook.prebook.seats ?? []}
            />
          ) : null}
          {prebook === null ? (
            <button
              className="button accent"
              disabled={busy || passengerMissing.length > 0}
              onClick={() => void checkout()}
              type="button"
            >
              {busy ? "Reserving this fare…" : "Reserve this fare"}
            </button>
          ) : booked ? (
            <button className="button secondary" disabled type="button">
              Sandbox payment completed
            </button>
          ) : (
            <button
              className="button accent"
              disabled={busy}
              onClick={() => void payAndBook()}
              type="button"
            >
              {busy
                ? "Paying and ticketing…"
                : `Pay ${money(seatTotal ?? prebook.prebook.total)} and book`}
            </button>
          )}
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
                This ticket is on your trip now and stays there until it is
                cancelled.
              </p>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
