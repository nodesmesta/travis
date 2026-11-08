/** Types for the assistant and itinerary views. They mirror contracts/schemas/*.json. */

export type ConfirmationAction =
  | "save_event_result"
  | "expire_event_result"
  | "save_recommendation"
  | "apply_recommendation"
  | "dismiss_recommendation";

export type AssistantFreshness = "fresh" | "stale" | "expired" | "unavailable";

export interface AssistantSource {
  id: string;
  kind:
    "provider" | "official_page" | "search_result" | "user_input" | "internal";
  provider: string;
  url?: string;
  title?: string;
  retrieved_at: string;
  freshness: "fresh" | "expired" | "unavailable";
  expires_at?: string;
}

export interface AssistantCardAction {
  action: ConfirmationAction;
  label: string;
}

export interface AssistantCard {
  type:
    | "event"
    | "activity"
    | "restaurant"
    | "route"
    | "weather"
    | "traffic"
    | "alert"
    | "agenda"
    | "recommendation";
  id: string;
  title: string;
  subtitle?: string;
  status?: string;
  starts_at?: string;
  ends_at?: string;
  fields: Array<{ label: string; value: string }>;
  source_ids: string[];
  retrieved_at?: string;
  /** True on the option the deterministic mobility engine recommends. */
  recommended?: boolean;
  /** Position given by the mobility engine. 1 is best. */
  rank?: number;
  actions?: AssistantCardAction[];
}

export interface ConfirmationRequest {
  action: ConfirmationAction;
  entity_type: "event_discovery_result" | "recommendation";
  entity_id: string;
  summary: string;
  expires_at: string;
  /** Present once, when the backend issues the request. Never stored. */
  confirmation_token?: string;
}

export interface AssistantResponse {
  message: string;
  intent: string;
  context: {
    context_point_ids: string[];
    agenda_item_ids: string[];
    event_result_ids: string[];
  };
  cards: AssistantCard[];
  facts: Array<{ label: string; value: string; source_ids: string[] }>;
  recommendations: Array<{
    title: string;
    reason: string;
    confidence: "low" | "medium" | "high";
    source_ids: string[];
  }>;
  travel_tips: Array<{
    title: string;
    detail: string;
    source_ids: string[];
  }>;
  clarification: {
    question: string;
    options: Array<{ id: string; label: string }>;
  } | null;
  confirmation_request: ConfirmationRequest | null;
  sources: AssistantSource[];
  limitations: string[];
  follow_up_actions: Array<{ label: string; prompt: string }>;
  freshness_status: AssistantFreshness;
  retrieved_at: string | null;
}

export interface ConversationMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  status: "received" | "completed" | "clarification" | "failed";
  intent?: string;
  error_code?: string;
  request_id?: string;
  execution_id?: string;
  response?: AssistantResponse;
  created_at: string;
}

export interface Conversation {
  id: string;
  trip_id: string;
  active_context_point_id: string | null;
  title: string | null;
  status: "active" | "archived";
  created_at: string;
  updated_at: string;
}

export interface ConversationDetail {
  conversation: Conversation;
  messages: ConversationMessage[];
  request_id: string;
}

export interface ChatResult {
  request_id: string;
  conversation_id: string;
  replayed?: boolean;
  user_message: ConversationMessage;
  assistant_message: ConversationMessage;
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

export interface ActionOutcome {
  request_id: string;
  recommendation_id?: string;
  status?: string;
  agenda_item_id?: string | null;
  event_result?: { id: string; status: string };
}

export interface AgendaItemView {
  id: string;
  trip_id: string;
  context_point_id?: string | null;
  title: string;
  type: string;
  start_at: string;
  end_at: string;
  timezone: string;
  status:
    | "suggested"
    | "planned"
    | "confirmed"
    | "completed"
    | "skipped"
    | "cancelled";
  source: string;
  metadata: Record<string, unknown>;
}

export interface JourneyLegView {
  id: string;
  trip_id: string;
  origin_context_point_id: string;
  destination_context_point_id: string;
  related_agenda_id?: string | null;
  departure_at: string;
  arrival_deadline?: string | null;
  status: "planned" | "in_progress" | "completed" | "cancelled";
}

export interface RecommendationView {
  id: string;
  trip_id: string;
  recommendation_type: string;
  payload: Record<string, unknown>;
  reason: string | null;
  created_at: string;
  expires_at: string | null;
  status: string;
}

export interface ActivityEntry {
  id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  metadata: Record<string, unknown>;
  created_at: string;
}
