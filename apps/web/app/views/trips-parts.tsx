"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { newIdempotencyKey, type DescribedError } from "../../lib/api-trips";
import {
  validateTripForm,
  type TripField,
  type TripFormValues,
} from "../../lib/trips-form";
import {
  formatInZone,
  isoToZonedLocal,
  supportedTimeZones,
} from "../../lib/trips-time";
import type { Trip } from "../../lib/types";
import { TRIP_TRANSITIONS, type CreateTripBody } from "../../lib/types-trips";

export const TIMEZONE_LIST_ID = "trp-timezone-options";

/**
 * One Idempotency-Key per submit. The same key is reused while the body stays
 * the same (a double click or a retry after a network error returns the first
 * result); a changed body gets a new key, because the server refuses a key that
 * was used with a different body.
 */
export function useIdempotencyKey(operation: string): {
  keyFor: (payload: unknown) => string;
  done: () => void;
} {
  const stored = useRef<{ fingerprint: string; key: string } | null>(null);
  return {
    keyFor(payload) {
      const fingerprint = JSON.stringify(payload);
      if (stored.current?.fingerprint !== fingerprint) {
        stored.current = { fingerprint, key: newIdempotencyKey(operation) };
      }
      return stored.current.key;
    },
    done() {
      stored.current = null;
    },
  };
}

/** The browser timezone when it is a real IANA name, otherwise UTC. */
export function browserTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone && supportedTimeZones().includes(zone) ? zone : "UTC";
}

export function TimeZoneOptions() {
  return (
    <datalist id={TIMEZONE_LIST_ID}>
      {supportedTimeZones().map((zone) => (
        <option key={zone} value={zone} />
      ))}
    </datalist>
  );
}

/** A server or client problem. The server message is shown as received, with its code and request id. */
export function ErrorNote({
  error,
  title,
}: {
  error: DescribedError | null;
  title?: string;
}) {
  if (!error) return null;
  return (
    <div className="status-banner error trp-error" role="alert">
      {title ? <strong>{title}</strong> : null}
      <span>{error.message}</span>
      <small>
        Code: {error.code}
        {error.requestId ? ` · Request ID: ${error.requestId}` : ""}
      </small>
    </div>
  );
}

interface TextFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  hint?: string | undefined;
  type?: string | undefined;
  required?: boolean | undefined;
  list?: string | undefined;
  step?: string | undefined;
  placeholder?: string | undefined;
  autoComplete?: string | undefined;
  disabled?: boolean | undefined;
}

export function TextField(props: TextFieldProps) {
  const hintId = `${props.id}-hint`;
  const errorId = `${props.id}-error`;
  const describedBy =
    [props.hint ? hintId : "", props.error ? errorId : ""]
      .filter((entry) => entry.length > 0)
      .join(" ") || undefined;
  return (
    <div className="trp-field">
      <label htmlFor={props.id}>
        {props.label}
        {props.required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <input
        id={props.id}
        type={props.type ?? "text"}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        required={props.required}
        list={props.list}
        step={props.step}
        placeholder={props.placeholder}
        autoComplete={props.autoComplete ?? "off"}
        disabled={props.disabled}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={describedBy}
      />
      {props.hint ? (
        <small id={hintId} className="trp-hint">
          {props.hint}
        </small>
      ) : null}
      {props.error ? (
        <small id={errorId} className="trp-field-error">
          Problem: {props.error}
        </small>
      ) : null}
    </div>
  );
}

interface SelectFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  /** Label of the empty first option. When set, nothing is chosen by default. */
  placeholder?: string | undefined;
  error?: string | undefined;
  hint?: string | undefined;
  required?: boolean | undefined;
}

export function SelectField(props: SelectFieldProps) {
  const hintId = `${props.id}-hint`;
  const errorId = `${props.id}-error`;
  const describedBy =
    [props.hint ? hintId : "", props.error ? errorId : ""]
      .filter((entry) => entry.length > 0)
      .join(" ") || undefined;
  return (
    <div className="trp-field">
      <label htmlFor={props.id}>
        {props.label}
        {props.required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <select
        id={props.id}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={describedBy}
      >
        {props.placeholder !== undefined ? (
          <option value="">{props.placeholder}</option>
        ) : null}
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {props.hint ? (
        <small id={hintId} className="trp-hint">
          {props.hint}
        </small>
      ) : null}
      {props.error ? (
        <small id={errorId} className="trp-field-error">
          Problem: {props.error}
        </small>
      ) : null}
    </div>
  );
}

/** Focuses the first field that has a problem, so keyboard and screen reader users land on it. */
export function focusFirstInvalid(
  idPrefix: string,
  order: readonly string[],
  errors: Partial<Record<string, string>>,
): void {
  const first = order.find((field) => errors[field]);
  if (first) document.getElementById(`${idPrefix}-${first}`)?.focus();
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  busy: boolean;
  error: DescribedError | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const previous = useRef<Element | null>(null);

  useEffect(() => {
    previous.current = document.activeElement;
    cancelRef.current?.focus();
    return () => {
      if (previous.current instanceof HTMLElement) previous.current.focus();
    };
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && !busy) {
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key === "Tab") {
      const first = cancelRef.current;
      const last = confirmRef.current;
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  return (
    <div className="asst-backdrop" onKeyDown={onKeyDown}>
      <div
        className="asst-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="trp-confirm-title"
        aria-describedby="trp-confirm-body"
      >
        <p className="eyebrow">PLEASE CONFIRM</p>
        <h3 id="trp-confirm-title">{title}</h3>
        <div id="trp-confirm-body">{body}</div>
        <ErrorNote error={error} />
        <div className="button-row">
          <button
            ref={cancelRef}
            type="button"
            className="button ghost"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="button primary"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  confirmed: "Confirmed",
  active: "Active",
  completed: "Completed",
};

export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

const TRIP_FIELD_ORDER: readonly TripField[] = [
  "name",
  "destination",
  "start",
  "end",
  "timezone",
];

function initialValues(
  trip: Trip | undefined,
  timezone: string,
): TripFormValues {
  if (!trip) {
    return { name: "", destination: "", start: "", end: "", timezone };
  }
  return {
    name: trip.name,
    destination: trip.destination_summary ?? "",
    start: trip.start_at ? isoToZonedLocal(trip.start_at, trip.timezone) : "",
    end: trip.end_at ? isoToZonedLocal(trip.end_at, trip.timezone) : "",
    timezone: trip.timezone,
  };
}

/** The create and edit form for a trip. `onSubmit` resolves to true when the server accepted it. */
export function TripForm({
  idPrefix,
  trip,
  defaultTimezone,
  busy,
  error,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  idPrefix: string;
  /** Present when editing. */
  trip?: Trip;
  defaultTimezone: string;
  busy: boolean;
  error: DescribedError | null;
  submitLabel: string;
  onSubmit: (body: CreateTripBody) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const [values, setValues] = useState<TripFormValues>(() =>
    initialValues(trip, defaultTimezone),
  );
  const [errors, setErrors] = useState<Partial<Record<TripField, string>>>({});

  function set<K extends keyof TripFormValues>(
    field: K,
    value: TripFormValues[K],
  ) {
    setValues((current) => ({ ...current, [field]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = validateTripForm(values);
    setErrors(result.errors);
    if (!result.value) {
      focusFirstInvalid(idPrefix, TRIP_FIELD_ORDER, result.errors);
      return;
    }
    const accepted = await onSubmit(result.value);
    if (accepted && !trip) {
      setValues(initialValues(undefined, defaultTimezone));
      setErrors({});
    }
  }

  return (
    <form className="trp-form" onSubmit={submit} noValidate>
      <TextField
        id={`${idPrefix}-name`}
        label="Trip name"
        value={values.name}
        onChange={(value) => set("name", value)}
        error={errors.name}
        required
        placeholder="Jakarta business trip"
      />
      <TextField
        id={`${idPrefix}-destination`}
        label="Destination"
        value={values.destination}
        onChange={(value) => set("destination", value)}
        error={errors.destination}
        placeholder="Jakarta, Indonesia"
      />
      <TextField
        id={`${idPrefix}-timezone`}
        label="Timezone"
        value={values.timezone}
        onChange={(value) => set("timezone", value)}
        error={errors.timezone}
        list={TIMEZONE_LIST_ID}
        required
        hint="Start typing a city, for example Asia/Jakarta. The dates below are read in this timezone."
      />
      <TextField
        id={`${idPrefix}-start`}
        label="Start"
        type="datetime-local"
        value={values.start}
        onChange={(value) => set("start", value)}
        error={errors.start}
        hint="Optional. Local time at the destination."
      />
      <TextField
        id={`${idPrefix}-end`}
        label="End"
        type="datetime-local"
        value={values.end}
        onChange={(value) => set("end", value)}
        error={errors.end}
        hint="Optional. Must be after the start."
      />
      <ErrorNote error={error} title="The trip was not saved" />
      <div className="button-row">
        <button className="button primary" type="submit" disabled={busy}>
          {busy ? "Saving…" : submitLabel}
        </button>
        {onCancel ? (
          <button
            className="button ghost"
            type="button"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

/** The user's trips. Status is always written out, not only coloured. */
export function TripList({
  trips,
  activeId,
  busy,
  editingId,
  onOpen,
  onEdit,
  onTransition,
  renderEditor,
}: {
  trips: Trip[];
  activeId: string | null;
  busy: boolean;
  editingId: string | null;
  onOpen: (tripId: string) => void;
  onEdit: (tripId: string | null) => void;
  onTransition: (
    trip: Trip,
    target: "confirmed" | "active" | "completed",
    action: string,
  ) => void;
  renderEditor: (trip: Trip) => ReactNode;
}) {
  if (trips.length === 0) {
    return (
      <div className="empty-state">
        <h3>No trips yet</h3>
        <p>Create your first trip with the form. It opens here right away.</p>
      </div>
    );
  }
  return (
    <ul className="trp-trips" aria-label="Your trips">
      {trips.map((item) => {
        const next = TRIP_TRANSITIONS[item.status];
        const isActive = item.id === activeId;
        return (
          <li
            key={item.id}
            className={`trp-trip${isActive ? " selected" : ""}`}
            data-trip-id={item.id}
          >
            <div className="trp-trip-head">
              <div>
                <strong>{item.name}</strong>{" "}
                <span className="tag">{statusLabel(item.status)}</span>
                {isActive ? (
                  <span className="tag sage">Open in workspace</span>
                ) : null}
              </div>
            </div>
            <p className="asst-muted">
              {item.destination_summary ?? "No destination"} ·{" "}
              {item.start_at
                ? `${formatInZone(item.start_at, item.timezone)} to ${formatInZone(item.end_at, item.timezone)}`
                : "Dates not set"}{" "}
              · {item.timezone}
            </p>
            <div className="button-row">
              <button
                type="button"
                className="button secondary"
                disabled={isActive || busy}
                aria-label={`Open ${item.name}`}
                onClick={() => onOpen(item.id)}
              >
                {isActive ? "Open" : "Open trip"}
              </button>
              <button
                type="button"
                className="button ghost"
                disabled={busy}
                aria-label={`Edit ${item.name}`}
                aria-expanded={editingId === item.id}
                onClick={() => onEdit(editingId === item.id ? null : item.id)}
              >
                {editingId === item.id ? "Close editor" : "Edit"}
              </button>
              {next ? (
                <button
                  type="button"
                  className="button accent"
                  disabled={busy}
                  aria-label={`${next.action}: ${item.name}`}
                  onClick={() => onTransition(item, next.target, next.action)}
                >
                  {next.action}
                </button>
              ) : null}
            </div>
            {editingId === item.id ? (
              <div className="trp-editor">{renderEditor(item)}</div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
