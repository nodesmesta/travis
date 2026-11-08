import {
  HereClient,
  OpenWeatherClient,
  createEmailProvider,
  emailConfigured,
  type EmailSettings,
  type HereService,
} from "@travelflow/integrations";
import {
  EmailDeliveryService,
  InvoiceService,
  MobilityService,
  SupabaseInvoiceRepository,
  SupabaseInvoiceStorage,
  SupabaseActivityLogWriter,
  SupabaseIdempotencyStore,
  SupabaseMobilityRepository,
  SupabaseTripContextRepository,
  createAdminSupabaseClient,
  createLogger,
  type Logger,
} from "@travelflow/api/shared";
import { SupabaseAlertWriter } from "./alert-store.js";
import { loadWorkerConfig, type WorkerConfig } from "./config.js";
import { runHandler, type HandlerDeps } from "./handlers.js";
import { SupabaseJobStore } from "./job-store.js";
import { JobRunner } from "./runner.js";
import { runScheduleTick } from "./scheduler.js";
import { TripData } from "./trip-data.js";

function hereBaseUrls(
  origin: string | undefined,
): Partial<Record<HereService, string>> | undefined {
  if (!origin) return undefined;
  const base = origin.endsWith("/") ? origin.slice(0, -1) : origin;
  return {
    router: `${base}/router`,
    intermodal: `${base}/intermodal`,
    traffic: `${base}/traffic`,
    geocode: `${base}/geocode`,
    browse: `${base}/browse`,
  };
}

function buildHandlerDeps(
  config: WorkerConfig,
  logger: Logger,
): {
  deps: HandlerDeps;
  store: SupabaseJobStore;
  data: TripData;
} {
  const admin = createAdminSupabaseClient(config.api);
  const trips = new SupabaseTripContextRepository(admin);
  const baseUrls = hereBaseUrls(config.api.hereBaseUrlOverride);
  const mobility = new MobilityService({
    trips,
    repo: new SupabaseMobilityRepository(admin),
    here: new HereClient({
      apiKey: config.api.hereApiKey,
      timeoutMs: config.api.hereTimeoutMs,
      ...(baseUrls ? { baseUrls } : {}),
    }),
    weather: new OpenWeatherClient({
      apiKey: config.api.openWeatherApiKey,
      timeoutMs: config.api.openWeatherTimeoutMs,
      ...(config.api.openWeatherBaseUrlOverride
        ? { baseUrl: config.api.openWeatherBaseUrlOverride }
        : {}),
    }),
    idempotency: new SupabaseIdempotencyStore(admin),
    activityLog: new SupabaseActivityLogWriter(admin),
    logger,
  });
  const data = new TripData(admin);
  const emailSettings: EmailSettings = {
    provider: config.api.emailProvider,
    from: config.api.emailFrom,
    timeoutMs: config.api.emailTimeoutMs,
    smtpHost: config.api.smtpHost,
    smtpPort: config.api.smtpPort,
    resendApiKey: config.api.emailProviderApiKey,
  };
  const invoiceRepo = new SupabaseInvoiceRepository(admin);
  const invoiceService = new InvoiceService({
    reads: invoiceRepo,
    writes: invoiceRepo,
    storage: new SupabaseInvoiceStorage(admin),
    logger,
    emailConfigured: () => emailConfigured(emailSettings),
    generationWaitMs: 10_000,
  });
  const emailService = new EmailDeliveryService({
    repo: invoiceRepo,
    invoices: invoiceService,
    providerName: config.api.emailProvider ?? null,
    provider: () => createEmailProvider(emailSettings),
    from: config.api.emailFrom,
    logger,
  });
  return {
    deps: {
      data,
      alerts: new SupabaseAlertWriter(admin),
      mobility,
      invoices: {
        generate: (actor, bookingId) =>
          invoiceService.generate(actor, bookingId),
        dispatchEmail: (deliveryId, actor) =>
          emailService.dispatch(deliveryId, actor),
      },
      contextPoint: (id) => trips.getContextPoint(id),
      now: () => new Date(),
    },
    store: new SupabaseJobStore(admin),
    data,
  };
}

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const logger = createLogger(config.api.logLevel);
  const { deps, store, data } = buildHandlerDeps(config, logger);

  const runner = new JobRunner({
    settings: config,
    store,
    handle: (parsed, context) => runHandler(deps, context, parsed),
    logger,
  });

  logger.info("worker.started", {
    worker_id: config.workerId,
    concurrency: config.concurrency,
    poll_interval_ms: config.pollIntervalMs,
    schedule_interval_ms: config.scheduleIntervalMs,
    lease_seconds: config.leaseSeconds,
    heartbeat_interval_ms: config.heartbeatIntervalMs,
    job_timeout_ms: config.jobTimeoutMs,
    trip_filter: config.tripIds.length,
    here_configured: Boolean(config.api.hereApiKey),
    openweather_configured: Boolean(config.api.openWeatherApiKey),
    email_provider: config.api.emailProvider ?? null,
  });

  const scheduleOnce = async (): Promise<void> => {
    try {
      await runScheduleTick({
        data,
        jobs: store,
        logger,
        now: () => new Date(),
        tripIds: config.tripIds,
      });
    } catch (error) {
      logger.error("scheduler.tick_failed", {
        worker_id: config.workerId,
        error_name: error instanceof Error ? error.name : "UnknownError",
        error_message: error instanceof Error ? error.message : "unknown",
      });
    }
  };

  runner.start();
  await scheduleOnce();
  const scheduleTimer = setInterval(() => {
    void scheduleOnce();
  }, config.scheduleIntervalMs);

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info("worker.shutdown_requested", {
      worker_id: config.workerId,
      signal,
      active_jobs: runner.activeJobs,
    });
    clearInterval(scheduleTimer);
    const stillRunning = await runner.stop();
    if (stillRunning.length > 0) {
      // These jobs keep their lease. Any worker marks them interrupted once it expires.
      logger.warn("worker.jobs_left_running", {
        worker_id: config.workerId,
        job_ids: stillRunning,
      });
    }
    logger.info("worker.stopped", {
      worker_id: config.workerId,
      counters: runner.counters,
    });
    process.exitCode = stillRunning.length > 0 ? 1 : 0;
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  process.stdout.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      event: "worker.start_failed",
      error_name: error instanceof Error ? error.name : "UnknownError",
      error_message: error instanceof Error ? error.message : "unknown",
    })}\n`,
  );
  process.exitCode = 1;
});
