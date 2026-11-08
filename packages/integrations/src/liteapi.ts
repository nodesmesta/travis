import { ExternalDataError } from "./errors.js";
import { allDigits, isAsciiUpper, isDigit, trimTrailing } from "./text.js";
import {
  asRecord,
  callProviderJson,
  finiteNumber,
  invalidResponse,
  missingConfiguration,
  nonBlankString,
  type ProviderJson,
} from "./provider-http.js";

export const LITEAPI_PROVIDER = "liteapi";
// Search and flights live on the API host; the booking-management endpoints are
// published on their own host in the provider's OpenAPI definitions.
const API_BASE_URL = "https://api.liteapi.travel/v3.0";
const BOOK_BASE_URL = "https://book.liteapi.travel/v3.0";

function usesBookingHost(path: string): boolean {
  return (
    path === "/rates/prebook" ||
    path === "/rates/book" ||
    path === "/rates/rebook" ||
    path.startsWith("/bookings")
  );
}

export interface LiteApiConfig {
  apiKey: string | undefined;
  timeoutMs?: number;
  /** Flight search answers are large (about 2 MB for one busy route). */
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
  /** Only the validation harness uses this, to serve documented response shapes. */
  baseUrl?: string;
  /** Booking-management host; defaults to the provider's published book host. */
  bookBaseUrl?: string;
}

// ---------------------------------------------------------------------------
// Normalized shapes. These are what the rest of the system sees; LiteAPI's own
// field names stop at this file.

export interface Money {
  amount: number;
  currency: string;
}

export interface FlightSegment {
  carrier_code: string;
  carrier_name: string;
  flight_number: string;
  origin_code: string;
  origin_name: string | null;
  destination_code: string;
  destination_name: string | null;
  /** Local wall-clock time at the airport, as the provider sent it. No offset. */
  departs_local: string;
  arrives_local: string;
  duration_minutes: number;
  /** Who actually flies the leg, when it differs from the seller. */
  operating_carrier_name: string | null;
  carrier_logo: string | null;
  stops_within_segment: number | null;
}

export interface FlightBaggage {
  description: string | null;
  pieces: number | null;
  weight_kg: number | null;
  size: string | null;
  /** What a bag of this kind costs when it is not in the fare. */
  price: Money | null;
}

export interface FlightFareTerms {
  changeable: boolean;
  refundable: boolean;
  /** The provider's own sentences, e.g. "Change fee: from 57.93 SGD". */
  messages: string[];
}

export interface FlightOffer {
  /** The provider's opaque id. Needed to prebook; valid only until `expires_at`. */
  offer_id: string;
  expires_at: string;
  total: Money;
  base: number;
  taxes: number;
  fees: number;
  cabin: string | null;
  fare_family: string | null;
  seats_remaining: number | null;
  carry_on_included: boolean;
  checked_bag_included: boolean;
  /** Refund and change rules as the carrier states them. */
  terms: FlightFareTerms | null;
  /** What the fare carries and what an extra bag costs. */
  baggage: {
    cabin: FlightBaggage | null;
    checked: FlightBaggage | null;
    /** The carrier's paid checked bag, when the fare does not include one. */
    paid_checked: FlightBaggage | null;
  };
}

export interface FlightJourney {
  journey_key: string;
  segments: FlightSegment[];
  stops: number;
  duration_minutes: number;
  /** True when the itinerary crosses a night, as the provider flags it. */
  overnight: boolean;
  /** Every fare on sale for this itinerary, cheapest first. `cheapest` is `offers[0]`. */
  offers: FlightOffer[];
  cheapest: FlightOffer;
}

export interface FlightSearchResult {
  journeys: FlightJourney[];
  /** How many the provider returned before `limit` was applied. */
  total_found: number;
  retrieved_at: string;
  provider_request_id: string | null;
}

export interface HotelStay {
  hotel_id: string;
  name: string;
  address: string | null;
  city: string | null;
  country_code: string | null;
  latitude: number | null;
  longitude: number | null;
  stars: number | null;
  rating: number | null;
  review_count: number | null;
  photo_url: string | null;
}

export interface HotelRoomContent {
  room_id: string;
  name: string;
  description: string | null;
  size_square: number | null;
  size_unit: string | null;
  max_adults: number | null;
  max_children: number | null;
  max_occupancy: number | null;
  bed_types: Array<{ quantity: number; bed_type: string }>;
  amenities: string[];
  photos: string[];
}

export interface HotelReview {
  review_id: string;
  score: number;
  date: string | null;
  country: string | null;
  traveller_type: string | null;
  name: string | null;
  headline: string | null;
  pros: string | null;
  cons: string | null;
  language: string | null;
}

export interface HotelContent {
  hotel_id: string;
  name: string;
  description: string | null;
  important_information: string | null;
  address: string | null;
  city: string | null;
  country_code: string | null;
  /** Where the hotel actually is, used when the trip records its location. */
  latitude: number | null;
  longitude: number | null;
  zip: string | null;
  stars: number | null;
  rating: number | null;
  review_count: number | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  chain: string | null;
  hotel_type: string | null;
  airport_code: string | null;
  currency: string | null;
  checkin_from: string | null;
  checkin_until: string | null;
  checkout_until: string | null;
  minimum_check_in_age: number | null;
  images: Array<{ url: string; caption: string | null }>;
  facilities: string[];
  policies: string[];
  nearby: Array<{
    name: string;
    category: string | null;
    distance_km: number | null;
    importance: string | null;
  }>;
  sentiment: { pros: string[]; cons: string[] };
  rooms: HotelRoomContent[];
}

/** One step of the provider's cancellation ladder. */
export interface HotelCancellationStep {
  /** The deadline, as the provider states it (`2026-11-29 10:00:00`, GMT). */
  before: string | null;
  /** What cancelling after that deadline costs. */
  fee: Money | null;
}

export interface HotelOffer {
  offer_id: string;
  room_name: string;
  board_name: string | null;
  total: Money;
  taxes_included: number | null;
  /** RFN refundable, NRFN non-refundable, as the provider reports it. */
  refundable: "refundable" | "non_refundable" | "unknown";
  free_cancellation_until: string | null;
  /** What the rate allows: people, extras, who sells it, how it is paid. */
  max_occupancy: number | null;
  adults: number | null;
  children: number | null;
  perks: string[];
  supplier: string | null;
  payment_types: string[];
  cancellation: {
    tag: string | null;
    steps: HotelCancellationStep[];
  };
}

export interface HotelRatesRequest {
  hotel_id: string;
  city: string;
  country_code: string;
  checkin: string;
  checkout: string;
  adults: number;
  currency: string;
  guest_nationality: string;
}

export interface HotelRatesResult {
  hotel: HotelStay | null;
  /** Every room the provider sells for these nights, cheapest first. */
  offers: HotelOffer[];
  retrieved_at: string;
  provider_request_id: string | null;
}

export interface HotelSearchResult {
  hotels: Array<{
    hotel: HotelStay;
    /** Every room and rate sold for the stay, cheapest first. `cheapest` is `offers[0]`. */
    offers: HotelOffer[];
    cheapest: HotelOffer;
  }>;
  /** How many bookable hotels the provider returned before the limit was applied. */
  total_found: number;
  retrieved_at: string;
  provider_request_id: string | null;
  sandbox: boolean;
}

// ---------------------------------------------------------------------------
// Small readers. They throw when a required field is missing or has the wrong
// type; nothing is guessed.

function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw invalidResponse(LITEAPI_PROVIDER, `LiteAPI response has no ${what}.`);
  }
  return value;
}

function money(value: unknown, what: string): Money {
  const record = asRecord(value);
  const amount = finiteNumber(record?.amount);
  const currency = nonBlankString(record?.currency);
  if (amount === null || currency === null || amount < 0) {
    throw invalidResponse(
      LITEAPI_PROVIDER,
      `LiteAPI response has an invalid ${what}.`,
    );
  }
  return { amount, currency };
}

function nonNegative(value: unknown, what: string): number {
  const number = finiteNumber(value);
  if (number === null || number < 0) {
    throw invalidResponse(LITEAPI_PROVIDER, `LiteAPI response has no ${what}.`);
  }
  return number;
}

function isoInstant(value: unknown, what: string): string {
  const text = nonBlankString(value);
  if (text === null || Number.isNaN(Date.parse(text))) {
    throw invalidResponse(LITEAPI_PROVIDER, `LiteAPI response has no ${what}.`);
  }
  return new Date(text).toISOString();
}

function array(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw invalidResponse(LITEAPI_PROVIDER, `LiteAPI response has no ${what}.`);
  }
  return value;
}

function localTime(value: unknown, what: string): string {
  const text = nonBlankString(value);
  // Local wall-clock time: `YYYY-MM-DDTHH:MM:SS`, no offset. Parse only to validate.
  if (text === null || Number.isNaN(Date.parse(`${text}Z`))) {
    throw invalidResponse(LITEAPI_PROVIDER, `LiteAPI response has no ${what}.`);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Booking shapes

export interface Person {
  first_name: string;
  last_name: string;
  email: string;
}

export interface HotelGuest extends Person {
  occupancy_number: number;
}

export interface HotelBookRequest {
  prebook_id: string;
  /** Our own id for this attempt. The provider refuses a second booking with the same one. */
  client_reference?: string;
  holder: Person & { phone: string };
  guests: HotelGuest[];
}

export interface HotelPrebook {
  prebook_id: string;
  hotel_id: string;
  total: Money;
  checkin: string;
  checkout: string;
  /** The price moved since the search. 0 means it did not. */
  price_difference_percent: number;
  cancellation_changed: boolean;
  board_changed: boolean;
}

export type ProviderBookingState =
  "confirmed" | "pending" | "cancelled" | "failed" | "unknown";

export interface HotelBooking {
  booking_id: string;
  state: ProviderBookingState;
  /** The provider's own status word, kept for support and for states we do not know. */
  provider_status: string;
  confirmation_code: string | null;
  hotel_id: string | null;
  hotel_name: string | null;
  checkin: string;
  checkout: string;
  total: Money;
  free_cancellation_until: string | null;
  sandbox: boolean;
}

export interface HotelCancellation {
  booking_id: string;
  state: ProviderBookingState;
  fee: Money;
  refund: Money;
}

export type FlightPassengerType = "adult" | "child" | "infant";

export interface FlightPassenger {
  type: FlightPassengerType;
  title: "MR" | "MS" | "MRS" | "MISS";
  first_name: string;
  last_name: string;
  /** `YYYY-MM-DD` */
  birthday: string;
  gender: "M" | "F";
  nationality: string;
  document?: {
    type: "passport" | "id_card";
    number: string;
    issue_country: string;
    /** `YYYY-MM-DD` */
    expiry: string;
  };
}

export interface FlightPrebookRequest {
  offer_id: string;
  purpose: "BUSINESS" | "LEISURE";
  contact: Person & { phone_country_code: string; phone_number: string };
  passengers: FlightPassenger[];
}

export interface FlightSeat {
  service_id: string;
  /** `12C`, as the provider labels it. */
  seat_number: string;
  row: number;
  column: string;
  /** `window`, `middle`, `aisle`, when the provider states it. */
  position: string | null;
  /** `standard`, `extra_legroom`, `exit_row`. */
  kind: string | null;
  available: boolean;
  /** What the seat costs on top of the fare, when the carrier charges for it. */
  price: Money | null;
  segment_key: string;
}

export interface FlightPrebook {
  prebook_id: string;
  total: Money;
  /** Seats the carrier lets this passenger pick before ticketing. */
  seats: FlightSeat[];
}

/** `POST /flights/verify`: the price the provider will honour right before booking. */
export interface FlightOfferVerification {
  offer_id: string;
  journey_key: string;
  total: Money;
  /** True when the provider reported a price or fare change since the search. */
  changed: boolean;
  messages: string[];
  verified_at: string;
}

export interface FlightBooking {
  booking_id: string;
  /** The airline's reference. Present once ticketing has run. */
  booking_reference: string | null;
  state: ProviderBookingState;
  provider_status: string;
  total: Money;
  ticket_deadline: string | null;
  /** Passengers as the provider holds them. The document number is never carried. */
  passengers: Array<{
    first_name: string;
    last_name: string;
    document_last4: string | null;
  }>;
}

export interface FlightCancellationQuote {
  refund: Money;
  penalty: Money;
  refundable: boolean;
  /** `exact` or `estimated`, as the provider labels it. */
  confidence: string | null;
}

export interface FlightCancellation {
  booking_id: string;
  /** Accepted means requested, not done. Read the booking again later. */
  accepted: true;
  fee: Money;
  refund: Money;
}

// ---------------------------------------------------------------------------
// Request validation. Bad input is refused before any request is made.

/** Exactly `length` ASCII capital letters. No regular expressions in this repository. */
function isUpperCode(value: string, length: number): boolean {
  if (value.length !== length) return false;
  for (const char of value) if (!isAsciiUpper(char)) return false;
  return true;
}

/** `YYYY-MM-DD`: digits and dashes in the right places. */
function isIsoDateShape(value: string): boolean {
  if (value.length !== 10) return false;
  for (let index = 0; index < 10; index++) {
    const char = value[index];
    if (index === 4 || index === 7) {
      if (char !== "-") return false;
    } else if (!isDigit(char)) {
      return false;
    }
  }
  return true;
}

function queryInvalid(message: string): ExternalDataError {
  return new ExternalDataError(
    "EXTERNAL_QUERY_INVALID",
    LITEAPI_PROVIDER,
    message,
    422,
  );
}

function assertDate(value: string, field: string): void {
  // `Date` rolls an impossible day (2026-02-30) forward to a real one instead of
  // refusing it. Accept only a date that survives the round trip unchanged.
  const parsed = isIsoDateShape(value) ? new Date(`${value}T00:00:00Z`) : null;
  if (
    parsed === null ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw queryInvalid(`${field} must be a real date like 2026-12-12.`);
  }
}

function assertPerson(
  person: Person,
  field: string,
): {
  firstName: string;
  lastName: string;
  email: string;
} {
  const firstName = nonBlankString(person.first_name);
  const lastName = nonBlankString(person.last_name);
  const email = nonBlankString(person.email);
  if (firstName === null || lastName === null) {
    throw queryInvalid(`${field} needs a first and a last name.`);
  }
  // A shape check only: one @ with text on both sides and a dot in the domain.
  const at = email?.indexOf("@") ?? -1;
  if (
    email === null ||
    at < 1 ||
    email.indexOf("@", at + 1) !== -1 ||
    email.indexOf(".", at) === -1 ||
    email.endsWith(".")
  ) {
    throw queryInvalid(`${field} needs a valid email address.`);
  }
  return { firstName, lastName, email };
}

function assertPhone(countryCode: string, number: string): void {
  if (
    countryCode.length < 1 ||
    countryCode.length > 4 ||
    !allDigits(countryCode) ||
    number.length < 5 ||
    number.length > 15 ||
    !allDigits(number)
  ) {
    throw queryInvalid(
      "phone needs a country code and a number, digits only, without +.",
    );
  }
}

function assertProviderId(value: string, what: string): void {
  if (nonBlankString(value) === null || value.length > 80) {
    throw queryInvalid(`${what} is required.`);
  }
}

function flightPassengerBody(
  passenger: FlightPassenger,
  index: number,
): Record<string, unknown> {
  const field = `passengers[${index}]`;
  const names = assertPerson(
    {
      first_name: passenger.first_name,
      last_name: passenger.last_name,
      email: "x@x.x",
    },
    field,
  );
  assertDate(passenger.birthday, `${field}.birthday`);
  if (!isUpperCode(passenger.nationality, 2)) {
    throw queryInvalid(`${field}.nationality must be a 2-letter code.`);
  }
  const passengerType =
    passenger.type === "adult" ? 0 : passenger.type === "child" ? 1 : 2;
  const body: Record<string, unknown> = {
    type:
      passenger.type === "adult"
        ? "ADT"
        : passenger.type === "child"
          ? "CHD"
          : "INF",
    passengerType,
    title: passenger.title,
    firstName: names.firstName,
    lastName: names.lastName,
    birthday: passenger.birthday,
    dateOfBirth: passenger.birthday,
    gender: passenger.gender,
    nationality: passenger.nationality,
  };
  if (passenger.document) {
    assertDate(passenger.document.expiry, `${field}.document.expiry`);
    if (nonBlankString(passenger.document.number) === null) {
      throw queryInvalid(`${field}.document.number is required.`);
    }
    if (!isUpperCode(passenger.document.issue_country, 2)) {
      throw queryInvalid(
        `${field}.document.issue_country must be a 2-letter code.`,
      );
    }
    body.documentType = passenger.document.type;
    body.documentNumber = passenger.document.number.trim();
    body.documentIssueCountry = passenger.document.issue_country;
    body.documentExpiry = passenger.document.expiry;
  }
  return body;
}

export interface FlightSearchRequest {
  origin: string;
  destination: string;
  date: string;
  adults: number;
  currency: string;
  /** Keep only the cheapest N journeys. LiteAPI returns up to a few hundred. */
  limit?: number;
}

export interface HotelSearchRequest {
  city: string;
  country_code: string;
  checkin: string;
  checkout: string;
  adults: number;
  currency: string;
  guest_nationality: string;
  limit?: number;
}

export interface LiteCountry {
  code: string;
  name: string;
}

/** One airport the flight search accepts as an origin or destination. */
export interface LiteAirport {
  iata: string;
  icao: string | null;
  name: string;
  city: string;
  country: string;
  state: string | null;
  lat: number | null;
  lon: number | null;
  timezone: string | null;
  /** False for city aggregates such as "Jakarta - All Airports". */
  has_airline_service: boolean;
}

/**
 * `GET /data/flights/airports?q=`: the provider only answers a text query, so a
 * country is looked up by its name and the results are filtered to that country.
 */
export function normalizeAirports(result: ProviderJson): LiteAirport[] {
  const root = asRecord(result.json);
  const airports: LiteAirport[] = [];
  const seen = new Set<string>();
  for (const entry of array(root?.data, "data")) {
    const group = asRecord(entry);
    for (const item of Array.isArray(group?.airports) ? group.airports : []) {
      const row = asRecord(item);
      const iata = nonBlankString(row?.iata)?.toUpperCase();
      const name = nonBlankString(row?.name);
      if (!iata || !name || iata.length !== 3 || seen.has(iata)) continue;
      seen.add(iata);
      airports.push({
        iata,
        icao: nonBlankString(row?.icao)?.toUpperCase() ?? null,
        name,
        city: nonBlankString(row?.city) ?? "",
        country: nonBlankString(row?.country)?.toUpperCase() ?? "",
        state: nonBlankString(row?.state) ?? null,
        lat: finiteNumber(row?.lat),
        lon: finiteNumber(row?.lon),
        timezone: nonBlankString(row?.tz) ?? null,
        has_airline_service: row?.hasAirlineService !== false,
      });
    }
  }
  return airports;
}

/** `GET /data/countries`: the countries that have hotel inventory. */
export function normalizeCountries(result: ProviderJson): LiteCountry[] {
  const root = asRecord(result.json);
  const countries: LiteCountry[] = [];
  const seen = new Set<string>();
  for (const entry of array(root?.data, "data")) {
    const row = asRecord(entry);
    const name = nonBlankString(row?.name);
    const code = nonBlankString(row?.code)?.toUpperCase();
    if (!name || !code || !isUpperCode(code, 2) || seen.has(code)) continue;
    seen.add(code);
    countries.push({ code, name });
  }
  countries.sort((left, right) => left.name.localeCompare(right.name));
  return countries;
}

/** `GET /data/cities`: city names are the exact strings the rate search expects. */
export function normalizeCities(result: ProviderJson): string[] {
  const root = asRecord(result.json);
  const cities: string[] = [];
  const seen = new Set<string>();
  for (const entry of array(root?.data, "data")) {
    const name = nonBlankString(asRecord(entry)?.city);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cities.push(name);
  }
  return cities;
}

/**
 * LiteAPI (Nuitee Connect) for flights and hotels. Each method makes exactly one
 * request. A missing key, a timeout, or any provider error is thrown as an
 * ExternalDataError; nothing is retried and no other provider is tried.
 */
export class LiteApiClient {
  public readonly provider = LITEAPI_PROVIDER;

  public constructor(private readonly config: LiteApiConfig) {}

  public get configured(): boolean {
    return Boolean(this.config.apiKey);
  }

  /**
   * Only calls that cannot create or cancel a reservation are repeated. Rate
   * searches, verify, reads and cancels quotes are safe; prebook, book and
   * cancel are not, so they get exactly one attempt.
   */
  private retriesFor(method: "GET" | "POST" | "PUT", path: string): number {
    if (method === "GET") return 2;
    const safeToRepeat =
      path === "/hotels/rates" ||
      path === "/flights/rates" ||
      path === "/flights/verify";
    return safeToRepeat ? 2 : 0;
  }

  private async request(
    method: "GET" | "POST" | "PUT",
    path: string,
    label: string,
    body?: unknown,
  ): Promise<ProviderJson> {
    if (!this.config.apiKey) {
      throw missingConfiguration(LITEAPI_PROVIDER, "LiteAPI");
    }
    const base = usesBookingHost(path)
      ? (this.config.bookBaseUrl ?? BOOK_BASE_URL)
      : (this.config.baseUrl ?? API_BASE_URL);
    return callProviderJson({
      provider: LITEAPI_PROVIDER,
      label,
      url: new URL(`${trimTrailing(base, "/")}${path}`),
      method,
      headers: { "x-api-key": this.config.apiKey },
      ...(body === undefined ? {} : { body }),
      timeoutMs: this.config.timeoutMs ?? 30_000,
      maxResponseBytes: this.config.maxResponseBytes ?? 6_000_000,
      fetchImpl: this.config.fetchImpl ?? fetch,
      // The key travels in a header, so there is no query parameter to strip.
      keyParam: "x-api-key",
      exposeClientErrors: true,
      retries: this.retriesFor(method, path),
    });
  }

  /** `GET /data/countries`: every country the provider sells hotels in. */
  public async listCountries(): Promise<LiteCountry[]> {
    const result = await this.request(
      "GET",
      "/data/countries",
      "LiteAPI countries",
    );
    return normalizeCountries(result);
  }

  /** `GET /data/flights/airports?q=`: airports matching a city, country or code. */
  public async searchAirports(query: string): Promise<LiteAirport[]> {
    const text = query.trim();
    if (text.length < 2) {
      throw queryInvalid("q must be at least 2 characters.");
    }
    const result = await this.request(
      "GET",
      `/data/flights/airports?q=${encodeURIComponent(text)}`,
      "LiteAPI airports",
    );
    return normalizeAirports(result);
  }

  /** `GET /data/cities?countryCode=ID`: the cities with hotel inventory. */
  public async listCities(countryCode: string): Promise<string[]> {
    const code = countryCode.trim().toUpperCase();
    if (!isUpperCode(code, 2)) {
      throw queryInvalid("country_code must be a 2-letter code.");
    }
    const result = await this.request(
      "GET",
      `/data/cities?countryCode=${code}`,
      "LiteAPI cities",
    );
    return normalizeCities(result);
  }

  /** `POST /flights/rates`: one-way search, cheapest offer per journey. */
  public async searchFlights(
    request: FlightSearchRequest,
  ): Promise<FlightSearchResult> {
    const origin = request.origin.trim().toUpperCase();
    const destination = request.destination.trim().toUpperCase();
    if (!isUpperCode(origin, 3) || !isUpperCode(destination, 3)) {
      throw queryInvalid("origin and destination must be 3-letter IATA codes.");
    }
    if (origin === destination) {
      throw queryInvalid("origin and destination must differ.");
    }
    assertDate(request.date, "date");
    if (!Number.isInteger(request.adults) || request.adults < 1) {
      throw queryInvalid("adults must be at least 1.");
    }
    if (!isUpperCode(request.currency, 3)) {
      throw queryInvalid("currency must be a 3-letter code.");
    }
    const result = await this.request(
      "POST",
      "/flights/rates",
      "LiteAPI flights",
      {
        legs: [{ origin, destination, date: request.date }],
        adults: request.adults,
        currency: request.currency,
      },
    );
    return normalizeFlightSearch(result, request.limit);
  }

  /** `POST /hotels/rates`: availability and the cheapest rate per hotel in a city. */
  public async searchHotels(
    request: HotelSearchRequest,
  ): Promise<HotelSearchResult> {
    if (request.city.trim().length === 0) {
      throw queryInvalid("city is required.");
    }
    if (!isUpperCode(request.country_code, 2)) {
      throw queryInvalid("country_code must be a 2-letter code.");
    }
    assertDate(request.checkin, "checkin");
    assertDate(request.checkout, "checkout");
    if (Date.parse(request.checkout) <= Date.parse(request.checkin)) {
      throw queryInvalid("checkout must be after checkin.");
    }
    if (!Number.isInteger(request.adults) || request.adults < 1) {
      throw queryInvalid("adults must be at least 1.");
    }
    if (!isUpperCode(request.currency, 3)) {
      throw queryInvalid("currency must be a 3-letter code.");
    }
    if (!isUpperCode(request.guest_nationality, 2)) {
      throw queryInvalid("guest_nationality must be a 2-letter code.");
    }
    const limit = request.limit ?? 20;
    const result = await this.request(
      "POST",
      "/hotels/rates",
      "LiteAPI hotels",
      {
        cityName: request.city.trim(),
        countryCode: request.country_code,
        checkin: request.checkin,
        checkout: request.checkout,
        occupancies: [{ adults: request.adults }],
        currency: request.currency,
        guestNationality: request.guest_nationality,
        // More than one rate per hotel: the detail page lists rooms to choose from.
        maxRatesPerHotel: 5,
        timeout: 12,
      },
    );
    return normalizeHotelSearch(result, limit);
  }

  /** The requested hotel out of a rate search, with the provider's own counts. */
  private hotelRatesFrom(
    result: ProviderJson,
    hotelId: string,
  ): HotelRatesResult {
    const normalized = normalizeHotelSearch(result);
    const match = normalized.hotels.find(
      (entry) => entry.hotel.hotel_id === hotelId,
    );
    return {
      hotel: match?.hotel ?? null,
      offers: match?.offers ?? [],
      retrieved_at: normalized.retrieved_at,
      provider_request_id: normalized.provider_request_id,
    };
  }

  /**
   * `POST /hotels/rates` for one hotel with every rate it sells: the search only
   * asks for a handful per hotel, but the detail page has to show them all.
   */
  public async getHotelRates(
    request: HotelRatesRequest,
  ): Promise<HotelRatesResult> {
    if (request.hotel_id.trim().length === 0) {
      throw queryInvalid("hotel_id is required.");
    }
    if (request.city.trim().length === 0) {
      throw queryInvalid("city is required.");
    }
    if (!isUpperCode(request.country_code, 2)) {
      throw queryInvalid("country_code must be a 2-letter code.");
    }
    assertDate(request.checkin, "checkin");
    assertDate(request.checkout, "checkout");
    if (Date.parse(request.checkout) <= Date.parse(request.checkin)) {
      throw queryInvalid("checkout must be after checkin.");
    }
    if (!Number.isInteger(request.adults) || request.adults < 1) {
      throw queryInvalid("adults must be at least 1.");
    }
    if (!isUpperCode(request.currency, 3)) {
      throw queryInvalid("currency must be a 3-letter code.");
    }
    if (!isUpperCode(request.guest_nationality, 2)) {
      throw queryInvalid("guest_nationality must be a 2-letter code.");
    }
    const result = await this.request(
      "POST",
      "/hotels/rates",
      "LiteAPI hotel rates",
      {
        cityName: request.city,
        countryCode: request.country_code,
        checkin: request.checkin,
        checkout: request.checkout,
        occupancies: [{ adults: request.adults }],
        currency: request.currency,
        guestNationality: request.guest_nationality,
        // The provider caps rates per hotel; 50 is its practical ceiling.
        maxRatesPerHotel: 50,
        // Its response is capped in total, so asking for 50 hotels quietly drops
        // every hotel to 5 rates. At 20 hotels the full 50 rates survive, and the
        // hotel list the app shows is 20 entries, so the hotel is in there.
        limit: 20,
        timeout: 15,
      },
    );
    const found = this.hotelRatesFrom(result, request.hotel_id);
    if (found.hotel) return found;
    // Outside the first 20 the provider returns fewer rates per hotel, but a short
    // list still beats telling the traveller the room list is empty.
    const fallback = await this.request(
      "POST",
      "/hotels/rates",
      "LiteAPI hotel rates",
      {
        cityName: request.city,
        countryCode: request.country_code,
        checkin: request.checkin,
        checkout: request.checkout,
        occupancies: [{ adults: request.adults }],
        currency: request.currency,
        guestNationality: request.guest_nationality,
        maxRatesPerHotel: 50,
        limit: 50,
        timeout: 15,
      },
    );
    return this.hotelRatesFrom(fallback, request.hotel_id);
  }

  /** `GET /data/hotel`: everything the provider holds about one hotel. */
  public async getHotelContent(hotelId: string): Promise<HotelContent> {
    assertProviderId(hotelId, "hotel id");
    const result = await this.request(
      "GET",
      `/data/hotel?hotelId=${encodeURIComponent(hotelId)}`,
      "LiteAPI hotel content",
    );
    return normalizeHotelContent(result);
  }

  /** `GET /data/reviews`: what guests wrote about the hotel, newest first. */
  public async getHotelReviews(
    hotelId: string,
    limit = 10,
  ): Promise<HotelReview[]> {
    assertProviderId(hotelId, "hotel id");
    const capped = Math.min(Math.max(limit, 1), 50);
    const result = await this.request(
      "GET",
      `/data/reviews?hotelId=${encodeURIComponent(hotelId)}&limit=${capped}`,
      "LiteAPI hotel reviews",
    );
    return normalizeHotelReviews(result);
  }

  // -------------------------------------------------------------------------
  // Booking. The sandbox key pays with the hidden test card (`ACC_CREDIT_CARD`), so
  // nothing is charged. The customer-facing payment step is ours; see the dummy
  // payment flow. No card data ever reaches this class.

  /** `POST /rates/prebook`: reserves the price of one hotel offer for a short time. */
  public async prebookHotel(request: {
    offer_id: string;
  }): Promise<HotelPrebook> {
    if (nonBlankString(request.offer_id) === null) {
      throw queryInvalid("offer_id is required.");
    }
    const result = await this.request(
      "POST",
      "/rates/prebook",
      "LiteAPI hotel prebook",
      { offerId: request.offer_id, usePaymentSdk: false },
    );
    return normalizeHotelPrebook(result);
  }

  /** `POST /rates/book`: confirms a hotel prebook. */
  public async bookHotel(request: HotelBookRequest): Promise<HotelBooking> {
    const holder = assertPerson(request.holder, "holder");
    if (nonBlankString(request.holder.phone) === null) {
      throw queryInvalid("holder.phone is required.");
    }
    if (nonBlankString(request.prebook_id) === null) {
      throw queryInvalid("prebook_id is required.");
    }
    if (request.guests.length === 0) {
      throw queryInvalid("at least one guest is required.");
    }
    const guests = request.guests.map((guest, index) => ({
      occupancyNumber: guest.occupancy_number,
      ...assertPerson(guest, `guests[${index}]`),
    }));
    const result = await this.request(
      "POST",
      "/rates/book",
      "LiteAPI hotel booking",
      {
        prebookId: request.prebook_id,
        ...(request.client_reference
          ? { clientReference: request.client_reference }
          : {}),
        holder: { ...holder, phone: request.holder.phone.trim() },
        guests,
        payment: { method: "ACC_CREDIT_CARD" },
      },
    );
    return normalizeHotelBooking(result);
  }

  /** `GET /bookings/{id}`. */
  public async getHotelBooking(bookingId: string): Promise<HotelBooking> {
    assertProviderId(bookingId, "booking id");
    const result = await this.request(
      "GET",
      `/bookings/${encodeURIComponent(bookingId)}`,
      "LiteAPI hotel booking",
    );
    return normalizeHotelBooking(result);
  }

  /**
   * `GET /bookings?clientReference=...`: finds a booking created with our own
   * idempotency reference. Used when a book retry hits the provider's duplicate
   * code (4005) after the first attempt actually succeeded.
   */
  public async findHotelBookingByClientReference(
    clientReference: string,
  ): Promise<HotelBooking | null> {
    if (nonBlankString(clientReference) === null) {
      throw queryInvalid("client_reference is required.");
    }
    const query = `?clientReference=${encodeURIComponent(clientReference)}&timeout=10`;
    const result = await this.request(
      "GET",
      `/bookings${query}`,
      "LiteAPI hotel booking lookup",
    );
    const rows = asRecord(result.json)?.data;
    if (Array.isArray(rows) && rows.length === 0) return null;
    return normalizeHotelBooking(result);
  }

  /** `PUT /bookings/{id}`: cancels. The answer states the fee and the refund. */
  public async cancelHotelBooking(
    bookingId: string,
  ): Promise<HotelCancellation> {
    assertProviderId(bookingId, "booking id");
    const result = await this.request(
      "PUT",
      `/bookings/${encodeURIComponent(bookingId)}`,
      "LiteAPI hotel cancellation",
    );
    return normalizeHotelCancellation(result);
  }

  /**
   * `POST /flights/verify`: confirms the offer is still live and returns the
   * binding price. The provider asks for this before every prebook.
   */
  public async verifyFlight(offerId: string): Promise<FlightOfferVerification> {
    if (nonBlankString(offerId) === null) {
      throw queryInvalid("offer_id is required.");
    }
    const result = await this.request(
      "POST",
      "/flights/verify",
      "LiteAPI flight verification",
      { offerId },
    );
    return normalizeFlightVerification(result, offerId);
  }

  /**
   * `POST /flights/prebooks`. The airline decides what a passenger must provide,
   * and says so as a provider error (for example code 43002, a travel document is
   * required). That error is kept on `details.provider_error` for the form.
   */
  public async prebookFlight(
    request: FlightPrebookRequest,
  ): Promise<FlightPrebook> {
    if (nonBlankString(request.offer_id) === null) {
      throw queryInvalid("offer_id is required.");
    }
    const contact = assertPerson(request.contact, "contact");
    assertPhone(
      request.contact.phone_country_code,
      request.contact.phone_number,
    );
    if (request.passengers.length === 0) {
      throw queryInvalid("at least one passenger is required.");
    }
    const passengers = request.passengers.map(flightPassengerBody);
    const result = await this.request(
      "POST",
      "/flights/prebooks",
      "LiteAPI flight prebook",
      {
        offerId: request.offer_id,
        usePaymentSdk: false,
        travelPurpose: request.purpose,
        contact: {
          ...contact,
          phoneCountryCode: request.contact.phone_country_code,
          phoneNumber: request.contact.phone_number,
          phone: `+${request.contact.phone_country_code}${request.contact.phone_number}`,
        },
        passengers,
      },
    );
    return normalizeFlightPrebook(result);
  }

  /**
   * `POST /flights/prebooks/{id}/services`: attaches the seats the passenger picked.
   * The call replaces the previous selection wholesale, so send the full list.
   */
  public async attachFlightServices(request: {
    prebook_id: string;
    seats: Array<{ passenger_index: number; service_id: string }>;
  }): Promise<{ total: Money; seat_count: number }> {
    assertProviderId(request.prebook_id, "prebook id");
    const selectedServices = request.seats.map((seat, index) => {
      if (!Number.isInteger(seat.passenger_index) || seat.passenger_index < 0) {
        throw queryInvalid(
          `seats[${index}].passenger_index must be a non-negative integer.`,
        );
      }
      if (nonBlankString(seat.service_id) === null) {
        throw queryInvalid(`seats[${index}].service_id is required.`);
      }
      return {
        passengerIndex: seat.passenger_index,
        serviceId: seat.service_id,
        quantity: 1,
      };
    });
    const result = await this.request(
      "POST",
      `/flights/prebooks/${encodeURIComponent(request.prebook_id)}/services`,
      "LiteAPI flight services",
      { selectedServices },
    );
    const data = dataRecord(result, "flight services");
    return {
      total: moneyFrom(data.price, data.currency, "flight services price"),
      seat_count: selectedServices.length,
    };
  }

  /** `POST /flights/bookings`. Idempotent per prebook id on the provider side. */
  public async bookFlight(request: {
    prebook_id: string;
  }): Promise<FlightBooking> {
    assertProviderId(request.prebook_id, "prebook id");
    const result = await this.request(
      "POST",
      "/flights/bookings",
      "LiteAPI flight booking",
      {
        prebookId: request.prebook_id,
        payment: { method: "ACC_CREDIT_CARD" },
      },
    );
    return normalizeFlightBooking(result);
  }

  /** `GET /flights/bookings/{id}`. Ticketing finishes after the booking call returns. */
  public async getFlightBooking(bookingId: string): Promise<FlightBooking> {
    assertProviderId(bookingId, "booking id");
    const result = await this.request(
      "GET",
      `/flights/bookings/${encodeURIComponent(bookingId)}`,
      "LiteAPI flight booking",
    );
    return normalizeFlightBooking(result);
  }

  /** `GET /flights/bookings/{id}/cancellations`: what a cancellation would cost. */
  public async quoteFlightCancellation(
    bookingId: string,
  ): Promise<FlightCancellationQuote> {
    assertProviderId(bookingId, "booking id");
    const result = await this.request(
      "GET",
      `/flights/bookings/${encodeURIComponent(bookingId)}/cancellations`,
      "LiteAPI flight cancellation quote",
    );
    return normalizeFlightCancellationQuote(result);
  }

  /**
   * `POST /flights/bookings/{id}/cancellations`. The provider accepts the request
   * (HTTP 202) and finishes later, so the booking state does not change at once.
   */
  public async cancelFlightBooking(
    bookingId: string,
  ): Promise<FlightCancellation> {
    assertProviderId(bookingId, "booking id");
    const result = await this.request(
      "POST",
      `/flights/bookings/${encodeURIComponent(bookingId)}/cancellations`,
      "LiteAPI flight cancellation",
      {},
    );
    return normalizeFlightCancellation(result);
  }
}

// ---------------------------------------------------------------------------
// Normalizers

export function normalizeFlightSearch(
  result: ProviderJson,
  limit?: number,
): FlightSearchResult {
  const root = asRecord(result.json);
  const first = asRecord(array(root?.data, "data")[0]);
  const journeys = array(first?.journeys, "journeys").map(normalizeJourney);
  journeys.sort((a, b) => a.cheapest.total.amount - b.cheapest.total.amount);
  return {
    journeys: limit === undefined ? journeys : journeys.slice(0, limit),
    total_found: journeys.length,
    retrieved_at: new Date().toISOString(),
    provider_request_id: result.providerRequestId,
  };
}

function normalizeJourney(value: unknown): FlightJourney {
  const journey = asRecord(value);
  const segmentsRaw = array(journey?.segments, "segments");
  if (segmentsRaw.length === 0) {
    throw invalidResponse(LITEAPI_PROVIDER, "LiteAPI journey has no segments.");
  }
  const segments = segmentsRaw.map(normalizeSegment);
  const total = asRecord(journey?.totalDuration);
  const legs = Array.isArray(journey?.legDurations) ? journey.legDurations : [];
  const overnight = legs.some(
    (leg) => asRecord(leg)?.overnightFlight === true,
  );
  const offers = flightOffers(journey);
  return {
    journey_key: required(nonBlankString(journey?.journeyKey), "journeyKey"),
    segments,
    stops: segments.length - 1,
    duration_minutes: nonNegative(total?.minutes, "journey duration"),
    overnight,
    offers,
    cheapest: offers[0] as FlightOffer,
  };
}

/**
 * Every fare the journey sells. The provider lists them under `offers`; older
 * payloads only carry `cheapestOffer`, and a malformed fare is dropped rather
 * than failing the whole search.
 */
function flightOffers(journey: Record<string, unknown> | null): FlightOffer[] {
  const seen = new Set<string>();
  const offers: FlightOffer[] = [];
  for (const entry of Array.isArray(journey?.offers) ? journey.offers : []) {
    let offer: FlightOffer;
    try {
      offer = normalizeFlightOffer(entry);
    } catch {
      continue;
    }
    if (seen.has(offer.offer_id)) continue;
    seen.add(offer.offer_id);
    offers.push(offer);
  }
  if (offers.length === 0) {
    const only = normalizeFlightOffer(journey?.cheapestOffer);
    offers.push(only);
  }
  offers.sort((a, b) => a.total.amount - b.total.amount);
  return offers;
}

function normalizeSegment(value: unknown): FlightSegment {
  const segment = asRecord(value);
  const carrier = asRecord(segment?.carrier);
  const flight = asRecord(segment?.flight);
  const duration = asRecord(segment?.duration);
  return {
    carrier_code: required(nonBlankString(carrier?.marketingCode), "carrier"),
    carrier_name: required(
      nonBlankString(carrier?.marketingName),
      "carrier name",
    ),
    flight_number: required(
      nonBlankString(flight?.marketingNumber),
      "flight number",
    ),
    origin_code: required(nonBlankString(segment?.originCode), "origin"),
    origin_name: nonBlankString(segment?.originName),
    destination_code: required(
      nonBlankString(segment?.destinationCode),
      "destination",
    ),
    destination_name: nonBlankString(segment?.destinationName),
    departs_local: localTime(segment?.departureTime, "departure time"),
    arrives_local: localTime(segment?.arrivalTime, "arrival time"),
    duration_minutes: nonNegative(duration?.minutes, "segment duration"),
    operating_carrier_name: nonBlankString(carrier?.operatingName),
    carrier_logo: nonBlankString(carrier?.marketingLogo),
    stops_within_segment: finiteNumber(segment?.stopCount),
  };
}

function normalizeFlightOffer(value: unknown): FlightOffer {
  const offer = asRecord(value);
  const display = asRecord(asRecord(offer?.pricing)?.display);
  const total = money(
    { amount: display?.total, currency: display?.currency },
    "offer price",
  );
  const baggage = asRecord(offer?.baggage);
  const terms = asRecord(offer?.terms);
  const fare = asRecord(offer?.fare);
  const fares = Array.isArray(offer?.segmentFares) ? offer.segmentFares : [];
  const firstFare = asRecord(fares[0]);
  return {
    offer_id: required(nonBlankString(offer?.offerId), "offerId"),
    expires_at: isoInstant(offer?.expiration, "offer expiration"),
    total,
    base: nonNegative(display?.base, "base price"),
    taxes: nonNegative(display?.taxes, "taxes"),
    fees: nonNegative(display?.fees, "fees"),
    cabin: nonBlankString(firstFare?.cabin),
    fare_family: nonBlankString(fare?.family),
    seats_remaining: finiteNumber(fare?.seatsRemaining),
    carry_on_included: baggage?.hasCarryOnBag === true,
    checked_bag_included: baggage?.hasCheckedBag === true,
    terms: fareTerms(terms),
    baggage: {
      cabin: baggageAllowance(baggage?.included, "cabin"),
      checked: baggageAllowance(baggage?.included, "checked"),
      paid_checked: baggageAllowance(baggage?.paid, "checked"),
    },
  };
}

function fareTerms(
  terms: Record<string, unknown> | null,
): FlightFareTerms | null {
  if (!terms) return null;
  const messages: string[] = [];
  for (const entry of Array.isArray(terms.summary) ? terms.summary : []) {
    const message = nonBlankString(asRecord(entry)?.message);
    if (message) messages.push(message);
  }
  return {
    changeable: terms.changeable === true,
    refundable: terms.refundable === true,
    messages,
  };
}

/** The first allowance of `kind` the fare carries, with its weight and size. */
function baggageAllowance(
  included: unknown,
  kind: "cabin" | "checked",
): FlightBaggage | null {
  for (const entry of Array.isArray(included) ? included : []) {
    const bag = asRecord(entry);
    if (nonBlankString(bag?.bagType)?.toLowerCase() !== kind) continue;
    return {
      description: nonBlankString(bag?.description),
      pieces: finiteNumber(bag?.pieces),
      weight_kg: finiteNumber(bag?.weightKg),
      size: nonBlankString(bag?.size),
      price: null,
    };
  }
  return null;
}

export function normalizeHotelSearch(
  result: ProviderJson,
  limit?: number,
): HotelSearchResult {
  const root = asRecord(result.json);
  const content = new Map<string, Record<string, unknown>>();
  for (const entry of Array.isArray(root?.hotels) ? root.hotels : []) {
    const hotel = asRecord(entry);
    const id = nonBlankString(hotel?.id);
    if (hotel && id) content.set(id, hotel);
  }
  const hotels: HotelSearchResult["hotels"] = [];
  for (const entry of array(root?.data, "data")) {
    const row = asRecord(entry);
    const hotelId = required(nonBlankString(row?.hotelId), "hotelId");
    const info = content.get(hotelId);
    // A price with no hotel details cannot be shown honestly. Skip it and say nothing.
    if (!info) continue;
    const offers = hotelOffers(row);
    if (offers.length === 0) continue;
    hotels.push({
      hotel: normalizeHotel(hotelId, info),
      offers,
      cheapest: offers[0] as HotelOffer,
    });
  }
  hotels.sort((a, b) => a.cheapest.total.amount - b.cheapest.total.amount);
  const totalFound = hotels.length;
  return {
    hotels: limit === undefined ? hotels : hotels.slice(0, limit),
    total_found: totalFound,
    retrieved_at: new Date().toISOString(),
    provider_request_id: result.providerRequestId,
    sandbox: root?.sandbox === true,
  };
}

function normalizeHotel(
  hotelId: string,
  info: Record<string, unknown>,
): HotelStay {
  return {
    hotel_id: hotelId,
    name: required(nonBlankString(info.name), "hotel name"),
    address: nonBlankString(info.address),
    city: nonBlankString(info.city_name) ?? nonBlankString(info.city),
    country_code: nonBlankString(info.country_code),
    latitude: finiteNumber(info.latitude),
    longitude: finiteNumber(info.longitude),
    stars: finiteNumber(info.stars),
    rating: finiteNumber(info.rating),
    review_count: finiteNumber(info.review_count),
    photo_url:
      nonBlankString(info.main_photo) ?? nonBlankString(info.thumbnail),
  };
}

function cancellationUntil(
  policy: Record<string, unknown> | null,
): string | null {
  const infos = Array.isArray(policy?.cancelPolicyInfos)
    ? policy.cancelPolicyInfos
    : [];
  const first = asRecord(infos[0]);
  const text = nonBlankString(first?.cancelTime);
  if (!text) return null;
  const normalized = text.includes("T") ? text : text.replace(" ", "T");
  const parsed = new Date(
    normalized.endsWith("Z") ? normalized : `${normalized}Z`,
  );
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Every room and rate sold for the stay, cheapest first. Each room type carries
 * the offer id the prebook step needs, so two rooms are two bookable options.
 */
/** Strings from a provider list, ignoring blank or non-string entries. */
function providerStrings(value: unknown): string[] {
  const out: string[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    if (typeof entry === "string" && entry.trim().length > 0) out.push(entry);
  }
  return out;
}

/** `cancellationPolicies.cancelPolicyInfos[]`, in the order sold. */
function cancellationSteps(
  policy: Record<string, unknown> | null,
): HotelCancellationStep[] {
  const steps: HotelCancellationStep[] = [];
  for (const entry of Array.isArray(policy?.cancelPolicyInfos)
    ? policy.cancelPolicyInfos
    : []) {
    const step = asRecord(entry);
    const before = nonBlankString(step?.cancelTime);
    const amount = finiteNumber(step?.amount);
    const currency = nonBlankString(step?.currency);
    steps.push({
      before,
      fee:
        amount !== null && currency
          ? { amount, currency }
          : null,
    });
  }
  return steps;
}

function hotelOffers(row: Record<string, unknown> | null): HotelOffer[] {
  const offers: HotelOffer[] = [];
  const seen = new Set<string>();
  for (const roomEntry of Array.isArray(row?.roomTypes) ? row.roomTypes : []) {
    const roomType = asRecord(roomEntry);
    const offerId = nonBlankString(roomType?.offerId);
    if (!offerId) continue;
    for (const rateEntry of Array.isArray(roomType?.rates)
      ? roomType.rates
      : []) {
      const rate = asRecord(rateEntry);
      const totals = Array.isArray(asRecord(rate?.retailRate)?.total)
        ? (asRecord(rate?.retailRate)?.total as unknown[])
        : [];
      if (totals.length === 0) continue;
      if (seen.has(offerId)) continue;
      seen.add(offerId);
      const total = money(totals[0], "room price");
      const policy = asRecord(rate?.cancellationPolicies);
      const tag = nonBlankString(policy?.refundableTag);
      const taxes = Array.isArray(asRecord(rate?.retailRate)?.taxesAndFees)
        ? (asRecord(rate?.retailRate)?.taxesAndFees as unknown[])
        : [];
      const includedTaxes = taxes
        .map(asRecord)
        .filter((tax) => tax?.included === true)
        .reduce((sum, tax) => sum + (finiteNumber(tax?.amount) ?? 0), 0);
      offers.push({
        offer_id: offerId,
        room_name: required(nonBlankString(rate?.name), "room name"),
        board_name: nonBlankString(rate?.boardName),
        total,
        taxes_included: taxes.length > 0 ? includedTaxes : null,
        refundable:
          tag === "RFN"
            ? "refundable"
            : tag === "NRFN"
              ? "non_refundable"
              : "unknown",
        free_cancellation_until: cancellationUntil(policy),
        max_occupancy: finiteNumber(rate?.maxOccupancy),
        adults: finiteNumber(rate?.adultCount),
        children: finiteNumber(rate?.childCount),
        perks: providerStrings(rate?.perks),
        supplier: nonBlankString(roomType?.supplier),
        payment_types: providerStrings(roomType?.paymentTypes),
        cancellation: {
          tag,
          steps: cancellationSteps(policy),
        },
      });
    }
  }
  offers.sort((a, b) => a.total.amount - b.total.amount);
  return offers;
}

// ---------------------------------------------------------------------------
// Booking normalizers

/**
 * Only states that were seen in the sandbox are mapped. Anything else is
 * "unknown" and the provider's own word is kept next to it, so a new state is
 * visible instead of being filed under a wrong one.
 */
export function bookingStateOf(status: string): ProviderBookingState {
  switch (status.toUpperCase()) {
    case "CONFIRMED":
    case "TICKETED":
    case "COMPLETED":
      return "confirmed";
    case "CREATED":
    case "PENDING":
    case "PENDING_CONFIRMATION":
      return "pending";
    case "CANCELLED":
    case "CANCELED":
    case "CANCELLED_WITH_CHARGES":
      return "cancelled";
    case "FAILED":
    case "REJECTED":
      return "failed";
    default:
      return "unknown";
  }
}

function dataRecord(
  result: ProviderJson,
  what: string,
): Record<string, unknown> {
  const data = asRecord(result.json)?.data;
  const record = Array.isArray(data) ? asRecord(data[0]) : asRecord(data);
  if (!record) {
    throw invalidResponse(LITEAPI_PROVIDER, `LiteAPI response has no ${what}.`);
  }
  return record;
}

function dateOnly(value: unknown, what: string): string {
  const text = nonBlankString(value);
  if (text === null || text.length < 10) {
    throw invalidResponse(LITEAPI_PROVIDER, `LiteAPI response has no ${what}.`);
  }
  return text.slice(0, 10);
}

function moneyFrom(amount: unknown, currency: unknown, what: string): Money {
  return money({ amount, currency }, what);
}

export function normalizeHotelPrebook(result: ProviderJson): HotelPrebook {
  const data = dataRecord(result, "prebook");
  return {
    prebook_id: required(nonBlankString(data.prebookId), "prebookId"),
    hotel_id: required(nonBlankString(data.hotelId), "hotelId"),
    total: moneyFrom(data.price, data.currency, "prebook price"),
    checkin: dateOnly(data.checkin, "check-in date"),
    checkout: dateOnly(data.checkout, "check-out date"),
    price_difference_percent: finiteNumber(data.priceDifferencePercent) ?? 0,
    cancellation_changed: data.cancellationChanged === true,
    board_changed: data.boardChanged === true,
  };
}

export function normalizeHotelBooking(result: ProviderJson): HotelBooking {
  const data = dataRecord(result, "booking");
  const hotel = asRecord(data.hotel);
  const status = required(nonBlankString(data.status), "booking status");
  const root = asRecord(result.json);
  const lastFree = nonBlankString(data.lastFreeCancellationDate);
  return {
    booking_id: required(nonBlankString(data.bookingId), "bookingId"),
    state: bookingStateOf(status),
    provider_status: status,
    confirmation_code: nonBlankString(data.hotelConfirmationCode),
    hotel_id: nonBlankString(hotel?.hotelId) ?? nonBlankString(data.hotelId),
    hotel_name: nonBlankString(hotel?.name) ?? nonBlankString(data.hotelName),
    checkin: dateOnly(data.checkin, "check-in date"),
    checkout: dateOnly(data.checkout, "check-out date"),
    total: moneyFrom(
      data.sellingPriceToUser ?? data.price,
      data.currency,
      "booking price",
    ),
    free_cancellation_until:
      lastFree !== null && !Number.isNaN(Date.parse(lastFree))
        ? new Date(lastFree).toISOString()
        : null,
    sandbox:
      root?.sandbox === true || data.sandbox === 1 || data.sandbox === true,
  };
}

export function normalizeHotelCancellation(
  result: ProviderJson,
): HotelCancellation {
  const data = dataRecord(result, "cancellation");
  const status = required(nonBlankString(data.status), "cancellation status");
  const currency = data.currency;
  return {
    booking_id: required(nonBlankString(data.bookingId), "bookingId"),
    state: bookingStateOf(status),
    fee: moneyFrom(data.cancellation_fee, currency, "cancellation fee"),
    refund: moneyFrom(data.refund_amount, currency, "refund amount"),
  };
}

export function normalizeFlightPrebook(result: ProviderJson): FlightPrebook {
  const data = dataRecord(result, "prebook");
  return {
    prebook_id: required(nonBlankString(data.prebookId), "prebookId"),
    total: moneyFrom(data.price, data.currency, "prebook price"),
    seats: flightSeats(data),
  };
}

/** Seat services from `servicesAttachable`; baggage and others are ignored here. */
function flightSeats(data: Record<string, unknown>): FlightSeat[] {
  const groups = asRecord(data.servicesAttachable)?.groups;
  const seats: FlightSeat[] = [];
  for (const groupEntry of Array.isArray(groups) ? groups : []) {
    const group = asRecord(groupEntry);
    if (nonBlankString(group?.category)?.toLowerCase() !== "seat") continue;
    for (const serviceEntry of Array.isArray(group?.services)
      ? group.services
      : []) {
      const service = asRecord(serviceEntry);
      const serviceId = nonBlankString(service?.serviceId);
      const seat = asRecord(asRecord(service?.metadata)?.seat);
      const name = nonBlankString(service?.name) ?? "";
      const row = finiteNumber(seat?.seatRow) ?? rowFromName(name);
      const column =
        nonBlankString(seat?.seatColumn) ?? columnFromName(name) ?? null;
      if (!serviceId || row === null || column === null) continue;
      const display = asRecord(asRecord(service?.pricing)?.display);
      const amount = finiteNumber(display?.amount);
      const currency = nonBlankString(display?.currency);
      seats.push({
        service_id: serviceId,
        seat_number:
          nonBlankString(seat?.seatNumber) ?? `${row}${column.toUpperCase()}`,
        row,
        column: column.toUpperCase(),
        position: nonBlankString(seat?.position),
        kind: nonBlankString(seat?.seatType),
        available: seat?.available !== false,
        price:
          amount !== null && amount > 0 && currency !== null
            ? { amount, currency }
            : null,
        segment_key: nonBlankString(service?.segmentKey) ?? "",
      });
    }
  }
  seats.sort(
    (a, b) => a.row - b.row || a.column.localeCompare(b.column),
  );
  return seats;
}

/** `Seat 12C` → 12, for carriers that send no seat metadata. */
function rowFromName(name: string): number | null {
  for (let index = 0; index < name.length; index += 1) {
    const char = name.charAt(index);
    if (char < "0" || char > "9") continue;
    const value = Number.parseInt(name.slice(index), 10);
    return Number.isNaN(value) ? null : value;
  }
  return null;
}

/** `Seat 12C` → `C`, for carriers that send no seat metadata. */
function columnFromName(name: string): string | null {
  const trimmed = name.trim();
  const last = trimmed.charAt(trimmed.length - 1);
  return last >= "A" && last <= "Z" ? last : null;
}

export function normalizeFlightVerification(
  result: ProviderJson,
  offerId: string,
): FlightOfferVerification {
  const entry = dataRecord(result, "verified journey");
  const journey = asRecord(entry.journey) ?? entry;
  const display = asRecord(asRecord(journey.pricing)?.display);
  const changes = asRecord(entry.changes);
  const messages = Array.isArray(changes?.messages)
    ? changes.messages.filter(
        (message): message is string =>
          typeof message === "string" && message.trim().length > 0,
      )
    : [];
  return {
    offer_id: offerId,
    journey_key: nonBlankString(journey.journeyKey) ?? "",
    total: moneyFrom(display?.total, display?.currency, "verified price"),
    changed: changes !== null,
    messages,
    verified_at: new Date().toISOString(),
  };
}

export function normalizeFlightBooking(result: ProviderJson): FlightBooking {
  const entry = dataRecord(result, "booking");
  // The create call wraps the record as `{ booking }`; the read call returns it directly.
  const data = asRecord(entry.booking) ?? entry;
  const status = required(nonBlankString(data.status), "booking status");
  const pricing = asRecord(data.pricing);
  const order = asRecord(data.order);
  const passengers = Array.isArray(data.passengers) ? data.passengers : [];
  return {
    booking_id: required(nonBlankString(data.bookingId), "bookingId"),
    booking_reference: nonBlankString(data.bookingRef),
    state: bookingStateOf(status),
    provider_status: status,
    total: moneyFrom(pricing?.totalAmount, pricing?.currency, "booking price"),
    ticket_deadline: (() => {
      const text =
        nonBlankString(data.ticketLimitTime) ??
        nonBlankString(order?.ticketLimitTime);
      return text !== null && !Number.isNaN(Date.parse(text))
        ? new Date(text).toISOString()
        : null;
    })(),
    passengers: passengers.map((entryPassenger) => {
      const passenger = asRecord(entryPassenger);
      const number = nonBlankString(passenger?.documentNumber);
      return {
        first_name: required(
          nonBlankString(passenger?.firstName),
          "passenger name",
        ),
        last_name: required(
          nonBlankString(passenger?.lastName),
          "passenger name",
        ),
        // Only the last four characters survive this function, never the number itself.
        document_last4: number === null ? null : number.slice(-4),
      };
    }),
  };
}

export function normalizeFlightCancellationQuote(
  result: ProviderJson,
): FlightCancellationQuote {
  const data = dataRecord(result, "cancellation quote");
  const refund = asRecord(asRecord(data.refund)?.display);
  const penalty = asRecord(asRecord(data.penalty)?.display);
  const tickets = Array.isArray(data.tickets) ? data.tickets : [];
  return {
    refund: moneyFrom(refund?.amount, refund?.currency, "refund amount"),
    penalty: moneyFrom(penalty?.amount, penalty?.currency, "penalty amount"),
    refundable:
      tickets.length > 0 &&
      tickets.every((ticket) => asRecord(ticket)?.isRefundable === true),
    confidence: nonBlankString(data.confidence),
  };
}

export function normalizeFlightCancellation(
  result: ProviderJson,
): FlightCancellation {
  const data = dataRecord(result, "cancellation");
  return {
    booking_id: required(nonBlankString(data.bookingId), "bookingId"),
    accepted: true,
    fee: moneyFrom(data.cancellation_fee, data.currency, "cancellation fee"),
    refund: moneyFrom(data.refund_amount, data.currency, "refund amount"),
  };
}

// ---------------------------------------------------------------------------
// Hotel content and reviews

export function normalizeHotelContent(result: ProviderJson): HotelContent {
  const data = dataRecord(result, "hotel content");
  const times = asRecord(data.checkinCheckoutTimes);
  const attributes = asRecord(data.policyAttributes);
  const location = asRecord(data.location);
  const rating = finiteNumber(data.rating);
  const stars = finiteNumber(data.starRating);
  const rooms: HotelRoomContent[] = [];
  for (const entry of Array.isArray(data.rooms) ? data.rooms : []) {
    const room = asRecord(entry);
    const roomId = nonBlankString(room?.id) ?? "";
    const name = nonBlankString(room?.roomName);
    if (!name) continue;
    rooms.push({
      room_id: String(roomId),
      name,
      description: plainText(room?.description),
      size_square: finiteNumber(room?.roomSizeSquare),
      size_unit: nonBlankString(room?.roomSizeUnit),
      max_adults: finiteNumber(room?.maxAdults),
      max_children: finiteNumber(room?.maxChildren),
      max_occupancy: finiteNumber(room?.maxOccupancy),
      bed_types: bedTypes(room?.bedTypes),
      amenities: stringList(room?.roomAmenities, 20),
      photos: photoUrls(room?.photos, 6),
    });
  }
  const nearby: HotelContent["nearby"] = [];
  for (const entry of Array.isArray(data.poi) ? data.poi : []) {
    const poi = asRecord(entry);
    const name = nonBlankString(poi?.name);
    if (!name) continue;
    nearby.push({
      name,
      category: nonBlankString(poi?.category),
      distance_km: finiteNumber(poi?.distanceKm),
      importance: nonBlankString(poi?.importance),
    });
  }
  const sentiment = asRecord(data.sentiment_analysis);
  return {
    hotel_id: String(nonBlankString(data.id) ?? ""),
    name: required(nonBlankString(data.name), "hotel name"),
    description: plainText(data.hotelDescription),
    important_information: plainText(data.hotelImportantInformation),
    address: nonBlankString(data.address),
    city: nonBlankString(data.city),
    country_code: nonBlankString(data.country),
    latitude: finiteNumber(location?.latitude),
    longitude: finiteNumber(location?.longitude),
    zip: nonBlankString(data.zip),
    stars,
    rating,
    review_count: finiteNumber(data.reviewCount),
    phone: nonBlankString(data.phone),
    email: nonBlankString(data.email),
    website: nonBlankString(data.website),
    chain: nonBlankString(data.chain),
    hotel_type: nonBlankString(data.hotelType),
    airport_code: nonBlankString(data.airportCode),
    currency: nonBlankString(data.currency),
    checkin_from: nonBlankString(times?.checkin_start),
    checkin_until: nonBlankString(times?.checkin_end),
    checkout_until: nonBlankString(times?.checkout),
    minimum_check_in_age: finiteNumber(attributes?.minimumCheckInAge),
    images: images(data.hotelImages),
    facilities: stringList(data.hotelFacilities ?? data.facilities, 40),
    policies: policyNotes(attributes, data),
    nearby: nearby.slice(0, 8),
    sentiment: {
      pros: stringList(sentiment?.pros, 6),
      cons: stringList(sentiment?.cons, 6),
    },
    rooms,
  };
}

export function normalizeHotelReviews(result: ProviderJson): HotelReview[] {
  const root = asRecord(result.json);
  const reviews: HotelReview[] = [];
  for (const entry of Array.isArray(root?.data) ? root.data : []) {
    const review = asRecord(entry);
    const id = nonBlankString(review?.reviewId) ?? "";
    const score = finiteNumber(review?.averageScore);
    if (score === null) continue;
    reviews.push({
      review_id: String(id),
      score,
      date: nonBlankString(review?.date),
      country: nonBlankString(review?.country),
      traveller_type: nonBlankString(review?.type),
      name: plainText(review?.name),
      headline: plainText(review?.headline),
      pros: plainText(review?.pros),
      cons: plainText(review?.cons),
      language: nonBlankString(review?.language),
    });
  }
  return reviews;
}

/** Provider text arrives as HTML or with entities; keep the words only. */
function plainText(value: unknown): string | null {
  const text = nonBlankString(value);
  if (!text) return null;
  const decoded = decodeEntities(text);
  let out = "";
  let insideTag = false;
  for (const char of decoded) {
    if (char === "<") {
      insideTag = true;
      continue;
    }
    if (char === ">") {
      insideTag = false;
      out += " ";
      continue;
    }
    if (!insideTag) out += char;
  }
  const collapsed = out.split("\n").join(" ");
  let result = "";
  let space = false;
  for (const char of collapsed) {
    if (char === " " || char === "\t" || char === "\r") {
      space = true;
      continue;
    }
    if (space && result.length > 0) result += " ";
    space = false;
    result += char;
  }
  const trimmed = result.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function decodeEntities(text: string): string {
  const pairs: Array<[string, string]> = [
    ["&nbsp;", " "],
    ["&amp;", "&"],
    ["&quot;", '"'],
    ["&#39;", "'"],
    ["&apos;", "'"],
    ["&lt;", "<"],
    ["&gt;", ">"],
  ];
  let out = text;
  for (const [entity, character] of pairs) out = out.split(entity).join(character);
  return out;
}

function stringList(value: unknown, limit: number): string[] {
  const items: string[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const text = plainText(entry) ?? plainText(asRecord(entry)?.name);
    if (!text || items.includes(text)) continue;
    items.push(text);
    if (items.length >= limit) break;
  }
  return items;
}

function photoUrls(value: unknown, limit: number): string[] {
  const urls: string[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const url = nonBlankString(asRecord(entry)?.url);
    if (!url || urls.includes(url)) continue;
    urls.push(url);
    if (urls.length >= limit) break;
  }
  return urls;
}

function images(value: unknown): Array<{ url: string; caption: string | null }> {
  const items: Array<{ url: string; caption: string | null }> = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const image = asRecord(entry);
    const url = nonBlankString(image?.urlHd) ?? nonBlankString(image?.url);
    if (!url) continue;
    if (items.some((item) => item.url === url)) continue;
    items.push({ url, caption: nonBlankString(image?.caption) });
    if (items.length >= 12) break;
  }
  return items;
}

function bedTypes(value: unknown): Array<{ quantity: number; bed_type: string }> {
  const beds: Array<{ quantity: number; bed_type: string }> = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const bed = asRecord(entry);
    const type = nonBlankString(bed?.bedType);
    if (!type) continue;
    beds.push({ quantity: finiteNumber(bed?.quantity) ?? 1, bed_type: type });
  }
  return beds;
}

/** The rules a traveller asks about, in plain sentences. */
function policyNotes(
  attributes: Record<string, unknown> | null,
  data: Record<string, unknown>,
): string[] {
  const notes: string[] = [];
  const children = asRecord(attributes?.children);
  const pets = asRecord(attributes?.pets);
  const wifi = asRecord(attributes?.wifi);
  const parking = asRecord(attributes?.parking);
  if (children?.allowed === true)
    notes.push(
      children?.cribAvailable === true
        ? "Children allowed, cribs available"
        : "Children allowed",
    );
  if (children?.allowed === false) notes.push("Children not allowed");
  if (pets?.allowed === true) notes.push("Pets allowed");
  if (pets?.allowed === false) notes.push("Pets not allowed");
  if (data.petsAllowed === true && pets?.allowed !== true)
    notes.push("Pets allowed");
  if (data.petsAllowed === false && pets?.allowed !== false)
    notes.push("Pets not allowed");
  if (wifi?.free === true) notes.push("Free WiFi");
  else if (wifi?.inRoom === true) notes.push("WiFi in rooms");
  if (parking?.free === true || nonBlankString(data.parking) === "FREE")
    notes.push("Free parking");
  const minimumAge = finiteNumber(attributes?.minimumCheckInAge);
  if (minimumAge !== null) notes.push(`Minimum check-in age ${minimumAge}`);
  return notes;
}
