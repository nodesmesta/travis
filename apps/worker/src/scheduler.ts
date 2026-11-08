import { randomUUID } from "node:crypto";
import {
  findStaleReminders,
  planSchedule,
  type AlertPolicy,
} from "@travelflow/domain";
import type { Logger } from "@travelflow/api/shared";
import type { SupabaseJobStore } from "./job-store.js";
import type { TripData } from "./trip-data.js";

export interface SchedulerDeps {
  data: TripData;
  jobs: Pick<SupabaseJobStore, "enqueue" | "cancelQueued" | "queuedReminders">;
  logger: Logger;
  now(): Date;
  policy?: AlertPolicy;
  /** Limits the pass to these trips when not empty. */
  tripIds?: string[];
}

export interface ScheduleTickResult {
  trips: number;
  created: number;
  existing: number;
  cancelled: number;
  skipped: number;
  failed_trips: number;
}

/**
 * One scheduler pass. It only creates jobs; it never calls a provider. Keys come from
 * `planSchedule`, so running the pass again, or from a second process, creates nothing
 * new. A trip that cannot be planned is logged as an error and the pass moves on to the
 * next trip, then reports how many trips failed.
 */
export async function runScheduleTick(
  deps: SchedulerDeps,
): Promise<ScheduleTickResult> {
  const tickId = `sched-${randomUUID()}`;
  const result: ScheduleTickResult = {
    trips: 0,
    created: 0,
    existing: 0,
    cancelled: 0,
    skipped: 0,
    failed_trips: 0,
  };
  const trips = await deps.data.schedulableTrips(deps.tripIds ?? []);
  for (const trip of trips) {
    result.trips += 1;
    try {
      const now = deps.now();
      const legs = await deps.data.legs(trip.id);
      const agenda = await deps.data.agenda(trip.id);
      const plan = planSchedule({
        now,
        tripId: trip.id,
        tripStatus: trip.status,
        legs,
        agenda,
        ...(deps.policy ? { policy: deps.policy } : {}),
      });
      result.skipped += plan.skipped.length;
      for (const skipped of plan.skipped) {
        deps.logger.info("scheduler.skipped", {
          correlation_id: tickId,
          trip_id: trip.id,
          entity: skipped.entity,
          entity_id: skipped.id,
          reason: skipped.reason,
        });
      }
      for (const job of plan.jobs) {
        const created = await deps.jobs.enqueue({
          tripId: trip.id,
          userId: trip.user_id,
          jobType: job.job_type,
          payload: job.payload,
          idempotencyKey: job.idempotency_key,
          runAt: job.run_at,
          correlationId: tickId,
        });
        if (created) result.created += 1;
        else result.existing += 1;
      }
      const queued = await deps.jobs.queuedReminders(trip.id);
      for (const stale of findStaleReminders(queued, legs)) {
        if (await deps.jobs.cancelQueued(stale.id, stale.reason)) {
          result.cancelled += 1;
          deps.logger.info("scheduler.cancelled", {
            correlation_id: tickId,
            trip_id: trip.id,
            job_id: stale.id,
            reason: stale.reason,
          });
        }
      }
    } catch (error) {
      result.failed_trips += 1;
      deps.logger.error("scheduler.trip_failed", {
        correlation_id: tickId,
        trip_id: trip.id,
        error_name: error instanceof Error ? error.name : "UnknownError",
        error_message: error instanceof Error ? error.message : "unknown",
      });
    }
  }
  deps.logger.info("scheduler.tick", { correlation_id: tickId, ...result });
  return result;
}
