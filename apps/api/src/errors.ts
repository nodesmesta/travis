import type { ServerResponse } from "node:http";

export type ErrorCategory =
  | "validation"
  | "authentication"
  | "authorization"
  | "not_found"
  | "conflict"
  | "provider"
  | "persistence"
  | "internal";

export class AppError extends Error {
  public readonly code: string;
  public readonly category: ErrorCategory;
  public readonly statusCode: number;
  public readonly details: Record<string, unknown> | undefined;

  public constructor(
    code: string,
    category: ErrorCategory,
    statusCode: number,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.category = category;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function writeError(
  response: ServerResponse,
  requestId: string,
  error: AppError | Error,
): void {
  const isAppError = error instanceof AppError;
  const statusCode = isAppError ? error.statusCode : 500;
  const body = {
    error: {
      code: isAppError ? error.code : "INTERNAL_ERROR",
      category: isAppError ? error.category : "internal",
      message: isAppError ? error.message : "An unexpected error occurred.",
      request_id: requestId,
      ...(isAppError && error.details ? { details: error.details } : {}),
    },
  };

  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}
