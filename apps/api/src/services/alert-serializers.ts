import type { SourceRow } from "../supabase/database.types.js";
import type {
  AlertRow,
  BackgroundJobRow,
} from "../supabase/tables/job.types.js";
import { freshnessAt, sourceDto } from "./mobility-serializers.js";

/**
 * Row to API shape for alerts and jobs. Freshness is decided from `expires_at` on
 * every read. Job payloads, lease owners, and provider request ids are not exposed.
 */

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function alertDto(
  row: AlertRow,
  sources: Map<string, SourceRow>,
  now: Date,
): Record<string, unknown> {
  const evidence: Record<string, unknown>[] = [];
  for (const id of row.source_ids) {
    const source = sources.get(id);
    if (source) evidence.push(sourceDto(source, now));
  }
  return {
    id: row.id,
    trip_id: row.trip_id,
    agenda_item_id: row.agenda_item_id,
    journey_leg_id: row.journey_leg_id,
    alert_type: row.alert_type,
    severity: row.severity,
    title: row.title,
    factual_summary: row.factual_summary,
    recommendation_summary: row.recommendation_summary,
    sources: evidence,
    retrieved_at: row.retrieved_at,
    expires_at: row.expires_at,
    triggered_at: row.triggered_at,
    status: row.status,
    freshness: freshnessAt(row.expires_at, now),
    read_at: row.read_at,
    dismissed_at: row.dismissed_at,
    policy_version: row.policy_version,
    reason_codes: stringList(row.reason_codes),
    job_id: row.job_id,
  };
}

export function jobDto(
  row: BackgroundJobRow,
  canRerun: boolean,
): Record<string, unknown> {
  return {
    id: row.id,
    trip_id: row.trip_id,
    parent_job_id: row.parent_job_id,
    job_type: row.job_type,
    status: row.status,
    run_at: row.run_at,
    attempts: row.attempts,
    correlation_id: row.correlation_id,
    execution_id: row.execution_id,
    started_at: row.started_at,
    completed_at: row.completed_at,
    result_summary: row.result_summary,
    error_code: row.error_code,
    error_message: row.error_message,
    can_rerun: canRerun,
    created_at: row.created_at,
  };
}
