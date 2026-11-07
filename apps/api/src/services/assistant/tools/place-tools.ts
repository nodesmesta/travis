import {
  truncateText,
  type AssistantCard,
  type ToolDefinition,
  type ToolResult,
} from "@travelflow/domain";
import type { PlaceView, ToolRuntime } from "../types.js";
import {
  contextPointOf,
  distanceLabel,
  freshnessOf,
  uniqueSources,
} from "./shared.js";

type PlaceCategory = "activity" | "restaurant";

function yesNo(value: boolean | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value ? "Yes" : "No";
}

function fieldsOf(
  place: PlaceView,
  category: PlaceCategory,
): Array<{ label: string; value: string }> {
  const fields: Array<{ label: string; value: string | null }> = [
    {
      label: "Distance",
      value:
        place.distance_meters === null
          ? null
          : `${distanceLabel(place.distance_meters)} straight line`,
    },
    { label: "Address", value: place.address },
  ];
  if (category === "activity") {
    fields.push(
      { label: "Type", value: place.activity_type ?? null },
      { label: "Setting", value: place.indoor_outdoor ?? null },
      {
        label: "Suggested time",
        value:
          place.recommended_duration_minutes === null ||
          place.recommended_duration_minutes === undefined
            ? null
            : `${place.recommended_duration_minutes} min`,
      },
      {
        label: "Weather sensitivity",
        value: place.weather_sensitivity ?? null,
      },
      { label: "Booking required", value: yesNo(place.booking_required) },
      {
        label: "About",
        value: place.description ? truncateText(place.description, 400) : null,
      },
    );
  } else {
    fields.push({
      label: "Cuisine",
      value:
        place.cuisines && place.cuisines.length > 0
          ? place.cuisines.join(", ")
          : null,
    });
  }
  fields.push(
    {
      label: "Opening hours",
      value: place.opening_hours
        ? truncateText(place.opening_hours.text.join("; "), 300)
        : null,
    },
    { label: "Website", value: place.official_url },
  );
  return fields.filter(
    (field): field is { label: string; value: string } => field.value !== null,
  );
}

function dataOf(place: PlaceView, category: PlaceCategory) {
  return {
    id: place.id,
    name: truncateText(place.name, 300),
    distance:
      place.distance_meters === null
        ? null
        : `${distanceLabel(place.distance_meters)} straight line`,
    address: place.address,
    ...(category === "activity"
      ? {
          type: place.activity_type ?? null,
          setting: place.indoor_outdoor ?? null,
          suggested_minutes: place.recommended_duration_minutes ?? null,
          weather_sensitivity: place.weather_sensitivity ?? null,
          booking_required: place.booking_required ?? null,
          about: place.description
            ? truncateText(place.description, 400)
            : null,
        }
      : { cuisines: place.cuisines ?? [] }),
    opening_hours: place.opening_hours ? place.opening_hours.text : null,
    source_ids: place.source_ids,
  };
}

function createPlaceTool(
  category: PlaceCategory,
  timeoutMs: number,
): ToolDefinition<ToolRuntime> {
  const activity = category === "activity";
  return {
    name: activity ? "find_nearby_activities" : "find_nearby_restaurants",
    description: activity
      ? "Find things to do near one place of the trip, from web sources. Returns sourced activity candidates with distance when known. Results are suggestions, not part of the itinerary."
      : "Find restaurants near one place of the trip, from the places provider. Returns restaurants with straight-line distance, cuisine, and opening hours when the provider gives them. Results are suggestions, not part of the itinerary.",
    category: "read",
    intents: [activity ? "find_nearby_activity" : "find_restaurant"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["search_context_point_id"],
      properties: {
        search_context_point_id: {
          type: "string",
          minLength: 1,
          maxLength: 80,
          description: "Id of a context point in the trip snapshot.",
        },
        ...(activity
          ? {}
          : {
              radius_meters: {
                type: ["integer", "null"],
                minimum: 100,
                maximum: 5000,
                description:
                  "Search radius in metres. Leave out unless the user asked for a distance.",
              },
            }),
      },
    },
    contextArguments: ["search_context_point_id"],
    timeoutMs,
    providerCalls: 1,
    live: true,
    parallelSafe: false,
    async execute(input, runtime): Promise<ToolResult> {
      const contextPointId = input.search_context_point_id as string;
      const point = contextPointOf(runtime, contextPointId);
      const toolStartedAt = runtime.now().getTime();
      const radius =
        typeof input.radius_meters === "number"
          ? input.radius_meters
          : undefined;
      const view = await runtime.services.discoverPlaces({
        requestId: runtime.requestId,
        executionId: runtime.executionId,
        userId: runtime.userId,
        tripId: runtime.tripId,
        contextPointId,
        category,
        ...(radius !== undefined ? { radiusMeters: radius } : {}),
        language: "en",
      });
      const sources = uniqueSources(view.sources);
      const retrievedAt = new Date(view.retrieved_at).toISOString();
      const shown = view.items.slice(0, runtime.maxItems);
      const limitations = [...view.limitations];
      if (view.items.length > shown.length) {
        limitations.push(
          `Showing the first ${shown.length} of ${view.items.length} places found.`,
        );
      }
      const cards: AssistantCard[] = shown.map((place) => ({
        type: category,
        id: place.id,
        title: truncateText(place.name, 300),
        ...(place.address
          ? { subtitle: truncateText(place.address, 300) }
          : {}),
        status: place.status,
        fields: fieldsOf(place, category),
        source_ids: place.source_ids,
        retrieved_at: new Date(place.retrieved_at).toISOString(),
      }));
      return {
        status: view.items.length === 0 ? "empty" : "ok",
        data: {
          search: { near: point.label, category },
          place_count: view.items.length,
          places: shown.map((place) => dataOf(place, category)),
        },
        cards,
        facts: [],
        sources,
        limitations,
        live: true,
        retrievedAt,
        freshness: freshnessOf([view.freshness]),
        contextPointIds: [contextPointId],
        eventResultIds: [],
        agendaItemIds: [],
        // A run stored before this call started was served from the cache.
        providerCalls: Date.parse(view.retrieved_at) < toolStartedAt ? 0 : 1,
      };
    },
  };
}

export function createNearbyActivitiesTool(
  timeoutMs: number,
): ToolDefinition<ToolRuntime> {
  return createPlaceTool("activity", timeoutMs);
}

export function createNearbyRestaurantsTool(
  timeoutMs: number,
): ToolDefinition<ToolRuntime> {
  return createPlaceTool("restaurant", timeoutMs);
}
