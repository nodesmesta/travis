import { JobError } from "./types.js";

/**
 * Time zone helpers built on Intl. A job time is always an absolute instant;
 * the zone only decides how that instant is written in keys and in text the
 * user reads, so a daylight-saving change cannot move a reminder.
 */

const MINUTE_MS = 60_000;

export function assertIanaZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
  } catch {
    throw new JobError(
      "JOB_PAYLOAD_INVALID",
      `"${timeZone}" is not a valid IANA time zone.`,
    );
  }
}

/** Offset of the zone from UTC at an instant, in minutes. East of UTC is positive. */
export function zoneOffsetMinutes(ms: number, timeZone: string): number {
  assertIanaZone(timeZone);
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
    year: "numeric",
  })
    .formatToParts(new Date(ms))
    .find((part) => part.type === "timeZoneName")?.value;
  if (name === undefined || !name.startsWith("GMT")) {
    throw new JobError(
      "JOB_INTERNAL_ERROR",
      `The offset of "${timeZone}" could not be determined.`,
    );
  }
  const rest = name.slice(3);
  if (rest.length === 0) return 0;
  const sign = rest[0] === "-" || rest[0] === "\u2212" ? -1 : 1;
  const [hours, minutes] = rest.slice(1).split(":");
  return sign * (Number(hours) * 60 + Number(minutes ?? "0"));
}

function two(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function offsetSuffix(offsetMinutes: number, separator: string): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  return `${sign}${two(Math.floor(absolute / 60))}${separator}${two(absolute % 60)}`;
}

/** `2026-11-12T07:15:00+07:00`: the instant written on the wall clock of the zone. */
export function localIso(ms: number, timeZone: string): string {
  const offset = zoneOffsetMinutes(ms, timeZone);
  const shifted = new Date(ms + offset * MINUTE_MS);
  return (
    `${shifted.getUTCFullYear()}-${two(shifted.getUTCMonth() + 1)}-${two(shifted.getUTCDate())}` +
    `T${two(shifted.getUTCHours())}:${two(shifted.getUTCMinutes())}:${two(shifted.getUTCSeconds())}` +
    offsetSuffix(offset, ":")
  );
}

/** `Thu 12 Nov, 07:45 (UTC+07:00)` for text the user reads. */
export function localLabel(ms: number, timeZone: string): string {
  assertIanaZone(timeZone);
  const text = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));
  return `${text} (UTC${offsetSuffix(zoneOffsetMinutes(ms, timeZone), ":")})`;
}

/** Start of the interval that contains the instant, for slot based job keys. */
export function floorToInterval(ms: number, intervalMinutes: number): number {
  const interval = intervalMinutes * MINUTE_MS;
  return Math.floor(ms / interval) * interval;
}

export function parseInstant(value: string, field: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new JobError(
      "JOB_PAYLOAD_INVALID",
      `${field} is not a valid date-time.`,
    );
  }
  return ms;
}
