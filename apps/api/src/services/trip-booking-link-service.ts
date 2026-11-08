import type { LiteApiBookingRepository } from "../repositories/liteapi-booking-repository.js";
import type {
  Booking,
  ContextPoint,
  ProviderBooking,
} from "../supabase/database.types.js";

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

/** Where a booked item happens, as the provider describes it. */
export interface BookingPlace {
  type: "hotel" | "airport";
  /** What the traveller reads: the hotel name, or `SIN · Singapore Changi Airport`. */
  label: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  /** The provider's own id for the place: a hotel id or an IATA code. */
  externalPlaceId: string;
}

/**
 * The only source of truth for a booked place is the provider. A booking names a
 * hotel id or airport codes, not coordinates, so the coordinates are looked up
 * rather than invented.
 */
export interface BookingPlaceResolver {
  hotel(hotelId: string): Promise<BookingPlace | null>;
  airport(iata: string): Promise<BookingPlace | null>;
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

/** `value` moved by `minutes`, as an ISO instant. */
function addMinutes(value: string, minutes: number): string {
  return new Date(Date.parse(value) + minutes * 60_000).toISOString();
}

function earlier(current: string | null, candidate: string): string {
  if (!current) return candidate;
  return Date.parse(candidate) < Date.parse(current) ? candidate : current;
}

function later(current: string | null, candidate: string): string {
  if (!current) return candidate;
  return Date.parse(candidate) > Date.parse(current) ? candidate : current;
}

/** A place the provider could not describe. Kept, so the gap is visible in the data. */
interface PlaceLookup {
  place: BookingPlace | null;
  error: string | null;
}

/** What a linked booking gave the trip: the place the other services can reason about. */
export interface LinkedItem {
  contextPointId: string | null;
}

/**
 * A booking is not a separate artefact from the trip: once a ticket is issued the
 * trip gains that item, covers its dates, and gains the place it happens at.
 * Without that place neither the weather nor the alerts nor the assistant has
 * anything to reason about, so the location is part of the same write.
 *
 * Cancelling the ticket cancels the item, so the itinerary never shows a dead booking.
 */
export class TripBookingLinkService {
  public constructor(
    private readonly repository: LiteApiBookingRepository,
    private readonly places: BookingPlaceResolver | null = null,
  ) {}

  /** The hotel stay: check-in at 15:00, check-out at 12:00, in trip time. */
  public async linkHotel(input: {
    tripId: string;
    booking: Booking;
    providerBooking: ProviderBooking;
    hotelName: string | null;
  }): Promise<LinkedItem> {
    const trip = await this.repository.getTrip(input.tripId);
    if (!trip) return { contextPointId: null };
    const checkin = input.providerBooking.checkin;
    const checkout = input.providerBooking.checkout;
    if (!checkin || !checkout) return { contextPointId: null };
    const start = zonedInstant(checkin.slice(0, 10), "15:00", trip.timezone);
    const end = zonedInstant(checkout.slice(0, 10), "12:00", trip.timezone);
    const hotelId = hotelIdOf(input.providerBooking);
    const lookup = await this.lookUp(
      hotelId === null ? null : () => this.requirePlaces().hotel(hotelId),
    );
    const point = await this.placeFor(
      input.tripId,
      trip.timezone,
      lookup,
      input.providerBooking.state === "confirmed" ? "confirmed" : "unconfirmed",
    );
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
      contextPointId: point?.id ?? null,
      // A stay is indoors; the weather rules are for what the traveller does outside.
      exposure: "indoor",
      extra: {
        hotel_id: hotelId,
        checkin: input.providerBooking.checkin,
        checkout: input.providerBooking.checkout,
        ...(lookup.error === null ? {} : { context_error: lookup.error }),
      },
    });
    await this.transferLegs(input.tripId);
    return { contextPointId: point?.id ?? null };
  }

  /** The flown itinerary: first departure to last arrival, as booked. */
  public async linkFlight(input: {
    tripId: string;
    booking: Booking;
    providerBooking: ProviderBooking;
    schedule: FlightSchedule | null;
  }): Promise<LinkedItem> {
    const trip = await this.repository.getTrip(input.tripId);
    if (!trip) return { contextPointId: null };
    const segments = input.schedule?.segments ?? [];
    const first = segments[0];
    const last = segments[segments.length - 1];
    if (!first || !last) return { contextPointId: null };
    const confirmation =
      input.providerBooking.state === "confirmed" ? "confirmed" : "unconfirmed";
    // Both ends of the flight are places of the trip: the airport it leaves from and
    // the one it lands at. Without them there is no way to say how to get anywhere.
    const originLookup = await this.lookUp(() =>
      this.requirePlaces().airport(first.origin_code),
    );
    const originPoint = await this.placeFor(
      input.tripId,
      trip.timezone,
      originLookup,
      confirmation,
    );
    // The destination is where the traveller actually spends the trip.
    const lookup = await this.lookUp(() =>
      this.requirePlaces().airport(last.destination_code),
    );
    const point = await this.placeFor(
      input.tripId,
      trip.timezone,
      lookup,
      confirmation,
    );
    const start = scheduleInstant(first.departs_at, trip.timezone);
    const end = scheduleInstant(last.arrives_at, trip.timezone);
    await this.upsertItem({
      tripId: input.tripId,
      timezone: trip.timezone,
      type: "flight",
      title: `${first.origin_code} → ${last.destination_code} · ${first.carrier_name} ${first.flight_number}`,
      start,
      end,
      status: input.providerBooking.state === "confirmed" ? "confirmed" : "planned",
      bookingId: input.booking.id,
      providerBookingId: input.providerBooking.id,
      confirmationCode:
        input.providerBooking.confirmation_code ?? input.booking.confirmation_code,
      total: input.booking.total,
      currency: input.booking.currency,
      contextPointId: point?.id ?? null,
      // The flight itself is indoors; the weather matters for the days around it.
      exposure: "indoor",
      extra: {
        segments: segments.map((segment) => ({
          from: segment.origin_code,
          to: segment.destination_code,
          departs_at: segment.departs_at,
          arrives_at: segment.arrives_at,
          carrier: segment.carrier_name,
          flight_number: segment.flight_number,
        })),
        airport_codes: {
          origin: first.origin_code,
          destination: last.destination_code,
        },
        times_are_airport_local: true,
        ...(lookup.error === null ? {} : { context_error: lookup.error }),
        ...(originLookup.error === null
          ? {}
          : { origin_context_error: originLookup.error }),
      },
    });
    await this.transferLegs(input.tripId);
    return { contextPointId: point?.id ?? null };
  }

  /**
   * The travel a trip implies but nobody booked: getting from the airport to the
   * hotel after landing, and back to the airport before the flight home. They are
   * planned only from places the trip really has, so a trip without a flight or
   * without a hotel gets no invented leg.
   */
  private async transferLegs(tripId: string): Promise<void> {
    const [points, agenda, legs] = await Promise.all([
      this.repository.listContextPoints(tripId),
      this.repository.listAgenda(tripId),
      this.repository.listJourneyLegs(tripId),
    ]);
    const hotel = points.find((point) => point.type === "hotel") ?? null;
    const flight =
      agenda.find(
        (item) => item.type === "flight" && item.status !== "cancelled",
      ) ?? null;
    if (!hotel || !flight) return;
    const codes = (flight.metadata as { airport_codes?: unknown } | null)
      ?.airport_codes as { origin?: string; destination?: string } | undefined;
    const airportOf = (code: string | undefined) =>
      code === undefined
        ? null
        : (points.find(
            (point) => point.type === "airport" && point.external_place_id === code,
          ) ?? null);
    const arrivalAirport = airportOf(codes?.destination);
    const departureAirport = airportOf(codes?.origin);
    const plan: Array<{
      originId: string;
      destinationId: string;
      departureAt: string;
      agendaId: string;
    }> = [];
    if (arrivalAirport) {
      plan.push({
        originId: arrivalAirport.id,
        destinationId: hotel.id,
        // Land, collect the bag, then head for the hotel.
        departureAt: addMinutes(flight.end_at, 60),
        agendaId: flight.id,
      });
    }
    if (departureAirport) {
      plan.push({
        originId: hotel.id,
        destinationId: departureAirport.id,
        // Leave three hours before the flight, so the leg is judged against it.
        departureAt: addMinutes(flight.start_at, -180),
        agendaId: flight.id,
      });
    }
    for (const item of plan) {
      const existing = legs.find(
        (leg) =>
          leg.origin_context_point_id === item.originId &&
          leg.destination_context_point_id === item.destinationId,
      );
      if (existing) {
        if (existing.status === "cancelled") continue;
        if (Date.parse(existing.departure_at) === Date.parse(item.departureAt)) continue;
        await this.repository.updateJourneyLeg(existing.id, tripId, {
          departure_at: item.departureAt,
          related_agenda_id: item.agendaId,
        });
        continue;
      }
      await this.repository.createJourneyLeg({
        trip_id: tripId,
        origin_context_point_id: item.originId,
        destination_context_point_id: item.destinationId,
        related_agenda_id: item.agendaId,
        departure_at: item.departureAt,
        status: "planned",
      });
    }
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
    if (item.status !== "cancelled") {
      await this.repository.updateAgendaItem(item.id, input.tripId, {
        status: "cancelled",
      });
    }
    // A cancelled flight leaves no travel to plan.
    const legs = await this.repository.listJourneyLegs(input.tripId);
    for (const leg of legs) {
      if (leg.related_agenda_id !== item.id) continue;
      if (leg.status === "cancelled") continue;
      await this.repository.updateJourneyLeg(leg.id, input.tripId, {
        status: "cancelled",
      });
    }
  }

  private requirePlaces(): BookingPlaceResolver {
    if (!this.places) {
      throw new Error("The booking has no place resolver.");
    }
    return this.places;
  }

  /**
   * A provider lookup that fails must not unmake a ticket the traveller already
   * paid for. The failure is returned instead of thrown, and the caller records it
   * on the item so the missing place is visible rather than silently absent.
   */
  private async lookUp(
    resolve: (() => Promise<BookingPlace | null>) | null,
  ): Promise<PlaceLookup> {
    if (resolve === null) {
      return { place: null, error: "The booking names no place." };
    }
    try {
      const place = await resolve();
      return { place, error: place === null ? "The provider knows no location." : null };
    } catch (error) {
      return {
        place: null,
        error: error instanceof Error ? error.message : "The place lookup failed.",
      };
    }
  }

  /** The trip's location for a booked place: reused when it already exists. */
  private async placeFor(
    tripId: string,
    timezone: string,
    lookup: PlaceLookup,
    confirmation: "confirmed" | "unconfirmed",
  ): Promise<ContextPoint | null> {
    const place = lookup.place;
    if (!place) return null;
    const latitude = place.latitude;
    const longitude = place.longitude;
    const resolved = latitude !== null && longitude !== null;
    const patch = {
      type: place.type,
      label: place.label,
      address: place.address,
      latitude,
      longitude,
      resolution_status: resolved ? ("resolved" as const) : ("unresolved" as const),
      confirmation_status: confirmation,
    };
    try {
      const existing = await this.repository.findContextPointForPlace(
        tripId,
        place.externalPlaceId,
      );
      if (existing) {
        return await this.repository.updateContextPoint(existing.id, tripId, patch);
      }
      return await this.repository.createContextPoint({
        trip_id: tripId,
        timezone,
        external_place_id: place.externalPlaceId,
        source: "booking_import",
        ...patch,
      });
    } catch (error) {
      // The booking is already confirmed upstream; a location write must not fail
      // the request. The reason is handed back so the item records it.
      lookup.error =
        error instanceof Error ? error.message : "The location could not be saved.";
      return null;
    }
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
    contextPointId: string | null;
    exposure: "indoor" | "outdoor" | "both" | "unknown";
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
      // The weather rules read the exposure from here; without it nothing is evaluated.
      indoor_outdoor: input.exposure,
      ...input.extra,
    };
    const existing = await this.repository.findAgendaForProviderBooking(
      input.tripId,
      input.providerBookingId,
    );
    if (existing) {
      await this.repository.updateAgendaItem(existing.id, input.tripId, {
        context_point_id: input.contextPointId,
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
      context_point_id: input.contextPointId,
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

function hotelIdOf(providerBooking: ProviderBooking): string | null {
  const metadata = providerBooking.metadata as { hotel_id?: unknown } | null;
  const hotelId = metadata?.hotel_id;
  return typeof hotelId === "string" && hotelId.length > 0 ? hotelId : null;
}
