import {
  JOB_TYPES,
  JobError,
  type EvaluateAlertsPayload,
  type JobType,
  type ParsedJob,
} from "./types.js";
import { parseInstant } from "./time.js";

/**
 * Job payloads come from the database, so they are checked again before any
 * work starts. A payload with a missing, extra, or malformed field fails the
 * job with JOB_PAYLOAD_INVALID. Nothing is guessed or defaulted.
 */

const HEX = "0123456789abcdef";

/** True for a canonical UUID such as 123e4567-e89b-12d3-a456-426614174000. */
export function isUuid(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 36) return false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] as string;
    if (index === 8 || index === 13 || index === 18 || index === 23) {
      if (char !== "-") return false;
    } else if (!HEX.includes(char.toLowerCase())) {
      return false;
    }
  }
  return true;
}

export function isJobType(value: string): value is JobType {
  return (JOB_TYPES as readonly string[]).includes(value);
}

function invalid(message: string): JobError {
  return new JobError("JOB_PAYLOAD_INVALID", message);
}

function record(payload: unknown): Record<string, unknown> {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    throw invalid("The job payload must be an object.");
  }
  return payload as Record<string, unknown>;
}

function onlyKeys(payload: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(payload)) {
    if (!allowed.includes(key))
      throw invalid(`The job payload has an unknown field "${key}".`);
  }
}

function uuidField(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (!isUuid(value)) throw invalid(`${field} must be a UUID.`);
  return value;
}

function instantField(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string")
    throw invalid(`${field} must be an ISO date-time.`);
  parseInstant(value, field);
  return value;
}

export function parseJobPayload(jobType: string, payload: unknown): ParsedJob {
  if (!isJobType(jobType)) {
    throw invalid(`"${jobType}" is not a supported job type.`);
  }
  const body = record(payload);
  switch (jobType) {
    case "generate_invoice":
      onlyKeys(body, ["booking_id", "payment_id"]);
      return {
        job_type: jobType,
        payload: {
          booking_id: uuidField(body, "booking_id"),
          payment_id: uuidField(body, "payment_id"),
        },
      };
    case "send_invoice_email":
      onlyKeys(body, ["email_delivery_id"]);
      return {
        job_type: jobType,
        payload: { email_delivery_id: uuidField(body, "email_delivery_id") },
      };
    case "refresh_weather":
      onlyKeys(body, ["context_point_id"]);
      return {
        job_type: jobType,
        payload: { context_point_id: uuidField(body, "context_point_id") },
      };
    case "refresh_traffic":
      onlyKeys(body, ["journey_leg_id"]);
      return {
        job_type: jobType,
        payload: { journey_leg_id: uuidField(body, "journey_leg_id") },
      };
    case "evaluate_alerts": {
      onlyKeys(body, ["trigger_job_id", "journey_leg_id", "context_point_id"]);
      const leg = body.journey_leg_id ?? null;
      const point = body.context_point_id ?? null;
      if ((leg === null) === (point === null)) {
        throw invalid(
          "Exactly one of journey_leg_id and context_point_id is required.",
        );
      }
      const parsed: EvaluateAlertsPayload = {
        trigger_job_id: uuidField(body, "trigger_job_id"),
        journey_leg_id: leg === null ? null : uuidField(body, "journey_leg_id"),
        context_point_id:
          point === null ? null : uuidField(body, "context_point_id"),
      };
      return { job_type: jobType, payload: parsed };
    }
    case "departure_reminder": {
      onlyKeys(body, [
        "journey_leg_id",
        "departure_at",
        "scheduled_at",
        "policy_version",
      ]);
      const policyVersion = body.policy_version;
      if (typeof policyVersion !== "string" || policyVersion.length === 0) {
        throw invalid("policy_version must be a non-empty string.");
      }
      return {
        job_type: jobType,
        payload: {
          journey_leg_id: uuidField(body, "journey_leg_id"),
          departure_at: instantField(body, "departure_at"),
          scheduled_at: instantField(body, "scheduled_at"),
          policy_version: policyVersion,
        },
      };
    }
  }
}
