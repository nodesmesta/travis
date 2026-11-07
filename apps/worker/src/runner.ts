import { JobError, parseJobPayload, type ParsedJob } from "@travelflow/domain";
import type { BackgroundJobRow, Logger } from "@travelflow/api/shared";
import { toJobError } from "./errors.js";
import type { HandlerContext, HandlerOutcome } from "./handlers.js";
import type { JobStorePort } from "./job-store.js";

export interface RunnerSettings {
  workerId: string;
  concurrency: number;
  pollIntervalMs: number;
  leaseSeconds: number;
  heartbeatIntervalMs: number;
  jobTimeoutMs: number;
  shutdownGraceMs: number;
}

export interface RunnerDeps {
  settings: RunnerSettings;
  store: JobStorePort;
  handle(parsed: ParsedJob, context: HandlerContext): Promise<HandlerOutcome>;
  logger: Logger;
}

export interface RunnerCounters {
  claimed: number;
  succeeded: number;
  failed: number;
  interrupted: number;
  abandoned: number;
  alerts_created: number;
  alerts_deduplicated: number;
}

function raceTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(
        new JobError(
          "JOB_TIMEOUT",
          `The job did not finish within ${Math.round(ms / 1000)} seconds.`,
        ),
      );
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function numberField(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

/**
 * Claims due jobs, runs each one once, and records exactly what happened.
 *
 * - At most `concurrency` jobs run at the same time in this process.
 * - A claim holds a lease. A heartbeat renews it. If a heartbeat is refused, the lease is
 *   gone: the job is abandoned and never recorded as a success. The next poll (of any
 *   worker) marks it `interrupted` once the lease has expired.
 * - A job that throws, times out, or has an invalid payload is recorded as `failed` with an
 *   error code. Nothing retries it. Only a manual rerun creates a new job.
 */
export class JobRunner {
  private readonly active = new Map<string, Promise<void>>();
  private stopping = false;
  private wake: (() => void) | null = null;
  private loop: Promise<void> | null = null;
  public readonly counters: RunnerCounters = {
    claimed: 0,
    succeeded: 0,
    failed: 0,
    interrupted: 0,
    abandoned: 0,
    alerts_created: 0,
    alerts_deduplicated: 0,
  };

  public constructor(private readonly deps: RunnerDeps) {}

  public get activeJobs(): number {
    return this.active.size;
  }

  public start(): void {
    if (this.loop) return;
    this.loop = this.run();
  }

  private async run(): Promise<void> {
    const { logger, settings } = this.deps;
    while (!this.stopping) {
      try {
        await this.pollOnce();
      } catch (error) {
        logger.error("worker.poll_failed", {
          worker_id: settings.workerId,
          error_name: error instanceof Error ? error.name : "UnknownError",
          error_message: error instanceof Error ? error.message : "unknown",
        });
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, settings.pollIntervalMs);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
  }

  /** One poll: mark expired leases as interrupted, then claim up to the free capacity. */
  public async pollOnce(): Promise<number> {
    const { store, logger, settings } = this.deps;
    const reclaimed = await store.reclaimExpired();
    for (const job of reclaimed) {
      this.counters.interrupted += 1;
      logger.error("job.interrupted", {
        worker_id: settings.workerId,
        job_id: job.id,
        parent_job_id: job.parent_job_id,
        trip_id: job.trip_id,
        job_type: job.job_type,
        correlation_id: job.correlation_id,
        execution_id: job.execution_id,
        lease_owner: job.lease_owner,
        error_code: "JOB_INTERRUPTED",
      });
    }
    const free = settings.concurrency - this.active.size;
    if (this.stopping || free <= 0) return 0;
    const jobs = await store.claim(
      settings.workerId,
      free,
      settings.leaseSeconds,
    );
    for (const job of jobs) {
      this.counters.claimed += 1;
      const task = this.execute(job).finally(() => {
        this.active.delete(job.id);
      });
      this.active.set(job.id, task);
    }
    return jobs.length;
  }

  private fields(job: BackgroundJobRow): Record<string, unknown> {
    return {
      worker_id: this.deps.settings.workerId,
      job_id: job.id,
      parent_job_id: job.parent_job_id,
      trip_id: job.trip_id,
      job_type: job.job_type,
      correlation_id: job.correlation_id,
      execution_id: job.execution_id,
    };
  }

  private async execute(job: BackgroundJobRow): Promise<void> {
    const { store, logger, settings } = this.deps;
    const base = this.fields(job);
    const startedAt = Date.now();
    logger.info("job.started", {
      ...base,
      run_at: job.run_at,
      lease_expires_at: job.lease_expires_at,
    });

    let leaseLost = false;
    let timedOut = false;
    let beating = false;
    const heartbeat = setInterval(() => {
      if (beating || leaseLost) return;
      beating = true;
      store
        .heartbeat(job.id, settings.workerId, settings.leaseSeconds)
        .then((renewed) => {
          if (!renewed) {
            leaseLost = true;
            logger.error("job.lease_lost", { ...base });
          }
        })
        .catch((error: unknown) => {
          // The lease may still be valid. If it is not, the next poll marks the job interrupted.
          logger.error("job.heartbeat_failed", {
            ...base,
            error_name: error instanceof Error ? error.name : "UnknownError",
          });
        })
        .finally(() => {
          beating = false;
        });
    }, settings.heartbeatIntervalMs);

    const context: HandlerContext = {
      job,
      assertActive: () => {
        if (leaseLost) {
          throw new JobError("JOB_INTERRUPTED", "The job lease was lost.");
        }
        if (timedOut) {
          throw new JobError("JOB_TIMEOUT", "The job timed out.");
        }
      },
    };

    let outcome: HandlerOutcome | null = null;
    let failure: JobError | null = null;
    try {
      const parsed = parseJobPayload(job.job_type, job.payload);
      outcome = await raceTimeout(
        this.deps.handle(parsed, context),
        settings.jobTimeoutMs,
        () => {
          timedOut = true;
        },
      );
      for (const followUp of outcome.followUps) {
        context.assertActive();
        await store.enqueue(followUp);
      }
    } catch (error) {
      outcome = null;
      failure = toJobError(error);
    } finally {
      clearInterval(heartbeat);
    }

    if (leaseLost) {
      this.counters.abandoned += 1;
      logger.error("job.abandoned", {
        ...base,
        latency_ms: Date.now() - startedAt,
        reason: "lease_lost",
      });
      return;
    }

    const latency = Date.now() - startedAt;
    try {
      const recorded = failure
        ? await store.complete({
            jobId: job.id,
            workerId: settings.workerId,
            status: "failed",
            result: { outcome: "failed", ...(failure.details ?? {}) },
            errorCode: failure.code,
            errorMessage: failure.message,
            providerRequestIds: [],
          })
        : await store.complete({
            jobId: job.id,
            workerId: settings.workerId,
            status: "succeeded",
            result: outcome?.result ?? {},
            errorCode: null,
            errorMessage: null,
            providerRequestIds: outcome?.providerRequestIds ?? [],
          });
      if (!recorded) {
        this.counters.abandoned += 1;
        logger.error("job.completion_rejected", {
          ...base,
          latency_ms: latency,
          reason: "job is no longer running under this worker",
        });
        return;
      }
    } catch (error) {
      this.counters.abandoned += 1;
      logger.error("job.complete_failed", {
        ...base,
        latency_ms: latency,
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
      return;
    }

    if (failure) {
      this.counters.failed += 1;
      logger.error("job.finished", {
        ...base,
        status: "failed",
        latency_ms: latency,
        error_code: failure.code,
        error_message: failure.message,
        outcome: "failed",
      });
      return;
    }
    this.counters.succeeded += 1;
    const result = outcome?.result ?? {};
    this.counters.alerts_created += numberField(result.alerts_created);
    this.counters.alerts_deduplicated += numberField(
      result.alerts_deduplicated,
    );
    logger.info("job.finished", {
      ...base,
      status: "succeeded",
      latency_ms: latency,
      outcome: result.outcome ?? null,
      alerts_created: numberField(result.alerts_created),
      alerts_deduplicated: numberField(result.alerts_deduplicated),
    });
  }

  /**
   * Stops claiming, waits up to the grace period for running jobs, and returns the ids that
   * are still running. Those keep their lease and are marked interrupted when it expires.
   */
  public async stop(): Promise<string[]> {
    this.stopping = true;
    this.wake?.();
    await this.loop;
    const grace = this.deps.settings.shutdownGraceMs;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...this.active.values()]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, grace);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return [...this.active.keys()];
  }
}
