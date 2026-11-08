import { request } from "./api";
import type { Booking, PaymentResult } from "./types";

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

export interface HotelMoney {
  amount: number;
  currency: string;
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

export interface HotelCancellationStep {
  before: string | null;
  fee: HotelMoney | null;
}
export interface HotelOffer {
  offer_id: string;
  room_name: string;
  board_name: string | null;
  total: HotelMoney;
  taxes_included: number | null;
  refundable: "refundable" | "non_refundable" | "unknown";
  free_cancellation_until: string | null;
  max_occupancy: number | null;
  adults: number | null;
  children: number | null;
  perks: string[];
  supplier: string | null;
  payment_types: string[];
  cancellation: { tag: string | null; steps: HotelCancellationStep[] };
}

/** A room the provider sells for these nights, with the content it matched. */
export interface HotelRateGroup {
  key: string;
  name: string;
  room: HotelRoomContent | null;
  offers: HotelOffer[];
}
export interface HotelRoomOptions {
  hotel_id: string;
  hotel_name: string;
  nights: number;
  offer_count: number;
  groups: HotelRateGroup[];
}
export interface HotelSearchResponse {
  hotels: Array<{
    hotel: HotelStay;
    /** Every room and rate sold for the stay, cheapest first. */
    offers: HotelOffer[];
    cheapest: HotelOffer;
  }>;
  total_found?: number;
  retrieved_at: string;
  provider_request_id: string | null;
  sandbox: boolean;
  trip_id: string;
  request_id: string;
}
export interface HotelPrebookResponse {
  prebook_id: string;
  hotel_id: string;
  total: HotelMoney;
  checkin: string;
  checkout: string;
  price_difference_percent: number;
  cancellation_changed: boolean;
  board_changed: boolean;
}
export interface FlightSegment {
  carrier_code: string;
  carrier_name: string;
  flight_number: string;
  origin_code: string;
  origin_name: string | null;
  destination_code: string;
  destination_name: string | null;
  departs_local: string;
  arrives_local: string;
  duration_minutes: number;
  operating_carrier_name: string | null;
  carrier_logo: string | null;
  stops_within_segment: number | null;
}
export interface FlightBaggage {
  description: string | null;
  pieces: number | null;
  weight_kg: number | null;
  size: string | null;
  price: HotelMoney | null;
}

export interface FlightFareTerms {
  changeable: boolean;
  refundable: boolean;
  messages: string[];
}

export interface FlightOffer {
  offer_id: string;
  expires_at: string;
  total: HotelMoney;
  base: number;
  taxes: number;
  fees: number;
  cabin: string | null;
  fare_family: string | null;
  seats_remaining: number | null;
  carry_on_included: boolean;
  checked_bag_included: boolean;
  terms: FlightFareTerms | null;
  baggage: { cabin: FlightBaggage | null; checked: FlightBaggage | null };
}
export interface FlightJourney {
  journey_key: string;
  segments: FlightSegment[];
  stops: number;
  duration_minutes: number;
  overnight: boolean;
  /** Every fare on sale for this itinerary, cheapest first. */
  offers: FlightOffer[];
  cheapest: FlightOffer;
}
export interface FlightSearchResponse {
  journeys: FlightJourney[];
  total_found: number;
  retrieved_at: string;
  provider_request_id: string | null;
  trip_id: string;
  request_id: string;
}
export interface ProviderBookingView {
  id: string;
  booking_id: string;
  provider: "liteapi";
  booking_type: "hotel" | "flight";
  offer_id: string;
  prebook_id: string | null;
  client_reference: string;
  provider_booking_id: string | null;
  provider_status: string | null;
  state: string;
  currency: string;
  subtotal: number;
  tax: number;
  total: number;
  confirmation_code: string | null;
  checkin: string | null;
  checkout: string | null;
  ticket_deadline: string | null;
  cancellation_fee: number | null;
  refund_amount: number | null;
  last_reconciled_at: string | null;
}
export interface ProviderAttemptResponse {
  booking: Booking;
  provider_booking: ProviderBookingView;
  request_id: string;
}
export interface HotelPrebookAttempt extends ProviderAttemptResponse {
  kind: "hotel";
  prebook: HotelPrebookResponse;
}
export interface FlightOfferVerificationView {
  offer_id: string;
  journey_key: string;
  total: HotelMoney;
  changed: boolean;
  messages: string[];
  verified_at: string;
}
export interface FlightSeat {
  service_id: string;
  seat_number: string;
  row: number;
  column: string;
  position: string | null;
  kind: string | null;
  available: boolean;
  price: HotelMoney | null;
  segment_key: string;
}

export interface FlightPrebookAttempt extends ProviderAttemptResponse {
  kind: "flight";
  prebook: { prebook_id: string; total: HotelMoney; seats?: FlightSeat[] };
  verification?: FlightOfferVerificationView;
}
export interface ProviderActionResponse extends ProviderAttemptResponse {
  provider?: unknown;
  payment?: PaymentResult["payment"];
}

function trip(tripId: string): string {
  return `/trips/${encodeURIComponent(tripId)}`;
}
function providerRequest<T>(
  path: string,
  body: unknown,
  mutation = false,
): Promise<T> {
  return request(
    path,
    { method: "POST", body: JSON.stringify(body) },
    mutation,
  );
}

export function searchHotels(
  tripId: string,
  body: HotelSearchRequest,
): Promise<HotelSearchResponse> {
  return providerRequest(`${trip(tripId)}/hotels/search`, body);
}
export function prebookHotel(
  tripId: string,
  offerId: string,
): Promise<HotelPrebookAttempt> {
  return providerRequest(
    `${trip(tripId)}/hotels/prebook`,
    { offer_id: offerId },
    true,
  );
}
export function bookHotel(
  tripId: string,
  providerBookingId: string,
  body: unknown,
): Promise<ProviderActionResponse> {
  return providerRequest(
    `${trip(tripId)}/hotels/${encodeURIComponent(providerBookingId)}/book`,
    body,
    true,
  );
}
export function getHotelBooking(
  tripId: string,
  providerBookingId: string,
): Promise<ProviderActionResponse> {
  return request(
    `${trip(tripId)}/hotels/${encodeURIComponent(providerBookingId)}`,
  );
}
export function cancelHotelBooking(
  tripId: string,
  providerBookingId: string,
): Promise<ProviderActionResponse> {
  return providerRequest(
    `${trip(tripId)}/hotels/${encodeURIComponent(providerBookingId)}/cancel`,
    {},
    true,
  );
}

export function searchFlights(
  tripId: string,
  body: {
    origin: string;
    destination: string;
    date: string;
    adults: number;
    currency: string;
    limit?: number;
  },
): Promise<FlightSearchResponse> {
  return providerRequest(`${trip(tripId)}/flights/search`, body);
}
export function prebookFlight(
  tripId: string,
  body: unknown,
): Promise<FlightPrebookAttempt> {
  return providerRequest(`${trip(tripId)}/flights/prebook`, body, true);
}
/** Attaches the seats the passenger picked; the totals move with them. */
export function attachFlightSeats(
  tripId: string,
  providerBookingId: string,
  seats: Array<{ passenger_index: number; service_id: string }>,
): Promise<{
  total: HotelMoney;
  seat_count: number;
  provider_booking: ProviderBookingView;
}> {
  return providerRequest(
    `${trip(tripId)}/flights/${encodeURIComponent(providerBookingId)}/services`,
    { seats },
    true,
  );
}

/** Everything the provider holds about one hotel, plus its latest reviews. */
/** Every rate the provider sells for one hotel on these dates, grouped by room. */
export function getHotelRoomOptions(
  hotelId: string,
  params: {
    city: string;
    country: string;
    checkin: string;
    checkout: string;
    adults: number;
    currency?: string;
  },
): Promise<HotelRoomOptions> {
  const query = [
    `city=${encodeURIComponent(params.city)}`,
    `country=${encodeURIComponent(params.country)}`,
    `checkin=${encodeURIComponent(params.checkin)}`,
    `checkout=${encodeURIComponent(params.checkout)}`,
    `adults=${params.adults}`,
    params.currency ? `currency=${encodeURIComponent(params.currency)}` : "",
  ]
    .filter((part) => part.length > 0)
    .join("&");
  return request(
    `/places/hotels/${encodeURIComponent(hotelId)}/rates?${query}`,
  ) as Promise<HotelRoomOptions>;
}

export function getHotelDetails(
  hotelId: string,
): Promise<{ hotel: HotelContent; reviews: HotelReview[] }> {
  return request(
    `/places/hotels/${encodeURIComponent(hotelId)}`,
  ) as Promise<{ hotel: HotelContent; reviews: HotelReview[] }>;
}

export function bookFlight(
  tripId: string,
  providerBookingId: string,
): Promise<ProviderActionResponse> {
  return providerRequest(
    `${trip(tripId)}/flights/${encodeURIComponent(providerBookingId)}/book`,
    {},
    true,
  );
}
export function getFlightBooking(
  tripId: string,
  providerBookingId: string,
): Promise<ProviderActionResponse> {
  return request(
    `${trip(tripId)}/flights/${encodeURIComponent(providerBookingId)}`,
  );
}
export function cancelFlightBooking(
  tripId: string,
  providerBookingId: string,
): Promise<ProviderActionResponse> {
  return providerRequest(
    `${trip(tripId)}/flights/${encodeURIComponent(providerBookingId)}/cancel`,
    {},
    true,
  );
}

// ---------------------------------------------------------------------------
// Places. The provider owns the country and city lists, so the search form asks
// for them instead of carrying a hand-written list that can drift.

export interface PlaceCountry {
  code: string;
  name: string;
}

export function listCountries(): Promise<{ countries: PlaceCountry[] }> {
  return request("/places/countries");
}

export function searchCities(
  country: string,
  query: string,
  limit = 40,
  first: string[] = [],
): Promise<{ country: string; cities: string[]; total: number }> {
  const params = new URLSearchParams({ country, limit: String(limit) });
  const trimmed = query.trim();
  if (trimmed) params.set("q", trimmed);
  if (first.length > 0) params.set("first", first.slice(0, 20).join(","));
  return request(`/places/cities?${params.toString()}`);
}

/** True only when `city` is one of the provider's cities in `country`. */
export async function cityBelongsToCountry(
  country: string,
  city: string,
): Promise<boolean> {
  const params = new URLSearchParams({
    country,
    q: city.trim(),
    limit: "1",
  });
  const result = await request<{
    country: string;
    cities: string[];
    total: number;
    exact?: boolean;
  }>(`/places/cities?${params.toString()}`);
  return result.exact === true;
}
