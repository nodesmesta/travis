// Client-side validation for the Trip setup forms. Each rule mirrors one the API
// enforces (apps/api/src/routes/trips.ts, packages/domain/src/service.ts), so a
// problem is shown next to the field before the request is sent. The server
// still checks everything again and its answer is shown unchanged.

import {
  isKnownTimeZone,
  parseLocalDateTime,
  zonedLocalToIso,
} from "./trips-time";
import type { Trip } from "./types";
import type {
  AgendaType,
  ContextPointType,
  CreateAgendaItemBody,
  CreateContextPointBody,
  CreateJourneyLegBody,
  CreateTripBody,
  ResolveContextPointBody,
  UpdateTripBody,
} from "./types-trips";

export type FieldErrors<K extends string> = Partial<Record<K, string>>;

export interface Validation<TValue, K extends string> {
  errors: FieldErrors<K>;
  /** The request body when there are no errors, otherwise null. */
  value: TValue | null;
}

const TIMEZONE_HINT =
  "Use an IANA timezone such as Asia/Jakarta. A UTC offset like +07:00 is not accepted.";

function finish<TValue, K extends string>(
  errors: FieldErrors<K>,
  value: TValue,
): Validation<TValue, K> {
  return Object.keys(errors).length === 0
    ? { errors, value }
    : { errors, value: null };
}

function checkTimezone(raw: string): string | null {
  const timezone = raw.trim();
  if (timezone.length === 0) return "Choose a timezone.";
  if (!isKnownTimeZone(timezone)) return TIMEZONE_HINT;
  return null;
}

/** ISO text with offset for a wall-clock input, or an error message. */
function dateTimeField(
  raw: string,
  timezone: string,
  required: boolean,
): { iso: string | null; error: string | null } {
  const text = raw.trim();
  if (text.length === 0) {
    return {
      iso: null,
      error: required ? "Choose a date and time." : null,
    };
  }
  if (!parseLocalDateTime(text)) {
    return { iso: null, error: "Enter a real date and time." };
  }
  const iso = zonedLocalToIso(text, timezone);
  return iso
    ? { iso, error: null }
    : { iso: null, error: "Choose a valid timezone first." };
}

// --- trip ---------------------------------------------------------------------

export interface TripFormValues {
  name: string;
  destination: string;
  /** `YYYY-MM-DDTHH:mm` in the chosen timezone, or empty. */
  start: string;
  end: string;
  timezone: string;
}

export type TripField = "name" | "destination" | "start" | "end" | "timezone";

export function validateTripForm(
  values: TripFormValues,
): Validation<CreateTripBody, TripField> {
  const errors: FieldErrors<TripField> = {};
  const name = values.name.trim();
  if (name.length === 0) errors.name = "Enter a trip name.";
  else if (name.length > 160) errors.name = "Use at most 160 characters.";
  const destination = values.destination.trim();
  if (destination.length > 500) {
    errors.destination = "Use at most 500 characters.";
  }
  const timezone = values.timezone.trim();
  const timezoneError = checkTimezone(timezone);
  if (timezoneError) errors.timezone = timezoneError;

  const start = timezoneError
    ? { iso: null, error: null }
    : dateTimeField(values.start, timezone, false);
  const end = timezoneError
    ? { iso: null, error: null }
    : dateTimeField(values.end, timezone, false);
  if (start.error) errors.start = start.error;
  if (end.error) errors.end = end.error;
  if (start.iso && end.iso && Date.parse(end.iso) <= Date.parse(start.iso)) {
    errors.end = "The end must be after the start.";
  }

  const body: CreateTripBody = { name, timezone };
  if (destination.length > 0) body.destination_summary = destination;
  if (start.iso) body.start_at = start.iso;
  if (end.iso) body.end_at = end.iso;
  return finish(errors, body);
}

/** Only the fields that differ from the stored trip, ready for PATCH. Empty when nothing changed. */
export function tripChanges(
  original: Trip,
  next: CreateTripBody,
): UpdateTripBody {
  const changes: UpdateTripBody = {};
  if (next.name !== original.name) changes.name = next.name;
  const destination = next.destination_summary ?? null;
  if (destination !== (original.destination_summary ?? null)) {
    changes.destination_summary = destination;
  }
  const sameInstant = (left: string | null, right: string | null): boolean =>
    left === null || right === null
      ? left === right
      : Date.parse(left) === Date.parse(right);
  const start = next.start_at ?? null;
  if (!sameInstant(start, original.start_at)) changes.start_at = start;
  const end = next.end_at ?? null;
  if (!sameInstant(end, original.end_at)) changes.end_at = end;
  if (next.timezone !== original.timezone) changes.timezone = next.timezone;
  return changes;
}

// --- context points -----------------------------------------------------------

export interface ContextPointFormValues {
  type: ContextPointType;
  label: string;
  address: string;
  latitude: string;
  longitude: string;
  timezone: string;
  placeId: string;
}

export type ContextPointField =
  "label" | "address" | "latitude" | "longitude" | "timezone" | "placeId";

function coordinate(
  raw: string,
  limit: number,
  name: string,
): { value: number | null; error: string | null } {
  const text = raw.trim();
  if (text.length === 0) return { value: null, error: null };
  const value = Number(text);
  if (!Number.isFinite(value) || value < -limit || value > limit) {
    return {
      value: null,
      error: `${name} must be a number between -${limit} and ${limit}.`,
    };
  }
  return { value, error: null };
}

export function validateContextPointForm(
  values: ContextPointFormValues,
): Validation<CreateContextPointBody, ContextPointField> {
  const errors: FieldErrors<ContextPointField> = {};
  const label = values.label.trim();
  if (label.length === 0) errors.label = "Enter a name for this place.";
  else if (label.length > 160) errors.label = "Use at most 160 characters.";
  const address = values.address.trim();
  if (address.length > 500) errors.address = "Use at most 500 characters.";
  const timezoneError = checkTimezone(values.timezone);
  if (timezoneError) errors.timezone = timezoneError;

  const latitude = coordinate(values.latitude, 90, "Latitude");
  const longitude = coordinate(values.longitude, 180, "Longitude");
  if (latitude.error) errors.latitude = latitude.error;
  if (longitude.error) errors.longitude = longitude.error;
  if (!latitude.error && !longitude.error) {
    if (latitude.value !== null && longitude.value === null) {
      errors.longitude = "Add the longitude too, or clear the latitude.";
    }
    if (longitude.value !== null && latitude.value === null) {
      errors.latitude = "Add the latitude too, or clear the longitude.";
    }
  }
  const placeId = values.placeId.trim();

  const body: CreateContextPointBody = {
    type: values.type,
    label,
    timezone: values.timezone.trim(),
  };
  if (address.length > 0) body.address = address;
  if (latitude.value !== null && longitude.value !== null) {
    body.latitude = latitude.value;
    body.longitude = longitude.value;
  }
  if (placeId.length > 0) body.external_place_id = placeId;
  return finish(errors, body);
}

export function validateResolveForm(
  values: Omit<ContextPointFormValues, "type">,
): Validation<ResolveContextPointBody, ContextPointField> {
  const errors: FieldErrors<ContextPointField> = {};
  const label = values.label.trim();
  if (label.length > 160) errors.label = "Use at most 160 characters.";
  const address = values.address.trim();
  if (address.length > 500) errors.address = "Use at most 500 characters.";
  const timezoneError = checkTimezone(values.timezone);
  if (timezoneError) errors.timezone = timezoneError;
  const latitude = coordinate(values.latitude, 90, "Latitude");
  const longitude = coordinate(values.longitude, 180, "Longitude");
  if (latitude.error) errors.latitude = latitude.error;
  else if (latitude.value === null) errors.latitude = "Enter the latitude.";
  if (longitude.error) errors.longitude = longitude.error;
  else if (longitude.value === null) errors.longitude = "Enter the longitude.";
  const placeId = values.placeId.trim();
  if (placeId.length === 0) errors.placeId = "Enter the place reference.";

  const body: ResolveContextPointBody = {
    latitude: latitude.value ?? 0,
    longitude: longitude.value ?? 0,
    timezone: values.timezone.trim(),
    external_place_id: placeId,
  };
  if (label.length > 0) body.label = label;
  if (address.length > 0) body.address = address;
  return finish(errors, body);
}

// --- agenda items and journey legs --------------------------------------------

export interface AgendaFormValues {
  title: string;
  type: AgendaType;
  start: string;
  end: string;
  timezone: string;
  contextPointId: string;
}

export type AgendaField = "title" | "start" | "end" | "timezone";

export function validateAgendaForm(
  values: AgendaFormValues,
): Validation<CreateAgendaItemBody, AgendaField> {
  const errors: FieldErrors<AgendaField> = {};
  const title = values.title.trim();
  if (title.length === 0) errors.title = "Enter a title.";
  const timezoneError = checkTimezone(values.timezone);
  if (timezoneError) errors.timezone = timezoneError;
  const timezone = values.timezone.trim();
  const start = timezoneError
    ? { iso: null, error: null }
    : dateTimeField(values.start, timezone, true);
  const end = timezoneError
    ? { iso: null, error: null }
    : dateTimeField(values.end, timezone, true);
  if (start.error) errors.start = start.error;
  if (end.error) errors.end = end.error;
  if (start.iso && end.iso && Date.parse(end.iso) <= Date.parse(start.iso)) {
    errors.end = "The end must be after the start.";
  }
  const body: CreateAgendaItemBody = {
    title,
    type: values.type,
    start_at: start.iso ?? "",
    end_at: end.iso ?? "",
    timezone,
  };
  if (values.contextPointId.length > 0) {
    body.context_point_id = values.contextPointId;
  }
  return finish(errors, body);
}

export interface JourneyLegFormValues {
  origin: string;
  destination: string;
  departure: string;
  deadline: string;
  /** Zone used to read the departure and deadline: the trip timezone. */
  timezone: string;
}

export type JourneyLegField =
  "origin" | "destination" | "departure" | "deadline";

export function validateJourneyLegForm(
  values: JourneyLegFormValues,
): Validation<CreateJourneyLegBody, JourneyLegField> {
  const errors: FieldErrors<JourneyLegField> = {};
  if (values.origin.length === 0)
    errors.origin = "Choose where the trip starts.";
  if (values.destination.length === 0) {
    errors.destination = "Choose where the trip ends.";
  }
  if (values.origin.length > 0 && values.origin === values.destination) {
    errors.destination = "Origin and destination must be different places.";
  }
  const departure = dateTimeField(values.departure, values.timezone, true);
  const deadline = dateTimeField(values.deadline, values.timezone, false);
  if (departure.error) errors.departure = departure.error;
  if (deadline.error) errors.deadline = deadline.error;
  if (
    departure.iso &&
    deadline.iso &&
    Date.parse(deadline.iso) < Date.parse(departure.iso)
  ) {
    errors.deadline = "The arrival deadline cannot be before the departure.";
  }
  const body: CreateJourneyLegBody = {
    origin_context_point_id: values.origin,
    destination_context_point_id: values.destination,
    departure_at: departure.iso ?? "",
  };
  if (deadline.iso) body.arrival_deadline = deadline.iso;
  return finish(errors, body);
}
