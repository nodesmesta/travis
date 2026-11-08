/**
 * Error codes of the assistant orchestrator (Segment 04, "Error taxonomy").
 * Every failure ends the execution with one of these codes. None of them is
 * ever turned into a substitute answer.
 */
export type AssistantErrorCode =
  | "CONTEXT_NOT_FOUND"
  | "CONTEXT_AMBIGUOUS"
  | "CONTEXT_OUTSIDE_TRIP"
  | "PLANNER_INVALID_OUTPUT"
  | "PLANNER_UNSUPPORTED_INTENT"
  | "PLANNER_TOOL_NOT_ALLOWED"
  | "PLANNER_TOOL_ARGUMENT_INVALID"
  | "PLANNER_LIMIT_EXCEEDED"
  | "TOOL_RESULT_INVALID"
  | "TOOL_TIMEOUT"
  | "SYNTHESIS_INVALID_OUTPUT"
  | "SYNTHESIS_SOURCE_MISSING"
  | "RESPONSE_SCHEMA_INVALID"
  | "RECOMMENDATION_INCONSISTENT"
  | "ORCHESTRATION_TIMEOUT"
  | "INTERNAL_ORCHESTRATION_ERROR"
  | "PROMPT_SECRET_DETECTED";

export class AssistantError extends Error {
  public readonly code: AssistantErrorCode;
  /** Safe diagnostic detail. Never contains prompts, secrets, or provider payloads. */
  public readonly details: Record<string, unknown> | undefined;

  public constructor(
    code: AssistantErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AssistantError";
    this.code = code;
    this.details = details;
  }
}
