import { randomUUID } from "node:crypto";
import type {
  AgendaItemRecord,
  AssistantResponse,
  ConfirmationAction,
  ContextPointRecord,
  HistoryMessage,
  JourneyLegRecord,
  ResolverEventResult,
} from "@travelflow/domain";
import { AppError } from "../../errors.js";
import type { Logger } from "../../logger.js";
import {
  conversationNotFound,
  type SupabaseConversationRepository,
} from "../../repositories/conversation-repository.js";
import type { SupabaseTripContextRepository } from "../../repositories/trip-context-repository.js";
import type {
  AgendaItem,
  ContextPoint,
  JourneyLeg,
} from "../../supabase/database.types.js";
import type {
  ConversationMessageRow,
  ConversationRow,
} from "../../supabase/tables/conversation.types.js";
import type { ConfirmationService } from "./confirmation-service.js";
import {
  OrchestrationFailure,
  toAppError,
  type ExecutionTrace,
} from "./errors.js";
import type { AssistantOrchestrator } from "./orchestrator.js";
import type { ToolServices, TripSnapshotData } from "./types.js";

export const MAX_MESSAGE_CHARS = 2000;

export interface ChatServiceDependencies {
  conversations: SupabaseConversationRepository;
  trips: SupabaseTripContextRepository;
  orchestrator: AssistantOrchestrator;
  confirmations: ConfirmationService;
  toolServices: ToolServices;
  logger: Logger;
  maxContextMessages: number;
  maxToolItems: number;
}

export interface SendMessageInput {
  requestId: string;
  userId: string;
  tripId: string;
  conversationId: string | null;
  message: string;
  contextPointId: string | null;
  clientRequestKey: string;
}

export interface ChatResult {
  request_id: string;
  conversation_id: string;
  replayed?: boolean;
  user_message: SerializedMessage;
  assistant_message: SerializedMessage;
  response: AssistantResponse;
  execution: {
    execution_id: string;
    state: "completed" | "awaiting_clarification";
    intent: string;
    model?: string;
    latency_ms: number;
    planner_latency_ms?: number;
    synthesis_latency_ms?: number;
    tool_call_count: number;
    provider_call_count: number;
  };
}

export interface SerializedMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  status: ConversationMessageRow["status"];
  intent?: string;
  error_code?: string;
  request_id?: string;
  execution_id?: string;
  response?: AssistantResponse;
  tool_call_metadata?: unknown[];
  created_at: string;
}

export function serializeMessage(
  row: ConversationMessageRow,
): SerializedMessage {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    role: row.role,
    content: row.content,
    status: row.status,
    ...(row.intent ? { intent: row.intent } : {}),
    ...(row.error_code ? { error_code: row.error_code } : {}),
    ...(row.request_id ? { request_id: row.request_id } : {}),
    ...(row.execution_id ? { execution_id: row.execution_id } : {}),
    ...(row.response
      ? { response: row.response as unknown as AssistantResponse }
      : {}),
    ...(Array.isArray(row.tool_call_metadata) &&
    row.tool_call_metadata.length > 0
      ? { tool_call_metadata: row.tool_call_metadata }
      : {}),
    created_at: new Date(row.created_at).toISOString(),
  };
}

export function serializeConversation(
  row: ConversationRow,
): Record<string, unknown> {
  return {
    id: row.id,
    trip_id: row.trip_id,
    active_context_point_id: row.active_context_point_id,
    title: row.title,
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

/** The raw confirmation token is shown to the client once and never stored. */
function withoutToken(response: AssistantResponse): AssistantResponse {
  if (!response.confirmation_request) return response;
  const { confirmation_token: _token, ...stored } =
    response.confirmation_request;
  return { ...response, confirmation_request: stored };
}

function numberOrNull(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toContextPointRecord(row: ContextPoint): ContextPointRecord {
  return {
    id: row.id,
    tripId: row.trip_id,
    type: row.type,
    label: row.label,
    address: row.address,
    latitude: numberOrNull(row.latitude),
    longitude: numberOrNull(row.longitude),
    timezone: row.timezone,
    externalPlaceId: row.external_place_id,
    status: row.status,
    resolutionStatus: row.resolution_status,
    confirmationStatus: row.confirmation_status,
    source: row.source,
    metadata:
      row.metadata &&
      typeof row.metadata === "object" &&
      !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {},
  };
}

function toAgendaRecord(row: AgendaItem): AgendaItemRecord {
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
    metadata:
      row.metadata &&
      typeof row.metadata === "object" &&
      !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {},
  };
}

function toJourneyLegRecord(row: JourneyLeg): JourneyLegRecord {
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

function titleFrom(message: string): string {
  const trimmed = message.trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed;
}

export class ChatWithAssistantService {
  public constructor(private readonly deps: ChatServiceDependencies) {}

  public async createConversation(input: {
    userId: string;
    tripId: string;
    activeContextPointId: string | null;
    title: string | null;
  }): Promise<ConversationRow> {
    await this.requireTrip(input.tripId, input.userId);
    if (input.activeContextPointId) {
      await this.requireContextPoint(
        input.tripId,
        input.userId,
        input.activeContextPointId,
      );
    }
    return this.deps.conversations.createConversation({
      tripId: input.tripId,
      activeContextPointId: input.activeContextPointId,
      title: input.title,
    });
  }

  public async listConversations(
    tripId: string,
    userId: string,
  ): Promise<ConversationRow[]> {
    await this.requireTrip(tripId, userId);
    return this.deps.conversations.listConversations(tripId);
  }

  public async getConversationDetail(
    tripId: string,
    userId: string,
    conversationId: string,
  ): Promise<{
    conversation: ConversationRow;
    messages: ConversationMessageRow[];
  }> {
    await this.requireTrip(tripId, userId);
    const conversation = await this.deps.conversations.getConversation(
      tripId,
      conversationId,
    );
    if (!conversation) throw conversationNotFound();
    const messages = await this.deps.conversations.listMessages(conversationId);
    return { conversation, messages };
  }

  /** Chat shortcut: use the given or newest active conversation, or start one. */
  public async chat(input: SendMessageInput): Promise<ChatResult> {
    await this.requireTrip(input.tripId, input.userId);
    let conversationId = input.conversationId;
    if (!conversationId) {
      const latest = await this.deps.conversations.latestActiveConversation(
        input.tripId,
      );
      conversationId = (
        latest ??
        (await this.deps.conversations.createConversation({
          tripId: input.tripId,
          activeContextPointId: null,
          title: titleFrom(input.message),
        }))
      ).id;
    }
    return this.sendMessage({ ...input, conversationId });
  }

  public async sendMessage(input: SendMessageInput): Promise<ChatResult> {
    const message = input.message.trim();
    if (message.length === 0 || message.length > MAX_MESSAGE_CHARS) {
      throw new AppError(
        "REQUEST_INVALID",
        "validation",
        400,
        `message must contain between 1 and ${MAX_MESSAGE_CHARS} characters.`,
      );
    }
    const trip = await this.requireTrip(input.tripId, input.userId);
    const conversationId = input.conversationId as string;
    const conversation = await this.deps.conversations.getConversation(
      input.tripId,
      conversationId,
    );
    if (!conversation) throw conversationNotFound();
    if (input.contextPointId) {
      await this.requireContextPoint(
        input.tripId,
        input.userId,
        input.contextPointId,
      );
    }

    const existing = await this.deps.conversations.findUserMessageByKey(
      conversationId,
      input.clientRequestKey,
    );
    if (existing) return this.replay(existing, input.requestId);

    const [contextPoints, agenda, journeyLegs, bookings, recent] =
      await Promise.all([
        this.deps.trips.listContextPointsForTrip(input.tripId, input.userId),
        this.deps.trips.listAgendaItemsForTrip(input.tripId, input.userId),
        this.deps.trips.listJourneyLegsForTrip(input.tripId, input.userId),
        this.deps.toolServices.listBookings(input.tripId),
        this.deps.conversations.recentMessages(
          conversationId,
          this.deps.maxContextMessages,
        ),
      ]);
    const snapshot: TripSnapshotData = {
      trip: {
        id: trip.id,
        name: trip.name,
        timezone: trip.timezone,
        status: trip.status,
      },
      destinationSummary: trip.destination_summary,
      contextPoints: contextPoints.map(toContextPointRecord),
      agenda: agenda.map(toAgendaRecord),
      journeyLegs: journeyLegs.map(toJourneyLegRecord),
      bookings,
    };
    const history: HistoryMessage[] = recent
      .filter((row) => row.status !== "failed")
      .map((row) => ({ role: row.role, content: row.content }));
    const lastAssistant = [...recent]
      .reverse()
      .find((row) => row.role === "assistant" && row.response);
    const lastCards =
      (lastAssistant?.response as unknown as AssistantResponse | null)?.cards ??
      [];
    const eventCards = lastCards.filter(
      (card) => card.type === "event" && card.status === "suggested",
    );
    const recommendationCards = lastCards.filter(
      (card) => card.type === "recommendation",
    );
    const previousEventResults: ResolverEventResult[] = eventCards.map(
      (card) => ({ id: card.id, title: card.title }),
    );

    const userMessage = await this.deps.conversations.insertUserMessage({
      conversationId,
      tripId: input.tripId,
      content: message,
      requestId: input.requestId,
      clientRequestKey: input.clientRequestKey,
    });
    const executionId = randomUUID();
    const activeContextPointId =
      input.contextPointId ?? conversation.active_context_point_id;

    try {
      const outcome = await this.deps.orchestrator.run({
        requestId: input.requestId,
        executionId,
        userId: input.userId,
        tripId: input.tripId,
        message,
        activeContextPointId,
        history,
        previousEventResults,
        actionableEntities: {
          event_discovery_result: eventCards.map((card) => ({
            id: card.id,
            label: card.title,
          })),
          recommendation: recommendationCards.map((card) => ({
            id: card.id,
            label: card.title,
          })),
        },
        snapshot,
        toolRuntime: {
          requestId: input.requestId,
          executionId,
          userId: input.userId,
          tripId: input.tripId,
          snapshot,
          services: this.deps.toolServices,
          maxItems: this.deps.maxToolItems,
        },
        confirmations: {
          issue: (request: { action: ConfirmationAction; entityId: string }) =>
            this.deps.confirmations.issue({
              userId: input.userId,
              tripId: input.tripId,
              tripTimezone: trip.timezone,
              conversationId,
              action: request.action,
              entityId: request.entityId,
            }),
        },
      });

      const stored = await this.deps.conversations.insertAssistantMessage({
        conversationId,
        tripId: input.tripId,
        content: outcome.response.message,
        status:
          outcome.state === "awaiting_clarification"
            ? "clarification"
            : "completed",
        intent: outcome.intent,
        errorCode: null,
        requestId: input.requestId,
        executionId,
        response: withoutToken(outcome.response),
        toolCallMetadata: outcome.trace.toolCalls,
      });
      await this.deps.conversations.touchConversation(
        conversationId,
        input.contextPointId ?? undefined,
      );
      this.logExecution(
        input,
        outcome.trace,
        outcome.state,
        outcome.intent,
        null,
      );
      return {
        request_id: input.requestId,
        conversation_id: conversationId,
        user_message: serializeMessage(userMessage),
        assistant_message: serializeMessage(stored),
        response: outcome.response,
        execution: {
          execution_id: executionId,
          state: outcome.state,
          intent: outcome.intent,
          ...(outcome.trace.model ? { model: outcome.trace.model } : {}),
          latency_ms: outcome.latencyMs,
          ...(outcome.trace.plannerLatencyMs !== null
            ? { planner_latency_ms: outcome.trace.plannerLatencyMs }
            : {}),
          ...(outcome.trace.synthesisLatencyMs !== null
            ? { synthesis_latency_ms: outcome.trace.synthesisLatencyMs }
            : {}),
          tool_call_count: outcome.trace.toolCalls.length,
          provider_call_count: outcome.trace.providerCallCount,
        },
      };
    } catch (error) {
      const trace: ExecutionTrace | null =
        error instanceof OrchestrationFailure ? error.trace : null;
      const appError = toAppError(error);
      this.deps.logger.error("assistant.execution_failed", {
        request_id: input.requestId,
        execution_id: executionId,
        trip_id: input.tripId,
        conversation_id: conversationId,
        error_code: appError.code,
        intent: trace?.intent ?? null,
        tool_calls: trace?.toolCalls ?? [],
        cause_name:
          error instanceof OrchestrationFailure
            ? error.causeError instanceof Error
              ? error.causeError.name
              : "Unknown"
            : error instanceof Error
              ? error.name
              : "Unknown",
      });
      try {
        await this.deps.conversations.insertAssistantMessage({
          conversationId,
          tripId: input.tripId,
          content: appError.message,
          status: "failed",
          intent: trace?.intent ?? null,
          errorCode: appError.code,
          requestId: input.requestId,
          executionId,
          response: null,
          toolCallMetadata: trace?.toolCalls ?? [],
        });
      } catch (persistError) {
        this.deps.logger.error("assistant.failed_turn_not_stored", {
          request_id: input.requestId,
          execution_id: executionId,
          error_code:
            persistError instanceof AppError ? persistError.code : "UNKNOWN",
        });
      }
      throw new AppError(
        appError.code,
        appError.category,
        appError.statusCode,
        appError.message,
        {
          ...(appError.details ?? {}),
          conversation_id: conversationId,
          execution_id: executionId,
          user_message_id: userMessage.id,
        },
      );
    }
  }

  private async replay(
    userMessage: ConversationMessageRow,
    requestId: string,
  ): Promise<ChatResult> {
    const reply = await this.deps.conversations.assistantReplyTo(userMessage);
    if (!reply) {
      throw new AppError(
        "IDEMPOTENCY_IN_PROGRESS",
        "conflict",
        409,
        "A message with this Idempotency-Key is still being processed.",
      );
    }
    if (reply.status === "failed" || !reply.response) {
      throw new AppError(
        "IDEMPOTENCY_RETRY_REQUIRED",
        "conflict",
        409,
        "The original request failed. Send it again with a new Idempotency-Key.",
        { original_error_code: reply.error_code ?? "UNKNOWN" },
      );
    }
    const response = reply.response as unknown as AssistantResponse;
    return {
      request_id: requestId,
      conversation_id: userMessage.conversation_id,
      replayed: true,
      user_message: serializeMessage(userMessage),
      assistant_message: serializeMessage(reply),
      response,
      execution: {
        execution_id: reply.execution_id ?? userMessage.id,
        state:
          reply.status === "clarification"
            ? "awaiting_clarification"
            : "completed",
        intent: reply.intent ?? response.intent,
        latency_ms: 0,
        tool_call_count: Array.isArray(reply.tool_call_metadata)
          ? reply.tool_call_metadata.length
          : 0,
        provider_call_count: 0,
      },
    };
  }

  private logExecution(
    input: SendMessageInput,
    trace: ExecutionTrace,
    state: string,
    intent: string,
    failureCode: string | null,
  ): void {
    this.deps.logger.info("assistant.execution", {
      request_id: input.requestId,
      execution_id: trace.executionId,
      trip_id: input.tripId,
      conversation_id: input.conversationId,
      intent,
      state,
      model: trace.model,
      planner_latency_ms: trace.plannerLatencyMs,
      synthesis_latency_ms: trace.synthesisLatencyMs,
      tool_call_count: trace.toolCalls.length,
      provider_call_count: trace.providerCallCount,
      failure_code: failureCode,
    });
  }

  private async requireTrip(tripId: string, userId: string) {
    const trip = await this.deps.trips.getTripRowForUser(tripId, userId);
    if (!trip) {
      throw new AppError(
        "RESOURCE_NOT_FOUND",
        "not_found",
        404,
        "Trip was not found.",
      );
    }
    return trip;
  }

  private async requireContextPoint(
    tripId: string,
    userId: string,
    contextPointId: string,
  ): Promise<void> {
    const points = await this.deps.trips.listContextPointsForTrip(
      tripId,
      userId,
    );
    const found = points.find(
      (point) => point.id === contextPointId && point.status === "active",
    );
    if (!found) {
      throw new AppError(
        "CONTEXT_OUTSIDE_TRIP",
        "validation",
        422,
        "The selected place is not an active place in this trip.",
      );
    }
  }
}
