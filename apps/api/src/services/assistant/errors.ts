import { AssistantError, type AssistantErrorCode } from "@travelflow/domain";
import { ExternalDataError } from "@travelflow/integrations";
import { AppError } from "../../errors.js";

const ASSISTANT_ERROR_MAP: Record<
  AssistantErrorCode,
  { status: number; category: AppError["category"]; message: string }
> = {
  CONTEXT_NOT_FOUND: {
    status: 404,
    category: "not_found",
    message: "The place you mentioned is not part of this trip.",
  },
  CONTEXT_AMBIGUOUS: {
    status: 422,
    category: "validation",
    message: "More than one place matches. Choose one and ask again.",
  },
  CONTEXT_OUTSIDE_TRIP: {
    status: 422,
    category: "validation",
    message: "That place is not part of this trip.",
  },
  PLANNER_INVALID_OUTPUT: {
    status: 502,
    category: "provider",
    message: "The assistant could not plan this request. Please try again.",
  },
  PLANNER_UNSUPPORTED_INTENT: {
    status: 502,
    category: "provider",
    message: "The assistant could not plan this request. Please try again.",
  },
  PLANNER_TOOL_NOT_ALLOWED: {
    status: 502,
    category: "provider",
    message: "The assistant could not plan this request. Please try again.",
  },
  PLANNER_TOOL_ARGUMENT_INVALID: {
    status: 502,
    category: "provider",
    message: "The assistant could not plan this request. Please try again.",
  },
  PLANNER_LIMIT_EXCEEDED: {
    status: 502,
    category: "provider",
    message: "The assistant could not plan this request. Please try again.",
  },
  TOOL_RESULT_INVALID: {
    status: 502,
    category: "provider",
    message:
      "This information is currently unavailable because the data source returned an unusable result. Please try again.",
  },
  TOOL_TIMEOUT: {
    status: 504,
    category: "provider",
    message:
      "This information is currently unavailable because the data source took too long. Please try again.",
  },
  SYNTHESIS_INVALID_OUTPUT: {
    status: 502,
    category: "provider",
    message:
      "The assistant could not write a reliable answer. Please try again.",
  },
  SYNTHESIS_SOURCE_MISSING: {
    status: 502,
    category: "provider",
    message:
      "The assistant could not write a reliable answer. Please try again.",
  },
  RESPONSE_SCHEMA_INVALID: {
    status: 502,
    category: "provider",
    message:
      "The assistant could not write a reliable answer. Please try again.",
  },
  RECOMMENDATION_INCONSISTENT: {
    status: 502,
    category: "provider",
    message:
      "The assistant answer disagreed with the computed recommendation, so it was discarded. Please try again.",
  },
  ORCHESTRATION_TIMEOUT: {
    status: 504,
    category: "provider",
    message: "The request took too long and was stopped. Please try again.",
  },
  INTERNAL_ORCHESTRATION_ERROR: {
    status: 500,
    category: "internal",
    message: "The assistant ran into an internal problem.",
  },
  PROMPT_SECRET_DETECTED: {
    status: 500,
    category: "internal",
    message: "The assistant ran into an internal problem.",
  },
};

export interface ExecutionTrace {
  executionId: string;
  intent: string | null;
  toolCalls: ToolTrace[];
  plannerLatencyMs: number | null;
  synthesisLatencyMs: number | null;
  providerCallCount: number;
  model: string | null;
}

export interface ToolTrace {
  tool_name: string;
  status: "ok" | "empty" | "failed";
  duration_ms: number;
  error_code?: string;
  source_ids?: string[];
  entity_ids?: string[];
}

/** An execution that ended in an error. It keeps the trace so the failed turn can be stored. */
export class OrchestrationFailure extends AppError {
  public readonly trace: ExecutionTrace;
  public readonly causeError: unknown;

  public constructor(
    appError: AppError,
    trace: ExecutionTrace,
    cause: unknown,
  ) {
    super(
      appError.code,
      appError.category,
      appError.statusCode,
      appError.message,
      appError.details,
    );
    this.name = "OrchestrationFailure";
    this.trace = trace;
    this.causeError = cause;
  }
}

/** Maps any failure to a safe, structured error. Nothing is swallowed. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof AssistantError) {
    const mapped = ASSISTANT_ERROR_MAP[error.code];
    return new AppError(
      error.code,
      mapped.category,
      mapped.status,
      mapped.message,
      error.details,
    );
  }
  if (error instanceof ExternalDataError) {
    return new AppError(
      error.code,
      "provider",
      error.statusCode,
      error.message,
      {
        provider: error.provider,
        retryable: error.retryable,
        ...(error.details ?? {}),
      },
    );
  }
  return new AppError(
    "INTERNAL_ORCHESTRATION_ERROR",
    "internal",
    500,
    "The assistant ran into an internal problem.",
  );
}
