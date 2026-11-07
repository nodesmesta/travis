export * from "./errors.js";
export * from "./text.js";
export * from "./html.js";
export * from "./bright-data.js";
export * from "./vultr-inference.js";
export * from "./event-discovery.js";
export * from "./event-extraction.js";
export * from "./event-pipeline.js";
export * from "./provider-http.js";
export * from "./here.js";
export * from "./here-normalizers.js";
export * from "./openweather.js";
export * from "./place-discovery.js";
export * from "./activity-pipeline.js";

export interface ExternalQuery {
  request_id: string;
  trip_id: string;
  category: string;
  context_point_id?: string;
  observed_for?: {
    from: string;
    to: string;
    timezone: string;
  };
  filters?: Record<string, string | number | boolean>;
}

export interface NormalizedResult<T> {
  data: T;
  source_ids: string[];
  retrieved_at: string;
  expires_at?: string;
  freshness: "fresh" | "expired" | "unavailable";
}

export interface ExternalProviderAdapter<TRequest, TResult> {
  readonly provider: string;
  execute(request: TRequest): Promise<TResult>;
}
export * from "./email.js";
