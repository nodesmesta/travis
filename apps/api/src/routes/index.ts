import type { RouteModule } from "./context.js";
import { alertRoutes } from "./alerts.js";
import { assistantRoutes } from "./assistant.js";
import { bookingQuoteRoutes } from "./booking-quote.js";
import { invoiceRoutes } from "./invoices.js";
import { liteApiRoutes } from "./liteapi.js";
import { mobilityRoutes } from "./mobility.js";
import { placeRoutes } from "./places.js";
import { tripRoutes } from "./trips.js";

/**
 * Route modules are tried in order after the core routes in `index.ts`.
 * Each task adds its own module here.
 */
export const routeModules: RouteModule[] = [
  bookingQuoteRoutes,
  tripRoutes,
  assistantRoutes,
  mobilityRoutes,
  alertRoutes,
  invoiceRoutes,
  liteApiRoutes,
  placeRoutes,
];
