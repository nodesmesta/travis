import { getSupabaseBrowserClient } from "./supabase/browser";
import type {
  ApiErrorPayload,
  Booking,
  BookingQuote,
  ContextPoint,
  EventDiscoveryResponse,
  PaymentResult,
  Trip,
} from "./types";

const apiBaseUrl =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000/api/v1";

export class ApiClientError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly requestId: string | undefined;

  public constructor(
    message: string,
    code: string,
    status: number,
    requestId?: string,
  ) {
    super(message);
    this.name = "ApiClientError";
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

async function accessToken(): Promise<string> {
  const { data, error } = await getSupabaseBrowserClient().auth.getSession();
  if (error || !data.session?.access_token) {
    throw new ApiClientError(
      "Your session has expired. Please sign in again.",
      "AUTH_TOKEN_MISSING",
      401,
    );
  }
  return data.session.access_token;
}

function idempotencyKey(operation: string): string {
  const random =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `travelflow-${operation}-${random}`.slice(0, 200);
}

export async function request<T>(
  path: string,
  options: RequestInit = {},
  mutation = false,
): Promise<T> {
  const token = await accessToken();
  const headers = new Headers(options.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("content-type", "application/json");
  if (mutation && !headers.has("idempotency-key")) {
    headers.set("idempotency-key", idempotencyKey("mutation"));
  }
  const response = await fetch(`${apiBaseUrl}${path}`, { ...options, headers });
  const body = (await response.json().catch(() => ({}))) as T | ApiErrorPayload;
  if (!response.ok) {
    const errorBody = body as ApiErrorPayload;
    throw new ApiClientError(
      errorBody.error?.message ?? "The request could not be completed.",
      errorBody.error?.code ?? "INTERNAL_ERROR",
      response.status,
      errorBody.error?.request_id,
    );
  }
  return body as T;
}

export function listTrips(): Promise<{ items: Trip[]; request_id: string }> {
  return request("/trips");
}

export function listContextPoints(
  tripId: string,
): Promise<{ items: ContextPoint[]; request_id: string }> {
  return request(`/trips/${encodeURIComponent(tripId)}/context-points`);
}

export function discoverEvents(
  tripId: string,
  body: {
    context_point_id: string;
    observed_for: { from: string; to: string; timezone: string };
    filters: {
      category: string;
      radius_preference?: string;
      language?: string;
    };
  },
): Promise<EventDiscoveryResponse> {
  return request(`/trips/${encodeURIComponent(tripId)}/event-discoveries`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getBookingQuote(
  tripId: string,
  bookingType: BookingQuote["booking_type"],
): Promise<BookingQuote> {
  return request(
    `/trips/${encodeURIComponent(tripId)}/booking-quote?booking_type=${encodeURIComponent(bookingType)}`,
  );
}

export function createBooking(
  tripId: string,
  body: {
    booking_type: "event";
    source_type: "event_discovery_result";
    source_id: string;
    starts_at?: string;
    ends_at?: string;
  },
): Promise<Booking & { request_id: string }> {
  return request(
    `/trips/${encodeURIComponent(tripId)}/bookings`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
    true,
  );
}

export function simulatePayment(
  tripId: string,
  bookingId: string,
  outcome: "succeeded" | "failed" | "pending" | "cancelled",
): Promise<PaymentResult> {
  return request(
    `/trips/${encodeURIComponent(tripId)}/bookings/${encodeURIComponent(bookingId)}/payments`,
    {
      method: "POST",
      body: JSON.stringify({
        outcome,
        ...(outcome === "failed" ? { failure_code: "DEMO_DECLINED" } : {}),
      }),
    },
    true,
  );
}

/** Authorized GET of a binary file, such as an invoice PDF. Storage URLs are never used. */
export async function requestBlob(path: string): Promise<Blob> {
  const token = await accessToken();
  const response = await fetch(`${apiBaseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiErrorPayload;
    throw new ApiClientError(
      body.error?.message ?? "The file could not be downloaded.",
      body.error?.code ?? "INTERNAL_ERROR",
      response.status,
      body.error?.request_id,
    );
  }
  return response.blob();
}
