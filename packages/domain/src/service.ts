import { DomainInvariantError } from "./errors.js";
import {
  assertChronology,
  assertCommandContext,
  assertCoordinates,
  assertNonBlank,
  assertSameTrip,
  assertValidTimezone,
  assertZonedDateTime,
} from "./validation.js";
import type {
  AgendaItemRecord,
  CommandContext,
  ContextPointRecord,
  ContextResolutionResult,
  CreateAgendaItemInput,
  CreateContextPointInput,
  CreateJourneyLegInput,
  JourneyLegRecord,
  ResolveContextPointInput,
  TripRecord,
} from "./types.js";

export interface TripContextRepository {
  getTripForUser(tripId: string, userId: string): Promise<TripRecord | null>;
  updateTripStatus(
    tripId: string,
    status: TripRecord["status"],
  ): Promise<TripRecord>;
  getContextPoint(contextPointId: string): Promise<ContextPointRecord | null>;
  createContextPoint(
    input: Omit<ContextPointRecord, "id">,
  ): Promise<ContextPointRecord>;
  updateContextPoint(
    contextPointId: string,
    patch: Partial<ContextPointRecord>,
  ): Promise<ContextPointRecord>;
  getAgendaItem(agendaItemId: string): Promise<AgendaItemRecord | null>;
  createAgendaItem(
    input: Omit<AgendaItemRecord, "id">,
  ): Promise<AgendaItemRecord>;
  updateAgendaItem(
    agendaItemId: string,
    patch: Partial<AgendaItemRecord>,
  ): Promise<AgendaItemRecord>;
  getJourneyLeg(journeyLegId: string): Promise<JourneyLegRecord | null>;
  updateJourneyLeg(
    journeyLegId: string,
    patch: Partial<JourneyLegRecord>,
  ): Promise<JourneyLegRecord>;
  createJourneyLeg(
    input: Omit<JourneyLegRecord, "id">,
  ): Promise<JourneyLegRecord>;
}

export interface IdempotencyStore {
  execute<T>(
    scope: string,
    context: CommandContext,
    operation: () => Promise<T>,
  ): Promise<T>;
}

export interface ActivityLogWriter {
  append(entry: {
    actorUserId: string;
    action: string;
    resourceType: string;
    resourceId: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

export interface TripContextDependencies {
  repository: TripContextRepository;
  idempotency: IdempotencyStore;
  activityLog: ActivityLogWriter;
}

export class TripContextService {
  public constructor(private readonly dependencies: TripContextDependencies) {}

  public async confirmTrip(
    tripId: string,
    context: CommandContext,
  ): Promise<TripRecord> {
    return this.transitionTrip(tripId, "confirmed", "draft", context);
  }

  public async activateTrip(
    tripId: string,
    context: CommandContext,
  ): Promise<TripRecord> {
    return this.transitionTrip(tripId, "active", "confirmed", context);
  }

  public async completeTrip(
    tripId: string,
    context: CommandContext,
  ): Promise<TripRecord> {
    return this.transitionTrip(tripId, "completed", "active", context);
  }

  private async transitionTrip(
    tripId: string,
    targetStatus: TripRecord["status"],
    expectedStatus: TripRecord["status"],
    context: CommandContext,
  ): Promise<TripRecord> {
    assertCommandContext(context);
    assertNonBlank(tripId, "tripId");
    return this.dependencies.idempotency.execute(
      `trip.transition:${tripId}:${targetStatus}`,
      context,
      async () => {
        const trip = await this.requireTrip(tripId, context.actorUserId);
        if (trip.status !== expectedStatus) {
          throw new DomainInvariantError(
            "DOMAIN_STATE_INVALID",
            `Only a ${expectedStatus} trip can become ${targetStatus}.`,
          );
        }
        const updated = await this.dependencies.repository.updateTripStatus(
          tripId,
          targetStatus,
        );
        await this.dependencies.activityLog.append({
          actorUserId: context.actorUserId,
          action: `trip.${targetStatus}`,
          resourceType: "trip",
          resourceId: updated.id,
          metadata: { previous_status: trip.status },
        });
        return updated;
      },
    );
  }

  public async createContextPoint(
    input: CreateContextPointInput,
    context: CommandContext,
  ): Promise<ContextResolutionResult> {
    assertCommandContext(context);
    assertNonBlank(input.tripId, "tripId");
    assertNonBlank(input.label, "label");
    assertValidTimezone(input.timezone);

    return this.dependencies.idempotency.execute(
      `context_point.create:${input.tripId}`,
      context,
      async () => {
        await this.requireTrip(input.tripId, context.actorUserId);
        const hasCoordinates =
          input.latitude !== undefined && input.longitude !== undefined;
        const hasPartialCoordinates =
          input.latitude !== undefined || input.longitude !== undefined;
        if (hasPartialCoordinates && !hasCoordinates) {
          throw new DomainInvariantError(
            "CONTEXT_POINT_INVALID",
            "Latitude and longitude must be provided together.",
          );
        }
        if (hasCoordinates) {
          assertCoordinates(input.latitude!, input.longitude!);
        }
        const hasExternalPlaceId = Boolean(input.externalPlaceId?.trim());
        const resolutionStatus =
          input.resolutionStatus ??
          (hasCoordinates && hasExternalPlaceId ? "resolved" : "unresolved");

        if (
          resolutionStatus === "resolved" &&
          (!hasCoordinates || !hasExternalPlaceId)
        ) {
          throw new DomainInvariantError(
            "CONTEXT_POINT_INVALID",
            "A resolved context point requires coordinates and an external place ID.",
          );
        }

        const created = await this.dependencies.repository.createContextPoint({
          tripId: input.tripId,
          type: input.type,
          label: input.label.trim(),
          address: input.address?.trim() || null,
          latitude: input.latitude ?? null,
          longitude: input.longitude ?? null,
          timezone: input.timezone,
          externalPlaceId: input.externalPlaceId?.trim() || null,
          status: "active",
          resolutionStatus,
          confirmationStatus: input.confirmationStatus ?? "unconfirmed",
          source: input.source,
          metadata: input.metadata ?? {},
        });

        await this.dependencies.activityLog.append({
          actorUserId: context.actorUserId,
          action: "context_point.created",
          resourceType: "context_point",
          resourceId: created.id,
          metadata: {
            trip_id: created.tripId,
            resolution_status: created.resolutionStatus,
          },
        });

        if (
          created.resolutionStatus === "ambiguous" ||
          created.resolutionStatus === "unresolved"
        ) {
          return {
            kind: "awaiting_clarification",
            contextPoint: created,
            clarification:
              "Please confirm the location or provide a more specific address.",
          };
        }

        return { kind: "created", contextPoint: created };
      },
    );
  }

  public async resolveContextPoint(
    contextPointId: string,
    input: ResolveContextPointInput,
    context: CommandContext,
  ): Promise<ContextPointRecord> {
    assertCommandContext(context);
    assertNonBlank(contextPointId, "contextPointId");
    assertValidTimezone(input.timezone);
    assertCoordinates(input.latitude, input.longitude);
    assertNonBlank(input.externalPlaceId, "externalPlaceId");
    if (input.label !== undefined) assertNonBlank(input.label, "label");

    return this.dependencies.idempotency.execute(
      `context_point.resolve:${contextPointId}`,
      context,
      async () => {
        const current = await this.requireContextPoint(
          contextPointId,
          context.actorUserId,
        );
        if (current.status === "archived") {
          throw new DomainInvariantError(
            "CONTEXT_POINT_INVALID",
            "An archived context point cannot be resolved.",
          );
        }
        const updated = await this.dependencies.repository.updateContextPoint(
          contextPointId,
          {
            label: input.label?.trim() ?? current.label,
            address: input.address?.trim() || current.address,
            latitude: input.latitude,
            longitude: input.longitude,
            timezone: input.timezone,
            externalPlaceId: input.externalPlaceId.trim(),
            resolutionStatus: "resolved",
          },
        );
        await this.dependencies.activityLog.append({
          actorUserId: context.actorUserId,
          action: "context_point.resolved",
          resourceType: "context_point",
          resourceId: updated.id,
          metadata: { previous_resolution_status: current.resolutionStatus },
        });
        return updated;
      },
    );
  }

  public async archiveContextPoint(
    contextPointId: string,
    context: CommandContext,
  ): Promise<ContextPointRecord> {
    assertCommandContext(context);
    assertNonBlank(contextPointId, "contextPointId");
    return this.dependencies.idempotency.execute(
      `context_point.archive:${contextPointId}`,
      context,
      async () => {
        const current = await this.requireContextPoint(
          contextPointId,
          context.actorUserId,
        );
        if (current.status !== "active") {
          throw new DomainInvariantError(
            "DOMAIN_STATE_INVALID",
            "Only an active context point can be archived.",
          );
        }
        const updated = await this.dependencies.repository.updateContextPoint(
          contextPointId,
          { status: "archived" },
        );
        await this.dependencies.activityLog.append({
          actorUserId: context.actorUserId,
          action: "context_point.archived",
          resourceType: "context_point",
          resourceId: updated.id,
        });
        return updated;
      },
    );
  }

  public async confirmContextPoint(
    contextPointId: string,
    context: CommandContext,
  ): Promise<ContextPointRecord> {
    assertCommandContext(context);
    return this.dependencies.idempotency.execute(
      `context_point.confirm:${contextPointId}`,
      context,
      async () => {
        const contextPoint = await this.requireContextPoint(
          contextPointId,
          context.actorUserId,
        );
        if (
          contextPoint.status === "archived" ||
          contextPoint.resolutionStatus !== "resolved"
        ) {
          throw new DomainInvariantError(
            "CONTEXT_POINT_INVALID",
            "Only an active, resolved context point can be confirmed.",
          );
        }
        const updated = await this.dependencies.repository.updateContextPoint(
          contextPointId,
          {
            confirmationStatus: "confirmed",
          },
        );
        await this.dependencies.activityLog.append({
          actorUserId: context.actorUserId,
          action: "context_point.confirmed",
          resourceType: "context_point",
          resourceId: updated.id,
        });
        return updated;
      },
    );
  }

  public async createAgendaItem(
    input: CreateAgendaItemInput,
    context: CommandContext,
  ): Promise<AgendaItemRecord> {
    assertCommandContext(context);
    assertNonBlank(input.tripId, "tripId");
    assertNonBlank(input.title, "title");
    assertValidTimezone(input.timezone);
    assertChronology(input.startAt, input.endAt, "startAt", "endAt");

    return this.dependencies.idempotency.execute(
      `agenda_item.create:${input.tripId}`,
      context,
      async () => {
        await this.requireTrip(input.tripId, context.actorUserId);
        if (input.contextPointId) {
          await this.requireContextPointInTrip(
            input.contextPointId,
            input.tripId,
            context.actorUserId,
          );
        }

        const created = await this.dependencies.repository.createAgendaItem({
          tripId: input.tripId,
          contextPointId: input.contextPointId ?? null,
          title: input.title.trim(),
          type: input.type,
          startAt: input.startAt,
          endAt: input.endAt,
          timezone: input.timezone,
          status: input.source === "event_discovery" ? "suggested" : "planned",
          source: input.source,
          metadata: input.metadata ?? {},
        });

        await this.dependencies.activityLog.append({
          actorUserId: context.actorUserId,
          action: "agenda_item.created",
          resourceType: "agenda_item",
          resourceId: created.id,
          metadata: { status: created.status, source: created.source },
        });
        return created;
      },
    );
  }

  public async planAgendaItem(
    agendaItemId: string,
    context: CommandContext,
  ): Promise<AgendaItemRecord> {
    assertCommandContext(context);
    return this.dependencies.idempotency.execute(
      `agenda_item.plan:${agendaItemId}`,
      context,
      async () => {
        const agenda = await this.requireAgendaItem(
          agendaItemId,
          context.actorUserId,
        );
        if (agenda.status !== "suggested") {
          throw new DomainInvariantError(
            "DOMAIN_STATE_INVALID",
            "Only a suggested agenda item can become planned.",
          );
        }
        const updated = await this.dependencies.repository.updateAgendaItem(
          agendaItemId,
          {
            status: "planned",
          },
        );
        await this.dependencies.activityLog.append({
          actorUserId: context.actorUserId,
          action: "agenda_item.planned",
          resourceType: "agenda_item",
          resourceId: updated.id,
        });
        return updated;
      },
    );
  }

  public async confirmAgendaItem(
    agendaItemId: string,
    context: CommandContext,
  ): Promise<AgendaItemRecord> {
    assertCommandContext(context);
    return this.dependencies.idempotency.execute(
      `agenda_item.confirm:${agendaItemId}`,
      context,
      async () => {
        const agenda = await this.requireAgendaItem(
          agendaItemId,
          context.actorUserId,
        );
        if (agenda.status !== "planned") {
          throw new DomainInvariantError(
            "DOMAIN_STATE_INVALID",
            "Only a planned agenda item can become confirmed.",
          );
        }
        const updated = await this.dependencies.repository.updateAgendaItem(
          agendaItemId,
          {
            status: "confirmed",
          },
        );
        await this.dependencies.activityLog.append({
          actorUserId: context.actorUserId,
          action: "agenda_item.confirmed",
          resourceType: "agenda_item",
          resourceId: updated.id,
        });
        return updated;
      },
    );
  }

  public async cancelAgendaItem(
    agendaItemId: string,
    context: CommandContext,
  ): Promise<AgendaItemRecord> {
    assertCommandContext(context);
    return this.dependencies.idempotency.execute(
      `agenda_item.cancel:${agendaItemId}`,
      context,
      async () => {
        const agenda = await this.requireAgendaItem(
          agendaItemId,
          context.actorUserId,
        );
        if (
          agenda.status !== "suggested" &&
          agenda.status !== "planned" &&
          agenda.status !== "confirmed"
        ) {
          throw new DomainInvariantError(
            "DOMAIN_STATE_INVALID",
            "Only a suggested, planned, or confirmed agenda item can be cancelled.",
          );
        }
        const updated = await this.dependencies.repository.updateAgendaItem(
          agendaItemId,
          { status: "cancelled" },
        );
        await this.dependencies.activityLog.append({
          actorUserId: context.actorUserId,
          action: "agenda_item.cancelled",
          resourceType: "agenda_item",
          resourceId: updated.id,
          metadata: { previous_status: agenda.status },
        });
        return updated;
      },
    );
  }

  public async completeAgendaItem(
    agendaItemId: string,
    context: CommandContext,
  ): Promise<AgendaItemRecord> {
    assertCommandContext(context);
    return this.dependencies.idempotency.execute(
      `agenda_item.complete:${agendaItemId}`,
      context,
      async () => {
        const agenda = await this.requireAgendaItem(
          agendaItemId,
          context.actorUserId,
        );
        if (agenda.status !== "confirmed") {
          throw new DomainInvariantError(
            "DOMAIN_STATE_INVALID",
            "Only a confirmed agenda item can be completed.",
          );
        }
        const updated = await this.dependencies.repository.updateAgendaItem(
          agendaItemId,
          { status: "completed" },
        );
        await this.dependencies.activityLog.append({
          actorUserId: context.actorUserId,
          action: "agenda_item.completed",
          resourceType: "agenda_item",
          resourceId: updated.id,
          metadata: { previous_status: agenda.status },
        });
        return updated;
      },
    );
  }

  public async createJourneyLeg(
    input: CreateJourneyLegInput,
    context: CommandContext,
  ): Promise<JourneyLegRecord> {
    assertCommandContext(context);
    assertNonBlank(input.tripId, "tripId");
    assertZonedDateTime(input.departureAt, "departureAt");
    if (input.arrivalDeadline) {
      assertZonedDateTime(input.arrivalDeadline, "arrivalDeadline");
      if (Date.parse(input.arrivalDeadline) < Date.parse(input.departureAt)) {
        throw new DomainInvariantError(
          "JOURNEY_LEG_INVALID",
          "arrivalDeadline cannot be before departureAt.",
        );
      }
    }

    return this.dependencies.idempotency.execute(
      `journey_leg.create:${input.tripId}`,
      context,
      async () => {
        await this.requireTrip(input.tripId, context.actorUserId);
        const origin = await this.requireContextPointInTrip(
          input.originContextPointId,
          input.tripId,
          context.actorUserId,
        );
        const destination = await this.requireContextPointInTrip(
          input.destinationContextPointId,
          input.tripId,
          context.actorUserId,
        );
        if (
          origin.resolutionStatus !== "resolved" ||
          destination.resolutionStatus !== "resolved"
        ) {
          throw new DomainInvariantError(
            "JOURNEY_LEG_INVALID",
            "Origin and destination must be resolved context points.",
          );
        }
        if (origin.id === destination.id) {
          throw new DomainInvariantError(
            "JOURNEY_LEG_INVALID",
            "Origin and destination must be different context points.",
          );
        }
        if (origin.status === "archived" || destination.status === "archived") {
          throw new DomainInvariantError(
            "JOURNEY_LEG_INVALID",
            "Origin and destination must be active context points.",
          );
        }
        if (input.relatedAgendaId) {
          await this.requireAgendaItem(
            input.relatedAgendaId,
            context.actorUserId,
            input.tripId,
          );
        }

        const created = await this.dependencies.repository.createJourneyLeg({
          tripId: input.tripId,
          originContextPointId: origin.id,
          destinationContextPointId: destination.id,
          relatedAgendaId: input.relatedAgendaId ?? null,
          departureAt: input.departureAt,
          arrivalDeadline: input.arrivalDeadline ?? null,
          status: "planned",
        });
        await this.dependencies.activityLog.append({
          actorUserId: context.actorUserId,
          action: "journey_leg.created",
          resourceType: "journey_leg",
          resourceId: created.id,
          metadata: {
            origin_context_point_id: created.originContextPointId,
            destination_context_point_id: created.destinationContextPointId,
          },
        });
        return created;
      },
    );
  }

  public async startJourneyLeg(
    journeyLegId: string,
    context: CommandContext,
  ): Promise<JourneyLegRecord> {
    return this.transitionJourneyLeg(
      journeyLegId,
      "in_progress",
      "planned",
      context,
    );
  }

  public async completeJourneyLeg(
    journeyLegId: string,
    context: CommandContext,
  ): Promise<JourneyLegRecord> {
    return this.transitionJourneyLeg(
      journeyLegId,
      "completed",
      "in_progress",
      context,
    );
  }

  public async cancelJourneyLeg(
    journeyLegId: string,
    context: CommandContext,
  ): Promise<JourneyLegRecord> {
    assertCommandContext(context);
    return this.dependencies.idempotency.execute(
      `journey_leg.cancel:${journeyLegId}`,
      context,
      async () => {
        const leg = await this.requireJourneyLeg(
          journeyLegId,
          context.actorUserId,
        );
        if (leg.status !== "planned" && leg.status !== "in_progress") {
          throw new DomainInvariantError(
            "DOMAIN_STATE_INVALID",
            "Only a planned or in-progress journey leg can be cancelled.",
          );
        }
        const updated = await this.dependencies.repository.updateJourneyLeg(
          journeyLegId,
          { status: "cancelled" },
        );
        await this.dependencies.activityLog.append({
          actorUserId: context.actorUserId,
          action: "journey_leg.cancelled",
          resourceType: "journey_leg",
          resourceId: updated.id,
          metadata: { previous_status: leg.status },
        });
        return updated;
      },
    );
  }

  private async transitionJourneyLeg(
    journeyLegId: string,
    targetStatus: JourneyLegRecord["status"],
    expectedStatus: JourneyLegRecord["status"],
    context: CommandContext,
  ): Promise<JourneyLegRecord> {
    assertCommandContext(context);
    return this.dependencies.idempotency.execute(
      `journey_leg.transition:${journeyLegId}:${targetStatus}`,
      context,
      async () => {
        const leg = await this.requireJourneyLeg(
          journeyLegId,
          context.actorUserId,
        );
        if (leg.status !== expectedStatus) {
          throw new DomainInvariantError(
            "DOMAIN_STATE_INVALID",
            `Only a ${expectedStatus} journey leg can become ${targetStatus}.`,
          );
        }
        const updated = await this.dependencies.repository.updateJourneyLeg(
          journeyLegId,
          { status: targetStatus },
        );
        await this.dependencies.activityLog.append({
          actorUserId: context.actorUserId,
          action: `journey_leg.${targetStatus}`,
          resourceType: "journey_leg",
          resourceId: updated.id,
          metadata: { previous_status: leg.status },
        });
        return updated;
      },
    );
  }

  private async requireTrip(
    tripId: string,
    userId: string,
  ): Promise<TripRecord> {
    const trip = await this.dependencies.repository.getTripForUser(
      tripId,
      userId,
    );
    if (!trip) {
      throw new DomainInvariantError(
        "RESOURCE_NOT_FOUND",
        "Trip was not found.",
      );
    }
    return trip;
  }

  private async requireContextPoint(
    contextPointId: string,
    userId: string,
  ): Promise<ContextPointRecord> {
    const contextPoint =
      await this.dependencies.repository.getContextPoint(contextPointId);
    if (!contextPoint) {
      throw new DomainInvariantError(
        "RESOURCE_NOT_FOUND",
        "Context point was not found.",
      );
    }
    await this.requireTrip(contextPoint.tripId, userId);
    return contextPoint;
  }

  private async requireContextPointInTrip(
    contextPointId: string,
    tripId: string,
    userId: string,
  ): Promise<ContextPointRecord> {
    const contextPoint = await this.requireContextPoint(contextPointId, userId);
    assertSameTrip(contextPoint.tripId, tripId);
    return contextPoint;
  }

  private async requireJourneyLeg(
    journeyLegId: string,
    userId: string,
  ): Promise<JourneyLegRecord> {
    const leg = await this.dependencies.repository.getJourneyLeg(journeyLegId);
    if (!leg) {
      throw new DomainInvariantError(
        "RESOURCE_NOT_FOUND",
        "Journey leg was not found.",
      );
    }
    await this.requireTrip(leg.tripId, userId);
    return leg;
  }

  private async requireAgendaItem(
    agendaItemId: string,
    userId: string,
    expectedTripId?: string,
  ): Promise<AgendaItemRecord> {
    const agenda =
      await this.dependencies.repository.getAgendaItem(agendaItemId);
    if (!agenda) {
      throw new DomainInvariantError(
        "RESOURCE_NOT_FOUND",
        "Agenda item was not found.",
      );
    }
    await this.requireTrip(agenda.tripId, userId);
    if (expectedTripId) {
      assertSameTrip(agenda.tripId, expectedTripId);
    }
    return agenda;
  }
}
