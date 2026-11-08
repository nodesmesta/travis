import {
  AssistantError,
  formatInZone,
  truncateText,
  zonedDateTimeToIso,
  type AssistantCard,
  type AssistantSource,
  type FreshnessStatus,
  type ToolDefinition,
  type ToolResult,
} from "@travelflow/domain";
import type { ToolRuntime } from "../types.js";

export const EVENT_CATEGORIES = [
  "business_events",
  "conference",
  "networking",
  "technology",
  "arts_culture",
  "food_drink",
  "music",
  "sports",
  "family",
  "general",
] as const;

export function createEventDiscoveryTool(
  timeoutMs: number,
): ToolDefinition<ToolRuntime> {
  return {
    name: "discover_events",
    description:
      "Find public events near one context point of the trip on one date. Returns sourced event candidates with start times. Results are suggestions only; they are not part of the itinerary.",
    category: "read",
    intents: ["find_nearby_event"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["search_context_point_id", "date"],
      properties: {
        search_context_point_id: {
          type: "string",
          minLength: 1,
          maxLength: 80,
          description: "Id of a context point in the trip snapshot.",
        },
        date: { type: "string", format: "date", description: "YYYY-MM-DD" },
        time_range: {
          type: ["object", "null"],
          additionalProperties: false,
          required: ["from", "to"],
          properties: {
            from: { type: "string", format: "time", description: "HH:MM" },
            to: { type: "string", format: "time", description: "HH:MM" },
          },
        },
        category: { type: "string", enum: [...EVENT_CATEGORIES] },
        radius_preference: {
          type: "string",
          enum: ["walking", "nearby", "city"],
        },
      },
    },
    contextArguments: ["search_context_point_id"],
    timeoutMs,
    providerCalls: 1,
    live: true,
    parallelSafe: false,
    async execute(input, runtime): Promise<ToolResult> {
      const contextPointId = input.search_context_point_id as string;
      const contextPoint = runtime.snapshot.contextPoints.find(
        (point) => point.id === contextPointId,
      );
      if (!contextPoint) {
        throw new AssistantError(
          "CONTEXT_OUTSIDE_TRIP",
          "The context point is not part of this trip.",
        );
      }
      const range = (input.time_range ?? null) as {
        from: string;
        to: string;
      } | null;
      const from = range?.from ?? "00:00";
      const to = range?.to ?? "23:59";
      const date = input.date as string;
      const fromIso = zonedDateTimeToIso(date, from, contextPoint.timezone);
      const toIso = zonedDateTimeToIso(date, to, contextPoint.timezone);
      if (Date.parse(toIso) <= Date.parse(fromIso)) {
        throw new AssistantError(
          "PLANNER_TOOL_ARGUMENT_INVALID",
          "The planned time range ends before it starts.",
          { tool_name: "discover_events" },
        );
      }
      const category =
        typeof input.category === "string" ? input.category : "business_events";
      const radius =
        typeof input.radius_preference === "string"
          ? input.radius_preference
          : "nearby";
      const toolStartedAt = runtime.now().getTime();
      const response = await runtime.services.discoverEvents({
        requestId: runtime.requestId,
        executionId: runtime.executionId,
        userId: runtime.userId,
        tripId: runtime.tripId,
        contextPointId,
        observedFor: {
          from: fromIso,
          to: toIso,
          timezone: contextPoint.timezone,
        },
        category,
        radiusPreference: radius,
        language: "en",
      });

      const freshness: FreshnessStatus =
        response.freshness === "fresh"
          ? "fresh"
          : response.freshness === "expired"
            ? "expired"
            : "unavailable";
      const sources: AssistantSource[] = response.sources.map((source) => ({
        id: source.id,
        kind: source.kind,
        provider: source.provider,
        ...(source.url ? { url: source.url } : {}),
        ...(source.title ? { title: truncateText(source.title, 300) } : {}),
        retrieved_at: new Date(source.retrieved_at).toISOString(),
        freshness: source.freshness,
        ...(source.expires_at
          ? { expires_at: new Date(source.expires_at).toISOString() }
          : {}),
      }));
      const retrievedAt = new Date(response.retrieved_at).toISOString();
      const shown = response.items.slice(0, runtime.maxItems);
      const limitations = [...response.limitations];
      if (response.items.length > shown.length) {
        limitations.push(
          `Showing the first ${shown.length} of ${response.items.length} events found.`,
        );
      }
      const cards: AssistantCard[] = shown.map((item) => {
        const fields = [
          {
            label: "Starts",
            value: `${formatInZone(item.starts_at, contextPoint.timezone)} (${contextPoint.timezone})`,
          },
          ...(item.ends_at
            ? [
                {
                  label: "Ends",
                  value: formatInZone(item.ends_at, contextPoint.timezone),
                },
              ]
            : []),
          ...(item.venue_name
            ? [{ label: "Venue", value: truncateText(item.venue_name, 300) }]
            : []),
          ...(item.category
            ? [{ label: "Category", value: truncateText(item.category, 120) }]
            : []),
          ...(item.description
            ? [
                {
                  label: "About",
                  value: truncateText(item.description, 400),
                },
              ]
            : []),
        ];
        return {
          type: "event" as const,
          id: item.id,
          title: truncateText(item.title, 300),
          ...(item.venue_name
            ? { subtitle: truncateText(item.venue_name, 300) }
            : {}),
          status: item.status,
          starts_at: new Date(item.starts_at).toISOString(),
          ...(item.ends_at
            ? { ends_at: new Date(item.ends_at).toISOString() }
            : {}),
          fields,
          source_ids: item.source_ids,
          retrieved_at: retrievedAt,
          ...(item.status === "suggested"
            ? {
                actions: [
                  {
                    action: "save_event_result" as const,
                    label: "Add to itinerary",
                  },
                ],
              }
            : {}),
        };
      });
      return {
        status: response.items.length === 0 ? "empty" : "ok",
        data: {
          search: {
            context_point: contextPoint.label,
            date,
            from,
            to,
            timezone: contextPoint.timezone,
            category,
          },
          event_count: response.items.length,
          events: shown.map((item) => ({
            id: item.id,
            title: truncateText(item.title, 300),
            starts_at: new Date(item.starts_at).toISOString(),
            ends_at: item.ends_at ? new Date(item.ends_at).toISOString() : null,
            venue: item.venue_name ? truncateText(item.venue_name, 300) : null,
            category: item.category ?? null,
            description: item.description
              ? truncateText(item.description, 400)
              : null,
            source_ids: item.source_ids,
          })),
        },
        cards,
        facts: [],
        sources,
        limitations,
        live: true,
        retrievedAt,
        freshness,
        contextPointIds: [contextPointId],
        eventResultIds: shown.map((item) => item.id),
        agendaItemIds: [],
        // A snapshot retrieved before this call started came from the cache, so no provider was called.
        providerCalls:
          Date.parse(response.retrieved_at) < toolStartedAt ? 0 : 1,
      };
    },
  };
}
