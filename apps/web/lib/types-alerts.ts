/** Shapes returned by the alert and job endpoints (contracts/schemas/alert.schema.json and background-job.schema.json). */

export type AlertSeverity = "info" | "low" | "medium" | "high" | "critical";
export type AlertType = "departure_reminder" | "traffic_risk" | "weather_risk";
export type AlertState = "unread" | "read" | "dismissed";

export interface AlertSourceView {
  id: string;
  kind: string;
  provider: string;
  title?: string;
  url?: string;
  retrieved_at: string;
  freshness: "fresh" | "expired" | "unavailable";
  expires_at?: string;
}

export interface AlertView {
  id: string;
  trip_id: string;
  agenda_item_id: string | null;
  journey_leg_id: string | null;
  alert_type: AlertType;
  severity: AlertSeverity;
  title: string;
  factual_summary: string;
  recommendation_summary: string;
  sources: AlertSourceView[];
  retrieved_at: string;
  expires_at: string;
  triggered_at: string;
  status: AlertState;
  freshness: "fresh" | "expired";
  read_at: string | null;
  dismissed_at: string | null;
  policy_version: string;
  reason_codes: string[];
  job_id: string | null;
}

export interface AlertList {
  request_id: string;
  items: AlertView[];
  hidden_dismissed_count: number;
  hidden_expired_count: number;
}

export type JobStatus =
  "queued" | "running" | "succeeded" | "failed" | "interrupted" | "cancelled";

export type JobType =
  | "refresh_weather"
  | "refresh_traffic"
  | "evaluate_alerts"
  | "departure_reminder"
  | "generate_invoice"
  | "send_invoice_email";

export interface JobView {
  id: string;
  trip_id: string;
  parent_job_id: string | null;
  job_type: JobType;
  status: JobStatus;
  run_at: string;
  attempts: number;
  correlation_id: string;
  execution_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  result_summary: Record<string, unknown> | null;
  error_code: string | null;
  error_message: string | null;
  can_rerun: boolean;
  created_at: string;
}

export interface JobList {
  request_id: string;
  items: JobView[];
}
