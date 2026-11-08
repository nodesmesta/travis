export type ExternalDataErrorCode =
  | "EXTERNAL_CONFIGURATION_MISSING"
  | "EXTERNAL_QUERY_INVALID"
  | "EXTERNAL_PROVIDER_ERROR"
  | "EXTERNAL_PROVIDER_TIMEOUT"
  | "EXTERNAL_PROVIDER_REJECTED"
  | "EXTERNAL_PROVIDER_RATE_LIMITED"
  | "EXTERNAL_MODEL_MISMATCH"
  | "EXTERNAL_RESPONSE_INVALID"
  | "EXTERNAL_SOURCE_MISSING";

export class ExternalDataError extends Error {
  public readonly code: ExternalDataErrorCode;
  public readonly provider: string;
  public readonly statusCode: number;
  public readonly retryable: boolean;
  public readonly details: Record<string, unknown> | undefined;

  public constructor(
    code: ExternalDataErrorCode,
    provider: string,
    message: string,
    statusCode: number,
    retryable = false,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ExternalDataError";
    this.code = code;
    this.provider = provider;
    this.statusCode = statusCode;
    this.retryable = retryable;
    this.details = details;
  }
}
