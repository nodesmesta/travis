import { ExternalDataError } from "./errors.js";

/**
 * Shared JSON-over-HTTP call for the structured providers (HERE, OpenWeather).
 * One request, one timeout, no retry, no fallback. Every failure becomes an
 * ExternalDataError, and the API key is never part of an error or a log value.
 */

export interface ProviderCall {
  provider: string;
  /** Human label such as "HERE Routing". Used in messages only. */
  label: string;
  url: URL;
  timeoutMs: number;
  maxResponseBytes: number;
  fetchImpl: typeof fetch;
  /** Name of the query parameter that carries the key, removed from audit URLs. */
  keyParam: string;
  /** HTTP method. GET when omitted. */
  method?: "GET" | "POST" | "PUT";
  /** Extra request headers, for example an API key header. Never logged. */
  headers?: Record<string, string>;
  /** JSON body for POST and PUT. */
  body?: unknown;
  /**
   * Keep the provider's own error body on a 400 or 404, under `details.provider_error`.
   * Use it only for providers whose error bodies are written for API clients and carry
   * no secret (for example "the airline requires a travel document").
   */
  exposeClientErrors?: boolean;
}

export interface ProviderJson {
  json: unknown;
  /** Provider request id when the response carried one. */
  providerRequestId: string | null;
  /** The request URL without the API key, safe to store and show. */
  auditUrl: string;
  httpStatus: number;
}

export function missingConfiguration(
  provider: string,
  label: string,
): ExternalDataError {
  return new ExternalDataError(
    "EXTERNAL_CONFIGURATION_MISSING",
    provider,
    `${label} is not configured.`,
    503,
  );
}

export function auditUrl(url: URL, keyParam: string): string {
  const copy = new URL(url.toString());
  copy.searchParams.delete(keyParam);
  return copy.toString();
}

const MAX_CLIENT_ERROR_TEXT = 300;

/**
 * Reads a provider error body of the shape `{ error: { code, description, key } }`
 * into a small, bounded object. Anything else yields null, so an unexpected body
 * (an HTML error page, a stack trace) is never passed on.
 */
function clientErrorOf(
  text: string,
): { code: number | string; description: string; field?: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const error = asRecord(asRecord(parsed)?.error);
  if (!error) return null;
  const code = error.code;
  // Some answers carry `description`, others only `message` (a duplicate booking
  // reference, for example). Take whichever is there, the longer explanation first.
  const description =
    nonBlankString(error.description) ?? nonBlankString(error.message);
  if (
    (typeof code !== "number" && typeof code !== "string") ||
    description === null
  ) {
    return null;
  }
  const field = nonBlankString(error.key);
  return {
    code,
    description: description.slice(0, MAX_CLIENT_ERROR_TEXT),
    ...(field ? { field: field.slice(0, 120) } : {}),
  };
}

export async function callProviderJson(
  call: ProviderCall,
): Promise<ProviderJson> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), call.timeoutMs);
  const audit = auditUrl(call.url, call.keyParam);
  let response: Response;
  try {
    response = await call.fetchImpl(call.url.toString(), {
      method: call.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(call.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...call.headers,
      },
      ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    if (error instanceof Error && error.name === "AbortError") {
      throw new ExternalDataError(
        "EXTERNAL_PROVIDER_TIMEOUT",
        call.provider,
        `${call.label} request timed out.`,
        504,
        true,
      );
    }
    throw new ExternalDataError(
      "EXTERNAL_PROVIDER_ERROR",
      call.provider,
      `${call.label} request failed.`,
      502,
      true,
    );
  }

  try {
    const providerRequestId =
      response.headers.get("x-request-id") ??
      response.headers.get("x-correlation-id");
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"));
      throw new ExternalDataError(
        "EXTERNAL_PROVIDER_RATE_LIMITED",
        call.provider,
        `${call.label} rejected the request because of a rate limit.`,
        429,
        true,
        {
          retry_after_seconds:
            Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 15,
        },
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new ExternalDataError(
        "EXTERNAL_PROVIDER_REJECTED",
        call.provider,
        `${call.label} rejected the credentials.`,
        502,
        false,
        { provider_status: response.status },
      );
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > call.maxResponseBytes) {
      throw new ExternalDataError(
        "EXTERNAL_RESPONSE_INVALID",
        call.provider,
        `${call.label} response exceeded the configured size limit.`,
        502,
      );
    }
    if (response.status === 400 || response.status === 404) {
      throw new ExternalDataError(
        "EXTERNAL_QUERY_INVALID",
        call.provider,
        `${call.label} could not process the request.`,
        422,
        false,
        {
          provider_status: response.status,
          ...(call.exposeClientErrors
            ? { provider_error: clientErrorOf(text) }
            : {}),
        },
      );
    }
    if (!response.ok) {
      throw new ExternalDataError(
        "EXTERNAL_PROVIDER_ERROR",
        call.provider,
        `${call.label} did not return a successful response.`,
        502,
        response.status >= 500,
        { provider_status: response.status },
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ExternalDataError(
        "EXTERNAL_RESPONSE_INVALID",
        call.provider,
        `${call.label} response was not valid JSON.`,
        502,
      );
    }
    return {
      json,
      providerRequestId,
      auditUrl: audit,
      httpStatus: response.status,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Small readers shared by the normalizers. They throw instead of defaulting.

export function invalidResponse(
  provider: string,
  message: string,
): ExternalDataError {
  return new ExternalDataError(
    "EXTERNAL_RESPONSE_INVALID",
    provider,
    message,
    502,
  );
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function nonBlankString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}
