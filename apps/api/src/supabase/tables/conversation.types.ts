import type { Json, TableDefinition } from "../database.types.js";

/** Table and function types for Task 09 (migration 0008). */

export type ConversationRow = {
  id: string;
  trip_id: string;
  active_context_point_id: string | null;
  title: string | null;
  status: "active" | "archived";
  created_at: string;
  updated_at: string;
};

export type ConversationMessageRow = {
  id: string;
  conversation_id: string;
  trip_id: string;
  role: "user" | "assistant";
  content: string;
  status: "received" | "completed" | "clarification" | "failed";
  intent: string | null;
  error_code: string | null;
  request_id: string | null;
  execution_id: string | null;
  client_request_key: string | null;
  response: Json | null;
  tool_call_metadata: Json;
  created_at: string;
};

export type AssistantConfirmationRow = {
  id: string;
  trip_id: string;
  user_id: string;
  conversation_id: string | null;
  action:
    | "save_event_result"
    | "expire_event_result"
    | "save_recommendation"
    | "apply_recommendation"
    | "dismiss_recommendation";
  entity_type: "event_discovery_result" | "recommendation";
  entity_id: string;
  token_hash: string;
  payload_hash: string;
  summary: string;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
};

export type ConversationTables = {
  conversations: TableDefinition<
    ConversationRow,
    {
      id?: string;
      trip_id: string;
      active_context_point_id?: string | null;
      title?: string | null;
      status?: ConversationRow["status"];
      created_at?: string;
      updated_at?: string;
    },
    Partial<
      Pick<ConversationRow, "active_context_point_id" | "title" | "status">
    >
  >;
  conversation_messages: TableDefinition<
    ConversationMessageRow,
    {
      id?: string;
      conversation_id: string;
      trip_id: string;
      role: ConversationMessageRow["role"];
      content: string;
      status: ConversationMessageRow["status"];
      intent?: string | null;
      error_code?: string | null;
      request_id?: string | null;
      execution_id?: string | null;
      client_request_key?: string | null;
      response?: Json | null;
      tool_call_metadata?: Json;
      created_at?: string;
    },
    never
  >;
  assistant_confirmations: TableDefinition<
    AssistantConfirmationRow,
    {
      id?: string;
      trip_id: string;
      user_id: string;
      conversation_id?: string | null;
      action: AssistantConfirmationRow["action"];
      entity_type: AssistantConfirmationRow["entity_type"];
      entity_id: string;
      token_hash: string;
      payload_hash: string;
      summary: string;
      expires_at: string;
      consumed_at?: string | null;
      created_at?: string;
    },
    Partial<Pick<AssistantConfirmationRow, "consumed_at">>
  >;
};

export type ConversationFunctions = {
  assistant_consume_confirmation: {
    Args: {
      p_token_hash: string;
      p_trip_id: string;
      p_action: string;
      p_entity_type: string;
      p_entity_id: string;
      p_payload_hash: string;
    };
    Returns: string | null;
  };
  assistant_apply_event_result_action: {
    Args: {
      p_token_hash: string;
      p_payload_hash: string;
      p_trip_id: string;
      p_result_id: string;
      p_action: string;
    };
    Returns: Json;
  };
};

export type { Json, TableDefinition };
