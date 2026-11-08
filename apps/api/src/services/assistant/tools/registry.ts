import { ToolRegistry } from "@travelflow/domain";
import type { ApiConfig } from "../../../config.js";
import type { ToolRuntime } from "../types.js";
import { createEventDiscoveryTool } from "./event-discovery-tool.js";
import {
  createNearbyActivitiesTool,
  createNearbyRestaurantsTool,
} from "./place-tools.js";
import { createRecommendationReadTool } from "./recommendation-tool.js";
import { createCompareRoutesTool } from "./route-tool.js";
import { createTrafficTool } from "./traffic-tool.js";
import { createTripSummaryTool } from "./trip-summary-tool.js";
import { createTripAdviceTool } from "./trip-advice-tool.js";
import { createWeatherTool } from "./weather-tool.js";

/**
 * The allowlist of tools the planner may use. Adding a tool means registering
 * one more definition here; the planner, validator, executor, and response code
 * do not change.
 */
export function createAssistantToolRegistry(
  config: Pick<
    ApiConfig,
    "aiToolTimeoutMs" | "aiEventToolTimeoutMs" | "aiMobilityToolTimeoutMs"
  >,
): ToolRegistry<ToolRuntime> {
  return new ToolRegistry<ToolRuntime>()
    .register(createEventDiscoveryTool(config.aiEventToolTimeoutMs))
    .register(createTripSummaryTool(config.aiToolTimeoutMs))
    .register(createTripAdviceTool(config.aiEventToolTimeoutMs))
    .register(createRecommendationReadTool(config.aiToolTimeoutMs))
    .register(createCompareRoutesTool(config.aiMobilityToolTimeoutMs))
    .register(createWeatherTool(config.aiMobilityToolTimeoutMs))
    .register(createTrafficTool(config.aiMobilityToolTimeoutMs))
    .register(createNearbyActivitiesTool(config.aiEventToolTimeoutMs))
    .register(createNearbyRestaurantsTool(config.aiMobilityToolTimeoutMs));
}
