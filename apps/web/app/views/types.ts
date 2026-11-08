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
}

/** The Trips view must also work for a user who has no trip yet. */
export interface TripsViewProps extends Omit<ViewProps, "trip"> {
  trip: Trip | null;
}

/**
 * A search the Explore views turn into a trip when the traveller has none yet.
 * The workspace owns trip creation, so the views only describe what was typed.
 */
export interface EnsureTripInput {
  name: string;
  destination: string;
  startDate?: string;
  endDate?: string;
}

/**
 * Explore searches before it knows the trip. Hotel and flight search need a trip
 * only as the container of the booking, so the views ask the workspace to open
 * one from the search itself instead of sending the traveller to Trips first.
 */
export interface ExploreViewProps {
  trip: Trip | null;
  contexts: ContextPoint[];
  context: ContextPoint | null;
  onSelectContext: (point: ContextPoint) => void;
  onEnsureTrip: (input: EnsureTripInput) => Promise<Trip>;
  onOpenInvoices?: () => void;
  /** The trip the booking lands in; opens the Trips view. */
  onOpenTrips?: () => void;
}

export type ViewId =
  "explore" | "advice" | "itinerary" | "alerts" | "invoices" | "trips";

export const VIEWS: Array<{ id: ViewId; label: string; hint: string }> = [
  {
    id: "explore",
    label: "Explore",
    hint: "Stays and flights",
  },
  {
    id: "advice",
    label: "Advice",
    hint: "Automatic advice from your tickets",
  },
  { id: "itinerary", label: "Itinerary", hint: "Timeline and suggestions" },
  { id: "alerts", label: "Alerts", hint: "What changed" },
  { id: "invoices", label: "Invoices", hint: "Receipts and email" },
  { id: "trips", label: "Trips", hint: "Set up trip context" },
];
