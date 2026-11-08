import type { LiteApiBookingRepository } from "../repositories/liteapi-booking-repository.js";
import type { Booking, ProviderBooking } from "../supabase/database.types.js";

/**
 * One leg of the itinerary the traveller booked, as the search showed it. The
 * provider reports airport-local times, so these strings are `YYYY-MM-DDTHH:MM`.
 */
export interface FlightScheduleSegment {
  origin_code: string;
  origin_name: string | null;
  destination_code: string;
  destination_name: string | null;
  departs_at: string;
  arrives_at: string;
  carrier_name: string;
  flight_number: string;
}

export interface FlightSchedule {
  segments: FlightScheduleSegment[];
}

/** `2026-12-01T15:00:00+07:00` for a wall-clock time in `timezone`. */
function zonedInstant(date: string, time: string, timezone: string): string {
  const probe = new Date(`${date}T${time}:00Z`);
  const zone =
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || "UTC",
      timeZoneName: "longOffset",
    })
      .formatToParts(probe)
      .find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const offset = zone.replace("GMT", "") || "+00:00";
  return `${date}T${time}:00${offset}`;
}

/** The local string the provider gave, read in the trip's timezone. */
function scheduleInstant(value: string, timezone: string): string {
  const date = value.slice(0, 10);
  const time = value.slice(11, 16);
  if (date.length !== 10 || time.length !== 5) return value;
  return zonedInstant(date, time, timezone);
}

function earlier(current: string | null, candidate: string): string {
  if (!current) return candidate;
  return Date.parse(candidate) < Date.parse(current) ? candidate : current;
}

function later(current: string | null, candidate: string): string {
  if (!current) return candidate;
  return Date.parse(candidate) > Date.parse(current) ? candidate : current;
}

/**
 * A booking is not a separate artefact from the trip: once a ticket is issued the
 * trip gains that item, covers its dates and leaves the draft state. Cancelling
 * the ticket cancels the item, so the itinerary never shows a dead booking.
 */
export class TripBookingLinkService {
  public constructor(
    private readonly repository: LiteApiBookingRepository,
  ) {}

  /** The hotel stay: check-in at 15:00, check-out at 12:00, in trip time. */
  public async linkHotel(input: {
    tripId: string;
    booking: Booking;
    providerBooking: ProviderBooking;
    hotelName: string | null;
  }): Promise<void> {
    const trip = await this.repository.getTrip(input.tripId);
    if (!trip) return;
    const checkin = input.providerBooking.checkin;
    const checkout = input.providerBooking.checkout;
    if (!checkin || !checkout) return;
    const start = zonedInstant(checkin.slice(0, 10), "15:00", trip.timezone);
    const end = zonedInstant(checkout.slice(0, 10), "12:00", trip.timezone);
    await this.upsertItem({
      tripId: input.tripId,
      timezone: trip.timezone,
      type: "hotel_check_in",
      title: `Stay at ${input.hotelName ?? "the hotel"}`,
      start,
      end,
      status: input.providerBooking.state === "confirmed" ? "confirmed" : "planned",
      bookingId: input.booking.id,
      providerBookingId: input.providerBooking.id,
      confirmationCode:
        input.providerBooking.confirmation_code ?? input.booking.confirmation_code,
      total: input.booking.total,
      currency: input.booking.currency,
      extra: {
        hotel_id: (input.providerBooking.metadata as { hotel_id?: string } | null)
          ?.hotel_id ?? null,
        checkin: input.providerBooking.checkin,
        checkout: input.providerBooking.checkout,
      },
    });
  }

  /** The flown itinerary: first departure to last arrival, as booked. */
  public async linkFlight(input: {
    tripId: string;
    booking: Booking;
    providerBooking: ProviderBooking;
    schedule: FlightSchedule | null;
  }): Promise<void> {
    const trip = await this.repository.getTrip(input.tripId);
    if (!trip) return;
    const segments = input.schedule?.segments ?? [];
    const first = segments[0];
    const last = segments[segments.length - 1];
    if (!first || !last) return;
    await this.upsertItem({
      tripId: input.tripId,
      timezone: trip.timezone,
      type: "flight",
      title: `${first.origin_code} → ${last.destination_code} · ${first.carrier_name} ${first.flight_number}`,
      start: scheduleInstant(first.departs_at, trip.timezone),
      end: scheduleInstant(last.arrives_at, trip.timezone),
      status: input.providerBooking.state === "confirmed" ? "confirmed" : "planned",
      bookingId: input.booking.id,
      providerBookingId: input.providerBooking.id,
      confirmationCode:
        input.providerBooking.confirmation_code ?? input.booking.confirmation_code,
      total: input.booking.total,
      currency: input.booking.currency,
      extra: {
        segments: segments.map((segment) => ({
          from: segment.origin_code,
          to: segment.destination_code,
          departs_at: segment.departs_at,
          arrives_at: segment.arrives_at,
          carrier: segment.carrier_name,
          flight_number: segment.flight_number,
        })),
        times_are_airport_local: true,
      },
    });
  }

  /** Cancelling the ticket takes the item off the itinerary. */
  public async release(input: {
    tripId: string;
    providerBookingId: string;
  }): Promise<void> {
    const item = await this.repository.findAgendaForProviderBooking(
      input.tripId,
      input.providerBookingId,
    );
    if (!item) return;
    if (item.status === "cancelled") return;
    await this.repository.updateAgendaItem(item.id, input.tripId, {
      status: "cancelled",
    });
  }

  private async upsertItem(input: {
    tripId: string;
    timezone: string;
    type: "hotel_check_in" | "flight";
    title: string;
    start: string;
    end: string;
    status: "confirmed" | "planned";
    bookingId: string;
    providerBookingId: string;
    confirmationCode: string | null;
    total: number;
    currency: string;
    extra: Record<string, unknown>;
  }): Promise<void> {
    // `agenda_items` requires end > start; a same-day stay would otherwise fail.
    const end =
      Date.parse(input.end) > Date.parse(input.start)
        ? input.end
        : new Date(Date.parse(input.start) + 60 * 60 * 1000).toISOString();
    const metadata = {
      provider: "liteapi",
      provider_booking_id: input.providerBookingId,
      booking_id: input.bookingId,
      confirmation_code: input.confirmationCode,
      total: input.total,
      currency: input.currency,
      ...input.extra,
    };
    const existing = await this.repository.findAgendaForProviderBooking(
      input.tripId,
      input.providerBookingId,
    );
    if (existing) {
      await this.repository.updateAgendaItem(existing.id, input.tripId, {
        title: input.title,
        start_at: input.start,
        end_at: end,
        timezone: input.timezone,
        status: input.status,
        metadata,
      });
      await this.widenTrip(input.tripId, input.start, end);
      return;
    }
    await this.repository.createAgendaItem({
      trip_id: input.tripId,
      title: input.title,
      type: input.type,
      start_at: input.start,
      end_at: end,
      timezone: input.timezone,
      status: input.status,
      source: "external_provider",
      metadata,
    });
    await this.widenTrip(input.tripId, input.start, end);
  }

  /** The trip now runs from the first booked item to the last one. */
  private async widenTrip(
    tripId: string,
    start: string,
    end: string,
  ): Promise<void> {
    const trip = await this.repository.getTrip(tripId);
    if (!trip) return;
    const startAt = earlier(trip.start_at, start) ?? start;
    const endAt = later(trip.end_at, end) ?? end;
    const status = trip.status === "draft" ? "active" : trip.status;
    if (status === trip.status && startAt === trip.start_at && endAt === trip.end_at)
      return;
    await this.repository.updateTripForBooking(tripId, {
      start_at: startAt,
      end_at: endAt,
      status,
    });
  }
}
