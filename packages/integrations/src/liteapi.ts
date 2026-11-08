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
}

export interface FlightJourney {
  journey_key: string;
  segments: FlightSegment[];
  stops: number;
  duration_minutes: number;
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

export interface HotelOffer {
  offer_id: string;
  room_name: string;
  board_name: string | null;
  total: Money;
  taxes_included: number | null;
  /** RFN refundable, NRFN non-refundable, as the provider reports it. */
  refundable: "refundable" | "non_refundable" | "unknown";
  free_cancellation_until: string | null;
}

export interface HotelSearchResult {
  hotels: Array<{ hotel: HotelStay; cheapest: HotelOffer }>;
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

export interface FlightPrebook {
  prebook_id: string;
  total: Money;
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
        maxRatesPerHotel: 1,
        timeout: 12,
      },
    );
    return normalizeHotelSearch(result, limit);
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
  return {
    journey_key: required(nonBlankString(journey?.journeyKey), "journeyKey"),
    segments,
    stops: segments.length - 1,
    duration_minutes: nonNegative(total?.minutes, "journey duration"),
    cheapest: normalizeFlightOffer(journey?.cheapestOffer),
  };
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
  };
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
    const cheapest = cheapestHotelOffer(row);
    if (!cheapest) continue;
    hotels.push({ hotel: normalizeHotel(hotelId, info), cheapest });
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

function cheapestHotelOffer(
  row: Record<string, unknown> | null,
): HotelOffer | null {
  let best: HotelOffer | null = null;
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
      const total = money(totals[0], "room price");
      if (best !== null && total.amount >= best.total.amount) continue;
      const policy = asRecord(rate?.cancellationPolicies);
      const tag = nonBlankString(policy?.refundableTag);
      const taxes = Array.isArray(asRecord(rate?.retailRate)?.taxesAndFees)
        ? (asRecord(rate?.retailRate)?.taxesAndFees as unknown[])
        : [];
      const includedTaxes = taxes
        .map(asRecord)
        .filter((tax) => tax?.included === true)
        .reduce((sum, tax) => sum + (finiteNumber(tax?.amount) ?? 0), 0);
      best = {
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
      };
    }
  }
  return best;
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
  };
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
