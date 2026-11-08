import { AssistantError } from "./errors.js";
import type { AssistantIntent, ConfirmationAction } from "./intents.js";
import { isIsoDateTime, validateSchema, type JsonSchema } from "./schema.js";

export type FreshnessStatus = "fresh" | "stale" | "expired" | "unavailable";

export type CardType =
  | "event"
  | "activity"
  | "restaurant"
  | "route"
  | "weather"
  | "traffic"
  | "alert"
  | "agenda"
  | "recommendation";

export const CARD_TYPES: readonly CardType[] = [
  "event",
  "activity",
  "restaurant",
  "route",
  "weather",
  "traffic",
  "alert",
  "agenda",
  "recommendation",
];

export interface AssistantSource {
  id: string;
  kind:
    "provider" | "official_page" | "search_result" | "user_input" | "internal";
  provider: string;
  url?: string;
  title?: string;
  retrieved_at: string;
  freshness: "fresh" | "expired" | "unavailable";
  expires_at?: string;
  observed_for?: { from?: string; to?: string; timezone?: string };
}

export interface AssistantCard {
  type: CardType;
  id: string;
  title: string;
  subtitle?: string;
  status?: string;
  starts_at?: string;
  ends_at?: string;
  fields: Array<{ label: string; value: string }>;
  source_ids: string[];
  retrieved_at?: string;
  /** Set on the option the deterministic engine recommends. Never set by the model. */
  recommended?: boolean;
  /** Position given by the deterministic engine, 1 is best. */
  rank?: number;
  actions?: Array<{ action: ConfirmationAction; label: string }>;
}

export interface AssistantFact {
  label: string;
  value: string;
  source_ids: string[];
}

/** What a tool hands back. Everything in it is validated before use. */
export interface ToolResult {
  status: "ok" | "empty";
  /**
   * Compact data shown to the model. Text copied from external pages
   * (titles, descriptions) is untrusted and is fenced by the prompt builder.
   */
  data: Record<string, unknown>;
  cards: AssistantCard[];
  facts: AssistantFact[];
  sources: AssistantSource[];
  limitations: string[];
  /** True when the data comes from an external provider. */
  live: boolean;
  retrievedAt: string | null;
  freshness: FreshnessStatus;
  /**
   * Values computed by a deterministic engine. The model may echo, never change, them.
   * `rankedOptionIds` is the engine's full order, best first, and includes the recommended option.
   */
  locked?: { recommendedOptionId?: string; rankedOptionIds?: string[] };
  contextPointIds: string[];
  eventResultIds: string[];
  agendaItemIds: string[];
  providerCalls: number;
}

/** A tool the planner may call. Only read tools can be registered. */
export interface ToolDefinition<TContext> {
  name: string;
  description: string;
  category: "read";
  /** Intents this tool serves. A plan whose intent is not listed is rejected. */
  intents: readonly AssistantIntent[];
  /** JSON schema of the arguments the planner may supply. */
  inputSchema: JsonSchema;
  /** Argument names that hold a context point id. */
  contextArguments: readonly string[];
  /**
   * Set by tools that travel between two places. The plan must give either a
   * stored journey leg, or an origin and a destination that the backend's own
   * context resolution established. The planner never picks them on its own.
   */
  routeArguments?: { journeyLeg: string; origin: string; destination: string };
  timeoutMs: number;
  /** How many external provider calls one execution may make. */
  providerCalls: number;
  live: boolean;
  parallelSafe: boolean;
  execute(
    input: Record<string, unknown>,
    context: TContext,
    signal: AbortSignal,
  ): Promise<ToolResult>;
}

export class ToolRegistry<TContext> {
  private readonly tools = new Map<string, ToolDefinition<TContext>>();

  public register(tool: ToolDefinition<TContext>): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool is already registered: ${tool.name}`);
    }
    if (tool.category !== "read") {
      throw new Error(`Only read tools can be planned: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  public get(name: string): ToolDefinition<TContext> | undefined {
    return this.tools.get(name);
  }

  public names(): string[] {
    return [...this.tools.keys()];
  }

  public list(): ToolDefinition<TContext>[] {
    return [...this.tools.values()];
  }

  /** What the planner is told. No URLs, credentials, or implementation detail. */
  public catalog(): Array<{
    name: string;
    description: string;
    intents: readonly AssistantIntent[];
    input_schema: JsonSchema;
  }> {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      intents: tool.intents,
      input_schema: tool.inputSchema,
    }));
  }
}

export interface ToolResultLimits {
  maxBytes: number;
  secrets: readonly string[];
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Result validation (Segment 04, ResultValidator). A failing result ends the
 * execution; nothing is repaired or replaced.
 */
export function validateToolResult(
  tool: Pick<ToolDefinition<unknown>, "name" | "live">,
  result: ToolResult,
  limits: ToolResultLimits,
): void {
  const fail = (message: string, details?: Record<string, unknown>): never => {
    throw new AssistantError("TOOL_RESULT_INVALID", message, {
      tool_name: tool.name,
      ...details,
    });
  };
  if (result.status !== "ok" && result.status !== "empty") {
    fail("Tool result status is invalid.");
  }
  const sourceIds = new Set<string>();
  for (const source of result.sources) {
    if (!source.id || !source.provider) fail("A source has no id or provider.");
    if (!isIsoDateTime(source.retrieved_at)) {
      fail("A source has no valid retrieval time.", { source_id: source.id });
    }
    sourceIds.add(source.id);
  }
  if (tool.live || result.live) {
    if (!result.retrievedAt || !isIsoDateTime(result.retrievedAt)) {
      fail("Live data must carry a retrieval time.");
    }
    if (result.status === "ok" && result.sources.length === 0) {
      fail("Live data must carry at least one source.");
    }
    if (result.freshness === "expired") {
      fail("Live data is expired and cannot be used.");
    }
  }
  if (result.status === "empty" && result.cards.length > 0) {
    fail("An empty result cannot carry cards.");
  }
  for (const card of result.cards) {
    if (!CARD_TYPES.includes(card.type)) fail("A card type is not allowed.");
    if (!card.id || !card.title) fail("A card has no id or title.");
    for (const id of card.source_ids) {
      if (!sourceIds.has(id)) {
        fail("A card refers to an unknown source.", { source_id: id });
      }
    }
    if ((tool.live || result.live) && card.source_ids.length === 0) {
      fail("A live card must cite a source.", { card_id: card.id });
    }
  }
  for (const fact of result.facts) {
    for (const id of fact.source_ids) {
      if (!sourceIds.has(id)) {
        fail("A fact refers to an unknown source.", { source_id: id });
      }
    }
  }
  const serialized = JSON.stringify(result);
  if (byteLength(serialized) > limits.maxBytes) {
    fail("Tool result is larger than the allowed size.", {
      max_bytes: limits.maxBytes,
    });
  }
  for (const secret of limits.secrets) {
    if (secret.length >= 8 && serialized.includes(secret)) {
      fail("Tool result contains a secret value.");
    }
  }
}

/** Validates the arguments a planner supplied against the tool's input schema. */
export function validateToolArguments(
  tool: Pick<ToolDefinition<unknown>, "name" | "inputSchema">,
  args: unknown,
): Record<string, unknown> {
  const errors = validateSchema(tool.inputSchema, args);
  if (errors.length > 0) {
    throw new AssistantError(
      "PLANNER_TOOL_ARGUMENT_INVALID",
      "The planned tool arguments are not valid.",
      { tool_name: tool.name, violations: errors.slice(0, 5) },
    );
  }
  return args as Record<string, unknown>;
}
