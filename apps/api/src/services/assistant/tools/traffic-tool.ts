import {
  truncateText,
  type AssistantCard,
  type ToolDefinition,
  type ToolResult,
} from "@travelflow/domain";
import type { ToolRuntime } from "../types.js";
import {
  ROUTE_ARGUMENT_NAMES,
  ROUTE_ARGUMENT_PROPERTIES,
  contextPointOf,
  freshnessOf,
  invalidArguments,
  journeyLegOf,
  optionalString,
  uniqueSources,
} from "./shared.js";

const MAX_INCIDENTS = 3;

/**
 * Traffic flow and incidents in the corridor between two places, from HERE.
 * The level and the jam factors are the provider's and the engine's values.
 */
export function createTrafficTool(
  timeoutMs: number,
): ToolDefinition<ToolRuntime> {
  return {
    name: "get_traffic",
    description:
      "Get current traffic flow and incidents around the corridor between two places of the trip, from the traffic provider. It is a snapshot of now, not a forecast. Give either journey_leg_id, or the origin and destination exactly as the user named them.",
    category: "read",
    intents: ["check_traffic"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { ...ROUTE_ARGUMENT_PROPERTIES },
    },
    contextArguments: [],
    routeArguments: ROUTE_ARGUMENT_NAMES,
    timeoutMs,
    // HERE traffic flow and traffic incidents.
    providerCalls: 2,
    live: true,
    parallelSafe: false,
    async execute(input, runtime): Promise<ToolResult> {
      const legId = optionalString(input.journey_leg_id);
      let originId = optionalString(input.origin_context_point_id);
      let destinationId = optionalString(input.destination_context_point_id);
      if (legId) {
        const leg = journeyLegOf(runtime, legId);
        originId = leg.originContextPointId;
        destinationId = leg.destinationContextPointId;
      } else if (!originId || !destinationId) {
        invalidArguments(
          "Traffic needs a journey leg, or an origin and a destination.",
          "get_traffic",
        );
      }
      const origin = contextPointOf(runtime, originId as string);
      const destination = contextPointOf(runtime, destinationId as string);
      const { traffic, sources: sourceViews } =
        await runtime.services.getTraffic({
          requestId: runtime.requestId,
          userId: runtime.userId,
          tripId: runtime.tripId,
          ...(legId
            ? { journeyLegId: legId }
            : {
                originContextPointId: origin.id,
                destinationContextPointId: destination.id,
              }),
        });
      const sources = uniqueSources(sourceViews);
      const retrievedAt = new Date(traffic.retrieved_at).toISOString();
      const summary = traffic.summary;
      const incidents = traffic.incidents
        .slice(0, MAX_INCIDENTS)
        .map((incident) => ({
          type: incident.type,
          criticality: incident.criticality,
          road_closed: incident.road_closed,
          summary: incident.summary
            ? truncateText(incident.summary, 200)
            : null,
        }));
      const fields = [
        { label: "Traffic level", value: traffic.traffic_level },
        {
          label: "Average jam factor",
          value:
            summary.average_jam_factor === null ||
            summary.average_jam_factor === undefined
              ? "Not available"
              : `${summary.average_jam_factor} of 10`,
        },
        {
          label: "Highest jam factor",
          value:
            summary.max_jam_factor === null ||
            summary.max_jam_factor === undefined
              ? "Not available"
              : `${summary.max_jam_factor} of 10`,
        },
        {
          label: "Road segments measured",
          value: `${summary.segment_count ?? 0}`,
        },
        {
          label: "Closed segments",
          value: `${summary.closed_segment_count ?? 0}`,
        },
        { label: "Incidents", value: `${summary.incident_count ?? 0}` },
        ...incidents.map((incident, index) => ({
          label: `Incident ${index + 1}`,
          value: truncateText(
            [
              incident.type,
              incident.criticality,
              incident.road_closed ? "road closed" : null,
              incident.summary,
            ]
              .filter((part) => part)
              .join(", "),
            300,
          ),
        })),
        {
          label: "Area",
          value: `${traffic.area.radius_meters} m around the middle of the route`,
        },
      ];
      const card: AssistantCard = {
        type: "traffic",
        id: traffic.id,
        title: truncateText(
          `Traffic between ${origin.label} and ${destination.label}`,
          300,
        ),
        status: traffic.traffic_level,
        fields,
        source_ids: sources.map((source) => source.id),
        retrieved_at: retrievedAt,
      };
      return {
        status: "ok",
        data: {
          origin: origin.label,
          destination: destination.label,
          traffic_level: traffic.traffic_level,
          jam_factor_scale: "0 is free flow, 10 is closed",
          average_jam_factor: summary.average_jam_factor ?? null,
          highest_jam_factor: summary.max_jam_factor ?? null,
          road_segments_measured: summary.segment_count ?? 0,
          closed_segments: summary.closed_segment_count ?? 0,
          incident_count: summary.incident_count ?? 0,
          incidents,
          area_radius_meters: traffic.area.radius_meters,
        },
        cards: [card],
        facts: [],
        sources,
        limitations: [
          "Traffic is a snapshot of current flow in a circle around the middle of the route. It is not a forecast for a later departure.",
        ],
        live: true,
        retrievedAt,
        freshness: freshnessOf([traffic.freshness]),
        contextPointIds: [origin.id, destination.id],
        eventResultIds: [],
        agendaItemIds: [],
        providerCalls: traffic.cache_status === "hit" ? 0 : 2,
      };
    },
  };
}
