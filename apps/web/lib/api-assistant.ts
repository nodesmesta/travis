import { ApiClientError, request } from "./api";
import type {
  ActionOutcome,
  ActivityEntry,
  AgendaItemView,
  ChatResult,
  Conversation,
  ConversationDetail,
  ConfirmationAction,
  ConfirmationRequest,
  JourneyLegView,
  RecommendationView,
} from "./types-assistant";

/** A fresh key for one user decision. Reusing it replays the stored result. */
export function newIdempotencyKey(operation: string): string {
  const random =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `travelflow-${operation}-${random}`.slice(0, 200);
}

function tripPath(tripId: string): string {
  return `/trips/${encodeURIComponent(tripId)}`;
}

function withKey(key: string): Record<string, string> {
  return { "idempotency-key": key };
}

export function listConversations(
  tripId: string,
): Promise<{ items: Conversation[]; request_id: string }> {
  return request(`${tripPath(tripId)}/conversations`);
}

export function createConversation(
  tripId: string,
  body: { active_context_point_id?: string; title?: string },
  key: string,
): Promise<Conversation> {
  return request(
    `${tripPath(tripId)}/conversations`,
    { method: "POST", body: JSON.stringify(body), headers: withKey(key) },
    true,
  );
}

export function getConversation(
  tripId: string,
  conversationId: string,
): Promise<ConversationDetail> {
  return request(
    `${tripPath(tripId)}/conversations/${encodeURIComponent(conversationId)}`,
  );
}

export function sendMessage(
  tripId: string,
  conversationId: string,
  body: { message: string; context_point_id?: string },
  key: string,
): Promise<ChatResult> {
  return request(
    `${tripPath(tripId)}/conversations/${encodeURIComponent(conversationId)}/messages`,
    { method: "POST", body: JSON.stringify(body), headers: withKey(key) },
    true,
  );
}

export function requestConfirmation(
  tripId: string,
  body: {
    action: ConfirmationAction;
    entity_type: ConfirmationRequest["entity_type"];
    entity_id: string;
  },
  key: string,
): Promise<ConfirmationRequest> {
  return request(
    `${tripPath(tripId)}/assistant-confirmations`,
    { method: "POST", body: JSON.stringify(body), headers: withKey(key) },
    true,
  );
}

const ENTITY_TYPE: Record<
  ConfirmationAction,
  ConfirmationRequest["entity_type"]
> = {
  save_event_result: "event_discovery_result",
  expire_event_result: "event_discovery_result",
  save_recommendation: "recommendation",
  apply_recommendation: "recommendation",
  dismiss_recommendation: "recommendation",
};

export function entityTypeFor(
  action: ConfirmationAction,
): ConfirmationRequest["entity_type"] {
  return ENTITY_TYPE[action];
}

/** Runs a confirmed mutation with the token the backend issued. */
export function runConfirmedAction(
  tripId: string,
  confirmation: ConfirmationRequest & { confirmation_token: string },
  key: string,
): Promise<ActionOutcome> {
  const id = encodeURIComponent(confirmation.entity_id);
  const path = (() => {
    switch (confirmation.action) {
      case "save_event_result":
        return `${tripPath(tripId)}/event-discovery-results/${id}/save`;
      case "expire_event_result":
        return `${tripPath(tripId)}/event-discovery-results/${id}/expire`;
      case "save_recommendation":
        return `${tripPath(tripId)}/recommendations/${id}/save`;
      case "apply_recommendation":
        return `${tripPath(tripId)}/recommendations/${id}/apply`;
      case "dismiss_recommendation":
        return `${tripPath(tripId)}/recommendations/${id}/dismiss`;
    }
  })();
  return request(
    path,
    {
      method: "POST",
      body: JSON.stringify({
        confirmation_token: confirmation.confirmation_token,
      }),
      headers: withKey(key),
    },
    true,
  );
}

export function listAgendaItems(
  tripId: string,
): Promise<{ items: AgendaItemView[] }> {
  return request(`${tripPath(tripId)}/agenda-items`);
}

export function listJourneyLegs(
  tripId: string,
): Promise<{ items: JourneyLegView[] }> {
  return request(`${tripPath(tripId)}/journey-legs`);
}

export function listActivityLog(
  tripId: string,
  limit = 30,
): Promise<{ items: ActivityEntry[]; request_id: string }> {
  return request(`${tripPath(tripId)}/activity-log?limit=${limit}`);
}

/** Provided by the mobility task. A 404 means the list endpoint is not deployed yet. */
export function listRecommendations(
  tripId: string,
): Promise<{ items: RecommendationView[] }> {
  return request(`${tripPath(tripId)}/recommendations`);
}

/** A short, safe sentence for the UI. The request id helps support find the log line. */
export function describeAssistantError(error: unknown): {
  message: string;
  code: string;
  requestId?: string;
  retryable: boolean;
} {
  if (error instanceof ApiClientError) {
    // A missing provider key stays missing until the server is configured, so asking again cannot help.
    const retryable =
      error.code !== "EXTERNAL_CONFIGURATION_MISSING" &&
      (error.status === 429 ||
        error.status === 502 ||
        error.status === 503 ||
        error.status === 504);
    return {
      message: error.message,
      code: error.code,
      ...(error.requestId ? { requestId: error.requestId } : {}),
      retryable,
    };
  }
  return {
    message:
      error instanceof Error
        ? error.message
        : "Something went wrong. Please try again.",
    code: "CLIENT_ERROR",
    retryable: true,
  };
}
