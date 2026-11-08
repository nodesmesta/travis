import type { CommandContext } from "@travelflow/domain";
import { quoteBooking, type PricedBookingType } from "../pricing.js";
import { AppError } from "../errors.js";
import type { SupabaseTripContextRepository } from "../repositories/trip-context-repository.js";
import {
  SupabaseBookingPaymentRepository,
  type PaymentActionResult,
} from "../repositories/booking-payment-repository.js";
import type {
  SupabaseIdempotencyStore,
  SupabaseActivityLogWriter,
} from "../repositories/domain-persistence.js";
import type { Booking } from "../supabase/database.types.js";

export interface CreateBookingInput {
  tripId: string;
  userId: string;
  bookingType: PricedBookingType;
  sourceType: Booking["source_type"];
  sourceId: string;
  startsAt: string | null;
  endsAt: string | null;
}

export class BookingPaymentService {
  public constructor(
    private readonly tripRepository: SupabaseTripContextRepository,
    private readonly repository: SupabaseBookingPaymentRepository,
    private readonly idempotency: SupabaseIdempotencyStore,
    private readonly activityLog: SupabaseActivityLogWriter,
  ) {}

  public async createBooking(
    input: CreateBookingInput,
    context: CommandContext,
  ): Promise<Booking> {
    if (!input.tripId || input.userId !== context.actorUserId) {
      throw new AppError(
        "OWNERSHIP_DENIED",
        "authorization",
        403,
        "Booking ownership is invalid.",
      );
    }
    const quote = quoteBooking(input.bookingType);
    const trip = await this.tripRepository.getTripRowForUser(
      input.tripId,
      context.actorUserId,
    );
    if (!trip)
      throw new AppError(
        "RESOURCE_NOT_FOUND",
        "not_found",
        404,
        "Trip was not found.",
      );

    if (input.sourceType === "event_discovery_result") {
      const source = await this.repository.getEventResultForTrip(
        input.sourceId,
        input.tripId,
      );
      if (
        !source ||
        source.status === "expired" ||
        Date.parse(source.expires_at) <= Date.now()
      ) {
        throw new AppError(
          "BOOKING_RESOURCE_MISMATCH",
          "conflict",
          409,
          "Event is not available for booking.",
        );
      }
    } else if (input.sourceType === "agenda_item") {
      const source = await this.repository.getAgendaSourceForTrip(
        input.sourceId,
        input.tripId,
      );
      if (
        !source ||
        ["cancelled", "completed", "skipped"].includes(source.status)
      ) {
        throw new AppError(
          "BOOKING_RESOURCE_MISMATCH",
          "conflict",
          409,
          "Agenda item is not available for booking.",
        );
      }
    } else {
      // An activity is a nearby-place result (Task 08), owned by this trip.
      // Restaurants are places too but are not bookable through this flow.
      const source = await this.repository.getPlaceResultForTrip(
        input.sourceId,
        input.tripId,
      );
      if (
        !source ||
        source.category !== "activity" ||
        source.status === "expired" ||
        source.status === "rejected" ||
        Date.parse(source.expires_at) <= Date.now()
      ) {
        throw new AppError(
          "BOOKING_RESOURCE_MISMATCH",
          "conflict",
          409,
          "Activity is not available for booking.",
        );
      }
    }

    return this.idempotency.execute(
      `booking.create:${input.tripId}`,
      context,
      async () => {
        const booking = await this.repository.createBooking({
          user_id: context.actorUserId,
          trip_id: input.tripId,
          booking_type: input.bookingType,
          source_type: input.sourceType,
          source_id: input.sourceId,
          provider_name: "internal",
          status: "pending_payment",
          currency: quote.currency,
          subtotal: quote.subtotal,
          tax: quote.tax,
          total: quote.total,
          pricing_policy: quote.policy_version,
          starts_at: input.startsAt,
          ends_at: input.endsAt,
        });
        await this.activityLog.append({
          actorUserId: context.actorUserId,
          action: "booking.created",
          resourceType: "booking",
          resourceId: booking.id,
          metadata: {
            trip_id: booking.trip_id,
            source_type: booking.source_type,
            source_id: booking.source_id,
            status: booking.status,
          },
        });
        return booking;
      },
    );
  }

  public async simulatePayment(
    bookingId: string,
    tripId: string,
    input: { outcome: string; failureCode: string | null },
    context: CommandContext,
  ): Promise<PaymentActionResult> {
    await this.requireBooking(bookingId, tripId, context.actorUserId);
    return this.repository.simulatePayment({
      bookingId,
      outcome: input.outcome,
      failureCode: input.failureCode,
      idempotencyKey: context.idempotencyKey,
      requestHash: context.requestHash,
    });
  }

  public async refundPayment(
    bookingId: string,
    tripId: string,
    paymentId: string,
    context: CommandContext,
  ): Promise<PaymentActionResult> {
    await this.requireBooking(bookingId, tripId, context.actorUserId);
    return this.repository.refundPayment({
      bookingId,
      paymentId,
      idempotencyKey: context.idempotencyKey,
      requestHash: context.requestHash,
    });
  }

  private async requireBooking(
    bookingId: string,
    tripId: string,
    userId: string,
  ): Promise<Booking> {
    const booking = await this.repository.getBooking(bookingId, tripId);
    if (!booking || booking.user_id !== userId) {
      throw new AppError(
        "RESOURCE_NOT_FOUND",
        "not_found",
        404,
        "Booking was not found.",
      );
    }
    return booking;
  }
}
