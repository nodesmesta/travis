import type {
  AgendaItemRecord,
  ContextPointRecord,
  CreateAgendaItemInput,
  CreateContextPointInput,
  CreateJourneyLegInput,
  JourneyLegRecord,
  TripContextRepository,
  TripRecord,
} from "@travelflow/domain";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../errors.js";
import type {
  AgendaItem,
  ContextPoint,
  Database,
  JourneyLeg,
  Json,
  Trip,
} from "../supabase/database.types.js";

type UserScopedClient = SupabaseClient<Database>;
export type TripUpdate = Database["public"]["Tables"]["trips"]["Update"];

function persistenceFailure(operation: string, message?: string): AppError {
  return new AppError(
    "PERSISTENCE_ERROR",
    "persistence",
    500,
    message ?? "The persistence operation could not be completed.",
    { operation },
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function nullableNumber(value: number | string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapTrip(row: Trip): TripRecord {
  return {
    id: row.id,
    userId: row.user_id,
    timezone: row.timezone,
    status: row.status,
  };
}

function mapContextPoint(row: ContextPoint): ContextPointRecord {
  return {
    id: row.id,
    tripId: row.trip_id,
    type: row.type,
    label: row.label,
    address: row.address,
    latitude: nullableNumber(row.latitude),
    longitude: nullableNumber(row.longitude),
    timezone: row.timezone,
    externalPlaceId: row.external_place_id,
    status: row.status,
    resolutionStatus: row.resolution_status,
    confirmationStatus: row.confirmation_status,
    source: row.source,
    metadata: asRecord(row.metadata),
  };
}

function mapAgendaItem(row: AgendaItem): AgendaItemRecord {
  return {
    id: row.id,
    tripId: row.trip_id,
    contextPointId: row.context_point_id,
    title: row.title,
    type: row.type,
    startAt: row.start_at,
    endAt: row.end_at,
    timezone: row.timezone,
    status: row.status,
    source: row.source,
    metadata: asRecord(row.metadata),
  };
}

function mapJourneyLeg(row: JourneyLeg): JourneyLegRecord {
  return {
    id: row.id,
    tripId: row.trip_id,
    originContextPointId: row.origin_context_point_id,
    destinationContextPointId: row.destination_context_point_id,
    relatedAgendaId: row.related_agenda_id,
    departureAt: row.departure_at,
    arrivalDeadline: row.arrival_deadline,
    status: row.status,
  };
}

export class SupabaseTripContextRepository implements TripContextRepository {
  public constructor(private readonly client: UserScopedClient) {}

  public async listTrips(userId: string): Promise<Trip[]> {
    const { data, error } = await this.client
      .from("trips")
      .select("*")
      .eq("user_id", userId)
      .order("start_at", { ascending: true, nullsFirst: false });

    if (error) {
      throw persistenceFailure("trips.list", "Trips could not be loaded.");
    }
    return data ?? [];
  }

  public async getTripRowForUser(
    tripId: string,
    userId: string,
  ): Promise<Trip | null> {
    const { data, error } = await this.client
      .from("trips")
      .select("*")
      .eq("id", tripId)
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      throw persistenceFailure("trips.get");
    }
    return data;
  }

  public async updateTrip(
    tripId: string,
    userId: string,
    patch: TripUpdate,
  ): Promise<Trip | null> {
    const { data, error } = await this.client
      .from("trips")
      .update(patch)
      .eq("id", tripId)
      .eq("user_id", userId)
      .select("*")
      .maybeSingle();

    if (error) {
      throw persistenceFailure("trips.update");
    }
    return data;
  }

  public async updateTripStatus(
    tripId: string,
    status: Trip["status"],
  ): Promise<TripRecord> {
    const { data, error } = await this.client
      .from("trips")
      .update({ status })
      .eq("id", tripId)
      .select("*")
      .single();

    if (error || !data) {
      throw persistenceFailure("trips.transition");
    }
    return mapTrip(data);
  }

  public async getTripForUser(
    tripId: string,
    userId: string,
  ): Promise<TripRecord | null> {
    const row = await this.getTripRowForUser(tripId, userId);
    return row ? mapTrip(row) : null;
  }

  public async getContextPoint(
    contextPointId: string,
  ): Promise<ContextPointRecord | null> {
    const { data, error } = await this.client
      .from("context_points")
      .select("*")
      .eq("id", contextPointId)
      .maybeSingle();

    if (error) {
      throw persistenceFailure("context_points.get");
    }
    return data ? mapContextPoint(data) : null;
  }

  public async listContextPointsForTrip(
    tripId: string,
    userId: string,
  ): Promise<ContextPoint[]> {
    const trip = await this.getTripRowForUser(tripId, userId);
    if (!trip) {
      return [];
    }

    const { data, error } = await this.client
      .from("context_points")
      .select("*")
      .eq("trip_id", tripId)
      .order("label", { ascending: true });

    if (error) {
      throw persistenceFailure("context_points.list");
    }
    return data ?? [];
  }

  public async createContextPoint(
    input: Omit<ContextPointRecord, "id">,
  ): Promise<ContextPointRecord> {
    const { data, error } = await this.client
      .from("context_points")
      .insert({
        trip_id: input.tripId,
        type: input.type,
        label: input.label,
        address: input.address,
        latitude: input.latitude,
        longitude: input.longitude,
        timezone: input.timezone,
        external_place_id: input.externalPlaceId,
        status: input.status,
        resolution_status: input.resolutionStatus,
        source: input.source,
        confirmation_status: input.confirmationStatus,
        metadata: input.metadata as Json,
      })
      .select("*")
      .single();

    if (error || !data) {
      throw persistenceFailure("context_points.create");
    }
    return mapContextPoint(data);
  }

  public async updateContextPoint(
    contextPointId: string,
    patch: Partial<ContextPointRecord>,
  ): Promise<ContextPointRecord> {
    const update: Database["public"]["Tables"]["context_points"]["Update"] = {};
    if (patch.type !== undefined) update.type = patch.type;
    if (patch.label !== undefined) update.label = patch.label;
    if (patch.address !== undefined) update.address = patch.address;
    if (patch.latitude !== undefined) update.latitude = patch.latitude;
    if (patch.longitude !== undefined) update.longitude = patch.longitude;
    if (patch.timezone !== undefined) update.timezone = patch.timezone;
    if (patch.externalPlaceId !== undefined) {
      update.external_place_id = patch.externalPlaceId;
    }
    if (patch.status !== undefined) update.status = patch.status;
    if (patch.resolutionStatus !== undefined) {
      update.resolution_status = patch.resolutionStatus;
    }
    if (patch.confirmationStatus !== undefined) {
      update.confirmation_status = patch.confirmationStatus;
    }
    if (patch.source !== undefined) update.source = patch.source;
    if (patch.metadata !== undefined) update.metadata = patch.metadata as Json;

    const { data, error } = await this.client
      .from("context_points")
      .update(update)
      .eq("id", contextPointId)
      .select("*")
      .single();

    if (error || !data) {
      throw persistenceFailure("context_points.update");
    }
    return mapContextPoint(data);
  }

  public async listAgendaItemsForTrip(
    tripId: string,
    userId: string,
  ): Promise<AgendaItem[]> {
    const trip = await this.getTripRowForUser(tripId, userId);
    if (!trip) return [];
    const { data, error } = await this.client
      .from("agenda_items")
      .select("*")
      .eq("trip_id", tripId)
      .order("start_at", { ascending: true });
    if (error) throw persistenceFailure("agenda_items.list");
    return data ?? [];
  }

  public async getAgendaItem(
    agendaItemId: string,
  ): Promise<AgendaItemRecord | null> {
    const { data, error } = await this.client
      .from("agenda_items")
      .select("*")
      .eq("id", agendaItemId)
      .maybeSingle();

    if (error) {
      throw persistenceFailure("agenda_items.get");
    }
    return data ? mapAgendaItem(data) : null;
  }

  public async createAgendaItem(
    input: Omit<AgendaItemRecord, "id">,
  ): Promise<AgendaItemRecord> {
    const { data, error } = await this.client
      .from("agenda_items")
      .insert({
        trip_id: input.tripId,
        context_point_id: input.contextPointId,
        title: input.title,
        type: input.type,
        start_at: input.startAt,
        end_at: input.endAt,
        timezone: input.timezone,
        status: input.status,
        source: input.source,
        metadata: input.metadata as Json,
      })
      .select("*")
      .single();

    if (error || !data) {
      throw persistenceFailure("agenda_items.create");
    }
    return mapAgendaItem(data);
  }

  public async updateAgendaItem(
    agendaItemId: string,
    patch: Partial<AgendaItemRecord>,
  ): Promise<AgendaItemRecord> {
    const update: Database["public"]["Tables"]["agenda_items"]["Update"] = {};
    if (patch.contextPointId !== undefined) {
      update.context_point_id = patch.contextPointId;
    }
    if (patch.title !== undefined) update.title = patch.title;
    if (patch.type !== undefined) update.type = patch.type;
    if (patch.startAt !== undefined) update.start_at = patch.startAt;
    if (patch.endAt !== undefined) update.end_at = patch.endAt;
    if (patch.timezone !== undefined) update.timezone = patch.timezone;
    if (patch.status !== undefined) update.status = patch.status;
    if (patch.source !== undefined) update.source = patch.source;
    if (patch.metadata !== undefined) update.metadata = patch.metadata as Json;

    const { data, error } = await this.client
      .from("agenda_items")
      .update(update)
      .eq("id", agendaItemId)
      .select("*")
      .single();

    if (error || !data) {
      throw persistenceFailure("agenda_items.update");
    }
    return mapAgendaItem(data);
  }

  public async listJourneyLegsForTrip(
    tripId: string,
    userId: string,
  ): Promise<JourneyLeg[]> {
    const trip = await this.getTripRowForUser(tripId, userId);
    if (!trip) return [];
    const { data, error } = await this.client
      .from("journey_legs")
      .select("*")
      .eq("trip_id", tripId)
      .order("departure_at", { ascending: true });
    if (error) throw persistenceFailure("journey_legs.list");
    return data ?? [];
  }

  public async getJourneyLeg(
    journeyLegId: string,
  ): Promise<JourneyLegRecord | null> {
    const { data, error } = await this.client
      .from("journey_legs")
      .select("*")
      .eq("id", journeyLegId)
      .maybeSingle();
    if (error) throw persistenceFailure("journey_legs.get");
    return data ? mapJourneyLeg(data) : null;
  }

  public async updateJourneyLeg(
    journeyLegId: string,
    patch: Partial<JourneyLegRecord>,
  ): Promise<JourneyLegRecord> {
    const update: Database["public"]["Tables"]["journey_legs"]["Update"] = {};
    if (patch.relatedAgendaId !== undefined) {
      update.related_agenda_id = patch.relatedAgendaId;
    }
    if (patch.departureAt !== undefined)
      update.departure_at = patch.departureAt;
    if (patch.arrivalDeadline !== undefined) {
      update.arrival_deadline = patch.arrivalDeadline;
    }
    if (patch.status !== undefined) update.status = patch.status;

    const { data, error } = await this.client
      .from("journey_legs")
      .update(update)
      .eq("id", journeyLegId)
      .select("*")
      .single();
    if (error || !data) throw persistenceFailure("journey_legs.update");
    return mapJourneyLeg(data);
  }

  public async createJourneyLeg(
    input: Omit<JourneyLegRecord, "id">,
  ): Promise<JourneyLegRecord> {
    const { data, error } = await this.client
      .from("journey_legs")
      .insert({
        trip_id: input.tripId,
        origin_context_point_id: input.originContextPointId,
        destination_context_point_id: input.destinationContextPointId,
        related_agenda_id: input.relatedAgendaId,
        departure_at: input.departureAt,
        arrival_deadline: input.arrivalDeadline,
        status: input.status,
      })
      .select("*")
      .single();

    if (error || !data) {
      throw persistenceFailure("journey_legs.create");
    }
    return mapJourneyLeg(data);
  }
}
