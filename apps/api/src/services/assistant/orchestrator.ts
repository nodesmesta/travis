import {
  AssistantError,
  SYNTHESIS_SCHEMA,
  assertNoSecrets,
  buildPlannerMessages,
  buildSubmitPlanTool,
  buildSynthesisMessages,
  composeAssistantResponse,
  composeClarificationResponse,
  dateInZone,
  resolveAssistantContext,
  validateAssistantResponse,
  validatePlannerOutput,
  validateSynthesisOutput,
  validateToolResult,
  type AssistantIntent,
  type AssistantResponse,
  type ConfirmationAction,
  type ConfirmationRequestView,
  type HistoryMessage,
  type ResolvedAssistantContext,
  type ResolverContextPoint,
  type ResolverEventResult,
  type ToolDefinition,
  type ToolResult,
  type TripSnapshot,
} from "@travelflow/domain";
import type { ReasoningEffort } from "@travelflow/integrations";
import { AppError } from "../../errors.js";
import type { AssistantModel } from "./model.js";
import {
  OrchestrationFailure,
  toAppError,
  type ExecutionTrace,
  type ToolTrace,
} from "./errors.js";
import type {
  AssistantToolRegistry,
  ToolRuntime,
  TripSnapshotData,
} from "./types.js";

export interface OrchestratorLimits {
  plannerTimeoutMs: number;
  synthesisTimeoutMs: number;
  plannerReasoningEffort: ReasoningEffort;
  synthesisReasoningEffort: ReasoningEffort;
  plannerMaxTokens: number;
  synthesisMaxTokens: number;
  maxToolCalls: number;
  maxProviderCalls: number;
  maxParallelTools: number;
  maxToolResultBytes: number;
  maxContextMessages: number;
  maxMessageChars: number;
  totalTimeoutMs: number;
}

/** The orchestrator asks for a confirmation; the service decides how it is stored. */
export interface ConfirmationIssuer {
  issue(input: {
    action: ConfirmationAction;
    entityId: string;
  }): Promise<ConfirmationRequestView>;
}

export interface OrchestratorDependencies {
  model: AssistantModel;
  tools: AssistantToolRegistry;
  limits: OrchestratorLimits;
  /** Secret values that must never appear in a prompt, tool result, or answer. */
  secrets: readonly string[];
  now?: () => Date;
}

export interface OrchestratorInput {
  requestId: string;
  executionId: string;
  userId: string;
  tripId: string;
  message: string;
  activeContextPointId: string | null;
  history: HistoryMessage[];
  previousEventResults: ResolverEventResult[];
  /** Event results and recommendations from earlier in this conversation that the user may act on. */
  actionableEntities: {
    event_discovery_result: Array<{ id: string; label: string }>;
    recommendation: Array<{ id: string; label: string }>;
  };
  snapshot: TripSnapshotData;
  toolRuntime: Omit<ToolRuntime, "now">;
  confirmations: ConfirmationIssuer;
}

export interface OrchestratorOutcome {
  state: "completed" | "awaiting_clarification";
  intent: AssistantIntent;
  response: AssistantResponse;
  trace: ExecutionTrace;
  latencyMs: number;
  usage: {
    plannerTokens: number | null;
    synthesisTokens: number | null;
  };
}

const OUT_OF_SCOPE_MESSAGE =
  "I can help with this trip: routes between your places, weather, traffic, activities and restaurants nearby, events near your places, your agenda and bookings, and saved recommendations. I can't help with that request.";

const ROUTE_ENDPOINTS_QUESTION =
  'Where do you start and where do you want to go? Name both places, for example "from my hotel to the Jakarta Convention Center", or pick a stored journey leg.';

function tripSnapshotForPrompt(
  data: TripSnapshotData,
  usable: ReadonlySet<string>,
  now: Date,
): TripSnapshot {
  return {
    trip: data.trip,
    context_points: data.contextPoints.map((point) => ({
      id: point.id,
      label: point.label,
      type: point.type,
      usable: usable.has(point.id),
    })),
    upcoming_agenda: data.agenda
      .filter(
        (item) =>
          item.status !== "cancelled" &&
          Date.parse(item.endAt) >= now.getTime(),
      )
      .slice(0, 8)
      .map((item) => ({
        id: item.id,
        title: item.title,
        start_at: new Date(item.startAt).toISOString(),
        status: item.status,
      })),
    journey_legs: activeJourneyLegs(data).map((leg) => ({
      id: leg.id,
      from: labelOf(data, leg.originContextPointId),
      to: labelOf(data, leg.destinationContextPointId),
      departure_at: new Date(leg.departureAt).toISOString(),
      status: leg.status,
    })),
  };
}

function labelOf(data: TripSnapshotData, id: string): string {
  return data.contextPoints.find((point) => point.id === id)?.label ?? id;
}

/** Legs that can still be routed: planned or in progress, and not already over. */
function activeJourneyLegs(data: TripSnapshotData) {
  return data.journeyLegs
    .filter((leg) => leg.status === "planned" || leg.status === "in_progress")
    .slice(0, 8);
}

function ignoreTokensFor(data: TripSnapshotData): string[] {
  const tokens: string[] = [];
  for (const text of [data.trip.name, data.destinationSummary ?? ""]) {
    let current = "";
    for (const char of text.toLowerCase()) {
      const isWord =
        (char >= "a" && char <= "z") || (char >= "0" && char <= "9");
      if (isWord) current += char;
      else if (current) {
        tokens.push(current);
        current = "";
      }
    }
    if (current) tokens.push(current);
  }
  return tokens;
}

/**
 * Runs one assistant turn: resolve context, plan, validate, run read tools,
 * validate results, write the answer, validate the answer. There is no
 * fallback: any failed step ends the execution with a structured error.
 */
export class AssistantOrchestrator {
  public constructor(private readonly deps: OrchestratorDependencies) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  public async run(input: OrchestratorInput): Promise<OrchestratorOutcome> {
    const startedAt = Date.now();
    const deadline = startedAt + this.deps.limits.totalTimeoutMs;
    const trace: ExecutionTrace = {
      executionId: input.executionId,
      intent: null,
      toolCalls: [],
      plannerLatencyMs: null,
      synthesisLatencyMs: null,
      providerCallCount: 0,
      model: null,
    };
    try {
      return await this.execute(input, trace, startedAt, deadline);
    } catch (error) {
      throw new OrchestrationFailure(toAppError(error), trace, error);
    }
  }

  private remaining(deadline: number): number {
    const left = deadline - Date.now();
    if (left <= 0) {
      throw new AssistantError(
        "ORCHESTRATION_TIMEOUT",
        "The execution exceeded its total time budget.",
      );
    }
    return left;
  }

  private async execute(
    input: OrchestratorInput,
    trace: ExecutionTrace,
    startedAt: number,
    deadline: number,
  ): Promise<OrchestratorOutcome> {
    const { limits } = this.deps;
    const snapshot = input.snapshot;
    const activePoints = snapshot.contextPoints.filter(
      (point) => point.status === "active",
    );
    const resolverPoints: ResolverContextPoint[] = activePoints.map(
      (point) => ({
        id: point.id,
        label: point.label,
        type: point.type,
        usable:
          point.resolutionStatus === "resolved" &&
          point.latitude !== null &&
          point.longitude !== null &&
          Boolean(point.externalPlaceId),
      }),
    );
    const usable = new Set(
      resolverPoints.filter((point) => point.usable).map((point) => point.id),
    );
    const usableOptions = resolverPoints
      .filter((point) => point.usable)
      .map((point) => ({ id: point.id, label: point.label }));

    // 1) Context resolution. Ambiguity ends the turn before any model or provider call.
    const resolved: ResolvedAssistantContext = resolveAssistantContext({
      message: input.message,
      contextPoints: resolverPoints,
      activeContextPointId: input.activeContextPointId,
      ignoreTokens: ignoreTokensFor(snapshot),
      previousEventResults: input.previousEventResults,
    });
    if (resolved.status === "ambiguous") {
      const first = resolved.ambiguities[0] as NonNullable<
        (typeof resolved.ambiguities)[number]
      >;
      trace.intent = "clarify_context";
      return this.clarification(
        composeClarificationResponse({
          question: first.question,
          options: first.options,
          resolved,
        }),
        trace,
        startedAt,
      );
    }
    if (resolved.status === "missing") {
      const first = resolved.missing[0] as NonNullable<
        (typeof resolved.missing)[number]
      >;
      trace.intent = "clarify_context";
      return this.clarification(
        composeClarificationResponse({
          question: first.message,
          options: usableOptions,
          resolved,
        }),
        trace,
        startedAt,
      );
    }

    // 2) Planning. The model only proposes; the backend validates.
    const now = this.now();
    const today = dateInZone(now, snapshot.trip.timezone);
    const plannerTool = buildSubmitPlanTool(
      this.deps.tools.names(),
      limits.maxToolCalls,
    );
    const plannerMessages = buildPlannerMessages({
      now,
      today,
      timezone: snapshot.trip.timezone,
      tripSnapshot: tripSnapshotForPrompt(snapshot, usable, now),
      resolved,
      catalog: this.deps.tools.catalog(),
      actionableEntities: [
        ...input.actionableEntities.event_discovery_result.map((entry) => ({
          entity_type: "event_discovery_result",
          ...entry,
        })),
        ...input.actionableEntities.recommendation.map((entry) => ({
          entity_type: "recommendation",
          ...entry,
        })),
      ],
      history: input.history.slice(-limits.maxContextMessages),
      message: input.message,
      maxHistoryChars: 3000,
      maxMessageChars: limits.maxMessageChars,
    });
    assertNoSecrets(plannerMessages, this.deps.secrets);
    const plannerStarted = Date.now();
    const planned = await this.deps.model.plan({
      messages: plannerMessages,
      tool: plannerTool,
      timeoutMs: Math.min(limits.plannerTimeoutMs, this.remaining(deadline)),
      reasoningEffort: limits.plannerReasoningEffort,
      maxTokens: limits.plannerMaxTokens,
    });
    trace.plannerLatencyMs = Date.now() - plannerStarted;
    trace.model = planned.meta.model;
    const plannerTokens = planned.meta.usage.totalTokens;

    const { plan, needsContextChoice, needsRouteEndpoints } =
      validatePlannerOutput(planned.arguments, {
        registry: this.deps.tools,
        usableContextPointIds: usable,
        tripContextPointIds: new Set(activePoints.map((point) => point.id)),
        resolved,
        journeyLegs: new Map(
          activeJourneyLegs(snapshot).map((leg) => [
            leg.id,
            {
              origin: leg.originContextPointId,
              destination: leg.destinationContextPointId,
            },
          ]),
        ),
        actionableEntityIds: {
          event_discovery_result: new Set([
            ...input.actionableEntities.event_discovery_result.map((e) => e.id),
          ]),
          recommendation: new Set([
            ...input.actionableEntities.recommendation.map((e) => e.id),
          ]),
        },
        limits: {
          maxToolCalls: limits.maxToolCalls,
          maxProviderCalls: limits.maxProviderCalls,
        },
      });
    trace.intent = plan.intent;

    if (plan.needsClarification) {
      trace.intent = "clarify_context";
      return this.clarification(
        composeClarificationResponse({
          question: plan.clarificationQuestion as string,
          options: usableOptions,
          resolved,
        }),
        trace,
        startedAt,
        plannerTokens,
      );
    }
    if (needsRouteEndpoints) {
      trace.intent = "clarify_context";
      return this.clarification(
        composeClarificationResponse({
          question: ROUTE_ENDPOINTS_QUESTION,
          options: usableOptions,
          resolved,
        }),
        trace,
        startedAt,
        plannerTokens,
      );
    }
    if (needsContextChoice) {
      trace.intent = "clarify_context";
      return this.clarification(
        composeClarificationResponse({
          question:
            "Which place should I use? Pick one of your trip locations, or select one in the context bar.",
          options: usableOptions,
          resolved,
        }),
        trace,
        startedAt,
        plannerTokens,
      );
    }
    if (plan.intent === "clarify_context") {
      return this.clarification(
        composeClarificationResponse({
          question: "Which place or item do you mean?",
          options: usableOptions,
          resolved,
        }),
        trace,
        startedAt,
        plannerTokens,
      );
    }
    if (plan.intent === "out_of_scope") {
      return this.finish(
        "completed",
        plan.intent,
        this.plainResponse(OUT_OF_SCOPE_MESSAGE, plan.intent, resolved),
        trace,
        startedAt,
        plannerTokens,
        null,
      );
    }
    if (plan.intent === "save_to_itinerary" && plan.proposedAction) {
      const request = await input.confirmations.issue({
        action: plan.proposedAction.action,
        entityId: plan.proposedAction.entityId,
      });
      const response = this.plainResponse(
        `${request.summary} Nothing changes until you confirm.`,
        plan.intent,
        resolved,
      );
      response.confirmation_request = request;
      return this.finish(
        "completed",
        plan.intent,
        response,
        trace,
        startedAt,
        plannerTokens,
        null,
      );
    }

    // 3) Tools. Read-only, bounded in number, time, and parallelism.
    const runtime: ToolRuntime = {
      ...input.toolRuntime,
      now: () => this.now(),
    };
    const results = await this.runTools(
      plan.toolCalls,
      runtime,
      trace,
      deadline,
    );

    // 4) Synthesis. The model words the answer; the backend validates it.
    const synthesisMessages = buildSynthesisMessages({
      message: input.message,
      intent: plan.intent,
      timezone: snapshot.trip.timezone,
      resolved,
      results,
      history: [],
      maxMessageChars: limits.maxMessageChars,
      maxToolResultChars: limits.maxToolResultBytes,
    });
    assertNoSecrets(synthesisMessages, this.deps.secrets);
    const synthesisStarted = Date.now();
    const synthesized = await this.deps.model.synthesize({
      messages: synthesisMessages,
      schema: SYNTHESIS_SCHEMA,
      timeoutMs: Math.min(limits.synthesisTimeoutMs, this.remaining(deadline)),
      reasoningEffort: limits.synthesisReasoningEffort,
      maxTokens: limits.synthesisMaxTokens,
    });
    trace.synthesisLatencyMs = Date.now() - synthesisStarted;

    const toolResults = results.map((entry) => entry.result);
    const synthesis = validateSynthesisOutput({
      output: synthesized.value,
      results: toolResults,
      groundingText: [
        input.message,
        JSON.stringify(tripSnapshotForPrompt(snapshot, usable, now)),
        today,
      ],
      secrets: this.deps.secrets,
    });
    const response = validateAssistantResponse(
      composeAssistantResponse({
        intent: plan.intent,
        synthesis,
        results: toolResults,
        resolved,
        confirmation: null,
        maxCards: 12,
      }),
      this.deps.secrets,
    );
    return this.finish(
      "completed",
      plan.intent,
      response,
      trace,
      startedAt,
      plannerTokens,
      synthesized.meta.usage.totalTokens,
    );
  }

  private plainResponse(
    message: string,
    intent: AssistantIntent,
    resolved: ResolvedAssistantContext,
  ): AssistantResponse {
    return {
      message,
      intent,
      context: {
        context_point_ids: resolved.contextPointIds,
        agenda_item_ids: resolved.agendaItemIds,
        event_result_ids: resolved.eventResultIds,
      },
      cards: [],
      facts: [],
      recommendations: [],
      clarification: null,
      confirmation_request: null,
      sources: [],
      limitations: [],
      follow_up_actions: [],
      freshness_status: "fresh",
      retrieved_at: null,
    };
  }

  private clarification(
    response: AssistantResponse,
    trace: ExecutionTrace,
    startedAt: number,
    plannerTokens: number | null = null,
  ): OrchestratorOutcome {
    return this.finish(
      "awaiting_clarification",
      "clarify_context",
      validateAssistantResponse(response, this.deps.secrets),
      trace,
      startedAt,
      plannerTokens,
      null,
    );
  }

  private finish(
    state: OrchestratorOutcome["state"],
    intent: AssistantIntent,
    response: AssistantResponse,
    trace: ExecutionTrace,
    startedAt: number,
    plannerTokens: number | null,
    synthesisTokens: number | null,
  ): OrchestratorOutcome {
    return {
      state,
      intent,
      response: validateAssistantResponse(response, this.deps.secrets),
      trace,
      latencyMs: Date.now() - startedAt,
      usage: { plannerTokens, synthesisTokens },
    };
  }

  private async runTools(
    calls: ReadonlyArray<{
      toolName: string;
      arguments: Record<string, unknown>;
    }>,
    runtime: ToolRuntime,
    trace: ExecutionTrace,
    deadline: number,
  ): Promise<Array<{ toolName: string; result: ToolResult }>> {
    const { limits } = this.deps;
    const ordered: Array<{
      index: number;
      toolName: string;
      args: Record<string, unknown>;
      tool: ToolDefinition<ToolRuntime>;
    }> = calls.map((call, index) => ({
      index,
      toolName: call.toolName,
      args: call.arguments,
      tool: this.deps.tools.get(call.toolName) as ToolDefinition<ToolRuntime>,
    }));
    const results = new Map<number, ToolResult>();
    const parallel = ordered.filter((entry) => entry.tool.parallelSafe);
    const sequential = ordered.filter((entry) => !entry.tool.parallelSafe);

    for (
      let offset = 0;
      offset < parallel.length;
      offset += limits.maxParallelTools
    ) {
      const batch = parallel.slice(offset, offset + limits.maxParallelTools);
      const settled = await Promise.allSettled(
        batch.map((entry) => this.runOne(entry, runtime, trace, deadline)),
      );
      for (let index = 0; index < settled.length; index += 1) {
        const outcome = settled[index];
        if (outcome?.status === "fulfilled") {
          results.set((batch[index] as { index: number }).index, outcome.value);
        }
      }
      const failure = settled.find((outcome) => outcome.status === "rejected");
      if (failure && failure.status === "rejected") throw failure.reason;
    }
    for (const entry of sequential) {
      results.set(
        entry.index,
        await this.runOne(entry, runtime, trace, deadline),
      );
    }
    return ordered.map((entry) => ({
      toolName: entry.toolName,
      result: results.get(entry.index) as ToolResult,
    }));
  }

  private async runOne(
    entry: {
      toolName: string;
      args: Record<string, unknown>;
      tool: ToolDefinition<ToolRuntime>;
    },
    runtime: ToolRuntime,
    trace: ExecutionTrace,
    deadline: number,
  ): Promise<ToolResult> {
    const started = Date.now();
    const controller = new AbortController();
    const budget = Math.min(entry.tool.timeoutMs, this.remaining(deadline));
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new AssistantError("TOOL_TIMEOUT", "A tool did not finish in time.", {
            tool_name: entry.toolName,
            timeout_ms: budget,
          }),
        );
      }, budget);
    });
    let counted = false;
    try {
      const result = await Promise.race([
        entry.tool.execute(entry.args, runtime, controller.signal),
        timeout,
      ]);
      trace.providerCallCount += result.providerCalls;
      counted = true;
      validateToolResult(entry.tool, result, {
        maxBytes: this.deps.limits.maxToolResultBytes,
        secrets: this.deps.secrets,
      });
      const toolTrace: ToolTrace = {
        tool_name: entry.toolName,
        status: result.status,
        duration_ms: Date.now() - started,
        source_ids: result.sources.map((source) => source.id),
        entity_ids: [...result.eventResultIds, ...result.contextPointIds],
      };
      trace.toolCalls.push(toolTrace);
      return result;
    } catch (error) {
      // A tool that failed was attempted, so its provider calls count.
      if (!counted) trace.providerCallCount += entry.tool.providerCalls;
      const mapped: AppError = toAppError(error);
      trace.toolCalls.push({
        tool_name: entry.toolName,
        status: "failed",
        duration_ms: Date.now() - started,
        error_code: mapped.code,
      });
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
