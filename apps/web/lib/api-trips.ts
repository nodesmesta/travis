import { ApiClientError, request } from "./api";
import type { Trip } from "./types";
import type {
  AgendaItemView,
  ContextPointResult,
  CreateAgendaItemBody,
  CreateContextPointBody,
  CreateJourneyLegBody,
  CreateTripBody,
  JourneyLegView,
  ResolveContextPointBody,
  UpdateTripBody,
} from "./types-trips";
import type { ContextPoint } from "./types";

export { newIdempotencyKey } from "./api-assistant";
export { listContextPoints, listTrips } from "./api";

function tripPath(tripId: string): string {
  return `/trips/${encodeURIComponent(tripId)}`;
}

function withKey(key: string): Record<string, string> {
  return { "idempotency-key": key };
}

type WithRequestId<T> = T & { request_id: string };

/** `POST /trips`. Reusing `key` for the same body returns the trip created the first time. */
export function createTrip(
  body: CreateTripBody,
  key: string,
): Promise<WithRequestId<Trip>> {
  return request(
    "/trips",
    { method: "POST", body: JSON.stringify(body), headers: withKey(key) },
    true,
  );
}

export function updateTrip(
  tripId: string,
  body: UpdateTripBody,
): Promise<WithRequestId<Trip>> {
  return request(tripPath(tripId), {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function transitionTrip(
  tripId: string,
  status: "confirmed" | "active" | "completed",
  key: string,
): Promise<WithRequestId<Trip>> {
  return request(
    `${tripPath(tripId)}/transition`,
    { method: "POST", body: JSON.stringify({ status }), headers: withKey(key) },
    true,
  );
}

export async function createContextPoint(
  tripId: string,
  body: CreateContextPointBody,
  key: string,
): Promise<ContextPointResult> {
  return request(
    `${tripPath(tripId)}/context-points`,
    { method: "POST", body: JSON.stringify(body), headers: withKey(key) },
    true,
  );
}

export function resolveContextPoint(
  tripId: string,
  contextPointId: string,
  body: ResolveContextPointBody,
  key: string,
): Promise<ContextPoint & { request_id: string }> {
  return request(
    `${tripPath(tripId)}/context-points/${encodeURIComponent(contextPointId)}/resolve`,
    { method: "POST", body: JSON.stringify(body), headers: withKey(key) },
    true,
  );
}

export function confirmContextPoint(
  tripId: string,
  contextPointId: string,
  key: string,
): Promise<ContextPoint & { request_id: string }> {
  return request(
    `${tripPath(tripId)}/context-points/${encodeURIComponent(contextPointId)}/confirm`,
    { method: "POST", headers: withKey(key) },
    true,
  );
}

export function archiveContextPoint(
  tripId: string,
  contextPointId: string,
  key: string,
): Promise<ContextPoint & { request_id: string }> {
  return request(
    `${tripPath(tripId)}/context-points/${encodeURIComponent(contextPointId)}/archive`,
    { method: "POST", headers: withKey(key) },
    true,
  );
}

export function createAgendaItem(
  tripId: string,
  body: CreateAgendaItemBody,
  key: string,
): Promise<WithRequestId<AgendaItemView>> {
  return request(
    `${tripPath(tripId)}/agenda-items`,
    { method: "POST", body: JSON.stringify(body), headers: withKey(key) },
    true,
  );
}

export function createJourneyLeg(
  tripId: string,
  body: CreateJourneyLegBody,
  key: string,
): Promise<WithRequestId<JourneyLegView>> {
  return request(
    `${tripPath(tripId)}/journey-legs`,
    { method: "POST", body: JSON.stringify(body), headers: withKey(key) },
    true,
  );
}

export interface DescribedError {
  message: string;
  code: string;
  requestId?: string;
}

/** The server message as it came, with its code and request id. Nothing is rewritten. */
export function describeTripError(error: unknown): DescribedError {
  if (error instanceof ApiClientError) {
    return {
      message: error.message,
      code: error.code,
      ...(error.requestId ? { requestId: error.requestId } : {}),
    };
  }
  return {
    message:
      error instanceof Error
        ? error.message
        : "Something went wrong. Please try again.",
    code: "CLIENT_ERROR",
  };
}
