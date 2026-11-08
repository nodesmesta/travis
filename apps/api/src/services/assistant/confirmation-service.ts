import { createHash, randomBytes } from "node:crypto";
import {
  ACTION_ENTITY_TYPE,
  formatInZone,
  validateSchema,
  type AgendaItemRecord,
  type CommandContext,
  type ConfirmationAction,
  type ConfirmationRequestView,
  type CreateAgendaItemInput,
} from "@travelflow/domain";
import { AppError } from "../../errors.js";
import { stableValue } from "../../http.js";
import {
  refusalError,
  type SupabaseConfirmationRepository,
} from "../../repositories/confirmation-repository.js";
import {
  RECOMMENDATION_FINAL_STATUSES,
  RECOMMENDATION_STATUS_AFTER,
  type RecommendationRecord,
  type SupabaseRecommendationRepository,
} from "../../repositories/recommendation-repository.js";
import type { SupabaseActivityLogWriter } from "../../repositories/domain-persistence.js";

export function newConfirmationToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashConfirmationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Hash of what the user was shown. A change after issuing invalidates the token. */
export function hashConfirmationPayload(snapshot: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(snapshot)), "utf8")
    .digest("hex");
}

export interface ConfirmationServiceDependencies {
  confirmations: SupabaseConfirmationRepository;
  recommendations: SupabaseRecommendationRepository;
  activityLog: SupabaseActivityLogWriter;
  createAgendaItem: (
    input: CreateAgendaItemInput,
    command: CommandContext,
  ) => Promise<AgendaItemRecord>;
  ttlMinutes: number;
  now?: () => Date;
}

export interface IssueConfirmationInput {
  userId: string;
  tripId: string;
  tripTimezone: string;
  conversationId: string | null;
  action: ConfirmationAction;
  entityId: string;
}

const RECOMMENDATION_ITEM_SCHEMA = {
  type: "object",
  required: ["title", "start_at", "end_at", "timezone"],
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1, maxLength: 300 },
    type: {
      type: "string",
      enum: [
        "flight",
        "train",
        "meeting",
        "conference",
        "event",
        "meal",
        "hotel_check_in",
        "hotel_check_out",
        "free_time",
        "custom",
      ],
    },
    start_at: { type: "string", format: "date-time" },
    end_at: { type: "string", format: "date-time" },
    timezone: { type: "string", minLength: 1 },
    context_point_id: { type: "string", minLength: 1 },
  },
} as const;

function notFound(what: string): AppError {
  return new AppError(
    "RESOURCE_NOT_FOUND",
    "not_found",
    404,
    `${what} was not found.`,
  );
}

function recommendationLabel(recommendation: RecommendationRecord): string {
  const title = recommendation.payload.title;
  if (typeof title === "string" && title.length > 0) return title.slice(0, 120);
  if (recommendation.reason) return recommendation.reason.slice(0, 120);
  return `${recommendation.recommendation_type} recommendation`;
}

/**
 * Issues and redeems confirmation tokens. A mutation never runs unless the
 * caller holds an unexpired, unused token bound to their user, the trip, the
 * action, the entity, and the state they were shown.
 */
export class ConfirmationService {
  public constructor(private readonly deps: ConfirmationServiceDependencies) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private assertActionable(
    recommendation: RecommendationRecord,
    action: ConfirmationAction,
  ): void {
    const final = RECOMMENDATION_FINAL_STATUSES as readonly string[];
    if (final.includes(recommendation.status)) {
      throw new AppError(
        "RECOMMENDATION_STATE_INVALID",
        "conflict",
        409,
        `This recommendation is already ${recommendation.status}.`,
      );
    }
    if (
      action !== "dismiss_recommendation" &&
      recommendation.expires_at &&
      Date.parse(recommendation.expires_at) <= this.now().getTime()
    ) {
      throw new AppError(
        "RECOMMENDATION_EXPIRED",
        "conflict",
        409,
        "This recommendation has expired. Ask for a new one.",
      );
    }
    if (action === "save_recommendation" && recommendation.status === "saved") {
      throw new AppError(
        "RECOMMENDATION_STATE_INVALID",
        "conflict",
        409,
        "This recommendation is already saved.",
      );
    }
  }

  private recommendationSnapshot(
    recommendation: RecommendationRecord,
    action: ConfirmationAction,
  ): unknown {
    return {
      action,
      trip_id: recommendation.trip_id,
      id: recommendation.id,
      status: recommendation.status,
      payload: recommendation.payload,
    };
  }

  private eventSnapshot(
    row: {
      id: string;
      trip_id: string;
      title: string;
      starts_at: string;
      status: string;
    },
    action: ConfirmationAction,
  ): unknown {
    return {
      action,
      trip_id: row.trip_id,
      id: row.id,
      title: row.title,
      starts_at: new Date(row.starts_at).toISOString(),
      status: row.status,
    };
  }

  /**
   * The itinerary item a recommendation would add. A route recommendation is
   * turned into a travel block from its stored, still valid route option. Any
   * other type must carry an explicit itinerary_item in its payload.
   */
  private async itineraryFor(
    recommendation: RecommendationRecord,
  ): Promise<CreateAgendaItemInput> {
    const notApplicable = (message: string): AppError =>
      new AppError("RECOMMENDATION_NOT_APPLICABLE", "validation", 422, message);
    if (recommendation.recommendation_type === "route") {
      const route =
        await this.deps.recommendations.routeItinerarySource(recommendation);
      if (!route) {
        throw notApplicable(
          "The route behind this recommendation is no longer valid, so it cannot be added. Ask for a new route.",
        );
      }
      return {
        tripId: recommendation.trip_id,
        title: `Travel: ${route.originLabel} to ${route.destinationLabel} (${route.transportMode})`,
        type: "custom",
        startAt: route.departureAt,
        endAt: route.arriveAt,
        timezone: route.timezone,
        source: "assistant_suggestion",
        contextPointId: route.destinationContextPointId,
        metadata: {
          recommendation_id: recommendation.id,
          route_request_id: route.routeRequestId,
          route_option_id: route.routeOptionId,
          ...(route.journeyLegId ? { journey_leg_id: route.journeyLegId } : {}),
          transport_mode: route.transportMode,
        },
      };
    }
    const item = recommendation.payload.itinerary_item;
    if (validateSchema(RECOMMENDATION_ITEM_SCHEMA, item).length > 0) {
      throw notApplicable(
        "This recommendation does not describe an itinerary item, so it cannot be added.",
      );
    }
    const record = item as Record<string, string>;
    return {
      tripId: recommendation.trip_id,
      title: record.title as string,
      type: (record.type ?? "custom") as CreateAgendaItemInput["type"],
      startAt: record.start_at as string,
      endAt: record.end_at as string,
      timezone: record.timezone as string,
      source: "assistant_suggestion",
      metadata: { recommendation_id: recommendation.id },
      ...(record.context_point_id
        ? { contextPointId: record.context_point_id }
        : {}),
    };
  }

  /** Creates a confirmation request with a fresh single-use token. */
  public async issue(
    input: IssueConfirmationInput,
  ): Promise<ConfirmationRequestView> {
    const entityType = ACTION_ENTITY_TYPE[input.action];
    let summary: string;
    let payloadHash: string;

    if (entityType === "event_discovery_result") {
      const row = await this.deps.confirmations.getEventResult(
        input.tripId,
        input.entityId,
      );
      if (!row) throw notFound("Event result");
      if (row.status !== "suggested") {
        throw new AppError(
          "EVENT_RESULT_STATE_INVALID",
          "conflict",
          409,
          "Only a suggested event can be changed this way.",
        );
      }
      if (
        input.action === "save_event_result" &&
        Date.parse(row.expires_at) <= this.now().getTime()
      ) {
        throw new AppError(
          "EVENT_RESULT_EXPIRED",
          "conflict",
          409,
          "This event result has expired. Search again before saving it.",
        );
      }
      const when = formatInZone(row.starts_at, input.tripTimezone);
      summary =
        input.action === "save_event_result"
          ? `Add "${row.title}" (${when}) to your itinerary?`
          : `Mark "${row.title}" (${when}) as expired?`;
      payloadHash = hashConfirmationPayload(
        this.eventSnapshot(row, input.action),
      );
    } else {
      const recommendation = await this.deps.recommendations.get(
        input.tripId,
        input.entityId,
      );
      if (!recommendation) throw notFound("Recommendation");
      this.assertActionable(recommendation, input.action);
      if (input.action === "apply_recommendation") {
        await this.itineraryFor(recommendation);
      }
      const label = recommendationLabel(recommendation);
      summary =
        input.action === "apply_recommendation"
          ? `Add "${label}" to your itinerary?`
          : input.action === "save_recommendation"
            ? `Save "${label}" for later?`
            : `Dismiss "${label}"?`;
      payloadHash = hashConfirmationPayload(
        this.recommendationSnapshot(recommendation, input.action),
      );
    }

    const token = newConfirmationToken();
    const expiresAt = new Date(
      this.now().getTime() + this.deps.ttlMinutes * 60_000,
    ).toISOString();
    await this.deps.confirmations.insert({
      tripId: input.tripId,
      userId: input.userId,
      conversationId: input.conversationId,
      action: input.action,
      entityType,
      entityId: input.entityId,
      tokenHash: hashConfirmationToken(token),
      payloadHash,
      summary: summary.slice(0, 500),
      expiresAt,
    });
    return {
      action: input.action,
      entity_type: entityType,
      entity_id: input.entityId,
      summary: summary.slice(0, 500),
      expires_at: expiresAt,
      confirmation_token: token,
    };
  }

  /** `save` or `expire` for an event result. Token use and change are one transaction. */
  public async runEventResultAction(input: {
    userId: string;
    tripId: string;
    resultId: string;
    action: "save" | "expire";
    token: string;
  }): Promise<{ status: string; agendaItemId: string | null }> {
    const action: ConfirmationAction =
      input.action === "save" ? "save_event_result" : "expire_event_result";
    const row = await this.deps.confirmations.getEventResult(
      input.tripId,
      input.resultId,
    );
    if (!row) throw notFound("Event result");
    return this.deps.confirmations.applyEventResultAction({
      tokenHash: hashConfirmationToken(input.token),
      payloadHash: hashConfirmationPayload(this.eventSnapshot(row, action)),
      tripId: input.tripId,
      resultId: input.resultId,
      action: action as "save_event_result" | "expire_event_result",
    });
  }

  /** `save`, `apply`, or `dismiss` for a recommendation. */
  public async runRecommendationAction(input: {
    userId: string;
    tripId: string;
    recommendationId: string;
    action: "save" | "apply" | "dismiss";
    token: string;
    command: CommandContext;
  }): Promise<{ status: string; agendaItemId: string | null }> {
    const action: ConfirmationAction =
      input.action === "save"
        ? "save_recommendation"
        : input.action === "apply"
          ? "apply_recommendation"
          : "dismiss_recommendation";
    const recommendation = await this.deps.recommendations.get(
      input.tripId,
      input.recommendationId,
    );
    if (!recommendation) throw notFound("Recommendation");
    this.assertActionable(recommendation, action);

    const itinerary =
      action === "apply_recommendation"
        ? await this.itineraryFor(recommendation)
        : null;

    const tokenHash = hashConfirmationToken(input.token);
    const consumed = await this.deps.confirmations.consume({
      tokenHash,
      tripId: input.tripId,
      action,
      entityType: "recommendation",
      entityId: recommendation.id,
      payloadHash: hashConfirmationPayload(
        this.recommendationSnapshot(recommendation, action),
      ),
    });
    if (!consumed) {
      throw refusalError(
        await this.deps.confirmations.explainRefusal(tokenHash),
      );
    }

    let agendaItemId: string | null = null;
    if (itinerary) {
      const created = await this.deps.createAgendaItem(itinerary, {
        ...input.command,
        idempotencyKey: `${input.command.idempotencyKey}-agenda`.slice(0, 200),
      });
      agendaItemId = created.id;
    }
    const nextStatus =
      RECOMMENDATION_STATUS_AFTER[
        action as keyof typeof RECOMMENDATION_STATUS_AFTER
      ];
    const updated = await this.deps.recommendations.transition(
      input.tripId,
      recommendation.id,
      recommendation.status,
      nextStatus,
    );
    if (!updated) {
      throw new AppError(
        "RECOMMENDATION_STATE_INVALID",
        "conflict",
        409,
        "The recommendation changed while the action was running. Check it and try again.",
      );
    }
    await this.deps.activityLog.append({
      actorUserId: input.userId,
      action: `assistant.recommendation_${nextStatus}`,
      resourceType: "recommendation",
      resourceId: recommendation.id,
      metadata: { trip_id: input.tripId, agenda_item_id: agendaItemId },
    });
    return { status: nextStatus, agendaItemId };
  }
}
