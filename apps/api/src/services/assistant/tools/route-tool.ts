import {
  AssistantError,
  formatInZone,
  truncateText,
  zonedDateTimeToIso,
  type AssistantCard,
  type AssistantFact,
  type TransportMode,
  type ToolDefinition,
  type ToolResult,
} from "@travelflow/domain";
import type { RouteOptionView, ToolRuntime } from "../types.js";
import {
  ROUTE_ARGUMENT_NAMES,
  ROUTE_ARGUMENT_PROPERTIES,
  contextPointOf,
  distanceLabel,
  freshnessOf,
  invalidArguments,
  journeyLegOf,
  minutesOf,
  optionalString,
  uniqueSources,
} from "./shared.js";

const MODES: readonly TransportMode[] = [
  "car",
  "taxi",
  "pedestrian",
  "transit",
];

/** Modes asked for when the plan names none: car, pedestrian, transit. */
const DEFAULT_MODE_COUNT = 3;

const MODE_LABEL: Record<TransportMode, string> = {
  car: "Drive",
  taxi: "Taxi",
  pedestrian: "Walk",
  transit: "Public transit",
};

function costText(option: RouteOptionView): string {
  const cost = option.cost;
  if (cost.min_amount === null || cost.max_amount === null) {
    return "Not provided";
  }
  const range =
    cost.min_amount === cost.max_amount
      ? `${cost.min_amount}`
      : `${cost.min_amount} to ${cost.max_amount}`;
  return `${cost.currency} ${range}${cost.is_estimate ? " (estimate)" : ""}`;
}

/**
 * Compares transport options between two places. The services fetch the
 * routes and the mobility engine ranks them; this tool only reshapes the
 * result. Ranking, recommendation, and every figure come from the engine.
 */
export function createCompareRoutesTool(
  timeoutMs: number,
): ToolDefinition<ToolRuntime> {
  return {
    name: "compare_routes",
    description:
      "Compare ways to travel between two places of the trip (drive, taxi, walk, public transit). Returns options with duration, arrival time, walking, transfers, cost when the provider gives it, and risk, ranked by the mobility engine with one recommended option. Give either journey_leg_id, or the origin and destination exactly as the user named them. Optionally give date and time together for a later departure; leave both out to leave now.",
    category: "read",
    intents: ["compare_transport"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...ROUTE_ARGUMENT_PROPERTIES,
        date: {
          type: ["string", "null"],
          format: "date",
          description: "YYYY-MM-DD",
        },
        time: {
          type: ["string", "null"],
          format: "time",
          description: "HH:MM",
        },
        modes: {
          type: ["array", "null"],
          minItems: 1,
          maxItems: 3,
          items: { type: "string", enum: [...MODES] },
        },
      },
    },
    contextArguments: [],
    routeArguments: ROUTE_ARGUMENT_NAMES,
    timeoutMs,
    // One HERE call per requested mode, three at most.
    providerCalls: 3,
    live: true,
    parallelSafe: false,
    async execute(input, runtime): Promise<ToolResult> {
      const legId = optionalString(input.journey_leg_id);
      const date = optionalString(input.date);
      const time = optionalString(input.time);
      if ((date === undefined) !== (time === undefined)) {
        invalidArguments(
          "Give both date and time, or neither.",
          "compare_routes",
        );
      }
      const modes = Array.isArray(input.modes)
        ? (input.modes as TransportMode[])
        : undefined;

      let originId: string;
      let destinationId: string;
      let departureAt: string | null = null;
      if (legId) {
        if (date !== undefined) {
          invalidArguments(
            "A stored journey leg already has its departure time.",
            "compare_routes",
          );
        }
        const leg = journeyLegOf(runtime, legId);
        originId = leg.originContextPointId;
        destinationId = leg.destinationContextPointId;
      } else {
        originId = optionalString(input.origin_context_point_id) ?? "";
        destinationId =
          optionalString(input.destination_context_point_id) ?? "";
        if (!originId || !destinationId) {
          invalidArguments(
            "A route needs a journey leg, or an origin and a destination.",
            "compare_routes",
          );
        }
        if (date !== undefined && time !== undefined) {
          departureAt = zonedDateTimeToIso(
            date,
            time,
            contextPointOf(runtime, originId).timezone,
          );
        }
      }
      const origin = contextPointOf(runtime, originId);
      const destination = contextPointOf(runtime, destinationId);

      const view = await runtime.services.compareRoutes({
        requestId: runtime.requestId,
        executionId: runtime.executionId,
        userId: runtime.userId,
        tripId: runtime.tripId,
        ...(legId
          ? { journeyLegId: legId }
          : {
              originContextPointId: originId,
              destinationContextPointId: destinationId,
            }),
        departureAt,
        ...(modes ? { modes } : {}),
      });

      const timezone = origin.timezone;
      const shown = view.options.slice(0, runtime.maxItems);
      const rankedIds = shown
        .filter((option) => option.score !== null && option.score.rank !== null)
        .map((option) => option.id);
      const recommended = shown.find((option) => option.recommended) ?? null;
      const sources = uniqueSources(view.sources);
      const retrievedAt = new Date(
        shown[0]?.retrieved_at ?? sources[0]?.retrieved_at ?? Date.now(),
      ).toISOString();

      const cards: AssistantCard[] = shown.map((option) => {
        const metrics = option.derived_metrics;
        const facts = option.provider_facts;
        const rank = option.score?.rank ?? null;
        const fields = [
          {
            label: "Duration",
            value: `${minutesOf(metrics.total_duration_seconds)} min`,
          },
          {
            label: "Departs",
            value: formatInZone(metrics.departure_at, timezone),
          },
          {
            label: "Arrives",
            value: formatInZone(metrics.arrival_at, timezone),
          },
          ...(facts.distance_meters !== null
            ? [
                {
                  label: "Distance",
                  value: distanceLabel(facts.distance_meters),
                },
              ]
            : []),
          { label: "Walking", value: `${metrics.walking_minutes} min` },
          { label: "Transfers", value: `${metrics.transfer_count}` },
          { label: "Cost", value: costText(option) },
          {
            label: "Risk",
            value: `traffic ${option.risk.traffic}, weather ${option.risk.weather}, overall ${option.risk.overall}`,
          },
          {
            label: "Safety buffer",
            value: `${minutesOf(metrics.safety_buffer_seconds)} min`,
          },
          ...(option.exclusion_reasons.length > 0
            ? [
                {
                  label: "Excluded because",
                  value: option.exclusion_reasons.join(", "),
                },
              ]
            : []),
        ];
        return {
          type: "route" as const,
          id: option.id,
          title: `${MODE_LABEL[option.transport_mode]}: ${minutesOf(metrics.total_duration_seconds)} min`,
          subtitle: truncateText(
            `${origin.label} to ${destination.label}`,
            300,
          ),
          status: option.status,
          starts_at: new Date(metrics.departure_at).toISOString(),
          ends_at: new Date(metrics.arrival_at).toISOString(),
          fields,
          source_ids: option.source_ids,
          retrieved_at: new Date(option.retrieved_at).toISOString(),
          ...(option.recommended ? { recommended: true } : {}),
          ...(rank !== null ? { rank } : {}),
        };
      });

      const optionData = shown.map((option) => {
        const metrics = option.derived_metrics;
        return {
          id: option.id,
          mode: MODE_LABEL[option.transport_mode],
          rank: option.score?.rank ?? null,
          recommended: option.recommended,
          status: option.status,
          duration_minutes: minutesOf(metrics.total_duration_seconds),
          departs_local: formatInZone(metrics.departure_at, timezone),
          arrives_local: formatInZone(metrics.arrival_at, timezone),
          distance:
            option.provider_facts.distance_meters !== null
              ? distanceLabel(option.provider_facts.distance_meters)
              : null,
          walking_minutes: metrics.walking_minutes,
          transfers: metrics.transfer_count,
          cost: costText(option),
          risk: option.risk,
          safety_buffer_minutes: minutesOf(metrics.safety_buffer_seconds),
          deadline_slack_minutes:
            metrics.deadline_slack_seconds !== null
              ? minutesOf(metrics.deadline_slack_seconds)
              : null,
          exclusion_reasons: option.exclusion_reasons,
          reason_codes: metrics.reason_codes,
        };
      });

      const limitations = [...view.limitations];
      if (view.departureBasis === "now") {
        limitations.push(
          "No departure time was given, so these routes are for leaving now.",
        );
      }
      if (view.preview) {
        limitations.push(
          "These routes were not saved: no stored journey leg covers this pair of places, so there is no recommendation to apply.",
        );
      }
      if (view.options.length > shown.length) {
        limitations.push(
          `Showing the first ${shown.length} of ${view.options.length} options.`,
        );
      }

      const evidence = (recommended ?? shown[0])?.source_ids ?? [];
      const facts: AssistantFact[] = view.facts.map((value) => ({
        label: "Route analysis",
        value: truncateText(value, 600),
        source_ids: evidence,
      }));

      const recommendation = view.departureRecommendation;
      if (shown.length === 0) {
        throw new AssistantError(
          "TOOL_RESULT_INVALID",
          "The route service returned no option.",
          { tool_name: "compare_routes" },
        );
      }
      return {
        status: "ok",
        data: {
          origin: origin.label,
          destination: destination.label,
          timezone,
          departure_basis: view.departureBasis,
          stored: !view.preview,
          options: optionData,
          ...(recommendation
            ? {
                departure_recommendation: {
                  depart_at_local: formatInZone(
                    recommendation.depart_at,
                    timezone,
                  ),
                  latest_departure_local: recommendation.latest_departure_at
                    ? formatInZone(recommendation.latest_departure_at, timezone)
                    : null,
                  buffer_minutes: minutesOf(recommendation.buffer_seconds),
                },
              }
            : {}),
          policy_note: "Ranking comes from the TravelFlow mobility engine.",
        },
        cards,
        facts,
        sources,
        limitations,
        live: true,
        retrievedAt,
        freshness: freshnessOf(shown.map((option) => option.freshness)),
        locked: {
          ...(recommended ? { recommendedOptionId: recommended.id } : {}),
          rankedOptionIds: rankedIds,
        },
        contextPointIds: [originId, destinationId],
        eventResultIds: [],
        agendaItemIds: [],
        // One HERE call per requested mode. Routes are never served from a cache.
        providerCalls: modes ? modes.length : DEFAULT_MODE_COUNT,
      };
    },
  };
}
