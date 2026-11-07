/**
 * Modules the background worker shares with the API (`@travelflow/api/shared`).
 * The worker runs the same weather and traffic refresh code as the API
 * endpoints, so provider calls, caching, and snapshot persistence behave
 * identically. Nothing here starts a server or reads the environment.
 */
export { loadConfig, type ApiConfig, type LogLevel } from "./config.js";
export { AppError } from "./errors.js";
export { createLogger, type Logger } from "./logger.js";
export { createAdminSupabaseClient } from "./supabase/client.js";
export type { Database, Json, SourceRow } from "./supabase/database.types.js";
export type {
  AlertRow,
  BackgroundJobRow,
  BackgroundJobStatus,
  BackgroundJobType,
} from "./supabase/tables/job.types.js";
export type {
  TrafficSnapshotRow,
  WeatherSnapshotRow,
} from "./supabase/tables/mobility.types.js";
export { SupabaseMobilityRepository } from "./repositories/mobility-repository.js";
export { SupabaseTripContextRepository } from "./repositories/trip-context-repository.js";
export {
  SupabaseActivityLogWriter,
  SupabaseIdempotencyStore,
} from "./repositories/domain-persistence.js";
export { MobilityService } from "./services/mobility-service.js";
export {
  SupabaseInvoiceRepository,
  SupabaseInvoiceStorage,
} from "./repositories/invoice-repository.js";
export {
  InvoiceService,
  type InvoiceServiceDeps,
} from "./services/invoice-service.js";
export {
  EmailDeliveryService,
  type DispatchOutcome,
} from "./services/email-delivery-service.js";
