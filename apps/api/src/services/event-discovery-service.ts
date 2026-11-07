import {
  buildEventDiscoveryQuery,
  type EventDiscoveryInput,
  type EventDiscoveryPipeline,
} from "@travelflow/integrations";
import type { ContextPointRecord } from "@travelflow/domain";
import { AppError } from "../errors.js";
import {
  SupabaseEventDiscoveryRepository,
  type EventDiscoveryResponse,
} from "../repositories/event-discovery-repository.js";
import type { SupabaseTripContextRepository } from "../repositories/trip-context-repository.js";

export interface DiscoverEventsRequest {
  requestId: string;
  executionId: string;
  userId: string;
  tripId: string;
  contextPointId: string;
  observedFor: {
    from: string;
    to: string;
    timezone: string;
  };
  category: string;
  radiusPreference?: string;
  language?: string;
  locale?: string;
  currency?: string;
}

export class EventDiscoveryService {
  public constructor(
    private readonly tripContextRepository: SupabaseTripContextRepository,
    private readonly eventRepository: SupabaseEventDiscoveryRepository,
    private readonly pipeline: EventDiscoveryPipeline,
    private readonly ttlHours: number,
  ) {}

  public async discover(
    input: DiscoverEventsRequest,
  ): Promise<EventDiscoveryResponse> {
    const trip = await this.tripContextRepository.getTripRowForUser(
      input.tripId,
      input.userId,
    );
    if (!trip) {
      throw new AppError(
        "RESOURCE_NOT_FOUND",
        "not_found",
        404,
        "Trip was not found.",
      );
    }
    const contextPoint = await this.tripContextRepository.getContextPoint(
      input.contextPointId,
    );
    this.assertContext(input, contextPoint);

    const integrationInput: EventDiscoveryInput = {
      requestId: input.requestId,
      executionId: input.executionId,
      tripId: input.tripId,
      contextPointId: input.contextPointId,
      contextLabel: contextPoint.label,
      contextAddress: contextPoint.address,
      observedFor: input.observedFor,
      filters: {
        category: input.category,
        ...(input.radiusPreference
          ? { radiusPreference: input.radiusPreference }
          : {}),
        ...(input.language ? { language: input.language } : {}),
      },
      ...(input.locale ? { locale: input.locale } : {}),
      ...(input.currency ? { currency: input.currency } : {}),
    };
    const query = buildEventDiscoveryQuery(integrationInput);
    const now = new Date().toISOString();
    const cached = await this.eventRepository.findFreshSnapshot({
      tripId: input.tripId,
      contextPointId: input.contextPointId,
      fingerprint: query.fingerprint,
      now,
    });
    if (cached) return { ...cached, request_id: input.requestId };

    const normalized = await this.pipeline.run(query, now, this.ttlHours);
    const persisted = await this.eventRepository.persistSnapshot({
      query: {
        requestId: input.requestId,
        tripId: input.tripId,
        contextPointId: input.contextPointId,
        fingerprint: query.fingerprint,
        category: input.category,
        observedFrom: input.observedFor.from,
        observedTo: input.observedFor.to,
        timezone: input.observedFor.timezone,
      },
      normalized,
    });
    return { ...persisted, request_id: input.requestId };
  }

  public async latest(
    tripId: string,
    contextPointId: string,
    userId: string,
    requestId: string,
  ): Promise<EventDiscoveryResponse> {
    const trip = await this.tripContextRepository.getTripRowForUser(
      tripId,
      userId,
    );
    if (!trip) {
      throw new AppError(
        "RESOURCE_NOT_FOUND",
        "not_found",
        404,
        "Trip was not found.",
      );
    }
    const contextPoint =
      await this.tripContextRepository.getContextPoint(contextPointId);
    this.assertContext({ tripId, contextPointId }, contextPoint);
    const latest = await this.eventRepository.listLatest(
      tripId,
      contextPointId,
    );
    if (!latest) {
      throw new AppError(
        "RESOURCE_NOT_FOUND",
        "not_found",
        404,
        "Event discovery result was not found.",
      );
    }
    if (latest.freshness !== "fresh") {
      throw new AppError(
        "EVENT_DISCOVERY_EXPIRED",
        "provider",
        410,
        "The latest event discovery result has expired.",
      );
    }
    return { ...latest, request_id: requestId };
  }

  private assertContext(
    input: { tripId: string; contextPointId: string },
    contextPoint: ContextPointRecord | null,
  ): asserts contextPoint is ContextPointRecord {
    if (!contextPoint || contextPoint.tripId !== input.tripId) {
      throw new AppError(
        "RESOURCE_NOT_FOUND",
        "not_found",
        404,
        "Context point was not found.",
      );
    }
    if (contextPoint.status !== "active") {
      throw new AppError(
        "EXTERNAL_CONTEXT_UNRESOLVED",
        "validation",
        422,
        "Event discovery requires an active context point.",
      );
    }
    if (
      contextPoint.resolutionStatus !== "resolved" ||
      contextPoint.latitude === null ||
      contextPoint.longitude === null ||
      !contextPoint.externalPlaceId
    ) {
      throw new AppError(
        "EXTERNAL_CONTEXT_UNRESOLVED",
        "validation",
        422,
        "Event discovery requires a resolved context point.",
      );
    }
  }
}
