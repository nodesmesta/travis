import { assertValidTimezone } from "@travelflow/domain";
import { AppError } from "../errors.js";
import {
  assertOffsetDateTime,
  bodyRecord,
  commandContext,
  isUtcOffsetTimezone,
  normalizeDomainError,
  optionalString,
  readJsonBody,
  requiredString,
  writeJson,
} from "../http.js";
import {
  SupabaseActivityLogWriter,
  SupabaseIdempotencyStore,
} from "../repositories/domain-persistence.js";
import type { Trip } from "../supabase/database.types.js";
import type { RouteModule } from "./context.js";

const ALLOWED_FIELDS = new Set([
  "name",
  "destination_summary",
  "start_at",
  "end_at",
  "timezone",
  "source",
]);
const SOURCES = ["user_input", "imported_booking", "internal"] as const;

export interface CreateTripInput {
  name: string;
  destinationSummary: string | null;
  startAt: string | null;
  endAt: string | null;
  timezone: string;
  source: Trip["source"];
}

function invalid(message: string): AppError {
  return new AppError("TRIP_INVALID", "validation", 400, message);
}

function zonedDateTime(
  input: Record<string, unknown>,
  field: string,
): string | null {
  const value = optionalString(input, field);
  if (value === undefined || value === "") return null;
  return assertOffsetDateTime(value, field);
}

/**
 * Validates the body of `POST /trips`. Throws a 400 `AppError` for an unknown
 * field, a missing or too long name, an invalid timezone, a date-time without
 * a UTC offset or with a day that does not exist, or an end that is not after
 * the start.
 */
export function parseCreateTripBody(body: unknown): CreateTripInput {
  const input = bodyRecord(body);
  const unknown = Object.keys(input).find((key) => !ALLOWED_FIELDS.has(key));
  if (unknown) throw invalid(`Trip field is not supported: ${unknown}.`);

  const name = requiredString(input, "name");
  if (name.length > 160) throw invalid("name must be at most 160 characters.");
  const destination = optionalString(input, "destination_summary");
  if (destination !== undefined && destination.length > 500) {
    throw invalid("destination_summary must be at most 500 characters.");
  }
  const timezone = requiredString(input, "timezone");
  if (isUtcOffsetTimezone(timezone)) {
    throw invalid(
      "timezone must be an IANA timezone name such as Asia/Jakarta, not a UTC offset.",
    );
  }
  try {
    assertValidTimezone(timezone);
  } catch (error) {
    throw normalizeDomainError(error);
  }
  const startAt = zonedDateTime(input, "start_at");
  const endAt = zonedDateTime(input, "end_at");
  if (startAt && endAt && Date.parse(endAt) <= Date.parse(startAt)) {
    throw invalid("end_at must be after start_at.");
  }
  const source = optionalString(input, "source") ?? "user_input";
  if (!(SOURCES as readonly string[]).includes(source)) {
    throw invalid("source is invalid.");
  }
  return {
    name,
    destinationSummary:
      destination === undefined || destination === "" ? null : destination,
    startAt,
    endAt,
    timezone,
    source: source as Trip["source"],
  };
}

function serialize(trip: Trip): Record<string, unknown> {
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

/** `POST /trips`: creates a draft trip owned by the signed-in user. */
export const tripRoutes: RouteModule = async (context) => {
  if (context.method !== "POST" || context.url.pathname !== "/api/v1/trips") {
    return false;
  }
  const { client, user } = await context.authenticate();
  const body = await readJsonBody(context.request);
  const input = parseCreateTripBody(body);

  const command = commandContext(
    context.request,
    context.url.pathname,
    user.id,
    body,
  );
  const trip = await new SupabaseIdempotencyStore(client).execute(
    "trip.create",
    command,
    async () => {
      const { data, error } = await client
        .from("trips")
        .insert({
          user_id: user.id,
          name: input.name,
          destination_summary: input.destinationSummary,
          start_at: input.startAt,
          end_at: input.endAt,
          timezone: input.timezone,
          status: "draft",
          source: input.source,
        })
        .select("*")
        .single();
      if (error || !data) {
        throw new AppError(
          "PERSISTENCE_ERROR",
          "persistence",
          500,
          "The trip could not be created.",
        );
      }
      await new SupabaseActivityLogWriter(client).append({
        actorUserId: user.id,
        action: "trip.created",
        resourceType: "trip",
        resourceId: data.id,
        metadata: { trip_id: data.id },
      });
      return data;
    },
  );
  writeJson(context.response, 201, {
    ...serialize(trip),
    request_id: context.requestId,
  });
  return true;
};
