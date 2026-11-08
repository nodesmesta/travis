import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../errors.js";
import type { Booking, Database, Payment } from "../supabase/database.types.js";

type UserScopedClient = SupabaseClient<Database>;

export interface BookingCreateRow {
  user_id: string;
  trip_id: string;
  booking_type: Booking["booking_type"];
  source_type: Booking["source_type"];
  source_id: string;
  provider_name: string;
  status: Booking["status"];
  currency: string;
  subtotal: number;
  tax: number;
  total: number;
  pricing_policy: string;
  starts_at: string | null;
  ends_at: string | null;
}

export interface PaymentActionResult {
  booking: Booking;
  payment: Payment;
}

function persistenceFailure(operation: string): AppError {
  return new AppError(
    "PERSISTENCE_ERROR",
    "persistence",
    500,
    "Booking or payment persistence failed.",
    { operation },
  );
}

function mapRpcError(message: string): AppError {
  const mappings: Record<
    string,
    [string, AppError["category"], number, string]
  > = {
    RESOURCE_NOT_FOUND: [
      "RESOURCE_NOT_FOUND",
      "not_found",
      404,
      "Booking was not found.",
    ],
    BOOKING_STATE_INVALID: [
      "BOOKING_STATE_INVALID",
      "conflict",
      409,
      "Booking cannot accept this payment operation.",
    ],
    PAYMENT_STATE_INVALID: [
      "PAYMENT_STATE_INVALID",
      "conflict",
      409,
      "Payment cannot accept this operation.",
    ],
    PAYMENT_DUPLICATE: [
      "PAYMENT_DUPLICATE",
      "conflict",
      409,
      "A successful payment already exists for this booking.",
    ],
    PAYMENT_SIMULATION_INVALID: [
      "PAYMENT_SIMULATION_INVALID",
      "validation",
      400,
      "Payment outcome is invalid.",
    ],
    IDEMPOTENCY_CONFLICT: [
      "IDEMPOTENCY_CONFLICT",
      "conflict",
      409,
      "The idempotency key was already used with a different request.",
    ],
    IDEMPOTENCY_IN_PROGRESS: [
      "IDEMPOTENCY_IN_PROGRESS",
      "conflict",
      409,
      "An equivalent payment request is still being processed.",
    ],
  };
  const mapping = Object.entries(mappings).find(([code]) =>
    message.includes(code),
  )?.[1];
  if (mapping) {
    return new AppError(mapping[0], mapping[1], mapping[2], mapping[3]);
  }
  return persistenceFailure("payments.rpc");
}

export class SupabaseBookingPaymentRepository {
  public constructor(private readonly client: UserScopedClient) {}

  public async createBooking(input: BookingCreateRow): Promise<Booking> {
    const { data, error } = await this.client
      .from("bookings")
      .insert(input)
      .select("*")
      .single();
    if (error?.code === "23505") {
      // bookings_active_source_unique_idx: one live booking per source.
      throw new AppError(
        "BOOKING_ALREADY_EXISTS",
        "conflict",
        409,
        "This item already has an active booking.",
      );
    }
    if (error || !data) throw persistenceFailure("bookings.create");
    return data;
  }

  public async listBookings(tripId: string): Promise<Booking[]> {
    const { data, error } = await this.client
      .from("bookings")
      .select("*")
      .eq("trip_id", tripId)
      .order("created_at", { ascending: false });
    if (error) throw persistenceFailure("bookings.list");
    return data ?? [];
  }

  public async getBooking(
    bookingId: string,
    tripId: string,
  ): Promise<Booking | null> {
    const { data, error } = await this.client
      .from("bookings")
      .select("*")
      .eq("id", bookingId)
      .eq("trip_id", tripId)
      .maybeSingle();
    if (error) throw persistenceFailure("bookings.get");
    return data;
  }

  public async listPayments(bookingId: string): Promise<Payment[]> {
    const { data, error } = await this.client
      .from("payments")
      .select("*")
      .eq("booking_id", bookingId)
      .order("created_at", { ascending: false });
    if (error) throw persistenceFailure("payments.list");
    return data ?? [];
  }

  public async simulatePayment(input: {
    bookingId: string;
    outcome: string;
    failureCode: string | null;
    idempotencyKey: string;
    requestHash: string;
  }): Promise<PaymentActionResult> {
    const { data, error } = await this.client.rpc("simulate_dummy_payment", {
      p_booking_id: input.bookingId,
      p_outcome: input.outcome,
      p_failure_code: input.failureCode,
      p_idempotency_key: input.idempotencyKey,
      p_request_hash: input.requestHash,
      p_scope: `payment.simulate:${input.bookingId}`,
    });
    if (error || !data) throw mapRpcError(error?.message ?? "unknown");
    return data as unknown as PaymentActionResult;
  }

  public async refundPayment(input: {
    bookingId: string;
    paymentId: string;
    idempotencyKey: string;
    requestHash: string;
  }): Promise<PaymentActionResult> {
    const { data, error } = await this.client.rpc("refund_dummy_payment", {
      p_booking_id: input.bookingId,
      p_payment_id: input.paymentId,
      p_idempotency_key: input.idempotencyKey,
      p_request_hash: input.requestHash,
      p_scope: `payment.refund:${input.paymentId}`,
    });
    if (error || !data) throw mapRpcError(error?.message ?? "unknown");
    return data as unknown as PaymentActionResult;
  }

  public async getEventResultForTrip(
    sourceId: string,
    tripId: string,
  ): Promise<{ status: string; expires_at: string } | null> {
    const { data, error } = await this.client
      .from("event_discovery_results")
      .select("status, expires_at")
      .eq("id", sourceId)
      .eq("trip_id", tripId)
      .maybeSingle();
    if (error) throw persistenceFailure("event_discovery.get_for_booking");
    return data;
  }

  public async getPlaceResultForTrip(
    sourceId: string,
    tripId: string,
  ): Promise<{ category: string; status: string; expires_at: string } | null> {
    const { data, error } = await this.client
      .from("place_discovery_results")
      .select("category, status, expires_at")
      .eq("id", sourceId)
      .eq("trip_id", tripId)
      .maybeSingle();
    if (error) throw persistenceFailure("place_discovery.get_for_booking");
    return data;
  }

  public async getAgendaSourceForTrip(
    sourceId: string,
    tripId: string,
  ): Promise<{ status: string } | null> {
    const { data, error } = await this.client
      .from("agenda_items")
      .select("status")
      .eq("id", sourceId)
      .eq("trip_id", tripId)
      .maybeSingle();
    if (error) throw persistenceFailure("agenda.get_for_booking");
    return data;
  }
}
