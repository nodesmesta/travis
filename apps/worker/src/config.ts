import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { isUuid } from "@travelflow/domain";
import { loadConfig, type ApiConfig } from "@travelflow/api/shared";

export interface WorkerConfig {
  /** Provider keys, timeouts, and Supabase connection, read the same way as in the API. */
  api: ApiConfig;
  workerId: string;
  /** Jobs this process runs at the same time. */
  concurrency: number;
  pollIntervalMs: number;
  scheduleIntervalMs: number;
  leaseSeconds: number;
  heartbeatIntervalMs: number;
  jobTimeoutMs: number;
  shutdownGraceMs: number;
  /** When not empty, the scheduler plans jobs only for these trips. Empty means every confirmed or active trip. */
  tripIds: string[];
}

function readTripIds(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") return [];
  const ids = value.split(",").map((entry) => entry.trim());
  for (const id of ids) {
    if (!isUuid(id))
      throw new Error(
        "WORKER_TRIP_IDS must be a comma separated list of UUIDs",
      );
  }
  return ids;
}

function readInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function loadWorkerConfig(
  env: NodeJS.ProcessEnv = process.env,
): WorkerConfig {
  const leaseSeconds = readInteger(env, "WORKER_LEASE_SECONDS", 60, 10, 3600);
  const heartbeatIntervalMs = readInteger(
    env,
    "WORKER_HEARTBEAT_INTERVAL_MS",
    15_000,
    1000,
    600_000,
  );
  if (heartbeatIntervalMs * 2 > leaseSeconds * 1000) {
    throw new Error(
      "WORKER_HEARTBEAT_INTERVAL_MS must be at most half of WORKER_LEASE_SECONDS",
    );
  }
  const configuredId = env.WORKER_ID;
  return {
    api: loadConfig(env),
    // The random suffix keeps two processes on one host apart.
    workerId:
      configuredId && configuredId.length > 0
        ? configuredId
        : `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`,
    concurrency: readInteger(env, "WORKER_CONCURRENCY", 2, 1, 16),
    pollIntervalMs: readInteger(
      env,
      "WORKER_POLL_INTERVAL_MS",
      2000,
      100,
      60_000,
    ),
    scheduleIntervalMs: readInteger(
      env,
      "WORKER_SCHEDULE_INTERVAL_MS",
      60_000,
      1000,
      3_600_000,
    ),
    leaseSeconds,
    heartbeatIntervalMs,
    jobTimeoutMs: readInteger(
      env,
      "WORKER_JOB_TIMEOUT_MS",
      120_000,
      1000,
      3_600_000,
    ),
    shutdownGraceMs: readInteger(
      env,
      "WORKER_SHUTDOWN_GRACE_MS",
      20_000,
      0,
      600_000,
    ),
    tripIds: readTripIds(env.WORKER_TRIP_IDS),
  };
}
