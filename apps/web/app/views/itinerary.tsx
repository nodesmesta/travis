"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiClientError } from "../../lib/api";
import {
  describeAssistantError,
  listActivityLog,
  listAgendaItems,
  listJourneyLegs,
  listRecommendations,
} from "../../lib/api-assistant";
import type {
  ActivityEntry,
  AgendaItemView,
  JourneyLegView,
  RecommendationView,
} from "../../lib/types-assistant";
import { ConfirmDialog, formatWhen } from "./assistant-parts";
import { useConfirmation } from "./use-confirmation";
import type { ViewProps } from "./types";

interface Section<T> {
  data: T;
  error: string | null;
  /** True when the server has no such endpoint yet. */
  unavailable?: boolean;
}

type TimelineEntry =
  | { kind: "agenda"; at: string; item: AgendaItemView }
  | { kind: "leg"; at: string; leg: JourneyLegView };

const ACTION_TEXT: Record<string, string> = {
  "agenda_item.created": "An agenda item was added",
  "agenda_item.planned": "An agenda item was planned",
  "agenda_item.confirmed": "An agenda item was confirmed",
  "agenda_item.cancelled": "An agenda item was cancelled",
  "agenda_item.completed": "An agenda item was completed",
  "journey_leg.created": "A journey leg was added",
  "assistant.event_result_saved":
    "You added a suggested event to the itinerary",
  "assistant.event_result_expired": "You marked a suggested event as expired",
  "assistant.recommendation_applied":
    "You added a recommendation to the itinerary",
  "assistant.recommendation_saved": "You saved a recommendation",
  "assistant.recommendation_dismissed": "You dismissed a recommendation",
};

function actionText(action: string): string {
  const known = ACTION_TEXT[action];
  if (known) return known;
  return action.split(".").join(" · ").split("_").join(" ");
}

function dayKey(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

function dayHeading(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(iso));
}

function timeOnly(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function statusInfo(status: AgendaItemView["status"]): {
  label: string;
  tone: string;
} {
  switch (status) {
    case "confirmed":
    case "completed":
      return {
        label: status === "completed" ? "Completed" : "Confirmed",
        tone: "sage",
      };
    case "planned":
      return { label: "Planned", tone: "" };
    case "suggested":
      return { label: "Suggested", tone: "coral" };
    case "cancelled":
      return { label: "Cancelled", tone: "muted" };
    default:
      return { label: "Skipped", tone: "muted" };
  }
}

function recommendationTitle(rec: RecommendationView): string {
  const title = rec.payload.title;
  if (typeof title === "string" && title.length > 0) return title;
  return `${rec.recommendation_type} recommendation`;
}

function hasItineraryItem(rec: RecommendationView): boolean {
  const item = rec.payload.itinerary_item;
  return Boolean(item) && typeof item === "object" && !Array.isArray(item);
}

const CLOSED_STATUSES = ["dismissed", "applied", "expired"];

export default function ItineraryView({ trip, contexts }: ViewProps) {
  const [agenda, setAgenda] = useState<Section<AgendaItemView[]>>({
    data: [],
    error: null,
  });
  const [legs, setLegs] = useState<Section<JourneyLegView[]>>({
    data: [],
    error: null,
  });
  const [recs, setRecs] = useState<Section<RecommendationView[]>>({
    data: [],
    error: null,
  });
  const [log, setLog] = useState<Section<ActivityEntry[]>>({
    data: [],
    error: null,
  });
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const [agendaResult, legResult, recResult, logResult] =
      await Promise.allSettled([
        listAgendaItems(trip.id),
        listJourneyLegs(trip.id),
        listRecommendations(trip.id),
        listActivityLog(trip.id, 30),
      ]);
    const message = (reason: unknown) => {
      const described = describeAssistantError(reason);
      return `${described.message}${described.requestId ? ` (request ${described.requestId})` : ""}`;
    };
    setAgenda(
      agendaResult.status === "fulfilled"
        ? { data: agendaResult.value.items, error: null }
        : { data: [], error: message(agendaResult.reason) },
    );
    setLegs(
      legResult.status === "fulfilled"
        ? { data: legResult.value.items, error: null }
        : { data: [], error: message(legResult.reason) },
    );
    if (recResult.status === "fulfilled") {
      setRecs({ data: recResult.value.items, error: null });
    } else if (
      recResult.reason instanceof ApiClientError &&
      recResult.reason.status === 404
    ) {
      setRecs({ data: [], error: null, unavailable: true });
    } else {
      setRecs({ data: [], error: message(recResult.reason) });
    }
    setLog(
      logResult.status === "fulfilled"
        ? { data: logResult.value.items, error: null }
        : { data: [], error: message(logResult.reason) },
    );
    setLoading(false);
  }, [trip.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const confirmation = useConfirmation(trip.id, async (outcome) => {
    setNotice(
      outcome.agenda_item_id
        ? "Added to your itinerary."
        : "Your choice was saved.",
    );
    await reload();
  });

  const labelOf = useCallback(
    (id: string) =>
      contexts.find((point) => point.id === id)?.label ?? "Unknown place",
    [contexts],
  );

  const days = useMemo(() => {
    const entries: TimelineEntry[] = [
      ...agenda.data.map((item): TimelineEntry => ({
        kind: "agenda",
        at: item.start_at,
        item,
      })),
      ...legs.data.map((leg): TimelineEntry => ({
        kind: "leg",
        at: leg.departure_at,
        leg,
      })),
    ].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
    const grouped = new Map<string, TimelineEntry[]>();
    for (const entry of entries) {
      const key = dayKey(entry.at, trip.timezone);
      grouped.set(key, [...(grouped.get(key) ?? []), entry]);
    }
    return [...grouped.entries()];
  }, [agenda.data, legs.data, trip.timezone]);

  const openRecommendations = recs.data.filter(
    (rec) =>
      !CLOSED_STATUSES.includes(rec.status) &&
      (!rec.expires_at || Date.parse(rec.expires_at) > Date.now()),
  );

  return (
    <section className="panel itin-panel" aria-labelledby="itinerary-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">ITINERARY</p>
          <h2 id="itinerary-title">{trip.name}</h2>
        </div>
        <button
          type="button"
          className="button ghost"
          onClick={() => void reload()}
          disabled={loading}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <p className="helper-text">
        Times are shown in {trip.timezone}. Suggested items are not part of your
        plan until you add them.
      </p>

      {notice ? (
        <div className="status-banner success" role="status">
          {notice}
        </div>
      ) : null}
      {confirmation.startError ? (
        <div className="status-banner error" role="alert">
          {confirmation.startError}
        </div>
      ) : null}

      <h3 className="itin-heading">Timeline</h3>
      {loading ? (
        <p className="helper-text" role="status">
          Loading your itinerary…
        </p>
      ) : null}
      {agenda.error ? (
        <div className="status-banner error" role="alert">
          Agenda could not be loaded: {agenda.error}
        </div>
      ) : null}
      {legs.error ? (
        <div className="status-banner error" role="alert">
          Journey legs could not be loaded: {legs.error}
        </div>
      ) : null}
      {!loading && !agenda.error && !legs.error && days.length === 0 ? (
        <div className="empty-state">
          <h3>Nothing planned yet</h3>
          <p>
            Add an event from Explore and book, or ask the assistant for
            suggestions.
          </p>
        </div>
      ) : null}
      <ol className="itin-days">
        {days.map(([key, entries]) => (
          <li key={key} className="itin-day">
            <h4>{dayHeading(entries[0]?.at ?? key, trip.timezone)}</h4>
            <ul className="itin-entries">
              {entries.map((entry) => {
                if (entry.kind === "leg") {
                  const { leg } = entry;
                  return (
                    <li key={`leg-${leg.id}`} className="itin-entry leg">
                      <time dateTime={leg.departure_at}>
                        {timeOnly(leg.departure_at, trip.timezone)}
                      </time>
                      <div>
                        <strong>
                          Travel: {labelOf(leg.origin_context_point_id)} →{" "}
                          {labelOf(leg.destination_context_point_id)}
                        </strong>
                        <p className="asst-muted">
                          {leg.arrival_deadline
                            ? `Arrive by ${timeOnly(leg.arrival_deadline, trip.timezone)} · `
                            : ""}
                          {leg.status.split("_").join(" ")}
                        </p>
                      </div>
                    </li>
                  );
                }
                const { item } = entry;
                const status = statusInfo(item.status);
                return (
                  <li
                    key={`agenda-${item.id}`}
                    className={`itin-entry${item.status === "cancelled" || item.status === "skipped" ? " muted" : ""}`}
                  >
                    <time dateTime={item.start_at}>
                      {timeOnly(item.start_at, trip.timezone)}
                    </time>
                    <div>
                      <strong>{item.title}</strong>{" "}
                      <span className={`tag ${status.tone}`}>
                        {status.label}
                      </span>
                      <p className="asst-muted">
                        {item.type.split("_").join(" ")} · until{" "}
                        {timeOnly(item.end_at, trip.timezone)}
                        {item.source === "assistant_suggestion"
                          ? " · from a recommendation"
                          : item.source === "event_discovery"
                            ? " · from event search"
                            : item.source === "external_provider"
                              ? " · from your booking"
                              : ""}
                        {item.metadata.end_time_estimated === true
                          ? " · end time is an estimate"
                          : ""}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ol>

      <h3 className="itin-heading">Recommendations</h3>
      {recs.unavailable ? (
        <p className="helper-text">
          Stored recommendations are not available in this environment yet.
        </p>
      ) : null}
      {recs.error ? (
        <div className="status-banner error" role="alert">
          Recommendations could not be loaded: {recs.error}
        </div>
      ) : null}
      {!loading &&
      !recs.unavailable &&
      !recs.error &&
      openRecommendations.length === 0 ? (
        <p className="helper-text">No open recommendations right now.</p>
      ) : null}
      <ul className="itin-recs">
        {openRecommendations.map((rec) => {
          const addable = hasItineraryItem(rec);
          return (
            <li key={rec.id} className="itin-rec">
              <div>
                <strong>{recommendationTitle(rec)}</strong>{" "}
                <span className="tag coral">{rec.status}</span>
                {rec.reason ? <p>{rec.reason}</p> : null}
                {rec.expires_at ? (
                  <p className="asst-muted">
                    Valid until {formatWhen(rec.expires_at, trip.timezone)}
                  </p>
                ) : null}
                {!addable ? (
                  <p className="asst-muted">
                    This suggestion has no time slot, so it cannot be added to
                    the itinerary.
                  </p>
                ) : null}
              </div>
              <div className="button-row">
                <button
                  type="button"
                  className="button primary"
                  disabled={!addable || confirmation.busy}
                  onClick={() =>
                    void confirmation.begin("apply_recommendation", rec.id)
                  }
                >
                  Add recommendation
                </button>
                {rec.status !== "saved" ? (
                  <button
                    type="button"
                    className="button secondary"
                    disabled={confirmation.busy}
                    onClick={() =>
                      void confirmation.begin("save_recommendation", rec.id)
                    }
                  >
                    Save for later
                  </button>
                ) : null}
                <button
                  type="button"
                  className="button ghost"
                  disabled={confirmation.busy}
                  onClick={() =>
                    void confirmation.begin("dismiss_recommendation", rec.id)
                  }
                >
                  Dismiss
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <h3 className="itin-heading">Activity log</h3>
      {log.error ? (
        <div className="status-banner error" role="alert">
          Activity log could not be loaded: {log.error}
        </div>
      ) : null}
      {!loading && !log.error && log.data.length === 0 ? (
        <p className="helper-text">No changes recorded yet.</p>
      ) : null}
      <ul className="itin-log">
        {log.data.map((entry) => (
          <li key={entry.id}>
            <time dateTime={entry.created_at}>
              {formatWhen(entry.created_at, trip.timezone)}
            </time>
            <span>{actionText(entry.action)}</span>
          </li>
        ))}
      </ul>

      {confirmation.pending ? (
        <ConfirmDialog
          confirmation={confirmation.pending}
          timezone={trip.timezone}
          busy={confirmation.busy}
          error={confirmation.dialogError}
          onConfirm={() => void confirmation.confirm()}
          onCancel={confirmation.cancel}
        />
      ) : null}
    </section>
  );
}
