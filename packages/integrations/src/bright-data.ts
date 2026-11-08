import { ExternalDataError } from "./errors.js";
import { isDigit, isWhitespace, isWordChar } from "./text.js";

export interface BrightDataConfig {
  apiKey: string | undefined;
  /** SERP API zone used for search requests. */
  serpZone: string | undefined;
  /** Web Unlocker zone used to read candidate pages. */
  unlockerZone?: string | undefined;
  timeoutMs?: number;
  maxResponseBytes?: number;
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

const PROVIDER = "bright_data";

const RATE_LIMIT_CODES = new Set([
  "sr_rate_limit",
  "bucket_rate_limit",
  "failed_query_rejected",
  "repeat_query_rejected",
  "client_10110",
]);

/** Reasons that are safe to show to a user. Free-form provider text is not. */
const KNOWN_REJECTION_CODES = new Set([
  "client_10050",
  "captcha",
  "verifying",
  "expect_element",
  "unexpected_q",
  "invalid_path",
]);

function splitOnWhitespace(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  for (const char of value) {
    if (isWhitespace(char)) {
      if (current) tokens.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function dropUrl(token: string): string {
  const lower = token.toLowerCase();
  const http = lower.indexOf("http://");
  const https = lower.indexOf("https://");
  const found = [http, https].filter((index) => index >= 0);
  return found.length === 0 ? token : token.slice(0, Math.min(...found));
}

function readDigits(token: string, from: number, maxCount: number): number {
  let count = 0;
  while (count < maxCount && isDigit(token[from + count])) count += 1;
  return count;
}

/** Returns the end index of an IPv4 address (optionally with /prefix) at `from`, or -1. */
function ipv4End(token: string, from: number): number {
  let index = from;
  for (let octet = 0; octet < 4; octet += 1) {
    const count = readDigits(token, index, 3);
    if (count === 0) return -1;
    index += count;
    if (octet < 3) {
      if (token[index] !== ".") return -1;
      index += 1;
    }
  }
  const atBoundary = (end: number): boolean => !isWordChar(token[end]);
  if (token[index] === "/") {
    const prefix = readDigits(token, index + 1, 2);
    if (prefix > 0 && atBoundary(index + 1 + prefix)) return index + 1 + prefix;
  }
  return atBoundary(index) ? index : -1;
}

function maskIpv4(token: string): string {
  let output = "";
  let index = 0;
  while (index < token.length) {
    const char = token[index] as string;
    const startsWord = index === 0 || !isWordChar(token[index - 1]);
    if (isDigit(char) && startsWord) {
      const end = ipv4End(token, index);
      if (end > 0) {
        output += "<ip>";
        index = end;
        continue;
      }
    }
    output += char;
    index += 1;
  }
  return output;
}

function sanitizeProviderText(value: string | null): string | undefined {
  if (!value) return undefined;
  const words = splitOnWhitespace(value)
    .map((token) => maskIpv4(dropUrl(token)))
    .filter((token) => token.length > 0);
  return words.join(" ").slice(0, 160);
}

/**
 * Bright Data reports many failures (captcha, denylisted IP, expect_element)
 * as HTTP 200 with an empty body. The reason is only present in headers, so
 * every response is inspected before the body is trusted.
 */
export class BrightDataClient {
  public readonly provider = PROVIDER;

  public constructor(private readonly config: BrightDataConfig) {}

  public get serpZone(): string | undefined {
    return this.config.serpZone;
  }

  public get unlockerZone(): string | undefined {
    return this.config.unlockerZone;
  }

  public async fetchText(
    zone: string | undefined,
    url: string,
  ): Promise<string> {
    if (!this.config.apiKey || !zone) {
      throw new ExternalDataError(
        "EXTERNAL_CONFIGURATION_MISSING",
        PROVIDER,
        "Bright Data is not configured for this request type.",
        503,
      );
    }
    const doFetch = this.config.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs ?? 60_000,
    );
    let response: Response;
    try {
      response = await doFetch(
        this.config.endpoint ?? "https://api.brightdata.com/request",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ zone, url, format: "raw" }),
          signal: controller.signal,
        },
      );
      return await this.readBody(response);
    } catch (error) {
      if (error instanceof ExternalDataError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new ExternalDataError(
          "EXTERNAL_PROVIDER_TIMEOUT",
          PROVIDER,
          "Bright Data request timed out.",
          504,
          true,
        );
      }
      throw new ExternalDataError(
        "EXTERNAL_PROVIDER_ERROR",
        PROVIDER,
        "Bright Data request failed.",
        502,
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readBody(response: Response): Promise<string> {
    const providerCode =
      response.headers.get("x-brd-error-code") ??
      response.headers.get("x-brd-err-code");
    const providerText = sanitizeProviderText(
      response.headers.get("x-brd-error") ??
        response.headers.get("x-brd-err-msg"),
    );

    if (providerCode || response.status === 429) {
      if (
        response.status === 429 ||
        (providerCode && RATE_LIMIT_CODES.has(providerCode))
      ) {
        const retryAfter = Number(response.headers.get("retry-after"));
        throw new ExternalDataError(
          "EXTERNAL_PROVIDER_RATE_LIMITED",
          PROVIDER,
          "Bright Data rejected the request because of a rate limit.",
          429,
          true,
          {
            ...(providerCode ? { provider_error_code: providerCode } : {}),
            retry_after_seconds:
              Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 15,
          },
        );
      }
      throw new ExternalDataError(
        "EXTERNAL_PROVIDER_REJECTED",
        PROVIDER,
        "Bright Data could not complete the request.",
        502,
        providerCode !== "client_10050",
        {
          provider_error_code: providerCode,
          ...(providerCode &&
          KNOWN_REJECTION_CODES.has(providerCode) &&
          providerText
            ? { provider_message: providerText }
            : {}),
        },
      );
    }

    const body = await response.text();
    if (response.status === 401 || response.status === 403) {
      throw new ExternalDataError(
        "EXTERNAL_PROVIDER_REJECTED",
        PROVIDER,
        "Bright Data rejected the credentials.",
        502,
        false,
        { provider_status: response.status },
      );
    }
    if (!response.ok) {
      throw new ExternalDataError(
        "EXTERNAL_PROVIDER_ERROR",
        PROVIDER,
        "Bright Data did not return a successful response.",
        502,
        response.status >= 500,
        { provider_status: response.status },
      );
    }
    const maxBytes = this.config.maxResponseBytes ?? 2_000_000;
    if (Buffer.byteLength(body, "utf8") > maxBytes) {
      throw new ExternalDataError(
        "EXTERNAL_RESPONSE_INVALID",
        PROVIDER,
        "Bright Data response exceeded the configured size limit.",
        502,
      );
    }
    if (!body.trim()) {
      throw new ExternalDataError(
        "EXTERNAL_RESPONSE_INVALID",
        PROVIDER,
        "Bright Data returned an empty response without an error reason.",
        502,
        true,
      );
    }
    return body;
  }
}
