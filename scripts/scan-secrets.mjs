// Secret exposure scan. Fails (exit 1) when a secret value or a secret-shaped token
// appears in a file that could be published.
//
//   node --env-file=.env.local scripts/scan-secrets.mjs [--logs]
//
// Two checks, neither uses a regular expression:
//   1. VALUES: every secret value read from the environment (.env.local) must not
//      appear in any publishable file. This catches a real key pasted anywhere.
//   2. SHAPES: well-known token prefixes (JWT header, sk-, ghp_, AKIA, private key
//      armor) followed by enough token characters.
// `--logs` also scans the output of `docker compose logs` for the deploy project, when running.
//
// Files skipped: .env.local itself (it is meant to hold secrets and is git-ignored),
// node_modules, build output, and binary files.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SKIPPED_DIRS = new Set([
  "node_modules",
  "dist",
  ".next",
  ".git",
  ".temp",
  ".branches",
  ".playwright",
]);
const SKIPPED_FILES = new Set([".env.local", "package-lock.json"]);
const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mjs",
  ".js",
  ".cjs",
  ".json",
  ".md",
  ".yaml",
  ".yml",
  ".sql",
  ".sh",
  ".toml",
  ".css",
  ".txt",
  ".example",
  ".html",
  "",
]);
// Environment names whose values are secrets. Values shorter than 12 characters are
// ignored to avoid matching ordinary words.
const SECRET_NAMES = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_ANON_KEY",
  "BRIGHT_DATA_API_KEY",
  "VULTR_INFERENCE_API_KEY",
  "HERE_API_KEY",
  "OPENWEATHER_API_KEY",
  "EMAIL_PROVIDER_API_KEY",
  "METRICS_TOKEN",
  "DEMO_PASSWORD",
];
// Built in two pieces so this file does not match itself.
const ARMOR_START = "-----" + "BEGIN";
const ARMOR_KIND = "PRIVATE" + " KEY";
const TOKEN_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-.";

const findings = [];
function report(file, line, message) {
  findings.push(`${relative(root, file)}${line ? `:${line}` : ""}  ${message}`);
}

function* walk(directory) {
  for (const name of readdirSync(directory)) {
    if (SKIPPED_DIRS.has(name)) continue;
    const path = join(directory, name);
    const stats = statSync(path);
    if (stats.isDirectory()) yield* walk(path);
    else yield path;
  }
}

function extensionOf(file) {
  const name = basename(file);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot);
}

/** True when `prefix` starts at `index` and at least `minTail` token characters follow. */
function tokenAt(text, index, prefix, minTail) {
  if (!text.startsWith(prefix, index)) return false;
  let count = 0;
  for (let cursor = index + prefix.length; cursor < text.length; cursor += 1) {
    if (!TOKEN_CHARS.includes(text[cursor])) break;
    count += 1;
  }
  return count >= minTail;
}

const SHAPES = [
  { name: "JWT", prefix: "eyJ", minTail: 30 },
  { name: "OpenAI-style key", prefix: "sk-", minTail: 24 },
  { name: "GitHub token", prefix: "ghp_", minTail: 30 },
  { name: "GitHub fine-grained token", prefix: "github_pat_", minTail: 30 },
  { name: "AWS access key id", prefix: "AKIA", minTail: 14 },
  { name: "Slack token", prefix: "xoxb-", minTail: 20 },
  { name: "Resend key", prefix: "re_", minTail: 24 },
];

function scanText(file, text, secrets) {
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    for (const secret of secrets) {
      if (line.includes(secret.value)) {
        report(file, index + 1, `contains the value of ${secret.name}`);
      }
    }
    if (line.includes(ARMOR_START) && line.includes(ARMOR_KIND)) {
      report(file, index + 1, "private key armor");
    }
    for (const shape of SHAPES) {
      let from = 0;
      for (;;) {
        const at = line.indexOf(shape.prefix, from);
        if (at < 0) break;
        from = at + 1;
        // A shape must start a token, not sit inside a longer word.
        const before = at === 0 ? "" : line[at - 1];
        if (before !== "" && TOKEN_CHARS.includes(before)) continue;
        if (tokenAt(line, at, shape.prefix, shape.minTail)) {
          report(file, index + 1, `looks like a ${shape.name}`);
        }
      }
    }
  });
}

// Secret values from the environment.
const secrets = [];
for (const name of SECRET_NAMES) {
  const value = process.env[name];
  if (value && value.length >= 12) secrets.push({ name, value });
}
if (secrets.length === 0) {
  console.log(
    "NOTE: no secret values in the environment; run with --env-file=.env.local to check values. Only token shapes are checked.",
  );
}

let scanned = 0;
for (const file of walk(root)) {
  if (SKIPPED_FILES.has(basename(file))) continue;
  if (!TEXT_EXTENSIONS.has(extensionOf(file))) continue;
  const size = statSync(file).size;
  if (size > 2_000_000) continue;
  scanText(file, readFileSync(file, "utf8"), secrets);
  scanned += 1;
}

// .env.local must not be tracked or published: check the ignore rules say so.
const ignore = readFileSync(join(root, ".gitignore"), "utf8")
  .split("\n")
  .map((line) => line.trim());
for (const needed of [".env.local"]) {
  if (
    !ignore.includes(needed) &&
    !ignore.some((line) => line === ".env.*" || line === ".env*")
  ) {
    report(join(root, ".gitignore"), 0, `does not ignore ${needed}`);
  }
}

if (process.argv.includes("--logs")) {
  const logs = spawnSync(
    "docker",
    ["compose", "-p", "travelflow", "logs", "--no-color"],
    { encoding: "utf8" },
  );
  if (logs.status === 0) {
    scanText(join(root, "(docker compose logs)"), logs.stdout, secrets);
    console.log("Scanned docker compose logs of project travelflow.");
  } else {
    console.log(
      "NOTE: --logs requested but no compose project 'travelflow' is running; logs not scanned.",
    );
  }
}

if (findings.length > 0) {
  console.error(`Secret exposure found (${findings.length}):`);
  for (const finding of findings) console.error(`  ${finding}`);
  process.exit(1);
}
console.log(
  `OK: no secret values or token shapes in ${scanned} files (${secrets.length} secret values checked).`,
);
