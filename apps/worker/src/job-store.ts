import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  BackgroundJobRow,
  BackgroundJobType,
  Database,
  Json,
} from "@travelflow/api/shared";

type Client = SupabaseClient<Database>;

/** What the runner needs from job storage. The database store and the test fake both implement it. */
export interface JobStorePort {
  claim(
    workerId: string,
    limit: number,
    leaseSeconds: number,
  ): Promise<BackgroundJobRow[]>;
  heartbeat(
    jobId: string,
    workerId: string,
    leaseSeconds: number,
  ): Promise<boolean>;
  complete(input: {
    jobId: string;
    workerId: string;
    status: "succeeded" | "failed";
    result: Record<string, unknown>;
    errorCode: string | null;
    errorMessage: string | null;
    providerRequestIds: string[];
  }): Promise<boolean>;
  reclaimExpired(): Promise<BackgroundJobRow[]>;
  enqueue(job: NewJob): Promise<boolean>;
}

export interface NewJob {
  tripId: string;
  userId: string;
  jobType: BackgroundJobType;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  runAt: string;
  correlationId: string;
}

export class JobStoreError extends Error {
  public readonly operation: string;
  public readonly databaseCode: string | undefined;

  public constructor(operation: string, databaseCode?: string) {
    super(`Job storage failed during ${operation}.`);
    this.name = "JobStoreError";
    this.operation = operation;
    this.databaseCode = databaseCode;
  }
}

/** Job storage on Postgres. Every call goes through the SQL functions of migration 0009 or a plain insert. */
export class SupabaseJobStore implements JobStorePort {
  public constructor(private readonly client: Client) {}

  public async claim(
    workerId: string,
    limit: number,
    leaseSeconds: number,
  ): Promise<BackgroundJobRow[]> {
    const { data, error } = await this.client.rpc("claim_background_jobs", {
      p_worker_id: workerId,
      p_limit: limit,
      p_lease_seconds: leaseSeconds,
    });
    if (error) throw new JobStoreError("claim", error.code);
    return data ?? [];
  }

  public async heartbeat(
    jobId: string,
    workerId: string,
    leaseSeconds: number,
  ): Promise<boolean> {
    const { data, error } = await this.client.rpc("heartbeat_background_job", {
      p_job_id: jobId,
      p_worker_id: workerId,
      p_lease_seconds: leaseSeconds,
    });
    if (error) throw new JobStoreError("heartbeat", error.code);
    return data === true;
  }

  public async complete(input: {
    jobId: string;
    workerId: string;
    status: "succeeded" | "failed";
    result: Record<string, unknown>;
    errorCode: string | null;
    errorMessage: string | null;
    providerRequestIds: string[];
  }): Promise<boolean> {
    const { data, error } = await this.client.rpc("complete_background_job", {
      p_job_id: input.jobId,
      p_worker_id: input.workerId,
      p_status: input.status,
      p_result: JSON.parse(JSON.stringify(input.result)) as Json,
      p_error_code: input.errorCode,
      p_error_message: input.errorMessage,
      p_provider_request_ids: input.providerRequestIds,
    });
    if (error) throw new JobStoreError("complete", error.code);
    return data === true;
  }

  public async reclaimExpired(): Promise<BackgroundJobRow[]> {
    const { data, error } = await this.client.rpc(
      "reclaim_expired_background_jobs",
      {},
    );
    if (error) throw new JobStoreError("reclaim", error.code);
    return data ?? [];
  }

  /** True when the job was created, false when its idempotency key already existed. */
  public async enqueue(job: NewJob): Promise<boolean> {
    const { data, error } = await this.client
      .from("background_jobs")
      .upsert(
        {
          trip_id: job.tripId,
          user_id: job.userId,
          job_type: job.jobType,
          payload: JSON.parse(JSON.stringify(job.payload)) as Json,
          idempotency_key: job.idempotencyKey,
          run_at: job.runAt,
          correlation_id: job.correlationId,
        },
        { onConflict: "idempotency_key", ignoreDuplicates: true },
      )
      .select("id");
    if (error) throw new JobStoreError("enqueue", error.code);
    return (data ?? []).length === 1;
  }

  public async cancelQueued(jobId: string, reason: string): Promise<boolean> {
    const { data, error } = await this.client.rpc(
      "cancel_queued_background_job",
      { p_job_id: jobId, p_reason: reason },
    );
    if (error) throw new JobStoreError("cancel", error.code);
    return data === true;
  }

  /** Queued departure reminders of a trip, for the stale check. */
  public async queuedReminders(
    tripId: string,
  ): Promise<
    Array<{ id: string; job_type: string; payload: Record<string, unknown> }>
  > {
    const { data, error } = await this.client
      .from("background_jobs")
      .select("id, job_type, payload")
      .eq("trip_id", tripId)
      .eq("status", "queued")
      .eq("job_type", "departure_reminder");
    if (error) throw new JobStoreError("queued_reminders", error.code);
    return (data ?? []).map((row) => ({
      id: row.id,
      job_type: row.job_type,
      payload:
        row.payload !== null &&
        typeof row.payload === "object" &&
        !Array.isArray(row.payload)
          ? (row.payload as Record<string, unknown>)
          : {},
    }));
  }
}
