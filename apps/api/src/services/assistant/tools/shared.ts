import {
  AssistantError,
  truncateText,
  type AssistantSource,
  type ContextPointRecord,
  type FreshnessStatus,
  type JourneyLegRecord,
} from "@travelflow/domain";
import type { SourceView, ToolRuntime } from "../types.js";

/** A source from a mobility or place service, in the shape the assistant response uses. */
export function toAssistantSource(view: SourceView): AssistantSource {
  return {
    id: view.id,
    kind: view.kind,
    provider: view.provider,
    ...(view.url ? { url: view.url } : {}),
    ...(view.title ? { title: truncateText(view.title, 300) } : {}),
    retrieved_at: new Date(view.retrieved_at).toISOString(),
    freshness: view.freshness,
    ...(view.expires_at
      ? { expires_at: new Date(view.expires_at).toISOString() }
      : {}),
    ...(view.observed_for ? { observed_for: view.observed_for } : {}),
  };
}

export function uniqueSources(views: readonly SourceView[]): AssistantSource[] {
  const seen = new Set<string>();
  const result: AssistantSource[] = [];
  for (const view of views) {
    if (seen.has(view.id)) continue;
    seen.add(view.id);
    result.push(toAssistantSource(view));
  }
  return result;
}

/** "expired" is reported as such so result validation can reject it. */
export function freshnessOf(
  values: ReadonlyArray<"fresh" | "expired">,
): FreshnessStatus {
  return values.includes("expired") ? "expired" : "fresh";
}

export function contextPointOf(
  runtime: ToolRuntime,
  id: string,
): ContextPointRecord {
  const point = runtime.snapshot.contextPoints.find((entry) => entry.id === id);
  if (!point) {
    throw new AssistantError(
      "CONTEXT_OUTSIDE_TRIP",
      "The context point is not part of this trip.",
    );
  }
  return point;
}

export function journeyLegOf(
  runtime: ToolRuntime,
  id: string,
): JourneyLegRecord {
  const leg = runtime.snapshot.journeyLegs.find((entry) => entry.id === id);
  if (!leg) {
    throw new AssistantError(
      "PLANNER_TOOL_ARGUMENT_INVALID",
      "The journey leg is not part of this trip.",
      { argument: "journey_leg_id" },
    );
  }
  return leg;
}

export function minutesOf(seconds: number): number {
  return Math.round(seconds / 60);
}

/** One decimal, as a number, for display units such as kilometres. */
export function oneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

export function percentOf(probability: number | null): number | null {
  return probability === null ? null : Math.round(probability * 100);
}

/** "450 m" below one kilometre, "1.2 km" above. The same text is given to the model. */
export function distanceLabel(meters: number): string {
  return meters < 1000
    ? `${Math.round(meters)} m`
    : `${oneDecimal(meters / 1000)} km`;
}

export function pairLabel(
  runtime: ToolRuntime,
  originId: string,
  destinationId: string,
): { origin: string; destination: string } {
  return {
    origin: contextPointOf(runtime, originId).label,
    destination: contextPointOf(runtime, destinationId).label,
  };
}

/** Optional planner arguments may arrive as null. Treat null as not given. */
export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function invalidArguments(message: string, toolName: string): never {
  throw new AssistantError("PLANNER_TOOL_ARGUMENT_INVALID", message, {
    tool_name: toolName,
  });
}

export const ROUTE_ARGUMENT_NAMES = {
  journeyLeg: "journey_leg_id",
  origin: "origin_context_point_id",
  destination: "destination_context_point_id",
} as const;

/** Input schema pieces shared by the tools that travel between two places. */
export const ROUTE_ARGUMENT_PROPERTIES = {
  journey_leg_id: {
    type: ["string", "null"],
    maxLength: 80,
    description:
      "Id of a stored journey leg from the trip data. Use it instead of origin and destination, never with them.",
  },
  origin_context_point_id: {
    type: ["string", "null"],
    maxLength: 80,
    description:
      "Context point id of the start. Must be the origin the user named.",
  },
  destination_context_point_id: {
    type: ["string", "null"],
    maxLength: 80,
    description:
      "Context point id of the end. Must be the destination the user named.",
  },
} as const;
