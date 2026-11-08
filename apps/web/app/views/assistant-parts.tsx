"use client";

import { useEffect, useRef, type KeyboardEvent } from "react";
import type {
  AssistantCard,
  AssistantSource,
  ConfirmationAction,
  ConfirmationRequest,
} from "../../lib/types-assistant";

export function formatWhen(iso: string | undefined, timezone: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(date);
}

const CARD_LABEL: Record<AssistantCard["type"], string> = {
  event: "Event",
  activity: "Activity",
  restaurant: "Restaurant",
  route: "Route",
  weather: "Weather",
  traffic: "Traffic",
  alert: "Alert",
  agenda: "Agenda",
  recommendation: "Recommendation",
};

export function AssistantCardView({
  card,
  timezone,
  sources,
  onAction,
  disabled,
}: {
  card: AssistantCard;
  timezone: string;
  sources: AssistantSource[];
  onAction: (card: AssistantCard, action: ConfirmationAction) => void;
  disabled: boolean;
}) {
  const cited = sources.filter((source) => card.source_ids.includes(source.id));
  const titleId = `asst-card-${card.type}-${card.id}`;
  return (
    <article
      className={`asst-card${card.recommended ? " recommended" : ""}`}
      aria-labelledby={titleId}
      data-card-type={card.type}
    >
      <div className="asst-card-top">
        <span className="tag sage">{CARD_LABEL[card.type]}</span>
        {card.recommended ? (
          <span className="tag gold">Recommended by TravelFlow</span>
        ) : null}
        {card.rank !== undefined ? (
          <span className="tag">Rank {card.rank}</span>
        ) : null}
        {card.status ? <span className="tag">{card.status}</span> : null}
      </div>
      <h4 id={titleId}>{card.title}</h4>
      {card.subtitle ? <p className="asst-muted">{card.subtitle}</p> : null}
      {card.starts_at ? (
        <p className="asst-muted">
          {formatWhen(card.starts_at, timezone)}
          {card.ends_at ? ` – ${formatWhen(card.ends_at, timezone)}` : ""}
        </p>
      ) : null}
      {card.fields.length > 0 ? (
        <dl className="asst-fields">
          {card.fields.map((field) => (
            <div key={`${field.label}-${field.value}`}>
              <dt>{field.label}</dt>
              <dd>{field.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {cited.length === 0 && card.retrieved_at ? (
        <p className="asst-muted asst-source-line">
          Retrieved {formatWhen(card.retrieved_at, timezone)}
        </p>
      ) : null}
      {cited.length > 0 ? (
        <p className="asst-muted asst-source-line">
          Source:{" "}
          {cited.map((source, index) => (
            <span key={source.id}>
              {index > 0 ? ", " : ""}
              {source.url ? (
                <a href={source.url} target="_blank" rel="noreferrer noopener">
                  {source.title ?? source.provider}
                </a>
              ) : (
                (source.title ?? source.provider)
              )}
            </span>
          ))}
          {card.retrieved_at
            ? ` · retrieved ${formatWhen(card.retrieved_at, timezone)}`
            : ""}
        </p>
      ) : null}
      {card.actions && card.actions.length > 0 ? (
        <div className="button-row">
          {card.actions.map((action) => (
            <button
              key={action.action}
              type="button"
              className={
                action.action === "dismiss_recommendation" ||
                action.action === "expire_event_result"
                  ? "button ghost"
                  : "button secondary"
              }
              disabled={disabled}
              onClick={() => onAction(card, action.action)}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </article>
  );
}

export function SourceList({
  sources,
  timezone,
}: {
  sources: AssistantSource[];
  timezone: string;
}) {
  if (sources.length === 0) return null;
  return (
    <details className="source-details">
      <summary>Sources ({sources.length})</summary>
      <ul className="asst-source-list">
        {sources.map((source) => (
          <li key={source.id} className="source-row">
            <span>
              {source.url ? (
                <a href={source.url} target="_blank" rel="noreferrer noopener">
                  {source.title ?? source.url}
                </a>
              ) : (
                (source.title ?? source.provider)
              )}
            </span>
            <small>
              {source.provider} · {source.freshness} · retrieved{" "}
              {formatWhen(source.retrieved_at, timezone)}
            </small>
          </li>
        ))}
      </ul>
    </details>
  );
}

const ACTION_LABEL: Record<ConfirmationAction, string> = {
  save_event_result: "Add to itinerary",
  expire_event_result: "Mark as expired",
  save_recommendation: "Save recommendation",
  apply_recommendation: "Add to itinerary",
  dismiss_recommendation: "Dismiss",
};

export function actionLabel(action: ConfirmationAction): string {
  return ACTION_LABEL[action];
}

/**
 * Confirmation before any change. The token comes from the backend; the dialog
 * never sends it unless the user presses the confirm button.
 */
export function ConfirmDialog({
  confirmation,
  timezone,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  confirmation: ConfirmationRequest;
  timezone: string;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const previous = useRef<Element | null>(null);

  useEffect(() => {
    previous.current = document.activeElement;
    confirmRef.current?.focus();
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
        aria-labelledby="asst-confirm-title"
        aria-describedby="asst-confirm-body"
      >
        <p className="eyebrow">PLEASE CONFIRM</p>
        <h3 id="asst-confirm-title">{actionLabel(confirmation.action)}</h3>
        <p id="asst-confirm-body">{confirmation.summary}</p>
        <p className="asst-muted">
          Nothing changes until you confirm. This confirmation expires{" "}
          {formatWhen(confirmation.expires_at, timezone)}.
        </p>
        {error ? (
          <div className="status-banner error" role="alert">
            {error}
          </div>
        ) : null}
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
            disabled={busy || !confirmation.confirmation_token}
            onClick={onConfirm}
          >
            {busy ? "Working…" : "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
