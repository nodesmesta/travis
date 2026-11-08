import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { AuthenticatedUser } from "../auth.js";
import type { Database } from "../supabase/database.types.js";

export interface AuthenticatedSession {
  user: AuthenticatedUser;
  accessToken: string;
  /** Supabase client that acts as the signed-in user, so row level security applies. */
  client: SupabaseClient<Database>;
}

/** Everything a route module needs to answer one request. */
export interface RequestContext {
  request: IncomingMessage;
  response: ServerResponse;
  requestId: string;
  method: string;
  url: URL;
  config: ApiConfig;
  logger: Logger;
  authenticate(): Promise<AuthenticatedSession>;
}

/** Returns true when the module handled the request. */
export type RouteModule = (context: RequestContext) => Promise<boolean>;
