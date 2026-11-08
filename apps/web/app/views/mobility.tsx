"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createRouteRequest,
  listJourneyLegs,
  listTraffic,
  listWeather,
  refreshTraffic,
  refreshWeather,
  selectRouteOption,
} from "../../lib/api-mobility";
import type {
  JourneyLeg,
  RouteOptionView,
  RouteRequestResult,
  TrafficSnapshotView,
  WeatherSnapshotView,
} from "../../lib/types-mobility";
import {
  NearbyPlaces,
  RiskTag,
  SourceList,
  TrafficCard,
  WeatherCard,
  describeError,
  formatWhen,
  minutesOf,
} from "./mobility-parts";
import type { ViewProps } from "./types";

const MODE_LABEL: Record<string, string> = {
  car: "Drive",
  taxi: "Taxi",
  pedestrian: "Walk",
  transit: "Public transit",
};

const REASON_LABEL: Record<string, string> = {
  arrival_deadline: "Judged against the arrival deadline",
  traffic_delay: "Traffic adds delay",
  traffic_incident: "Traffic incident nearby",
  weather_risk: "Weather risk on the way",
  walking_limit: "Walking is over your limit",
  transfer_limit: "More transfers than your limit",
  cost_limit: "Over the cost limit",
  shorter_duration: "Shortest travel time",
  more_buffer: "Most time to spare",
  public_transit_preference: "You prefer public transit",
  comfort_preference: "Comfort preference",
  route_unavailable: "Route unavailable",
  weather_unavailable: "Weather not available",
  traffic_unavailable: "Traffic not available",
};

function costText(option: RouteOptionView): string {
  const { cost } = option;
  if (cost.min_amount === null || cost.max_amount === null)
    return "Cost unavailable";
  const range =
    cost.min_amount === cost.max_amount
      ? `${cost.min_amount}`
      : `${cost.min_amount} to ${cost.max_amount}`;
  return `${cost.currency} ${range}${cost.is_estimate ? " (estimate from provider)" : ""}`;
}

function OptionCard({
  option,
  result,
  timezone,
  busy,
  onSelect,
}: {
  option: RouteOptionView;
  result: RouteRequestResult;
  timezone: string;
  busy: boolean;
  onSelect: () => void;
}) {
  const metrics = option.derived_metrics;
  const label = option.recommended
    ? "Recommended"
    : option.status === "excluded"
      ? "Not recommended"
      : option.status === "expired"
        ? "Expired"
        : "Alternative";
  const slack = metrics.deadline_slack_seconds;
  return (
    <article
      className={`event-card mobility-option ${option.recommended ? "selected" : ""}`}
    >
      <div className="event-card-topline">
        <span className={`tag ${option.recommended ? "sage" : "coral"}`}>
          {label}
        </span>
        <span className="fresh-label">
          {option.freshness} · {formatWhen(option.retrieved_at, timezone)}
        </span>
      </div>
      <h3>{MODE_LABEL[option.transport_mode] ?? option.transport_mode}</h3>
      <dl className="mobility-facts">
        <div>
          <dt>Travel time (provider)</dt>
          <dd>{minutesOf(option.provider_facts.duration_seconds)}</dd>
        </div>
        <div>
          <dt>Departs / arrives</dt>
          <dd>
            {formatWhen(metrics.departure_at, timezone)} →{" "}
            {formatWhen(metrics.arrival_at, timezone)}
          </dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd>{costText(option)}</dd>
        </div>
        <div>
          <dt>Walking</dt>
          <dd>{metrics.walking_minutes} min</dd>
        </div>
        <div>
          <dt>Transfers</dt>
          <dd>{metrics.transfer_count}</dd>
        </div>
        <div>
          <dt>Safety buffer</dt>
          <dd>{minutesOf(metrics.safety_buffer_seconds)}</dd>
        </div>
        <div>
          <dt>Deadline</dt>
          <dd>
            {metrics.feasible === null
              ? "No deadline on this leg"
              : metrics.feasible
                ? `Meets it, ${slack !== null ? minutesOf(slack) : "0 min"} to spare`
                : `Misses it by ${slack !== null ? minutesOf(Math.abs(slack)) : "?"}`}
          </dd>
        </div>
      </dl>
      <p>
        <RiskTag label="Traffic" level={option.risk.traffic} />{" "}
        <RiskTag label="Weather" level={option.risk.weather} />
      </p>
      {option.recommended && result.departure_recommendation ? (
        <p className="event-meta">
          Suggested departure:{" "}
          <strong>
            {formatWhen(result.departure_recommendation.depart_at, timezone)}
          </strong>
          {result.departure_recommendation.latest_departure_at
            ? ` (latest ${formatWhen(result.departure_recommendation.latest_departure_at, timezone)} if travel time stays the same)`
            : ""}
        </p>
      ) : null}
      <ul className="mobility-list">
        {[
          ...metrics.reason_codes,
          ...option.exclusion_reasons.filter(
            (code) => !metrics.reason_codes.includes(code),
          ),
        ].map((code) => (
          <li key={code}>{REASON_LABEL[code] ?? code}</li>
        ))}
      </ul>
      {option.provider_facts.sections.some((section) => section.operator) ? (
        <p className="event-meta">
          Operator:{" "}
          {[
            ...new Set(
              option.provider_facts.sections.flatMap((section) =>
                section.operator ? [section.operator] : [],
              ),
            ),
          ].join(", ")}
        </p>
      ) : null}
      <SourceList sourceIds={option.source_ids} sources={result.sources} />
      <button
        className="button secondary wide"
        disabled={busy || option.status !== "valid"}
        onClick={onSelect}
        type="button"
      >
        {option.selected
          ? "Selected"
          : option.status === "valid"
            ? "Select this route"
            : "Cannot be selected"}
      </button>
    </article>
  );
}

export default function MobilityView({
  trip,
  contexts,
  context,
  onSelectContext,
  onOpenInvoices,
}: ViewProps) {
  const [legs, setLegs] = useState<JourneyLeg[]>([]);
  const [legId, setLegId] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [needTraffic, setNeedTraffic] = useState(false);
  const [needWeather, setNeedWeather] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RouteRequestResult | null>(null);
  const [weather, setWeather] = useState<WeatherSnapshotView[]>([]);
  const [missingWeather, setMissingWeather] = useState<string[]>([]);
  const [traffic, setTraffic] = useState<TrafficSnapshotView[]>([]);
  const [sideBusy, setSideBusy] = useState(false);
  const [sideError, setSideError] = useState<string | null>(null);

  const labelOf = useCallback(
    (id: string) =>
      contexts.find((point) => point.id === id)?.label ?? "Unknown place",
    [contexts],
  );
  const leg = useMemo(
    () => legs.find((item) => item.id === legId) ?? null,
    [legs, legId],
  );
  const timezone = trip.timezone;

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [legResult, weatherResult, trafficResult] = await Promise.all([
        listJourneyLegs(trip.id),
        listWeather(trip.id),
        listTraffic(trip.id),
      ]);
      const usable = legResult.items.filter(
        (item) => item.status === "planned" || item.status === "in_progress",
      );
      setLegs(usable);
      setLegId((current) =>
        usable.some((item) => item.id === current)
          ? current
          : (usable[0]?.id ?? ""),
      );
      setWeather(weatherResult.items);
      setMissingWeather(weatherResult.missing_context_point_ids);
      setTraffic(trafficResult.items);
    } catch (caught) {
      setLoadError(describeError(caught));
    } finally {
      setLoading(false);
    }
  }, [trip.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function compare() {
    if (!leg) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const facts: Array<"route" | "traffic" | "weather"> = ["route"];
      if (needTraffic) facts.push("traffic");
      if (needWeather) facts.push("weather");
      setResult(
        await createRouteRequest(trip.id, leg.id, { required_facts: facts }),
      );
      void load();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function choose(option: RouteOptionView) {
    if (!result) return;
    setBusy(true);
    setError(null);
    try {
      setResult(
        await selectRouteOption(trip.id, result.route_request.id, option.id),
      );
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function refreshSide(kind: "weather" | "traffic") {
    setSideBusy(true);
    setSideError(null);
    try {
      if (kind === "weather") {
        await refreshWeather(trip.id, leg?.destination_context_point_id);
      } else if (leg) {
        await refreshTraffic(trip.id, leg.id);
      }
      await load();
    } catch (caught) {
      setSideError(describeError(caught));
    } finally {
      setSideBusy(false);
    }
  }

  const destinationId = leg?.destination_context_point_id ?? null;
  const destinationWeather =
    weather.find((item) => item.context_point_id === destinationId) ?? null;
  const legTraffic = leg
    ? (traffic.find(
        (item) =>
          item.origin_context_point_id === leg.origin_context_point_id &&
          item.destination_context_point_id ===
            leg.destination_context_point_id,
      ) ?? null)
    : null;

  return (
    <div className="mobility-view">
      <section className="panel" aria-labelledby="mobility-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">GETTING THERE</p>
            <h2 id="mobility-title">Compare ways to travel</h2>
          </div>
          <span className="tag sage">Backend-ranked</span>
        </div>
        {loading ? (
          <p className="helper-text">
            <span className="spinner" /> Loading your journey legs…
          </p>
        ) : null}
        {loadError ? (
          <div className="status-banner error" role="alert">
            {loadError}
          </div>
        ) : null}
        {!loading && !loadError && legs.length === 0 ? (
          <div className="empty-state">
            <h3>No journey leg yet</h3>
            <p>
              Add a journey leg between two places of this trip to compare
              routes.
            </p>
          </div>
        ) : null}
        {legs.length > 0 ? (
          <div className="mobility-controls">
            <label>
              Journey leg
              <select
                value={legId}
                onChange={(event) => {
                  setLegId(event.target.value);
                  setResult(null);
                  setError(null);
                }}
              >
                {legs.map((item) => (
                  <option key={item.id} value={item.id}>
                    {labelOf(item.origin_context_point_id)} →{" "}
                    {labelOf(item.destination_context_point_id)} ·{" "}
                    {formatWhen(item.departure_at, timezone)}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="mobility-facts-choice">
              <legend>Also require</legend>
              <label>
                <input
                  type="checkbox"
                  checked={needTraffic}
                  onChange={(event) => setNeedTraffic(event.target.checked)}
                />
                Live traffic
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={needWeather}
                  onChange={(event) => setNeedWeather(event.target.checked)}
                />
                Weather
              </label>
            </fieldset>
            <button
              className="button accent"
              disabled={busy || !leg}
              onClick={() => void compare()}
              type="button"
            >
              {busy ? "Asking providers…" : "Compare routes"}
            </button>
          </div>
        ) : null}
        {leg ? (
          <p className="helper-text">
            Leaves {formatWhen(leg.departure_at, timezone)}
            {leg.arrival_deadline
              ? `, must arrive by ${formatWhen(leg.arrival_deadline, timezone)}`
              : ", no arrival deadline"}
            . If a required fact cannot be fetched, you get an error, not an
            estimate.
          </p>
        ) : null}
        <div aria-live="polite">
          {error ? (
            <div className="status-banner error" role="alert">
              {error}
            </div>
          ) : null}
        </div>
      </section>

      {result ? (
        <section className="results-section" aria-labelledby="options-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">YOUR OPTIONS</p>
              <h2 id="options-title">
                {result.recommended_option_id
                  ? "Recommended route first"
                  : "No route is recommended"}
              </h2>
            </div>
            <span className="fresh-label">
              {result.route_request.freshness} · retrieved{" "}
              {formatWhen(result.route_request.retrieved_at, timezone)} · policy{" "}
              {result.route_request.policy_version}
            </span>
          </div>
          {result.route_request.freshness === "expired" ? (
            <div className="status-banner warning" role="status">
              These results have expired and are shown for reference only.
              Compare routes again for current data.
            </div>
          ) : null}
          {!result.recommended_option_id ? (
            <div className="status-banner warning" role="status">
              No option arrives before the deadline with the safety buffer, or
              none fits your limits. Nothing was invented to fill the gap.
            </div>
          ) : null}
          <div className="event-grid">
            {result.options.map((option) => (
              <OptionCard
                key={option.id}
                option={option}
                result={result}
                timezone={timezone}
                busy={busy}
                onSelect={() => void choose(option)}
              />
            ))}
          </div>
          {result.limitations.length > 0 ? (
            <details className="limitations">
              <summary>Limitations</summary>
              {result.limitations.map((text) => (
                <p key={text}>{text}</p>
              ))}
            </details>
          ) : null}
        </section>
      ) : null}

      <section className="panel" aria-labelledby="conditions-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">CONDITIONS</p>
            <h2 id="conditions-title">Weather and traffic</h2>
          </div>
          <div className="button-row">
            <button
              className="button secondary"
              disabled={sideBusy || !leg}
              onClick={() => void refreshSide("weather")}
              type="button"
            >
              Refresh weather
            </button>
            <button
              className="button secondary"
              disabled={sideBusy || !leg}
              onClick={() => void refreshSide("traffic")}
              type="button"
            >
              Refresh traffic
            </button>
          </div>
        </div>
        <div aria-live="polite">
          {sideBusy ? (
            <p className="helper-text">
              <span className="spinner" /> Contacting the provider…
            </p>
          ) : null}
          {sideError ? (
            <div className="status-banner error" role="alert">
              {sideError}
            </div>
          ) : null}
        </div>
        <div className="event-grid">
          {destinationWeather ? (
            <WeatherCard
              snapshot={destinationWeather}
              label={labelOf(destinationWeather.context_point_id)}
              timezone={timezone}
            />
          ) : (
            <div className="empty-state">
              <h3>Weather unavailable</h3>
              <p>
                {destinationId && missingWeather.includes(destinationId)
                  ? "There is no current weather snapshot for the destination. Refresh to fetch it."
                  : "Choose a journey leg to see the weather at its destination."}
              </p>
            </div>
          )}
          {legTraffic ? (
            <TrafficCard
              snapshot={legTraffic}
              label={`${labelOf(legTraffic.origin_context_point_id)} → ${labelOf(legTraffic.destination_context_point_id)}`}
              timezone={timezone}
            />
          ) : (
            <div className="empty-state">
              <h3>Traffic unavailable</h3>
              <p>
                There is no current traffic snapshot for this leg. Live traffic
                only describes the next few hours; refresh when the leg is
                close.
              </p>
            </div>
          )}
        </div>
        {contexts.length > 0 ? (
          <label className="mobility-context">
            Place for activities and restaurants
            <select
              value={context?.id ?? ""}
              onChange={(event) => {
                const point = contexts.find(
                  (item) => item.id === event.target.value,
                );
                if (point) onSelectContext(point);
              }}
            >
              {context ? null : <option value="">Choose a place</option>}
              {contexts
                .filter(
                  (point) =>
                    point.resolution_status === "resolved" &&
                    point.status === "active",
                )
                .map((point) => (
                  <option key={point.id} value={point.id}>
                    {point.label}
                  </option>
                ))}
            </select>
          </label>
        ) : null}
      </section>

      <NearbyPlaces
        tripId={trip.id}
        context={context}
        {...(onOpenInvoices ? { onOpenInvoices } : {})}
      />
    </div>
  );
}
