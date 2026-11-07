import { isClockTime, isIsoDate } from "./schema.js";

/** Time-zone helpers built on Intl. No regular expressions. */

export function assertKnownTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
  } catch {
    throw new RangeError(`Unknown time zone: ${timeZone}`);
  }
}

/** Offset of `timeZone` from UTC, in minutes, at the given instant. */
export function offsetMinutesAt(timeZone: string, instantMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  }).formatToParts(new Date(instantMs));
  const name = parts.find((part) => part.type === "timeZoneName")?.value ?? "";
  if (name === "GMT" || name === "UTC") return 0;
  const sign = name[3] === "-" ? -1 : 1;
  const hours = Number(name.slice(4, 6));
  const minutes = Number(name.slice(7, 9));
  if (!name.startsWith("GMT") || Number.isNaN(hours) || Number.isNaN(minutes)) {
    throw new RangeError(`Unreadable offset for ${timeZone}`);
  }
  return sign * (hours * 60 + minutes);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  return `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

/** Local `YYYY-MM-DD` + `HH:MM` in `timeZone` as an ISO-8601 string with offset. */
export function zonedDateTimeToIso(
  date: string,
  time: string,
  timeZone: string,
): string {
  if (!isIsoDate(date) || !isClockTime(time)) {
    throw new RangeError("date must be YYYY-MM-DD and time must be HH:MM");
  }
  const nominal = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
    Number(time.slice(0, 2)),
    Number(time.slice(3, 5)),
  );
  const firstOffset = offsetMinutesAt(timeZone, nominal);
  let offset = offsetMinutesAt(timeZone, nominal - firstOffset * 60_000);
  if (offset !== firstOffset) {
    offset = offsetMinutesAt(timeZone, nominal - offset * 60_000);
  }
  return `${date}T${time}:00${formatOffset(offset)}`;
}

/** Calendar date (`YYYY-MM-DD`) of `now` in `timeZone`. */
export function dateInZone(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const pick = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

/** Human-readable local time, for example `Nov 12, 2026, 6:30 PM`. */
export function formatInZone(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(new Date(iso));
}
