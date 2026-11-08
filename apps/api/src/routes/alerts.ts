import { isUuid } from "@travelflow/domain";
import { AppError } from "../errors.js";
import { commandContext, writeJson } from "../http.js";
import { FixedWindowLimiter } from "../rate-limit.js";
import {
  SupabaseAlertRepository,
  SupabaseJobRepository,
} from "../repositories/alert-repository.js";
import {
  SupabaseActivityLogWriter,
  SupabaseIdempotencyStore,
} from "../repositories/domain-persistence.js";
import { SupabaseTripContextRepository } from "../repositories/trip-context-repository.js";
import { matchPath } from "../routing.js";
import { AlertService } from "../services/alert-service.js";
import { createAdminSupabaseClient } from "../supabase/client.js";
import type {
  AuthenticatedSession,
  RequestContext,
  RouteModule,
} from "./context.js";

const TRIPS = "/api/v1/trips";
const DEFAULT_JOB_LIMIT = 30;
const MAX_JOB_LIMIT = 100;

const rerunLimiter = new FixedWindowLimiter(10, 60_000);

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

function flag(context: RequestContext, name: string): boolean {
  const value = context.url.searchParams.get(name);
  if (value === null || value === "false") return false;
  if (value === "true") return true;
  throw new AppError(
    "REQUEST_INVALID",
    "validation",
    400,
    `${name} must be true or false.`,
  );
}

function buildService(
  context: RequestContext,
  session: AuthenticatedSession,
): AlertService {
  const { client } = session;
  return new AlertService({
    trips: new SupabaseTripContextRepository(client),
    alerts: new SupabaseAlertRepository(client),
    jobs: new SupabaseJobRepository(client, () =>
      createAdminSupabaseClient(context.config),
    ),
    idempotency: new SupabaseIdempotencyStore(client),
    activityLog: new SupabaseActivityLogWriter(client),
  });
}

async function drainBody(context: RequestContext): Promise<void> {
  // These actions carry no body. Anything sent is read and discarded.
  for await (const chunk of context.request) {
    void chunk;
  }
}

export const alertRoutes: RouteModule = async (context) => {
  const { method, request, response, requestId, url } = context;
  const path = url.pathname;

  const list = matchPath(path, `${TRIPS}/:tripId/alerts`);
  if (list && method === "GET") {
    const session = await context.authenticate();
    writeJson(
      response,
      200,
      await buildService(context, session).list({
        tripId: pathId(list.tripId, "Trip"),
        userId: session.user.id,
        requestId,
        includeDismissed: flag(context, "include_dismissed"),
        includeExpired: flag(context, "include_expired"),
      }),
    );
    return true;
  }

  const change = matchPath(
    path,
    `${TRIPS}/:tripId/alerts/:alertId/:action(read|dismiss)`,
  );
  if (change && method === "POST") {
    const session = await context.authenticate();
    await drainBody(context);
    writeJson(
      response,
      200,
      await buildService(context, session).changeState(
        {
          tripId: pathId(change.tripId, "Trip"),
          alertId: pathId(change.alertId, "Alert"),
          userId: session.user.id,
          requestId,
          to: change.action === "read" ? "read" : "dismissed",
        },
        commandContext(request, path, session.user.id, {}),
      ),
    );
    return true;
  }

  const jobs = matchPath(path, `${TRIPS}/:tripId/jobs`);
  if (jobs && method === "GET") {
    const session = await context.authenticate();
    const raw = url.searchParams.get("limit");
    const limit = raw === null ? DEFAULT_JOB_LIMIT : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_JOB_LIMIT) {
      throw new AppError(
        "REQUEST_INVALID",
        "validation",
        400,
        `limit must be an integer from 1 to ${MAX_JOB_LIMIT}.`,
      );
    }
    writeJson(
      response,
      200,
      await buildService(context, session).listJobs({
        tripId: pathId(jobs.tripId, "Trip"),
        userId: session.user.id,
        requestId,
        limit,
      }),
    );
    return true;
  }

  const rerun = matchPath(path, `${TRIPS}/:tripId/jobs/:jobId/rerun`);
  if (rerun && method === "POST") {
    const session = await context.authenticate();
    await drainBody(context);
    const wait = rerunLimiter.take(`${session.user.id}:rerun`);
    if (wait > 0) {
      context.response.setHeader("retry-after", String(wait));
      throw new AppError(
        "RATE_LIMITED",
        "validation",
        429,
        "Too many requests. Wait a moment and try again.",
        { retry_after_seconds: wait },
      );
    }
    writeJson(
      response,
      201,
      await buildService(context, session).rerunJob(
        {
          tripId: pathId(rerun.tripId, "Trip"),
          jobId: pathId(rerun.jobId, "Job"),
          userId: session.user.id,
          requestId,
        },
        commandContext(request, path, session.user.id, {}),
      ),
    );
    return true;
  }

  return false;
};
