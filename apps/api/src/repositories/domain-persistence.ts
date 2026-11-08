import type {
  ActivityLogWriter,
  CommandContext,
  IdempotencyStore,
} from "@travelflow/domain";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../errors.js";
import type { Database, Json } from "../supabase/database.types.js";

const PROCESSING_WAIT_MS = 100;
const PROCESSING_WAIT_ATTEMPTS = 50;

type UserScopedClient = SupabaseClient<Database>;

type IdempotencyRow =
  Database["public"]["Tables"]["idempotency_records"]["Row"];

function persistenceFailure(operation: string): AppError {
  return new AppError(
    "PERSISTENCE_ERROR",
    "persistence",
    500,
    "The persistence operation could not be completed.",
    { operation },
  );
}

function serializedResult(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

export class SupabaseIdempotencyStore implements IdempotencyStore {
  public constructor(private readonly client: UserScopedClient) {}

  public async execute<T>(
    scope: string,
    context: CommandContext,
    operation: () => Promise<T>,
  ): Promise<T> {
    const existing = await this.find(scope, context);
    if (existing) {
      return this.replayOrWait(existing, scope, context);
    }

    const { data, error } = await this.client
      .from("idempotency_records")
      .insert({
        actor_user_id: context.actorUserId,
        scope,
        idempotency_key: context.idempotencyKey,
        request_hash: context.requestHash,
        status: "processing",
        response_body: {},
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      })
      .select("*")
      .single();

    if (error || !data) {
      if (error?.code === "23505") {
        const claimed = await this.find(scope, context);
        if (claimed) return this.replayOrWait(claimed, scope, context);
      }
      throw persistenceFailure("idempotency.claim");
    }

    try {
      const result = await operation();
      const { error: completeError } = await this.client
        .from("idempotency_records")
        .update({
          status: "completed",
          response_body: serializedResult(result),
          completed_at: new Date().toISOString(),
        })
        .eq("id", data.id)
        .eq("actor_user_id", context.actorUserId);
      if (completeError) throw persistenceFailure("idempotency.complete");
      return result;
    } catch (error) {
      await this.client
        .from("idempotency_records")
        .delete()
        .eq("id", data.id)
        .eq("actor_user_id", context.actorUserId);
      throw error;
    }
  }

  private async find(
    scope: string,
    context: CommandContext,
  ): Promise<IdempotencyRow | null> {
    const { data, error } = await this.client
      .from("idempotency_records")
      .select("*")
      .eq("actor_user_id", context.actorUserId)
      .eq("scope", scope)
      .eq("idempotency_key", context.idempotencyKey)
      .maybeSingle();
    if (error) throw persistenceFailure("idempotency.lookup");
    return data;
  }

  private async replayOrWait<T>(
    row: IdempotencyRow,
    scope: string,
    context: CommandContext,
  ): Promise<T> {
    if (row.request_hash !== context.requestHash) {
      throw new AppError(
        "IDEMPOTENCY_CONFLICT",
        "conflict",
        409,
        "The idempotency key was already used with a different request.",
      );
    }
    if (row.status === "completed") {
      return row.response_body as T;
    }

    for (let attempt = 0; attempt < PROCESSING_WAIT_ATTEMPTS; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, PROCESSING_WAIT_MS));
      const current = await this.find(scope, context);
      if (!current) {
        throw new AppError(
          "IDEMPOTENCY_RETRY_REQUIRED",
          "conflict",
          409,
          "The original command is no longer available. Retry with a new request.",
        );
      }
      if (current.request_hash !== context.requestHash) {
        throw new AppError(
          "IDEMPOTENCY_CONFLICT",
          "conflict",
          409,
          "The idempotency key was already used with a different request.",
        );
      }
      if (current.status === "completed") {
        return current.response_body as T;
      }
    }

    throw new AppError(
      "IDEMPOTENCY_IN_PROGRESS",
      "conflict",
      409,
      "An equivalent command is still being processed.",
    );
  }
}

export class SupabaseActivityLogWriter implements ActivityLogWriter {
  public constructor(private readonly client: UserScopedClient) {}

  public async append(entry: {
    actorUserId: string;
    action: string;
    resourceType: string;
    resourceId: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const { error } = await this.client.from("activity_logs").insert({
      actor_user_id: entry.actorUserId,
      action: entry.action,
      resource_type: entry.resourceType,
      resource_id: entry.resourceId,
      metadata: serializedResult(entry.metadata ?? {}),
    });
    if (error) throw persistenceFailure("activity_logs.append");
  }
}
