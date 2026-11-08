import {
  ExternalDataError,
  LiteApiClient,
  type FlightBooking,
  type FlightPassenger,
  type HotelBooking,
  type HotelGuest,
  type Person,
} from "@travelflow/integrations";
import { randomUUID } from "node:crypto";
import { AppError } from "../errors.js";
import {
  LiteApiBookingRepository,
  type ProviderAttemptInput,
} from "../repositories/liteapi-booking-repository.js";
import type { Booking, ProviderBooking } from "../supabase/database.types.js";

function providerFailure(error: unknown): boolean {
  return (
    error instanceof ExternalDataError &&
    error.code === "EXTERNAL_PROVIDER_TIMEOUT"
  );
}

/** The provider's own error code, e.g. 4005 for a duplicate client reference. */
function providerErrorCode(error: unknown): number | string | null {
  if (!(error instanceof ExternalDataError)) return null;
  const details = error.details;
  if (!details || typeof details !== "object") return null;
  const providerError = (details as Record<string, unknown>).provider_error;
  if (!providerError || typeof providerError !== "object") return null;
  const code = (providerError as Record<string, unknown>).code;
  return typeof code === "number" || typeof code === "string" ? code : null;
}

function duplicateClientReference(error: unknown): boolean {
  return String(providerErrorCode(error)) === "4005";
}

export interface ProviderAttemptResult {
  booking: Booking;
  provider_booking: ProviderBooking;
}

export interface HotelPrebookResult extends ProviderAttemptResult {
  kind: "hotel";
  prebook: Awaited<ReturnType<LiteApiClient["prebookHotel"]>>;
}

export interface FlightPrebookResult extends ProviderAttemptResult {
  kind: "flight";
  prebook: Awaited<ReturnType<LiteApiClient["prebookFlight"]>>;
  verification: Awaited<ReturnType<LiteApiClient["verifyFlight"]>>;
}

export class LiteApiBookingService {
  public constructor(
    private readonly repository: LiteApiBookingRepository,
    private readonly client: LiteApiClient,
  ) {}

  public async prebookHotel(input: {
    userId: string;
    tripId: string;
    offerId: string;
  }): Promise<HotelPrebookResult> {
    const prebook = await this.client.prebookHotel({ offer_id: input.offerId });
    const attempt: ProviderAttemptInput = {
      user_id: input.userId,
      trip_id: input.tripId,
      booking_type: "hotel",
      offer_id: input.offerId,
      prebook_id: prebook.prebook_id,
      client_reference: `travelflow-${randomUUID()}`,
      currency: prebook.total.currency,
      subtotal: prebook.total.amount,
      checkin: prebook.checkin,
      checkout: prebook.checkout,
    };
    const created = await this.repository.createAttempt(attempt);
    const providerBooking = await this.repository.updateProviderBooking(
      created.providerBooking.id,
      input.tripId,
      {
        provider_status: "PREBOOKED",
        state: "prebooked",
        metadata: {
          price_difference_percent: prebook.price_difference_percent,
          cancellation_changed: prebook.cancellation_changed,
          board_changed: prebook.board_changed,
        },
      },
    );
    return {
      kind: "hotel",
      ...created,
      provider_booking: providerBooking,
      prebook,
    };
  }

  public async prebookFlight(input: {
    userId: string;
    tripId: string;
    offerId: string;
    purpose: "BUSINESS" | "LEISURE";
    contact: Person & { phone_country_code: string; phone_number: string };
    passengers: FlightPassenger[];
  }): Promise<FlightPrebookResult> {
    // The provider asks for a verify before every prebook so the price the
    // guest is about to pay is the price the airline will honour.
    const verification = await this.client.verifyFlight(input.offerId);
    const prebook = await this.client.prebookFlight({
      offer_id: input.offerId,
      purpose: input.purpose,
      contact: input.contact,
      passengers: input.passengers,
    });
    const attempt: ProviderAttemptInput = {
      user_id: input.userId,
      trip_id: input.tripId,
      booking_type: "flight",
      offer_id: input.offerId,
      prebook_id: prebook.prebook_id,
      client_reference: `travelflow-${randomUUID()}`,
      currency: prebook.total.currency,
      subtotal: prebook.total.amount,
    };
    const created = await this.repository.createAttempt(attempt);
    const providerBooking = await this.repository.updateProviderBooking(
      created.providerBooking.id,
      input.tripId,
      { provider_status: "PREBOOKED", state: "prebooked" },
    );
    return {
      kind: "flight",
      ...created,
      provider_booking: providerBooking,
      prebook,
      verification,
    };
  }

  public async bookHotel(input: {
    userId: string;
    tripId: string;
    providerBookingId: string;
    holder: Person & { phone: string };
    guests: HotelGuest[];
  }): Promise<{
    booking: Booking;
    provider_booking: ProviderBooking;
    provider: HotelBooking;
  }> {
    const attempt = await this.requireAttempt(input);
    if (attempt.booking_type !== "hotel" || !attempt.prebook_id) {
      throw new AppError(
        "PROVIDER_BOOKING_STATE_INVALID",
        "conflict",
        409,
        "This is not a prebooked hotel.",
      );
    }
    if (attempt.state === "confirmed") {
      throw new AppError(
        "PROVIDER_BOOKING_ALREADY_FINAL",
        "conflict",
        409,
        "This hotel provider booking is already confirmed.",
      );
    }
    await this.requirePaid(attempt.booking_id);
    await this.repository.updateProviderBooking(attempt.id, input.tripId, {
      state: "booking",
      provider_status: "BOOKING",
    });
    try {
      const provider = await this.client
        .bookHotel({
          prebook_id: attempt.prebook_id,
          client_reference: attempt.client_reference,
          holder: input.holder,
          guests: input.guests,
        })
        // A retry after a timeout can reach a booking that the first attempt
        // already created. The provider answers 4005 for that duplicate
        // reference, so adopt the booking it points at instead of failing.
        .catch(async (error: unknown) => {
          if (!duplicateClientReference(error)) throw error;
          const existing = await this.client.findHotelBookingByClientReference(
            attempt.client_reference,
          );
          // Only a live reservation can be adopted. A cancelled one means the
          // reference is burnt, so the original failure stays visible.
          if (!existing || existing.state !== "confirmed") throw error;
          return existing;
        });
      const state =
        provider.state === "confirmed" ? "confirmed" : provider.state;
      const providerBooking = await this.repository.updateProviderBooking(
        attempt.id,
        input.tripId,
        {
          provider_booking_id: provider.booking_id,
          provider_status: provider.provider_status,
          last_reconciled_at: new Date().toISOString(),
          state,
          confirmation_code: provider.confirmation_code,
          currency: provider.total.currency,
          subtotal: provider.total.amount,
          total: provider.total.amount,
          cancellation_fee: 0,
          metadata: {
            sandbox: provider.sandbox,
            hotel_id: provider.hotel_id,
            hotel_name: provider.hotel_name,
          },
        },
      );
      const booking = await this.repository.updateLocalBooking(
        attempt.booking_id,
        input.tripId,
        {
          status: state === "confirmed" ? "confirmed" : "paid",
          confirmation_code: provider.confirmation_code,
          currency: provider.total.currency,
          subtotal: provider.total.amount,
          tax: 0,
          total: provider.total.amount,
        },
      );
      return { booking, provider_booking: providerBooking, provider };
    } catch (error) {
      await this.repository.updateProviderBooking(attempt.id, input.tripId, {
        state: providerFailure(error) ? "unknown" : "failed",
        provider_status: providerFailure(error) ? "UNKNOWN" : "FAILED",
      });
      throw error;
    }
  }

  public async bookFlight(input: {
    userId: string;
    tripId: string;
    providerBookingId: string;
  }): Promise<{
    booking: Booking;
    provider_booking: ProviderBooking;
    provider: FlightBooking;
  }> {
    const attempt = await this.requireAttempt(input);
    if (attempt.booking_type !== "flight" || !attempt.prebook_id) {
      throw new AppError(
        "PROVIDER_BOOKING_STATE_INVALID",
        "conflict",
        409,
        "This is not a prebooked flight.",
      );
    }
    if (attempt.state === "confirmed") {
      throw new AppError(
        "PROVIDER_BOOKING_ALREADY_FINAL",
        "conflict",
        409,
        "This flight provider booking is already confirmed.",
      );
    }
    await this.requirePaid(attempt.booking_id);
    await this.repository.updateProviderBooking(attempt.id, input.tripId, {
      state: "booking",
      provider_status: "BOOKING",
    });
    try {
      const provider = await this.client.bookFlight({
        prebook_id: attempt.prebook_id,
      });
      const state =
        provider.state === "confirmed"
          ? "confirmed"
          : provider.state === "pending"
            ? "pending"
            : provider.state;
      const providerBooking = await this.repository.updateProviderBooking(
        attempt.id,
        input.tripId,
        {
          provider_booking_id: provider.booking_id,
          provider_status: provider.provider_status,
          last_reconciled_at: new Date().toISOString(),
          state,
          confirmation_code: provider.booking_reference,
          currency: provider.total.currency,
          subtotal: provider.total.amount,
          total: provider.total.amount,
        },
      );
      const booking = await this.repository.updateLocalBooking(
        attempt.booking_id,
        input.tripId,
        {
          status: state === "confirmed" ? "confirmed" : "paid",
          confirmation_code: provider.booking_reference,
          currency: provider.total.currency,
          subtotal: provider.total.amount,
          tax: 0,
          total: provider.total.amount,
        },
      );
      return { booking, provider_booking: providerBooking, provider };
    } catch (error) {
      await this.repository.updateProviderBooking(attempt.id, input.tripId, {
        state: providerFailure(error) ? "unknown" : "failed",
        provider_status: providerFailure(error) ? "UNKNOWN" : "FAILED",
      });
      throw error;
    }
  }

  public async getHotel(input: { tripId: string; providerBookingId: string }) {
    const attempt = await this.requireAttempt(input);
    if (attempt.booking_type !== "hotel" || !attempt.provider_booking_id) {
      throw new AppError(
        "PROVIDER_BOOKING_NOT_READY",
        "conflict",
        409,
        "The hotel has no provider booking yet.",
      );
    }
    const provider = await this.client.getHotelBooking(
      attempt.provider_booking_id,
    );
    return this.persistProviderState(
      attempt,
      provider.state,
      provider.provider_status,
      provider.booking_id,
      provider.confirmation_code,
      provider.total.amount,
      provider.total.currency,
    );
  }

  /**
   * Attaches the seats the passenger picked to the provider prebook and keeps our
   * totals in step, so the payment step charges what the carrier now expects.
   */
  public async attachFlightSeats(input: {
    userId: string;
    tripId: string;
    providerBookingId: string;
    seats: Array<{ passenger_index: number; service_id: string }>;
  }): Promise<{
    total: { amount: number; currency: string };
    seat_count: number;
    booking: Booking;
    provider_booking: ProviderBooking;
  }> {
    const attempt = await this.requireAttempt(input);
    if (attempt.booking_type !== "flight" || !attempt.prebook_id) {
      throw new AppError(
        "PROVIDER_BOOKING_NOT_READY",
        "conflict",
        409,
        "This is not a prebooked flight.",
      );
    }
    if (attempt.state === "confirmed") {
      throw new AppError(
        "PROVIDER_BOOKING_ALREADY_FINAL",
        "conflict",
        409,
        "Seats cannot change after the ticket was issued.",
      );
    }
    const result = await this.client.attachFlightServices({
      prebook_id: attempt.prebook_id,
      seats: input.seats,
    });
    const providerBooking = await this.repository.updateProviderBooking(
      attempt.id,
      input.tripId,
      {
        currency: result.total.currency,
        subtotal: result.total.amount,
        total: result.total.amount,
      },
    );
    const booking = await this.repository.updateLocalBooking(
      attempt.booking_id,
      input.tripId,
      {
        currency: result.total.currency,
        subtotal: result.total.amount,
        total: result.total.amount,
      },
    );
    return {
      total: result.total,
      seat_count: result.seat_count,
      booking,
      provider_booking: providerBooking,
    };
  }

  public async getFlight(input: { tripId: string; providerBookingId: string }) {
    const attempt = await this.requireAttempt(input);
    if (attempt.booking_type !== "flight" || !attempt.provider_booking_id) {
      throw new AppError(
        "PROVIDER_BOOKING_NOT_READY",
        "conflict",
        409,
        "The flight has no provider booking yet.",
      );
    }
    const provider = await this.client.getFlightBooking(
      attempt.provider_booking_id,
    );
    return this.persistProviderState(
      attempt,
      provider.state,
      provider.provider_status,
      provider.booking_id,
      provider.booking_reference,
      provider.total.amount,
      provider.total.currency,
    );
  }

  public async cancelHotel(input: {
    tripId: string;
    providerBookingId: string;
  }) {
    const attempt = await this.requireAttempt(input);
    if (attempt.booking_type !== "hotel" || !attempt.provider_booking_id)
      throw new AppError(
        "PROVIDER_BOOKING_NOT_READY",
        "conflict",
        409,
        "The hotel has no provider booking yet.",
      );
    const provider = await this.client.cancelHotelBooking(
      attempt.provider_booking_id,
    );
    const updated = await this.repository.updateProviderBooking(
      attempt.id,
      input.tripId,
      {
        state: provider.state,
        provider_status: provider.state.toUpperCase(),
        cancellation_fee: provider.fee.amount,
        refund_amount: provider.refund.amount,
      },
    );
    const booking = await this.repository.updateLocalBooking(
      attempt.booking_id,
      input.tripId,
      {
        status: "cancelled",
        cancelled_at: new Date().toISOString(),
      },
    );
    return { booking, provider_booking: updated, provider };
  }

  public async cancelFlight(input: {
    tripId: string;
    providerBookingId: string;
  }) {
    const attempt = await this.requireAttempt(input);
    if (attempt.booking_type !== "flight" || !attempt.provider_booking_id)
      throw new AppError(
        "PROVIDER_BOOKING_NOT_READY",
        "conflict",
        409,
        "The flight has no provider booking yet.",
      );
    const provider = await this.client.cancelFlightBooking(
      attempt.provider_booking_id,
    );
    const updated = await this.repository.updateProviderBooking(
      attempt.id,
      input.tripId,
      {
        state: "cancel_requested",
        provider_status: "CANCELLATION_REQUESTED",
        cancellation_fee: provider.fee.amount,
        refund_amount: provider.refund.amount,
      },
    );
    return {
      booking: await this.repository.getLocalBooking(
        attempt.booking_id,
        input.tripId,
      ),
      provider_booking: updated,
      provider,
    };
  }

  private async persistProviderState(
    attempt: ProviderBooking,
    state: ProviderBooking["state"],
    providerStatus: string,
    providerBookingId: string,
    confirmationCode: string | null,
    total: number,
    currency: string,
  ) {
    const providerBooking = await this.repository.updateProviderBooking(
      attempt.id,
      attempt.trip_id,
      {
        state,
        provider_status: providerStatus,
        provider_booking_id: providerBookingId,
        confirmation_code: confirmationCode,
        total,
        subtotal: total,
        currency,
        last_reconciled_at: new Date().toISOString(),
      },
    );
    const booking = await this.repository.updateLocalBooking(
      attempt.booking_id,
      attempt.trip_id,
      {
        status: state === "confirmed" ? "confirmed" : "paid",
        confirmation_code: confirmationCode,
        total,
        subtotal: total,
        currency,
      },
    );
    return { booking, provider_booking: providerBooking };
  }

  private async requireAttempt(input: {
    tripId: string;
    providerBookingId: string;
  }): Promise<ProviderBooking> {
    const attempt = await this.repository.getProviderBooking(
      input.providerBookingId,
      input.tripId,
    );
    if (!attempt)
      throw new AppError(
        "RESOURCE_NOT_FOUND",
        "not_found",
        404,
        "Provider booking was not found.",
      );
    return attempt;
  }

  private async requirePaid(bookingId: string): Promise<void> {
    const payment = await this.repository.getBookingPayment(bookingId);
    if (!payment || payment.status !== "succeeded") {
      throw new AppError(
        "PAYMENT_REQUIRED",
        "conflict",
        409,
        "Complete the sandbox payment before booking with LiteAPI.",
      );
    }
  }
}
