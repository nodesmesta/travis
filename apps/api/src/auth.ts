import {
  createClient,
  type SupabaseClient,
  type User,
} from "@supabase/supabase-js";
import type { IncomingHttpHeaders } from "node:http";
import { AppError } from "./errors.js";

export interface AuthConfig {
  supabaseUrl: string | undefined;
  supabaseServiceRoleKey: string | undefined;
}

export interface AuthenticatedUser {
  id: string;
  email: string | undefined;
}

export interface AuthVerifier {
  verifyAccessToken(accessToken: string): Promise<AuthenticatedUser>;
}

function toAuthenticatedUser(user: User): AuthenticatedUser {
  return {
    id: user.id,
    email: user.email,
  };
}

export function extractBearerToken(
  authorizationHeader: string | undefined,
): string {
  if (!authorizationHeader) {
    throw new AppError(
      "AUTH_TOKEN_MISSING",
      "authentication",
      401,
      "Bearer access token is required.",
    );
  }

  const token = parseBearerToken(authorizationHeader);
  if (!token) {
    throw new AppError(
      "AUTH_TOKEN_INVALID",
      "authentication",
      401,
      "Authorization header must use the Bearer scheme.",
    );
  }

  return token;
}

function isBlank(char: string | undefined): boolean {
  return (
    char === " " ||
    char === "\t" ||
    char === "\n" ||
    char === "\r" ||
    char === "\f" ||
    char === "\v"
  );
}

/** Reads `Bearer <token>`: the scheme is case-insensitive and the token has no whitespace. */
export function parseBearerToken(header: string): string | null {
  const scheme = "bearer";
  if (header.slice(0, scheme.length).toLowerCase() !== scheme) return null;
  let index = scheme.length;
  if (!isBlank(header[index])) return null;
  while (isBlank(header[index])) index += 1;
  const token = header.slice(index);
  if (token.length === 0) return null;
  for (const char of token) {
    if (isBlank(char)) return null;
  }
  return token;
}

export function createAuthVerifier(config: AuthConfig): AuthVerifier {
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    throw new Error("Supabase auth configuration is incomplete.");
  }

  const client: SupabaseClient = createClient(
    config.supabaseUrl,
    config.supabaseServiceRoleKey,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    },
  );

  return {
    async verifyAccessToken(accessToken: string): Promise<AuthenticatedUser> {
      const { data, error } = await client.auth.getUser(accessToken);
      if (error || !data.user) {
        throw new AppError(
          "AUTH_TOKEN_INVALID",
          "authentication",
          401,
          "Access token is invalid or expired.",
        );
      }
      return toAuthenticatedUser(data.user);
    },
  };
}

export async function requireAuthenticatedUser(
  headers: IncomingHttpHeaders,
  verifier: AuthVerifier,
): Promise<AuthenticatedUser> {
  const authorization = headers.authorization;
  const accessToken = extractBearerToken(
    Array.isArray(authorization) ? authorization[0] : authorization,
  );
  return verifier.verifyAccessToken(accessToken);
}
