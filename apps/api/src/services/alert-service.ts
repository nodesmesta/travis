import type { CommandContext } from "@travelflow/domain";
import { AppError } from "../errors.js";
import type {
  SupabaseActivityLogWriter,
  SupabaseIdempotencyStore,
} from "../repositories/domain-persistence.js";
import type {
  SupabaseAlertRepository,
  SupabaseJobRepository,
} from "../repositories/alert-repository.js";
import type { SupabaseTripContextRepository } from "../repositories/trip-context-repository.js";
import type { SourceRow } from "../supabase/database.types.js";
import { alertDto, jobDto } from "./alert-serializers.js";

export interface AlertDeps {
  trips: SupabaseTripContextRepository;
  alerts: SupabaseAlertRepository;
  jobs: SupabaseJobRepository;
  idempotency: SupabaseIdempotencyStore;
  activityLog: SupabaseActivityLogWriter;
  now?: () => Date;
}

function notFound(message: string): AppError {
  return new AppError("RESOURCE_NOT_FOUND", "not_found", 404, message);
}

export class AlertService {
  private readonly now: () => Date;

  public constructor(private readonly deps: AlertDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private async requireTrip(tripId: string, userId: string): Promise<void> {
    const trip = await this.deps.trips.getTripRowForUser(tripId, userId);
    if (!trip) throw notFound("Trip was not found.");
  }

  private async sourceMap(
    tripId: string,
    rows: Array<{ source_ids: string[] }>,
  ): Promise<Map<string, SourceRow>> {
    const ids = [...new Set(rows.flatMap((row) => row.source_ids))];
    const sources = await this.deps.alerts.sourcesByIds(tripId, ids);
    return new Map(sources.map((source) => [source.id, source]));
  }

  /**
   * Visible alerts, newest first. An alert whose data has expired is left out, and so is a
   * dismissed one, unless the caller asks for them. The hidden counts say what was left out.
   */
  public async list(input: {
    tripId: string;
    userId: string;
    requestId: string;
    includeDismissed: boolean;
    includeExpired: boolean;
  }): Promise<Record<string, unknown>> {
    await this.requireTrip(input.tripId, input.userId);
    const now = this.now();
    const rows = await this.deps.alerts.listForTrip(input.tripId);
    let hiddenDismissed = 0;
    let hiddenExpired = 0;
    const visible: typeof rows = [];
    for (const row of rows) {
      if (row.status === "dismissed" && !input.includeDismissed) {
        hiddenDismissed += 1;
        continue;
      }
      if (
        Date.parse(row.expires_at) <= now.getTime() &&
        !input.includeExpired
      ) {
        if (row.status !== "dismissed") hiddenExpired += 1;
        continue;
      }
      visible.push(row);
    }
    const sources = await this.sourceMap(input.tripId, visible);
    return {
      request_id: input.requestId,
      items: visible.map((row) => alertDto(row, sources, now)),
      hidden_dismissed_count: hiddenDismissed,
      hidden_expired_count: hiddenExpired,
    };
  }

  /** `read` and `dismiss` only move forward. Repeating a call, or reading a dismissed alert, changes nothing. */
  public async changeState(
    input: {
      tripId: string;
      alertId: string;
      userId: string;
      requestId: string;
      to: "read" | "dismissed";
    },
    command: CommandContext,
  ): Promise<Record<string, unknown>> {
    await this.requireTrip(input.tripId, input.userId);
    const existing = await this.deps.alerts.get(input.tripId, input.alertId);
    if (!existing) throw notFound("Alert was not found.");
    return this.deps.idempotency.execute(
      `alert.${input.to}:${input.alertId}`,
      command,
      async () => {
        const changed = await this.deps.alerts.transition(
          input.tripId,
          input.alertId,
          input.to,
        );
        if (changed) {
          await this.deps.activityLog.append({
            actorUserId: input.userId,
            action: input.to === "read" ? "alert.read" : "alert.dismissed",
            resourceType: "alert",
            resourceId: input.alertId,
            metadata: { trip_id: input.tripId },
          });
        }
        const current = await this.deps.alerts.get(input.tripId, input.alertId);
        if (!current) throw notFound("Alert was not found.");
        const sources = await this.sourceMap(input.tripId, [current]);
        return {
          request_id: input.requestId,
          alert: alertDto(current, sources, this.now()),
        };
      },
    );
  }

  public async listJobs(input: {
    tripId: string;
    userId: string;
    requestId: string;
    limit: number;
  }): Promise<Record<string, unknown>> {
    await this.requireTrip(input.tripId, input.userId);
    const rows = await this.deps.jobs.listForTrip(input.tripId, input.limit);
    const rerunnable = rows
      .filter((row) => row.status === "failed" || row.status === "interrupted")
      .map((row) => row.id);
    const active = await this.deps.jobs.parentsWithActiveRerun(
      input.tripId,
      rerunnable,
    );
    return {
      request_id: input.requestId,
      items: rows.map((row) =>
        jobDto(row, rerunnable.includes(row.id) && !active.has(row.id)),
      ),
    };
  }

  /**
   * Manual rerun: a new queued job that points at the failed or interrupted one.
   * The original is never changed. The trip is checked against the signed-in user first.
   */
  public async rerunJob(
    input: {
      tripId: string;
      jobId: string;
      userId: string;
      requestId: string;
    },
    command: CommandContext,
  ): Promise<Record<string, unknown>> {
    await this.requireTrip(input.tripId, input.userId);
    const parent = await this.deps.jobs.get(input.tripId, input.jobId);
    if (!parent) throw notFound("Job was not found.");
    return this.deps.idempotency.execute(
      `job.rerun:${input.jobId}`,
      command,
      async () => {
        if (parent.status !== "failed" && parent.status !== "interrupted") {
          throw new AppError(
            "JOB_RERUN_NOT_ALLOWED",
            "conflict",
            409,
            "Only a failed or interrupted job can be rerun.",
            { status: parent.status },
          );
        }
        const active = await this.deps.jobs.parentsWithActiveRerun(
          input.tripId,
          [parent.id],
        );
        if (active.has(parent.id)) {
          throw new AppError(
            "JOB_RERUN_ALREADY_ACTIVE",
            "conflict",
            409,
            "This job already has a rerun that has not finished.",
          );
        }
        const created = await this.deps.jobs.insertRerun({
          tripId: input.tripId,
          userId: input.userId,
          jobType: parent.job_type,
          payload: parent.payload,
          parentJobId: parent.id,
          idempotencyKey: `rerun:${parent.id}:${command.idempotencyKey}`,
          correlationId: input.requestId,
        });
        await this.deps.activityLog.append({
          actorUserId: input.userId,
          action: "job.rerun_requested",
          resourceType: "background_job",
          resourceId: created.id,
          metadata: {
            trip_id: input.tripId,
            parent_job_id: parent.id,
            job_type: parent.job_type,
            correlation_id: input.requestId,
          },
        });
        return { request_id: input.requestId, job: jobDto(created, false) };
      },
    );
  }
}
