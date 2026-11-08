import {
  JobError,
  evaluateDepartureReminder,
  evaluateTrafficRisk,
  evaluateWeatherRisk,
  type AlertDecision,
  type ContextPointRecord,
  type ParsedJob,
} from "@travelflow/domain";
import type {
  BackgroundJobRow,
  DispatchOutcome,
  WeatherSnapshotRow,
} from "@travelflow/api/shared";
import type { AlertWriter } from "./alert-store.js";
import type { NewJob } from "./job-store.js";
import type { TripData } from "./trip-data.js";

/**
 * One handler per job type. A handler reads what it needs, calls the provider through
 * the shared mobility service or a pure rule, and returns what happened. It never
 * edits the itinerary: the only things it writes are snapshots, alerts, and follow-up jobs.
 * Failures are thrown as JobError (or anything `toJobError` understands); nothing is
 * swallowed and no result is made up.
 */

/** The two refresh operations of the shared mobility service that the worker uses. */
export interface MobilityPort {
  weatherFor(
    tripId: string,
    point: ContextPointRecord & { latitude: number; longitude: number },
  ): Promise<{ row: WeatherSnapshotRow; cache: "hit" | "miss" }>;
  refreshTraffic(input: {
    tripId: string;
    userId: string;
    requestId: string;
    journeyLegId: string;
  }): Promise<Record<string, unknown>>;
}

/** Task 11. The invoice and email services of the API, used by the two invoice jobs. */
export interface InvoicePort {
  generate(
    actor: { tripId: string; userId: string },
    bookingId: string,
  ): Promise<{
    created: boolean;
    invoice: {
      id: string;
      invoice_number: string;
      payment_id: string;
      pdf: { sha256: string } | null;
    };
  }>;
  dispatchEmail(
    deliveryId: string,
    actor: { tripId: string; userId: string },
  ): Promise<DispatchOutcome>;
}

export interface HandlerDeps {
  data: TripData;
  alerts: AlertWriter;
  mobility: MobilityPort;
  invoices: InvoicePort;
  contextPoint(id: string): Promise<ContextPointRecord | null>;
  now(): Date;
}

export interface HandlerContext {
  job: BackgroundJobRow;
  /** Throws when the lease was lost or the job timed out, so no side effect follows a lost job. */
  assertActive(): void;
}

export interface HandlerOutcome {
  result: Record<string, unknown>;
  providerRequestIds: string[];
  followUps: NewJob[];
}

interface Entry extends Record<string, unknown> {
  subject: {
    kind: "journey_leg" | "agenda_item" | "context_point";
    id: string;
  };
  decision: AlertDecision["decision"];
  reason_codes: string[];
}

async function requireLiveTrip(
  deps: HandlerDeps,
  job: BackgroundJobRow,
): Promise<void> {
  const trip = await deps.data.trip(job.trip_id);
  if (!trip) {
    throw new JobError("JOB_CONTEXT_NOT_FOUND", "The trip was not found.");
  }
  if (trip.status !== "confirmed" && trip.status !== "active") {
    throw new JobError(
      "JOB_PRECONDITION_FAILED",
      `The trip is ${trip.status}, so background checks are not run for it.`,
    );
  }
}

async function refreshWeather(
  deps: HandlerDeps,
  context: HandlerContext,
  contextPointId: string,
): Promise<HandlerOutcome> {
  const { job } = context;
  await requireLiveTrip(deps, job);
  const point = await deps.contextPoint(contextPointId);
  if (!point || point.tripId !== job.trip_id) {
    throw new JobError(
      "JOB_CONTEXT_NOT_FOUND",
      "The context point was not found in this trip.",
    );
  }
  if (
    point.status !== "active" ||
    point.resolutionStatus !== "resolved" ||
    point.latitude === null ||
    point.longitude === null
  ) {
    throw new JobError(
      "JOB_CONTEXT_UNRESOLVED",
      `"${point.label}" must be active and resolved before weather can be refreshed.`,
    );
  }
  context.assertActive();
  const { row, cache } = await deps.mobility.weatherFor(job.trip_id, {
    ...point,
    latitude: point.latitude,
    longitude: point.longitude,
  });
  return {
    result: {
      outcome: "snapshot_refreshed",
      context_point_id: contextPointId,
      weather_snapshot_id: row.id,
      source_id: row.source_id,
      provider: row.provider,
      cache_status: cache,
      retrieved_at: row.retrieved_at,
      expires_at: row.expires_at,
    },
    providerRequestIds:
      cache === "miss" ? await deps.data.providerRequestIds(row.source_id) : [],
    followUps: [
      {
        tripId: job.trip_id,
        userId: job.user_id,
        jobType: "evaluate_alerts",
        payload: {
          trigger_job_id: job.id,
          journey_leg_id: null,
          context_point_id: contextPointId,
        },
        idempotencyKey: `evaluate_alerts:${job.id}`,
        runAt: deps.now().toISOString(),
        correlationId: job.correlation_id,
      },
    ],
  };
}

async function refreshTraffic(
  deps: HandlerDeps,
  context: HandlerContext,
  journeyLegId: string,
): Promise<HandlerOutcome> {
  const { job } = context;
  await requireLiveTrip(deps, job);
  const [leg] = await deps.data.legs(job.trip_id, journeyLegId);
  if (!leg) {
    throw new JobError(
      "JOB_CONTEXT_NOT_FOUND",
      "The journey leg was not found in this trip.",
    );
  }
  if (leg.status !== "planned" && leg.status !== "in_progress") {
    throw new JobError(
      "JOB_PRECONDITION_FAILED",
      `The journey leg is ${leg.status}, so traffic is not refreshed.`,
    );
  }
  context.assertActive();
  const response = await deps.mobility.refreshTraffic({
    tripId: job.trip_id,
    userId: job.user_id,
    requestId: job.correlation_id,
    journeyLegId,
  });
  const items = Array.isArray(response.items) ? response.items : [];
  const snapshot = (items[0] ?? {}) as Record<string, unknown>;
  const sourceId =
    typeof snapshot.source_id === "string" ? snapshot.source_id : null;
  return {
    result: {
      outcome: "snapshot_refreshed",
      journey_leg_id: journeyLegId,
      traffic_snapshot_id: snapshot.id ?? null,
      source_id: sourceId,
      provider: snapshot.provider ?? null,
      cache_status: snapshot.cache_status ?? null,
      traffic_level: snapshot.traffic_level ?? null,
      retrieved_at: snapshot.retrieved_at ?? null,
      expires_at: snapshot.expires_at ?? null,
    },
    providerRequestIds:
      snapshot.cache_status === "miss" && sourceId
        ? await deps.data.providerRequestIds(sourceId)
        : [],
    followUps: [
      {
        tripId: job.trip_id,
        userId: job.user_id,
        jobType: "evaluate_alerts",
        payload: {
          trigger_job_id: job.id,
          journey_leg_id: journeyLegId,
          context_point_id: null,
        },
        idempotencyKey: `evaluate_alerts:${job.id}`,
        runAt: deps.now().toISOString(),
        correlationId: job.correlation_id,
      },
    ],
  };
}

async function record(
  deps: HandlerDeps,
  context: HandlerContext,
  subject: Entry["subject"],
  decision: AlertDecision,
  tally: { created: number; deduplicated: number },
): Promise<Entry> {
  if (decision.decision === "create_alert") {
    context.assertActive();
    const written = await deps.alerts.create({
      tripId: context.job.trip_id,
      jobId: context.job.id,
      draft: decision.alert,
      now: deps.now(),
    });
    if (written.created) tally.created += 1;
    else tally.deduplicated += 1;
    return {
      subject,
      decision: decision.decision,
      reason_codes: decision.alert.reason_codes,
      alert_id: written.alertId,
      alert_type: decision.alert.alert_type,
      severity: decision.alert.severity,
      created: written.created,
      evidence_refreshed: written.refreshed,
    };
  }
  return {
    subject,
    decision: decision.decision,
    reason_codes: decision.reason_codes,
    summary: decision.summary,
    ...(decision.decision === "blocked"
      ? { error_code: decision.error_code }
      : {}),
  };
}

/** Turns the entries into the job result. A blocked rule fails the job; alerts already saved stay saved. */
function summarize(
  entries: Entry[],
  tally: { created: number; deduplicated: number },
): Record<string, unknown> {
  const blocked = entries.filter((entry) => entry.decision === "blocked");
  const outcome =
    blocked.length > 0
      ? "blocked"
      : tally.created > 0
        ? "alert_created"
        : tally.deduplicated > 0
          ? "alert_deduplicated"
          : "no_action";
  const summary = {
    outcome,
    alerts_created: tally.created,
    alerts_deduplicated: tally.deduplicated,
    evaluated: entries,
  };
  if (blocked.length > 0) {
    const expired = blocked.some(
      (entry) => entry.error_code === "JOB_PROVIDER_DATA_EXPIRED",
    );
    throw new JobError(
      expired ? "JOB_PROVIDER_DATA_EXPIRED" : "JOB_PRECONDITION_FAILED",
      expired
        ? "A required snapshot has expired, so no alert was created from it."
        : "A required snapshot is missing, so no alert was created for it.",
      summary,
    );
  }
  return summary;
}

async function evaluateAlerts(
  deps: HandlerDeps,
  context: HandlerContext,
  scope: { journeyLegId: string | null; contextPointId: string | null },
): Promise<HandlerOutcome> {
  const { job } = context;
  await requireLiveTrip(deps, job);
  const now = deps.now();
  const entries: Entry[] = [];
  const tally = { created: 0, deduplicated: 0 };

  if (scope.journeyLegId) {
    const [leg] = await deps.data.legs(job.trip_id, scope.journeyLegId);
    if (!leg) {
      throw new JobError(
        "JOB_CONTEXT_NOT_FOUND",
        "The journey leg was not found in this trip.",
      );
    }
    const snapshot = await deps.data.latestTraffic(
      job.trip_id,
      leg.origin_context_point_id,
      leg.destination_context_point_id,
    );
    const decision = evaluateTrafficRisk({ leg, snapshot }, { now });
    entries.push(
      await record(
        deps,
        context,
        { kind: "journey_leg", id: leg.id },
        decision,
        tally,
      ),
    );
  }

  if (scope.contextPointId) {
    const items = (
      await deps.data.agenda(job.trip_id, scope.contextPointId)
    ).filter(
      (item) =>
        (item.status === "planned" || item.status === "confirmed") &&
        (item.exposure === "outdoor" || item.exposure === "both"),
    );
    const snapshot = await deps.data.latestWeather(
      job.trip_id,
      scope.contextPointId,
    );
    for (const agenda of items) {
      const decision = evaluateWeatherRisk({ agenda, snapshot }, { now });
      entries.push(
        await record(
          deps,
          context,
          { kind: "agenda_item", id: agenda.id },
          decision,
          tally,
        ),
      );
    }
    if (items.length === 0) {
      entries.push({
        subject: { kind: "context_point", id: scope.contextPointId },
        decision: "no_action",
        reason_codes: ["NO_OUTDOOR_AGENDA_AT_LOCATION"],
        summary:
          "No planned outdoor agenda item uses this location, so weather was not evaluated.",
      });
    }
  }

  return {
    result: summarize(entries, tally),
    providerRequestIds: [],
    followUps: [],
  };
}

async function departureReminder(
  deps: HandlerDeps,
  context: HandlerContext,
  payload: { journeyLegId: string; departureAt: string },
): Promise<HandlerOutcome> {
  const { job } = context;
  await requireLiveTrip(deps, job);
  const [leg] = await deps.data.legs(job.trip_id, payload.journeyLegId);
  if (!leg) {
    throw new JobError(
      "JOB_CONTEXT_NOT_FOUND",
      "The journey leg was not found in this trip.",
    );
  }
  const decision = evaluateDepartureReminder(
    { leg, plannedDepartureAt: payload.departureAt },
    { now: deps.now() },
  );
  const tally = { created: 0, deduplicated: 0 };
  const entry = await record(
    deps,
    context,
    { kind: "journey_leg", id: leg.id },
    decision,
    tally,
  );
  return {
    result: summarize([entry], tally),
    providerRequestIds: [],
    followUps: [],
  };
}

async function generateInvoice(
  deps: HandlerDeps,
  context: HandlerContext,
  payload: { bookingId: string; paymentId: string },
): Promise<HandlerOutcome> {
  const { job } = context;
  context.assertActive();
  const { created, invoice } = await deps.invoices.generate(
    { tripId: job.trip_id, userId: job.user_id },
    payload.bookingId,
  );
  if (invoice.payment_id !== payload.paymentId) {
    throw new JobError(
      "JOB_PRECONDITION_FAILED",
      "The invoice of this booking belongs to a different payment than the job names.",
    );
  }
  return {
    result: {
      outcome: created ? "invoice_issued" : "invoice_exists",
      booking_id: payload.bookingId,
      payment_id: payload.paymentId,
      invoice_id: invoice.id,
      invoice_number: invoice.invoice_number,
      pdf_sha256: invoice.pdf?.sha256 ?? null,
    },
    providerRequestIds: [],
    followUps: [],
  };
}

async function sendInvoiceEmail(
  deps: HandlerDeps,
  context: HandlerContext,
  deliveryId: string,
): Promise<HandlerOutcome> {
  const { job } = context;
  context.assertActive();
  const dispatched = await deps.invoices.dispatchEmail(deliveryId, {
    tripId: job.trip_id,
    userId: job.user_id,
  });
  const { delivery } = dispatched;
  const base = {
    email_delivery_id: delivery.id,
    invoice_id: delivery.invoice_id,
    sequence: delivery.sequence,
    provider: delivery.provider,
  };
  switch (dispatched.outcome) {
    case "sent":
      return {
        result: {
          outcome: "email_sent",
          ...base,
          provider_message_id: delivery.provider_message_id,
        },
        providerRequestIds: delivery.provider_message_id
          ? [delivery.provider_message_id]
          : [],
        followUps: [],
      };
    case "already_sent":
      // A duplicate job: the message already left, so nothing is sent again.
      return {
        result: {
          outcome: "email_already_sent",
          ...base,
          provider_message_id: delivery.provider_message_id,
        },
        providerRequestIds: [],
        followUps: [],
      };
    case "not_pending":
      throw new JobError(
        "JOB_PRECONDITION_FAILED",
        "This delivery was already attempted, so it was not sent again.",
        { ...base, delivery_status: delivery.status },
      );
    case "failed":
      throw new JobError(
        "JOB_PROVIDER_ERROR",
        delivery.error_message ?? "The email could not be delivered.",
        { ...base, provider_error_code: delivery.error_code },
      );
  }
}

export async function runHandler(
  deps: HandlerDeps,
  context: HandlerContext,
  parsed: ParsedJob,
): Promise<HandlerOutcome> {
  switch (parsed.job_type) {
    case "generate_invoice":
      return generateInvoice(deps, context, {
        bookingId: parsed.payload.booking_id,
        paymentId: parsed.payload.payment_id,
      });
    case "send_invoice_email":
      return sendInvoiceEmail(deps, context, parsed.payload.email_delivery_id);
    case "refresh_weather":
      return refreshWeather(deps, context, parsed.payload.context_point_id);
    case "refresh_traffic":
      return refreshTraffic(deps, context, parsed.payload.journey_leg_id);
    case "evaluate_alerts":
      return evaluateAlerts(deps, context, {
        journeyLegId: parsed.payload.journey_leg_id,
        contextPointId: parsed.payload.context_point_id,
      });
    case "departure_reminder":
      return departureReminder(deps, context, {
        journeyLegId: parsed.payload.journey_leg_id,
        departureAt: parsed.payload.departure_at,
      });
  }
}
