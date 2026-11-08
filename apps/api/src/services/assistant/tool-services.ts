import { createHash } from "node:crypto";
import type { DepartureRecommendation } from "@travelflow/domain";
import type { Booking } from "../../supabase/database.types.js";
import type { RecommendationRecord } from "../../repositories/recommendation-repository.js";
import type { MobilityService } from "../mobility-service.js";
import type { PlaceDiscoveryService } from "../place-discovery-service.js";
import type { EventDiscoveryService } from "../event-discovery-service.js";
import type {
  PlaceDiscoveryView,
  RouteComparisonView,
  RouteOptionView,
  SourceView,
  ToolServices,
  TrafficView,
  WeatherView,
} from "./types.js";

export interface ToolServiceDependencies {
  mobility: Pick<
    MobilityService,
    | "createRouteRequest"
    | "previewRoutes"
    | "refreshWeather"
    | "refreshTraffic"
    | "refreshTrafficForPair"
    | "sourceViews"
  >;
  places: Pick<PlaceDiscoveryService, "discover">;
  events: Pick<EventDiscoveryService, "discover">;
  listBookings(tripId: string): Promise<Booking[]>;
  listRecommendations(tripId: string): Promise<RecommendationRecord[]>;
}

type Rec = Record<string, unknown>;

function record(value: unknown): Rec {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Rec)
    : {};
}

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function firstItem(result: Rec): Rec {
  return record(list<unknown>(result.items)[0]);
}

/**
 * Connects the assistant's tools to the Task 08 services. The services already
 * apply ownership checks, caching, the provider call, and the mobility engine;
 * this layer only reshapes their API output for the tools and adds nothing.
 */
export function createToolServices(
  deps: ToolServiceDependencies,
): ToolServices {
  return {
    discoverEvents: (request) => deps.events.discover(request),
    listBookings: (tripId) => deps.listBookings(tripId),
    listRecommendations: (tripId) => deps.listRecommendations(tripId),

    async compareRoutes(input): Promise<RouteComparisonView> {
      if (input.journeyLegId) {
        const body: Rec = input.modes ? { modes: input.modes } : {};
        const result = await deps.mobility.createRouteRequest(
          {
            tripId: input.tripId,
            userId: input.userId,
            journeyLegId: input.journeyLegId,
            requestId: input.requestId,
            body,
          },
          {
            actorUserId: input.userId,
            idempotencyKey: `assistant:${input.executionId}:${input.journeyLegId}`,
            requestHash: createHash("sha256")
              .update(JSON.stringify(body))
              .digest("hex"),
          },
        );
        const request = record(result.route_request);
        return {
          preview: false,
          routeRequestId: text(request.id),
          originContextPointId: text(request.origin_context_point_id),
          destinationContextPointId: text(request.destination_context_point_id),
          departureAt: text(request.departure_at),
          arrivalDeadline: textOrNull(request.arrival_deadline),
          departureBasis: "leg",
          options: list<RouteOptionView>(result.options),
          recommendedOptionId: textOrNull(result.recommended_option_id),
          departureRecommendation:
            (result.departure_recommendation as DepartureRecommendation | null) ??
            null,
          facts: list<string>(result.facts),
          limitations: list<string>(result.limitations),
          sources: list<SourceView>(result.sources),
          weather: (result.weather as WeatherView | null) ?? null,
          traffic: (result.traffic as TrafficView | null) ?? null,
        };
      }
      const preview = await deps.mobility.previewRoutes({
        tripId: input.tripId,
        userId: input.userId,
        requestId: input.requestId,
        originContextPointId: input.originContextPointId as string,
        destinationContextPointId: input.destinationContextPointId as string,
        departureAt: input.departureAt,
        ...(input.modes ? { modes: input.modes } : {}),
      });
      return {
        preview: true,
        routeRequestId: null,
        originContextPointId: text(preview.origin_context_point_id),
        destinationContextPointId: text(preview.destination_context_point_id),
        departureAt: text(preview.departure_at),
        arrivalDeadline: null,
        departureBasis:
          preview.departure_basis === "requested" ? "requested" : "now",
        options: list<RouteOptionView>(preview.options),
        recommendedOptionId: textOrNull(preview.recommended_option_id),
        departureRecommendation:
          (preview.departure_recommendation as DepartureRecommendation | null) ??
          null,
        facts: list<string>(preview.facts),
        limitations: list<string>(preview.limitations),
        sources: list<SourceView>(preview.sources),
        weather: (preview.weather as WeatherView | null) ?? null,
        traffic: (preview.traffic as TrafficView | null) ?? null,
      };
    },

    async getWeather(input) {
      const result = await deps.mobility.refreshWeather({
        tripId: input.tripId,
        userId: input.userId,
        requestId: input.requestId,
        contextPointId: input.contextPointId,
      });
      const weather = firstItem(result) as unknown as WeatherView;
      const sources = await deps.mobility.sourceViews(input.tripId, [
        weather.source_id,
      ]);
      return { weather, sources: sources as unknown as SourceView[] };
    },

    async getTraffic(input) {
      let result: Rec;
      if (input.journeyLegId) {
        result = await deps.mobility.refreshTraffic({
          tripId: input.tripId,
          userId: input.userId,
          requestId: input.requestId,
          journeyLegId: input.journeyLegId,
        });
      } else {
        result = await deps.mobility.refreshTrafficForPair({
          tripId: input.tripId,
          userId: input.userId,
          requestId: input.requestId,
          originContextPointId: input.originContextPointId as string,
          destinationContextPointId: input.destinationContextPointId as string,
        });
      }
      const item = firstItem(result);
      const traffic = item as unknown as TrafficView;
      const sources = await deps.mobility.sourceViews(input.tripId, [
        traffic.source_id,
      ]);
      return {
        traffic,
        originContextPointId: text(item.origin_context_point_id),
        destinationContextPointId: text(item.destination_context_point_id),
        sources: sources as unknown as SourceView[],
      };
    },

    async discoverPlaces(input): Promise<PlaceDiscoveryView> {
      const result = await deps.places.discover({
        requestId: input.requestId,
        executionId: input.executionId,
        userId: input.userId,
        tripId: input.tripId,
        contextPointId: input.contextPointId,
        category: input.category,
        ...(input.radiusMeters !== undefined
          ? { radiusMeters: input.radiusMeters }
          : {}),
        ...(input.language ? { language: input.language } : {}),
      });
      return result as unknown as PlaceDiscoveryView;
    },
  };
}
