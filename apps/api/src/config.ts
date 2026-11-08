export type LogLevel = "debug" | "info" | "warn" | "error";

export interface ApiConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  logLevel: LogLevel;
  supabaseUrl: string | undefined;
  supabaseAnonKey: string | undefined;
  supabaseServiceRoleKey: string | undefined;
  brightDataApiKey: string | undefined;
  brightDataSerpZone: string | undefined;
  brightDataUnlockerZone: string | undefined;
  brightDataTimeoutMs: number;
  /** Test hook: replaces https://api.brightdata.com/request. Unset in production. */
  brightDataEndpointOverride: string | undefined;
  hereApiKey: string | undefined;
  hereTimeoutMs: number;
  liteApiKey: string | undefined;
  liteApiTimeoutMs: number;
  /** Validation harness only: replaces HERE hosts. Rejected in production. */
  /** Browser origins allowed to call the API. Default: the local web dev server. */
  corsAllowedOrigins: string[];
  /** Queued jobs overdue by more than this many seconds make /ready fail. */
  readyJobStaleSeconds: number;
  /** When set, /metrics requires `Authorization: Bearer <token>`. */
  metricsToken: string | undefined;
  hereBaseUrlOverride: string | undefined;
  openWeatherApiKey: string | undefined;
  openWeatherTimeoutMs: number;
  /** Validation harness only: replaces the OpenWeather host. Rejected in production. */
  openWeatherBaseUrlOverride: string | undefined;
  activityDiscoveryTtlHours: number;
  restaurantDiscoveryTtlHours: number;
  vultrInferenceBaseUrl: string | undefined;
  vultrInferenceApiKey: string | undefined;
  vultrInferenceModel: string | undefined;
  aiExtractionTimeoutMs: number;
  eventDiscoveryTtlHours: number;
  eventMaxPages: number;
  eventPageMaxChars: number;
  eventPageConcurrency: number;
  aiPlannerTimeoutMs: number;
  aiSynthesisTimeoutMs: number;
  aiPlannerReasoningEffort: ReasoningEffortSetting;
  aiSynthesisReasoningEffort: ReasoningEffortSetting;
  aiPlannerMaxTokens: number;
  aiSynthesisMaxTokens: number;
  aiMaxToolCalls: number;
  aiMaxProviderCalls: number;
  aiMaxParallelTools: number;
  aiMaxContextMessages: number;
  aiMaxToolResultBytes: number;
  aiMaxToolItems: number;
  aiToolTimeoutMs: number;
  aiEventToolTimeoutMs: number;
  aiMobilityToolTimeoutMs: number;
  aiTotalTimeoutMs: number;
  aiConfirmationTtlMinutes: number;
  /** Task 11. Exactly one email provider is active; undefined means none is configured. */
  emailProvider: "smtp" | "resend" | undefined;
  emailFrom: string | undefined;
  emailProviderApiKey: string | undefined;
  smtpHost: string | undefined;
  smtpPort: number | undefined;
  emailTimeoutMs: number;
  /** Queue a generate_invoice job when a payment succeeds. */
  invoiceAutoGenerate: boolean;
}

function readEmailProvider(
  value: string | undefined,
): ApiConfig["emailProvider"] {
  if (value === undefined || value === "") return undefined;
  if (value === "smtp" || value === "resend") return value;
  throw new Error("EMAIL_PROVIDER must be smtp or resend");
}

function readOptionalPort(
  value: string | undefined,
  field: string,
): number | undefined {
  if (value === undefined || value === "") return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${field} must be an integer between 1 and 65535`);
  }
  return port;
}

function readBoolean(
  value: string | undefined,
  fallback: boolean,
  field: string,
): boolean {
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${field} must be true or false`);
}

export type ReasoningEffortSetting = "minimal" | "low" | "medium" | "high";

function readReasoningEffort(
  value: string | undefined,
  fallback: ReasoningEffortSetting,
  field: string,
): ReasoningEffortSetting {
  if (value === undefined || value === "") return fallback;
  if (
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high"
  ) {
    return value;
  }
  throw new Error(`${field} must be minimal, low, medium, or high`);
}

function readPort(value: string | undefined): number {
  const port = Number(value ?? "4000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("API_PORT must be an integer between 1 and 65535");
  }
  return port;
}

function readPositiveNumber(
  value: string | undefined,
  fallback: number,
  field: string,
): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive number`);
  }
  return parsed;
}

function readNodeEnv(value: string | undefined): ApiConfig["nodeEnv"] {
  if (value === "test" || value === "production") {
    return value;
  }
  return "development";
}

function readLogLevel(value: string | undefined): LogLevel {
  if (value === "debug" || value === "warn" || value === "error") {
    return value;
  }
  return "info";
}

function readOptionalUrl(
  value: string | undefined,
  field: string,
  nodeEnv: ApiConfig["nodeEnv"],
): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (nodeEnv === "production") {
    throw new Error(
      `${field} is for the validation harness and is not allowed in production`,
    );
  }
  try {
    new URL(value);
  } catch {
    throw new Error(`${field} must be a valid URL`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const nodeEnv = readNodeEnv(env.NODE_ENV);
  return {
    nodeEnv,
    host: env.API_HOST || "127.0.0.1",
    port: readPort(env.API_PORT),
    logLevel: readLogLevel(env.LOG_LEVEL),
    supabaseUrl: env.SUPABASE_URL,
    supabaseAnonKey: env.SUPABASE_ANON_KEY,
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    brightDataApiKey: env.BRIGHT_DATA_API_KEY,
    brightDataSerpZone: env.BRIGHT_DATA_SERP_ZONE,
    brightDataUnlockerZone: env.BRIGHT_DATA_UNLOCKER_ZONE,
    brightDataEndpointOverride: readOptionalUrl(
      env.BRIGHT_DATA_ENDPOINT_OVERRIDE,
      "BRIGHT_DATA_ENDPOINT_OVERRIDE",
      nodeEnv,
    ),
    brightDataTimeoutMs: readPositiveNumber(
      env.BRIGHT_DATA_TIMEOUT_MS,
      60000,
      "BRIGHT_DATA_TIMEOUT_MS",
    ),
    hereApiKey: env.HERE_API_KEY || undefined,
    hereTimeoutMs: readPositiveNumber(
      env.HERE_TIMEOUT_MS,
      15000,
      "HERE_TIMEOUT_MS",
    ),
    liteApiKey: env.LITEAPI_API_KEY || undefined,
    liteApiTimeoutMs: readPositiveNumber(
      env.LITEAPI_TIMEOUT_MS,
      30000,
      "LITEAPI_TIMEOUT_MS",
    ),
    readyJobStaleSeconds: readPositiveNumber(
      env.READY_JOB_STALE_SECONDS,
      300,
      "READY_JOB_STALE_SECONDS",
    ),
    metricsToken: env.METRICS_TOKEN || undefined,
    corsAllowedOrigins: (env.CORS_ALLOWED_ORIGINS ?? "http://localhost:3000")
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    hereBaseUrlOverride: readOptionalUrl(
      env.HERE_BASE_URL_OVERRIDE,
      "HERE_BASE_URL_OVERRIDE",
      nodeEnv,
    ),
    openWeatherApiKey: env.OPENWEATHER_API_KEY || undefined,
    openWeatherTimeoutMs: readPositiveNumber(
      env.OPENWEATHER_TIMEOUT_MS,
      15000,
      "OPENWEATHER_TIMEOUT_MS",
    ),
    openWeatherBaseUrlOverride: readOptionalUrl(
      env.OPENWEATHER_BASE_URL_OVERRIDE,
      "OPENWEATHER_BASE_URL_OVERRIDE",
      nodeEnv,
    ),
    activityDiscoveryTtlHours: readPositiveNumber(
      env.ACTIVITY_DISCOVERY_TTL_HOURS,
      24,
      "ACTIVITY_DISCOVERY_TTL_HOURS",
    ),
    restaurantDiscoveryTtlHours: readPositiveNumber(
      env.RESTAURANT_DISCOVERY_TTL_HOURS,
      12,
      "RESTAURANT_DISCOVERY_TTL_HOURS",
    ),
    vultrInferenceBaseUrl: env.VULTR_INFERENCE_BASE_URL,
    vultrInferenceApiKey: env.VULTR_INFERENCE_API_KEY,
    vultrInferenceModel: env.VULTR_INFERENCE_MODEL,
    aiExtractionTimeoutMs: readPositiveNumber(
      env.AI_EXTRACTION_TIMEOUT_MS,
      45000,
      "AI_EXTRACTION_TIMEOUT_MS",
    ),
    eventMaxPages: readPositiveNumber(
      env.EVENT_MAX_PAGES,
      4,
      "EVENT_MAX_PAGES",
    ),
    eventPageMaxChars: readPositiveNumber(
      env.EVENT_PAGE_MAX_CHARS,
      15000,
      "EVENT_PAGE_MAX_CHARS",
    ),
    eventPageConcurrency: readPositiveNumber(
      env.EVENT_PAGE_CONCURRENCY,
      3,
      "EVENT_PAGE_CONCURRENCY",
    ),
    eventDiscoveryTtlHours: readPositiveNumber(
      env.EVENT_DISCOVERY_TTL_HOURS,
      6,
      "EVENT_DISCOVERY_TTL_HOURS",
    ),
    aiPlannerTimeoutMs: readPositiveNumber(
      env.AI_PLANNER_TIMEOUT_MS,
      15000,
      "AI_PLANNER_TIMEOUT_MS",
    ),
    aiSynthesisTimeoutMs: readPositiveNumber(
      env.AI_SYNTHESIS_TIMEOUT_MS,
      20000,
      "AI_SYNTHESIS_TIMEOUT_MS",
    ),
    aiPlannerReasoningEffort: readReasoningEffort(
      env.AI_PLANNER_REASONING_EFFORT,
      "low",
      "AI_PLANNER_REASONING_EFFORT",
    ),
    aiSynthesisReasoningEffort: readReasoningEffort(
      env.AI_SYNTHESIS_REASONING_EFFORT,
      "low",
      "AI_SYNTHESIS_REASONING_EFFORT",
    ),
    aiPlannerMaxTokens: readPositiveNumber(
      env.AI_PLANNER_MAX_TOKENS,
      2000,
      "AI_PLANNER_MAX_TOKENS",
    ),
    aiSynthesisMaxTokens: readPositiveNumber(
      env.AI_SYNTHESIS_MAX_TOKENS,
      3000,
      "AI_SYNTHESIS_MAX_TOKENS",
    ),
    aiMaxToolCalls: readPositiveNumber(
      env.AI_MAX_TOOL_CALLS,
      3,
      "AI_MAX_TOOL_CALLS",
    ),
    aiMaxProviderCalls: readPositiveNumber(
      env.AI_MAX_PROVIDER_CALLS,
      4,
      "AI_MAX_PROVIDER_CALLS",
    ),
    aiMaxParallelTools: readPositiveNumber(
      env.AI_MAX_PARALLEL_TOOLS,
      3,
      "AI_MAX_PARALLEL_TOOLS",
    ),
    aiMaxContextMessages: readPositiveNumber(
      env.AI_MAX_CONTEXT_MESSAGES,
      8,
      "AI_MAX_CONTEXT_MESSAGES",
    ),
    aiMaxToolResultBytes: readPositiveNumber(
      env.AI_MAX_TOOL_RESULT_BYTES,
      60000,
      "AI_MAX_TOOL_RESULT_BYTES",
    ),
    aiMaxToolItems: readPositiveNumber(
      env.AI_MAX_TOOL_ITEMS,
      8,
      "AI_MAX_TOOL_ITEMS",
    ),
    aiToolTimeoutMs: readPositiveNumber(
      env.AI_TOOL_TIMEOUT_MS,
      15000,
      "AI_TOOL_TIMEOUT_MS",
    ),
    aiEventToolTimeoutMs: readPositiveNumber(
      env.AI_EVENT_TOOL_TIMEOUT_MS,
      150000,
      "AI_EVENT_TOOL_TIMEOUT_MS",
    ),
    aiMobilityToolTimeoutMs: readPositiveNumber(
      env.AI_MOBILITY_TOOL_TIMEOUT_MS,
      45000,
      "AI_MOBILITY_TOOL_TIMEOUT_MS",
    ),
    aiTotalTimeoutMs: readPositiveNumber(
      env.AI_TOTAL_TIMEOUT_MS,
      240000,
      "AI_TOTAL_TIMEOUT_MS",
    ),
    aiConfirmationTtlMinutes: readPositiveNumber(
      env.AI_CONFIRMATION_TTL_MINUTES,
      15,
      "AI_CONFIRMATION_TTL_MINUTES",
    ),
    emailProvider: readEmailProvider(env.EMAIL_PROVIDER),
    emailFrom: env.EMAIL_FROM || undefined,
    emailProviderApiKey: env.EMAIL_PROVIDER_API_KEY || undefined,
    smtpHost: env.SMTP_HOST || undefined,
    smtpPort: readOptionalPort(env.SMTP_PORT, "SMTP_PORT"),
    emailTimeoutMs: readPositiveNumber(
      env.EMAIL_TIMEOUT_MS,
      15000,
      "EMAIL_TIMEOUT_MS",
    ),
    invoiceAutoGenerate: readBoolean(
      env.INVOICE_AUTO_GENERATE,
      true,
      "INVOICE_AUTO_GENERATE",
    ),
  };
}
