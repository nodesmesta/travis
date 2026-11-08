import {
  truncateText,
  type AssistantCard,
  type AssistantSource,
  type ToolDefinition,
  type ToolResult,
} from "@travelflow/domain";
import { RECOMMENDATION_FINAL_STATUSES } from "../../../repositories/recommendation-repository.js";
import type { ToolRuntime } from "../types.js";

function recommendationTitleOf(row: {
  payload: Record<string, unknown>;
  recommendation_type: string;
}): string {
  const title = row.payload.title;
  return typeof title === "string" && title.length > 0
    ? truncateText(title, 300)
    : `${row.recommendation_type} recommendation`;
}

/**
 * Reads recommendations that the backend already stored (Task 08). The text
 * and ranking come from the engine; the assistant can only describe them.
 */
export function createRecommendationReadTool(
  timeoutMs: number,
): ToolDefinition<ToolRuntime> {
  return {
    name: "get_recommendations",
    description:
      "Read recommendations that TravelFlow already computed and stored for this trip (for example route or place suggestions that are waiting for a decision). It makes no external request and never changes them.",
    category: "read",
    intents: ["get_recommendations"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    contextArguments: [],
    timeoutMs,
    providerCalls: 0,
    live: false,
    parallelSafe: true,
    async execute(_input, runtime): Promise<ToolResult> {
      const rows = await runtime.services.listRecommendations(runtime.tripId);
      const finalStatuses = RECOMMENDATION_FINAL_STATUSES as readonly string[];
      const now = runtime.now().getTime();
      const open = rows.filter(
        (row) =>
          !finalStatuses.includes(row.status) &&
          (!row.expires_at || Date.parse(row.expires_at) > now),
      );
      const source: AssistantSource = {
        id: `internal:trip:${runtime.tripId}`,
        kind: "internal",
        provider: "travelflow",
        title: "TravelFlow stored recommendations",
        retrieved_at: runtime.now().toISOString(),
        freshness: "fresh",
      };
      const shown = open.slice(0, runtime.maxItems);
      const cards: AssistantCard[] = shown.map((row) => {
        const title = recommendationTitleOf(row);
        return {
          type: "recommendation" as const,
          id: row.id,
          title: truncateText(title, 300),
          status: row.status,
          fields: [
            { label: "Type", value: row.recommendation_type },
            ...(row.reason
              ? [{ label: "Why", value: truncateText(row.reason, 600) }]
              : []),
            ...(row.expires_at
              ? [{ label: "Valid until", value: row.expires_at }]
              : []),
          ],
          source_ids: [source.id],
          actions: [
            {
              action: "apply_recommendation" as const,
              label: "Add to itinerary",
            },
            { action: "dismiss_recommendation" as const, label: "Dismiss" },
          ],
        };
      });
      return {
        status: shown.length === 0 ? "empty" : "ok",
        data: {
          recommendation_count: open.length,
          recommendations: shown.map((row) => ({
            id: row.id,
            title: recommendationTitleOf(row),
            type: row.recommendation_type,
            status: row.status,
            reason: row.reason ? truncateText(row.reason, 600) : null,
            expires_at: row.expires_at,
          })),
        },
        cards,
        facts: [],
        sources: [source],
        limitations: [],
        live: false,
        retrievedAt: null,
        freshness: "fresh",
        contextPointIds: [],
        eventResultIds: [],
        agendaItemIds: [],
        providerCalls: 0,
      };
    },
  };
}
