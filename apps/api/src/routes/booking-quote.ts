import { AppError } from "../errors.js";
import { writeJson } from "../http.js";
import { isPricedBookingType, quoteBooking } from "../pricing.js";
import { matchPath } from "../routing.js";
import type { RouteModule } from "./context.js";

/** `GET /trips/:tripId/booking-quote?booking_type=...`: the server price shown before a booking is created. */
export const bookingQuoteRoutes: RouteModule = async (context) => {
  const params = matchPath(
    context.url.pathname,
    "/api/v1/trips/:tripId/booking-quote",
  );
  if (!params || context.method !== "GET") return false;
  const { client, user } = await context.authenticate();
  const { data: trip, error } = await client
    .from("trips")
    .select("id")
    .eq("id", params.tripId as string)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) {
    throw new AppError(
      "PERSISTENCE_ERROR",
      "persistence",
      500,
      "Trip could not be read.",
    );
  }
  if (!trip) {
    throw new AppError(
      "RESOURCE_NOT_FOUND",
      "not_found",
      404,
      "Trip was not found.",
    );
  }
  const bookingType = context.url.searchParams.get("booking_type") ?? "";
  if (!isPricedBookingType(bookingType)) {
    throw new AppError(
      "BOOKING_INVALID",
      "validation",
      400,
      "booking_type must be event, activity, or itinerary_item.",
    );
  }
  writeJson(context.response, 200, {
    ...quoteBooking(bookingType),
    request_id: context.requestId,
  });
  return true;
};
