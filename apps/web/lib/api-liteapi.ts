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
export interface HotelOffer {
  offer_id: string;
  room_name: string;
  board_name: string | null;
  total: HotelMoney;
  taxes_included: number | null;
  refundable: "refundable" | "non_refundable" | "unknown";
  free_cancellation_until: string | null;
}
export interface HotelSearchResponse {
  hotels: Array<{ hotel: HotelStay; cheapest: HotelOffer }>;
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
}
export interface FlightJourney {
  journey_key: string;
  segments: FlightSegment[];
  stops: number;
  duration_minutes: number;
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
export interface FlightPrebookAttempt extends ProviderAttemptResponse {
  kind: "flight";
  prebook: { prebook_id: string; total: HotelMoney };
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
