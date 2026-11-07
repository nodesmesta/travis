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

export async function callProviderJson(
  call: ProviderCall,
): Promise<ProviderJson> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), call.timeoutMs);
  const audit = auditUrl(call.url, call.keyParam);
  let response: Response;
  try {
    response = await call.fetchImpl(call.url.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
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
        { provider_status: response.status },
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
