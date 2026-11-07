import type { LogLevel } from "./config.js";

const levelRank: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SENSITIVE_KEY_PARTS = [
  "authorization",
  "cookie",
  "password",
  "secret",
  "token",
  "apikey",
  "api_key",
  "api-key",
];

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_PARTS.some((part) => lower.includes(part));
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        isSensitiveKey(key) ? "[REDACTED]" : sanitize(entry),
      ]),
    );
  }
  return value;
}

export interface Logger {
  debug(event: string, metadata?: Record<string, unknown>): void;
  info(event: string, metadata?: Record<string, unknown>): void;
  warn(event: string, metadata?: Record<string, unknown>): void;
  error(event: string, metadata?: Record<string, unknown>): void;
}

export function createLogger(configuredLevel: LogLevel): Logger {
  const threshold = levelRank[configuredLevel];

  function write(
    level: LogLevel,
    event: string,
    metadata: Record<string, unknown> = {},
  ): void {
    if (levelRank[level] < threshold) {
      return;
    }
    const sanitizedMetadata = sanitize(metadata);
    const safeMetadata =
      sanitizedMetadata && typeof sanitizedMetadata === "object"
        ? (sanitizedMetadata as Record<string, unknown>)
        : {};
    process.stdout.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        event,
        ...safeMetadata,
      })}\n`,
    );
  }

  return {
    debug: (event, metadata) => write("debug", event, metadata),
    info: (event, metadata) => write("info", event, metadata),
    warn: (event, metadata) => write("warn", event, metadata),
    error: (event, metadata) => write("error", event, metadata),
  };
}
