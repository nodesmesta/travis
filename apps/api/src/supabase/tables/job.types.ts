import type { Json, TableDefinition } from "../database.types.js";

/** Table and function types for Task 10 (migration 0009). */

export type BackgroundJobType =
  | "refresh_weather"
  | "refresh_traffic"
  | "evaluate_alerts"
  | "departure_reminder";

export type BackgroundJobStatus =
  "queued" | "running" | "succeeded" | "failed" | "interrupted" | "cancelled";

export type BackgroundJobRow = {
  id: string;
  trip_id: string;
  user_id: string;
  job_type: BackgroundJobType;
  payload: Json;
  status: BackgroundJobStatus;
  idempotency_key: string;
  run_at: string;
  attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  parent_job_id: string | null;
  correlation_id: string;
  execution_id: string | null;
  created_by: string | null;
  result_summary: Json | null;
  error_code: string | null;
  error_message: string | null;
  provider_request_ids: Json;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AlertTypeValue =
  "departure_reminder" | "traffic_risk" | "weather_risk";

export type AlertSeverityValue =
  "info" | "low" | "medium" | "high" | "critical";

export type AlertStatusValue = "unread" | "read" | "dismissed";

export type AlertRow = {
  id: string;
  trip_id: string;
  agenda_item_id: string | null;
  journey_leg_id: string | null;
  job_id: string | null;
  alert_type: AlertTypeValue;
  severity: AlertSeverityValue;
  title: string;
  factual_summary: string;
  recommendation_summary: string;
  source_ids: string[];
  retrieved_at: string;
  expires_at: string;
  triggered_at: string;
  deduplication_key: string;
  policy_version: string;
  reason_codes: Json;
  status: AlertStatusValue;
  read_at: string | null;
  dismissed_at: string | null;
  metadata: Json;
  created_at: string;
  updated_at: string;
};

export type JobTables = {
  background_jobs: TableDefinition<
    BackgroundJobRow,
    {
      id?: string;
      trip_id: string;
      user_id: string;
      job_type: BackgroundJobType;
      payload: Json;
      idempotency_key: string;
      run_at?: string;
      parent_job_id?: string | null;
      correlation_id: string;
      created_by?: string | null;
    },
    never
  >;
  alerts: TableDefinition<
    AlertRow,
    never,
    {
      status?: AlertStatusValue;
      read_at?: string | null;
      dismissed_at?: string | null;
    }
  >;
};

export type JobFunctions = {
  claim_background_jobs: {
    Args: { p_worker_id: string; p_limit: number; p_lease_seconds: number };
    Returns: BackgroundJobRow[];
  };
  heartbeat_background_job: {
    Args: { p_job_id: string; p_worker_id: string; p_lease_seconds: number };
    Returns: boolean;
  };
  complete_background_job: {
    Args: {
      p_job_id: string;
      p_worker_id: string;
      p_status: "succeeded" | "failed";
      p_result: Json;
      p_error_code: string | null;
      p_error_message: string | null;
      p_provider_request_ids: Json;
    };
    Returns: boolean;
  };
  reclaim_expired_background_jobs: {
    Args: Record<string, never>;
    Returns: BackgroundJobRow[];
  };
  cancel_queued_background_job: {
    Args: { p_job_id: string; p_reason: string };
    Returns: boolean;
  };
  create_alert: {
    Args: { p_alert: Json; p_sources: Json };
    Returns: Json;
  };
};

export type { Json, TableDefinition };
