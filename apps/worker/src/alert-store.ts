import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { JobError, type AlertDraft } from "@travelflow/domain";
import type { Database, Json } from "@travelflow/api/shared";

type Client = SupabaseClient<Database>;

export interface AlertWriteResult {
  created: boolean;
  refreshed: boolean;
  alertId: string;
}

export interface AlertWriter {
  create(input: {
    tripId: string;
    jobId: string;
    draft: AlertDraft;
    now: Date;
  }): Promise<AlertWriteResult>;
}

function json(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

/**
 * Stores alerts through `create_alert`. The deduplication key is unique per trip, so two
 * workers evaluating the same condition end with one row. A reminder built from the
 * journey leg gets its own internal source row in the same transaction.
 */
export class SupabaseAlertWriter implements AlertWriter {
  public constructor(private readonly client: Client) {}

  public async create(input: {
    tripId: string;
    jobId: string;
    draft: AlertDraft;
    now: Date;
  }): Promise<AlertWriteResult> {
    const { draft } = input;
    const sources: unknown[] = [];
    const sourceIds = [...draft.source_ids];
    if (draft.internal_source) {
      const id = randomUUID();
      sourceIds.push(id);
      sources.push({
        id,
        trip_id: input.tripId,
        kind: "internal",
        provider: draft.internal_source.provider,
        url: null,
        title: draft.internal_source.title,
        retrieved_at: draft.internal_source.retrieved_at,
        freshness: "fresh",
        expires_at: draft.internal_source.expires_at,
        observed_for: draft.internal_source.observed_for,
        content_hash: null,
        metadata: { basis: "journey_leg", job_id: input.jobId },
        created_at: input.now.toISOString(),
      });
    }
    const { data, error } = await this.client.rpc("create_alert", {
      p_alert: json({
        trip_id: input.tripId,
        agenda_item_id: draft.agenda_item_id,
        journey_leg_id: draft.journey_leg_id,
        job_id: input.jobId,
        alert_type: draft.alert_type,
        severity: draft.severity,
        title: draft.title,
        factual_summary: draft.factual_summary,
        recommendation_summary: draft.recommendation_summary,
        source_ids: sourceIds,
        retrieved_at: draft.retrieved_at,
        expires_at: draft.expires_at,
        deduplication_key: draft.deduplication_key,
        policy_version: draft.policy_version,
        reason_codes: draft.reason_codes,
        metadata: draft.metadata,
      }),
      p_sources: json(sources),
    });
    if (
      error ||
      data === null ||
      typeof data !== "object" ||
      Array.isArray(data)
    ) {
      throw new JobError(
        "JOB_ALERT_PERSISTENCE_ERROR",
        "The alert could not be saved.",
        { database_code: error?.code ?? "UNEXPECTED_RESPONSE" },
      );
    }
    const body = data as Record<string, unknown>;
    return {
      created: body.created === true,
      refreshed: body.refreshed === true,
      alertId: String(body.alert_id),
    };
  }
}
