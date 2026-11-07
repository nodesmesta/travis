import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../errors.js";
import type { Database, SourceRow } from "../supabase/database.types.js";
import type {
  AlertRow,
  AlertStatusValue,
  BackgroundJobRow,
  BackgroundJobType,
} from "../supabase/tables/job.types.js";
import type { Json } from "../supabase/database.types.js";

type Client = SupabaseClient<Database>;

function persistenceFailure(
  operation: string,
  databaseCode?: string,
): AppError {
  return new AppError(
    "PERSISTENCE_ERROR",
    "persistence",
    500,
    "Alerts and jobs could not be saved or loaded.",
    { operation, ...(databaseCode ? { database_code: databaseCode } : {}) },
  );
}

/** Alerts read and changed with the signed-in user's rights, so row level security applies. */
export class SupabaseAlertRepository {
  public constructor(private readonly client: Client) {}

  public async listForTrip(tripId: string): Promise<AlertRow[]> {
    const { data, error } = await this.client
      .from("alerts")
      .select("*")
      .eq("trip_id", tripId)
      .order("triggered_at", { ascending: false });
    if (error) throw persistenceFailure("alerts.list", error.code);
    return data ?? [];
  }

  public async get(tripId: string, alertId: string): Promise<AlertRow | null> {
    const { data, error } = await this.client
      .from("alerts")
      .select("*")
      .eq("trip_id", tripId)
      .eq("id", alertId)
      .maybeSingle();
    if (error) throw persistenceFailure("alerts.get", error.code);
    return data;
  }

  /** Moves an alert forward. Returns true when this call changed the row. */
  public async transition(
    tripId: string,
    alertId: string,
    to: "read" | "dismissed",
  ): Promise<boolean> {
    const allowedFrom: AlertStatusValue[] =
      to === "read" ? ["unread"] : ["unread", "read"];
    const { data, error } = await this.client
      .from("alerts")
      .update({ status: to })
      .eq("trip_id", tripId)
      .eq("id", alertId)
      .in("status", allowedFrom)
      .select("id");
    if (error) throw persistenceFailure(`alerts.${to}`, error.code);
    return (data ?? []).length === 1;
  }

  public async sourcesByIds(
    tripId: string,
    ids: string[],
  ): Promise<SourceRow[]> {
    if (ids.length === 0) return [];
    const { data, error } = await this.client
      .from("sources")
      .select("*")
      .eq("trip_id", tripId)
      .in("id", ids);
    if (error) throw persistenceFailure("sources.get", error.code);
    return data ?? [];
  }
}

/**
 * Jobs are read with the user's rights. The only write is a manual rerun, which
 * needs the service role client because users have no insert right on jobs.
 */
export class SupabaseJobRepository {
  public constructor(
    private readonly userClient: Client,
    private readonly adminClient: () => Client,
  ) {}

  public async listForTrip(
    tripId: string,
    limit: number,
  ): Promise<BackgroundJobRow[]> {
    const { data, error } = await this.userClient
      .from("background_jobs")
      .select("*")
      .eq("trip_id", tripId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw persistenceFailure("jobs.list", error.code);
    return data ?? [];
  }

  public async get(
    tripId: string,
    jobId: string,
  ): Promise<BackgroundJobRow | null> {
    const { data, error } = await this.userClient
      .from("background_jobs")
      .select("*")
      .eq("trip_id", tripId)
      .eq("id", jobId)
      .maybeSingle();
    if (error) throw persistenceFailure("jobs.get", error.code);
    return data;
  }

  /** Ids among `parentIds` that already have a queued or running rerun. */
  public async parentsWithActiveRerun(
    tripId: string,
    parentIds: string[],
  ): Promise<Set<string>> {
    if (parentIds.length === 0) return new Set();
    const { data, error } = await this.userClient
      .from("background_jobs")
      .select("parent_job_id")
      .eq("trip_id", tripId)
      .in("parent_job_id", parentIds)
      .in("status", ["queued", "running"]);
    if (error) throw persistenceFailure("jobs.active_reruns", error.code);
    const result = new Set<string>();
    for (const row of data ?? []) {
      if (row.parent_job_id) result.add(row.parent_job_id);
    }
    return result;
  }

  public async insertRerun(input: {
    tripId: string;
    userId: string;
    jobType: BackgroundJobType;
    payload: Json;
    parentJobId: string;
    idempotencyKey: string;
    correlationId: string;
  }): Promise<BackgroundJobRow> {
    const { data, error } = await this.adminClient()
      .from("background_jobs")
      .insert({
        trip_id: input.tripId,
        user_id: input.userId,
        job_type: input.jobType,
        payload: input.payload,
        idempotency_key: input.idempotencyKey,
        parent_job_id: input.parentJobId,
        correlation_id: input.correlationId,
        created_by: input.userId,
      })
      .select("*")
      .single();
    if (error || !data) {
      if (error?.code === "23505") {
        throw new AppError(
          "JOB_RERUN_ALREADY_ACTIVE",
          "conflict",
          409,
          "This job already has a rerun that has not finished.",
        );
      }
      if (error?.message.includes("JOB_PARENT_NOT_RERUNNABLE")) {
        throw new AppError(
          "JOB_RERUN_NOT_ALLOWED",
          "conflict",
          409,
          "Only a failed or interrupted job can be rerun.",
        );
      }
      throw persistenceFailure("jobs.rerun", error?.code);
    }
    return data;
  }
}
