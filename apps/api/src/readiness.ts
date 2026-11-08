import { createAdminSupabaseClient } from "./supabase/client.js";
import type { ApiConfig } from "./config.js";

/**
 * Readiness answers one question: can this instance serve a real request now?
 * `/health` only says the process is up. A database that is down, an Auth
 * service that does not answer, or a missing invoices bucket makes the
 * instance not ready, and the answer says which check failed.
 *
 * Nothing here calls a paid provider. Provider keys are reported as
 * configured or missing; provider connectivity is tested by
 * `npm run smoke:providers`.
 */

export type CheckStatus = "ok" | "failing" | "not_configured";

export interface ReadinessCheck {
  status: CheckStatus;
  /** Short, safe code for failing checks. Never a raw error message. */
  code?: string;
  detail?: Record<string, unknown>;
}

export interface ReadinessResult {
  status: "ready" | "not_ready";
  checks: Record<string, ReadinessCheck>;
}

/** The I/O behind each check. Production code uses the Supabase implementation. */
export interface ReadinessProbes {
  database(): Promise<void>;
  auth(): Promise<void>;
  storage(): Promise<void>;
  /** Number of queued jobs that are overdue by more than `staleSeconds`. */
  overdueJobs(staleSeconds: number): Promise<number>;
}

const PROBE_TIMEOUT_MS = 4000;

async function within<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out`)),
      PROBE_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function supabaseProbes(
  config: ApiConfig,
  fetchImpl: typeof fetch = fetch,
): ReadinessProbes | null {
  if (
    !config.supabaseUrl ||
    !config.supabaseAnonKey ||
    !config.supabaseServiceRoleKey
  ) {
    return null;
  }
  const url = config.supabaseUrl;
  const anonKey = config.supabaseAnonKey;
  const admin = createAdminSupabaseClient({
    supabaseUrl: config.supabaseUrl,
    supabaseAnonKey: config.supabaseAnonKey,
    supabaseServiceRoleKey: config.supabaseServiceRoleKey,
  });
  return {
    async database() {
      const { error } = await within(
        Promise.resolve(
          admin.from("trips").select("id", { head: true, count: "exact" }),
        ),
        "database",
      );
      if (error) throw new Error("database query failed");
    },
    async auth() {
      const response = await within(
        fetchImpl(`${url}/auth/v1/health`, { headers: { apikey: anonKey } }),
        "auth",
      );
      if (!response.ok) throw new Error(`auth answered ${response.status}`);
    },
    async storage() {
      const { data, error } = await within(
        admin.storage.getBucket("invoices"),
        "storage",
      );
      if (error || !data) throw new Error("invoices bucket is not available");
      if (data.public) throw new Error("invoices bucket is public");
    },
    async overdueJobs(staleSeconds) {
      const cutoff = new Date(Date.now() - staleSeconds * 1000).toISOString();
      const { count, error } = await within(
        Promise.resolve(
          admin
            .from("background_jobs")
            .select("id", { head: true, count: "exact" })
            .eq("status", "queued")
            .lt("run_at", cutoff),
        ),
        "jobs",
      );
      if (error) throw new Error("job query failed");
      return count ?? 0;
    },
  };
}

async function run(
  work: () => Promise<void>,
  code: string,
): Promise<ReadinessCheck> {
  try {
    await work();
    return { status: "ok" };
  } catch {
    return { status: "failing", code };
  }
}

export async function checkReadiness(
  config: ApiConfig,
  probes: ReadinessProbes | null,
): Promise<ReadinessResult> {
  const checks: Record<string, ReadinessCheck> = {};

  if (!probes) {
    const missing: string[] = [];
    if (!config.supabaseUrl) missing.push("SUPABASE_URL");
    if (!config.supabaseAnonKey) missing.push("SUPABASE_ANON_KEY");
    if (!config.supabaseServiceRoleKey) {
      missing.push("SUPABASE_SERVICE_ROLE_KEY");
    }
    const failing: ReadinessCheck = {
      status: "failing",
      code: "CONFIGURATION_MISSING",
      detail: { missing },
    };
    checks.configuration = failing;
    checks.database = { status: "failing", code: "NOT_CHECKED" };
    checks.auth = { status: "failing", code: "NOT_CHECKED" };
    checks.storage = { status: "failing", code: "NOT_CHECKED" };
    checks.worker = { status: "failing", code: "NOT_CHECKED" };
  } else {
    checks.configuration = { status: "ok" };
    const [database, auth, storage] = await Promise.all([
      run(() => probes.database(), "DATABASE_UNREACHABLE"),
      run(() => probes.auth(), "AUTH_UNREACHABLE"),
      run(() => probes.storage(), "STORAGE_UNAVAILABLE"),
    ]);
    checks.database = database;
    checks.auth = auth;
    checks.storage = storage;
    // The worker has no network port, so its health is read from the queue:
    // jobs that stay queued past their run time mean nothing is claiming them.
    try {
      const overdue = await probes.overdueJobs(config.readyJobStaleSeconds);
      checks.worker =
        overdue === 0
          ? { status: "ok" }
          : {
              status: "failing",
              code: "WORKER_BACKLOG",
              detail: {
                overdue_jobs: overdue,
                stale_after_seconds: config.readyJobStaleSeconds,
              },
            };
    } catch {
      checks.worker = { status: "failing", code: "JOBS_UNREADABLE" };
    }
  }

  // Provider keys: configured or not. A missing key does not stop the instance
  // from serving; the use cases that need it fail with an explicit error.
  const configured = (value: string | undefined): CheckStatus =>
    value ? "ok" : "not_configured";
  checks.providers = {
    status: "ok",
    detail: {
      bright_data: configured(
        config.brightDataApiKey && config.brightDataSerpZone
          ? "set"
          : undefined,
      ),
      vultr_inference: configured(config.vultrInferenceApiKey),
      here: configured(config.hereApiKey),
      openweather: configured(config.openWeatherApiKey),
      email: configured(
        config.emailProvider === "resend"
          ? config.emailProviderApiKey
          : config.emailProvider
            ? "smtp"
            : undefined,
      ),
    },
  };

  const failing = Object.values(checks).some(
    (check) => check.status === "failing",
  );
  return { status: failing ? "not_ready" : "ready", checks };
}
