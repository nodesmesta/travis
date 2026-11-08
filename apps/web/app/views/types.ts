import type { ContextPoint, Trip } from "../../lib/types";

/** Props shared by every workspace view. */
export interface ViewProps {
  trip: Trip;
  contexts: ContextPoint[];
  /** The context point chosen in the workspace, or null when none is resolved. */
  context: ContextPoint | null;
  onSelectContext: (point: ContextPoint) => void;
  /** Every trip of the signed-in user. Set by the workspace; the Trips view lists them. */
  trips?: Trip[];
  /** Makes another trip the active trip of the whole workspace. */
  onSelectTrip?: (tripId: string) => void;
  /** Reloads the trips after a create, edit, or status change. Passing an id also makes that trip active. */
  onTripsChanged?: (selectTripId?: string) => Promise<void>;
  /** Reloads the context points of the active trip after one was added or changed. */
  onContextsChanged?: () => Promise<void>;
  /** Opens the Invoices view, for the "View invoice" links after a payment succeeds. */
  onOpenInvoices?: () => void;
  /** Opens the Bookings view, for the "All reservations" links after a provider booking. */
  onOpenBookings?: () => void;
}

/** The Trips view must also work for a user who has no trip yet. */
export interface TripsViewProps extends Omit<ViewProps, "trip"> {
  trip: Trip | null;
}

export type ViewId =
  | "explore"
  | "mobility"
  | "assistant"
  | "itinerary"
  | "bookings"
  | "alerts"
  | "invoices"
  | "trips";

export const VIEWS: Array<{ id: ViewId; label: string; hint: string }> = [
  {
    id: "explore",
    label: "Explore",
    hint: "Stays and flights",
  },
  { id: "bookings", label: "Bookings", hint: "Your reservations" },
  { id: "itinerary", label: "Itinerary", hint: "Timeline and suggestions" },
  { id: "mobility", label: "Mobility", hint: "Routes, weather, traffic" },
  { id: "assistant", label: "Assistant", hint: "Ask about your trip" },
  { id: "alerts", label: "Alerts", hint: "What changed" },
  { id: "invoices", label: "Invoices", hint: "Receipts and email" },
  { id: "trips", label: "Trips", hint: "Set up trip context" },
];
