import { ExternalDataError } from "@travelflow/integrations";
import { JobError } from "@travelflow/domain";
import { AppError } from "@travelflow/api/shared";

const MAX_MESSAGE = 300;

function safe(message: string): string {
  return message.length > MAX_MESSAGE
    ? `${message.slice(0, MAX_MESSAGE - 1)}…`
    : message;
}

/**
 * Turns anything a handler throws into a job error with a stable code. Provider
 * failures keep the provider's own code in `details.provider_error_code`. A stack
 * trace or an unknown error message is never copied into the job record.
 */
export function toJobError(error: unknown): JobError {
  if (error instanceof JobError) return error;
  if (error instanceof ExternalDataError) {
    return new JobError("JOB_PROVIDER_ERROR", safe(error.message), {
      provider: error.provider,
      provider_error_code: error.code,
    });
  }
  if (error instanceof AppError) {
    if (error.category === "provider") {
      return new JobError("JOB_PROVIDER_ERROR", safe(error.message), {
        provider_error_code: error.code,
      });
    }
    if (error.code === "RESOURCE_NOT_FOUND") {
      return new JobError("JOB_CONTEXT_NOT_FOUND", safe(error.message));
    }
    if (
      error.code === "INVOICE_NOT_ELIGIBLE" ||
      error.code === "INVOICE_NOT_READY"
    ) {
      return new JobError("JOB_PRECONDITION_FAILED", safe(error.message), {
        app_error_code: error.code,
      });
    }
    if (error.code === "EXTERNAL_CONTEXT_UNRESOLVED") {
      return new JobError("JOB_CONTEXT_UNRESOLVED", safe(error.message));
    }
    return new JobError("JOB_INTERNAL_ERROR", safe(error.message), {
      app_error_code: error.code,
    });
  }
  return new JobError("JOB_INTERNAL_ERROR", "The job failed unexpectedly.");
}
