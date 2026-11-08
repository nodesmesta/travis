import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { AppError } from "../errors.js";
import type {
  Booking,
  Database,
  Payment,
  ProviderBooking,
  ProviderBookingInsert,
  ProviderBookingUpdate,
} from "../supabase/database.types.js";

type UserClient = SupabaseClient<Database>;

function persistenceFailure(operation: string): AppError {
  return new AppError(
    "PERSISTENCE_ERROR",
    "persistence",
    500,
    "LiteAPI booking persistence failed.",
    { operation },
  );
}

export interface ProviderAttemptInput {
  user_id: string;
  trip_id: string;
  booking_type: "hotel" | "flight";
  offer_id: string;
  prebook_id: string;
  client_reference: string;
  currency: string;
  subtotal: number;
  checkin?: string | null;
  checkout?: string | null;
}

export class LiteApiBookingRepository {
  public constructor(private readonly client: UserClient) {}

  public async createAttempt(
    input: ProviderAttemptInput,
  ): Promise<{ booking: Booking; providerBooking: ProviderBooking }> {
    const providerId = randomUUID();
    const bookingId = randomUUID();
    const bookingInsert = {
      id: bookingId,
      user_id: input.user_id,
      trip_id: input.trip_id,
      booking_type: input.booking_type,
      source_type: "liteapi_offer" as const,
      source_id: providerId,
      provider_name: "liteapi",
      status: "pending_payment" as const,
      currency: input.currency,
      subtotal: input.subtotal,
      tax: 0,
      total: input.subtotal,
      pricing_policy: "liteapi-sandbox-v1",
      starts_at: input.checkin ? `${input.checkin}T00:00:00Z` : null,
      ends_at: input.checkout ? `${input.checkout}T00:00:00Z` : null,
    };
    const { data: booking, error: bookingError } = await this.client
      .from("bookings")
      .insert(bookingInsert)
      .select("*")
      .single();
    if (bookingError || !booking) {
      throw persistenceFailure("bookings.provider_attempt.create");
    }
    const providerInsert: ProviderBookingInsert = {
      id: providerId,
      booking_id: booking.id,
      user_id: input.user_id,
      trip_id: input.trip_id,
      provider: "liteapi",
      booking_type: input.booking_type,
      offer_id: input.offer_id,
      prebook_id: input.prebook_id,
      client_reference: input.client_reference,
      state: "prebooked",
      currency: input.currency,
      subtotal: input.subtotal,
      tax: 0,
      total: input.subtotal,
      checkin: input.checkin ?? null,
      checkout: input.checkout ?? null,
    };
    const { data: providerBooking, error: providerError } = await this.client
      .from("provider_bookings")
      .insert(providerInsert)
      .select("*")
      .single();
    if (providerError || !providerBooking) {
      await this.client.from("bookings").delete().eq("id", booking.id);
      throw persistenceFailure("provider_bookings.create");
    }
    return { booking, providerBooking };
  }

  public async getProviderBooking(
    id: string,
    tripId: string,
  ): Promise<ProviderBooking | null> {
    const { data, error } = await this.client
      .from("provider_bookings")
      .select("*")
      .eq("id", id)
      .eq("trip_id", tripId)
      .maybeSingle();
    if (error) throw persistenceFailure("provider_bookings.get");
    return data;
  }

  public async listProviderBookings(
    tripId: string,
  ): Promise<ProviderBooking[]> {
    const { data, error } = await this.client
      .from("provider_bookings")
      .select("*")
      .eq("trip_id", tripId);
    if (error) throw persistenceFailure("provider_bookings.list");
    return data ?? [];
  }

  public async getProviderBookingByBooking(
    bookingId: string,
    tripId: string,
  ): Promise<ProviderBooking | null> {
    const { data, error } = await this.client
      .from("provider_bookings")
      .select("*")
      .eq("booking_id", bookingId)
      .eq("trip_id", tripId)
      .maybeSingle();
    if (error) throw persistenceFailure("provider_bookings.get_by_booking");
    return data;
  }

  public async getLocalBooking(
    id: string,
    tripId: string,
  ): Promise<Booking | null> {
    const { data, error } = await this.client
      .from("bookings")
      .select("*")
      .eq("id", id)
      .eq("trip_id", tripId)
      .maybeSingle();
    if (error) throw persistenceFailure("bookings.provider_get");
    return data;
  }

  public async updateProviderBooking(
    id: string,
    tripId: string,
    patch: ProviderBookingUpdate,
  ): Promise<ProviderBooking> {
    const { data, error } = await this.client
      .from("provider_bookings")
      .update(patch)
      .eq("id", id)
      .eq("trip_id", tripId)
      .select("*")
      .single();
    if (error || !data) throw persistenceFailure("provider_bookings.update");
    return data;
  }

  public async updateLocalBooking(
    id: string,
    tripId: string,
    patch: Partial<
      Pick<
        Booking,
        | "status"
        | "confirmation_code"
        | "cancelled_at"
        | "currency"
        | "subtotal"
        | "tax"
        | "total"
      >
    >,
  ): Promise<Booking> {
    const { data, error } = await this.client
      .from("bookings")
      .update(patch)
      .eq("id", id)
      .eq("trip_id", tripId)
      .select("*")
      .single();
    if (error || !data) throw persistenceFailure("bookings.provider_update");
    return data;
  }

  public async getBookingPayment(bookingId: string): Promise<Payment | null> {
    const { data, error } = await this.client
      .from("payments")
      .select("*")
      .eq("booking_id", bookingId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw persistenceFailure("payments.provider_get");
    return data;
  }
}
