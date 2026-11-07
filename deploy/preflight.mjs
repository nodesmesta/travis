// Container start gate. Usage: node deploy/preflight.mjs <api|worker>
//
// Policy (no fallback): when required configuration is missing or unsafe the
// process exits with code 1 and a structured error that names every problem.
// It never substitutes a default for a missing secret or URL. When the checks
// pass it loads the service entry point in the same process, so the service
// receives signals directly and keeps its own logging.
//
// This file contains no regular expressions (see plan/tasks/CONVENTIONS.md).

import { pathToFileURL } from "node:url";

const service = process.argv[2];

const SERVICES = {
  api: {
    entry: "/app/apps/api/dist/index.js",
    required: [
      "SUPABASE_URL",
      "SUPABASE_ANON_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "CORS_ALLOWED_ORIGINS",
    ],
    urls: ["SUPABASE_URL"],
  },
  worker: {
    entry: "/app/apps/worker/dist/index.js",
    required: ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"],
    urls: ["SUPABASE_URL"],
  },
};

function fail(problems) {
  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      event: "preflight.failed",
      service,
      problems,
      hint: "Fix the variables above in the environment file (see deploy/.env.production.example). The container does not start with missing or unsafe configuration.",
    })}\n`,
  );
  process.exit(1);
}

function isBlank(value) {
  return value === undefined || value.trim() === "";
}

const spec = SERVICES[service];
if (spec === undefined) {
  fail([`unknown service "${String(service)}", expected api or worker`]);
}

const env = process.env;
const problems = [];

if (env.NODE_ENV !== "production") {
  problems.push(
    `NODE_ENV must be "production" (got ${isBlank(env.NODE_ENV) ? "nothing" : `"${env.NODE_ENV}"`})`,
  );
}

const extra = isBlank(env.DEPLOY_REQUIRED_ENV)
  ? []
  : env.DEPLOY_REQUIRED_ENV.split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0);

for (const name of [...spec.required, ...extra]) {
  if (isBlank(env[name])) problems.push(`${name} is required and is empty`);
}

for (const name of spec.urls) {
  const value = env[name];
  if (isBlank(value)) continue;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      problems.push(`${name} must be an http or https URL`);
    }
  } catch {
    problems.push(`${name} is not a valid URL`);
  }
}

// Test hooks replace provider hosts. apps/api/src/config.ts rejects them in
// production too; this reports every one of them before the service starts.
for (const name of Object.keys(env).sort()) {
  if (name.endsWith("_OVERRIDE") && !isBlank(env[name])) {
    problems.push(`${name} is a test hook and is not allowed in production`);
  }
}

if (problems.length > 0) fail(problems);

const providerKeys = [
  "VULTR_INFERENCE_API_KEY",
  "BRIGHT_DATA_API_KEY",
  "HERE_API_KEY",
  "OPENWEATHER_API_KEY",
];
const unconfigured = providerKeys.filter((name) => isBlank(env[name]));
if (unconfigured.length > 0) {
  // Not fatal by default: the related features answer with a structured
  // "not configured" error. List them in DEPLOY_REQUIRED_ENV to make them fatal.
  process.stdout.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "warn",
      event: "preflight.provider_not_configured",
      service,
      variables: unconfigured,
    })}\n`,
  );
}

process.stdout.write(
  `${JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "info",
    event: "preflight.passed",
    service,
  })}\n`,
);

await import(pathToFileURL(spec.entry).href);
