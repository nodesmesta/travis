import {
  LiteApiClient,
  type FlightPassenger,
  type HotelGuest,
  type Person,
  type HotelSearchRequest,
  type FlightSearchRequest,
} from "@travelflow/integrations";
import { AppError } from "../errors.js";
import {
  bodyRecord,
  commandContext,
  readJsonBody,
  requiredString,
  writeJson,
} from "../http.js";
import { FixedWindowLimiter } from "../rate-limit.js";
import { SupabaseIdempotencyStore } from "../repositories/domain-persistence.js";
import { LiteApiBookingRepository } from "../repositories/liteapi-booking-repository.js";
import { SupabaseTripContextRepository } from "../repositories/trip-context-repository.js";
import { matchPath } from "../routing.js";
import { LiteApiBookingService, type BookingFollowUp } from "../services/liteapi-booking-service.js";
import type { BookingPlaceResolver } from "../services/trip-booking-link-service.js";
import { createAdminSupabaseClient } from "../supabase/client.js";
import { queueInvoiceAfterPayment } from "./invoices.js";
import type {
  AuthenticatedSession,
  RequestContext,
  RouteModule,
} from "./context.js";

const TRIPS = "/api/v1/trips";
const searchLimiter = new FixedWindowLimiter(10, 60_000);
const prebookLimiter = new FixedWindowLimiter(5, 60_000);
const bookLimiter = new FixedWindowLimiter(3, 60_000);
const HEX = "0123456789abcdef";

function isUuid(value: string): boolean {
  if (value.length !== 36) return false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] as string;
    if (index === 8 || index === 13 || index === 18 || index === 23) {
      if (char !== "-") return false;
    } else if (!HEX.includes(char.toLowerCase())) return false;
  }
  return true;
}

function pathId(value: string | undefined, label: string): string {
  if (!value || !isUuid(value)) {
    throw new AppError(
      "RESOURCE_NOT_FOUND",
      "not_found",
      404,
      `${label} was not found.`,
    );
  }
  return value;
}

function limit(
  context: RequestContext,
  limiter: FixedWindowLimiter,
  userId: string,
  scope: string,
): void {
  const wait = limiter.take(`${userId}:liteapi:${scope}`);
  if (wait <= 0) return;
  context.response.setHeader("retry-after", String(wait));
  throw new AppError(
    "RATE_LIMITED",
    "validation",
    429,
    "Too many LiteAPI requests. Wait and try again.",
    { retry_after_seconds: wait },
  );
}

function positiveInteger(
  body: Record<string, unknown>,
  field: string,
  maximum?: number,
): number {
  const value = body[field];
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    (maximum !== undefined && value > maximum)
  ) {
    throw new AppError(
      "REQUEST_INVALID",
      "validation",
      400,
      `${field} must be a positive integer.`,
    );
  }
  return value;
}

// The nested parsers below read one key from an object that is already the
// parent (a holder, a guest, a passenger, or a document), so the camel-free
// dotted name is only the label used in the error message.
function nestedString(
  body: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(
      "REQUEST_INVALID",
      "validation",
      400,
      `${label} must be a non-blank string.`,
    );
  }
  return value.trim();
}

function nestedInteger(
  body: Record<string, unknown>,
  key: string,
  label: string,
  maximum?: number,
): number {
  const value = body[key];
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    (maximum !== undefined && value > maximum)
  ) {
    throw new AppError(
      "REQUEST_INVALID",
      "validation",
      400,
      `${label} must be a positive integer.`,
    );
  }
  return value;
}

function only(
  body: Record<string, unknown>,
  allowed: string[],
  label: string,
): void {
  const unknown = Object.keys(body).find((key) => !allowed.includes(key));
  if (unknown)
    throw new AppError(
      "REQUEST_INVALID",
      "validation",
      400,
      `${unknown} is not supported for ${label}.`,
    );
}

function person(body: Record<string, unknown>, label: string): Person {
  return {
    first_name: nestedString(body, "first_name", `${label}.first_name`),
    last_name: nestedString(body, "last_name", `${label}.last_name`),
    email: nestedString(body, "email", `${label}.email`),
  };
}

function parseHotelSearch(body: unknown): HotelSearchRequest {
  const input = bodyRecord(body);
  only(
    input,
    [
      "city",
      "country_code",
      "checkin",
      "checkout",
      "adults",
      "currency",
      "guest_nationality",
      "limit",
    ],
    "hotel search",
  );
  return {
    city: requiredString(input, "city"),
    country_code: requiredString(input, "country_code"),
    checkin: requiredString(input, "checkin"),
    checkout: requiredString(input, "checkout"),
    adults: positiveInteger(input, "adults", 9),
    currency: requiredString(input, "currency"),
    guest_nationality: requiredString(input, "guest_nationality"),
    ...(input.limit === undefined
      ? {}
      : { limit: positiveInteger(input, "limit", 50) }),
  };
}

function parseFlightSearch(body: unknown): FlightSearchRequest {
  const input = bodyRecord(body);
  only(
    input,
    ["origin", "destination", "date", "adults", "currency", "limit"],
    "flight search",
  );
  return {
    origin: requiredString(input, "origin"),
    destination: requiredString(input, "destination"),
    date: requiredString(input, "date"),
    adults: positiveInteger(input, "adults", 9),
    currency: requiredString(input, "currency"),
    ...(input.limit === undefined
      ? {}
      : { limit: positiveInteger(input, "limit", 50) }),
  };
}

function parseHotelPrebook(body: unknown): { offer_id: string } {
  const input = bodyRecord(body);
  only(input, ["offer_id"], "hotel prebook");
  return { offer_id: requiredString(input, "offer_id") };
}

function parseHotelBook(body: unknown): {
  holder: Person & { phone: string };
  guests: HotelGuest[];
} {
  const input = bodyRecord(body);
  only(input, ["holder", "guests"], "hotel booking");
  if (
    !input.holder ||
    typeof input.holder !== "object" ||
    Array.isArray(input.holder)
  ) {
    throw new AppError(
      "REQUEST_INVALID",
      "validation",
      400,
      "holder must be an object.",
    );
  }
  const holderBody = input.holder as Record<string, unknown>;
  const holder = {
    ...person(holderBody, "holder"),
    phone: nestedString(holderBody, "phone", "holder.phone"),
  };
  if (
    !Array.isArray(input.guests) ||
    input.guests.length < 1 ||
    input.guests.length > 9
  ) {
    throw new AppError(
      "REQUEST_INVALID",
      "validation",
      400,
      "guests must contain between 1 and 9 guests.",
    );
  }
  const guests = input.guests.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new AppError(
        "REQUEST_INVALID",
        "validation",
        400,
        `guests[${index}] must be an object.`,
      );
    const guest = value as Record<string, unknown>;
    return {
      ...person(guest, `guests[${index}]`),
      occupancy_number: nestedInteger(
        guest,
        "occupancy_number",
        `guests[${index}].occupancy_number`,
      ),
    };
  });
  return { holder, guests };
}

function parseFlightSeats(body: unknown): Array<{
  passenger_index: number;
  service_id: string;
}> {
  const input = bodyRecord(body);
  only(input, ["seats"], "flight seats");
  if (!Array.isArray(input.seats) || input.seats.length > 9)
    throw new AppError(
      "REQUEST_INVALID",
      "validation",
      400,
      "seats must be an array of at most 9 entries.",
    );
  return input.seats.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new AppError(
        "REQUEST_INVALID",
        "validation",
        400,
        `seats[${index}] must be an object.`,
      );
    const seat = entry as Record<string, unknown>;
    only(seat, ["passenger_index", "service_id"], `seats[${index}]`);
    const passengerIndex = seat.passenger_index;
    if (
      typeof passengerIndex !== "number" ||
      !Number.isInteger(passengerIndex) ||
      passengerIndex < 0
    )
      throw new AppError(
        "REQUEST_INVALID",
        "validation",
        400,
        `seats[${index}].passenger_index must be a non-negative integer.`,
      );
    return {
      passenger_index: passengerIndex,
      service_id: nestedString(seat, "service_id", `seats[${index}].service_id`),
    };
  });
}

/** The itinerary the traveller booked, mirrored onto the trip. */
function parseFlightSchedule(body: Record<string, unknown>):
  | { segments: Array<{
      origin_code: string;
      origin_name: string | null;
      destination_code: string;
      destination_name: string | null;
      departs_at: string;
      arrives_at: string;
      carrier_name: string;
      flight_number: string;
    }> }
  | undefined {
  const raw = body.schedule;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw))
    throw new AppError(
      "REQUEST_INVALID",
      "validation",
      400,
      "schedule must be an object.",
    );
  const segmentsRaw = (raw as Record<string, unknown>).segments;
  if (!Array.isArray(segmentsRaw) || segmentsRaw.length === 0 || segmentsRaw.length > 4)
    throw new AppError(
      "REQUEST_INVALID",
      "validation",
      400,
      "schedule.segments must contain between 1 and 4 segments.",
    );
  const segments = segmentsRaw.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new AppError(
        "REQUEST_INVALID",
        "validation",
        400,
        `schedule.segments[${index}] must be an object.`,
      );
    const segment = entry as Record<string, unknown>;
    const field = (key: string) =>
      nestedString(segment, key, `schedule.segments[${index}].${key}`);
    const optional = (key: string) =>
      typeof segment[key] === "string" ? (segment[key] as string) : null;
    return {
      origin_code: field("origin_code"),
      origin_name: optional("origin_name"),
      destination_code: field("destination_code"),
      destination_name: optional("destination_name"),
      departs_at: field("departs_at"),
      arrives_at: field("arrives_at"),
      carrier_name: field("carrier_name"),
      flight_number: field("flight_number"),
    };
  });
  return { segments };
}

function parseFlightPrebook(body: unknown): {
  offer_id: string;
  purpose: "BUSINESS" | "LEISURE";
  contact: Person & { phone_country_code: string; phone_number: string };
  passengers: FlightPassenger[];
  schedule:
    | { segments: Array<{
        origin_code: string;
        origin_name: string | null;
        destination_code: string;
        destination_name: string | null;
        departs_at: string;
        arrives_at: string;
        carrier_name: string;
        flight_number: string;
      }> }
    | undefined;
} {
  const input = bodyRecord(body);
  only(
    input,
    ["offer_id", "purpose", "contact", "passengers", "schedule"],
    "flight prebook",
  );
  const purpose = requiredString(input, "purpose");
  if (purpose !== "BUSINESS" && purpose !== "LEISURE")
    throw new AppError(
      "REQUEST_INVALID",
      "validation",
      400,
      "purpose must be BUSINESS or LEISURE.",
    );
  if (
    !input.contact ||
    typeof input.contact !== "object" ||
    Array.isArray(input.contact)
  )
    throw new AppError(
      "REQUEST_INVALID",
      "validation",
      400,
      "contact must be an object.",
    );
  const contactBody = input.contact as Record<string, unknown>;
  const contact = {
    ...person(contactBody, "contact"),
    phone_country_code: nestedString(
      contactBody,
      "phone_country_code",
      "contact.phone_country_code",
    ),
    phone_number: nestedString(
      contactBody,
      "phone_number",
      "contact.phone_number",
    ),
  };
  if (
    !Array.isArray(input.passengers) ||
    input.passengers.length < 1 ||
    input.passengers.length > 9
  )
    throw new AppError(
      "REQUEST_INVALID",
      "validation",
      400,
      "passengers must contain between 1 and 9 passengers.",
    );
  const passengers = input.passengers.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new AppError(
        "REQUEST_INVALID",
        "validation",
        400,
        `passengers[${index}] must be an object.`,
      );
    const p = value as Record<string, unknown>;
    const type = nestedString(p, "type", `passengers[${index}].type`);
    const title = nestedString(p, "title", `passengers[${index}].title`);
    const gender = nestedString(p, "gender", `passengers[${index}].gender`);
    if (
      !["adult", "child", "infant"].includes(type) ||
      !["MR", "MS", "MRS", "MISS"].includes(title) ||
      !["M", "F"].includes(gender)
    )
      throw new AppError(
        "REQUEST_INVALID",
        "validation",
        400,
        `passengers[${index}] has an invalid type, title, or gender.`,
      );
    const result: FlightPassenger = {
      type: type as FlightPassenger["type"],
      title: title as FlightPassenger["title"],
      first_name: nestedString(
        p,
        "first_name",
        `passengers[${index}].first_name`,
      ),
      last_name: nestedString(p, "last_name", `passengers[${index}].last_name`),
      birthday: nestedString(p, "birthday", `passengers[${index}].birthday`),
      gender: gender as FlightPassenger["gender"],
      nationality: nestedString(
        p,
        "nationality",
        `passengers[${index}].nationality`,
      ),
    };
    if (p.document !== undefined) {
      if (
        !p.document ||
        typeof p.document !== "object" ||
        Array.isArray(p.document)
      )
        throw new AppError(
          "REQUEST_INVALID",
          "validation",
          400,
          `passengers[${index}].document must be an object.`,
        );
      const document = p.document as Record<string, unknown>;
      const documentType = nestedString(
        document,
        "type",
        `passengers[${index}].document.type`,
      );
      if (documentType !== "passport" && documentType !== "id_card")
        throw new AppError(
          "REQUEST_INVALID",
          "validation",
          400,
          "document.type is invalid.",
        );
      result.document = {
        type: documentType,
        number: nestedString(
          document,
          "number",
          `passengers[${index}].document.number`,
        ),
        issue_country: nestedString(
          document,
          "issue_country",
          `passengers[${index}].document.issue_country`,
        ),
        expiry: nestedString(
          document,
          "expiry",
          `passengers[${index}].document.expiry`,
        ),
      };
    }
    return result;
  });
  return {
    offer_id: requiredString(input, "offer_id"),
    purpose: purpose as "BUSINESS" | "LEISURE",
    contact,
    passengers,
    schedule: parseFlightSchedule(input),
  };
}

async function ownedTrip(
  context: RequestContext,
  id: string | undefined,
  session: AuthenticatedSession,
): Promise<string> {
  const tripId = pathId(id, "Trip");
  const trip = await new SupabaseTripContextRepository(
    session.client,
  ).getTripRowForUser(tripId, session.user.id);
  if (!trip)
    throw new AppError(
      "RESOURCE_NOT_FOUND",
      "not_found",
      404,
      "Trip was not found.",
    );
  return tripId;
}

function makeClient(context: RequestContext): LiteApiClient {
  return new LiteApiClient({
    apiKey: context.config.liteApiKey,
    timeoutMs: context.config.liteApiTimeoutMs,
  });
}

function makeService(
  context: RequestContext,
  session: AuthenticatedSession,
): LiteApiBookingService {
  const client = makeClient(context);
  return new LiteApiBookingService(
    new LiteApiBookingRepository(session.client),
    client,
    makePlaceResolver(client),
    makeFollowUp(context),
  );
}

/**
 * The first read a new trip needs: the weather where its ticket lands. It is queued
 * as the same `refresh_weather` job the worker already runs, so the snapshot and the
 * alerts that follow it come from one code path. A failure is logged and never
 * reports the booking as failed — the ticket exists either way.
 */
function makeFollowUp(context: RequestContext): BookingFollowUp {
  return {
    async weatherAt(input) {
      const admin = createAdminSupabaseClient(context.config);
      const { error } = await admin.from("background_jobs").insert({
        trip_id: input.tripId,
        user_id: input.userId,
        job_type: "refresh_weather",
        payload: { context_point_id: input.contextPointId },
        // One read per booking of a place: a retried request cannot queue a second.
        idempotency_key: `booking_weather:${input.bookingId}:${input.contextPointId}`,
        correlation_id: context.requestId,
        created_by: input.userId,
      });
      // 23505 means this booking already queued its read; that is the intended state.
      if (error && error.code !== "23505") {
        context.logger.error("booking.weather_follow_up_failed", {
          request_id: context.requestId,
          trip_id: input.tripId,
          context_point_id: input.contextPointId,
          error_code: error.code ?? null,
        });
      }
    },
  };
}

/**
 * The coordinates a booking does not carry. The provider is the only source: a hotel
 * id becomes the hotel's own location and an IATA code becomes the airport's, so the
 * trip can reason about the place it is actually going to.
 */
function makePlaceResolver(client: LiteApiClient): BookingPlaceResolver {
  return {
    async hotel(hotelId: string) {
      const content = await client.getHotelContent(hotelId);
      return {
        type: "hotel" as const,
        label: content.name,
        address: content.address,
        latitude: content.latitude,
        longitude: content.longitude,
        externalPlaceId: content.hotel_id || hotelId,
      };
    },
    async airport(iata: string) {
      const found = await client.searchAirports(iata);
      const code = iata.trim().toUpperCase();
      const match = found.find((airport) => airport.iata === code) ?? null;
      if (!match) return null;
      const place = [match.city, match.country].filter(
        (part) => part.length > 0,
      );
      return {
        type: "airport" as const,
        label: match.city.length > 0 ? `${match.city} · ${match.name}` : match.name,
        address: place.length > 0 ? place.join(", ") : null,
        latitude: match.lat,
        longitude: match.lon,
        externalPlaceId: match.iata,
      };
    },
  };
}

async function executeIdempotent<T>(
  session: AuthenticatedSession,
  context: RequestContext,
  scope: string,
  body: unknown,
  operation: () => Promise<T>,
): Promise<T> {
  return new SupabaseIdempotencyStore(session.client).execute(
    scope,
    commandContext(
      context.request,
      context.url.pathname,
      session.user.id,
      body,
    ),
    operation,
  );
}

export const liteApiRoutes: RouteModule = async (context) => {
  const { method, url, request, requestId } = context;
  const hotelSearch = matchPath(url.pathname, `${TRIPS}/:tripId/hotels/search`);
  const flightSearch = matchPath(
    url.pathname,
    `${TRIPS}/:tripId/flights/search`,
  );
  const prebookHotel = matchPath(
    url.pathname,
    `${TRIPS}/:tripId/hotels/prebook`,
  );
  const prebookFlight = matchPath(
    url.pathname,
    `${TRIPS}/:tripId/flights/prebook`,
  );
  const hotelBook = matchPath(
    url.pathname,
    `${TRIPS}/:tripId/hotels/:providerBookingId/book`,
  );
  const flightBook = matchPath(
    url.pathname,
    `${TRIPS}/:tripId/flights/:providerBookingId/book`,
  );
  const hotelDetail = matchPath(
    url.pathname,
    `${TRIPS}/:tripId/hotels/:providerBookingId`,
  );
  const flightDetail = matchPath(
    url.pathname,
    `${TRIPS}/:tripId/flights/:providerBookingId`,
  );
  const hotelCancel = matchPath(
    url.pathname,
    `${TRIPS}/:tripId/hotels/:providerBookingId/cancel`,
  );
  const flightCancel = matchPath(
    url.pathname,
    `${TRIPS}/:tripId/flights/:providerBookingId/cancel`,
  );
  const flightServices = matchPath(
    url.pathname,
    `${TRIPS}/:tripId/flights/:providerBookingId/services`,
  );
  if (
    !hotelSearch &&
    !flightSearch &&
    !prebookHotel &&
    !prebookFlight &&
    !hotelBook &&
    !flightBook &&
    !hotelDetail &&
    !flightDetail &&
    !hotelCancel &&
    !flightCancel &&
    !flightServices
  )
    return false;
  const session = await context.authenticate();

  if (hotelSearch && method === "POST") {
    const ownerTripId = await ownedTrip(context, hotelSearch.tripId, session);
    limit(context, searchLimiter, session.user.id, "hotel-search");
    const result = await makeClient(context).searchHotels(
      parseHotelSearch(await readJsonBody(request)),
    );
    writeJson(context.response, 200, {
      ...result,
      trip_id: ownerTripId,
      request_id: requestId,
    });
    return true;
  }

  if (flightSearch && method === "POST") {
    const ownerTripId = await ownedTrip(context, flightSearch.tripId, session);
    limit(context, searchLimiter, session.user.id, "flight-search");
    const result = await makeClient(context).searchFlights(
      parseFlightSearch(await readJsonBody(request)),
    );
    writeJson(context.response, 200, {
      ...result,
      trip_id: ownerTripId,
      request_id: requestId,
    });
    return true;
  }
  if (prebookHotel && method === "POST") {
    const ownerTripId = await ownedTrip(context, prebookHotel.tripId, session);
    limit(context, prebookLimiter, session.user.id, "hotel-prebook");
    const body = await readJsonBody(request);
    const input = parseHotelPrebook(body);
    const result = await executeIdempotent(
      session,
      context,
      `liteapi.hotel-prebook:${ownerTripId}`,
      body,
      () =>
        makeService(context, session).prebookHotel({
          userId: session.user.id,
          tripId: ownerTripId,
          offerId: input.offer_id,
        }),
    );
    writeJson(context.response, 200, {
      ...result,
      trip_id: ownerTripId,
      request_id: requestId,
    });
    return true;
  }
  if (prebookFlight && method === "POST") {
    const ownerTripId = await ownedTrip(context, prebookFlight.tripId, session);
    limit(context, prebookLimiter, session.user.id, "flight-prebook");
    const body = await readJsonBody(request);
    const input = parseFlightPrebook(body);
    const result = await executeIdempotent(
      session,
      context,
      `liteapi.flight-prebook:${ownerTripId}`,
      body,
      () =>
        makeService(context, session).prebookFlight({
          userId: session.user.id,
          tripId: ownerTripId,
          offerId: input.offer_id,
          purpose: input.purpose,
          contact: input.contact,
          passengers: input.passengers,
          schedule: input.schedule,
        }),
    );
    writeJson(context.response, 200, {
      ...result,
      trip_id: ownerTripId,
      request_id: requestId,
    });
    return true;
  }
  if (hotelBook && method === "POST") {
    const ownerTripId = await ownedTrip(context, hotelBook.tripId, session);
    limit(context, bookLimiter, session.user.id, "hotel-book");
    const body = await readJsonBody(request);
    const input = parseHotelBook(body);
    const result = await executeIdempotent(
      session,
      context,
      `liteapi.hotel-book:${hotelBook.providerBookingId}`,
      body,
      () =>
        makeService(context, session).bookHotel({
          userId: session.user.id,
          tripId: ownerTripId,
          providerBookingId: pathId(
            hotelBook.providerBookingId,
            "Provider booking",
          ),
          ...input,
        }),
    );
    if (result.booking.status === "confirmed")
      await queueInvoiceAfterPayment(
        context.config,
        context.logger,
        result.booking.id,
        context.requestId,
      );
    writeJson(context.response, 200, {
      ...result,
      trip_id: ownerTripId,
      request_id: requestId,
    });
    return true;
  }
  if (flightBook && method === "POST") {
    const ownerTripId = await ownedTrip(context, flightBook.tripId, session);
    limit(context, bookLimiter, session.user.id, "flight-book");
    const body = await readJsonBody(request);
    only(bodyRecord(body), [], "flight booking");
    const result = await executeIdempotent(
      session,
      context,
      `liteapi.flight-book:${flightBook.providerBookingId}`,
      body,
      () =>
        makeService(context, session).bookFlight({
          userId: session.user.id,
          tripId: ownerTripId,
          providerBookingId: pathId(
            flightBook.providerBookingId,
            "Provider booking",
          ),
        }),
    );
    if (result.booking.status === "confirmed")
      await queueInvoiceAfterPayment(
        context.config,
        context.logger,
        result.booking.id,
        context.requestId,
      );
    writeJson(context.response, 200, {
      ...result,
      trip_id: ownerTripId,
      request_id: requestId,
    });
    return true;
  }
  if (flightServices && method === "POST") {
    const ownerTripId = await ownedTrip(context, flightServices.tripId, session);
    limit(context, prebookLimiter, session.user.id, "flight-services");
    const body = await readJsonBody(request);
    const seats = parseFlightSeats(body);
    const result = await executeIdempotent(
      session,
      context,
      `liteapi.flight-services:${flightServices.providerBookingId}`,
      body,
      () =>
        makeService(context, session).attachFlightSeats({
          userId: session.user.id,
          tripId: ownerTripId,
          providerBookingId: pathId(
            flightServices.providerBookingId,
            "Provider booking",
          ),
          seats,
        }),
    );
    writeJson(context.response, 200, {
      ...result,
      trip_id: ownerTripId,
      request_id: requestId,
    });
    return true;
  }

  if (hotelDetail && method === "GET") {
    const ownerTripId = await ownedTrip(context, hotelDetail.tripId, session);
    const result = await makeService(context, session).getHotel({
      tripId: ownerTripId,
      providerBookingId: pathId(
        hotelDetail.providerBookingId,
        "Provider booking",
      ),
    });
    if (result.booking.status === "confirmed") {
      await queueInvoiceAfterPayment(
        context.config,
        context.logger,
        result.booking.id,
        context.requestId,
      );
    }
    writeJson(context.response, 200, {
      ...result,
      trip_id: ownerTripId,
      request_id: requestId,
    });
    return true;
  }
  if (flightDetail && method === "GET") {
    const ownerTripId = await ownedTrip(context, flightDetail.tripId, session);
    const result = await makeService(context, session).getFlight({
      tripId: ownerTripId,
      providerBookingId: pathId(
        flightDetail.providerBookingId,
        "Provider booking",
      ),
    });
    if (result.booking.status === "confirmed") {
      await queueInvoiceAfterPayment(
        context.config,
        context.logger,
        result.booking.id,
        context.requestId,
      );
    }
    writeJson(context.response, 200, {
      ...result,
      trip_id: ownerTripId,
      request_id: requestId,
    });
    return true;
  }
  if (hotelCancel && method === "POST") {
    const ownerTripId = await ownedTrip(context, hotelCancel.tripId, session);
    const body = await readJsonBody(request);
    only(bodyRecord(body), [], "hotel cancellation");
    const result = await executeIdempotent(
      session,
      context,
      `liteapi.hotel-cancel:${hotelCancel.providerBookingId}`,
      body,
      () =>
        makeService(context, session).cancelHotel({
          tripId: ownerTripId,
          providerBookingId: pathId(
            hotelCancel.providerBookingId,
            "Provider booking",
          ),
        }),
    );
    writeJson(context.response, 200, {
      ...result,
      trip_id: ownerTripId,
      request_id: requestId,
    });
    return true;
  }
  if (flightCancel && method === "POST") {
    const ownerTripId = await ownedTrip(context, flightCancel.tripId, session);
    const body = await readJsonBody(request);
    only(bodyRecord(body), [], "flight cancellation");
    const result = await executeIdempotent(
      session,
      context,
      `liteapi.flight-cancel:${flightCancel.providerBookingId}`,
      body,
      () =>
        makeService(context, session).cancelFlight({
          tripId: ownerTripId,
          providerBookingId: pathId(
            flightCancel.providerBookingId,
            "Provider booking",
          ),
        }),
    );
    writeJson(context.response, 200, {
      ...result,
      trip_id: ownerTripId,
      request_id: requestId,
    });
    return true;
  }
  return false;
};
