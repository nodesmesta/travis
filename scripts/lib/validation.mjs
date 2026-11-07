// Shared helpers for scripts/validate-task-NN.mjs.
//
// Environment comes from `.env.local` (created by `npm run bootstrap:local`).
// Run a validator with:  node --env-file=.env.local scripts/validate-task-NN.mjs
//
// A validator must exit non-zero when any check fails, and it must print BLOCKED
// (not PASS) for a check that cannot run because a prerequisite is missing.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export const env = process.env;

export function requireEnv(...names) {
  const missing = names.filter((name) => !env[name]);
  if (missing.length > 0) {
    console.error(`Missing environment variables: ${missing.join(", ")}`);
    process.exit(2);
  }
}

export const apiBase = () =>
  env.API_BASE_URL ??
  `http://${env.API_HOST ?? "127.0.0.1"}:${env.API_PORT ?? "4000"}/api/v1`;

const results = [];

export async function check(name, fn) {
  try {
    await fn();
    results.push({ name, status: "PASS" });
    console.log(`PASS: ${name}`);
  } catch (error) {
    results.push({ name, status: "FAIL", error });
    console.log(`FAIL: ${name}`);
    console.log(
      `      ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function blocked(name, reason) {
  results.push({ name, status: "BLOCKED", reason });
  console.log(`BLOCKED: ${name} (${reason})`);
}

export const getResults = () =>
  results.map((entry) => ({
    ...entry,
    error: entry.error ? String(entry.error.message ?? entry.error) : undefined,
  }));

/** Prints the summary and sets the exit code. BLOCKED does not fail the run but is never reported as PASS. */
export function finish() {
  const failed = results.filter((r) => r.status === "FAIL").length;
  const blockedCount = results.filter((r) => r.status === "BLOCKED").length;
  const passed = results.filter((r) => r.status === "PASS").length;
  console.log(
    `\nRESULT: ${passed} passed, ${failed} failed, ${blockedCount} blocked`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

export async function signIn(email, password) {
  const response = await fetch(
    `${env.SUPABASE_URL}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({ email, password }),
    },
  );
  const body = await response.json();
  assert.equal(response.status, 200, `sign-in failed: ${JSON.stringify(body)}`);
  return body.access_token;
}

export async function demoToken() {
  requireEnv(
    "DEMO_EMAIL",
    "DEMO_PASSWORD",
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
  );
  return signIn(env.DEMO_EMAIL, env.DEMO_PASSWORD);
}

/**
 * Creates (or reuses) a second confirmed user through the Auth admin API and
 * returns its access token. Used for cross-user ownership checks.
 */
export async function otherUserToken() {
  requireEnv("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY");
  const email = "other-user@travelflow.local";
  const password = `Other-${randomUUID()}`;
  const admin = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "content-type": "application/json",
  };
  const created = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: admin,
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (created.status === 422 || created.status === 409) {
    const list = await fetch(
      `${env.SUPABASE_URL}/auth/v1/admin/users?per_page=200`,
      { headers: admin },
    );
    const body = await list.json();
    const existing = body.users.find((user) => user.email === email);
    assert.ok(existing, "other user exists but could not be found");
    const updated = await fetch(
      `${env.SUPABASE_URL}/auth/v1/admin/users/${existing.id}`,
      {
        method: "PUT",
        headers: admin,
        body: JSON.stringify({ password }),
      },
    );
    assert.equal(updated.status, 200);
  } else {
    assert.equal(created.status, 200, await created.text());
  }
  return signIn(email, password);
}

/** Calls the API. Mutations get a unique Idempotency-Key unless one is passed. */
export async function api(
  path,
  token,
  { method = "GET", body, headers = {}, idempotencyKey } = {},
) {
  const finalHeaders = { authorization: `Bearer ${token}`, ...headers };
  if (body !== undefined) finalHeaders["content-type"] = "application/json";
  if (method !== "GET" && !finalHeaders["idempotency-key"]) {
    finalHeaders["idempotency-key"] =
      idempotencyKey ?? `validator-${randomUUID()}`;
  }
  const response = await fetch(`${apiBase()}${path}`, {
    method,
    headers: finalHeaders,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return {
    status: response.status,
    body: json,
    text,
    headers: response.headers,
  };
}

export const DEMO_TRIP_ID = "00000000-0000-0000-0000-000000000001";

/** Runs SQL in the local Supabase database container (service level access). */
export async function sql(statement) {
  const { spawnSync } = await import("node:child_process");
  const container = env.SUPABASE_DB_CONTAINER ?? "supabase_db_vultr";
  const result = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-U",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
      "-F",
      "|",
    ],
    { input: statement, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr}`);
  return result.stdout.trim();
}
