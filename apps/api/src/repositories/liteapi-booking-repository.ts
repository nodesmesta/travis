import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { AppError } from "../errors.js";
import type {
  AgendaItem,
  Booking,
  ContextPoint,
  Database,
  JourneyLeg,
  Payment,
  ProviderBooking,
  ProviderBookingInsert,
  ProviderBookingUpdate,
  Trip,
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

  // -------------------------------------------------------------------------
  // The trip a booking belongs to. A confirmed ticket fills the trip's window
  // and adds itself to the itinerary, so booking and planning stay one action.

  public async getTrip(tripId: string): Promise<Trip | null> {
    const { data, error } = await this.client
      .from("trips")
      .select("*")
      .eq("id", tripId)
      .maybeSingle();
    if (error) throw persistenceFailure("trips.get_for_booking");
    return data;
  }

  public async updateTripForBooking(
    tripId: string,
    patch: Pick<Trip, "start_at" | "end_at" | "status">,
  ): Promise<Trip> {
    const { data, error } = await this.client
      .from("trips")
      .update(patch)
      .eq("id", tripId)
      .select("*")
      .single();
    if (error || !data) throw persistenceFailure("trips.update_for_booking");
    return data;
  }

  public async findAgendaForProviderBooking(
    tripId: string,
    providerBookingId: string,
  ): Promise<AgendaItem | null> {
    const { data, error } = await this.client
      .from("agenda_items")
      .select("*")
      .eq("trip_id", tripId)
      .filter("metadata->>provider_booking_id", "eq", providerBookingId)
      .maybeSingle();
    if (error) throw persistenceFailure("agenda_items.get_for_booking");
    return data;
  }

  /**
   * The place a booked item happens at, found by the provider id it came from, so
   * booking the same hotel twice reuses one location instead of piling up duplicates.
   */
  public async findContextPointForPlace(
    tripId: string,
    externalPlaceId: string,
  ): Promise<ContextPoint | null> {
    const { data, error } = await this.client
      .from("context_points")
      .select("*")
      .eq("trip_id", tripId)
      .eq("external_place_id", externalPlaceId)
      .maybeSingle();
    if (error) throw persistenceFailure("context_points.get_for_booking");
    return data;
  }

  public async createContextPoint(
    input: Database["public"]["Tables"]["context_points"]["Insert"],
  ): Promise<ContextPoint> {
    const { data, error } = await this.client
      .from("context_points")
      .insert(input)
      .select("*")
      .single();
    if (error || !data) throw persistenceFailure("context_points.create_for_booking");
    return data;
  }

  public async updateContextPoint(
    id: string,
    tripId: string,
    patch: Database["public"]["Tables"]["context_points"]["Update"],
  ): Promise<ContextPoint> {
    const { data, error } = await this.client
      .from("context_points")
      .update(patch)
      .eq("id", id)
      .eq("trip_id", tripId)
      .select("*")
      .single();
    if (error || !data) throw persistenceFailure("context_points.update_for_booking");
    return data;
  }

  public async listContextPoints(tripId: string): Promise<ContextPoint[]> {
    const { data, error } = await this.client
      .from("context_points")
      .select("*")
      .eq("trip_id", tripId)
      .eq("status", "active");
    if (error) throw persistenceFailure("context_points.list_for_booking");
    return data ?? [];
  }

  public async listJourneyLegs(tripId: string): Promise<JourneyLeg[]> {
    const { data, error } = await this.client
      .from("journey_legs")
      .select("*")
      .eq("trip_id", tripId);
    if (error) throw persistenceFailure("journey_legs.list_for_booking");
    return data ?? [];
  }

  public async listAgenda(tripId: string): Promise<AgendaItem[]> {
    const { data, error } = await this.client
      .from("agenda_items")
      .select("*")
      .eq("trip_id", tripId)
      .order("start_at", { ascending: true });
    if (error) throw persistenceFailure("agenda_items.list_for_booking");
    return data ?? [];
  }

  public async createJourneyLeg(
    input: Database["public"]["Tables"]["journey_legs"]["Insert"],
  ): Promise<JourneyLeg> {
    const { data, error } = await this.client
      .from("journey_legs")
      .insert(input)
      .select("*")
      .single();
    if (error || !data) throw persistenceFailure("journey_legs.create_for_booking");
    return data;
  }

  public async updateJourneyLeg(
    id: string,
    tripId: string,
    patch: Database["public"]["Tables"]["journey_legs"]["Update"],
  ): Promise<JourneyLeg> {
    const { data, error } = await this.client
      .from("journey_legs")
      .update(patch)
      .eq("id", id)
      .eq("trip_id", tripId)
      .select("*")
      .single();
    if (error || !data) throw persistenceFailure("journey_legs.update_for_booking");
    return data;
  }

  public async createAgendaItem(
    input: Database["public"]["Tables"]["agenda_items"]["Insert"],
  ): Promise<AgendaItem> {
    const { data, error } = await this.client
      .from("agenda_items")
      .insert(input)
      .select("*")
      .single();
    if (error || !data) throw persistenceFailure("agenda_items.create_for_booking");
    return data;
  }

  public async updateAgendaItem(
    id: string,
    tripId: string,
    patch: Database["public"]["Tables"]["agenda_items"]["Update"],
  ): Promise<AgendaItem> {
    const { data, error } = await this.client
      .from("agenda_items")
      .update(patch)
      .eq("id", id)
      .eq("trip_id", tripId)
      .select("*")
      .single();
    if (error || !data) throw persistenceFailure("agenda_items.update_for_booking");
    return data;
  }
}
