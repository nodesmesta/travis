import { isUuid } from "@travelflow/domain";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiConfig } from "../config.js";
import { AppError } from "../errors.js";
import {
  bodyRecord,
  commandContext,
  readJsonBody,
  requiredString,
  writeJson,
} from "../http.js";
import type { Logger } from "../logger.js";
import { FixedWindowLimiter } from "../rate-limit.js";
import { SupabaseIdempotencyStore } from "../repositories/domain-persistence.js";
import {
  SupabaseInvoiceRepository,
  SupabaseInvoiceStorage,
} from "../repositories/invoice-repository.js";
import { matchPath } from "../routing.js";
import { InvoiceService } from "../services/invoice-service.js";
import { createAdminSupabaseClient } from "../supabase/client.js";
import type { Database } from "../supabase/database.types.js";
import { emailConfigured } from "@travelflow/integrations";
import type { RequestContext, RouteModule } from "./context.js";

const TRIPS = "/api/v1/trips";
const GENERATION_WAIT_MS = 10_000;

const emailLimiter = new FixedWindowLimiter(30, 60_000);

function pathId(value: string | undefined, label: string): string {
  if (!value || !isUuid(value)) {
    throw new AppError(
      "RESOURCE_NOT_FOUND",
      "not_found",
      404,
      `${label} was not found.`,
    );
  }
  return value;
}

export function emailSettingsOf(config: ApiConfig) {
  return {
    provider: config.emailProvider,
    from: config.emailFrom,
    timeoutMs: config.emailTimeoutMs,
    smtpHost: config.smtpHost,
    smtpPort: config.smtpPort,
    resendApiKey: config.emailProviderApiKey,
  };
}

export function buildInvoiceService(
  config: ApiConfig,
  logger: Logger,
  userClient: SupabaseClient<Database>,
): InvoiceService {
  const admin = createAdminSupabaseClient(config);
  return new InvoiceService({
    reads: new SupabaseInvoiceRepository(userClient),
    writes: new SupabaseInvoiceRepository(admin),
    storage: new SupabaseInvoiceStorage(admin),
    logger,
    emailConfigured: () => emailConfigured(emailSettingsOf(config)),
    generationWaitMs: GENERATION_WAIT_MS,
  });
}

/**
 * Queues the automatic `generate_invoice` job after a payment succeeded. A failure here
 * is logged and never changes the payment or the booking: the user can still generate the
 * invoice by hand. One job exists per payment, so calling this twice queues one.
 */
export async function queueInvoiceAfterPayment(
  config: ApiConfig,
  logger: Logger,
  bookingId: string,
  requestId: string,
): Promise<void> {
  if (!config.invoiceAutoGenerate) return;
  try {
    const repo = new SupabaseInvoiceRepository(
      createAdminSupabaseClient(config),
    );
    const queued = await repo.enqueueInvoiceGeneration(bookingId, requestId);
    logger.info("invoice.auto_generation_queued", {
      booking_id: bookingId,
      queued,
      request_id: requestId,
    });
  } catch (error) {
    logger.error("invoice.auto_generation_queue_failed", {
      booking_id: bookingId,
      request_id: requestId,
      error_code: error instanceof AppError ? error.code : "UNKNOWN",
    });
  }
}

function assertOnlyFields(
  body: Record<string, unknown>,
  allowed: string[],
): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      throw new AppError(
        "REQUEST_INVALID",
        "validation",
        400,
        `Unknown field "${key}".`,
      );
    }
  }
}

async function drainBody(context: RequestContext): Promise<void> {
  // These actions carry no body. Anything sent is read and discarded.
  for await (const chunk of context.request) {
    void chunk;
  }
}

export const invoiceRoutes: RouteModule = async (context) => {
  const { method, request, response, requestId, url, config, logger } = context;
  const path = url.pathname;

  const bookingInvoice = matchPath(
    path,
    `${TRIPS}/:tripId/bookings/:bookingId/invoice`,
  );
  if (bookingInvoice && method === "GET") {
    const session = await context.authenticate();
    const state = await buildInvoiceService(
      config,
      logger,
      session.client,
    ).getBookingInvoice(
      {
        tripId: pathId(bookingInvoice.tripId, "Trip"),
        userId: session.user.id,
      },
      pathId(bookingInvoice.bookingId, "Booking"),
    );
    writeJson(response, 200, { ...state, request_id: requestId });
    return true;
  }

  const generate = matchPath(
    path,
    `${TRIPS}/:tripId/bookings/:bookingId/invoice/generate`,
  );
  if (generate && method === "POST") {
    const session = await context.authenticate();
    await drainBody(context);
    const tripId = pathId(generate.tripId, "Trip");
    const bookingId = pathId(generate.bookingId, "Booking");
    const service = buildInvoiceService(config, logger, session.client);
    const result = await new SupabaseIdempotencyStore(session.client).execute(
      `invoice.generate:${bookingId}`,
      commandContext(request, path, session.user.id, {}),
      () => service.generate({ tripId, userId: session.user.id }, bookingId),
    );
    writeJson(response, result.created ? 201 : 200, {
      request_id: requestId,
      created: result.created,
      invoice: result.invoice,
    });
    return true;
  }

  const download = matchPath(
    path,
    `${TRIPS}/:tripId/invoices/:invoiceId/download`,
  );
  if (download && method === "GET") {
    const session = await context.authenticate();
    const { invoice, pdf } = await buildInvoiceService(
      config,
      logger,
      session.client,
    ).download(
      {
        tripId: pathId(download.tripId, "Trip"),
        userId: session.user.id,
      },
      pathId(download.invoiceId, "Invoice"),
    );
    response.writeHead(200, {
      "content-type": "application/pdf",
      "content-length": String(pdf.bytes.length),
      "content-disposition": `attachment; filename="invoice-${invoice.invoice_number}.pdf"`,
      "cache-control": "no-store",
      "x-content-sha256": pdf.sha256,
    });
    response.end(Buffer.from(pdf.bytes));
    return true;
  }

  const email = matchPath(path, `${TRIPS}/:tripId/invoices/:invoiceId/email`);
  if (email && method === "POST") {
    const session = await context.authenticate();
    const body = bodyRecord(await readJsonBody(request));
    assertOnlyFields(body, ["recipient_email"]);
    const recipient = requiredString(body, "recipient_email");
    const wait = emailLimiter.take(`${session.user.id}:invoice-email`);
    if (wait > 0) {
      response.setHeader("retry-after", String(wait));
      throw new AppError(
        "RATE_LIMITED",
        "validation",
        429,
        "Too many requests. Wait a moment and try again.",
        { retry_after_seconds: wait },
      );
    }
    const delivery = await buildInvoiceService(
      config,
      logger,
      session.client,
    ).requestEmail(
      {
        tripId: pathId(email.tripId, "Trip"),
        userId: session.user.id,
      },
      pathId(email.invoiceId, "Invoice"),
      recipient,
      commandContext(request, path, session.user.id, body),
      new SupabaseIdempotencyStore(session.client),
      requestId,
    );
    writeJson(response, 202, { request_id: requestId, delivery });
    return true;
  }

  const deliveries = matchPath(
    path,
    `${TRIPS}/:tripId/invoices/:invoiceId/email-deliveries`,
  );
  if (deliveries && method === "GET") {
    const session = await context.authenticate();
    const items = await buildInvoiceService(
      config,
      logger,
      session.client,
    ).listEmailDeliveries(
      {
        tripId: pathId(deliveries.tripId, "Trip"),
        userId: session.user.id,
      },
      pathId(deliveries.invoiceId, "Invoice"),
    );
    writeJson(response, 200, { request_id: requestId, items });
    return true;
  }

  return false;
};
