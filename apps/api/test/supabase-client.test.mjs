import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../dist/errors.js";
import { createUserSupabaseClient } from "../dist/supabase/client.js";

test("user-scoped Supabase client requires the public key", () => {
  assert.throws(
    () =>
      createUserSupabaseClient(
        {
          supabaseUrl: "https://example.supabase.co",
          supabaseAnonKey: undefined,
          supabaseServiceRoleKey: "server-only",
        },
        "user-token",
      ),
    (error) =>
      error instanceof AppError &&
      error.code === "DATABASE_CONFIGURATION_MISSING" &&
      error.statusCode === 503,
  );
});

test("user-scoped Supabase client can be created without a service role key", () => {
  const client = createUserSupabaseClient(
    {
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "public-key",
      supabaseServiceRoleKey: undefined,
    },
    "user-token",
  );

  assert.ok(client);
});
