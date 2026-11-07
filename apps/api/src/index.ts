import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHash, randomUUID } from "node:crypto";
import {
  ExternalDataError,
  BrightDataClient,
  EventClaimExtractor,
  EventDiscoveryPipeline,
  VultrInferenceClient,
} from "@travelflow/integrations";
import {
  DomainInvariantError,
  TripContextService,
  type AgendaItemRecord,
  type CommandContext,
  type ContextPointRecord,
  type CreateAgendaItemInput,
  type CreateContextPointInput,
  type CreateJourneyLegInput,
  type JourneyLegRecord,
  type ResolveContextPointInput,
} from "@travelflow/domain";
import {
  createAuthVerifier,
  extractBearerToken,
  requireAuthenticatedUser,
  type AuthVerifier,
  type AuthenticatedUser,
} from "./auth.js";
import { brightDataConfigFrom } from "./bright-data-config.js";
import { loadConfig } from "./config.js";
import { Metrics, routeLabel } from "./metrics.js";
import { checkReadiness, supabaseProbes } from "./readiness.js";
import {
  assertOptionalIsoDate,
  assertOptionalTripDateTime,
  assertTimezone,
  bodyRecord,
  commandContext,
  isRecord,
  normalizeDomainError,
  optionalString,
  readJsonBody,
  requiredNumber,
  requiredString,
  writeJson,
} from "./http.js";
import { matchPath } from "./routing.js";
import { routeModules } from "./routes/index.js";
import { queueInvoiceAfterPayment } from "./routes/invoices.js";
import type { AuthenticatedSession, RequestContext } from "./routes/context.js";
import { AppError, writeError } from "./errors.js";
import { createLogger } from "./logger.js";
import {
  SupabaseTripContextRepository,
  type TripUpdate,
} from "./repositories/trip-context-repository.js";
import {
  SupabaseActivityLogWriter,
  SupabaseIdempotencyStore,
} from "./repositories/domain-persistence.js";
import { createUserSupabaseClient } from "./supabase/client.js";
import { SupabaseEventDiscoveryRepository } from "./repositories/event-discovery-repository.js";
import { SupabaseBookingPaymentRepository } from "./repositories/booking-payment-repository.js";
import {
  BookingPaymentService,
  type CreateBookingInput,
} from "./services/booking-payment-service.js";
import {
  EventDiscoveryService,
  type DiscoverEventsRequest,
} from "./services/event-discovery-service.js";
import type {
  AgendaItem,
  Booking,
  ContextPoint,
  JourneyLeg,
  Payment,
  Trip,
} from "./supabase/database.types.js";

const config = loadConfig();
const logger = createLogger(config.logLevel);
const serviceName = "travelflow-api";
const metrics = new Metrics();
const readinessProbes = supabaseProbes(config);
const authVerifier: AuthVerifier | undefined =
  config.supabaseUrl && config.supabaseServiceRoleKey
    ? createAuthVerifier({
        supabaseUrl: config.supabaseUrl,
        supabaseServiceRoleKey: config.supabaseServiceRoleKey,
      })
    : undefined;

function requestIdFrom(request: IncomingMessage): string {
  const supplied = request.headers["x-request-id"];
  if (
    typeof supplied === "string" &&
    supplied.length > 0 &&
    supplied.length <= 120
  ) {
    return supplied;
  }
  return randomUUID();
}

function serializedTrip(trip: Trip): Record<string, unknown> {
  return {
    id: trip.id,
    user_id: trip.user_id,
    name: trip.name,
    destination_summary: trip.destination_summary,
    start_at: trip.start_at,
    end_at: trip.end_at,
    timezone: trip.timezone,
    status: trip.status,
    source: trip.source,
    created_at: trip.created_at,
    updated_at: trip.updated_at,
  };
}

function serializedBooking(booking: Booking): Record<string, unknown> {
  return {
    id: booking.id,
    user_id: booking.user_id,
    trip_id: booking.trip_id,
    booking_type: booking.booking_type,
    source_type: booking.source_type,
    source_id: booking.source_id,
    provider_name: booking.provider_name,
    ...(booking.confirmation_code
      ? { confirmation_code: booking.confirmation_code }
      : {}),
    status: booking.status,
    currency: booking.currency,
    subtotal: booking.subtotal,
    tax: booking.tax,
    total: booking.total,
    pricing_policy: booking.pricing_policy,
    ...(booking.starts_at ? { starts_at: booking.starts_at } : {}),
    ...(booking.ends_at ? { ends_at: booking.ends_at } : {}),
    ...(booking.cancelled_at ? { cancelled_at: booking.cancelled_at } : {}),
    created_at: booking.created_at,
    updated_at: booking.updated_at,
  };
}

function serializedPayment(payment: Payment): Record<string, unknown> {
  return {
    id: payment.id,
    booking_id: payment.booking_id,
    payment_reference: payment.payment_reference,
    provider: payment.provider,
    mode: payment.mode,
    amount: payment.amount,
    currency: payment.currency,
    status: payment.status,
    ...(payment.paid_at ? { paid_at: payment.paid_at } : {}),
    ...(payment.failed_at ? { failed_at: payment.failed_at } : {}),
    ...(payment.failure_code ? { failure_code: payment.failure_code } : {}),
    created_at: payment.created_at,
    updated_at: payment.updated_at,
  };
}

function serializedContextPoint(
  contextPoint: ContextPoint,
): Record<string, unknown> {
  return {
    id: contextPoint.id,
    trip_id: contextPoint.trip_id,
    type: contextPoint.type,
    label: contextPoint.label,
    address: contextPoint.address,
    latitude: contextPoint.latitude,
    longitude: contextPoint.longitude,
    timezone: contextPoint.timezone,
    external_place_id: contextPoint.external_place_id,
    status: contextPoint.status,
    resolution_status: contextPoint.resolution_status,
    source: contextPoint.source,
    confirmation_status: contextPoint.confirmation_status,
    metadata: contextPoint.metadata,
    created_at: contextPoint.created_at,
    updated_at: contextPoint.updated_at,
  };
}

function serializedContextPointRecord(
  contextPoint: ContextPointRecord,
): Record<string, unknown> {
  return {
    id: contextPoint.id,
    trip_id: contextPoint.tripId,
    type: contextPoint.type,
    label: contextPoint.label,
    address: contextPoint.address,
    latitude: contextPoint.latitude,
    longitude: contextPoint.longitude,
    timezone: contextPoint.timezone,
    external_place_id: contextPoint.externalPlaceId,
    status: contextPoint.status,
    resolution_status: contextPoint.resolutionStatus,
    confirmation_status: contextPoint.confirmationStatus,
    source: contextPoint.source,
    metadata: contextPoint.metadata,
  };
}

function serializedAgendaItem(
  agenda: AgendaItem | AgendaItemRecord,
): Record<string, unknown> {
  const item =
    "trip_id" in agenda
      ? {
          id: agenda.id,
          tripId: agenda.trip_id,
          contextPointId: agenda.context_point_id,
          title: agenda.title,
          type: agenda.type,
          startAt: agenda.start_at,
          endAt: agenda.end_at,
          timezone: agenda.timezone,
          status: agenda.status,
          source: agenda.source,
          metadata: agenda.metadata,
        }
      : agenda;
  return {
    id: item.id,
    trip_id: item.tripId,
    context_point_id: item.contextPointId,
    title: item.title,
    type: item.type,
    start_at: item.startAt,
    end_at: item.endAt,
    timezone: item.timezone,
    status: item.status,
    source: item.source,
    metadata: item.metadata,
  };
}

function serializedJourneyLeg(
  leg: JourneyLeg | JourneyLegRecord,
): Record<string, unknown> {
  const item =
    "trip_id" in leg
      ? {
          id: leg.id,
          tripId: leg.trip_id,
          originContextPointId: leg.origin_context_point_id,
          destinationContextPointId: leg.destination_context_point_id,
          relatedAgendaId: leg.related_agenda_id,
          departureAt: leg.departure_at,
          arrivalDeadline: leg.arrival_deadline,
          status: leg.status,
        }
      : leg;
  return {
    id: item.id,
    trip_id: item.tripId,
    origin_context_point_id: item.originContextPointId,
    destination_context_point_id: item.destinationContextPointId,
    related_agenda_id: item.relatedAgendaId,
    departure_at: item.departureAt,
    arrival_deadline: item.arrivalDeadline,
    status: item.status,
  };
}

function requireAuthVerifier(): AuthVerifier {
  if (!authVerifier) {
    throw new AppError(
      "AUTH_CONFIGURATION_MISSING",
      "internal",
      503,
      "Authentication service is not configured.",
    );
  }
  return authVerifier;
}

async function authenticateRequest(
  request: IncomingMessage,
): Promise<AuthenticatedSession> {
  const verifier = requireAuthVerifier();
  const authorization = request.headers.authorization;
  const accessToken = extractBearerToken(
    Array.isArray(authorization) ? authorization[0] : authorization,
  );
  const user = await verifier.verifyAccessToken(accessToken);
  const client = createUserSupabaseClient(
    {
      supabaseUrl: config.supabaseUrl,
      supabaseAnonKey: config.supabaseAnonKey,
      supabaseServiceRoleKey: config.supabaseServiceRoleKey,
    },
    accessToken,
  );
  return { user, accessToken, client };
}

async function authenticatedRepository(request: IncomingMessage): Promise<{
  user: AuthenticatedUser;
  repository: SupabaseTripContextRepository;
  service: TripContextService;
  eventDiscovery: EventDiscoveryService;
  commerce: BookingPaymentService;
  bookingRepository: SupabaseBookingPaymentRepository;
}> {
  const verifier = requireAuthVerifier();
  const authorization = request.headers.authorization;
  const accessToken = extractBearerToken(
    Array.isArray(authorization) ? authorization[0] : authorization,
  );
  const user = await verifier.verifyAccessToken(accessToken);
  const client = createUserSupabaseClient(
    {
      supabaseUrl: config.supabaseUrl,
      supabaseAnonKey: config.supabaseAnonKey,
      supabaseServiceRoleKey: config.supabaseServiceRoleKey,
    },
    accessToken,
  );
  const repository = new SupabaseTripContextRepository(client);
  const eventDiscoveryRepository = new SupabaseEventDiscoveryRepository(client);
  const bookingPaymentRepository = new SupabaseBookingPaymentRepository(client);
  return {
    user,
    repository,
    service: new TripContextService({
      repository,
      idempotency: new SupabaseIdempotencyStore(client),
      activityLog: new SupabaseActivityLogWriter(client),
    }),
    eventDiscovery: new EventDiscoveryService(
      repository,
      eventDiscoveryRepository,
      new EventDiscoveryPipeline(
        new BrightDataClient(brightDataConfigFrom(config)),
        new EventClaimExtractor(
          new VultrInferenceClient({
            baseUrl: config.vultrInferenceBaseUrl,
            apiKey: config.vultrInferenceApiKey,
            model: config.vultrInferenceModel,
            timeoutMs: config.aiExtractionTimeoutMs,
          }),
        ),
        {
          maxPages: config.eventMaxPages,
          pageMaxChars: config.eventPageMaxChars,
          pageConcurrency: config.eventPageConcurrency,
        },
      ),
      config.eventDiscoveryTtlHours,
    ),
    commerce: new BookingPaymentService(
      repository,
      bookingPaymentRepository,
      new SupabaseIdempotencyStore(client),
      new SupabaseActivityLogWriter(client),
    ),
    bookingRepository: bookingPaymentRepository,
  };
}

const TRIPS = "/api/v1/trips";

function tripIdFromPath(pathname: string): string | null {
  return matchPath(pathname, `${TRIPS}/:tripId`)?.tripId ?? null;
}

function contextPointsTripIdFromPath(pathname: string): string | null {
  return matchPath(pathname, `${TRIPS}/:tripId/context-points`)?.tripId ?? null;
}

function contextPointCommandFromPath(
  pathname: string,
): { tripId: string; contextPointId: string; action: string } | null {
  const params = matchPath(
    pathname,
    `${TRIPS}/:tripId/context-points/:contextPointId/:action(resolve|confirm|archive)`,
  );
  if (!params) return null;
  return {
    tripId: params.tripId as string,
    contextPointId: params.contextPointId as string,
    action: params.action as string,
  };
}

function agendaTripIdFromPath(pathname: string): string | null {
  return matchPath(pathname, `${TRIPS}/:tripId/agenda-items`)?.tripId ?? null;
}

function agendaCommandFromPath(
  pathname: string,
): { tripId: string; agendaItemId: string; action: string } | null {
  const params = matchPath(
    pathname,
    `${TRIPS}/:tripId/agenda-items/:agendaItemId/:action(plan|confirm|cancel|complete)`,
  );
  if (!params) return null;
  return {
    tripId: params.tripId as string,
    agendaItemId: params.agendaItemId as string,
    action: params.action as string,
  };
}

function journeyLegsTripIdFromPath(pathname: string): string | null {
  return matchPath(pathname, `${TRIPS}/:tripId/journey-legs`)?.tripId ?? null;
}

function journeyLegCommandFromPath(
  pathname: string,
): { tripId: string; journeyLegId: string; action: string } | null {
  const params = matchPath(
    pathname,
    `${TRIPS}/:tripId/journey-legs/:journeyLegId/:action(start|complete|cancel)`,
  );
  if (!params) return null;
  return {
    tripId: params.tripId as string,
    journeyLegId: params.journeyLegId as string,
    action: params.action as string,
  };
}

function bookingsTripIdFromPath(pathname: string): string | null {
  return matchPath(pathname, `${TRIPS}/:tripId/bookings`)?.tripId ?? null;
}

function bookingDetailFromPath(
  pathname: string,
): { tripId: string; bookingId: string } | null {
  const params = matchPath(pathname, `${TRIPS}/:tripId/bookings/:bookingId`);
  if (!params) return null;
  return {
    tripId: params.tripId as string,
    bookingId: params.bookingId as string,
  };
}

function paymentCollectionFromPath(
  pathname: string,
): { tripId: string; bookingId: string } | null {
  const params = matchPath(
    pathname,
    `${TRIPS}/:tripId/bookings/:bookingId/payments`,
  );
  if (!params) return null;
  return {
    tripId: params.tripId as string,
    bookingId: params.bookingId as string,
  };
}

function refundPaymentFromPath(
  pathname: string,
): { tripId: string; bookingId: string; paymentId: string } | null {
  const params = matchPath(
    pathname,
    `${TRIPS}/:tripId/bookings/:bookingId/payments/:paymentId/refund`,
  );
  if (!params) return null;
  return {
    tripId: params.tripId as string,
    bookingId: params.bookingId as string,
    paymentId: params.paymentId as string,
  };
}

function eventDiscoveriesTripIdFromPath(pathname: string): string | null {
  return (
    matchPath(pathname, `${TRIPS}/:tripId/event-discoveries`)?.tripId ?? null
  );
}

function tripTransitionFromPath(pathname: string): string | null {
  return matchPath(pathname, `${TRIPS}/:tripId/transition`)?.tripId ?? null;
}

function parseContextPointInput(
  tripId: string,
  body: unknown,
): CreateContextPointInput {
  const input = bodyRecord(body);
  const type = requiredString(input, "type");
  const allowedTypes = new Set([
    "airport",
    "station",
    "hotel",
    "meeting",
    "conference",
    "event",
    "restaurant",
    "attraction",
    "custom_location",
  ]);
  if (!allowedTypes.has(type)) {
    throw new AppError(
      "REQUEST_INVALID",
      "validation",
      400,
      "type is invalid.",
    );
  }
  const latitude = input.latitude;
  const longitude = input.longitude;
  if (
    latitude !== undefined &&
    (typeof latitude !== "number" || !Number.isFinite(latitude))
  ) {
    throw new AppError(
      "REQUEST_INVALID",
      "validation",
      400,
      "latitude is invalid.",
    );
  }
  if (
    longitude !== undefined &&
    (typeof longitude !== "number" || !Number.isFinite(longitude))
  ) {
    throw new AppError(
      "REQUEST_INVALID",
      "validation",
      400,
      "longitude is invalid.",
    );
  }
  const result: CreateContextPointInput = {
    tripId,
    type: type as CreateContextPointInput["type"],
    label: requiredString(input, "label"),
    timezone: requiredString(input, "timezone"),
    source: "user_input",
  };
  const address = optionalString(input, "address");
  const externalPlaceId = optionalString(input, "external_place_id");
  if (address !== undefined) result.address = address;
  if (externalPlaceId !== undefined) result.externalPlaceId = externalPlaceId;
  if (typeof latitude === "number") result.latitude = latitude;
  if (typeof longitude === "number") result.longitude = longitude;
  return result;
}

function parseResolveContextPointInput(
  body: unknown,
): ResolveContextPointInput {
  const input = bodyRecord(body);
  const latitude = input.latitude;
  const longitude = input.longitude;
  if (typeof latitude !== "number" || typeof longitude !== "number") {
    throw new AppError(
      "REQUEST_INVALID",
      "validation",
      400,
      "latitude and longitude are required numbers.",
    );
  }
  const result: ResolveContextPointInput = {
    latitude,
    longitude,
    timezone: requiredString(input, "timezone"),
    externalPlaceId: requiredString(input, "external_place_id"),
  };
  const label = optionalString(input, "label");
  const address = optionalString(input, "address");
  if (label !== undefined) result.label = label;
  if (address !== undefined) result.address = address;
  return result;
}

function parseAgendaInput(
  tripId: string,
  body: unknown,
): CreateAgendaItemInput {
  const input = bodyRecord(body);
  const type = requiredString(input, "type");
  const source = (optionalString(input, "source") ??
    "user_input") as CreateAgendaItemInput["source"];
  const allowedTypes = new Set([
    "flight",
    "train",
    "meeting",
    "conference",
    "event",
    "meal",
    "hotel_check_in",
    "hotel_check_out",
    "free_time",
    "custom",
  ]);
  const allowedSources = new Set([
    "user_input",
    "booking_import",
    "assistant_suggestion",
    "event_discovery",
    "external_provider",
  ]);
  if (!allowedTypes.has(type) || !allowedSources.has(source)) {
    throw new AppError(
      "REQUEST_INVALID",
      "validation",
      400,
      "Agenda type or source is invalid.",
    );
  }
  const result: CreateAgendaItemInput = {
    tripId,
    title: requiredString(input, "title"),
    type: type as CreateAgendaItemInput["type"],
    startAt: requiredString(input, "start_at"),
    endAt: requiredString(input, "end_at"),
    timezone: requiredString(input, "timezone"),
    source,
  };
  const contextPointId = optionalString(input, "context_point_id");
  if (contextPointId !== undefined) result.contextPointId = contextPointId;
  return result;
}

function parseJourneyLegInput(
  tripId: string,
  body: unknown,
): CreateJourneyLegInput {
  const input = bodyRecord(body);
  const result: CreateJourneyLegInput = {
    tripId,
    originContextPointId: requiredString(input, "origin_context_point_id"),
    destinationContextPointId: requiredString(
      input,
      "destination_context_point_id",
    ),
    departureAt: requiredString(input, "departure_at"),
  };
  const relatedAgendaId = optionalString(input, "related_agenda_id");
  const arrivalDeadline = optionalString(input, "arrival_deadline");
  if (relatedAgendaId !== undefined) result.relatedAgendaId = relatedAgendaId;
  if (arrivalDeadline !== undefined) result.arrivalDeadline = arrivalDeadline;
  return result;
}

function parseEventDiscoveryInput(
  tripId: string,
  userId: string,
  requestId: string,
  body: unknown,
): DiscoverEventsRequest {
  const input = bodyRecord(body);
  const observedFor = bodyRecord(input.observed_for);
  const filters = bodyRecord(input.filters);
  const contextPointId = requiredString(input, "context_point_id");
  const category = requiredString(filters, "category");
  const result: DiscoverEventsRequest = {
    requestId,
    executionId: randomUUID(),
    userId,
    tripId,
    contextPointId,
    observedFor: {
      from: requiredString(observedFor, "from"),
      to: requiredString(observedFor, "to"),
      timezone: requiredString(observedFor, "timezone"),
    },
    category,
  };
  const radiusPreference = optionalString(filters, "radius_preference");
  const language = optionalString(filters, "language");
  if (radiusPreference !== undefined)
    result.radiusPreference = radiusPreference;
  if (language !== undefined) result.language = language;
  return result;
}

function parseCreateBookingInput(
  tripId: string,
  userId: string,
  body: unknown,
): CreateBookingInput {
  const input = bodyRecord(body);
  const allowedFields = new Set([
    "booking_type",
    "source_type",
    "source_id",
    "starts_at",
    "ends_at",
  ]);
  const unknownField = Object.keys(input).find(
    (key) => !allowedFields.has(key),
  );
  if (unknownField) {
    throw new AppError(
      "BOOKING_INVALID",
      "validation",
      400,
      `Booking field is not supported: ${unknownField}.`,
    );
  }
  const bookingType = requiredString(input, "booking_type");
  const sourceType = requiredString(input, "source_type");
  if (!["event", "activity", "itinerary_item"].includes(bookingType)) {
    throw new AppError(
      "BOOKING_INVALID",
      "validation",
      400,
      "booking_type is invalid.",
    );
  }
  if (
    !["event_discovery_result", "activity", "agenda_item"].includes(sourceType)
  ) {
    throw new AppError(
      "BOOKING_INVALID",
      "validation",
      400,
      "source_type is invalid.",
    );
  }
  const startsAt =
    input.starts_at === undefined
      ? null
      : assertOptionalIsoDate(input.starts_at, "starts_at");
  const endsAt =
    input.ends_at === undefined
      ? null
      : assertOptionalIsoDate(input.ends_at, "ends_at");
  if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) {
    throw new AppError(
      "BOOKING_INVALID",
      "validation",
      400,
      "ends_at must be after starts_at.",
    );
  }
  return {
    tripId,
    userId,
    bookingType: bookingType as CreateBookingInput["bookingType"],
    sourceType: sourceType as CreateBookingInput["sourceType"],
    sourceId: requiredString(input, "source_id"),
    startsAt,
    endsAt,
  };
}

function parsePaymentInput(body: unknown): {
  outcome: string;
  failureCode: string | null;
} {
  const input = bodyRecord(body);
  const allowedFields = new Set(["outcome", "failure_code"]);
  const unknownField = Object.keys(input).find(
    (key) => !allowedFields.has(key),
  );
  if (unknownField) {
    throw new AppError(
      "PAYMENT_INVALID",
      "validation",
      400,
      `Payment field is not supported: ${unknownField}.`,
    );
  }
  const outcome = requiredString(input, "outcome");
  if (!["succeeded", "failed", "pending", "cancelled"].includes(outcome)) {
    throw new AppError(
      "PAYMENT_SIMULATION_INVALID",
      "validation",
      400,
      "outcome is invalid.",
    );
  }
  return {
    outcome,
    failureCode: optionalString(input, "failure_code") ?? null,
  };
}

function parseTripUpdate(body: unknown): TripUpdate {
  if (!isRecord(body)) {
    throw new AppError(
      "TRIP_INVALID",
      "validation",
      400,
      "Trip update must be a JSON object.",
    );
  }

  const allowed = new Set([
    "name",
    "destination_summary",
    "start_at",
    "end_at",
    "timezone",
  ]);
  const unknownField = Object.keys(body).find((key) => !allowed.has(key));
  if (unknownField) {
    throw new AppError(
      "TRIP_INVALID",
      "validation",
      400,
      `Trip field is not editable: ${unknownField}.`,
    );
  }
  if (Object.keys(body).length === 0) {
    throw new AppError(
      "TRIP_INVALID",
      "validation",
      400,
      "At least one trip field is required.",
    );
  }

  const patch: TripUpdate = {};
  if ("name" in body) {
    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      throw new AppError(
        "TRIP_INVALID",
        "validation",
        400,
        "name must be a non-blank string.",
      );
    }
    patch.name = body.name.trim();
  }
  if ("destination_summary" in body) {
    if (
      body.destination_summary !== null &&
      typeof body.destination_summary !== "string"
    ) {
      throw new AppError(
        "TRIP_INVALID",
        "validation",
        400,
        "destination_summary must be a string or null.",
      );
    }
    patch.destination_summary = body.destination_summary;
  }
  if ("start_at" in body) {
    patch.start_at = assertOptionalTripDateTime(body.start_at, "start_at");
  }
  if ("end_at" in body) {
    patch.end_at = assertOptionalTripDateTime(body.end_at, "end_at");
  }
  if ("timezone" in body) {
    if (
      typeof body.timezone !== "string" ||
      body.timezone.trim().length === 0
    ) {
      throw new AppError(
        "TRIP_INVALID",
        "validation",
        400,
        "timezone must be a non-blank IANA timezone.",
      );
    }
    assertTimezone(body.timezone);
    patch.timezone = body.timezone;
  }
  return patch;
}

function assertTripChronology(current: Trip, patch: TripUpdate): void {
  const startAt =
    patch.start_at !== undefined ? patch.start_at : current.start_at;
  const endAt = patch.end_at !== undefined ? patch.end_at : current.end_at;
  if (startAt && endAt && Date.parse(endAt) <= Date.parse(startAt)) {
    throw new AppError(
      "TRIP_INVALID",
      "validation",
      400,
      "end_at must be after start_at.",
    );
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  );

  // Only an origin from CORS_ALLOWED_ORIGINS is echoed back; other origins get no CORS header.
  const requestOrigin = request.headers.origin;
  const allowedOrigin =
    typeof requestOrigin === "string" &&
    config.corsAllowedOrigins.includes(requestOrigin)
      ? requestOrigin
      : undefined;
  if (allowedOrigin) {
    response.setHeader("access-control-allow-origin", allowedOrigin);
    response.setHeader("vary", "Origin");
  }

  if (method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-headers":
        "authorization, content-type, idempotency-key, x-request-id",
      "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
    });
    response.end();
    return;
  }

  if (
    method === "GET" &&
    (url.pathname === "/health" || url.pathname === "/api/v1/health")
  ) {
    writeJson(response, 200, {
      status: "ok",
      service: serviceName,
      version: "0.1.0",
      request_id: requestId,
    });
    return;
  }

  if (
    method === "GET" &&
    (url.pathname === "/ready" || url.pathname === "/api/v1/ready")
  ) {
    const result = await checkReadiness(config, readinessProbes);
    if (result.status === "not_ready") {
      logger.warn("api.not_ready", {
        request_id: requestId,
        failing: Object.entries(result.checks)
          .filter(([, check]) => check.status === "failing")
          .map(([name, check]) => `${name}:${check.code ?? "failing"}`),
      });
    }
    writeJson(response, result.status === "ready" ? 200 : 503, {
      ...result,
      service: serviceName,
      version: "0.1.0",
      request_id: requestId,
    });
    return;
  }

  if (method === "GET" && url.pathname === "/metrics") {
    if (config.metricsToken) {
      const supplied = request.headers.authorization;
      if (supplied !== `Bearer ${config.metricsToken}`) {
        throw new AppError(
          "AUTH_TOKEN_INVALID",
          "authentication",
          401,
          "A valid metrics token is required.",
        );
      }
    }
    response.writeHead(200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(metrics.render());
    return;
  }

  if (
    method === "GET" &&
    (url.pathname === "/auth/me" || url.pathname === "/api/v1/auth/me")
  ) {
    const user = await requireAuthenticatedUser(
      request.headers,
      requireAuthVerifier(),
    );
    writeJson(response, 200, {
      user,
      request_id: requestId,
    });
    return;
  }

  if (method === "GET" && url.pathname === "/api/v1/trips") {
    const { user, repository } = await authenticatedRepository(request);
    const trips = await repository.listTrips(user.id);
    writeJson(response, 200, {
      items: trips.map(serializedTrip),
      request_id: requestId,
    });
    return;
  }

  const refundPaymentPath = refundPaymentFromPath(url.pathname);
  if (method === "POST" && refundPaymentPath) {
    const { user, commerce } = await authenticatedRepository(request);
    const command = commandContext(request, url.pathname, user.id, {});
    const result = await commerce.refundPayment(
      refundPaymentPath.bookingId,
      refundPaymentPath.tripId,
      refundPaymentPath.paymentId,
      command,
    );
    writeJson(response, 200, {
      booking: serializedBooking(result.booking),
      payment: serializedPayment(result.payment),
      request_id: requestId,
    });
    return;
  }

  const paymentPath = paymentCollectionFromPath(url.pathname);
  if (paymentPath && method === "GET") {
    const { user, repository, bookingRepository } =
      await authenticatedRepository(request);
    const trip = await repository.getTripRowForUser(
      paymentPath.tripId,
      user.id,
    );
    if (!trip)
      throw new AppError(
        "RESOURCE_NOT_FOUND",
        "not_found",
        404,
        "Trip was not found.",
      );
    const booking = await bookingRepository.getBooking(
      paymentPath.bookingId,
      paymentPath.tripId,
    );
    if (!booking)
      throw new AppError(
        "RESOURCE_NOT_FOUND",
        "not_found",
        404,
        "Booking was not found.",
      );
    const payments = await bookingRepository.listPayments(
      paymentPath.bookingId,
    );
    writeJson(response, 200, {
      items: payments.map(serializedPayment),
      request_id: requestId,
    });
    return;
  }

  if (paymentPath && method === "POST") {
    const { user, commerce } = await authenticatedRepository(request);
    const body = await readJsonBody(request);
    const paymentInput = parsePaymentInput(body);
    const result = await commerce.simulatePayment(
      paymentPath.bookingId,
      paymentPath.tripId,
      paymentInput,
      commandContext(request, url.pathname, user.id, body),
    );
    if (result.payment.status === "succeeded") {
      await queueInvoiceAfterPayment(
        config,
        logger,
        result.booking.id,
        requestId,
      );
    }
    writeJson(response, 201, {
      booking: serializedBooking(result.booking),
      payment: serializedPayment(result.payment),
      request_id: requestId,
    });
    return;
  }

  const bookingDetail = bookingDetailFromPath(url.pathname);
  if (bookingDetail && method === "GET") {
    const { user, repository, bookingRepository } =
      await authenticatedRepository(request);
    const trip = await repository.getTripRowForUser(
      bookingDetail.tripId,
      user.id,
    );
    if (!trip)
      throw new AppError(
        "RESOURCE_NOT_FOUND",
        "not_found",
        404,
        "Trip was not found.",
      );
    const booking = await bookingRepository.getBooking(
      bookingDetail.bookingId,
      bookingDetail.tripId,
    );
    if (!booking)
      throw new AppError(
        "RESOURCE_NOT_FOUND",
        "not_found",
        404,
        "Booking was not found.",
      );
    writeJson(response, 200, {
      ...serializedBooking(booking),
      request_id: requestId,
    });
    return;
  }

  const bookingsTripId = bookingsTripIdFromPath(url.pathname);
  if (bookingsTripId && method === "GET") {
    const { user, repository, bookingRepository } =
      await authenticatedRepository(request);
    const trip = await repository.getTripRowForUser(bookingsTripId, user.id);
    if (!trip)
      throw new AppError(
        "RESOURCE_NOT_FOUND",
        "not_found",
        404,
        "Trip was not found.",
      );
    const bookings = await bookingRepository.listBookings(bookingsTripId);
    writeJson(response, 200, {
      items: bookings.map(serializedBooking),
      request_id: requestId,
    });
    return;
  }

  if (bookingsTripId && method === "POST") {
    const { user, commerce } = await authenticatedRepository(request);
    const body = await readJsonBody(request);
    const result = await commerce.createBooking(
      parseCreateBookingInput(bookingsTripId, user.id, body),
      commandContext(request, url.pathname, user.id, body),
    );
    writeJson(response, 201, {
      ...serializedBooking(result),
      request_id: requestId,
    });
    return;
  }

  const eventTripId = eventDiscoveriesTripIdFromPath(url.pathname);
  if (eventTripId && method === "POST") {
    const { user, eventDiscovery } = await authenticatedRepository(request);
    const body = await readJsonBody(request);
    const result = await eventDiscovery.discover(
      parseEventDiscoveryInput(eventTripId, user.id, requestId, body),
    );
    writeJson(response, 200, result);
    return;
  }

  if (eventTripId && method === "GET") {
    const { user, eventDiscovery } = await authenticatedRepository(request);
    const contextPointId = url.searchParams.get("context_point_id");
    if (!contextPointId) {
      throw new AppError(
        "EXTERNAL_QUERY_INVALID",
        "validation",
        400,
        "context_point_id is required.",
      );
    }
    const result = await eventDiscovery.latest(
      eventTripId,
      contextPointId,
      user.id,
      requestId,
    );
    writeJson(response, 200, result);
    return;
  }

  const contextTripId = contextPointsTripIdFromPath(url.pathname);
  if (method === "GET" && contextTripId) {
    const { user, repository } = await authenticatedRepository(request);
    const trip = await repository.getTripRowForUser(contextTripId, user.id);
    if (!trip) {
      throw new AppError(
        "RESOURCE_NOT_FOUND",
        "not_found",
        404,
        "Trip was not found.",
      );
    }
    const contextPoints = await repository.listContextPointsForTrip(
      contextTripId,
      user.id,
    );
    writeJson(response, 200, {
      items: contextPoints.map(serializedContextPoint),
      request_id: requestId,
    });
    return;
  }

  const contextCommand = contextPointCommandFromPath(url.pathname);
  if (method === "POST" && contextCommand) {
    const { user, repository, service } =
      await authenticatedRepository(request);
    const current = await repository.getContextPoint(
      contextCommand.contextPointId,
    );
    if (!current || current.tripId !== contextCommand.tripId) {
      throw new AppError(
        "RESOURCE_NOT_FOUND",
        "not_found",
        404,
        "Context point was not found.",
      );
    }
    const body =
      contextCommand.action === "resolve" ? await readJsonBody(request) : {};
    const command = commandContext(request, url.pathname, user.id, body);
    let result: ContextPointRecord;
    if (contextCommand.action === "resolve") {
      result = await service.resolveContextPoint(
        contextCommand.contextPointId,
        parseResolveContextPointInput(body),
        command,
      );
    } else if (contextCommand.action === "confirm") {
      result = await service.confirmContextPoint(
        contextCommand.contextPointId,
        command,
      );
    } else {
      result = await service.archiveContextPoint(
        contextCommand.contextPointId,
        command,
      );
    }
    writeJson(response, 200, {
      ...serializedContextPointRecord(result),
      request_id: requestId,
    });
    return;
  }

  if (method === "POST" && contextTripId) {
    const { user, service } = await authenticatedRepository(request);
    const body = await readJsonBody(request);
    const result = await service.createContextPoint(
      parseContextPointInput(contextTripId, body),
      commandContext(request, url.pathname, user.id, body),
    );
    writeJson(response, result.kind === "created" ? 201 : 202, {
      kind: result.kind,
      context_point: serializedContextPointRecord(result.contextPoint),
      ...(result.kind === "awaiting_clarification"
        ? { clarification: result.clarification }
        : {}),
      request_id: requestId,
    });
    return;
  }

  const agendaCommand = agendaCommandFromPath(url.pathname);
  if (method === "POST" && agendaCommand) {
    const { user, service, repository } =
      await authenticatedRepository(request);
    const agenda = await repository.getAgendaItem(agendaCommand.agendaItemId);
    if (!agenda || agenda.tripId !== agendaCommand.tripId) {
      throw new AppError(
        "RESOURCE_NOT_FOUND",
        "not_found",
        404,
        "Agenda item was not found.",
      );
    }
    const body = {};
    const command = commandContext(request, url.pathname, user.id, body);
    let result: AgendaItemRecord;
    if (agendaCommand.action === "plan") {
      result = await service.planAgendaItem(
        agendaCommand.agendaItemId,
        command,
      );
    } else if (agendaCommand.action === "confirm") {
      result = await service.confirmAgendaItem(
        agendaCommand.agendaItemId,
        command,
      );
    } else if (agendaCommand.action === "cancel") {
      result = await service.cancelAgendaItem(
        agendaCommand.agendaItemId,
        command,
      );
    } else {
      result = await service.completeAgendaItem(
        agendaCommand.agendaItemId,
        command,
      );
    }
    writeJson(response, 200, {
      ...serializedAgendaItem(result),
      request_id: requestId,
    });
    return;
  }

  const agendaTripId = agendaTripIdFromPath(url.pathname);
  if (agendaTripId && method === "GET") {
    const { user, repository } = await authenticatedRepository(request);
    const trip = await repository.getTripRowForUser(agendaTripId, user.id);
    if (!trip) {
      throw new AppError(
        "RESOURCE_NOT_FOUND",
        "not_found",
        404,
        "Trip was not found.",
      );
    }
    const items = await repository.listAgendaItemsForTrip(
      agendaTripId,
      user.id,
    );
    writeJson(response, 200, {
      items: items.map(serializedAgendaItem),
      request_id: requestId,
    });
    return;
  }

  if (agendaTripId && method === "POST") {
    const { user, service } = await authenticatedRepository(request);
    const body = await readJsonBody(request);
    const result = await service.createAgendaItem(
      parseAgendaInput(agendaTripId, body),
      commandContext(request, url.pathname, user.id, body),
    );
    writeJson(response, 201, {
      ...serializedAgendaItem(result),
      request_id: requestId,
    });
    return;
  }

  const journeyCommand = journeyLegCommandFromPath(url.pathname);
  if (method === "POST" && journeyCommand) {
    const { user, service, repository } =
      await authenticatedRepository(request);
    const leg = await repository.getJourneyLeg(journeyCommand.journeyLegId);
    if (!leg || leg.tripId !== journeyCommand.tripId) {
      throw new AppError(
        "RESOURCE_NOT_FOUND",
        "not_found",
        404,
        "Journey leg was not found.",
      );
    }
    const command = commandContext(request, url.pathname, user.id, {});
    let result: JourneyLegRecord;
    if (journeyCommand.action === "start") {
      result = await service.startJourneyLeg(
        journeyCommand.journeyLegId,
        command,
      );
    } else if (journeyCommand.action === "complete") {
      result = await service.completeJourneyLeg(
        journeyCommand.journeyLegId,
        command,
      );
    } else {
      result = await service.cancelJourneyLeg(
        journeyCommand.journeyLegId,
        command,
      );
    }
    writeJson(response, 200, {
      ...serializedJourneyLeg(result),
      request_id: requestId,
    });
    return;
  }

  const journeyTripId = journeyLegsTripIdFromPath(url.pathname);
  if (journeyTripId && method === "GET") {
    const { user, repository } = await authenticatedRepository(request);
    const trip = await repository.getTripRowForUser(journeyTripId, user.id);
    if (!trip) {
      throw new AppError(
        "RESOURCE_NOT_FOUND",
        "not_found",
        404,
        "Trip was not found.",
      );
    }
    const items = await repository.listJourneyLegsForTrip(
      journeyTripId,
      user.id,
    );
    writeJson(response, 200, {
      items: items.map(serializedJourneyLeg),
      request_id: requestId,
    });
    return;
  }

  if (journeyTripId && method === "POST") {
    const { user, service } = await authenticatedRepository(request);
    const body = await readJsonBody(request);
    const result = await service.createJourneyLeg(
      parseJourneyLegInput(journeyTripId, body),
      commandContext(request, url.pathname, user.id, body),
    );
    writeJson(response, 201, {
      ...serializedJourneyLeg(result),
      request_id: requestId,
    });
    return;
  }

  const transitionTripId = tripTransitionFromPath(url.pathname);
  if (method === "POST" && transitionTripId) {
    const { user, service, repository } =
      await authenticatedRepository(request);
    const body = bodyRecord(await readJsonBody(request));
    const target = requiredString(body, "status");
    const command = commandContext(request, url.pathname, user.id, body);
    let result;
    if (target === "confirmed") {
      result = await service.confirmTrip(transitionTripId, command);
    } else if (target === "active") {
      result = await service.activateTrip(transitionTripId, command);
    } else if (target === "completed") {
      result = await service.completeTrip(transitionTripId, command);
    } else {
      throw new AppError(
        "REQUEST_INVALID",
        "validation",
        400,
        "Trip transition status is invalid.",
      );
    }
    // The service returns the domain record (camelCase, few fields). The
    // contract promises the full Trip, so read the stored row.
    const row = await repository.getTripRowForUser(result.id, user.id);
    if (!row) {
      throw new AppError(
        "RESOURCE_NOT_FOUND",
        "not_found",
        404,
        "Trip was not found.",
      );
    }
    writeJson(response, 200, { ...serializedTrip(row), request_id: requestId });
    return;
  }

  const tripId = tripIdFromPath(url.pathname);
  if (tripId && method === "PATCH") {
    const { user, repository } = await authenticatedRepository(request);
    const current = await repository.getTripRowForUser(tripId, user.id);
    if (!current) {
      throw new AppError(
        "RESOURCE_NOT_FOUND",
        "not_found",
        404,
        "Trip was not found.",
      );
    }
    const patch = parseTripUpdate(await readJsonBody(request));
    assertTripChronology(current, patch);
    const updated = await repository.updateTrip(tripId, user.id, patch);
    if (!updated) {
      throw new AppError(
        "RESOURCE_NOT_FOUND",
        "not_found",
        404,
        "Trip was not found.",
      );
    }
    writeJson(response, 200, {
      ...serializedTrip(updated),
      request_id: requestId,
    });
    return;
  }

  if (tripId && method === "GET") {
    const { user, repository } = await authenticatedRepository(request);
    const trip = await repository.getTripRowForUser(tripId, user.id);
    if (!trip) {
      throw new AppError(
        "RESOURCE_NOT_FOUND",
        "not_found",
        404,
        "Trip was not found.",
      );
    }
    writeJson(response, 200, {
      ...serializedTrip(trip),
      request_id: requestId,
    });
    return;
  }

  const routeContext: RequestContext = {
    request,
    response,
    requestId,
    method,
    url,
    config,
    logger,
    authenticate: () => authenticateRequest(request),
  };
  for (const handle of routeModules) {
    if (await handle(routeContext)) return;
  }

  throw new AppError(
    "RESOURCE_NOT_FOUND",
    "not_found",
    404,
    "Route not found.",
    {
      method,
      path: url.pathname,
    },
  );
}

export const server = createServer((request, response) => {
  const requestId = requestIdFrom(request);
  response.setHeader("x-request-id", requestId);
  const startedAt = process.hrtime.bigint();
  response.on("finish", () => {
    let route = "unparsed";
    try {
      route = routeLabel(
        new URL(request.url ?? "/", "http://localhost").pathname,
      );
    } catch {
      // A request URL that cannot be parsed is counted under "unparsed".
    }
    metrics.recordRequest({
      method: request.method ?? "GET",
      route,
      status: response.statusCode,
      seconds: Number(process.hrtime.bigint() - startedAt) / 1e9,
    });
  });

  void handleRequest(request, response, requestId).catch((error: unknown) => {
    logger.error("http.request_failed", {
      request_id: requestId,
      method: request.method,
      path: request.url,
      error_name: error instanceof Error ? error.name : "UnknownError",
      error_message: error instanceof AppError ? error.message : undefined,
      ...(error instanceof ExternalDataError
        ? {
            error_code: error.code,
            provider: error.provider,
            error_details: error.details,
          }
        : {}),
    });
    if (error instanceof ExternalDataError) {
      metrics.recordProviderError(error.provider, error.code);
    }
    const safeError = normalizeDomainError(error);
    writeError(response, requestId, safeError);
  });
});

if (process.env.NODE_ENV !== "test") {
  server.listen(config.port, config.host, () => {
    logger.info("api.started", {
      service: serviceName,
      host: config.host,
      port: config.port,
      environment: config.nodeEnv,
      auth_configured: Boolean(authVerifier),
      database_public_key_configured: Boolean(config.supabaseAnonKey),
    });
  });

  function shutdown(signal: string): void {
    logger.info("api.shutdown_requested", { signal });
    server.close((error) => {
      if (error) {
        logger.error("api.shutdown_failed", { error_message: error.message });
        process.exitCode = 1;
        return;
      }
      process.exitCode = 0;
    });
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
