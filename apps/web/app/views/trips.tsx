"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { listAgendaItems, listJourneyLegs } from "../../lib/api-assistant";
import {
  createTrip,
  describeTripError,
  transitionTrip,
  updateTrip,
  type DescribedError,
} from "../../lib/api-trips";
import { tripChanges } from "../../lib/trips-form";
import type { Trip } from "../../lib/types";
import type {
  AgendaItemView,
  CreateTripBody,
  JourneyLegView,
} from "../../lib/types-trips";
import {
  AgendaPanel,
  ContextPointsPanel,
  JourneyLegPanel,
  TimelineSummary,
} from "./trips-detail";
import {
  ConfirmDialog,
  ErrorNote,
  TimeZoneOptions,
  TripForm,
  TripList,
  browserTimeZone,
  statusLabel,
  useIdempotencyKey,
} from "./trips-parts";
import type { TripsViewProps } from "./types";

interface PendingTransition {
  trip: Trip;
  target: "confirmed" | "active" | "completed";
  action: string;
}

interface Lists {
  agenda: AgendaItemView[];
  legs: JourneyLegView[];
  loading: boolean;
  error: DescribedError | null;
}

/** Trip setup (6.3): create and edit trips, move them forward, and fill the open trip with places, agenda items, and journey legs. */
export default function TripsView({
  trip,
  trips: allTrips,
  contexts,
  onSelectTrip,
  onTripsChanged,
  onContextsChanged,
}: TripsViewProps) {
  const trips = allTrips ?? (trip ? [trip] : []);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pageError, setPageError] = useState<DescribedError | null>(null);
  const [createError, setCreateError] = useState<DescribedError | null>(null);
  const [editError, setEditError] = useState<DescribedError | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingTransition | null>(null);
  const [transitionError, setTransitionError] = useState<DescribedError | null>(
    null,
  );
  const [lists, setLists] = useState<Lists>({
    agenda: [],
    legs: [],
    loading: false,
    error: null,
  });
  const createKey = useIdempotencyKey("trip-create");
  const transitionKey = useIdempotencyKey("trip-transition");
  const defaultTimezone = useRef(browserTimeZone());
  const tripId = trip?.id ?? null;

  const loadLists = useCallback(async (id: string): Promise<Lists> => {
    const [agenda, legs] = await Promise.allSettled([
      listAgendaItems(id),
      listJourneyLegs(id),
    ]);
    const failure =
      agenda.status === "rejected"
        ? agenda.reason
        : legs.status === "rejected"
          ? legs.reason
          : null;
    return {
      agenda: agenda.status === "fulfilled" ? agenda.value.items : [],
      legs: legs.status === "fulfilled" ? legs.value.items : [],
      loading: false,
      error: failure === null ? null : describeTripError(failure),
    };
  }, []);

  useEffect(() => {
    if (!tripId) {
      setLists({ agenda: [], legs: [], loading: false, error: null });
      return;
    }
    let current = true;
    setLists((existing) => ({ ...existing, loading: true }));
    void loadLists(tripId).then((result) => {
      if (current) setLists(result);
    });
    return () => {
      current = false;
    };
  }, [tripId, loadLists]);

  const reloadLists = useCallback(async () => {
    if (!tripId) return;
    setLists(await loadLists(tripId));
  }, [tripId, loadLists]);

  async function refreshTrips(selectTripId?: string) {
    try {
      await onTripsChanged?.(selectTripId);
      setPageError(null);
    } catch (caught) {
      setPageError(describeTripError(caught));
    }
  }

  async function handleCreate(body: CreateTripBody): Promise<boolean> {
    setBusy(true);
    setCreateError(null);
    setNotice(null);
    try {
      const created = await createTrip(body, createKey.keyFor(body));
      createKey.done();
      setNotice(
        `Trip “${created.name}” was created as a draft and is now open in the workspace.`,
      );
      await refreshTrips(created.id);
      return true;
    } catch (caught) {
      setCreateError(describeTripError(caught));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleEdit(
    original: Trip,
    body: CreateTripBody,
  ): Promise<boolean> {
    const changes = tripChanges(original, body);
    if (Object.keys(changes).length === 0) {
      setEditError({
        message: "Nothing has changed yet. Edit a field, then save.",
        code: "NO_CHANGES",
      });
      return false;
    }
    setBusy(true);
    setEditError(null);
    setNotice(null);
    try {
      const updated = await updateTrip(original.id, changes);
      setNotice(`Trip “${updated.name}” was updated.`);
      setEditingId(null);
      await refreshTrips();
      return true;
    } catch (caught) {
      setEditError(describeTripError(caught));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleTransition() {
    if (!pending) return;
    setBusy(true);
    setTransitionError(null);
    try {
      const updated = await transitionTrip(
        pending.trip.id,
        pending.target,
        transitionKey.keyFor({ id: pending.trip.id, target: pending.target }),
      );
      transitionKey.done();
      setNotice(
        `Trip “${updated.name}” is now ${statusLabel(updated.status)}.`,
      );
      setPending(null);
      await refreshTrips();
    } catch (caught) {
      setTransitionError(describeTripError(caught));
      // The trip may have changed elsewhere (for example in another tab), so show its real status.
      void refreshTrips();
    } finally {
      setBusy(false);
    }
  }

  function openTrip(id: string) {
    const target = trips.find((item) => item.id === id);
    onSelectTrip?.(id);
    if (target) setNotice(`“${target.name}” is now open in the workspace.`);
  }

  return (
    <section className="panel trp-view" aria-labelledby="trips-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">TRIP SETUP</p>
          <h2 id="trips-title">Your trips</h2>
        </div>
        <span className="count-badge" aria-label={`${trips.length} trips`}>
          {trips.length}
        </span>
      </div>
      <p className="helper-text">
        Create a trip, then add its places, agenda, and journey legs. The trip
        you open here is the one the other views use.
      </p>

      <div role="status" aria-live="polite" aria-atomic="true">
        {notice ? (
          <div className="status-banner success trp-notice">{notice}</div>
        ) : null}
      </div>
      <ErrorNote error={pageError} title="The trips could not be refreshed" />

      <div className="trp-grid">
        <section className="trp-card" aria-labelledby="trp-create-heading">
          <h3 id="trp-create-heading">Create a trip</h3>
          <TripForm
            idPrefix="trp-create"
            defaultTimezone={defaultTimezone.current}
            busy={busy}
            error={createError}
            submitLabel="Create trip"
            onSubmit={handleCreate}
          />
        </section>
        <section className="trp-card" aria-labelledby="trp-list-heading">
          <h3 id="trp-list-heading">Trips</h3>
          <TripList
            trips={trips}
            activeId={tripId}
            busy={busy}
            editingId={editingId}
            onOpen={openTrip}
            onEdit={(id) => {
              setEditError(null);
              setEditingId(id);
            }}
            onTransition={(item, target, action) => {
              setTransitionError(null);
              setPending({ trip: item, target, action });
            }}
            renderEditor={(item) => (
              <TripForm
                idPrefix={`trp-edit-${item.id}`}
                trip={item}
                defaultTimezone={item.timezone}
                busy={busy}
                error={editError}
                submitLabel="Save changes"
                onSubmit={(body) => handleEdit(item, body)}
                onCancel={() => setEditingId(null)}
              />
            )}
          />
        </section>
      </div>

      <TimeZoneOptions />

      {trip ? (
        <div className="trp-detail" key={trip.id}>
          <div className="section-heading">
            <div>
              <p className="eyebrow">
                OPEN TRIP · {statusLabel(trip.status).toUpperCase()}
              </p>
              <h2>Plan “{trip.name}”</h2>
            </div>
          </div>
          <div className="trp-grid">
            <ContextPointsPanel
              trip={trip}
              contexts={contexts}
              onNotice={setNotice}
              onChanged={async () => {
                await onContextsChanged?.();
              }}
            />
            <TimelineSummary
              trip={trip}
              contexts={contexts}
              agenda={lists.agenda}
              legs={lists.legs}
              loading={lists.loading}
              error={lists.error}
            />
            <AgendaPanel
              trip={trip}
              contexts={contexts}
              onNotice={setNotice}
              onChanged={reloadLists}
            />
            <JourneyLegPanel
              trip={trip}
              contexts={contexts}
              onNotice={setNotice}
              onChanged={reloadLists}
            />
          </div>
        </div>
      ) : (
        <div className="empty-state">
          <h3>No trip is open</h3>
          <p>Create a trip above to add places, an agenda, and journey legs.</p>
        </div>
      )}

      {pending ? (
        <ConfirmDialog
          title={`${pending.action}: “${pending.trip.name}”?`}
          body={
            <p>
              The status changes from {statusLabel(pending.trip.status)} to{" "}
              {statusLabel(pending.target)}. A trip only moves forward, so this
              cannot be undone.
            </p>
          }
          confirmLabel={pending.action}
          busy={busy}
          error={transitionError}
          onConfirm={() => void handleTransition()}
          onCancel={() => setPending(null)}
        />
      ) : null}
    </section>
  );
}
