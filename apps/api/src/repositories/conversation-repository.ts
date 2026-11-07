import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../errors.js";
import type { Database, Json } from "../supabase/database.types.js";
import type {
  ConversationMessageRow,
  ConversationRow,
} from "../supabase/tables/conversation.types.js";

type UserScopedClient = SupabaseClient<Database>;

function persistenceFailure(operation: string): AppError {
  return new AppError(
    "PERSISTENCE_ERROR",
    "persistence",
    500,
    "The conversation could not be saved or loaded.",
    { operation },
  );
}

export function conversationNotFound(): AppError {
  return new AppError(
    "RESOURCE_NOT_FOUND",
    "not_found",
    404,
    "Conversation was not found.",
  );
}

export interface NewAssistantMessage {
  conversationId: string;
  tripId: string;
  content: string;
  status: "completed" | "clarification" | "failed";
  intent: string | null;
  errorCode: string | null;
  requestId: string;
  executionId: string;
  response: unknown;
  toolCallMetadata: unknown[];
}

function json(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

/** Conversations and messages, always read and written through the user's own client (RLS applies). */
export class SupabaseConversationRepository {
  public constructor(private readonly client: UserScopedClient) {}

  public async createConversation(input: {
    tripId: string;
    activeContextPointId: string | null;
    title: string | null;
  }): Promise<ConversationRow> {
    const { data, error } = await this.client
      .from("conversations")
      .insert({
        trip_id: input.tripId,
        active_context_point_id: input.activeContextPointId,
        title: input.title,
      })
      .select("*")
      .single();
    if (error || !data) throw persistenceFailure("conversation.create");
    return data;
  }

  public async listConversations(tripId: string): Promise<ConversationRow[]> {
    const { data, error } = await this.client
      .from("conversations")
      .select("*")
      .eq("trip_id", tripId)
      .order("updated_at", { ascending: false })
      .limit(50);
    if (error) throw persistenceFailure("conversation.list");
    return data ?? [];
  }

  public async getConversation(
    tripId: string,
    conversationId: string,
  ): Promise<ConversationRow | null> {
    const { data, error } = await this.client
      .from("conversations")
      .select("*")
      .eq("trip_id", tripId)
      .eq("id", conversationId)
      .maybeSingle();
    if (error) throw persistenceFailure("conversation.get");
    return data;
  }

  public async latestActiveConversation(
    tripId: string,
  ): Promise<ConversationRow | null> {
    const { data, error } = await this.client
      .from("conversations")
      .select("*")
      .eq("trip_id", tripId)
      .eq("status", "active")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw persistenceFailure("conversation.latest");
    return data;
  }

  public async touchConversation(
    conversationId: string,
    activeContextPointId: string | null | undefined,
  ): Promise<void> {
    const patch: Database["public"]["Tables"]["conversations"]["Update"] =
      activeContextPointId !== undefined
        ? { active_context_point_id: activeContextPointId }
        : { status: "active" };
    const { error } = await this.client
      .from("conversations")
      .update(patch)
      .eq("id", conversationId);
    if (error) throw persistenceFailure("conversation.touch");
  }

  public async listMessages(
    conversationId: string,
    limit = 200,
  ): Promise<ConversationMessageRow[]> {
    const { data, error } = await this.client
      .from("conversation_messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(limit);
    if (error) throw persistenceFailure("message.list");
    return data ?? [];
  }

  /** The newest messages, oldest first, for the prompt window. */
  public async recentMessages(
    conversationId: string,
    limit: number,
  ): Promise<ConversationMessageRow[]> {
    const { data, error } = await this.client
      .from("conversation_messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw persistenceFailure("message.recent");
    return (data ?? []).reverse();
  }

  public async findUserMessageByKey(
    conversationId: string,
    clientRequestKey: string,
  ): Promise<ConversationMessageRow | null> {
    const { data, error } = await this.client
      .from("conversation_messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .eq("role", "user")
      .eq("client_request_key", clientRequestKey)
      .maybeSingle();
    if (error) throw persistenceFailure("message.find_by_key");
    return data;
  }

  /** First assistant message written at or after the given user message. */
  public async assistantReplyTo(
    userMessage: ConversationMessageRow,
  ): Promise<ConversationMessageRow | null> {
    const { data, error } = await this.client
      .from("conversation_messages")
      .select("*")
      .eq("conversation_id", userMessage.conversation_id)
      .eq("role", "assistant")
      .gte("created_at", userMessage.created_at)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw persistenceFailure("message.reply_lookup");
    return data;
  }

  public async insertUserMessage(input: {
    conversationId: string;
    tripId: string;
    content: string;
    requestId: string;
    clientRequestKey: string;
  }): Promise<ConversationMessageRow> {
    const { data, error } = await this.client
      .from("conversation_messages")
      .insert({
        conversation_id: input.conversationId,
        trip_id: input.tripId,
        role: "user",
        content: input.content,
        status: "received",
        request_id: input.requestId,
        client_request_key: input.clientRequestKey,
      })
      .select("*")
      .single();
    if (error?.code === "23505") {
      throw new AppError(
        "IDEMPOTENCY_IN_PROGRESS",
        "conflict",
        409,
        "A message with this Idempotency-Key is already being processed.",
      );
    }
    if (error || !data) throw persistenceFailure("message.insert_user");
    return data;
  }

  public async insertAssistantMessage(
    input: NewAssistantMessage,
  ): Promise<ConversationMessageRow> {
    const { data, error } = await this.client
      .from("conversation_messages")
      .insert({
        conversation_id: input.conversationId,
        trip_id: input.tripId,
        role: "assistant",
        content: input.content,
        status: input.status,
        intent: input.intent,
        error_code: input.errorCode,
        request_id: input.requestId,
        execution_id: input.executionId,
        response: input.response === null ? null : json(input.response),
        tool_call_metadata: json(input.toolCallMetadata),
      })
      .select("*")
      .single();
    if (error || !data) throw persistenceFailure("message.insert_assistant");
    return data;
  }
}
