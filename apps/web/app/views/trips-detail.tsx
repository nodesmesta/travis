"use client";

import { useState, type FormEvent } from "react";
import {
  archiveContextPoint,
  confirmContextPoint,
  createAgendaItem,
  createContextPoint,
  createJourneyLeg,
  describeTripError,
  resolveContextPoint,
  type DescribedError,
} from "../../lib/api-trips";
import {
  validateAgendaForm,
  validateContextPointForm,
  validateJourneyLegForm,
  validateResolveForm,
  type AgendaField,
  type AgendaFormValues,
  type ContextPointField,
  type ContextPointFormValues,
  type JourneyLegField,
  type JourneyLegFormValues,
} from "../../lib/trips-form";
import { formatInZone } from "../../lib/trips-time";
import type { ContextPoint, Trip } from "../../lib/types";
import {
  AGENDA_TYPES,
  CONTEXT_POINT_TYPES,
  type AgendaItemView,
  type JourneyLegView,
} from "../../lib/types-trips";
import {
  ConfirmDialog,
  ErrorNote,
  SelectField,
  TIMEZONE_LIST_ID,
  TextField,
  focusFirstInvalid,
  useIdempotencyKey,
} from "./trips-parts";

const POINT_TYPE_LABEL = new Map<string, string>(
  CONTEXT_POINT_TYPES.map((entry) => [entry.value, entry.label]),
);

function pointTypeLabel(type: string): string {
  return POINT_TYPE_LABEL.get(type) ?? type;
}

function resolutionLabel(point: ContextPoint): string {
  if (point.resolution_status === "resolved") return "Resolved";
  if (point.resolution_status === "ambiguous") {
    return "Needs clarification (ambiguous)";
  }
  return "Needs clarification";
}

const CONTEXT_FIELD_ORDER: readonly ContextPointField[] = [
  "label",
  "address",
  "latitude",
  "longitude",
  "timezone",
  "placeId",
];

function blankPoint(timezone: string): ContextPointFormValues {
  return {
    type: "hotel",
    label: "",
    address: "",
    latitude: "",
    longitude: "",
    timezone,
    placeId: "",
  };
}

function ResolveForm({
  tripId,
  point,
  onDone,
  onCancel,
  onNotice,
}: {
  tripId: string;
  point: ContextPoint;
  onDone: () => Promise<void>;
  onCancel: () => void;
  onNotice: (message: string) => void;
}) {
  const [values, setValues] = useState({
    label: point.label,
    address: point.address ?? "",
    latitude: point.latitude === null ? "" : String(point.latitude),
    longitude: point.longitude === null ? "" : String(point.longitude),
    timezone: point.timezone,
    placeId: point.external_place_id ?? "",
  });
  const [errors, setErrors] = useState<
    Partial<Record<ContextPointField, string>>
  >({});
  const [error, setError] = useState<DescribedError | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useIdempotencyKey("context-resolve");
  const prefix = `trp-resolve-${point.id}`;

  function set(field: keyof typeof values, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = validateResolveForm(values);
    setErrors(result.errors);
    if (!result.value) {
      focusFirstInvalid(prefix, CONTEXT_FIELD_ORDER, result.errors);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await resolveContextPoint(
        tripId,
        point.id,
        result.value,
        key.keyFor(result.value),
      );
      key.done();
      onNotice(
        `“${point.label}” is resolved. Confirm it when the place is right.`,
      );
      await onDone();
    } catch (caught) {
      setError(describeTripError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="trp-form trp-inline" onSubmit={submit} noValidate>
      <p className="helper-text">
        Add the exact location to resolve “{point.label}”. A place needs
        coordinates and a place reference (the ID of the place in your map
        provider) before routes can use it.
      </p>
      <TextField
        id={`${prefix}-label`}
        label="Name"
        value={values.label}
        onChange={(value) => set("label", value)}
        error={errors.label}
      />
      <TextField
        id={`${prefix}-address`}
        label="Address"
        value={values.address}
        onChange={(value) => set("address", value)}
        error={errors.address}
      />
      <TextField
        id={`${prefix}-latitude`}
        label="Latitude"
        type="number"
        step="any"
        value={values.latitude}
        onChange={(value) => set("latitude", value)}
        error={errors.latitude}
        required
      />
      <TextField
        id={`${prefix}-longitude`}
        label="Longitude"
        type="number"
        step="any"
        value={values.longitude}
        onChange={(value) => set("longitude", value)}
        error={errors.longitude}
        required
      />
      <TextField
        id={`${prefix}-timezone`}
        label="Timezone"
        value={values.timezone}
        onChange={(value) => set("timezone", value)}
        error={errors.timezone}
        list={TIMEZONE_LIST_ID}
        required
      />
      <TextField
        id={`${prefix}-placeId`}
        label="Place reference"
        value={values.placeId}
        onChange={(value) => set("placeId", value)}
        error={errors.placeId}
        required
        hint="The place ID from your map provider."
      />
      <ErrorNote error={error} title="The place was not resolved" />
      <div className="button-row">
        <button className="button primary" type="submit" disabled={busy}>
          {busy ? "Resolving…" : "Resolve place"}
        </button>
        <button
          className="button ghost"
          type="button"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Places of the trip: add, clarify (resolve), confirm, archive. */
export function ContextPointsPanel({
  trip,
  contexts,
  onChanged,
  onNotice,
}: {
  trip: Trip;
  contexts: ContextPoint[];
  onChanged: () => Promise<void>;
  onNotice: (message: string) => void;
}) {
  const [values, setValues] = useState<ContextPointFormValues>(() =>
    blankPoint(trip.timezone),
  );
  const [errors, setErrors] = useState<
    Partial<Record<ContextPointField, string>>
  >({});
  const [error, setError] = useState<DescribedError | null>(null);
  const [busy, setBusy] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [archiving, setArchiving] = useState<ContextPoint | null>(null);
  const [archiveError, setArchiveError] = useState<DescribedError | null>(null);
  const createKey = useIdempotencyKey("context-create");
  const actionKey = useIdempotencyKey("context-action");

  function set<K extends keyof ContextPointFormValues>(
    field: K,
    value: ContextPointFormValues[K],
  ) {
    setValues((current) => ({ ...current, [field]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = validateContextPointForm(values);
    setErrors(result.errors);
    if (!result.value) {
      focusFirstInvalid("trp-point", CONTEXT_FIELD_ORDER, result.errors);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await createContextPoint(
        trip.id,
        result.value,
        createKey.keyFor(result.value),
      );
      createKey.done();
      setValues(blankPoint(trip.timezone));
      setErrors({});
      if (created.kind === "awaiting_clarification") {
        setResolvingId(created.context_point.id);
        onNotice(
          `“${created.context_point.label}” was saved but needs clarification. ${created.clarification ?? ""} Add its coordinates and place reference to resolve it.`,
        );
      } else {
        onNotice(`“${created.context_point.label}” was added and is resolved.`);
      }
      await onChanged();
    } catch (caught) {
      setError(describeTripError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function confirmPoint(point: ContextPoint) {
    setBusy(true);
    setError(null);
    try {
      await confirmContextPoint(trip.id, point.id, actionKey.keyFor(point.id));
      actionKey.done();
      onNotice(`“${point.label}” is confirmed.`);
      await onChanged();
    } catch (caught) {
      setError(describeTripError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function archivePoint() {
    if (!archiving) return;
    setBusy(true);
    setArchiveError(null);
    try {
      await archiveContextPoint(
        trip.id,
        archiving.id,
        actionKey.keyFor(archiving.id),
      );
      actionKey.done();
      onNotice(`“${archiving.label}” was archived.`);
      setArchiving(null);
      await onChanged();
    } catch (caught) {
      setArchiveError(describeTripError(caught));
    } finally {
      setBusy(false);
    }
  }

  const active = contexts.filter((point) => point.status === "active");
  const archived = contexts.filter((point) => point.status === "archived");

  return (
    <section className="trp-card" aria-labelledby="trp-points-heading">
      <h3 id="trp-points-heading">Places</h3>
      <p className="helper-text">
        Hotels, airports, meeting venues, and other places in this trip. A place
        is resolved when it has coordinates and a place reference. Otherwise it
        stays marked as needing clarification.
      </p>
      <ErrorNote error={error} title="That did not work" />
      {active.length === 0 ? (
        <p className="helper-text">No places yet. Add the first one below.</p>
      ) : (
        <ul className="trp-points" aria-label="Places in this trip">
          {active.map((point) => (
            <li key={point.id} className="trp-point" data-point-id={point.id}>
              <div>
                <strong>{point.label}</strong>{" "}
                <span className="tag">{pointTypeLabel(point.type)}</span>{" "}
                <span
                  className={`tag ${point.resolution_status === "resolved" ? "sage" : "coral"}`}
                >
                  {resolutionLabel(point)}
                </span>
                {point.resolution_status === "resolved" ? (
                  <>
                    {" "}
                    <span className="tag">
                      {point.confirmation_status === "confirmed"
                        ? "Confirmed"
                        : "Not confirmed"}
                    </span>
                  </>
                ) : null}
              </div>
              <p className="asst-muted">
                {point.address ?? "No address"} ·{" "}
                {point.latitude !== null && point.longitude !== null
                  ? `${point.latitude}, ${point.longitude}`
                  : "No coordinates"}{" "}
                · {point.timezone}
              </p>
              <div className="button-row">
                {point.resolution_status !== "resolved" ? (
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy}
                    aria-label={`Resolve ${point.label}`}
                    aria-expanded={resolvingId === point.id}
                    onClick={() =>
                      setResolvingId(resolvingId === point.id ? null : point.id)
                    }
                  >
                    Resolve
                  </button>
                ) : null}
                {point.resolution_status === "resolved" &&
                point.confirmation_status !== "confirmed" ? (
                  <button
                    type="button"
                    className="button accent"
                    disabled={busy}
                    aria-label={`Confirm ${point.label}`}
                    onClick={() => void confirmPoint(point)}
                  >
                    Confirm place
                  </button>
                ) : null}
                <button
                  type="button"
                  className="button ghost"
                  disabled={busy}
                  aria-label={`Archive ${point.label}`}
                  onClick={() => {
                    setArchiveError(null);
                    setArchiving(point);
                  }}
                >
                  Archive
                </button>
              </div>
              {resolvingId === point.id ? (
                <ResolveForm
                  tripId={trip.id}
                  point={point}
                  onNotice={onNotice}
                  onCancel={() => setResolvingId(null)}
                  onDone={async () => {
                    setResolvingId(null);
                    await onChanged();
                  }}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {archived.length > 0 ? (
        <details className="trp-archived">
          <summary>Archived places ({archived.length})</summary>
          <ul>
            {archived.map((point) => (
              <li key={point.id}>
                {point.label} · {pointTypeLabel(point.type)} · Archived
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <form className="trp-form" onSubmit={submit} noValidate>
        <h4>Add a place</h4>
        <SelectField
          id="trp-point-type"
          label="Type"
          value={values.type}
          onChange={(value) =>
            set("type", value as ContextPointFormValues["type"])
          }
          options={CONTEXT_POINT_TYPES.map((entry) => ({
            value: entry.value,
            label: entry.label,
          }))}
          required
        />
        <TextField
          id="trp-point-label"
          label="Name"
          value={values.label}
          onChange={(value) => set("label", value)}
          error={errors.label}
          required
          placeholder="Hotel Indonesia Kempinski"
        />
        <TextField
          id="trp-point-address"
          label="Address"
          value={values.address}
          onChange={(value) => set("address", value)}
          error={errors.address}
        />
        <TextField
          id="trp-point-latitude"
          label="Latitude"
          type="number"
          step="any"
          value={values.latitude}
          onChange={(value) => set("latitude", value)}
          error={errors.latitude}
          hint="Optional. Between -90 and 90."
        />
        <TextField
          id="trp-point-longitude"
          label="Longitude"
          type="number"
          step="any"
          value={values.longitude}
          onChange={(value) => set("longitude", value)}
          error={errors.longitude}
          hint="Optional. Between -180 and 180."
        />
        <TextField
          id="trp-point-timezone"
          label="Timezone"
          value={values.timezone}
          onChange={(value) => set("timezone", value)}
          error={errors.timezone}
          list={TIMEZONE_LIST_ID}
          required
        />
        <TextField
          id="trp-point-placeId"
          label="Place reference"
          value={values.placeId}
          onChange={(value) => set("placeId", value)}
          error={errors.placeId}
          hint="Optional. The place ID from your map provider. With coordinates it marks the place as resolved."
        />
        <div className="button-row">
          <button className="button primary" type="submit" disabled={busy}>
            {busy ? "Adding…" : "Add place"}
          </button>
        </div>
      </form>

      {archiving ? (
        <ConfirmDialog
          title={`Archive “${archiving.label}”?`}
          body={
            <p>
              An archived place can no longer be used for new routes or agenda
              items. This cannot be undone.
            </p>
          }
          confirmLabel="Archive place"
          busy={busy}
          error={archiveError}
          onConfirm={() => void archivePoint()}
          onCancel={() => setArchiving(null)}
        />
      ) : null}
    </section>
  );
}

const AGENDA_FIELD_ORDER: readonly AgendaField[] = [
  "title",
  "start",
  "end",
  "timezone",
];

/** Adds a timed agenda item to the trip. */
export function AgendaPanel({
  trip,
  contexts,
  onChanged,
  onNotice,
}: {
  trip: Trip;
  contexts: ContextPoint[];
  onChanged: () => Promise<void>;
  onNotice: (message: string) => void;
}) {
  const blank = (): AgendaFormValues => ({
    title: "",
    type: "meeting",
    start: "",
    end: "",
    timezone: trip.timezone,
    contextPointId: "",
  });
  const [values, setValues] = useState<AgendaFormValues>(blank);
  const [errors, setErrors] = useState<Partial<Record<AgendaField, string>>>(
    {},
  );
  const [error, setError] = useState<DescribedError | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useIdempotencyKey("agenda-create");

  function set<K extends keyof AgendaFormValues>(
    field: K,
    value: AgendaFormValues[K],
  ) {
    setValues((current) => ({ ...current, [field]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = validateAgendaForm(values);
    setErrors(result.errors);
    if (!result.value) {
      focusFirstInvalid("trp-agenda", AGENDA_FIELD_ORDER, result.errors);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await createAgendaItem(
        trip.id,
        result.value,
        key.keyFor(result.value),
      );
      key.done();
      setValues(blank());
      onNotice(`“${created.title}” was added to the agenda.`);
      await onChanged();
    } catch (caught) {
      setError(describeTripError(caught));
    } finally {
      setBusy(false);
    }
  }

  const places = contexts.filter((point) => point.status === "active");
  return (
    <section className="trp-card" aria-labelledby="trp-agenda-heading">
      <h3 id="trp-agenda-heading">Add an agenda item</h3>
      <form className="trp-form" onSubmit={submit} noValidate>
        <TextField
          id="trp-agenda-title"
          label="Title"
          value={values.title}
          onChange={(value) => set("title", value)}
          error={errors.title}
          required
          placeholder="Kick-off meeting"
        />
        <SelectField
          id="trp-agenda-type"
          label="Type"
          value={values.type}
          onChange={(value) => set("type", value as AgendaFormValues["type"])}
          options={AGENDA_TYPES.map((entry) => ({
            value: entry.value,
            label: entry.label,
          }))}
          required
        />
        <TextField
          id="trp-agenda-timezone"
          label="Timezone"
          value={values.timezone}
          onChange={(value) => set("timezone", value)}
          error={errors.timezone}
          list={TIMEZONE_LIST_ID}
          required
        />
        <TextField
          id="trp-agenda-start"
          label="Starts"
          type="datetime-local"
          value={values.start}
          onChange={(value) => set("start", value)}
          error={errors.start}
          required
        />
        <TextField
          id="trp-agenda-end"
          label="Ends"
          type="datetime-local"
          value={values.end}
          onChange={(value) => set("end", value)}
          error={errors.end}
          required
        />
        <SelectField
          id="trp-agenda-place"
          label="Place"
          value={values.contextPointId}
          onChange={(value) => set("contextPointId", value)}
          placeholder="No place"
          options={places.map((point) => ({
            value: point.id,
            label: point.label,
          }))}
          hint="Optional."
        />
        <ErrorNote error={error} title="The agenda item was not saved" />
        <div className="button-row">
          <button className="button primary" type="submit" disabled={busy}>
            {busy ? "Adding…" : "Add agenda item"}
          </button>
        </div>
      </form>
    </section>
  );
}

const LEG_FIELD_ORDER: readonly JourneyLegField[] = [
  "origin",
  "destination",
  "departure",
  "deadline",
];

/** Adds a journey leg. Origin and destination are chosen by the user; there is no default. */
export function JourneyLegPanel({
  trip,
  contexts,
  onChanged,
  onNotice,
}: {
  trip: Trip;
  contexts: ContextPoint[];
  onChanged: () => Promise<void>;
  onNotice: (message: string) => void;
}) {
  const blank = (): JourneyLegFormValues => ({
    origin: "",
    destination: "",
    departure: "",
    deadline: "",
    timezone: trip.timezone,
  });
  const [values, setValues] = useState<JourneyLegFormValues>(blank);
  const [errors, setErrors] = useState<
    Partial<Record<JourneyLegField, string>>
  >({});
  const [error, setError] = useState<DescribedError | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useIdempotencyKey("leg-create");

  function set<K extends keyof JourneyLegFormValues>(
    field: K,
    value: JourneyLegFormValues[K],
  ) {
    setValues((current) => ({ ...current, [field]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = validateJourneyLegForm({
      ...values,
      timezone: trip.timezone,
    });
    setErrors(result.errors);
    if (!result.value) {
      focusFirstInvalid("trp-leg", LEG_FIELD_ORDER, result.errors);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createJourneyLeg(trip.id, result.value, key.keyFor(result.value));
      key.done();
      setValues(blank());
      onNotice("The journey leg was added.");
      await onChanged();
    } catch (caught) {
      setError(describeTripError(caught));
    } finally {
      setBusy(false);
    }
  }

  const places = contexts.filter(
    (point) =>
      point.status === "active" && point.resolution_status === "resolved",
  );
  const options = places.map((point) => ({
    value: point.id,
    label: `${point.label} (${point.type.split("_").join(" ")})`,
  }));
  return (
    <section className="trp-card" aria-labelledby="trp-leg-heading">
      <h3 id="trp-leg-heading">Add a journey leg</h3>
      <p className="helper-text">
        Choose where the journey starts and where it ends. Only resolved places
        can be used, and nothing is chosen for you.
      </p>
      {places.length < 2 ? (
        <p className="helper-text" role="status">
          You need at least two resolved places to add a journey leg.
        </p>
      ) : null}
      <form className="trp-form" onSubmit={submit} noValidate>
        <SelectField
          id="trp-leg-origin"
          label="From"
          value={values.origin}
          onChange={(value) => set("origin", value)}
          placeholder="Choose a place"
          options={options}
          error={errors.origin}
          required
        />
        <SelectField
          id="trp-leg-destination"
          label="To"
          value={values.destination}
          onChange={(value) => set("destination", value)}
          placeholder="Choose a place"
          options={options}
          error={errors.destination}
          required
        />
        <TextField
          id="trp-leg-departure"
          label="Departure"
          type="datetime-local"
          value={values.departure}
          onChange={(value) => set("departure", value)}
          error={errors.departure}
          required
          hint={`Local time in ${trip.timezone}.`}
        />
        <TextField
          id="trp-leg-deadline"
          label="Arrive by"
          type="datetime-local"
          value={values.deadline}
          onChange={(value) => set("deadline", value)}
          error={errors.deadline}
          hint="Optional."
        />
        <ErrorNote error={error} title="The journey leg was not saved" />
        <div className="button-row">
          <button className="button primary" type="submit" disabled={busy}>
            {busy ? "Adding…" : "Add journey leg"}
          </button>
        </div>
      </form>
    </section>
  );
}

type TimelineEntry =
  | { kind: "agenda"; at: string; item: AgendaItemView }
  | { kind: "leg"; at: string; leg: JourneyLegView };

/** A small timeline of what the trip holds so far, in the trip timezone. */
export function TimelineSummary({
  trip,
  contexts,
  agenda,
  legs,
  loading,
  error,
}: {
  trip: Trip;
  contexts: ContextPoint[];
  agenda: AgendaItemView[];
  legs: JourneyLegView[];
  loading: boolean;
  error: DescribedError | null;
}) {
  const label = (id: string) =>
    contexts.find((point) => point.id === id)?.label ?? "Unknown place";
  const entries: TimelineEntry[] = [
    ...agenda.map((item): TimelineEntry => ({
      kind: "agenda",
      at: item.start_at,
      item,
    })),
    ...legs.map((leg): TimelineEntry => ({
      kind: "leg",
      at: leg.departure_at,
      leg,
    })),
  ].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  return (
    <section className="trp-card" aria-labelledby="trp-timeline-heading">
      <h3 id="trp-timeline-heading">Timeline so far</h3>
      <ErrorNote error={error} title="The timeline could not be loaded" />
      {loading ? (
        <p className="helper-text" role="status">
          Loading the timeline…
        </p>
      ) : null}
      {!loading && !error && entries.length === 0 ? (
        <p className="helper-text">
          Nothing is planned yet. Agenda items and journey legs appear here.
        </p>
      ) : null}
      <ol className="trp-timeline" aria-label="Agenda items and journey legs">
        {entries.map((entry) =>
          entry.kind === "agenda" ? (
            <li key={`a-${entry.item.id}`}>
              <time dateTime={entry.item.start_at}>
                {formatInZone(entry.item.start_at, trip.timezone)}
              </time>
              <span>
                <strong>{entry.item.title}</strong> · agenda ·{" "}
                {entry.item.status}
              </span>
            </li>
          ) : (
            <li key={`l-${entry.leg.id}`}>
              <time dateTime={entry.leg.departure_at}>
                {formatInZone(entry.leg.departure_at, trip.timezone)}
              </time>
              <span>
                <strong>
                  {label(entry.leg.origin_context_point_id)} →{" "}
                  {label(entry.leg.destination_context_point_id)}
                </strong>{" "}
                · journey leg · {entry.leg.status.split("_").join(" ")}
              </span>
            </li>
          ),
        )}
      </ol>
    </section>
  );
}
