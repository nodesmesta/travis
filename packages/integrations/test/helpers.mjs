import assert from "node:assert/strict";

/** Asserts that `actual` contains the literal text `expected`. */
export function has(actual, expected, message) {
  assert.equal(typeof actual, "string", message ?? "value must be a string");
  assert.ok(
    actual.includes(expected),
    message ??
      `expected ${JSON.stringify(actual)} to contain ${JSON.stringify(expected)}`,
  );
}

/** Asserts that `actual` does not contain the literal text `unexpected`. */
export function lacks(actual, unexpected, message) {
  assert.equal(typeof actual, "string", message ?? "value must be a string");
  assert.ok(
    !actual.includes(unexpected),
    message ??
      `expected ${JSON.stringify(actual)} not to contain ${JSON.stringify(unexpected)}`,
  );
}
