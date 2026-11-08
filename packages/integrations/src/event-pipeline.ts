import type { BrightDataClient } from "./bright-data.js";
import { ExternalDataError } from "./errors.js";
import { htmlToText } from "./html.js";
import {
  extractJsonLdEvents,
  validateEventClaim,
  validateJsonLdEvent,
  type EventClaimExtractor,
  type ExtractionContext,
  type ValidatedEvent,
} from "./event-extraction.js";
import {
  normalizedText,
  parseSearchCandidates,
  sourceKey,
  type EventDiscoveryProviderQuery,
  type NormalizedEventDiscovery,
  type NormalizedEventItem,
  type NormalizedEventSource,
  type SearchCandidate,
} from "./event-discovery.js";

export interface EventPipelineOptions {
  maxPages: number;
  pageMaxChars: number;
  pageConcurrency: number;
}

/** Errors that mean the whole run is misconfigured, not that one page failed. */
const RUN_FATAL_CODES = new Set([
  "EXTERNAL_CONFIGURATION_MISSING",
  "EXTERNAL_MODEL_MISMATCH",
]);

interface PageOutcome {
  candidate: SearchCandidate;
  events: ValidatedEvent[];
  notes: string[];
  failure?: ExternalDataError;
}

/** Same error with the pipeline stage added, so a failure can be traced. */
function withStage(
  error: ExternalDataError,
  stage: string,
  host?: string,
): ExternalDataError {
  return new ExternalDataError(
    error.code,
    error.provider,
    error.message,
    error.statusCode,
    error.retryable,
    { ...(error.details ?? {}), stage, ...(host ? { host } : {}) },
  );
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await task(items[index] as T);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function countReasons(reasons: string[]): string[] {
  const counts = new Map<string, number>();
  for (const reason of reasons)
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts.entries()].map(([reason, count]) =>
    count > 1
      ? `${count} candidates ignored: ${reason}.`
      : `1 candidate ignored: ${reason}.`,
  );
}

/**
 * Event discovery pipeline (Segment 05, Bright Data workflow steps 1-10):
 * search -> candidate pages -> page text -> validated facts.
 *
 * Provider failures are never turned into empty results. A page that cannot be
 * read is reported in `limitations`; if no page can be read the first error is
 * rethrown. There is no retry and no fallback source.
 */
export class EventDiscoveryPipeline {
  public constructor(
    private readonly client: BrightDataClient,
    private readonly extractor: EventClaimExtractor,
    private readonly options: EventPipelineOptions,
  ) {}

  public async run(
    query: EventDiscoveryProviderQuery,
    retrievedAt: string,
    ttlHours: number,
  ): Promise<NormalizedEventDiscovery> {
    const expiresAt = new Date(
      Date.parse(retrievedAt) + ttlHours * 60 * 60 * 1000,
    ).toISOString();
    const limitations: string[] = [
      "Events are matched to the requested place by venue name. Distance from the place is not verified.",
    ];

    let searchText: string;
    try {
      searchText = await this.client.fetchText(
        this.client.serpZone,
        query.searchUrl,
      );
    } catch (error) {
      if (error instanceof ExternalDataError) throw withStage(error, "search");
      throw error;
    }
    let searchAnswer: unknown;
    try {
      searchAnswer = JSON.parse(searchText);
    } catch {
      throw new ExternalDataError(
        "EXTERNAL_RESPONSE_INVALID",
        "bright_data",
        "Bright Data search answer was not JSON.",
        502,
      );
    }
    const search = parseSearchCandidates(searchAnswer, this.options.maxPages);
    limitations.push(...search.limitations);

    const ctx: ExtractionContext = {
      contextLabel: query.input.contextLabel,
      timezone: query.input.observedFor.timezone,
      windowFromMs: Date.parse(query.input.observedFor.from),
      windowToMs: Date.parse(query.input.observedFor.to),
      nowMs: Date.parse(retrievedAt),
    };

    if (search.candidates.length === 0) {
      limitations.push(
        search.returned === 0
          ? "The search returned no results."
          : "No search result was suitable to read.",
      );
      return this.assemble(query, [], retrievedAt, expiresAt, limitations);
    }

    const outcomes = await mapLimit(
      search.candidates,
      this.options.pageConcurrency,
      (candidate) => this.processPage(candidate, ctx),
    );

    const failures = outcomes.flatMap((outcome) =>
      outcome.failure ? [outcome.failure] : [],
    );
    if (failures.length === outcomes.length) {
      throw failures[0] as ExternalDataError;
    }
    for (const outcome of outcomes) limitations.push(...outcome.notes);
    if (failures.length > 0) {
      limitations.push(
        `${failures.length} of ${outcomes.length} candidate pages could not be processed.`,
      );
    }
    return this.assemble(query, outcomes, retrievedAt, expiresAt, limitations);
  }

  private async processPage(
    candidate: SearchCandidate,
    ctx: ExtractionContext,
  ): Promise<PageOutcome> {
    const outcome: PageOutcome = { candidate, events: [], notes: [] };
    const rejected: string[] = [];
    const label = new URL(candidate.url).hostname;
    try {
      const html = await this.client.fetchText(
        this.client.unlockerZone,
        candidate.url,
      );
      const { text, truncated } = htmlToText(html, this.options.pageMaxChars);
      if (truncated) {
        outcome.notes.push(
          `Page ${label} was long; only its first part was read.`,
        );
      }

      const structured = extractJsonLdEvents(html);
      if (structured.malformedBlocks > 0) {
        outcome.notes.push(
          `${structured.malformedBlocks} structured data block(s) on ${label} could not be parsed.`,
        );
      }
      for (const event of structured.events) {
        const result = validateJsonLdEvent(event, ctx);
        if (result.ok) outcome.events.push(result.event);
        else rejected.push(result.reason);
      }

      if (structured.events.length === 0) {
        if (text.length < 40) {
          outcome.notes.push(`Page ${label} had no readable text.`);
        } else {
          const extraction = await this.extractor.extract(
            candidate.url,
            text,
            ctx,
          );
          if (extraction.malformed > 0) {
            outcome.notes.push(
              `${extraction.malformed} extracted item(s) from ${label} were malformed and ignored.`,
            );
          }
          for (const claim of extraction.claims) {
            const result = validateEventClaim(claim, text, ctx);
            if (result.ok) outcome.events.push(result.event);
            else rejected.push(result.reason);
          }
        }
      }
    } catch (error) {
      if (!(error instanceof ExternalDataError)) throw error;
      if (RUN_FATAL_CODES.has(error.code))
        throw withStage(error, "page", label);
      outcome.failure = withStage(error, "page", label);
      outcome.notes.push(
        `Page ${label} could not be processed (${error.code}).`,
      );
    }
    outcome.notes.push(
      ...countReasons(rejected).map((note) => `${label}: ${note}`),
    );
    return outcome;
  }

  private assemble(
    query: EventDiscoveryProviderQuery,
    outcomes: PageOutcome[],
    retrievedAt: string,
    expiresAt: string,
    limitations: string[],
  ): NormalizedEventDiscovery {
    const sources = new Map<string, NormalizedEventSource>();
    const items = new Map<string, NormalizedEventItem>();
    let usedModel = false;

    for (const outcome of outcomes) {
      for (const event of outcome.events) {
        if (event.origin === "llm_extraction") usedModel = true;
        const key = sourceKey(outcome.candidate.url);
        sources.set(key, {
          sourceKey: key,
          kind: "search_result",
          provider: "bright_data",
          url: outcome.candidate.url,
          title: outcome.candidate.title,
        });
        const dedupeKey = `${normalizedText(event.title)}|${normalizedText(event.venueName)}|${Date.parse(event.startsAt)}`;
        const existing = items.get(dedupeKey);
        if (existing) {
          if (!existing.sourceKeys.includes(key)) existing.sourceKeys.push(key);
          continue;
        }
        items.set(dedupeKey, {
          dedupeKey,
          title: event.title.slice(0, 300),
          venueName: event.venueName.slice(0, 300),
          startsAt: event.startsAt,
          ...(event.endsAt ? { endsAt: event.endsAt } : {}),
          sourceKeys: [key],
          sourceUrl: outcome.candidate.url,
        });
      }
    }
    if (usedModel) {
      limitations.push(
        "Some events were read from page text. Dates and times were checked against the page, and a time without a timezone is read in the trip timezone.",
      );
    }
    if (sources.size === 0) {
      const searchKey = sourceKey(query.searchUrl);
      sources.set(searchKey, {
        sourceKey: searchKey,
        kind: "search_result",
        provider: "bright_data",
        url: query.searchUrl,
        title: `Bright Data search for ${query.input.filters.category}`,
      });
    }
    return {
      status: items.size > 0 ? "ok" : "empty",
      fingerprint: query.fingerprint,
      items: [...items.values()],
      sources: [...sources.values()],
      retrievedAt,
      expiresAt,
      freshness: "fresh",
      limitations: [...new Set(limitations)],
      searchUrl: query.searchUrl,
    };
  }
}
