/** Intents the assistant accepts. Anything else from a planner is rejected. */
export const ASSISTANT_INTENTS = [
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
] as const;

export type AssistantIntent = (typeof ASSISTANT_INTENTS)[number];

export function isAssistantIntent(value: unknown): value is AssistantIntent {
  return (
    typeof value === "string" &&
    (ASSISTANT_INTENTS as readonly string[]).includes(value)
  );
}

/** Intents that never run a tool. */
export const TOOLLESS_INTENTS: readonly AssistantIntent[] = [
  "clarify_context",
  "out_of_scope",
  "save_to_itinerary",
];

/** Mutations a user may confirm. The planner can only propose them. */
export const CONFIRMATION_ACTIONS = [
  "save_event_result",
  "expire_event_result",
  "save_recommendation",
  "apply_recommendation",
  "dismiss_recommendation",
] as const;

export type ConfirmationAction = (typeof CONFIRMATION_ACTIONS)[number];

export type ConfirmationEntityType =
  "event_discovery_result" | "recommendation";

export const ACTION_ENTITY_TYPE: Record<
  ConfirmationAction,
  ConfirmationEntityType
> = {
  save_event_result: "event_discovery_result",
  expire_event_result: "event_discovery_result",
  save_recommendation: "recommendation",
  apply_recommendation: "recommendation",
  dismiss_recommendation: "recommendation",
};

export function isConfirmationAction(
  value: unknown,
): value is ConfirmationAction {
  return (
    typeof value === "string" &&
    (CONFIRMATION_ACTIONS as readonly string[]).includes(value)
  );
}
