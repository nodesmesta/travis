// Runs every task validator from the current state, one after another, each with its
// own API instance on a free port, and prints one table. Exit code 1 if any fails.
//
//   npm run build && npm run validate:all [-- --skip-live]
//
// Prerequisites: local Supabase running, `.env.local` from `npm run bootstrap:local`.
// Start from a clean database for a reproducible run:
//   supabase db reset --yes && npm run bootstrap:local
//
// Validators that start their own processes (task 07, 08 fixtures) are run as they are.
// A BLOCKED check is reported but does not fail the run; it is never counted as PASS.

import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { freePort, startApi, stopAll } from "./lib/harness.mjs";

const skipLive = process.argv.includes("--skip-live");
const root = new URL("..", import.meta.url).pathname;

const SUITES = [
  { name: "contracts", script: "scripts/validate-contracts.mjs", api: false },
  {
    name: "task 07 core demo",
    script: "scripts/validate-task-07.mjs",
    api: false,
    args: skipLive ? ["--skip-live", "--skip-smoke"] : [],
  },
  {
    name: "task 08 mobility",
    script: "scripts/validate-task-08.mjs",
    api: true,
  },
  {
    name: "task 09 assistant",
    script: "scripts/validate-task-09.mjs",
    api: true,
  },
  {
    name: "task 10 jobs and alerts",
    script: "scripts/validate-task-10.mjs",
    api: true,
  },
  {
    name: "task 11 invoices and email",
    script: "scripts/validate-task-11.mjs",
    api: true,
  },
  { name: "trip setup", script: "scripts/validate-task-trips.mjs", api: true },
];

function run(script, args, env) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--env-file=.env.local", script, ...args],
      {
        cwd: root,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => resolve({ code, output }));
  });
}

function summaryLine(output) {
  const lines = output
    .trim()
    .split("\n")
    .filter(
      (line) =>
        line.startsWith("RESULT") ||
        line.startsWith("Validated") ||
        line.includes("passed,"),
    );
  return lines.at(-1) ?? "(no summary line)";
}

const rows = [];
for (const suite of SUITES) {
  const started = performance.now();
  let env = {};
  let apiHandle = null;
  try {
    if (suite.api) {
      apiHandle = await startApi({});
      env = { API_BASE_URL: apiHandle.base };
    }
    console.log(`\n=== ${suite.name} ===`);
    const result = await run(suite.script, suite.args ?? [], env);
    const failures = result.output
      .split("\n")
      .filter((line) => line.startsWith("FAIL"));
    for (const line of failures) console.log(line);
    rows.push({
      name: suite.name,
      code: result.code,
      summary: summaryLine(result.output),
      seconds: Math.round((performance.now() - started) / 1000),
      failures,
    });
    console.log(
      `${result.code === 0 ? "OK" : "FAILED"} (${summaryLine(result.output)})`,
    );
  } finally {
    stopAll();
  }
}

console.log("\n==================== summary ====================");
for (const row of rows) {
  console.log(
    `${row.code === 0 ? "PASS" : "FAIL"}  ${row.name.padEnd(30)} ${row.summary}  [${row.seconds}s]`,
  );
}
process.exit(rows.some((row) => row.code !== 0) ? 1 : 0);
