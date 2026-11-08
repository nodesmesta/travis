import { createHash } from "node:crypto";
import { ExternalDataError } from "./errors.js";
import {
  alnumKey,
  hasExplicitUtcOffset,
  isAsciiLower,
  replaceLiteral,
  trimTrailing,
} from "./text.js";

export interface EventDiscoveryInput {
  requestId: string;
  executionId: string;
  tripId: string;
  contextPointId: string;
  contextLabel: string;
  contextAddress: string | null;
  observedFor: {
    from: string;
    to: string;
    timezone: string;
  };
  filters: {
    category: string;
    radiusPreference?: string;
    language?: string;
  };
  locale?: string;
  currency?: string;
}

export interface EventDiscoveryProviderQuery {
  input: EventDiscoveryInput;
  fingerprint: string;
  searchUrl: string;
}

export interface NormalizedEventSource {
  sourceKey: string;
  kind: "search_result" | "official_page";
  provider: "bright_data";
  url: string;
  title: string;
}

export interface NormalizedEventItem {
  dedupeKey: string;
  title: string;
  description?: string;
  venueName?: string;
  startsAt: string;
  endsAt?: string;
  category?: string;
  sourceKeys: string[];
  sourceUrl: string;
}

export interface NormalizedEventDiscovery {
  status: "ok" | "empty";
  fingerprint: string;
  items: NormalizedEventItem[];
  sources: NormalizedEventSource[];
  retrievedAt: string;
  expiresAt: string;
  freshness: "fresh";
  limitations: string[];
  searchUrl: string;
}

function stableValue(value: unknown): unknown {
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

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertZonedDateTime(value: string, field: string): void {
  if (!hasExplicitUtcOffset(value) || Number.isNaN(Date.parse(value))) {
    throw new ExternalDataError(
      "EXTERNAL_QUERY_INVALID",
      "bright_data",
      `${field} must contain an ISO datetime with an explicit timezone offset.`,
      400,
    );
  }
}

function assertInput(input: EventDiscoveryInput): void {
  if (
    !input.tripId ||
    !input.contextPointId ||
    !input.filters.category.trim()
  ) {
    throw new ExternalDataError(
      "EXTERNAL_QUERY_INVALID",
      "bright_data",
      "Event discovery requires trip, context point, and category.",
      400,
    );
  }
  assertZonedDateTime(input.observedFor.from, "observed_for.from");
  assertZonedDateTime(input.observedFor.to, "observed_for.to");
  if (Date.parse(input.observedFor.to) <= Date.parse(input.observedFor.from)) {
    throw new ExternalDataError(
      "EXTERNAL_QUERY_INVALID",
      "bright_data",
      "observed_for.to must be after observed_for.from.",
      400,
    );
  }
  try {
    new Intl.DateTimeFormat("en-US", {
      timeZone: input.observedFor.timezone,
    }).format();
  } catch {
    throw new ExternalDataError(
      "EXTERNAL_QUERY_INVALID",
      "bright_data",
      "observed_for.timezone must be a valid IANA timezone.",
      400,
    );
  }
}

/** Bump when the discovery pipeline changes so cached snapshots are not reused. */
export const EVENT_PIPELINE_VERSION = "serp-pages-llm-v2";

const MONTH_LABELS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function longDate(isoDate: string): string {
  const year = isoDate.slice(0, 4);
  const month = Number(isoDate.slice(5, 7));
  const day = Number(isoDate.slice(8, 10));
  return `${day} ${MONTH_LABELS[month - 1] ?? ""} ${year}`.trim();
}

export function buildEventDiscoveryQuery(
  input: EventDiscoveryInput,
): EventDiscoveryProviderQuery {
  assertInput(input);
  const date = input.observedFor.from.slice(0, 10);
  const searchTerms = [
    input.contextLabel,
    input.contextAddress,
    replaceLiteral(input.filters.category, "_", " "),
    "events",
    longDate(date),
  ].filter(Boolean);
  // Full JSON is the decided SERP format. It is requested explicitly so the
  // result never depends on the default format configured on the zone.
  // Bing is the SERP engine used in production: the Google SERP zone in this
  // account answers with a captcha header, while the same zone serves Bing
  // Full JSON. The response shape keeps the `organic` array the parser reads.
  const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(
    searchTerms.join(" "),
  )}&setlang=${encodeURIComponent(input.filters.language ?? "en")}&brd_json=1`;
  const fingerprint = hash(
    JSON.stringify(
      stableValue({
        provider: "bright_data",
        category: "event_discovery",
        pipeline: EVENT_PIPELINE_VERSION,
        contextPointId: input.contextPointId,
        observedFor: input.observedFor,
        filters: input.filters,
        locale: input.locale,
        currency: input.currency,
      }),
    ),
  );
  return { input, fingerprint, searchUrl };
}

export function normalizedText(value: string): string {
  return alnumKey(value);
}

export function sourceKey(url: string): string {
  return `source_${hash(url).slice(0, 24)}`;
}

export interface SearchCandidate {
  title: string;
  url: string;
  snippet?: string;
}

export interface SearchCandidates {
  candidates: SearchCandidate[];
  limitations: string[];
  /** Number of organic results the provider returned. */
  returned: number;
}

const SKIPPED_HOST_DOMAINS = [
  "instagram.com",
  "facebook.com",
  "tiktok.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "pinterest.com",
  "reddit.com",
  "linkedin.com",
  "youtu.be",
];
const SKIPPED_EXTENSIONS = [
  ".pdf",
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".zip",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
];

function isSkippedHost(host: string): boolean {
  return SKIPPED_HOST_DOMAINS.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
}

function isSkippedFile(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  return SKIPPED_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** True for `google.<tld>` and `www.google.<tld>`, including `google.co.id`. */
export function isGoogleHost(host: string): boolean {
  const marker = "google.";
  let from = 0;
  for (;;) {
    const index = host.indexOf(marker, from);
    if (index < 0) return false;
    from = index + 1;
    if (index !== 0 && host[index - 1] !== ".") continue;
    const rest = host.slice(index + marker.length);
    if (rest.length === 0) continue;
    if ([...rest].every((char) => isAsciiLower(char) || char === ".")) {
      return true;
    }
  }
}

/**
 * Reads a Full JSON SERP answer and keeps pages worth reading.
 *
 * Skipped on purpose: Google redirect wrappers (they cannot be resolved), other
 * Google properties, social networks (large, login-walled, no event markup), and
 * binary files.
 */
export function parseSearchCandidates(
  raw: unknown,
  maxCandidates: number,
): SearchCandidates {
  const organic =
    raw && typeof raw === "object"
      ? (raw as { organic?: unknown }).organic
      : undefined;
  if (!Array.isArray(organic)) {
    throw new ExternalDataError(
      "EXTERNAL_RESPONSE_INVALID",
      "bright_data",
      "Bright Data search answer did not contain parsed organic results.",
      502,
    );
  }
  const limitations: string[] = [];
  const seen = new Set<string>();
  const candidates: SearchCandidate[] = [];
  let skippedRedirects = 0;
  let skippedHosts = 0;
  let skippedFiles = 0;
  let invalid = 0;

  for (const entry of organic) {
    const item = entry as Record<string, unknown> | null;
    const link = item && typeof item.link === "string" ? item.link.trim() : "";
    const title =
      item && typeof item.title === "string" ? item.title.trim() : "";
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      invalid += 1;
      continue;
    }
    if (!(url.protocol === "http:" || url.protocol === "https:") || !title) {
      invalid += 1;
      continue;
    }
    const host = url.hostname.toLowerCase();
    if (isGoogleHost(host)) {
      skippedRedirects += 1;
      continue;
    }
    if (isSkippedHost(host)) {
      skippedHosts += 1;
      continue;
    }
    if (isSkippedFile(url.pathname)) {
      skippedFiles += 1;
      continue;
    }
    url.hash = "";
    const key = `${host}${trimTrailing(url.pathname, "/")}${url.search}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const snippet =
      item && typeof item.description === "string"
        ? item.description.trim()
        : "";
    candidates.push({
      title: title.slice(0, 300),
      url: url.toString(),
      ...(snippet ? { snippet: snippet.slice(0, 1000) } : {}),
    });
  }
  if (skippedRedirects)
    limitations.push(
      `${skippedRedirects} search result(s) pointed to Google redirect links and could not be read.`,
    );
  if (skippedHosts)
    limitations.push(
      `${skippedHosts} search result(s) from social networks were not read.`,
    );
  if (skippedFiles)
    limitations.push(
      `${skippedFiles} search result(s) were files and were not read.`,
    );
  if (invalid)
    limitations.push(
      `${invalid} search result(s) had no usable title or link.`,
    );
  return {
    candidates: candidates.slice(0, maxCandidates),
    limitations,
    returned: organic.length,
  };
}
