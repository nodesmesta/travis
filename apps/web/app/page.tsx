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
import {
  VIEWS,
  type EnsureTripInput,
  type ViewId,
  type ViewProps,
} from "./views/types";
import {
  useEffect,
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
import { ApiClientError, listContextPoints, listTrips } from "../lib/api";
import { createTrip, newIdempotencyKey } from "../lib/api-trips";
import type { CreateTripBody } from "../lib/types-trips";
import type { ContextPoint, Trip } from "../lib/types";

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

const EXPLORE_MODES = ["stays", "flights"] as const;
type ExploreMode = (typeof EXPLORE_MODES)[number];

const EXPLORE_TITLES: Record<ExploreMode, string> = {
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

/** `YYYY-MM-DD` + `HH:MM` in `timezone`, written with its UTC offset. */
function offsetDateTime(date: string, time: string, timezone: string): string {
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

function browserTimezone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone && zone.length > 0 ? zone : "UTC";
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
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewId>("explore");
  const [exploreMode, setExploreMode] = useState<ExploreMode>("stays");

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

  /**
   * Opens a trip for a search that has none yet. The traveller never fills a
   * trip form just to look at rates: the search supplies the name, destination
   * and dates, and the trip becomes the container of the booking.
   */
  async function ensureTrip(input: EnsureTripInput): Promise<Trip> {
    const timezone = browserTimezone();
    const body: CreateTripBody = {
      name: input.name,
      timezone,
      ...(input.destination ? { destination_summary: input.destination } : {}),
      ...(input.startDate
        ? { start_at: offsetDateTime(input.startDate, "09:00", timezone) }
        : {}),
      ...(input.endDate
        ? { end_at: offsetDateTime(input.endDate, "18:00", timezone) }
        : {}),
    };
    const created = await createTrip(body, newIdempotencyKey("trip"));
    tripRef.current = created;
    setTrips((current) => [created, ...current]);
    setTrip(created);
    return created;
  }

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
        className="workspace-grid two-column"
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
              {exploreMode === "stays" ? (
                <HotelsView
                  trip={trip}
                  contexts={contexts}
                  context={context}
                  onSelectContext={(point) => setContext(point)}
                  onEnsureTrip={ensureTrip}
                  onOpenInvoices={() => showView("invoices")}
                  onOpenBookings={() => showView("bookings")}
                  onOpenTrips={() => showView("trips")}
                />
              ) : (
                <FlightsView
                  trip={trip}
                  contexts={contexts}
                  context={context}
                  onSelectContext={(point) => setContext(point)}
                  onEnsureTrip={ensureTrip}
                  onOpenInvoices={() => showView("invoices")}
                  onOpenBookings={() => showView("bookings")}
                  onOpenTrips={() => showView("trips")}
                />
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
