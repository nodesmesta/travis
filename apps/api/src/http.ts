import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import {
  DomainInvariantError,
  hasExplicitUtcOffset,
  type CommandContext,
} from "@travelflow/domain";
import { ExternalDataError } from "@travelflow/integrations";
import { AppError } from "./errors.js";

/** Shared HTTP helpers for the API router and its route modules. */

export function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

export function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

export function commandContext(
  request: IncomingMessage,
  pathname: string,
  actorUserId: string,
  body: unknown,
): CommandContext {
  const header = request.headers["idempotency-key"];
  const idempotencyKey = Array.isArray(header) ? header[0] : header;
  if (
    !idempotencyKey ||
    idempotencyKey.trim().length < 16 ||
    idempotencyKey.length > 200
  ) {
    throw new AppError(
      "IDEMPOTENCY_KEY_INVALID",
      "validation",
      400,
      "Idempotency-Key must contain between 16 and 200 characters.",
    );
  }
  const requestHash = createHash("sha256")
    .update(
      `${request.method ?? "GET"} ${pathname} ${JSON.stringify(stableValue(body))}`,
    )
    .digest("hex");
  return { actorUserId, idempotencyKey, requestHash };
}

export function bodyRecord(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  throw new AppError(
    "REQUEST_INVALID",
    "validation",
    400,
    "Request body must be a JSON object.",
  );
}

export function requiredString(
  body: Record<string, unknown>,
  field: string,
): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(
      "REQUEST_INVALID",
      "validation",
      400,
      `${field} must be a non-blank string.`,
    );
  }
  return value.trim();
}

export function optionalString(
  body: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new AppError(
      "REQUEST_INVALID",
      "validation",
      400,
      `${field} must be a string.`,
    );
  }
  return value.trim();
}

export function requiredNumber(
  body: Record<string, unknown>,
  field: string,
): number {
  const value = body[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AppError(
      "REQUEST_INVALID",
      "validation",
      400,
      `${field} must be a number.`,
    );
  }
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** True for UTC offsets such as `+07:00`, which `Intl` accepts but are not IANA names. */
export function isUtcOffsetTimezone(value: string): boolean {
  const first = value[0];
  return first === "+" || first === "-";
}

function isDigits(text: string | undefined, length: number): text is string {
  if (text === undefined || text.length !== length) return false;
  for (const char of text) {
    if (char < "0" || char > "9") return false;
  }
  return true;
}

/** True when the `YYYY-MM-DDT` prefix names a real calendar day (`2026-02-30` is not). */
function hasRealCalendarDay(value: string): boolean {
  if (value[10] !== "T") return false;
  const [year, month, day, extra] = value.slice(0, 10).split("-");
  if (
    extra !== undefined ||
    !isDigits(year, 4) ||
    !isDigits(month, 2) ||
    !isDigits(day, 2)
  ) {
    return false;
  }
  const probe = new Date(0);
  probe.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  return (
    probe.getUTCFullYear() === Number(year) &&
    probe.getUTCMonth() === Number(month) - 1 &&
    probe.getUTCDate() === Number(day)
  );
}

/**
 * Accepts an ISO-8601 date-time that carries an explicit UTC offset and names a
 * real calendar day. Throws `TRIP_INVALID` otherwise.
 */
export function assertOffsetDateTime(value: string, field: string): string {
  if (
    !hasExplicitUtcOffset(value) ||
    !hasRealCalendarDay(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new AppError(
      "TRIP_INVALID",
      "validation",
      400,
      `${field} must be an ISO date-time with a timezone offset, for example 2026-11-12T09:00:00+07:00.`,
    );
  }
  return value;
}

/** Trip date-time field that may also be `null`. */
export function assertOptionalTripDateTime(
  value: unknown,
  field: string,
): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new AppError(
      "TRIP_INVALID",
      "validation",
      400,
      `${field} must be an ISO date-time with a timezone offset or null.`,
    );
  }
  return assertOffsetDateTime(value, field);
}

export function assertTimezone(value: string): void {
  if (isUtcOffsetTimezone(value)) {
    throw new AppError(
      "TRIP_INVALID",
      "validation",
      400,
      "timezone must be an IANA timezone name such as Asia/Jakarta, not a UTC offset.",
    );
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
  } catch {
    throw new AppError(
      "TRIP_INVALID",
      "validation",
      400,
      "timezone must be a valid IANA timezone.",
    );
  }
}

export function assertOptionalIsoDate(
  value: unknown,
  field: string,
): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new AppError(
      "TRIP_INVALID",
      "validation",
      400,
      `${field} must be an ISO date-time or null.`,
    );
  }
  return value;
}

export function normalizeDomainError(error: unknown): Error {
  if (error instanceof ExternalDataError) {
    return new AppError(
      error.code,
      "provider",
      error.statusCode,
      error.message,
      error.details,
    );
  }
  if (!(error instanceof DomainInvariantError)) {
    return error instanceof Error
      ? error
      : new Error("Unknown request failure");
  }
  const notFound = error.code === "RESOURCE_NOT_FOUND";
  const conflict =
    error.code === "DOMAIN_STATE_INVALID" ||
    error.code === "RESOURCE_TRIP_MISMATCH" ||
    error.code === "IDEMPOTENCY_CONFLICT";
  return new AppError(
    error.code,
    notFound ? "not_found" : conflict ? "conflict" : "validation",
    notFound ? 404 : conflict ? 409 : 400,
    error.message,
  );
}

export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > 256 * 1024) {
      throw new AppError(
        "REQUEST_BODY_TOO_LARGE",
        "validation",
        413,
        "Request body is too large.",
      );
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    throw new AppError(
      "REQUEST_BODY_INVALID",
      "validation",
      400,
      "A JSON request body is required.",
    );
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new AppError(
      "REQUEST_BODY_INVALID",
      "validation",
      400,
      "Request body must contain valid JSON.",
    );
  }
}
