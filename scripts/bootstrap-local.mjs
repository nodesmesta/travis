#!/usr/bin/env node
// Prepares the local Supabase stack for the core demo (Task 07 prerequisite).
//
// - Reads local Supabase connection values from `supabase status -o env`.
// - Ensures the demo Auth user exists with a known password (idempotent).
// - Applies supabase/seed.sql (idempotent) and verifies the demo trip is visible.
// - Writes .env.local (git-ignored) for API and web, preserving provider keys
//   that are already set there.
//
// It never deletes data. For a clean-state run use `npm run db:reset:local`
// first, then run this script again.
//
// Local only: it refuses to run against a non-loopback Supabase URL because it
// uses the service-role key.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env.local");
const demoEmail = process.env.DEMO_EMAIL ?? "demo@travelflow.local";
const demoTripId = "00000000-0000-0000-0000-000000000001";

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function isEnvKey(key) {
  if (key.length === 0) return false;
  for (const char of key) {
    const upper = char >= "A" && char <= "Z";
    const digit = char >= "0" && char <= "9";
    if (!upper && !digit && char !== "_") return false;
  }
  return true;
}

/** Splits `KEY=value` at the first `=`; returns null when the key is not UPPER_SNAKE_CASE. */
function splitAssignment(line) {
  const equals = line.indexOf("=");
  if (equals < 0) return null;
  const key = line.slice(0, equals);
  return isEnvKey(key) ? { key, value: line.slice(equals + 1) } : null;
}

function unquote(value) {
  let result = value;
  if (result.startsWith('"')) result = result.slice(1);
  if (result.endsWith('"')) result = result.slice(0, -1);
  return result;
}

function projectIdFrom(config) {
  for (const line of config.split("\n")) {
    if (!line.startsWith("project_id")) continue;
    const rest = line.slice("project_id".length).trimStart();
    if (!rest.startsWith("=")) continue;
    const value = rest.slice(1).trimStart();
    if (!value.startsWith('"')) continue;
    const end = value.indexOf('"', 1);
    if (end > 1) return value.slice(1, end);
  }
  return undefined;
}

function parseEnvFile(path) {
  const values = new Map();
  if (!existsSync(path)) return values;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const entry = splitAssignment(line.trim());
    if (entry) values.set(entry.key, entry.value);
  }
  return values;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.error) fail(`${command} could not run: ${result.error.message}`);
  return result;
}

function readSupabaseStatus() {
  const result = run("supabase", ["status", "-o", "env"]);
  if (result.status !== 0) {
    fail(
      "`supabase status` failed. Start the local stack with `supabase start` first.",
    );
  }
  const values = new Map();
  for (const line of result.stdout.split("\n")) {
    const entry = splitAssignment(line.trim());
    if (entry) values.set(entry.key, unquote(entry.value));
  }
  return values;
}

const existing = parseEnvFile(envPath);
const status = readSupabaseStatus();

const supabaseUrl = status.get("API_URL");
const anonKey = status.get("ANON_KEY");
const serviceRoleKey = status.get("SERVICE_ROLE_KEY");
if (!supabaseUrl || !anonKey || !serviceRoleKey) {
  fail(
    "Supabase status did not return API_URL, ANON_KEY, and SERVICE_ROLE_KEY.",
  );
}
const host = new URL(supabaseUrl).hostname;
if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
  fail(`Refusing to run against non-local Supabase host: ${host}`);
}

const demoPassword =
  process.env.DEMO_PASSWORD ??
  existing.get("DEMO_PASSWORD") ??
  randomBytes(18).toString("base64url");

async function adminRequest(path, init = {}) {
  const response = await fetch(`${supabaseUrl}/auth/v1/admin${path}`, {
    ...init,
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

async function ensureDemoUser() {
  const list = await adminRequest("/users?per_page=200");
  if (list.status !== 200)
    fail(`Auth admin list failed (HTTP ${list.status}).`);
  const user = (list.body?.users ?? []).find(
    (item) => item.email === demoEmail,
  );

  if (!user) {
    const created = await adminRequest("/users", {
      method: "POST",
      body: JSON.stringify({
        email: demoEmail,
        password: demoPassword,
        email_confirm: true,
      }),
    });
    if (created.status !== 200 && created.status !== 201) {
      fail(`Demo user creation failed (HTTP ${created.status}).`);
    }
    console.log(`PASS: created demo user ${demoEmail}`);
    return;
  }

  const updated = await adminRequest(`/users/${user.id}`, {
    method: "PUT",
    body: JSON.stringify({ password: demoPassword, email_confirm: true }),
  });
  if (updated.status !== 200) {
    fail(`Demo user password sync failed (HTTP ${updated.status}).`);
  }
  console.log(
    `PASS: demo user ${demoEmail} exists; password synced to .env.local`,
  );
}

function applySeed() {
  // `supabase db query` rejects multi-statement files, so run psql inside the
  // local Supabase database container.
  const config = readFileSync(join(root, "supabase", "config.toml"), "utf8");
  const projectId = projectIdFrom(config);
  if (!projectId) fail("project_id not found in supabase/config.toml.");

  const result = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      `supabase_db_${projectId}`,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-q",
    ],
    {
      cwd: root,
      encoding: "utf8",
      input: readFileSync(join(root, "supabase", "seed.sql"), "utf8"),
    },
  );
  if (result.error) fail(`docker could not run: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`seed.sql failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  console.log("PASS: seed.sql applied");
}

async function verifyDemoTrip() {
  const login = await fetch(
    `${supabaseUrl}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: { apikey: anonKey, "content-type": "application/json" },
      body: JSON.stringify({ email: demoEmail, password: demoPassword }),
    },
  );
  if (login.status !== 200) fail(`Demo login failed (HTTP ${login.status}).`);
  const { access_token: token } = await login.json();

  const headers = { apikey: anonKey, authorization: `Bearer ${token}` };
  const trips = await fetch(
    `${supabaseUrl}/rest/v1/trips?id=eq.${demoTripId}&select=id,name,timezone`,
    { headers },
  );
  const tripRows = trips.status === 200 ? await trips.json() : [];
  if (tripRows.length !== 1) fail("Demo trip is not visible to the demo user.");

  const points = await fetch(
    `${supabaseUrl}/rest/v1/context_points?trip_id=eq.${demoTripId}&select=id`,
    { headers },
  );
  const pointRows = points.status === 200 ? await points.json() : [];
  if (pointRows.length < 1) fail("Demo trip has no context points.");

  console.log(
    `PASS: demo login works; trip "${tripRows[0].name}" (${tripRows[0].timezone}) has ${pointRows.length} context points`,
  );
}

function mailpitAddress() {
  const config = readFileSync(join(root, "supabase", "config.toml"), "utf8");
  const projectId = projectIdFrom(config);
  if (!projectId) return null;
  const result = spawnSync(
    "docker",
    [
      "inspect",
      "-f",
      "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
      `supabase_inbucket_${projectId}`,
    ],
    { encoding: "utf8" },
  );
  const address = result.status === 0 ? result.stdout.trim() : "";
  return address.length > 0 ? address : null;
}

function writeEnvFile() {
  const managed = new Map([
    ["NODE_ENV", "development"],
    ["API_HOST", "127.0.0.1"],
    ["API_PORT", existing.get("API_PORT") ?? "4000"],
    ["SUPABASE_URL", supabaseUrl],
    ["SUPABASE_ANON_KEY", anonKey],
    ["SUPABASE_SERVICE_ROLE_KEY", serviceRoleKey],
    ["NEXT_PUBLIC_SUPABASE_URL", supabaseUrl],
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", anonKey],
    [
      "NEXT_PUBLIC_API_BASE_URL",
      `http://localhost:${existing.get("API_PORT") ?? "4000"}/api/v1`,
    ],
    ["DEMO_EMAIL", demoEmail],
    ["DEMO_PASSWORD", demoPassword],
    // Local only: shows the email and password form next to "Continue with Google".
    // The browser test scripts cannot drive Google's consent screen. Production builds
    // never set this, so the deployed app has Google sign-in only.
    ["NEXT_PUBLIC_ENABLE_PASSWORD_LOGIN", "true"],
  ]);
  // Provider keys are owned by the developer. Every key that is not managed above is
  // kept as it is, so a re-run never drops a setting (EMAIL_*, SMTP_*, WORKER_*, ...).
  const defaults = new Map([
    ["BRIGHT_DATA_API_KEY", ""],
    ["BRIGHT_DATA_SERP_ZONE", ""],
    ["BRIGHT_DATA_UNLOCKER_ZONE", ""],
    ["BRIGHT_DATA_TIMEOUT_MS", "60000"],
    ["EVENT_DISCOVERY_TTL_HOURS", "6"],
    ["VULTR_INFERENCE_BASE_URL", "https://api.vultrinference.com/v1"],
    ["VULTR_INFERENCE_API_KEY", ""],
    ["VULTR_INFERENCE_MODEL", "deepseek-v4.1-flash-1017"],
    ["HERE_API_KEY", ""],
    ["OPENWEATHER_API_KEY", ""],
    ["EMAIL_PROVIDER", "smtp"],
    ["EMAIL_FROM", "TravelFlow <invoices@travelflow.local>"],
    ["EMAIL_PROVIDER_API_KEY", ""],
    ["SMTP_PORT", "1025"],
    ["CORS_ALLOWED_ORIGINS", "http://localhost:3000"],
  ]);
  const unmanaged = new Map();
  for (const [key, value] of existing) {
    if (!managed.has(key)) unmanaged.set(key, value);
  }
  for (const [key, value] of defaults) {
    if (!unmanaged.has(key)) unmanaged.set(key, value);
  }
  // The local Mailpit container is not published on the host, so SMTP goes to its
  // address on the Docker network. That address changes when the stack is recreated.
  const mailpit = mailpitAddress();
  if (mailpit) unmanaged.set("SMTP_HOST", mailpit);
  const lines = [
    "# Generated by scripts/bootstrap-local.mjs. Git-ignored. Do not commit.",
  ];
  for (const [key, value] of managed) lines.push(`${key}=${value}`);
  lines.push("", "# Provider keys and other settings: kept on re-run.");
  for (const [key, value] of unmanaged) lines.push(`${key}=${value}`);
  writeFileSync(envPath, `${lines.join("\n")}\n`, { mode: 0o600 });
  chmodSync(envPath, 0o600);
  console.log("PASS: wrote .env.local (mode 600)");
}

await ensureDemoUser();
applySeed();
await verifyDemoTrip();
writeEnvFile();

const missing = ["BRIGHT_DATA_API_KEY", "BRIGHT_DATA_SERP_ZONE"].filter(
  (key) => !existing.get(key),
);
if (missing.length > 0) {
  console.log(
    `NOTE: set ${missing.join(", ")} in .env.local before running live event discovery.`,
  );
}
console.log("Done. Start with: npm run build && npm run start:api:local");
