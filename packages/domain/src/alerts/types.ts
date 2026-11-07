import type { WeatherPoint } from "../mobility/types.js";

/**
 * Types for the Task 10 alert rules and job scheduling. Everything here is
 * plain data so the rules stay pure: no clock, no database, no provider.
 */

export const JOB_TYPES = [
  "refresh_weather",
  "refresh_traffic",
  "evaluate_alerts",
  "departure_reminder",
  // Task 11
  "generate_invoice",
  "send_invoice_email",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const ALERT_TYPES = [
  "departure_reminder",
  "traffic_risk",
  "weather_risk",
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

export type AlertSeverity = "info" | "low" | "medium" | "high" | "critical";

export const JOB_ERROR_CODES = [
  "JOB_PAYLOAD_INVALID",
  "JOB_CONTEXT_NOT_FOUND",
  "JOB_CONTEXT_UNRESOLVED",
  "JOB_PRECONDITION_FAILED",
  "JOB_PROVIDER_ERROR",
  "JOB_PROVIDER_DATA_EXPIRED",
  "JOB_ALERT_PERSISTENCE_ERROR",
  "JOB_INTERRUPTED",
  "JOB_TIMEOUT",
  "JOB_INTERNAL_ERROR",
] as const;
export type JobErrorCode = (typeof JOB_ERROR_CODES)[number];

/** A job failure with a stable code and a message that is safe to show to a user. */
export class JobError extends Error {
  public readonly code: JobErrorCode;
  public readonly details: Record<string, unknown> | undefined;

  public constructor(
    code: JobErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "JobError";
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Job payloads

export interface RefreshWeatherPayload {
  context_point_id: string;
}

export interface RefreshTrafficPayload {
  journey_leg_id: string;
}

/** Exactly one of the two ids is set. It names what the evaluation covers. */
export interface EvaluateAlertsPayload {
  trigger_job_id: string;
  journey_leg_id: string | null;
  context_point_id: string | null;
}

export interface DepartureReminderPayload {
  journey_leg_id: string;
  /** The departure time the reminder was planned for (ISO, as stored). */
  departure_at: string;
  /** When the reminder was meant to fire (ISO). */
  scheduled_at: string;
  policy_version: string;
}

/** Task 11: issue the invoice of a booking whose payment succeeded. */
export interface GenerateInvoicePayload {
  booking_id: string;
  payment_id: string;
}

/** Task 11: send one pending email delivery. */
export interface SendInvoiceEmailPayload {
  email_delivery_id: string;
}

export type ParsedJob =
  | { job_type: "generate_invoice"; payload: GenerateInvoicePayload }
  | { job_type: "send_invoice_email"; payload: SendInvoiceEmailPayload }
  | { job_type: "refresh_weather"; payload: RefreshWeatherPayload }
  | { job_type: "refresh_traffic"; payload: RefreshTrafficPayload }
  | { job_type: "evaluate_alerts"; payload: EvaluateAlertsPayload }
  | { job_type: "departure_reminder"; payload: DepartureReminderPayload };

// ---------------------------------------------------------------------------
// Rule inputs. These mirror stored rows, with the shapes the rules need.

export type LegStatus = "planned" | "in_progress" | "completed" | "cancelled";
export type AlertAgendaStatus =
  "suggested" | "planned" | "confirmed" | "completed" | "skipped" | "cancelled";
export type Exposure = "indoor" | "outdoor" | "both" | "unknown";

export interface LegInput {
  id: string;
  trip_id: string;
  status: LegStatus;
  /** ISO instant as stored. */
  departure_at: string;
  arrival_deadline: string | null;
  origin_context_point_id: string;
  destination_context_point_id: string;
  origin_label: string;
  destination_label: string;
  /** IANA timezone of the origin context point. */
  timezone: string;
  origin_resolved: boolean;
  destination_resolved: boolean;
}

export interface AgendaInput {
  id: string;
  trip_id: string;
  title: string;
  status: AlertAgendaStatus;
  start_at: string;
  end_at: string;
  timezone: string;
  context_point_id: string | null;
  context_label: string | null;
  context_resolved: boolean;
  /** `metadata.indoor_outdoor` of the agenda item; null when it is not recorded. */
  exposure: Exposure | null;
}

export interface TrafficSnapshotInput {
  id: string;
  source_id: string;
  provider: string;
  traffic_level: "low" | "medium" | "high" | "unknown";
  average_jam_factor: number | null;
  max_jam_factor: number | null;
  closed_segment_count: number;
  incident_count: number;
  segment_count: number;
  retrieved_at: string;
  expires_at: string;
}

export interface WeatherSnapshotInput {
  id: string;
  source_id: string;
  provider: string;
  context_point_id: string;
  timezone: string;
  observed_at: string | null;
  current: WeatherPoint | null;
  hourly: WeatherPoint[];
  daily: WeatherPoint[];
  retrieved_at: string;
  expires_at: string;
}

// ---------------------------------------------------------------------------
// Rule output

export interface InternalSourceDraft {
  title: string;
  provider: string;
  retrieved_at: string;
  expires_at: string;
  observed_for: { from: string; to: string; timezone: string };
}

export interface AlertDraft {
  alert_type: AlertType;
  severity: AlertSeverity;
  title: string;
  factual_summary: string;
  recommendation_summary: string;
  /** Existing source rows that carry the evidence. */
  source_ids: string[];
  /** A source the worker must create first (for a reminder built from the journey leg). */
  internal_source: InternalSourceDraft | null;
  retrieved_at: string;
  expires_at: string;
  deduplication_key: string;
  reason_codes: string[];
  policy_version: string;
  agenda_item_id: string | null;
  journey_leg_id: string | null;
  metadata: Record<string, unknown>;
}

export type AlertDecision =
  | { decision: "create_alert"; alert: AlertDraft }
  | { decision: "no_action"; reason_codes: string[]; summary: string }
  | {
      decision: "blocked";
      error_code: "JOB_PROVIDER_DATA_EXPIRED" | "JOB_PRECONDITION_FAILED";
      reason_codes: string[];
      summary: string;
    };

// ---------------------------------------------------------------------------
// Scheduling

/** Jobs the scheduler plans by itself. The two Task 11 job types are created by the API. */
export type ScheduledJobType = Exclude<
  JobType,
  "generate_invoice" | "send_invoice_email"
>;

export interface PlannedJob {
  job_type: ScheduledJobType;
  idempotency_key: string;
  /** ISO instant at which the job becomes due. */
  run_at: string;
  payload: Record<string, unknown>;
  /** Why the job exists, for the log. */
  reason: string;
}

export interface SkippedSchedule {
  entity: "journey_leg" | "agenda_item";
  id: string;
  reason: string;
}

export interface SchedulePlan {
  jobs: PlannedJob[];
  skipped: SkippedSchedule[];
}
