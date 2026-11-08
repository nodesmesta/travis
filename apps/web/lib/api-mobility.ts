import { request } from "./api";
import type { Booking, PaymentResult } from "./types";
import type {
  JourneyLeg,
  PlaceDiscoveryView,
  RouteRequestResult,
  TrafficList,
  TransportMode,
  WeatherList,
} from "./types-mobility";

const trip = (tripId: string) => `/trips/${encodeURIComponent(tripId)}`;

export function listJourneyLegs(
  tripId: string,
): Promise<{ items: JourneyLeg[]; request_id: string }> {
  return request(`${trip(tripId)}/journey-legs`);
}

export function createRouteRequest(
  tripId: string,
  legId: string,
  body: {
    required_facts: Array<"route" | "traffic" | "weather">;
    modes?: TransportMode[];
  },
): Promise<RouteRequestResult> {
  return request(
    `${trip(tripId)}/journey-legs/${encodeURIComponent(legId)}/route-requests`,
    { method: "POST", body: JSON.stringify(body) },
    true,
  );
}

export function listRouteRequests(
  tripId: string,
  legId: string,
): Promise<{
  items: Array<RouteRequestResult["route_request"]>;
  request_id: string;
}> {
  return request(
    `${trip(tripId)}/journey-legs/${encodeURIComponent(legId)}/route-requests`,
  );
}

export function getRouteRequest(
  tripId: string,
  routeRequestId: string,
): Promise<RouteRequestResult> {
  return request(
    `${trip(tripId)}/route-requests/${encodeURIComponent(routeRequestId)}`,
  );
}

export function selectRouteOption(
  tripId: string,
  routeRequestId: string,
  optionId: string,
): Promise<RouteRequestResult> {
  return request(
    `${trip(tripId)}/route-requests/${encodeURIComponent(routeRequestId)}/select`,
    { method: "POST", body: JSON.stringify({ option_id: optionId }) },
    true,
  );
}

export function listWeather(tripId: string): Promise<WeatherList> {
  return request(`${trip(tripId)}/weather`);
}

export function refreshWeather(
  tripId: string,
  contextPointId?: string,
): Promise<WeatherList> {
  return request(
    `${trip(tripId)}/weather/refresh`,
    {
      method: "POST",
      body: JSON.stringify(
        contextPointId ? { context_point_id: contextPointId } : {},
      ),
    },
    true,
  );
}

export function listTraffic(tripId: string): Promise<TrafficList> {
  return request(`${trip(tripId)}/traffic`);
}

export function refreshTraffic(
  tripId: string,
  journeyLegId: string,
): Promise<TrafficList> {
  return request(
    `${trip(tripId)}/traffic/refresh`,
    { method: "POST", body: JSON.stringify({ journey_leg_id: journeyLegId }) },
    true,
  );
}

export function discoverPlaces(
  tripId: string,
  body: {
    context_point_id: string;
    category: "activity" | "restaurant";
    radius_meters?: number;
  },
): Promise<PlaceDiscoveryView> {
  return request(`${trip(tripId)}/place-discoveries`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Books an activity result through the same booking endpoint as events.
 * The server prices the booking (see getBookingQuote in lib/api).
 */
export function createActivityBooking(
  tripId: string,
  body: { source_id: string },
): Promise<Booking & { request_id: string }> {
  return request(
    `${trip(tripId)}/bookings`,
    {
      method: "POST",
      body: JSON.stringify({
        booking_type: "activity",
        source_type: "activity",
        ...body,
      }),
    },
    true,
  );
}

export type { PaymentResult };
