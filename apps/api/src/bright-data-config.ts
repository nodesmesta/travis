import type { BrightDataConfig } from "@travelflow/integrations";
import type { ApiConfig } from "./config.js";

/** One place that turns API configuration into Bright Data client configuration. */
export function brightDataConfigFrom(config: ApiConfig): BrightDataConfig {
  return {
    apiKey: config.brightDataApiKey,
    serpZone: config.brightDataSerpZone,
    unlockerZone: config.brightDataUnlockerZone,
    timeoutMs: config.brightDataTimeoutMs,
    ...(config.brightDataEndpointOverride
      ? { endpoint: config.brightDataEndpointOverride }
      : {}),
  };
}
