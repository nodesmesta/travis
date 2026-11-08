import { brightDataConfigFrom } from "../bright-data-config.js";
import {
  ACTION_ENTITY_TYPE,
  TripContextService,
  isConfirmationAction,
} from "@travelflow/domain";
import {
  BrightDataClient,
  EventClaimExtractor,
  EventDiscoveryPipeline,
  VultrInferenceClient,
} from "@travelflow/integrations";
import { AppError } from "../errors.js";
import {
  bodyRecord,
  commandContext,
  normalizeDomainError,
  optionalString,
  readJsonBody,
  requiredString,
  writeJson,
} from "../http.js";
import { matchPath } from "../routing.js";
import { SupabaseBookingPaymentRepository } from "../repositories/booking-payment-repository.js";
import { SupabaseConfirmationRepository } from "../repositories/confirmation-repository.js";
import { SupabaseConversationRepository } from "../repositories/conversation-repository.js";
import {
  SupabaseActivityLogWriter,
  SupabaseIdempotencyStore,
} from "../repositories/domain-persistence.js";
import { SupabaseEventDiscoveryRepository } from "../repositories/event-discovery-repository.js";
import { SupabaseRecommendationRepository } from "../repositories/recommendation-repository.js";
import { SupabaseTripContextRepository } from "../repositories/trip-context-repository.js";
import { ConfirmationService } from "../services/assistant/confirmation-service.js";
import {
  ChatWithAssistantService,
  serializeConversation,
  serializeMessage,
} from "../services/assistant/chat-service.js";
import { VultrAssistantModel } from "../services/assistant/model.js";
import { AssistantOrchestrator } from "../services/assistant/orchestrator.js";
import { createAssistantToolRegistry } from "../services/assistant/tools/registry.js";
import { EventDiscoveryService } from "../services/event-discovery-service.js";
import { createToolServices } from "../services/assistant/tool-services.js";
import { buildServices as buildMobilityServices } from "./mobility.js";
import type {
  AuthenticatedSession,
  RequestContext,
  RouteModule,
} from "./context.js";

const TRIPS = "/api/v1/trips";

interface AssistantServices {
  chat: ChatWithAssistantService;
  confirmations: ConfirmationService;
  confirmationRepository: SupabaseConfirmationRepository;
  trips: SupabaseTripContextRepository;
  bookings: SupabaseBookingPaymentRepository;
  idempotency: SupabaseIdempotencyStore;
}

function secretValues(
  context: RequestContext,
  session: AuthenticatedSession,
): string[] {
  const { config } = context;
  return [
    config.vultrInferenceApiKey,
    config.brightDataApiKey,
    config.supabaseServiceRoleKey,
    config.supabaseAnonKey,
    session.accessToken,
  ].filter(
    (value): value is string => typeof value === "string" && value.length >= 8,
  );
}

/** Builds every service for one request from the signed-in user's own database client. */
function buildServices(
  context: RequestContext,
  session: AuthenticatedSession,
): AssistantServices {
  const { config, logger } = context;
  const { client } = session;
  const trips = new SupabaseTripContextRepository(client);
  const conversations = new SupabaseConversationRepository(client);
  const confirmationRepository = new SupabaseConfirmationRepository(client);
  const recommendationRepository = new SupabaseRecommendationRepository(client);
  const bookings = new SupabaseBookingPaymentRepository(client);
  const activityLog = new SupabaseActivityLogWriter(client);
  const idempotency = new SupabaseIdempotencyStore(client);
  const domain = new TripContextService({
    repository: trips,
    idempotency,
    activityLog,
  });
  const eventDiscovery = new EventDiscoveryService(
    trips,
    new SupabaseEventDiscoveryRepository(client),
    new EventDiscoveryPipeline(
      new BrightDataClient(brightDataConfigFrom(config)),
      new EventClaimExtractor(
        new VultrInferenceClient({
          baseUrl: config.vultrInferenceBaseUrl,
          apiKey: config.vultrInferenceApiKey,
          model: config.vultrInferenceModel,
          timeoutMs: config.aiExtractionTimeoutMs,
        }),
      ),
      {
        maxPages: config.eventMaxPages,
        pageMaxChars: config.eventPageMaxChars,
        pageConcurrency: config.eventPageConcurrency,
      },
    ),
    config.eventDiscoveryTtlHours,
  );
  const { mobility, places } = buildMobilityServices(context, session);
  const toolServices = createToolServices({
    mobility,
    places,
    events: eventDiscovery,
    listBookings: (tripId) => bookings.listBookings(tripId),
    listRecommendations: (tripId) => recommendationRepository.list(tripId),
  });
  const confirmations = new ConfirmationService({
    confirmations: confirmationRepository,
    recommendations: recommendationRepository,
    activityLog,
    createAgendaItem: (input, command) =>
      domain.createAgendaItem(input, command),
    ttlMinutes: config.aiConfirmationTtlMinutes,
  });
  const orchestrator = new AssistantOrchestrator({
    model: new VultrAssistantModel(
      new VultrInferenceClient({
        baseUrl: config.vultrInferenceBaseUrl,
        apiKey: config.vultrInferenceApiKey,
        model: config.vultrInferenceModel,
        timeoutMs: config.aiSynthesisTimeoutMs,
      }),
    ),
    tools: createAssistantToolRegistry(config),
    limits: {
      plannerTimeoutMs: config.aiPlannerTimeoutMs,
      synthesisTimeoutMs: config.aiSynthesisTimeoutMs,
      plannerReasoningEffort: config.aiPlannerReasoningEffort,
      synthesisReasoningEffort: config.aiSynthesisReasoningEffort,
      plannerMaxTokens: config.aiPlannerMaxTokens,
      synthesisMaxTokens: config.aiSynthesisMaxTokens,
      maxToolCalls: config.aiMaxToolCalls,
      maxProviderCalls: config.aiMaxProviderCalls,
      maxParallelTools: config.aiMaxParallelTools,
      maxToolResultBytes: config.aiMaxToolResultBytes,
      maxContextMessages: config.aiMaxContextMessages,
      maxMessageChars: 2000,
      totalTimeoutMs: config.aiTotalTimeoutMs,
    },
    secrets: secretValues(context, session),
  });
  return {
    chat: new ChatWithAssistantService({
      conversations,
      trips,
      orchestrator,
      confirmations,
      toolServices,
      logger,
      maxContextMessages: config.aiMaxContextMessages,
      maxToolItems: config.aiMaxToolItems,
    }),
    confirmations,
    confirmationRepository,
    trips,
    bookings,
    idempotency,
  };
}

function assertFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(body).find((key) => !allowed.includes(key));
  if (unknown) {
    throw new AppError(
      "REQUEST_INVALID",
      "validation",
      400,
      `Field is not supported: ${unknown}.`,
    );
  }
}

function confirmationToken(body: Record<string, unknown>): string {
  assertFields(body, ["confirmation_token"]);
  const token = body.confirmation_token;
  if (token === undefined || token === null || token === "") {
    throw new AppError(
      "CONFIRMATION_REQUIRED",
      "validation",
      400,
      "A confirmation_token from the backend is required for this action.",
    );
  }
  if (typeof token !== "string" || token.length < 32 || token.length > 200) {
    throw new AppError(
      "CONFIRMATION_TOKEN_INVALID",
      "authorization",
      403,
      "The confirmation token is not valid for this action.",
    );
  }
  return token;
}

async function requireTrip(
  services: AssistantServices,
  tripId: string,
  userId: string,
) {
  const trip = await services.trips.getTripRowForUser(tripId, userId);
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

export const assistantRoutes: RouteModule = async (context) => {
  const { request, response, requestId, method, url } = context;
  const pathname = url.pathname;

  const conversationsPath = matchPath(
    pathname,
    `${TRIPS}/:tripId/conversations`,
  );
  const conversationPath = matchPath(
    pathname,
    `${TRIPS}/:tripId/conversations/:conversationId`,
  );
  const messagesPath = matchPath(
    pathname,
    `${TRIPS}/:tripId/conversations/:conversationId/messages`,
  );
  const chatPath = matchPath(pathname, `${TRIPS}/:tripId/chat`);
  const confirmationsPath = matchPath(
    pathname,
    `${TRIPS}/:tripId/assistant-confirmations`,
  );
  const recommendationPath = matchPath(
    pathname,
    `${TRIPS}/:tripId/recommendations/:recommendationId/:action(save|apply|dismiss)`,
  );
  const eventResultPath = matchPath(
    pathname,
    `${TRIPS}/:tripId/event-discovery-results/:resultId/:action(save|expire)`,
  );
  const activityPath = matchPath(pathname, `${TRIPS}/:tripId/activity-log`);

  const relevant =
    (conversationsPath && (method === "GET" || method === "POST")) ||
    (conversationPath && method === "GET") ||
    (messagesPath && method === "POST") ||
    (chatPath && method === "POST") ||
    (confirmationsPath && method === "POST") ||
    (recommendationPath && method === "POST") ||
    (eventResultPath && method === "POST") ||
    (activityPath && method === "GET");
  if (!relevant) return false;

  const session = await context.authenticate();
  const services = buildServices(context, session);
  const userId = session.user.id;

  try {
    if (conversationsPath && method === "GET") {
      const items = await services.chat.listConversations(
        conversationsPath.tripId as string,
        userId,
      );
      writeJson(response, 200, {
        items: items.map(serializeConversation),
        request_id: requestId,
      });
      return true;
    }

    if (conversationsPath && method === "POST") {
      const body = bodyRecord(await readJsonBody(request));
      assertFields(body, ["active_context_point_id", "title"]);
      commandContext(request, pathname, userId, body);
      const created = await services.chat.createConversation({
        userId,
        tripId: conversationsPath.tripId as string,
        activeContextPointId:
          optionalString(body, "active_context_point_id") ?? null,
        title: optionalString(body, "title") ?? null,
      });
      writeJson(response, 201, serializeConversation(created));
      return true;
    }

    if (conversationPath && method === "GET") {
      const detail = await services.chat.getConversationDetail(
        conversationPath.tripId as string,
        userId,
        conversationPath.conversationId as string,
      );
      writeJson(response, 200, {
        conversation: serializeConversation(detail.conversation),
        messages: detail.messages.map(serializeMessage),
        request_id: requestId,
      });
      return true;
    }

    if ((messagesPath || chatPath) && method === "POST") {
      const tripId = (messagesPath ?? chatPath)?.tripId as string;
      const body = bodyRecord(await readJsonBody(request));
      assertFields(
        body,
        messagesPath
          ? ["message", "context_point_id"]
          : ["message", "context_point_id", "conversation_id"],
      );
      const command = commandContext(request, pathname, userId, body);
      const result = await services.chat.chat({
        requestId,
        userId,
        tripId,
        conversationId: messagesPath
          ? (messagesPath.conversationId as string)
          : (optionalString(body, "conversation_id") ?? null),
        message: requiredString(body, "message"),
        contextPointId: optionalString(body, "context_point_id") ?? null,
        clientRequestKey: command.idempotencyKey,
      });
      writeJson(response, 200, result);
      return true;
    }

    if (confirmationsPath && method === "POST") {
      const tripId = confirmationsPath.tripId as string;
      const body = bodyRecord(await readJsonBody(request));
      assertFields(body, ["action", "entity_type", "entity_id"]);
      commandContext(request, pathname, userId, body);
      const action = requiredString(body, "action");
      if (!isConfirmationAction(action)) {
        throw new AppError(
          "REQUEST_INVALID",
          "validation",
          400,
          "action is not supported.",
        );
      }
      if (ACTION_ENTITY_TYPE[action] !== requiredString(body, "entity_type")) {
        throw new AppError(
          "REQUEST_INVALID",
          "validation",
          400,
          "entity_type does not match the action.",
        );
      }
      const trip = await requireTrip(services, tripId, userId);
      const issued = await services.confirmations.issue({
        userId,
        tripId,
        tripTimezone: trip.timezone,
        conversationId: null,
        action,
        entityId: requiredString(body, "entity_id"),
      });
      writeJson(response, 201, issued);
      return true;
    }

    if (eventResultPath && method === "POST") {
      const tripId = eventResultPath.tripId as string;
      const resultId = eventResultPath.resultId as string;
      const action = eventResultPath.action as "save" | "expire";
      const body = bodyRecord(await readJsonBody(request));
      const token = confirmationToken(body);
      const command = commandContext(request, pathname, userId, body);
      await requireTrip(services, tripId, userId);
      const outcome = await services.idempotency.execute(
        `assistant.event_result.${action}:${tripId}:${resultId}`,
        command,
        async () => {
          const result = await services.confirmations.runEventResultAction({
            userId,
            tripId,
            resultId,
            action,
            token,
          });
          const row = await services.confirmationRepository.getEventResult(
            tripId,
            resultId,
          );
          if (!row) {
            throw new AppError(
              "RESOURCE_NOT_FOUND",
              "not_found",
              404,
              "Event result was not found.",
            );
          }
          return {
            event_result: {
              id: row.id,
              trip_id: row.trip_id,
              context_point_id: row.context_point_id,
              title: row.title,
              ...(row.description ? { description: row.description } : {}),
              ...(row.venue_name ? { venue_name: row.venue_name } : {}),
              starts_at: row.starts_at,
              ...(row.ends_at ? { ends_at: row.ends_at } : {}),
              ...(row.category ? { category: row.category } : {}),
              status: row.status,
              source_ids: [row.source_id],
            },
            agenda_item_id: result.agendaItemId,
          };
        },
      );
      writeJson(response, 200, { ...outcome, request_id: requestId });
      return true;
    }

    if (recommendationPath && method === "POST") {
      const tripId = recommendationPath.tripId as string;
      const recommendationId = recommendationPath.recommendationId as string;
      const action = recommendationPath.action as "save" | "apply" | "dismiss";
      const body = bodyRecord(await readJsonBody(request));
      const token = confirmationToken(body);
      const command = commandContext(request, pathname, userId, body);
      await requireTrip(services, tripId, userId);
      const outcome = await services.idempotency.execute(
        `assistant.recommendation.${action}:${tripId}:${recommendationId}`,
        command,
        async () => {
          const result = await services.confirmations.runRecommendationAction({
            userId,
            tripId,
            recommendationId,
            action,
            token,
            command,
          });
          return {
            recommendation_id: recommendationId,
            status: result.status,
            agenda_item_id: result.agendaItemId,
          };
        },
      );
      writeJson(response, 200, { ...outcome, request_id: requestId });
      return true;
    }

    if (activityPath && method === "GET") {
      const tripId = activityPath.tripId as string;
      await requireTrip(services, tripId, userId);
      const requested = Number(url.searchParams.get("limit") ?? 50);
      const limit =
        Number.isInteger(requested) && requested >= 1 && requested <= 200
          ? requested
          : 50;
      const [points, agenda, legs, bookingRows] = await Promise.all([
        services.trips.listContextPointsForTrip(tripId, userId),
        services.trips.listAgendaItemsForTrip(tripId, userId),
        services.trips.listJourneyLegsForTrip(tripId, userId),
        services.bookings.listBookings(tripId),
      ]);
      const resourceIds = [
        tripId,
        ...points.map((row) => row.id),
        ...agenda.map((row) => row.id),
        ...legs.map((row) => row.id),
        ...bookingRows.map((row) => row.id),
      ].slice(0, 150);
      const entries = await services.confirmationRepository.listActivity(
        resourceIds,
        tripId,
        limit,
      );
      writeJson(response, 200, {
        items: entries.map((entry) => ({
          id: entry.id,
          action: entry.action,
          resource_type: entry.resource_type,
          resource_id: entry.resource_id,
          metadata: entry.metadata,
          created_at: new Date(entry.created_at).toISOString(),
        })),
        request_id: requestId,
      });
      return true;
    }
  } catch (error) {
    // Provider and domain errors keep their structured code; the router's
    // top-level handler logs and renders them.
    throw normalizeDomainError(error);
  }
  return false;
};
