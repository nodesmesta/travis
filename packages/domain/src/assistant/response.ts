import { AssistantError } from "./errors.js";
import type { AssistantIntent, ConfirmationAction } from "./intents.js";
import type { ResolvedAssistantContext } from "./context-resolver.js";
import { SYNTHESIS_SCHEMA } from "./prompts.js";
import { validateSchema, type JsonSchema } from "./schema.js";
import { digitRuns, findUrls, normalizeDigitRun, stripUuids } from "./text.js";
import type {
  AssistantCard,
  AssistantFact,
  AssistantSource,
  FreshnessStatus,
  ToolResult,
} from "./tools.js";

export interface ConfirmationRequestView {
  action: ConfirmationAction;
  entity_type: "event_discovery_result" | "recommendation";
  entity_id: string;
  summary: string;
  expires_at: string;
  confirmation_token?: string;
}

export interface AssistantResponse {
  message: string;
  intent: AssistantIntent;
  context: {
    context_point_ids: string[];
    agenda_item_ids: string[];
    event_result_ids: string[];
  };
  cards: AssistantCard[];
  facts: AssistantFact[];
  recommendations: Array<{
    title: string;
    reason: string;
    confidence: "low" | "medium" | "high";
    source_ids: string[];
  }>;
  travel_tips: Array<{
    title: string;
    detail: string;
    source_ids: string[];
  }>;
  clarification: {
    question: string;
    options: Array<{ id: string; label: string }>;
  } | null;
  confirmation_request: ConfirmationRequestView | null;
  sources: AssistantSource[];
  limitations: string[];
  follow_up_actions: Array<{ label: string; prompt: string }>;
  freshness_status: FreshnessStatus;
  retrieved_at: string | null;
}

export interface SynthesisOutput {
  message: string;
  recommendations: AssistantResponse["recommendations"];
  travel_tips: AssistantResponse["travel_tips"];
  limitations: string[];
  follow_up_actions: AssistantResponse["follow_up_actions"];
  recommended_option_id: string | null;
  /** The engine's order, copied by the model. Must equal the locked order. */
  ranked_option_ids: string[];
}

export interface SynthesisValidationInput {
  output: unknown;
  results: readonly ToolResult[];
  /** Text the answer may legitimately repeat: the user message and trusted trip data. */
  groundingText: readonly string[];
  secrets: readonly string[];
}

function collectArrayLengths(
  value: unknown,
  into: Set<string>,
  depth = 0,
): void {
  if (depth > 8) return;
  if (Array.isArray(value)) {
    into.add(String(value.length));
    for (const entry of value) collectArrayLengths(entry, into, depth + 1);
  } else if (value && typeof value === "object") {
    for (const entry of Object.values(value)) {
      collectArrayLengths(entry, into, depth + 1);
    }
  }
}

function groundedNumbers(
  results: readonly ToolResult[],
  groundingText: readonly string[],
): Set<string> {
  const allowed = new Set<string>(["0", "1"]);
  const corpus: string[] = [...groundingText];
  for (const result of results) {
    corpus.push(
      JSON.stringify({
        data: result.data,
        cards: result.cards,
        facts: result.facts,
        sources: result.sources,
        limitations: result.limitations,
      }),
    );
    collectArrayLengths(result.data, allowed);
    allowed.add(String(result.cards.length));
    allowed.add(String(result.sources.length));
  }
  for (const text of corpus) {
    for (const run of digitRuns(stripUuids(text))) {
      allowed.add(normalizeDigitRun(run));
    }
  }
  return allowed;
}

/**
 * Checks the model's synthesis before it is used (Segment 04, ResponseComposer).
 * A failure ends the execution: nothing is repaired and no template answer is
 * substituted.
 */
export function validateSynthesisOutput(
  input: SynthesisValidationInput,
): SynthesisOutput {
  const violations = validateSchema(SYNTHESIS_SCHEMA, input.output);
  if (violations.length > 0) {
    throw new AssistantError(
      "SYNTHESIS_INVALID_OUTPUT",
      "The model answer does not match the response schema.",
      { violations: violations.slice(0, 5) },
    );
  }
  const output = input.output as SynthesisOutput;

  const knownSources = new Set<string>();
  for (const result of input.results) {
    for (const source of result.sources) knownSources.add(source.id);
  }
  for (const recommendation of output.recommendations) {
    if (recommendation.source_ids.length === 0) {
      throw new AssistantError(
        "SYNTHESIS_SOURCE_MISSING",
        "A recommendation has no source.",
      );
    }
    for (const id of recommendation.source_ids) {
      if (!knownSources.has(id)) {
        throw new AssistantError(
          "SYNTHESIS_SOURCE_MISSING",
          "A recommendation cites a source that was not retrieved.",
          { source_id: id.slice(0, 80) },
        );
      }
    }
  }
  for (const tip of output.travel_tips) {
    if (tip.source_ids.length === 0) {
      throw new AssistantError(
        "SYNTHESIS_SOURCE_MISSING",
        "A travel tip has no source.",
      );
    }
    for (const id of tip.source_ids) {
      if (!knownSources.has(id)) {
        throw new AssistantError(
          "SYNTHESIS_SOURCE_MISSING",
          "A travel tip cites a source that was not retrieved.",
          { source_id: id.slice(0, 80) },
        );
      }
    }
  }

  const locked = input.results
    .map((result) => result.locked?.recommendedOptionId)
    .filter((value): value is string => typeof value === "string");
  const lockedValue = locked[0];
  if (locked.length > 0 && output.recommended_option_id !== lockedValue) {
    throw new AssistantError(
      "RECOMMENDATION_INCONSISTENT",
      "The model answer contradicts the recommendation computed by the backend.",
    );
  }
  if (locked.length === 0 && output.recommended_option_id !== null) {
    throw new AssistantError(
      "RECOMMENDATION_INCONSISTENT",
      "The model named a recommended option that the backend did not compute.",
    );
  }

  const lockedRanking = input.results.flatMap(
    (result) => result.locked?.rankedOptionIds ?? [],
  );
  if (
    JSON.stringify(output.ranked_option_ids) !== JSON.stringify(lockedRanking)
  ) {
    throw new AssistantError(
      "RECOMMENDATION_INCONSISTENT",
      "The model answer changed the ranking computed by the backend.",
    );
  }

  const texts = [
    output.message,
    ...output.recommendations.flatMap((entry) => [entry.title, entry.reason]),
    ...output.travel_tips.flatMap((entry) => [entry.title, entry.detail]),
    ...output.limitations,
    ...output.follow_up_actions.flatMap((entry) => [entry.label, entry.prompt]),
  ];

  for (const text of texts) {
    for (const secret of input.secrets) {
      if (secret.length >= 8 && text.includes(secret)) {
        throw new AssistantError(
          "SYNTHESIS_INVALID_OUTPUT",
          "The model answer contained a secret value.",
        );
      }
    }
  }

  const allowedUrls = new Set<string>();
  for (const result of input.results) {
    for (const source of result.sources) {
      if (source.url) allowedUrls.add(source.url);
    }
  }
  for (const text of texts) {
    for (const url of findUrls(text)) {
      if (!allowedUrls.has(url)) {
        throw new AssistantError(
          "SYNTHESIS_INVALID_OUTPUT",
          "The model answer contained a link that is not one of the retrieved sources.",
        );
      }
    }
  }

  const allowedNumbers = groundedNumbers(input.results, input.groundingText);
  for (const text of texts) {
    for (const run of digitRuns(text)) {
      if (!allowedNumbers.has(normalizeDigitRun(run))) {
        throw new AssistantError(
          "SYNTHESIS_INVALID_OUTPUT",
          "The model answer contained a number that is not in the retrieved data.",
          { number: run.slice(0, 12) },
        );
      }
    }
  }
  return output;
}

const FRESHNESS_RANK: Record<FreshnessStatus, number> = {
  fresh: 0,
  stale: 1,
  expired: 2,
  unavailable: 3,
};

export function worstFreshness(
  results: readonly ToolResult[],
): FreshnessStatus {
  let worst: FreshnessStatus = "fresh";
  for (const result of results) {
    if (!result.live) continue;
    if (FRESHNESS_RANK[result.freshness] > FRESHNESS_RANK[worst]) {
      worst = result.freshness;
    }
  }
  return worst;
}

function dedupe<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const id = key(value);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(value);
  }
  return result;
}

export interface ComposeInput {
  intent: AssistantIntent;
  synthesis: SynthesisOutput;
  results: readonly ToolResult[];
  resolved: ResolvedAssistantContext;
  confirmation: ConfirmationRequestView | null;
  maxCards: number;
}

export function composeAssistantResponse(
  input: ComposeInput,
): AssistantResponse {
  const liveRetrieved = input.results
    .filter((result) => result.live && result.retrievedAt)
    .map((result) => result.retrievedAt as string)
    .sort();
  const contextPointIds = dedupe(
    [
      ...input.resolved.contextPointIds,
      ...input.results.flatMap((result) => result.contextPointIds),
    ],
    (id) => id,
  );
  return {
    message: input.synthesis.message.trim(),
    intent: input.intent,
    context: {
      context_point_ids: contextPointIds,
      agenda_item_ids: dedupe(
        [
          ...input.resolved.agendaItemIds,
          ...input.results.flatMap((result) => result.agendaItemIds),
        ],
        (id) => id,
      ),
      event_result_ids: dedupe(
        [
          ...input.resolved.eventResultIds,
          ...input.results.flatMap((result) => result.eventResultIds),
        ],
        (id) => id,
      ),
    },
    cards: dedupe(
      input.results.flatMap((result) => result.cards),
      (card) => `${card.type}:${card.id}`,
    ).slice(0, input.maxCards),
    facts: input.results.flatMap((result) => result.facts).slice(0, 20),
    recommendations: input.synthesis.recommendations,
    travel_tips: input.synthesis.travel_tips,
    clarification: null,
    confirmation_request: input.confirmation,
    sources: dedupe(
      input.results.flatMap((result) => result.sources),
      (source) => source.id,
    ),
    limitations: dedupe(
      [
        ...input.results.flatMap((result) => result.limitations),
        ...input.synthesis.limitations,
      ],
      (text) => text,
    ).slice(0, 8),
    follow_up_actions: input.synthesis.follow_up_actions,
    freshness_status: worstFreshness(input.results),
    retrieved_at: liveRetrieved[0] ?? null,
  };
}

export function composeClarificationResponse(input: {
  question: string;
  options: Array<{ id: string; label: string }>;
  resolved: ResolvedAssistantContext;
  limitation?: string;
}): AssistantResponse {
  return {
    message: input.question,
    intent: "clarify_context",
    context: {
      context_point_ids: input.resolved.contextPointIds,
      agenda_item_ids: input.resolved.agendaItemIds,
      event_result_ids: input.resolved.eventResultIds,
    },
    cards: [],
    facts: [],
    recommendations: [],
    travel_tips: [],
    clarification: { question: input.question, options: input.options },
    confirmation_request: null,
    sources: [],
    limitations: input.limitation ? [input.limitation] : [],
    follow_up_actions: [],
    freshness_status: "fresh",
    retrieved_at: null,
  };
}

const SOURCE_SCHEMA: JsonSchema = {
  type: "object",
  required: ["id", "kind", "provider", "retrieved_at", "freshness"],
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1 },
    kind: {
      enum: [
        "provider",
        "official_page",
        "search_result",
        "user_input",
        "internal",
      ],
    },
    provider: { type: "string", minLength: 1 },
    url: { type: "string", format: "uri" },
    title: { type: "string", maxLength: 300 },
    retrieved_at: { type: "string", format: "date-time" },
    freshness: { enum: ["fresh", "expired", "unavailable"] },
    expires_at: { type: "string", format: "date-time" },
    observed_for: {
      type: "object",
      additionalProperties: false,
      properties: {
        from: { type: "string", format: "date-time" },
        to: { type: "string", format: "date-time" },
        timezone: { type: "string" },
      },
    },
  },
};

const ACTION_ENUM = [
  "save_event_result",
  "expire_event_result",
  "save_recommendation",
  "apply_recommendation",
  "dismiss_recommendation",
];

const idArray: JsonSchema = { type: "array", items: { type: "string" } };

/** Mirror of contracts/schemas/assistant-response.schema.json. A test keeps them aligned. */
export const ASSISTANT_RESPONSE_SCHEMA: JsonSchema = {
  type: "object",
  required: [
    "message",
    "intent",
    "context",
    "cards",
    "facts",
    "recommendations",
    "travel_tips",
    "clarification",
    "confirmation_request",
    "sources",
    "limitations",
    "follow_up_actions",
    "freshness_status",
    "retrieved_at",
  ],
  additionalProperties: false,
  properties: {
    message: { type: "string", minLength: 1, maxLength: 4000 },
    intent: {
      enum: [
        "find_nearby_event",
        "find_nearby_activity",
        "check_weather",
        "check_traffic",
        "compare_transport",
        "find_restaurant",
        "suggest_alternative",
        "save_to_itinerary",
        "summarize_trip",
        "get_recommendations",
        "get_trip_advice",
        "clarify_context",
        "out_of_scope",
      ],
    },
    context: {
      type: "object",
      required: ["context_point_ids", "agenda_item_ids", "event_result_ids"],
      additionalProperties: false,
      properties: {
        context_point_ids: idArray,
        agenda_item_ids: idArray,
        event_result_ids: idArray,
      },
    },
    cards: {
      type: "array",
      items: {
        type: "object",
        required: ["type", "id", "title", "fields", "source_ids"],
        additionalProperties: false,
        properties: {
          type: {
            enum: [
              "event",
              "activity",
              "restaurant",
              "route",
              "weather",
              "traffic",
              "alert",
              "agenda",
              "recommendation",
            ],
          },
          id: { type: "string", minLength: 1 },
          title: { type: "string", minLength: 1, maxLength: 300 },
          subtitle: { type: "string", maxLength: 300 },
          status: { type: "string", maxLength: 60 },
          starts_at: { type: "string", format: "date-time" },
          ends_at: { type: "string", format: "date-time" },
          fields: {
            type: "array",
            items: {
              type: "object",
              required: ["label", "value"],
              additionalProperties: false,
              properties: {
                label: { type: "string", minLength: 1, maxLength: 80 },
                value: { type: "string", maxLength: 1000 },
              },
            },
          },
          source_ids: idArray,
          retrieved_at: { type: "string", format: "date-time" },
          recommended: { type: "boolean" },
          rank: { type: "integer", minimum: 1 },
          actions: {
            type: "array",
            items: {
              type: "object",
              required: ["action", "label"],
              additionalProperties: false,
              properties: {
                action: { enum: ACTION_ENUM },
                label: { type: "string", minLength: 1, maxLength: 80 },
              },
            },
          },
        },
      },
    },
    facts: {
      type: "array",
      items: {
        type: "object",
        required: ["label", "value", "source_ids"],
        additionalProperties: false,
        properties: {
          label: { type: "string", minLength: 1, maxLength: 120 },
          value: { type: "string", maxLength: 1000 },
          source_ids: idArray,
        },
      },
    },
    recommendations: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "reason", "confidence", "source_ids"],
        additionalProperties: false,
        properties: {
          title: { type: "string", minLength: 1, maxLength: 200 },
          reason: { type: "string", minLength: 1, maxLength: 1000 },
          confidence: { enum: ["low", "medium", "high"] },
          source_ids: idArray,
        },
      },
    },
    travel_tips: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "detail", "source_ids"],
        additionalProperties: false,
        properties: {
          title: { type: "string", minLength: 1, maxLength: 200 },
          detail: { type: "string", minLength: 1, maxLength: 1000 },
          source_ids: idArray,
        },
      },
    },
    clarification: {
      oneOf: [
        { type: "null" },
        {
          type: "object",
          required: ["question", "options"],
          additionalProperties: false,
          properties: {
            question: { type: "string", minLength: 1, maxLength: 500 },
            options: {
              type: "array",
              items: {
                type: "object",
                required: ["id", "label"],
                additionalProperties: false,
                properties: {
                  id: { type: "string", minLength: 1 },
                  label: { type: "string", minLength: 1, maxLength: 200 },
                },
              },
            },
          },
        },
      ],
    },
    confirmation_request: {
      oneOf: [
        { type: "null" },
        {
          type: "object",
          required: [
            "action",
            "entity_type",
            "entity_id",
            "summary",
            "expires_at",
          ],
          additionalProperties: false,
          properties: {
            action: { enum: ACTION_ENUM },
            entity_type: { enum: ["event_discovery_result", "recommendation"] },
            entity_id: { type: "string", minLength: 1 },
            summary: { type: "string", minLength: 1, maxLength: 500 },
            expires_at: { type: "string", format: "date-time" },
            confirmation_token: {
              type: "string",
              minLength: 32,
              maxLength: 200,
            },
          },
        },
      ],
    },
    sources: { type: "array", items: SOURCE_SCHEMA },
    limitations: { type: "array", items: { type: "string", maxLength: 500 } },
    follow_up_actions: {
      type: "array",
      items: {
        type: "object",
        required: ["label", "prompt"],
        additionalProperties: false,
        properties: {
          label: { type: "string", minLength: 1, maxLength: 80 },
          prompt: { type: "string", minLength: 1, maxLength: 500 },
        },
      },
    },
    freshness_status: { enum: ["fresh", "stale", "expired", "unavailable"] },
    retrieved_at: {
      oneOf: [{ type: "null" }, { type: "string", format: "date-time" }],
    },
  },
};

/**
 * Final gate before a response leaves the backend. Besides the schema it checks
 * that every cited source exists and that live data carries a source.
 */
export function validateAssistantResponse(
  response: unknown,
  secrets: readonly string[] = [],
): AssistantResponse {
  const violations = validateSchema(ASSISTANT_RESPONSE_SCHEMA, response);
  if (violations.length > 0) {
    throw new AssistantError(
      "RESPONSE_SCHEMA_INVALID",
      "The assistant response does not match the response contract.",
      { violations: violations.slice(0, 5) },
    );
  }
  const typed = response as AssistantResponse;
  const sourceIds = new Set(typed.sources.map((source) => source.id));
  const cited = [
    ...typed.cards.flatMap((card) => card.source_ids),
    ...typed.facts.flatMap((fact) => fact.source_ids),
    ...typed.recommendations.flatMap((entry) => entry.source_ids),
    ...typed.travel_tips.flatMap((entry) => entry.source_ids),
  ];
  for (const id of cited) {
    if (!sourceIds.has(id)) {
      throw new AssistantError(
        "SYNTHESIS_SOURCE_MISSING",
        "The response cites a source that it does not include.",
        { source_id: id.slice(0, 80) },
      );
    }
  }
  if (typed.freshness_status !== "unavailable" && typed.retrieved_at === null) {
    const hasExternal = typed.sources.some(
      (source) => source.kind !== "internal" && source.kind !== "user_input",
    );
    if (hasExternal) {
      throw new AssistantError(
        "SYNTHESIS_SOURCE_MISSING",
        "Live data in the response has no retrieval time.",
      );
    }
  }
  const serialized = JSON.stringify(typed);
  for (const secret of secrets) {
    if (secret.length >= 8 && serialized.includes(secret)) {
      throw new AssistantError(
        "RESPONSE_SCHEMA_INVALID",
        "The assistant response contained a secret value.",
      );
    }
  }
  return typed;
}
