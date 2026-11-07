// Fails when the project contains a regular expression.
//
// Policy: this project does not use regular expressions anywhere (code, tests,
// scripts, SQL, JSON Schema, OpenAPI). This script enforces that, and it does
// not use a regular expression itself.
//
// Checks
//   TypeScript / JavaScript  (AST): regex literals, `RegExp`, `.match()`,
//     `.matchAll()`, `.search()`, and `.exec()` / `.test()` called with a
//     non-string argument.
//   SQL: `~`, `~*`, `!~`, `regexp_*`, `similar to`.
//   JSON Schema / OpenAPI: `pattern` and `patternProperties` keys.
//   Shell: `egrep`, `sed`, `awk`, `perl`, `=~`, `grep` without `-F`, python `re`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SCAN_DIRS = [
  "apps",
  "packages",
  "scripts",
  "contracts",
  "supabase",
  "deploy",
];
const SKIPPED_DIRS = new Set([
  "node_modules",
  "dist",
  ".next",
  ".git",
  ".temp",
  ".branches",
]);
const CODE = new Set([".ts", ".tsx", ".mjs", ".js", ".cjs"]);
const REGEX_METHODS = new Set(["match", "matchAll", "search"]);
const VIOLATIONS = [];

function report(file, line, message) {
  VIOLATIONS.push(`${relative(root, file)}:${line}  ${message}`);
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

function scanCode(file) {
  const text = readFileSync(file, "utf8");
  const kind = extname(file) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  const lineOf = (node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      report(file, lineOf(node), "regular expression literal");
    } else if (ts.isIdentifier(node) && node.text === "RegExp") {
      report(file, lineOf(node), "RegExp");
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const name = node.expression.name.text;
      const first = node.arguments[0];
      const stringArgument =
        first !== undefined &&
        (ts.isStringLiteral(first) ||
          ts.isNoSubstitutionTemplateLiteral(first));
      if (REGEX_METHODS.has(name)) {
        report(file, lineOf(node), `.${name}() builds a regular expression`);
      } else if ((name === "exec" || name === "test") && !stringArgument) {
        report(file, lineOf(node), `.${name}() on a regular expression`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function scanLines(file, check) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, index) => {
    const message = check(line);
    if (message) report(file, index + 1, message);
  });
}

function sqlLine(line) {
  const code = line.split("--")[0].toLowerCase();
  if (code.includes("regexp_")) return "regexp_ function";
  if (code.includes("similar to")) return "SIMILAR TO";
  for (const operator of [" ~* ", " !~ ", " ~ ", " !~* "]) {
    if (code.includes(operator)) return `regex operator ${operator.trim()}`;
  }
  return null;
}

function schemaLine(line) {
  const trimmed = line.trimStart();
  for (const key of ["pattern", "patternProperties"]) {
    if (
      trimmed.startsWith(`"${key}"`) ||
      trimmed.startsWith(`${key}:`) ||
      trimmed.includes(`{ ${key}:`) ||
      trimmed.includes(`, ${key}:`) ||
      trimmed.includes(`"${key}":`)
    ) {
      return `JSON Schema / OpenAPI "${key}"`;
    }
  }
  return null;
}

function shellLine(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith("#")) return null;
  // Split on shell separators so `$(sed ...)`, `| awk`, and `;grep` are seen.
  const separators = new Set([
    " ",
    "\t",
    "(",
    ")",
    "|",
    ";",
    "&",
    "`",
    "$",
    "{",
    "}",
  ]);
  const words = [];
  let current = "";
  for (const char of trimmed) {
    if (separators.has(char)) {
      if (current) words.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current) words.push(current);
  for (const banned of ["egrep", "sed", "awk", "perl"]) {
    if (words.includes(banned)) return `shell command ${banned}`;
  }
  if (trimmed.includes("=~")) return "bash =~ operator";
  if (words.includes("grep")) {
    const fixed = words.includes("-F") || words.includes("--fixed-strings");
    if (!fixed) return "grep without -F";
  }
  if (trimmed.startsWith("import re") || trimmed.includes("re.compile(")) {
    return "python re module";
  }
  for (const call of ["re.search(", "re.match(", "re.sub(", "re.findall("]) {
    if (trimmed.includes(call)) return "python re module";
  }
  return null;
}

for (const directory of SCAN_DIRS) {
  const base = join(root, directory);
  try {
    statSync(base);
  } catch {
    continue;
  }
  for (const file of walk(base)) {
    const extension = extname(file);
    if (file.endsWith(".d.ts")) continue;
    if (CODE.has(extension)) scanCode(file);
    else if (extension === ".sql") scanLines(file, sqlLine);
    else if (
      extension === ".json" ||
      extension === ".yaml" ||
      extension === ".yml"
    ) {
      if (!file.endsWith("package-lock.json")) scanLines(file, schemaLine);
    } else if (extension === ".sh") scanLines(file, shellLine);
  }
}

if (VIOLATIONS.length > 0) {
  console.error("Regular expressions are not allowed in this project:");
  for (const violation of VIOLATIONS) console.error(`  ${violation}`);
  process.exit(1);
}
console.log("OK: no regular expressions found.");
