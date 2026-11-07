import { brightDataConfigFrom } from "../bright-data-config.js";
import { randomUUID } from "node:crypto";
import {
  ActivityClaimExtractor,
  ActivityDiscoveryPipeline,
  BrightDataClient,
  HereClient,
  OpenWeatherClient,
  VultrInferenceClient,
  type HereService,
} from "@travelflow/integrations";
import { AppError } from "../errors.js";
import {
  bodyRecord,
  commandContext,
  readJsonBody,
  requiredString,
  writeJson,
} from "../http.js";
import { FixedWindowLimiter } from "../rate-limit.js";
import {
  SupabaseActivityLogWriter,
  SupabaseIdempotencyStore,
} from "../repositories/domain-persistence.js";
import { SupabaseMobilityRepository } from "../repositories/mobility-repository.js";
import { SupabasePlaceDiscoveryRepository } from "../repositories/place-discovery-repository.js";
import { SupabaseTripContextRepository } from "../repositories/trip-context-repository.js";
import { matchPath } from "../routing.js";
import { MobilityService } from "../services/mobility-service.js";
import {
  PlaceDiscoveryService,
  type PlaceCategoryName,
} from "../services/place-discovery-service.js";
import type {
  AuthenticatedSession,
  RequestContext,
  RouteModule,
} from "./context.js";

const TRIPS = "/api/v1/trips";

// Refresh and discovery endpoints reach paid providers, so they are rate limited per user.
const routeLimiter = new FixedWindowLimiter(20, 60_000);
const weatherLimiter = new FixedWindowLimiter(12, 60_000);
const trafficLimiter = new FixedWindowLimiter(12, 60_000);
const placeLimiter = new FixedWindowLimiter(10, 60_000);

const HEX = "0123456789abcdef";

/** True for a canonical UUID such as 123e4567-e89b-12d3-a456-426614174000. */
export function isUuid(value: string): boolean {
  if (value.length !== 36) return false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] as string;
    if (index === 8 || index === 13 || index === 18 || index === 23) {
      if (char !== "-") return false;
    } else if (!HEX.includes(char.toLowerCase())) {
      return false;
    }
  }
  return true;
}

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

function queryId(value: string | null, field: string): string {
  if (!value || !isUuid(value)) {
    throw new AppError(
      "REQUEST_INVALID",
      "validation",
      400,
      `${field} must be a UUID.`,
    );
  }
  return value;
}

function limit(
  context: RequestContext,
  limiter: FixedWindowLimiter,
  userId: string,
  scope: string,
): void {
  const wait = limiter.take(`${userId}:${scope}`);
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
}

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

export interface MobilityRouteServices {
  mobility: MobilityService;
  places: PlaceDiscoveryService;
}

type Services = MobilityRouteServices;

/** Also used by the assistant so its tools run through the same services as the REST endpoints. */
export function buildServices(
  context: RequestContext,
  session: AuthenticatedSession,
): Services {
  const { config, logger } = context;
  const { client } = session;
  const trips = new SupabaseTripContextRepository(client);
  const repo = new SupabaseMobilityRepository(client);
  const baseUrls = hereBaseUrls(config.hereBaseUrlOverride);
  const here = new HereClient({
    apiKey: config.hereApiKey,
    timeoutMs: config.hereTimeoutMs,
    ...(baseUrls ? { baseUrls } : {}),
  });
  const weather = new OpenWeatherClient({
    apiKey: config.openWeatherApiKey,
    timeoutMs: config.openWeatherTimeoutMs,
    ...(config.openWeatherBaseUrlOverride
      ? { baseUrl: config.openWeatherBaseUrlOverride }
      : {}),
  });
  const activityPipeline = new ActivityDiscoveryPipeline(
    new BrightDataClient(brightDataConfigFrom(config)),
    new ActivityClaimExtractor(
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
  );
  return {
    mobility: new MobilityService({
      trips,
      repo,
      here,
      weather,
      idempotency: new SupabaseIdempotencyStore(client),
      activityLog: new SupabaseActivityLogWriter(client),
      logger,
    }),
    places: new PlaceDiscoveryService(
      trips,
      new SupabasePlaceDiscoveryRepository(client),
      repo,
      here,
      activityPipeline,
      {
        activityHours: config.activityDiscoveryTtlHours,
        restaurantHours: config.restaurantDiscoveryTtlHours,
      },
    ),
  };
}

function parsePlaceBody(body: Record<string, unknown>): {
  contextPointId: string;
  category: PlaceCategoryName;
  radiusMeters?: number;
  language?: string;
} {
  for (const key of Object.keys(body)) {
    if (
      !["context_point_id", "category", "radius_meters", "language"].includes(
        key,
      )
    ) {
      throw new AppError(
        "REQUEST_INVALID",
        "validation",
        400,
        `${key} is not supported.`,
      );
    }
  }
  const contextPointId = requiredString(body, "context_point_id");
  if (!isUuid(contextPointId)) {
    throw new AppError(
      "REQUEST_INVALID",
      "validation",
      400,
      "context_point_id must be a UUID.",
    );
  }
  const category = requiredString(body, "category");
  if (category !== "activity" && category !== "restaurant") {
    throw new AppError(
      "REQUEST_INVALID",
      "validation",
      400,
      "category must be activity or restaurant.",
    );
  }
  const result: ReturnType<typeof parsePlaceBody> = {
    contextPointId,
    category,
  };
  if (body.radius_meters !== undefined) {
    if (
      typeof body.radius_meters !== "number" ||
      !Number.isInteger(body.radius_meters)
    ) {
      throw new AppError(
        "REQUEST_INVALID",
        "validation",
        400,
        "radius_meters must be an integer.",
      );
    }
    result.radiusMeters = body.radius_meters;
  }
  if (body.language !== undefined) {
    const language = requiredString(body, "language");
    if (language.length < 2 || language.length > 10) {
      throw new AppError(
        "REQUEST_INVALID",
        "validation",
        400,
        "language must be 2 to 10 characters.",
      );
    }
    result.language = language;
  }
  return result;
}

export const mobilityRoutes: RouteModule = async (context) => {
  const { method, url, request, response, requestId } = context;
  const path = url.pathname;

  const legRequests = matchPath(
    path,
    `${TRIPS}/:tripId/journey-legs/:journeyLegId/route-requests`,
  );
  if (legRequests && (method === "POST" || method === "GET")) {
    const session = await context.authenticate();
    const { mobility } = buildServices(context, session);
    const tripId = pathId(legRequests.tripId, "Trip");
    const journeyLegId = pathId(legRequests.journeyLegId, "Journey leg");
    if (method === "GET") {
      writeJson(
        response,
        200,
        await mobility.listRouteRequests({
          tripId,
          userId: session.user.id,
          journeyLegId,
          requestId,
        }),
      );
      return true;
    }
    limit(context, routeLimiter, session.user.id, "route");
    const body = bodyRecord(await readJsonBody(request));
    const result = await mobility.createRouteRequest(
      { tripId, userId: session.user.id, journeyLegId, requestId, body },
      commandContext(request, path, session.user.id, body),
    );
    writeJson(response, 201, result);
    return true;
  }

  const detail = matchPath(
    path,
    `${TRIPS}/:tripId/route-requests/:routeRequestId`,
  );
  if (detail && method === "GET") {
    const session = await context.authenticate();
    const { mobility } = buildServices(context, session);
    writeJson(
      response,
      200,
      await mobility.getRouteRequest({
        tripId: pathId(detail.tripId, "Trip"),
        userId: session.user.id,
        routeRequestId: pathId(detail.routeRequestId, "Route request"),
        requestId,
      }),
    );
    return true;
  }

  const options = matchPath(
    path,
    `${TRIPS}/:tripId/route-requests/:routeRequestId/options`,
  );
  if (options && method === "GET") {
    const session = await context.authenticate();
    const { mobility } = buildServices(context, session);
    writeJson(
      response,
      200,
      await mobility.listRouteOptions({
        tripId: pathId(options.tripId, "Trip"),
        userId: session.user.id,
        routeRequestId: pathId(options.routeRequestId, "Route request"),
        requestId,
      }),
    );
    return true;
  }

  const select = matchPath(
    path,
    `${TRIPS}/:tripId/route-requests/:routeRequestId/select`,
  );
  if (select && method === "POST") {
    const session = await context.authenticate();
    const { mobility } = buildServices(context, session);
    const body = bodyRecord(await readJsonBody(request));
    for (const key of Object.keys(body)) {
      if (key !== "option_id") {
        throw new AppError(
          "REQUEST_INVALID",
          "validation",
          400,
          `${key} is not supported.`,
        );
      }
    }
    const optionId = requiredString(body, "option_id");
    if (!isUuid(optionId)) {
      throw new AppError(
        "REQUEST_INVALID",
        "validation",
        400,
        "option_id must be a UUID.",
      );
    }
    writeJson(
      response,
      200,
      await mobility.selectRouteOption(
        {
          tripId: pathId(select.tripId, "Trip"),
          userId: session.user.id,
          routeRequestId: pathId(select.routeRequestId, "Route request"),
          optionId,
          requestId,
        },
        commandContext(request, path, session.user.id, body),
      ),
    );
    return true;
  }

  const weather = matchPath(path, `${TRIPS}/:tripId/weather`);
  if (weather && method === "GET") {
    const session = await context.authenticate();
    const { mobility } = buildServices(context, session);
    const contextPointId = url.searchParams.get("context_point_id");
    writeJson(
      response,
      200,
      await mobility.listWeather({
        tripId: pathId(weather.tripId, "Trip"),
        userId: session.user.id,
        requestId,
        ...(contextPointId
          ? { contextPointId: queryId(contextPointId, "context_point_id") }
          : {}),
      }),
    );
    return true;
  }

  const weatherRefresh = matchPath(path, `${TRIPS}/:tripId/weather/refresh`);
  if (weatherRefresh && method === "POST") {
    const session = await context.authenticate();
    const { mobility } = buildServices(context, session);
    limit(context, weatherLimiter, session.user.id, "weather");
    const body = bodyRecord(await readJsonBody(request));
    for (const key of Object.keys(body)) {
      if (key !== "context_point_id") {
        throw new AppError(
          "REQUEST_INVALID",
          "validation",
          400,
          `${key} is not supported.`,
        );
      }
    }
    const contextPointId = body.context_point_id;
    writeJson(
      response,
      200,
      await mobility.refreshWeather({
        tripId: pathId(weatherRefresh.tripId, "Trip"),
        userId: session.user.id,
        requestId,
        ...(contextPointId !== undefined
          ? {
              contextPointId: queryId(
                typeof contextPointId === "string" ? contextPointId : null,
                "context_point_id",
              ),
            }
          : {}),
      }),
    );
    return true;
  }

  const traffic = matchPath(path, `${TRIPS}/:tripId/traffic`);
  if (traffic && method === "GET") {
    const session = await context.authenticate();
    const { mobility } = buildServices(context, session);
    const journeyLegId = url.searchParams.get("journey_leg_id");
    writeJson(
      response,
      200,
      await mobility.listTraffic({
        tripId: pathId(traffic.tripId, "Trip"),
        userId: session.user.id,
        requestId,
        ...(journeyLegId
          ? { journeyLegId: queryId(journeyLegId, "journey_leg_id") }
          : {}),
      }),
    );
    return true;
  }

  const trafficRefresh = matchPath(path, `${TRIPS}/:tripId/traffic/refresh`);
  if (trafficRefresh && method === "POST") {
    const session = await context.authenticate();
    const { mobility } = buildServices(context, session);
    limit(context, trafficLimiter, session.user.id, "traffic");
    const body = bodyRecord(await readJsonBody(request));
    for (const key of Object.keys(body)) {
      if (key !== "journey_leg_id") {
        throw new AppError(
          "REQUEST_INVALID",
          "validation",
          400,
          `${key} is not supported.`,
        );
      }
    }
    writeJson(
      response,
      200,
      await mobility.refreshTraffic({
        tripId: pathId(trafficRefresh.tripId, "Trip"),
        userId: session.user.id,
        requestId,
        journeyLegId: queryId(
          typeof body.journey_leg_id === "string" ? body.journey_leg_id : null,
          "journey_leg_id",
        ),
      }),
    );
    return true;
  }

  const recommendations = matchPath(path, `${TRIPS}/:tripId/recommendations`);
  if (recommendations && method === "GET") {
    const session = await context.authenticate();
    const { mobility } = buildServices(context, session);
    writeJson(
      response,
      200,
      await mobility.listRecommendations({
        tripId: pathId(recommendations.tripId, "Trip"),
        userId: session.user.id,
        requestId,
        includeExpired: url.searchParams.get("include_expired") === "true",
      }),
    );
    return true;
  }

  const placeDiscoveries = matchPath(
    path,
    `${TRIPS}/:tripId/place-discoveries`,
  );
  if (placeDiscoveries && method === "POST") {
    const session = await context.authenticate();
    const { places } = buildServices(context, session);
    const body = bodyRecord(await readJsonBody(request));
    const parsed = parsePlaceBody(body);
    limit(context, placeLimiter, session.user.id, parsed.category);
    writeJson(
      response,
      200,
      await places.discover({
        requestId,
        executionId: randomUUID(),
        userId: session.user.id,
        tripId: pathId(placeDiscoveries.tripId, "Trip"),
        contextPointId: parsed.contextPointId,
        category: parsed.category,
        ...(parsed.radiusMeters !== undefined
          ? { radiusMeters: parsed.radiusMeters }
          : {}),
        ...(parsed.language ? { language: parsed.language } : {}),
      }),
    );
    return true;
  }
  if (placeDiscoveries && method === "GET") {
    const session = await context.authenticate();
    const { places } = buildServices(context, session);
    const category = url.searchParams.get("category");
    if (category !== "activity" && category !== "restaurant") {
      throw new AppError(
        "REQUEST_INVALID",
        "validation",
        400,
        "category must be activity or restaurant.",
      );
    }
    writeJson(
      response,
      200,
      await places.latest({
        tripId: pathId(placeDiscoveries.tripId, "Trip"),
        userId: session.user.id,
        contextPointId: queryId(
          url.searchParams.get("context_point_id"),
          "context_point_id",
        ),
        category,
        requestId,
      }),
    );
    return true;
  }

  return false;
};
