"use client";

import AlertsView from "./views/alerts";
import ActiveAlertsSummary from "./views/alerts-summary";
import AssistantView from "./views/assistant";
import BookingsView from "./views/bookings";
import InvoicesView from "./views/invoices";
import ItineraryView from "./views/itinerary";
import FlightsView from "./views/flights";
import HotelsView from "./views/hotels";
import MobilityView from "./views/mobility";
import TripsView from "./views/trips";
import { VIEWS, type ViewId, type ViewProps } from "./views/types";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { getSupabaseBrowserClient } from "../lib/supabase/browser";
import {
  passwordLoginEnabled,
  readAuthRedirectError,
  startGoogleSignIn,
} from "../lib/auth";
import {
  ApiClientError,
  createBooking,
  discoverEvents,
  getBookingQuote,
  listContextPoints,
  listTrips,
  simulatePayment,
} from "../lib/api";
import type {
  Booking,
  BookingQuote,
  ContextPoint,
  EventDiscoveryResponse,
  EventItem,
  Payment,
  Trip,
} from "../lib/types";

function formatMoney(currency: string, amount: number): string {
  return `${currency} ${new Intl.NumberFormat("en-US").format(amount)}`;
}

function formatDate(value: string | null | undefined, timezone = "UTC") {
  if (!value) return "Date to be confirmed";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(new Date(value));
}

function datePart(value: string | null): string {
  return value ? value.slice(0, 10) : "";
}

function timePart(value: string | null, timezone: string): string {
  if (!value) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: timezone,
  }).formatToParts(new Date(value));
  const hour = parts.find((part) => part.type === "hour")?.value ?? "";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "";
  return hour && minute ? `${hour}:${minute}` : "";
}

function timezoneTimestamp(
  date: string,
  time: string,
  timezone: string,
): string {
  const probe = new Date(`${date}T${time}:00Z`);
  const zone =
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "longOffset",
    })
      .formatToParts(probe)
      .find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const offset = zone.replace("GMT", "") || "+00:00";
  return `${date}T${time}:00${offset}`;
}

function friendlyError(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 401)
      return "Your session has expired. Please sign in again.";
    if (error.status === 404)
      return "This trip resource is no longer available to your account.";
    if (error.status === 409)
      return "This action conflicts with the current booking state. Refresh and try again.";
    if (error.status === 422) return error.message;
    if (error.status >= 500)
      return "The live service is unavailable right now. Try again manually in a moment.";
    return error.message;
  }
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}

function StatusBanner({
  tone,
  children,
}: {
  tone: "error" | "info" | "success" | "warning";
  children: ReactNode;
}) {
  return (
    <div
      className={`status-banner ${tone}`}
      role={tone === "error" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}

function GoogleMark() {
  return (
    <svg
      className="google-mark"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
      />
    </svg>
  );
}

/** Local development and browser test scripts only. See `passwordLoginEnabled`. */
function PasswordLoginForm({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { error: signInError } =
        await getSupabaseBrowserClient().auth.signInWithPassword({
          email,
          password,
        });
      if (signInError) throw signInError;
      onSignedIn();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Sign in failed. Check your credentials.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="stack-form dev-sign-in">
      <p className="fine-print">
        Local test sign-in. Not shown unless the test flag is set.
      </p>
      <label>
        Email
        <input
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
      </label>
      <label>
        Password
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </label>
      {error ? <StatusBanner tone="error">{error}</StatusBanner> : null}
      <button className="button primary wide" disabled={busy} type="submit">
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

function LoginScreen({
  notice,
  onSignedIn,
}: {
  notice: string | null;
  onSignedIn: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(notice);

  async function continueWithGoogle() {
    setBusy(true);
    setError(null);
    try {
      await startGoogleSignIn();
      // The browser is on its way to Google; keep the button disabled until it leaves.
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Google sign-in could not start. Please try again.",
      );
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-card" aria-labelledby="login-title">
        <div className="brand-lockup">
          <span className="brand-mark">✦</span>
          <span>travis</span>
        </div>
        <p className="eyebrow">BUSINESS TRAVEL OPERATIONS</p>
        <h1 id="login-title">Go further. Feel at home.</h1>
        <p className="auth-copy">
          A calm workspace for the details that make a business trip run
          smoothly.
        </p>
        {error ? <StatusBanner tone="error">{error}</StatusBanner> : null}
        <button
          className="button google wide"
          disabled={busy}
          onClick={continueWithGoogle}
          type="button"
        >
          <GoogleMark />
          <span>
            {busy ? "Redirecting to Google…" : "Continue with Google"}
          </span>
        </button>
        {passwordLoginEnabled ? (
          <PasswordLoginForm onSignedIn={onSignedIn} />
        ) : null}
        <p className="fine-print">
          travis receives your name, email, and profile picture from Google. It
          never asks for card details.
        </p>
      </section>
    </main>
  );
}

const EXPLORE_MODES = ["nearby", "stays", "flights"] as const;
type ExploreMode = (typeof EXPLORE_MODES)[number];

const EXPLORE_TITLES: Record<ExploreMode, string> = {
  nearby: "Nearby",
  stays: "Stays",
  flights: "Flights",
};

function parseWorkspaceHash(hash: string): {
  view: ViewId | null;
  exploreMode: ExploreMode | null;
} {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return { view: null, exploreMode: null };
  const [first, second] = raw.split("/");
  if (first === "explore" && exploreModeGuard(second)) {
    return { view: "explore", exploreMode: second };
  }
  const known = VIEWS.some((item) => item.id === first);
  return { view: known ? (first as ViewId) : null, exploreMode: null };
}

function exploreModeGuard(value: string | undefined): value is ExploreMode {
  return (
    typeof value === "string" &&
    (EXPLORE_MODES as readonly string[]).includes(value)
  );
}

function workspaceHash(view: ViewId, exploreMode: ExploreMode): string {
  return view === "explore" ? `#explore/${exploreMode}` : `#${view}`;
}

function replaceHash(hash: string) {
  if (window.location.hash !== hash) {
    window.history.replaceState(null, "", hash);
  }
}

function ExploreTabs({
  active,
  onChange,
}: {
  active: ExploreMode;
  onChange: (mode: ExploreMode) => void;
}) {
  return (
    <nav className="explore-tabs" aria-label="Explore categories">
      <button
        className={active === "nearby" ? "active" : undefined}
        onClick={() => onChange("nearby")}
        type="button"
      >
        Nearby
      </button>
      <button
        className={active === "stays" ? "active" : undefined}
        onClick={() => onChange("stays")}
        type="button"
      >
        Stays
      </button>
      <button
        className={active === "flights" ? "active" : undefined}
        onClick={() => onChange("flights")}
        type="button"
      >
        Flights
      </button>
    </nav>
  );
}

function ContextSelector({
  points,
  selectedId,
  onSelect,
}: {
  points: ContextPoint[];
  selectedId: string | null;
  onSelect: (point: ContextPoint) => void;
}) {
  return (
    <section className="panel context-panel" aria-labelledby="context-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">YOUR TRIP, IN PLACE</p>
          <h2 id="context-title">Choose a context point</h2>
        </div>
        <span className="count-badge">{points.length}</span>
      </div>
      <div className="context-list">
        {points.map((point) => {
          const usable =
            point.status === "active" &&
            point.resolution_status === "resolved" &&
            point.latitude !== null &&
            point.longitude !== null;
          return (
            <button
              className={`context-option ${selectedId === point.id ? "selected" : ""}`}
              disabled={!usable}
              key={point.id}
              onClick={() => onSelect(point)}
              type="button"
            >
              <span className={`context-icon ${usable ? "ready" : "muted"}`}>
                {point.type === "hotel"
                  ? "⌂"
                  : point.type === "airport"
                    ? "✈"
                    : "◎"}
              </span>
              <span className="context-copy">
                <strong>{point.label}</strong>
                <small>{point.address ?? point.type}</small>
                {!usable ? <em>Needs confirmation</em> : null}
              </span>
              {selectedId === point.id ? (
                <span className="selected-check">✓</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function EventCard({
  event,
  sources,
  timezone,
  selected,
  onSelect,
}: {
  event: EventItem;
  sources: EventDiscoveryResponse["sources"];
  timezone: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const eventSources = sources.filter((source) =>
    event.source_ids.includes(source.id),
  );
  return (
    <article className={`event-card ${selected ? "selected" : ""}`}>
      <div className="event-card-topline">
        <span className="tag coral">{event.category ?? "Local event"}</span>
        <span className="fresh-label">{event.status}</span>
      </div>
      <h3>{event.title}</h3>
      <p className="event-meta">
        <span>◷</span> {formatDate(event.starts_at, timezone)}
      </p>
      <p className="event-meta">
        <span>⌖</span> {event.venue_name ?? "Venue details in source"}
      </p>
      {event.description ? (
        <p className="event-description">{event.description}</p>
      ) : null}
      <details className="source-details">
        <summary>Source and freshness</summary>
        {eventSources.length > 0 ? (
          eventSources.map((source) => (
            <div className="source-row" key={source.id}>
              <span>
                {source.provider} · {source.freshness}
              </span>
              <small>Retrieved {formatDate(source.retrieved_at, "UTC")}</small>
              {source.url ? (
                <a href={source.url} target="_blank" rel="noreferrer">
                  Open source ↗
                </a>
              ) : null}
            </div>
          ))
        ) : (
          <small>Source metadata is not available.</small>
        )}
      </details>
      <button
        className={`button ${selected ? "secondary" : "accent"} wide`}
        onClick={onSelect}
        type="button"
      >
        {selected ? "Selected for booking" : "Review booking"}
      </button>
    </article>
  );
}

function BookingPanel({
  event,
  booking,
  payment,
  busy,
  quote,
  quoteError,
  onCreate,
  onPayment,
  onOpenInvoices,
}: {
  event: EventItem | null;
  quote: BookingQuote | null;
  quoteError: string | null;
  booking: Booking | null;
  payment: Payment | null;
  busy: boolean;
  onCreate: () => void;
  onPayment: (outcome: "succeeded" | "failed") => void;
  onOpenInvoices: () => void;
}) {
  if (!event) {
    return (
      <aside className="panel booking-panel empty-panel">
        <span className="panel-icon">♧</span>
        <h2>Your booking desk</h2>
        <p>Select an event to review the internal booking before you pay.</p>
      </aside>
    );
  }

  const confirmed =
    payment?.status === "succeeded" && booking?.status === "confirmed";
  const failed = payment?.status === "failed" || booking?.status === "failed";
  return (
    <aside className="panel booking-panel" aria-labelledby="booking-title">
      <p className="eyebrow">INTERNAL BOOKING</p>
      <h2 id="booking-title">{event.title}</h2>
      <p className="booking-location">{event.venue_name ?? "Selected event"}</p>
      <div className="price-summary">
        <span>Demo event price</span>
        {quote ? (
          <>
            <strong>{formatMoney(quote.currency, quote.total)}</strong>
            <small>
              Includes {formatMoney(quote.currency, quote.tax)} tax · Price
              policy {quote.policy_version} · No real money moves
            </small>
          </>
        ) : quoteError ? (
          <small role="alert">Price unavailable: {quoteError}</small>
        ) : (
          <small role="status">Getting the price…</small>
        )}
      </div>
      {!booking ? (
        <>
          <p className="booking-note">
            Review this booking before creating it. The event remains a
            suggestion until you confirm payment.
          </p>
          <button
            className="button primary wide"
            disabled={busy || !quote}
            onClick={onCreate}
            type="button"
          >
            {busy ? "Creating booking…" : "Confirm booking details"}
          </button>
        </>
      ) : confirmed ? (
        <StatusBanner tone="success">
          <strong>Booking confirmed</strong>
          <span>
            Confirmation {booking.confirmation_code ?? booking.id.slice(0, 8)}
          </span>
          <button
            className="button secondary"
            onClick={onOpenInvoices}
            type="button"
          >
            View invoice
          </button>
        </StatusBanner>
      ) : failed ? (
        <StatusBanner tone="error">
          <strong>Payment failed</strong>
          <span>
            This booking was not confirmed. Start a new booking to try again.
          </span>
        </StatusBanner>
      ) : (
        <>
          <div className="status-line">
            <span>Booking</span>
            <strong>{booking.status.replace("_", " ")}</strong>
          </div>
          <div className="payment-choice">
            <p className="eyebrow">DUMMY PAYMENT</p>
            <p>
              Choose an outcome for the demo. No card details are collected.
            </p>
            <div className="button-row">
              <button
                className="button primary"
                disabled={busy}
                onClick={() => onPayment("succeeded")}
                type="button"
              >
                Pay successfully
              </button>
              <button
                className="button danger"
                disabled={busy}
                onClick={() => onPayment("failed")}
                type="button"
              >
                Simulate failure
              </button>
            </div>
          </div>
        </>
      )}
    </aside>
  );
}

function ViewHost({
  view,
  viewProps,
  error,
}: {
  view: ViewId;
  viewProps: ViewProps;
  error: string | null;
}) {
  return (
    <>
      {error ? <StatusBanner tone="error">{error}</StatusBanner> : null}
      {view === "mobility" ? <MobilityView {...viewProps} /> : null}
      {view === "assistant" ? <AssistantView {...viewProps} /> : null}
      {view === "itinerary" ? <ItineraryView {...viewProps} /> : null}
      {view === "bookings" ? <BookingsView {...viewProps} /> : null}
      {view === "alerts" ? <AlertsView {...viewProps} /> : null}
      {view === "invoices" ? <InvoicesView {...viewProps} /> : null}
    </>
  );
}

function Workspace({ onSignOut }: { onSignOut: () => Promise<void> }) {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [contexts, setContexts] = useState<ContextPoint[]>([]);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [context, setContext] = useState<ContextPoint | null>(null);
  const [discovery, setDiscovery] = useState<EventDiscoveryResponse | null>(
    null,
  );
  const [selectedEvent, setSelectedEvent] = useState<EventItem | null>(null);
  const [booking, setBooking] = useState<Booking | null>(null);
  const [quote, setQuote] = useState<BookingQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [payment, setPayment] = useState<Payment | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState("business_events");
  const [date, setDate] = useState("");
  const [fromTime, setFromTime] = useState("");
  const [toTime, setToTime] = useState("");
  const [view, setView] = useState<ViewId>("explore");
  const [exploreMode, setExploreMode] = useState<ExploreMode>("nearby");

  function showView(next: ViewId) {
    setView(next);
    replaceHash(workspaceHash(next, exploreMode));
  }

  function showExploreMode(next: ExploreMode) {
    setExploreMode(next);
    replaceHash(workspaceHash("explore", next));
  }

  useEffect(() => {
    function syncFromHash() {
      const parsed = parseWorkspaceHash(window.location.hash);
      if (parsed.view) setView(parsed.view);
      if (parsed.exploreMode) setExploreMode(parsed.exploreMode);
    }
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, []);

  async function loadWorkspace() {
    setLoading(true);
    setError(null);
    try {
      const tripResult = await listTrips();
      setTrips(tripResult.items);
      const firstTrip = tripResult.items[0] ?? null;
      setTrip(firstTrip);
      if (firstTrip) {
        const contextResult = await listContextPoints(firstTrip.id);
        setContexts(contextResult.items);
        setContext(
          contextResult.items.find(
            (item) =>
              item.resolution_status === "resolved" && item.status === "active",
          ) ?? null,
        );
      }
    } catch (caught) {
      setError(friendlyError(caught));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadWorkspace();
  }, []);

  // The newest active trip, for callbacks that finish after a render.
  const tripRef = useRef<Trip | null>(null);
  const activation = useRef(0);
  useEffect(() => {
    tripRef.current = trip;
  }, [trip]);

  useEffect(() => {
    setDate(datePart(trip?.start_at ?? null));
    setFromTime(timePart(trip?.start_at ?? null, trip?.timezone ?? "UTC"));
    setToTime(timePart(trip?.end_at ?? null, trip?.timezone ?? "UTC"));
  }, [trip?.id, trip?.start_at, trip?.end_at, trip?.timezone]);

  function firstResolvedPoint(points: ContextPoint[]): ContextPoint | null {
    return (
      points.find(
        (item) =>
          item.resolution_status === "resolved" && item.status === "active",
      ) ?? null
    );
  }

  /** Makes `next` the active trip and loads its context points. */
  async function activateTrip(next: Trip | null) {
    const mine = ++activation.current;
    tripRef.current = next;
    setTrip(next);
    setDiscovery(null);
    setSelectedEvent(null);
    setBooking(null);
    setPayment(null);
    setContexts([]);
    setContext(null);
    if (!next) return;
    const contextResult = await listContextPoints(next.id);
    if (mine !== activation.current) return;
    setContexts(contextResult.items);
    setContext(firstResolvedPoint(contextResult.items));
  }

  async function selectTrip(id: string) {
    const next = trips.find((item) => item.id === id);
    if (!next || next.id === tripRef.current?.id) return;
    setError(null);
    try {
      await activateTrip(next);
    } catch (caught) {
      setError(friendlyError(caught));
    }
  }

  /** Reloads the trips. The Trips view passes an id to open a trip it just created. */
  async function reloadTrips(selectTripId?: string) {
    const result = await listTrips();
    setTrips(result.items);
    const wanted = selectTripId ?? tripRef.current?.id;
    const next =
      result.items.find((item) => item.id === wanted) ??
      result.items[0] ??
      null;
    if (next && next.id === tripRef.current?.id) {
      tripRef.current = next;
      setTrip(next);
    } else {
      await activateTrip(next);
    }
  }

  /** Reloads the context points of the active trip and keeps the chosen one when it is still usable. */
  async function reloadContexts() {
    const current = tripRef.current;
    if (!current) return;
    const result = await listContextPoints(current.id);
    if (tripRef.current?.id !== current.id) return;
    setContexts(result.items);
    setContext((chosen) => {
      const kept = chosen
        ? result.items.find(
            (item) =>
              item.id === chosen.id &&
              item.resolution_status === "resolved" &&
              item.status === "active",
          )
        : undefined;
      return kept ?? firstResolvedPoint(result.items);
    });
  }

  const tripId = trip?.id ?? null;
  const hasSelectedEvent = selectedEvent !== null;
  useEffect(() => {
    setQuote(null);
    setQuoteError(null);
    if (!tripId || !hasSelectedEvent) return;
    let current = true;
    getBookingQuote(tripId, "event").then(
      (result) => {
        if (current) setQuote(result);
      },
      (caught: unknown) => {
        if (current) setQuoteError(friendlyError(caught));
      },
    );
    return () => {
      current = false;
    };
  }, [tripId, hasSelectedEvent]);

  async function searchEvents(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!trip || !context) return;
    setBusy(true);
    setError(null);
    setDiscovery(null);
    setSelectedEvent(null);
    setBooking(null);
    setPayment(null);
    try {
      const result = await discoverEvents(trip.id, {
        context_point_id: context.id,
        observed_for: {
          from: timezoneTimestamp(date, fromTime, context.timezone),
          to: timezoneTimestamp(date, toTime, context.timezone),
          timezone: context.timezone,
        },
        filters: { category, radius_preference: "nearby", language: "en" },
      });
      setDiscovery(result);
    } catch (caught) {
      setError(friendlyError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function confirmBooking() {
    if (!trip || !selectedEvent) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createBooking(trip.id, {
        booking_type: "event",
        source_type: "event_discovery_result",
        source_id: selectedEvent.id,
        ...(selectedEvent.starts_at
          ? { starts_at: selectedEvent.starts_at }
          : {}),
        ...(selectedEvent.ends_at ? { ends_at: selectedEvent.ends_at } : {}),
      });
      setBooking(result);
    } catch (caught) {
      setError(friendlyError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function choosePayment(outcome: "succeeded" | "failed") {
    if (!trip || !booking) return;
    setBusy(true);
    setError(null);
    try {
      const result = await simulatePayment(trip.id, booking.id, outcome);
      setBooking(result.booking);
      setPayment(result.payment);
    } catch (caught) {
      setError(friendlyError(caught));
    } finally {
      setBusy(false);
    }
  }

  const activeEvents = discovery?.items ?? [];
  const selectedSource = useMemo(() => discovery?.sources ?? [], [discovery]);

  if (loading) {
    return (
      <main className="app-shell loading-shell">
        <div className="loading-card">
          <span className="spinner" />
          <p>Preparing your trip workspace…</p>
        </div>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark">✦</span>
          <span>travis</span>
        </div>
        <div className="topbar-actions">
          <button
            className="button ghost"
            onClick={() => void onSignOut()}
            type="button"
          >
            Sign out
          </button>
        </div>
      </header>
      <div
        className={
          view === "explore" && exploreMode === "nearby"
            ? "workspace-grid"
            : "workspace-grid two-column"
        }
      >
        <aside className="sidebar">
          <nav className="side-nav" aria-label="Workspace navigation">
            {VIEWS.map((item) => (
              <a
                key={item.id}
                className={view === item.id ? "active" : undefined}
                aria-current={view === item.id ? "page" : undefined}
                href={workspaceHash(item.id, exploreMode)}
                title={item.hint}
                onClick={(event) => {
                  event.preventDefault();
                  showView(item.id);
                }}
              >
                {item.label}
              </a>
            ))}
          </nav>
          {trip ? (
            <ActiveAlertsSummary
              tripId={trip.id}
              onOpen={() => showView("alerts")}
            />
          ) : null}
          <div className="sidebar-note">
            <span>✦</span>
            <p>Your trip context stays with you while you explore.</p>
          </div>
        </aside>
        <section className="main-column" id="workspace">
          {view === "explore" ? (
            <>
              <div className="explore-heading">
                <h1>{EXPLORE_TITLES[exploreMode]}</h1>
              </div>
              {error ? <StatusBanner tone="error">{error}</StatusBanner> : null}
              <ExploreTabs active={exploreMode} onChange={showExploreMode} />
              {exploreMode === "nearby" ? (
                <>
                  <ContextSelector
                    points={contexts}
                    selectedId={context?.id ?? null}
                    onSelect={(point) => {
                      setContext(point);
                      setDiscovery(null);
                      setSelectedEvent(null);
                      setBooking(null);
                      setPayment(null);
                    }}
                  />
                  <section
                    className="panel discovery-panel"
                    id="discover"
                    aria-labelledby="discover-title"
                  >
                    <div className="section-heading">
                      <div>
                        <p className="eyebrow">LIVE DISCOVERY</p>
                        <h2 id="discover-title">What is happening nearby?</h2>
                      </div>
                      <span className="tag sage">Context-aware</span>
                    </div>
                    <form className="discovery-form" onSubmit={searchEvents}>
                      <label>
                        Category
                        <input
                          value={category}
                          onChange={(event) => setCategory(event.target.value)}
                          placeholder="business events"
                        />
                      </label>
                      <label>
                        Date
                        <input
                          type="date"
                          value={date}
                          onChange={(event) => setDate(event.target.value)}
                          required
                        />
                      </label>
                      <label>
                        From
                        <input
                          type="time"
                          value={fromTime}
                          onChange={(event) => setFromTime(event.target.value)}
                          required
                        />
                      </label>
                      <label>
                        Until
                        <input
                          type="time"
                          value={toTime}
                          onChange={(event) => setToTime(event.target.value)}
                          required
                        />
                      </label>
                      <button
                        className="button accent search-button"
                        disabled={busy || !context}
                        type="submit"
                      >
                        {busy ? "Searching…" : "Find nearby"}
                      </button>
                    </form>
                    {!context ? (
                      <p className="helper-text">
                        Choose a resolved context point before searching.
                      </p>
                    ) : (
                      <p className="helper-text">
                        Searching around <strong>{context.label}</strong> in{" "}
                        {context.timezone}.
                      </p>
                    )}
                  </section>
                  <section className="results-section" aria-live="polite">
                    <div className="section-heading">
                      <div>
                        <p className="eyebrow">YOUR SHORTLIST</p>
                        <h2>Events and activities</h2>
                      </div>
                      {discovery ? (
                        <span className="fresh-label">
                          {discovery.freshness ?? "fresh"} ·{" "}
                          {formatDate(discovery.retrieved_at, "UTC")}
                        </span>
                      ) : null}
                    </div>
                    {discovery?.limitations?.length ? (
                      <details className="limitations">
                        <summary>About this search</summary>
                        {discovery.limitations.map((limitation) => (
                          <p key={limitation}>{limitation}</p>
                        ))}
                      </details>
                    ) : null}
                    {discovery && activeEvents.length === 0 ? (
                      <div className="empty-state">
                        <span className="panel-icon">⌕</span>
                        <h3>No matching events yet</h3>
                        <p>
                          Try a wider category or another time range. The live
                          provider did not return a valid event for this search.
                        </p>
                      </div>
                    ) : null}
                    <div className="event-grid">
                      {activeEvents.map((event) => (
                        <EventCard
                          key={event.id}
                          event={event}
                          sources={selectedSource}
                          timezone={
                            context?.timezone ?? trip?.timezone ?? "UTC"
                          }
                          selected={selectedEvent?.id === event.id}
                          onSelect={() => {
                            if (selectedEvent?.id !== event.id) {
                              setBooking(null);
                              setPayment(null);
                            }
                            setSelectedEvent(event);
                          }}
                        />
                      ))}
                    </div>
                  </section>
                </>
              ) : exploreMode === "stays" ? (
                trip ? (
                  <HotelsView
                    trip={trip}
                    contexts={contexts}
                    context={context}
                    onSelectContext={(point) => setContext(point)}
                    onOpenInvoices={() => showView("invoices")}
                    onOpenBookings={() => showView("bookings")}
                  />
                ) : (
                  <StatusBanner tone="warning">
                    Open a trip before searching stays.
                  </StatusBanner>
                )
              ) : trip ? (
                <FlightsView
                  trip={trip}
                  contexts={contexts}
                  context={context}
                  onSelectContext={(point) => setContext(point)}
                  onOpenInvoices={() => showView("invoices")}
                  onOpenBookings={() => showView("bookings")}
                />
              ) : (
                <StatusBanner tone="warning">
                  Open a trip before searching flights.
                </StatusBanner>
              )}
            </>
          ) : view === "trips" ? (
            <>
              {error ? <StatusBanner tone="error">{error}</StatusBanner> : null}
              <TripsView
                trip={trip}
                trips={trips}
                contexts={contexts}
                context={context}
                onSelectContext={(point) => setContext(point)}
                onSelectTrip={(id) => void selectTrip(id)}
                onTripsChanged={reloadTrips}
                onContextsChanged={reloadContexts}
              />
            </>
          ) : trip ? (
            <ViewHost
              view={view}
              viewProps={{
                trip,
                contexts,
                context,
                onSelectContext: (point) => setContext(point),
                trips,
                onSelectTrip: (id) => void selectTrip(id),
                onTripsChanged: reloadTrips,
                onContextsChanged: reloadContexts,
                onOpenInvoices: () => showView("invoices"),
                onOpenBookings: () => showView("bookings"),
              }}
              error={error}
            />
          ) : (
            <StatusBanner tone="error">
              No trip is available. Open Trips to create one.
            </StatusBanner>
          )}
        </section>
        {view === "explore" && exploreMode === "nearby" ? (
          <BookingPanel
            event={selectedEvent}
            booking={booking}
            payment={payment}
            quote={quote}
            quoteError={quoteError}
            busy={busy}
            onCreate={() => void confirmBooking()}
            onPayment={(outcome) => void choosePayment(outcome)}
            onOpenInvoices={() => showView("invoices")}
          />
        ) : null}
      </div>
    </main>
  );
}

export default function HomePage() {
  const [sessionReady, setSessionReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  // Read once, before the Supabase client touches the URL. Only the login screen shows it.
  const [redirectError] = useState<string | null>(() =>
    typeof window === "undefined"
      ? null
      : readAuthRedirectError(window.location.href),
  );

  useEffect(() => {
    let mounted = true;
    let unsubscribe: () => void = () => undefined;
    try {
      const client = getSupabaseBrowserClient();
      void client.auth.getSession().then(({ data, error }) => {
        if (!mounted) return;
        if (error) setAuthError(error.message);
        setSignedIn(Boolean(data.session));
        setSessionReady(true);
        // Drop error parameters from the address bar so a refresh starts clean.
        if (redirectError) window.history.replaceState(null, "", "/");
      });
      const subscription = client.auth.onAuthStateChange((_event, session) => {
        if (mounted) setSignedIn(Boolean(session));
      });
      unsubscribe = () => subscription.data.subscription.unsubscribe();
    } catch (error) {
      setAuthError(
        error instanceof Error
          ? error.message
          : "Authentication is not configured.",
      );
      setSessionReady(true);
    }
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [redirectError]);

  async function signOut() {
    await getSupabaseBrowserClient().auth.signOut();
    setSignedIn(false);
  }

  if (!sessionReady)
    return (
      <main className="auth-shell">
        <div className="loading-card">
          <span className="spinner" />
          <p>Checking your session…</p>
        </div>
      </main>
    );
  if (!signedIn)
    return (
      <LoginScreen
        notice={redirectError ?? authError}
        onSignedIn={() => setSignedIn(true)}
      />
    );
  if (authError)
    return (
      <main className="auth-shell">
        <StatusBanner tone="error">{authError}</StatusBanner>
      </main>
    );
  return <Workspace onSignOut={signOut} />;
}
