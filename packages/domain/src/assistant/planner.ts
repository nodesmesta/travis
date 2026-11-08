import { AssistantError } from "./errors.js";
import {
  ACTION_ENTITY_TYPE,
  ASSISTANT_INTENTS,
  CONFIRMATION_ACTIONS,
  TOOLLESS_INTENTS,
  isAssistantIntent,
  isConfirmationAction,
  type AssistantIntent,
  type ConfirmationAction,
  type ConfirmationEntityType,
} from "./intents.js";
import type { ResolvedAssistantContext } from "./context-resolver.js";
import { validateSchema, type JsonSchema } from "./schema.js";
import {
  validateToolArguments,
  type ToolDefinition,
  type ToolRegistry,
} from "./tools.js";

export interface PlannedToolCall {
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface ProposedAction {
  action: ConfirmationAction;
  entityType: ConfirmationEntityType;
  entityId: string;
}

export interface AssistantPlan {
  intent: AssistantIntent;
  needsClarification: boolean;
  clarificationQuestion: string | null;
  toolCalls: PlannedToolCall[];
  proposedAction: ProposedAction | null;
}

export interface PlanLimits {
  maxToolCalls: number;
  maxProviderCalls: number;
}

export interface PlanValidationContext<TContext> {
  registry: ToolRegistry<TContext>;
  /** Context points of the trip that can be searched (active and resolved). */
  usableContextPointIds: ReadonlySet<string>;
  /** Every active context point of the trip, usable or not. */
  tripContextPointIds: ReadonlySet<string>;
  resolved: ResolvedAssistantContext;
  /** Stored journey legs by id, with their two ends. Needed to plan a route from a leg. */
  journeyLegs?: ReadonlyMap<string, { origin: string; destination: string }>;
  /** Entities the user can act on, by type. A proposed action must point at one. */
  actionableEntityIds: Record<ConfirmationEntityType, ReadonlySet<string>>;
  limits: PlanLimits;
}

export interface ValidatedPlan {
  plan: AssistantPlan;
  /**
   * True when a planned tool needs a context point but the message named none
   * and the UI selected none. The orchestrator asks the user instead of guessing.
   */
  needsContextChoice: boolean;
  /**
   * True when a planned tool travels between two places but the message did not
   * establish which one is the start and which is the end. The orchestrator
   * asks the user; the planner's guess is never used.
   */
  needsRouteEndpoints: boolean;
}

/** The single function the planner must call. */
export function buildSubmitPlanTool(
  toolNames: readonly string[],
  maxToolCalls: number,
): {
  name: string;
  description: string;
  parameters: JsonSchema;
} {
  return {
    name: "submit_plan",
    description:
      "Submit the execution plan. Choose an intent and the read-only tools to run. You never change data yourself.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["intent", "needs_clarification", "tool_calls"],
      properties: {
        intent: { type: "string", enum: [...ASSISTANT_INTENTS] },
        needs_clarification: { type: "boolean" },
        clarification_question: { type: ["string", "null"], maxLength: 500 },
        tool_calls: {
          type: "array",
          maxItems: maxToolCalls,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["tool_name", "arguments"],
            properties: {
              tool_name: { type: "string", enum: [...toolNames] },
              arguments: { type: "object" },
              depends_on: {
                type: "array",
                maxItems: 0,
                items: { type: "string" },
              },
            },
          },
        },
        proposed_action: {
          oneOf: [
            { type: "null" },
            {
              type: "object",
              additionalProperties: false,
              required: ["action", "entity_id"],
              properties: {
                action: { type: "string", enum: [...CONFIRMATION_ACTIONS] },
                entity_id: { type: "string", minLength: 1, maxLength: 80 },
              },
            },
          ],
        },
      },
    },
  };
}

function invalid(message: string, violations?: string[]): AssistantError {
  return new AssistantError("PLANNER_INVALID_OUTPUT", message, {
    ...(violations ? { violations: violations.slice(0, 5) } : {}),
  });
}

function argumentKey(call: PlannedToolCall): string {
  const sorted = Object.keys(call.arguments)
    .sort()
    .map((key) => [key, call.arguments[key]]);
  return `${call.toolName}:${JSON.stringify(sorted)}`;
}

/**
 * Validates planner output before anything runs. The model is not trusted:
 * a bad plan ends the execution (`PLANNER_*`) and no provider is called.
 */
export function validatePlannerOutput<TContext>(
  raw: unknown,
  context: PlanValidationContext<TContext>,
): ValidatedPlan {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalid("Planner output must be a JSON object.");
  }
  const record = raw as Record<string, unknown>;
  if (record.intent !== undefined && !isAssistantIntent(record.intent)) {
    throw new AssistantError(
      "PLANNER_UNSUPPORTED_INTENT",
      "The planner chose an intent that is not supported.",
    );
  }
  const shape = buildSubmitPlanTool(
    context.registry.names(),
    context.limits.maxToolCalls,
  ).parameters;
  const rawCalls = record.tool_calls;
  if (
    Array.isArray(rawCalls) &&
    rawCalls.length > context.limits.maxToolCalls
  ) {
    throw new AssistantError(
      "PLANNER_LIMIT_EXCEEDED",
      "The plan asks for more tool calls than allowed.",
      { max_tool_calls: context.limits.maxToolCalls },
    );
  }
  if (Array.isArray(rawCalls)) {
    for (const call of rawCalls) {
      const name =
        call && typeof call === "object"
          ? (call as Record<string, unknown>).tool_name
          : undefined;
      if (typeof name === "string" && !context.registry.get(name)) {
        throw new AssistantError(
          "PLANNER_TOOL_NOT_ALLOWED",
          "The plan uses a tool that is not allowed.",
          { tool_name: name.slice(0, 80) },
        );
      }
    }
  }
  const violations = validateSchema(shape, raw);
  if (violations.length > 0) {
    throw invalid("Planner output does not match the plan schema.", violations);
  }

  const intent = record.intent as AssistantIntent;
  const needsClarification = record.needs_clarification as boolean;
  const question =
    typeof record.clarification_question === "string"
      ? record.clarification_question.trim()
      : null;
  const toolCalls: PlannedToolCall[] = (
    record.tool_calls as Array<Record<string, unknown>>
  ).map((call) => ({
    toolName: call.tool_name as string,
    arguments: call.arguments as Record<string, unknown>,
  }));

  if (needsClarification && (!question || question.length === 0)) {
    throw invalid("A clarification needs a question.");
  }
  if (needsClarification && toolCalls.length > 0) {
    throw invalid("A clarification cannot run tools.");
  }
  if (TOOLLESS_INTENTS.includes(intent) && toolCalls.length > 0) {
    throw invalid("This intent does not run tools.");
  }
  if (
    !TOOLLESS_INTENTS.includes(intent) &&
    !needsClarification &&
    toolCalls.length === 0
  ) {
    throw invalid("This intent needs at least one tool call.");
  }

  const seen = new Set<string>();
  let providerCalls = 0;
  let needsContextChoice = false;
  let needsRouteEndpoints = false;
  for (const call of toolCalls) {
    const tool = context.registry.get(
      call.toolName,
    ) as ToolDefinition<TContext>;
    if (tool.category !== "read") {
      throw new AssistantError(
        "PLANNER_TOOL_NOT_ALLOWED",
        "The plan uses a tool that is not allowed.",
        { tool_name: tool.name },
      );
    }
    if (!tool.intents.includes(intent)) {
      throw invalid("A planned tool does not serve the chosen intent.", [
        `${tool.name} does not serve ${intent}`,
      ]);
    }
    const key = argumentKey(call);
    if (seen.has(key)) throw invalid("The plan repeats the same tool call.");
    seen.add(key);
    validateToolArguments(tool, call.arguments);
    providerCalls += tool.providerCalls;

    if (tool.routeArguments) {
      if (checkRouteArguments(tool.routeArguments, call, context)) {
        needsRouteEndpoints = true;
      }
    }

    for (const argumentName of tool.contextArguments) {
      const value = call.arguments[argumentName];
      if (typeof value !== "string") continue;
      if (!context.tripContextPointIds.has(value)) {
        throw new AssistantError(
          "PLANNER_TOOL_ARGUMENT_INVALID",
          "The plan refers to a place outside this trip.",
          { tool_name: tool.name, argument: argumentName },
        );
      }
      if (context.resolved.contextPointIds.length === 0) {
        needsContextChoice = true;
      } else if (!context.resolved.contextPointIds.includes(value)) {
        throw new AssistantError(
          "PLANNER_TOOL_ARGUMENT_INVALID",
          "The plan uses a place that differs from the resolved context.",
          { tool_name: tool.name, argument: argumentName },
        );
      } else if (!context.usableContextPointIds.has(value)) {
        throw new AssistantError(
          "PLANNER_TOOL_ARGUMENT_INVALID",
          "The plan uses a place that cannot be searched yet.",
          { tool_name: tool.name, argument: argumentName },
        );
      }
    }
  }
  if (providerCalls > context.limits.maxProviderCalls) {
    throw new AssistantError(
      "PLANNER_LIMIT_EXCEEDED",
      "The plan needs more provider calls than allowed.",
      { max_provider_calls: context.limits.maxProviderCalls },
    );
  }

  let proposedAction: ProposedAction | null = null;
  const rawAction = record.proposed_action;
  if (rawAction !== undefined && rawAction !== null) {
    if (intent !== "save_to_itinerary") {
      throw invalid("Only save_to_itinerary may propose an action.");
    }
    const action = (rawAction as Record<string, unknown>).action;
    const entityId = (rawAction as Record<string, unknown>).entity_id;
    if (!isConfirmationAction(action) || typeof entityId !== "string") {
      throw invalid("The proposed action is not valid.");
    }
    const entityType = ACTION_ENTITY_TYPE[action];
    if (!context.actionableEntityIds[entityType].has(entityId)) {
      throw new AssistantError(
        "PLANNER_TOOL_ARGUMENT_INVALID",
        "The proposed action refers to something that is not part of this conversation or trip.",
        { action },
      );
    }
    proposedAction = { action, entityType, entityId };
  }
  if (
    intent === "save_to_itinerary" &&
    !needsClarification &&
    !proposedAction
  ) {
    throw invalid("save_to_itinerary needs a proposed action.");
  }

  return {
    plan: {
      intent,
      needsClarification,
      clarificationQuestion: needsClarification ? question : null,
      toolCalls,
      proposedAction,
    },
    needsContextChoice,
    needsRouteEndpoints,
  };
}

function argumentInvalid(
  message: string,
  toolName: string,
  argument: string,
): AssistantError {
  return new AssistantError("PLANNER_TOOL_ARGUMENT_INVALID", message, {
    tool_name: toolName,
    argument,
  });
}

/**
 * Checks the places a travel tool will use. Returns true when the user still has
 * to say which place is the start and which is the end.
 */
function checkRouteArguments<TContext>(
  names: { journeyLeg: string; origin: string; destination: string },
  call: PlannedToolCall,
  context: PlanValidationContext<TContext>,
): boolean {
  // The planner may send null for an argument it does not use.
  const given = (value: unknown): boolean =>
    value !== undefined && value !== null;
  const legId = call.arguments[names.journeyLeg];
  const origin = call.arguments[names.origin];
  const destination = call.arguments[names.destination];
  const { resolved } = context;

  if (given(legId)) {
    if (given(origin) || given(destination)) {
      throw invalid("Use either a journey leg or an origin and a destination.");
    }
    const leg =
      typeof legId === "string" ? context.journeyLegs?.get(legId) : undefined;
    if (!leg) {
      throw argumentInvalid(
        "The plan refers to a journey leg that is not part of this trip.",
        call.toolName,
        names.journeyLeg,
      );
    }
    for (const id of resolved.contextPointIds) {
      if (id !== leg.origin && id !== leg.destination) {
        throw argumentInvalid(
          "The plan uses a journey leg that differs from the places in the message.",
          call.toolName,
          names.journeyLeg,
        );
      }
    }
    if (
      (resolved.originContextPointId &&
        resolved.originContextPointId !== leg.origin) ||
      (resolved.destinationContextPointId &&
        resolved.destinationContextPointId !== leg.destination)
    ) {
      throw argumentInvalid(
        "The plan uses a journey leg that runs in a different direction than the message.",
        call.toolName,
        names.journeyLeg,
      );
    }
    return false;
  }

  if (typeof origin !== "string" || typeof destination !== "string") {
    throw invalid(
      "A route needs a journey leg, or an origin and a destination.",
    );
  }
  if (origin === destination) {
    throw argumentInvalid(
      "The origin and the destination are the same place.",
      call.toolName,
      names.destination,
    );
  }
  for (const [argument, value] of [
    [names.origin, origin],
    [names.destination, destination],
  ] as const) {
    if (!context.tripContextPointIds.has(value)) {
      throw argumentInvalid(
        "The plan refers to a place outside this trip.",
        call.toolName,
        argument,
      );
    }
    if (!context.usableContextPointIds.has(value)) {
      throw argumentInvalid(
        "The plan uses a place that cannot be routed yet.",
        call.toolName,
        argument,
      );
    }
  }
  if (!resolved.originContextPointId || !resolved.destinationContextPointId) {
    return true;
  }
  if (
    origin !== resolved.originContextPointId ||
    destination !== resolved.destinationContextPointId
  ) {
    throw argumentInvalid(
      "The plan uses a start or an end that differs from the resolved context.",
      call.toolName,
      names.origin,
    );
  }
  return false;
}
