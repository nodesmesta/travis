import { DomainInvariantError } from "./errors.js";

export function assertNonBlank(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new DomainInvariantError(
      "REQUEST_INVALID",
      `${field} must not be blank.`,
    );
  }
}

export function assertValidTimezone(timezone: string): void {
  assertNonBlank(timezone, "timezone");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new DomainInvariantError(
      "TIMEZONE_INVALID",
      `Timezone ${timezone} is not a valid IANA timezone.`,
    );
  }
}

export function assertCoordinates(latitude: number, longitude: number): void {
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new DomainInvariantError(
      "CONTEXT_POINT_INVALID",
      "Latitude and longitude must be valid coordinates.",
    );
  }
}

function isAsciiDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

/** True when an ISO-8601 date-time ends with `Z` or a `+HH:MM` / `-HH:MM` offset. */
export function hasExplicitUtcOffset(value: string): boolean {
  const last = value[value.length - 1];
  if (last === "Z" || last === "z") return true;
  const length = value.length;
  if (length < 6) return false;
  const sign = value[length - 6];
  return (
    (sign === "+" || sign === "-") &&
    isAsciiDigit(value[length - 5]) &&
    isAsciiDigit(value[length - 4]) &&
    value[length - 3] === ":" &&
    isAsciiDigit(value[length - 2]) &&
    isAsciiDigit(value[length - 1])
  );
}

/** Three uppercase ASCII letters, for example `IDR`. */
export function isCurrencyCode(value: string): boolean {
  if (value.length !== 3) return false;
  for (const char of value) {
    if (char < "A" || char > "Z") return false;
  }
  return true;
}

export function assertZonedDateTime(value: string, field: string): void {
  assertNonBlank(value, field);
  if (!hasExplicitUtcOffset(value) || Number.isNaN(Date.parse(value))) {
    throw new DomainInvariantError(
      "DATETIME_TIMEZONE_REQUIRED",
      `${field} must be an ISO-8601 datetime with an explicit timezone offset.`,
    );
  }
}

export function assertChronology(
  startAt: string,
  endAt: string,
  startField: string,
  endField: string,
): void {
  assertZonedDateTime(startAt, startField);
  assertZonedDateTime(endAt, endField);
  if (Date.parse(endAt) <= Date.parse(startAt)) {
    throw new DomainInvariantError(
      "AGENDA_INVALID",
      `${endField} must be later than ${startField}.`,
    );
  }
}

export function assertSameTrip(
  resourceTripId: string,
  requestedTripId: string,
): void {
  if (resourceTripId !== requestedTripId) {
    throw new DomainInvariantError(
      "RESOURCE_TRIP_MISMATCH",
      "The resource does not belong to the requested trip.",
    );
  }
}

export function assertCommandContext(context: {
  actorUserId: string;
  idempotencyKey: string;
  requestHash: string;
}): void {
  assertNonBlank(context.actorUserId, "actorUserId");
  assertNonBlank(context.idempotencyKey, "idempotencyKey");
  assertNonBlank(context.requestHash, "requestHash");
}
