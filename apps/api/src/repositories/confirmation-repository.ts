import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../errors.js";
import type {
  Database,
  EventDiscoveryResultRow,
  Json,
} from "../supabase/database.types.js";
import type { AssistantConfirmationRow } from "../supabase/tables/conversation.types.js";

type UserScopedClient = SupabaseClient<Database>;

function persistenceFailure(operation: string): AppError {
  return new AppError(
    "PERSISTENCE_ERROR",
    "persistence",
    500,
    "The confirmation could not be saved or checked.",
    { operation },
  );
}

export interface NewConfirmation {
  tripId: string;
  userId: string;
  conversationId: string | null;
  action: AssistantConfirmationRow["action"];
  entityType: AssistantConfirmationRow["entity_type"];
  entityId: string;
  tokenHash: string;
  payloadHash: string;
  summary: string;
  expiresAt: string;
}

export interface ConsumeInput {
  tokenHash: string;
  tripId: string;
  action: string;
  entityType: string;
  entityId: string;
  payloadHash: string;
}

/** Why a token was refused. Only the owner of a token can learn more than "invalid". */
export type ConfirmationRefusal = "invalid" | "used" | "expired";

export function refusalError(reason: ConfirmationRefusal): AppError {
  if (reason === "used") {
    return new AppError(
      "CONFIRMATION_TOKEN_USED",
      "conflict",
      409,
      "This confirmation was already used. Request a new one to repeat the action.",
    );
  }
  if (reason === "expired") {
    return new AppError(
      "CONFIRMATION_TOKEN_EXPIRED",
      "conflict",
      410,
      "This confirmation has expired. Request a new one.",
    );
  }
  return new AppError(
    "CONFIRMATION_TOKEN_INVALID",
    "authorization",
    403,
    "The confirmation token is not valid for this action.",
  );
}

export class SupabaseConfirmationRepository {
  public constructor(private readonly client: UserScopedClient) {}

  public async insert(input: NewConfirmation): Promise<void> {
    const { error } = await this.client.from("assistant_confirmations").insert({
      trip_id: input.tripId,
      user_id: input.userId,
      conversation_id: input.conversationId,
      action: input.action,
      entity_type: input.entityType,
      entity_id: input.entityId,
      token_hash: input.tokenHash,
      payload_hash: input.payloadHash,
      summary: input.summary,
      expires_at: input.expiresAt,
    });
    if (error) throw persistenceFailure("confirmation.insert");
  }

  /** One atomic UPDATE. Returns the confirmation id, or null when the token is refused. */
  public async consume(input: ConsumeInput): Promise<string | null> {
    const { data, error } = await this.client.rpc(
      "assistant_consume_confirmation",
      {
        p_token_hash: input.tokenHash,
        p_trip_id: input.tripId,
        p_action: input.action,
        p_entity_type: input.entityType,
        p_entity_id: input.entityId,
        p_payload_hash: input.payloadHash,
      },
    );
    if (error) throw persistenceFailure("confirmation.consume");
    return typeof data === "string" ? data : null;
  }

  /** Explains a refusal to the token's owner (row level security hides other users' tokens). */
  public async explainRefusal(tokenHash: string): Promise<ConfirmationRefusal> {
    const { data, error } = await this.client
      .from("assistant_confirmations")
      .select("consumed_at, expires_at")
      .eq("token_hash", tokenHash)
      .maybeSingle();
    if (error) throw persistenceFailure("confirmation.explain");
    if (!data) return "invalid";
    if (data.consumed_at) return "used";
    if (Date.parse(data.expires_at) <= Date.now()) return "expired";
    return "invalid";
  }

  public async getEventResult(
    tripId: string,
    resultId: string,
  ): Promise<EventDiscoveryResultRow | null> {
    const { data, error } = await this.client
      .from("event_discovery_results")
      .select("*")
      .eq("trip_id", tripId)
      .eq("id", resultId)
      .maybeSingle();
    if (error) throw persistenceFailure("event_result.get");
    return data;
  }

  /** Consume the token and change the event in one database transaction. */
  public async applyEventResultAction(input: {
    tokenHash: string;
    payloadHash: string;
    tripId: string;
    resultId: string;
    action: "save_event_result" | "expire_event_result";
  }): Promise<{ status: string; agendaItemId: string | null }> {
    const { data, error } = await this.client.rpc(
      "assistant_apply_event_result_action",
      {
        p_token_hash: input.tokenHash,
        p_payload_hash: input.payloadHash,
        p_trip_id: input.tripId,
        p_result_id: input.resultId,
        p_action: input.action,
      },
    );
    if (error) {
      switch (error.message) {
        case "CONFIRMATION_REJECTED":
          throw refusalError(await this.explainRefusal(input.tokenHash));
        case "RESOURCE_NOT_FOUND":
          throw new AppError(
            "RESOURCE_NOT_FOUND",
            "not_found",
            404,
            "Event result was not found.",
          );
        case "EVENT_RESULT_STATE_INVALID":
          throw new AppError(
            "EVENT_RESULT_STATE_INVALID",
            "conflict",
            409,
            "Only a suggested event can be changed this way.",
          );
        case "EVENT_RESULT_EXPIRED":
          throw new AppError(
            "EVENT_RESULT_EXPIRED",
            "conflict",
            409,
            "This event result has expired. Search again before saving it.",
          );
        default:
          throw persistenceFailure("event_result.apply");
      }
    }
    const result = (data ?? {}) as Record<string, Json | undefined>;
    return {
      status: typeof result.status === "string" ? result.status : "unknown",
      agendaItemId:
        typeof result.agenda_item_id === "string"
          ? result.agenda_item_id
          : null,
    };
  }

  /**
   * Audit entries of a trip, newest first: entries about the given resources plus
   * entries whose metadata names the trip (assistant actions, context points).
   */
  public async listActivity(
    resourceIds: string[],
    tripId: string,
    limit: number,
  ): Promise<
    Array<{
      id: string;
      action: string;
      resource_type: string;
      resource_id: string;
      metadata: Json;
      created_at: string;
    }>
  > {
    const columns =
      "id, action, resource_type, resource_id, metadata, created_at";
    const [byResource, byTrip] = await Promise.all([
      resourceIds.length === 0
        ? Promise.resolve({ data: [], error: null })
        : this.client
            .from("activity_logs")
            .select(columns)
            .in("resource_id", resourceIds)
            .order("created_at", { ascending: false })
            .limit(limit),
      this.client
        .from("activity_logs")
        .select(columns)
        .eq("metadata->>trip_id", tripId)
        .order("created_at", { ascending: false })
        .limit(limit),
    ]);
    if (byResource.error || byTrip.error) {
      throw persistenceFailure("activity.list");
    }
    const merged = new Map<
      string,
      {
        id: string;
        action: string;
        resource_type: string;
        resource_id: string;
        metadata: Json;
        created_at: string;
      }
    >();
    for (const entry of [...(byResource.data ?? []), ...(byTrip.data ?? [])]) {
      merged.set(entry.id, entry);
    }
    return [...merged.values()]
      .sort(
        (left, right) =>
          Date.parse(right.created_at) - Date.parse(left.created_at),
      )
      .slice(0, limit);
  }
}
