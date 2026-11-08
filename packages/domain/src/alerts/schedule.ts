import { ALERT_POLICY_V1, type AlertPolicy } from "./policy.js";
import { floorToInterval, localIso } from "./time.js";
import type {
  AgendaInput,
  LegInput,
  PlannedJob,
  SchedulePlan,
  SkippedSchedule,
} from "./types.js";

/**
 * Plans the jobs a trip needs right now. The plan is a pure function of the
 * clock and the stored itinerary: calling it twice at the same moment returns
 * the same idempotency keys, so a restarted scheduler cannot create duplicates.
 *
 * Time zones: due times are absolute instants. The zone of the journey leg
 * origin (or of the agenda item) is used to write the instant into the
 * idempotency key, so the key shows the local wall clock time and offset the
 * user sees. A departure moved by an hour, or a zone whose offset changes,
 * produces a different key and therefore a new job.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export interface ScheduleInput {
  now: Date;
  tripId: string;
  tripStatus: "draft" | "confirmed" | "active" | "completed";
  legs: LegInput[];
  agenda: AgendaInput[];
  policy?: AlertPolicy;
}

export function planSchedule(input: ScheduleInput): SchedulePlan {
  const policy = input.policy ?? ALERT_POLICY_V1;
  const nowMs = input.now.getTime();
  const jobs: PlannedJob[] = [];
  const skipped: SkippedSchedule[] = [];
  // A draft or completed trip gets no jobs.
  if (input.tripStatus !== "confirmed" && input.tripStatus !== "active") {
    return { jobs, skipped };
  }
  const horizonMs = policy.schedule_horizon_hours * HOUR_MS;

  for (const leg of input.legs) {
    if (leg.status !== "planned") continue;
    const departureMs = Date.parse(leg.departure_at);
    if (departureMs <= nowMs || departureMs - nowMs > horizonMs) continue;

    const scheduledMs =
      departureMs - policy.departure_reminder_lead_minutes * MINUTE_MS;
    jobs.push({
      job_type: "departure_reminder",
      idempotency_key: `trip:${input.tripId}:leg:${leg.id}:departure_reminder:${localIso(scheduledMs, leg.timezone)}`,
      run_at: new Date(Math.max(scheduledMs, nowMs)).toISOString(),
      payload: {
        journey_leg_id: leg.id,
        departure_at: leg.departure_at,
        scheduled_at: new Date(scheduledMs).toISOString(),
        policy_version: policy.version,
      },
      reason: "journey leg departs within the schedule horizon",
    });

    if (departureMs - nowMs <= policy.traffic_horizon_minutes * MINUTE_MS) {
      if (!leg.origin_resolved || !leg.destination_resolved) {
        skipped.push({
          entity: "journey_leg",
          id: leg.id,
          reason: "CONTEXT_UNRESOLVED",
        });
      } else {
        const slot = floorToInterval(
          nowMs,
          policy.traffic_refresh_interval_minutes,
        );
        jobs.push({
          job_type: "refresh_traffic",
          idempotency_key: `trip:${input.tripId}:leg:${leg.id}:refresh_traffic:${localIso(slot, leg.timezone)}`,
          run_at: input.now.toISOString(),
          payload: { journey_leg_id: leg.id },
          reason: "journey leg departs within the live traffic horizon",
        });
      }
    }
  }

  const weatherPoints = new Set<string>();
  for (const item of input.agenda) {
    if (item.status !== "planned" && item.status !== "confirmed") continue;
    // Weather is a property of the place, not of how exposed the item is: the trip
    // needs the forecast wherever it goes. The alert rules still decide risk from
    // the item's exposure, so an indoor stay is not turned into a weather warning.
    const startMs = Date.parse(item.start_at);
    const endMs = Date.parse(item.end_at);
    if (endMs <= nowMs) continue;
    if (startMs - nowMs > policy.weather_horizon_hours * HOUR_MS) continue;
    if (!item.context_resolved || item.context_point_id === null) {
      skipped.push({
        entity: "agenda_item",
        id: item.id,
        reason: "CONTEXT_UNRESOLVED",
      });
      continue;
    }
    if (weatherPoints.has(item.context_point_id)) continue;
    weatherPoints.add(item.context_point_id);
    const slot = floorToInterval(
      nowMs,
      policy.weather_refresh_interval_minutes,
    );
    jobs.push({
      job_type: "refresh_weather",
      idempotency_key: `trip:${input.tripId}:context_point:${item.context_point_id}:refresh_weather:${localIso(slot, item.timezone)}`,
      run_at: input.now.toISOString(),
      payload: { context_point_id: item.context_point_id },
      reason: "outdoor agenda item starts within the weather horizon",
    });
  }

  return { jobs, skipped };
}

export interface QueuedReminder {
  id: string;
  job_type: string;
  payload: Record<string, unknown>;
}

export interface StaleJob {
  id: string;
  reason: "LEG_NO_LONGER_PLANNED" | "DEPARTURE_CHANGED";
}

/**
 * Queued departure reminders that no longer match the itinerary. They are
 * cancelled so a changed departure never fires a reminder for the old time.
 */
export function findStaleReminders(
  queued: QueuedReminder[],
  legs: LegInput[],
): StaleJob[] {
  const byId = new Map(legs.map((leg) => [leg.id, leg]));
  const stale: StaleJob[] = [];
  for (const job of queued) {
    if (job.job_type !== "departure_reminder") continue;
    const leg = byId.get(String(job.payload.journey_leg_id));
    if (!leg || leg.status !== "planned") {
      stale.push({ id: job.id, reason: "LEG_NO_LONGER_PLANNED" });
      continue;
    }
    const planned = Date.parse(String(job.payload.departure_at));
    if (planned !== Date.parse(leg.departure_at)) {
      stale.push({ id: job.id, reason: "DEPARTURE_CHANGED" });
    }
  }
  return stale;
}
