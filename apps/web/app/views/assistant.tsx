"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  createConversation,
  describeAssistantError,
  getConversation,
  listConversations,
  newIdempotencyKey,
  sendMessage,
} from "../../lib/api-assistant";
import type {
  AssistantCard,
  AssistantResponse,
  ConfirmationAction,
  ConversationMessage,
} from "../../lib/types-assistant";
import {
  AssistantCardView,
  ConfirmDialog,
  SourceList,
  formatWhen,
} from "./assistant-parts";
import { useConfirmation } from "./use-confirmation";
import type { ViewProps } from "./types";

interface SendFailure {
  message: string;
  code: string;
  requestId?: string;
  retryable: boolean;
  text: string;
  contextPointId: string | null;
}

function isoDateInZone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  return parts;
}

function longDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  if (!year || !month || !day) return isoDate;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function freshnessLabel(
  response: AssistantResponse,
  timezone: string,
): string | null {
  if (response.freshness_status === "unavailable") {
    return "Live data was unavailable for this answer.";
  }
  if (!response.retrieved_at) return null;
  return `Data ${response.freshness_status} · retrieved ${formatWhen(response.retrieved_at, timezone)}`;
}

export default function AssistantPanel({
  trip,
  contexts,
  context,
  onSelectContext,
  onClose,
}: ViewProps & { onClose: () => void }) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [failure, setFailure] = useState<SendFailure | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(
    context?.id ?? null,
  );
  const [date, setDate] = useState(
    isoDateInZone(
      trip.start_at ? new Date(trip.start_at) : new Date(),
      trip.timezone,
    ),
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [routeFrom, setRouteFrom] = useState("");
  const [routeTo, setRouteTo] = useState("");
  const [statusOverride, setStatusOverride] = useState<Record<string, string>>(
    {},
  );
  const logRef = useRef<HTMLDivElement | null>(null);

  const selectable = contexts.filter((point) => point.status === "active");
  const selectedPoint =
    selectable.find((point) => point.id === selectedId) ?? null;

  const confirmation = useConfirmation(trip.id, (outcome, done) => {
    setStatusOverride((current) => ({
      ...current,
      [done.entity_id]:
        done.action === "dismiss_recommendation"
          ? "dismissed"
          : done.action === "expire_event_result"
            ? "expired"
            : done.action === "save_recommendation"
              ? "saved"
              : done.action === "apply_recommendation"
                ? "applied"
                : "selected",
    }));
    setNotice(
      outcome.agenda_item_id
        ? "Done. The item was added to your itinerary."
        : "Done. Your choice was saved.",
    );
  });

  const loadConversation = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const list = await listConversations(trip.id);
      const latest = list.items.find((item) => item.status === "active");
      if (latest) {
        const detail = await getConversation(trip.id, latest.id);
        setConversationId(latest.id);
        setMessages(detail.messages);
      } else {
        setConversationId(null);
        setMessages([]);
      }
    } catch (error) {
      const described = describeAssistantError(error);
      setLoadError(
        `${described.message}${described.requestId ? ` (request ${described.requestId})` : ""}`,
      );
    } finally {
      setLoading(false);
    }
  }, [trip.id]);

  useEffect(() => {
    void loadConversation();
  }, [loadConversation]);

  useEffect(() => {
    const element = logRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages, pendingText, sending]);

  function chooseContext(id: string | null) {
    setSelectedId(id);
    const point = selectable.find((candidate) => candidate.id === id);
    if (point) onSelectContext(point);
  }

  async function submit(message: string, contextPointId: string | null) {
    const trimmed = message.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setFailure(null);
    setNotice(null);
    setPendingText(trimmed);
    setText("");
    try {
      let activeId = conversationId;
      if (!activeId) {
        const created = await createConversation(
          trip.id,
          contextPointId ? { active_context_point_id: contextPointId } : {},
          newIdempotencyKey("conversation"),
        );
        activeId = created.id;
        setConversationId(created.id);
      }
      const result = await sendMessage(
        trip.id,
        activeId,
        {
          message: trimmed,
          ...(contextPointId ? { context_point_id: contextPointId } : {}),
        },
        newIdempotencyKey("message"),
      );
      setMessages((current) => [
        ...current,
        result.user_message,
        result.assistant_message,
      ]);
    } catch (error) {
      const described = describeAssistantError(error);
      setFailure({ ...described, text: trimmed, contextPointId });
      // A failed turn is stored by the backend, so reload to show it in order.
      if (conversationId) {
        try {
          const detail = await getConversation(trip.id, conversationId);
          setMessages(detail.messages);
        } catch (reloadError) {
          const reload = describeAssistantError(reloadError);
          setLoadError(
            `The conversation could not be reloaded: ${reload.message}`,
          );
        }
      }
    } finally {
      setPendingText(null);
      setSending(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit(text, selectedId);
  }

  function onCardAction(card: AssistantCard, action: ConfirmationAction) {
    void confirmation.begin(action, card.id);
  }

  async function newConversation() {
    setConversationId(null);
    setMessages([]);
    setFailure(null);
    setNotice(null);
  }

  const routable = selectable.filter(
    (point) => point.resolution_status === "resolved",
  );
  const routeFromPoint = routable.find((point) => point.id === routeFrom);
  const routeToPoint = routable.find((point) => point.id === routeTo);
  const routeReady =
    routeFromPoint !== undefined &&
    routeToPoint !== undefined &&
    routeFromPoint.id !== routeToPoint.id;

  const lastAssistant = [...messages]
    .reverse()
    .find((message) => message.role === "assistant");

  return (
    <section
      className="panel asst-panel rail"
      aria-labelledby="assistant-title"
    >
      <div className="section-heading">
        <div>
          <p className="eyebrow">ASSISTANT</p>
          <h2 id="assistant-title">Ask about {trip.name}</h2>
        </div>
        <div className="button-row">
          <button
            type="button"
            className="button ghost"
            onClick={() => void newConversation()}
            disabled={sending}
          >
            New
          </button>
          <button
            type="button"
            className="button ghost"
            onClick={onClose}
            aria-label="Hide assistant"
          >
            Close
          </button>
        </div>
      </div>
      <p className="helper-text">
        Answers use your trip and live sources. The assistant never changes your
        itinerary without your confirmation.
      </p>

      <fieldset className="asst-context">
        <legend>Place to ask about</legend>
        <div className="asst-context-options">
          <label
            className={`asst-chip${selectedId === null ? " selected" : ""}`}
          >
            <input
              type="radio"
              name="asst-context"
              checked={selectedId === null}
              onChange={() => chooseContext(null)}
            />
            Whole trip
          </label>
          {selectable.map((point) => {
            const usable = point.resolution_status === "resolved";
            return (
              <label
                key={point.id}
                className={`asst-chip${selectedId === point.id ? " selected" : ""}${usable ? "" : " disabled"}`}
              >
                <input
                  type="radio"
                  name="asst-context"
                  checked={selectedId === point.id}
                  disabled={!usable}
                  onChange={() => chooseContext(point.id)}
                />
                {point.label}
                <small>
                  {point.type}
                  {usable ? "" : " · location not confirmed"}
                </small>
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="asst-quick" role="group" aria-label="Quick actions">
        <label className="asst-date">
          Date
          <input
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="button secondary"
          disabled={sending || !selectedPoint}
          title={selectedPoint ? undefined : "Choose a place first"}
          onClick={() =>
            void submit(
              `What events are happening near ${selectedPoint?.label ?? "this place"} on ${longDate(date)}?`,
              selectedId,
            )
          }
        >
          Events near this place
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={sending || !selectedPoint}
          title={selectedPoint ? undefined : "Choose a place first"}
          onClick={() =>
            void submit(
              `What is the weather around ${selectedPoint?.label ?? "this place"}?`,
              selectedId,
            )
          }
        >
          Weather here
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={sending || !selectedPoint}
          title={selectedPoint ? undefined : "Choose a place first"}
          onClick={() =>
            void submit(
              `Which restaurants are near ${selectedPoint?.label ?? "this place"}?`,
              selectedId,
            )
          }
        >
          Restaurants nearby
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={sending || !selectedPoint}
          title={selectedPoint ? undefined : "Choose a place first"}
          onClick={() =>
            void submit(
              `What can I do near ${selectedPoint?.label ?? "this place"}?`,
              selectedId,
            )
          }
        >
          Things to do nearby
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={sending}
          onClick={() => void submit("Summarize my trip.", selectedId)}
        >
          Summarize my trip
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={sending}
          onClick={() =>
            void submit("What should I know about today?", selectedId)
          }
        >
          Today&apos;s advice
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={sending}
          onClick={() =>
            void submit("Show my current recommendations.", selectedId)
          }
        >
          My recommendations
        </button>
      </div>

      <div className="asst-quick" role="group" aria-label="Route and traffic">
        <label className="asst-date">
          From
          <select
            value={routeFrom}
            onChange={(event) => setRouteFrom(event.target.value)}
          >
            <option value="">Choose a place</option>
            {routable.map((point) => (
              <option key={point.id} value={point.id}>
                {point.label}
              </option>
            ))}
          </select>
        </label>
        <label className="asst-date">
          To
          <select
            value={routeTo}
            onChange={(event) => setRouteTo(event.target.value)}
          >
            <option value="">Choose a place</option>
            {routable.map((point) => (
              <option key={point.id} value={point.id}>
                {point.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="button secondary"
          disabled={sending || !routeReady}
          title={routeReady ? undefined : "Choose two different places"}
          onClick={() =>
            void submit(
              `How do I get from ${routeFromPoint?.label} to ${routeToPoint?.label}?`,
              null,
            )
          }
        >
          Compare routes
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={sending || !routeReady}
          title={routeReady ? undefined : "Choose two different places"}
          onClick={() =>
            void submit(
              `How is the traffic from ${routeFromPoint?.label} to ${routeToPoint?.label}?`,
              null,
            )
          }
        >
          Traffic on this route
        </button>
      </div>

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

      <div
        className="asst-log"
        ref={logRef}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Conversation"
        tabIndex={0}
      >
        {loading ? (
          <p className="helper-text" role="status">
            Loading your conversation…
          </p>
        ) : null}
        {loadError ? (
          <div className="status-banner error" role="alert">
            {loadError}{" "}
            <button
              type="button"
              className="button ghost"
              onClick={() => void loadConversation()}
            >
              Try again
            </button>
          </div>
        ) : null}
        {!loading && !loadError && messages.length === 0 && !pendingText ? (
          <div className="empty-state">
            <h3>Start with a question</h3>
            <p>
              For example: “What events are near the Jakarta Convention Center
              on 12 November 2026?”, “How do I get from my hotel to the Jakarta
              Convention Center?”, or “What is the weather around the venue?”
            </p>
          </div>
        ) : null}
        {messages.map((message) => {
          if (message.role === "user") {
            return (
              <div key={message.id} className="asst-msg user">
                <span className="asst-who">You</span>
                <p>{message.content}</p>
              </div>
            );
          }
          if (message.status === "failed") {
            return (
              <div key={message.id} className="asst-msg failed" role="group">
                <span className="asst-who">Assistant</span>
                <p>{message.content}</p>
                <small>
                  Provider error
                  {message.error_code ? ` · ${message.error_code}` : ""}
                  {message.request_id ? ` · request ${message.request_id}` : ""}
                </small>
              </div>
            );
          }
          const response = message.response;
          const freshness = response
            ? freshnessLabel(response, trip.timezone)
            : null;
          return (
            <div
              key={message.id}
              className={`asst-msg assistant${message.status === "clarification" ? " clarification" : ""}`}
            >
              <span className="asst-who">Assistant</span>
              <p>{message.content}</p>
              {response ? (
                <>
                  {freshness ? <p className="asst-muted">{freshness}</p> : null}
                  {response.clarification ? (
                    <div
                      className="asst-clarify"
                      role="group"
                      aria-label="Choose one"
                    >
                      {response.clarification.options.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          className="button secondary"
                          disabled={sending}
                          onClick={() => {
                            const isPlace = selectable.some(
                              (point) => point.id === option.id,
                            );
                            const original =
                              [...messages]
                                .reverse()
                                .find(
                                  (candidate) =>
                                    candidate.role === "user" &&
                                    candidate.created_at <= message.created_at,
                                )?.content ?? "";
                            if (isPlace) chooseContext(option.id);
                            void submit(
                              original
                                ? `${original} (${option.label})`
                                : option.label,
                              isPlace ? option.id : selectedId,
                            );
                          }}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {response.cards.length > 0 ? (
                    <div className="asst-cards">
                      {response.cards.map((card) => {
                        const override = statusOverride[card.id];
                        const shown: AssistantCard = override
                          ? { ...card, status: override, actions: [] }
                          : card;
                        return (
                          <AssistantCardView
                            key={`${message.id}-${card.id}`}
                            card={shown}
                            timezone={trip.timezone}
                            sources={response.sources}
                            onAction={onCardAction}
                            disabled={sending || confirmation.busy}
                          />
                        );
                      })}
                    </div>
                  ) : null}
                  {response.facts.length > 0 ? (
                    <dl className="asst-fields asst-facts">
                      {response.facts.map((fact) => (
                        <div key={`${fact.label}-${fact.value}`}>
                          <dt>{fact.label}</dt>
                          <dd>{fact.value}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                  {response.recommendations.length > 0 ? (
                    <ul className="asst-recs">
                      {response.recommendations.map((rec) => (
                        <li key={rec.title}>
                          <strong>{rec.title}</strong>{" "}
                          <span className="tag">
                            {rec.confidence} confidence
                          </span>
                          <br />
                          {rec.reason}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {response.travel_tips && response.travel_tips.length > 0 ? (
                    <div className="asst-tips">
                      <p className="asst-who">Travel tips</p>
                      <ul>
                        {response.travel_tips.map((tip) => (
                          <li key={tip.title}>
                            <strong>{tip.title}</strong>
                            <br />
                            {tip.detail}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {response.confirmation_request ? (
                    <div className="asst-confirm-box">
                      <p>{response.confirmation_request.summary}</p>
                      <button
                        type="button"
                        className="button primary"
                        disabled={sending || confirmation.busy}
                        onClick={() =>
                          void confirmation.open(
                            response.confirmation_request as NonNullable<
                              typeof response.confirmation_request
                            >,
                          )
                        }
                      >
                        Review and confirm
                      </button>
                    </div>
                  ) : null}
                  {response.limitations.length > 0 ? (
                    <details className="limitations">
                      <summary>About this answer</summary>
                      {response.limitations.map((limitation) => (
                        <p key={limitation}>{limitation}</p>
                      ))}
                    </details>
                  ) : null}
                  <SourceList
                    sources={response.sources}
                    timezone={trip.timezone}
                  />
                  {message.id === lastAssistant?.id &&
                  response.follow_up_actions.length > 0 ? (
                    <div
                      className="asst-followups"
                      role="group"
                      aria-label="Suggested next questions"
                    >
                      {response.follow_up_actions.map((action) => (
                        <button
                          key={action.label}
                          type="button"
                          className="button ghost"
                          disabled={sending}
                          onClick={() => void submit(action.prompt, selectedId)}
                        >
                          {action.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          );
        })}
        {pendingText ? (
          <div className="asst-msg user pending">
            <span className="asst-who">You</span>
            <p>{pendingText}</p>
          </div>
        ) : null}
        {sending ? (
          <p className="helper-text asst-working" role="status">
            <span className="spinner" aria-hidden="true" /> The assistant is
            working. Searching live sources can take up to a minute.
          </p>
        ) : null}
      </div>

      {failure ? (
        <div className="status-banner error asst-failure" role="alert">
          <strong>This question could not be answered.</strong>
          <p>
            {failure.message}
            {failure.requestId ? ` (request ${failure.requestId})` : ""}
          </p>
          <small>Error code: {failure.code}. No answer was made up.</small>
          {failure.code === "EXTERNAL_CONFIGURATION_MISSING" ? (
            <p className="asst-muted">
              A data source this question needs is not configured on the server.
              Your question is fine; asking again will not help until it is set
              up.
            </p>
          ) : null}
          <div className="button-row">
            {failure.retryable ? (
              <button
                type="button"
                className="button secondary"
                disabled={sending}
                onClick={() =>
                  void submit(failure.text, failure.contextPointId)
                }
              >
                Ask again
              </button>
            ) : null}
            <button
              type="button"
              className="button ghost"
              onClick={() => setFailure(null)}
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      <form className="asst-form" onSubmit={onSubmit}>
        <label htmlFor="asst-input">
          Your question
          {selectedPoint
            ? ` (about ${selectedPoint.label})`
            : " (about the whole trip)"}
        </label>
        <textarea
          id="asst-input"
          value={text}
          rows={2}
          maxLength={2000}
          placeholder="Ask about routes, weather, traffic, nearby places, events, your agenda, recommendations, or today's travel tips"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit(text, selectedId);
            }
          }}
        />
        <button
          type="submit"
          className="button primary"
          disabled={sending || text.trim().length === 0}
        >
          {sending ? "Working…" : "Send"}
        </button>
      </form>

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
