import assert from "node:assert/strict";
import test from "node:test";
import { extractBearerToken, requireAuthenticatedUser } from "../dist/auth.js";

test("extractBearerToken accepts a Bearer token", () => {
  assert.equal(extractBearerToken("Bearer test-token"), "test-token");
  assert.equal(extractBearerToken("bearer test-token"), "test-token");
});

test("extractBearerToken rejects missing or malformed headers", () => {
  assert.throws(() => extractBearerToken(undefined), {
    code: "AUTH_TOKEN_MISSING",
  });
  assert.throws(() => extractBearerToken("Basic test-token"), {
    code: "AUTH_TOKEN_INVALID",
  });
  assert.throws(() => extractBearerToken("Bearer"), {
    code: "AUTH_TOKEN_INVALID",
  });
});

test("requireAuthenticatedUser passes the verified identity through", async () => {
  const user = { id: "user-1", email: "user@example.com" };
  const verifier = {
    async verifyAccessToken(token) {
      assert.equal(token, "valid-token");
      return user;
    },
  };

  await assert.doesNotReject(async () => {
    const authenticated = await requireAuthenticatedUser(
      { authorization: "Bearer valid-token" },
      verifier,
    );
    assert.deepEqual(authenticated, user);
  });
});
