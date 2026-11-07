// Date and timezone helpers for the Trip setup view. No regular expressions.
// A wall-clock time typed by the user ("2026-11-12T08:00") plus an IANA
// timezone becomes the ISO-8601 string with an explicit UTC offset that the
// API requires ("2026-11-12T08:00:00+07:00").

/** IANA names for the combobox. `UTC` is valid but missing from `supportedValuesOf`. */
export function supportedTimeZones(): string[] {
  const names = Intl.supportedValuesOf("timeZone");
  return names.includes("UTC") ? names : ["UTC", ...names];
}

/** True for an IANA name that `Intl` knows. A UTC offset such as `+07:00` is not accepted. */
export function isKnownTimeZone(value: string): boolean {
  const name = value.trim();
  if (name.length === 0) return false;
  const first = name[0];
  if (first === "+" || first === "-") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name }).format();
    return true;
  } catch {
    return false;
  }
}

function pad(value: number, length = 2): string {
  return String(Math.abs(value)).padStart(length, "0");
}

function isDigits(text: string | undefined, min: number, max: number): boolean {
  if (text === undefined || text.length < min || text.length > max) {
    return false;
  }
  for (const char of text) {
    if (char < "0" || char > "9") return false;
  }
  return true;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Parses `YYYY-MM-DDTHH:mm` or `YYYY-MM-DDTHH:mm:ss`. Null when it is not a real date and time. */
export function parseLocalDateTime(value: string): LocalParts | null {
  const [datePart, timePart, extra] = value.split("T");
  if (datePart === undefined || timePart === undefined || extra !== undefined) {
    return null;
  }
  const [year, month, day, dateExtra] = datePart.split("-");
  const [hour, minute, second, timeExtra] = timePart.split(":");
  if (
    dateExtra !== undefined ||
    timeExtra !== undefined ||
    !isDigits(year, 4, 4) ||
    !isDigits(month, 2, 2) ||
    !isDigits(day, 2, 2) ||
    !isDigits(hour, 2, 2) ||
    !isDigits(minute, 2, 2) ||
    (second !== undefined && !isDigits(second, 2, 2))
  ) {
    return null;
  }
  const parts: LocalParts = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: second === undefined ? 0 : Number(second),
  };
  const probe = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (
    probe.getUTCFullYear() !== parts.year ||
    probe.getUTCMonth() !== parts.month - 1 ||
    probe.getUTCDate() !== parts.day ||
    parts.hour > 23 ||
    parts.minute > 59 ||
    parts.second > 59
  ) {
    return null;
  }
  return parts;
}

/** The wall-clock time in `timeZone` at `instantMs`, expressed as if it were UTC. */
function wallClockAsUtc(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instantMs));
  const read = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  return Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    read("hour"),
    read("minute"),
    read("second"),
  );
}

/** Offset of `timeZone` from UTC, in minutes, at the given instant. */
function offsetMinutes(instantMs: number, timeZone: string): number {
  const whole = Math.floor(instantMs / 1000) * 1000;
  return Math.round((wallClockAsUtc(whole, timeZone) - whole) / 60000);
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  return `${sign}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`;
}

/**
 * Turns a wall-clock time in `timeZone` into an ISO string with that zone's UTC
 * offset. Returns null when the text is not a real date and time or the zone is
 * unknown. A wall-clock time that a daylight saving change skips is moved to the
 * nearest real time.
 */
export function zonedLocalToIso(
  local: string,
  timeZone: string,
): string | null {
  const parts = parseLocalDateTime(local);
  if (!parts || !isKnownTimeZone(timeZone)) return null;
  const zone = timeZone.trim();
  const wall = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  const firstGuess = wall - offsetMinutes(wall, zone) * 60000;
  const instant = wall - offsetMinutes(firstGuess, zone) * 60000;
  const offset = offsetMinutes(instant, zone);
  const shown = new Date(wallClockAsUtc(instant, zone));
  return `${pad(shown.getUTCFullYear(), 4)}-${pad(shown.getUTCMonth() + 1)}-${pad(shown.getUTCDate())}T${pad(shown.getUTCHours())}:${pad(shown.getUTCMinutes())}:${pad(shown.getUTCSeconds())}${formatOffset(offset)}`;
}

/** The `YYYY-MM-DDTHH:mm` wall-clock text of an instant in `timeZone`, for a date-time input. */
export function isoToZonedLocal(iso: string, timeZone: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms) || !isKnownTimeZone(timeZone)) return "";
  const shown = new Date(wallClockAsUtc(ms, timeZone.trim()));
  return `${pad(shown.getUTCFullYear(), 4)}-${pad(shown.getUTCMonth() + 1)}-${pad(shown.getUTCDate())}T${pad(shown.getUTCHours())}:${pad(shown.getUTCMinutes())}`;
}

/** Readable date and time in a zone, for example `12 Nov 2026, 08:00`. */
export function formatInZone(
  iso: string | null | undefined,
  timeZone: string,
): string {
  if (!iso) return "Not set";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "Not set";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(ms));
}
