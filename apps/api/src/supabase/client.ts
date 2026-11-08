import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../errors.js";
import type { Database } from "./database.types.js";

export interface SupabaseClientConfig {
  supabaseUrl: string | undefined;
  supabaseAnonKey: string | undefined;
  supabaseServiceRoleKey: string | undefined;
}

function requireValue(
  value: string | undefined,
  code: string,
  message: string,
): string {
  if (!value) {
    throw new AppError(code, "internal", 503, message);
  }
  return value;
}

export function createAdminSupabaseClient(
  config: SupabaseClientConfig,
): SupabaseClient<Database> {
  const url = requireValue(
    config.supabaseUrl,
    "DATABASE_CONFIGURATION_MISSING",
    "Database service is not configured.",
  );
  const serviceRoleKey = requireValue(
    config.supabaseServiceRoleKey,
    "DATABASE_CONFIGURATION_MISSING",
    "Database service is not configured.",
  );

  return createClient<Database>(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}

export function createUserSupabaseClient(
  config: SupabaseClientConfig,
  accessToken: string,
): SupabaseClient<Database> {
  const url = requireValue(
    config.supabaseUrl,
    "DATABASE_CONFIGURATION_MISSING",
    "Database service is not configured.",
  );
  const anonKey = requireValue(
    config.supabaseAnonKey,
    "DATABASE_CONFIGURATION_MISSING",
    "Database public key is not configured.",
  );

  return createClient<Database>(url, anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });
}
