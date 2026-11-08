import {
  dateInZone,
  formatInZone,
  truncateText,
  type AssistantCard,
  type AssistantFact,
  type ToolDefinition,
  type ToolResult,
} from "@travelflow/domain";
import type {
  RouteComparisonView,
  SourceView,
  ToolRuntime,
  WeatherView,
} from "../types.js";
import {
  contextPointOf,
  distanceLabel,
  freshnessOf,
  minutesOf,
  uniqueSources,
} from "./shared.js";

const ADVICE_MODES = ["car", "transit"] as const;

const TYPE_LABEL: Record<string, string> = {
  flight: "Flight",
  train: "Train",
  meeting: "Meeting",
  conference: "Conference",
  event: "Event",
  meal: "Meal",
  hotel_check_in: "Hotel check-in",
  hotel_check_out: "Hotel check-out",
  free_time: "Free time",
  custom: "Item",
};

function internalSource(runtime: ToolRuntime): SourceView {
  return {
    id: `internal:trip:${runtime.tripId}`,
    kind: "internal",
    provider: "travelflow",
    title: "TravelFlow trip data",
    retrieved_at: runtime.now().toISOString(),
    freshness: "fresh",
  };
}

function describeWeather(point: {
  description?: string | null;
  condition?: string | null;
}): string {
  return point.description ?? point.condition ?? "no description";
}

function percentOf(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return value <= 1 ? Math.round(value * 100) : Math.round(value);
}

/**
 * One read-only answer about a day of the trip: the agenda, the weather at the
 * day's first resolved place, and the ride between the day's places when the
 * trip has one. Advice wording comes from the synthesis step; every figure here
 * is copied from the agenda, OpenWeather, or the mobility engine.
 */
export function createTripAdviceTool(
  timeoutMs: number,
): ToolDefinition<ToolRuntime> {
  return {
    name: "get_trip_advice",
    description:
      "Read the plan for one day of this trip: agenda items with times and places, weather for the day's main place, and the route between the day's places with duration and distance. Use it for questions such as what to know, how to plan, or what to watch out for on a day. It never changes the itinerary.",
    category: "read",
    intents: ["get_trip_advice"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        date: {
          type: ["string", "null"],
          format: "date",
          description: "YYYY-MM-DD in the trip timezone. Leave out for today.",
        },
      },
    },
    contextArguments: [],
    timeoutMs,
    // One weather call plus two route modes at most.
    providerCalls: 3,
    live: true,
    parallelSafe: false,
    async execute(input, runtime): Promise<ToolResult> {
      const { snapshot } = runtime;
      const timezone = snapshot.trip.timezone;
      const requested = input.date;
      const date =
        typeof requested === "string" && requested.length > 0
          ? requested
          : dateInZone(runtime.now(), timezone);
      const labelOf = new Map(
        snapshot.contextPoints.map((point) => [point.id, point.label]),
      );
      const items = snapshot.agenda
        .filter(
          (item) =>
            item.status !== "cancelled" &&
            dateInZone(new Date(item.startAt), timezone) === date,
        )
        .sort(
          (left, right) => Date.parse(left.startAt) - Date.parse(right.startAt),
        )
        .slice(0, runtime.maxItems);
      const internal = internalSource(runtime);
      const cards: AssistantCard[] = items.map((item) => ({
        type: "agenda" as const,
        id: item.id,
        title: truncateText(item.title, 300),
        status: item.status,
        starts_at: new Date(item.startAt).toISOString(),
        ends_at: new Date(item.endAt).toISOString(),
        fields: [
          {
            label: "When",
            value: `${formatInZone(item.startAt, item.timezone)} (${item.timezone})`,
          },
          { label: "Type", value: TYPE_LABEL[item.type] ?? item.type },
          ...(item.contextPointId && labelOf.has(item.contextPointId)
            ? [
                {
                  label: "Place",
                  value: labelOf.get(item.contextPointId) as string,
                },
              ]
            : []),
        ],
        source_ids: [internal.id],
      }));

      const gaps = items.slice(1).map((item, index) => {
        const previous = items[index] as (typeof items)[number];
        const minutes = Math.round(
          (Date.parse(item.startAt) - Date.parse(previous.endAt)) / 60_000,
        );
        return {
          after: truncateText(previous.title, 160),
          before: truncateText(item.title, 160),
          minutes,
        };
      });

      const usablePointIds: string[] = [];
      for (const item of items) {
        if (!item.contextPointId) continue;
        if (usablePointIds.includes(item.contextPointId)) continue;
        const point = snapshot.contextPoints.find(
          (candidate) => candidate.id === item.contextPointId,
        );
        if (
          !point ||
          point.status !== "active" ||
          point.resolutionStatus !== "resolved" ||
          point.latitude === null ||
          point.longitude === null ||
          !point.externalPlaceId
        ) {
          continue;
        }
        usablePointIds.push(point.id);
      }

      let weather: WeatherView | null = null;
      let weatherSources: SourceView[] = [];
      let weatherPointLabel: string | null = null;
      if (usablePointIds.length > 0) {
        const primaryId = usablePointIds[0] as string;
        weatherPointLabel = contextPointOf(runtime, primaryId).label;
        const result = await runtime.services.getWeather({
          requestId: runtime.requestId,
          userId: runtime.userId,
          tripId: runtime.tripId,
          contextPointId: primaryId,
        });
        weather = result.weather;
        weatherSources = result.sources;
      }

      const leg = snapshot.journeyLegs.find(
        (candidate) =>
          (candidate.status === "planned" ||
            candidate.status === "in_progress") &&
          dateInZone(new Date(candidate.departureAt), timezone) === date,
      );
      let route: RouteComparisonView | null = null;
      let routeFrom: string | null = null;
      let routeTo: string | null = null;
      if (leg) {
        routeFrom = leg.originContextPointId;
        routeTo = leg.destinationContextPointId;
      } else if (usablePointIds.length >= 2) {
        routeFrom = usablePointIds[0] as string;
        routeTo = usablePointIds[1] as string;
      }
      if (routeFrom && routeTo) {
        const origin = contextPointOf(runtime, routeFrom);
        const destination = contextPointOf(runtime, routeTo);
        const startItem =
          items.find((item) => item.contextPointId === routeFrom) ?? items[0];
        route = await runtime.services.compareRoutes({
          requestId: runtime.requestId,
          executionId: runtime.executionId,
          userId: runtime.userId,
          tripId: runtime.tripId,
          ...(leg
            ? { journeyLegId: leg.id }
            : {
                originContextPointId: origin.id,
                destinationContextPointId: destination.id,
              }),
          departureAt: leg ? null : (startItem?.endAt ?? null),
          modes: [...ADVICE_MODES],
        });
      }

      const sources = uniqueSources([
        internal,
        ...weatherSources,
        ...(route?.sources ?? []),
      ]);
      const routeSourceIds = (route?.sources ?? []).map((source) => source.id);
      const weatherSourceIds = weatherSources.map((source) => source.id);

      if (weather) {
        const day =
          weather.daily.find(
            (entry) =>
              dateInZone(new Date(entry.at), weather.timezone) === date,
          ) ?? null;
        cards.push({
          type: "weather",
          id: weather.id,
          title: truncateText(
            `Weather${weatherPointLabel ? ` at ${weatherPointLabel}` : ""}`,
            300,
          ),
          subtitle: weather.timezone,
          status: weather.freshness,
          fields: [
            ...(weather.current
              ? [
                  {
                    label: "Now",
                    value: `${weather.current.temperature_c ?? "n/a"} °C, ${describeWeather(weather.current)}`,
                  },
                ]
              : []),
            ...(day
              ? [
                  {
                    label: "Day",
                    value: `${day.temperature_c ?? "n/a"} °C, ${describeWeather(day)}, rain chance ${percentOf(day.precipitation_probability) ?? "n/a"}%`,
                  },
                ]
              : []),
            {
              label: "Alerts",
              value:
                weather.alerts.length === 0
                  ? "None reported by the provider"
                  : weather.alerts.map((alert) => alert.event).join("; "),
            },
          ],
          source_ids: weatherSourceIds,
          retrieved_at: new Date(weather.retrieved_at).toISOString(),
        });
      }

      const facts: AssistantFact[] = [];
      const forecastDay = weather
        ? (weather.daily.find(
            (entry) =>
              dateInZone(new Date(entry.at), weather.timezone) === date,
          ) ?? null)
        : null;
      if (weather) {
        const day = forecastDay;
        facts.push({
          label: "Weather",
          value: day
            ? `${day.temperature_c ?? "n/a"} °C, ${describeWeather(day)}, rain chance ${percentOf(day.precipitation_probability) ?? "n/a"}%`
            : `${weather.current?.temperature_c ?? "n/a"} °C, ${weather.current ? describeWeather(weather.current) : "no current reading"}`,
          source_ids: weatherSourceIds,
        });
      }
      if (route) {
        const recommended =
          route.options.find((option) => option.recommended) ??
          route.options[0];
        if (recommended) {
          facts.push({
            label: "Getting between places",
            value: `${minutesOf(recommended.derived_metrics.total_duration_seconds)} min ${
              recommended.transport_mode
            } from ${contextPointOf(runtime, routeFrom as string).label} to ${
              contextPointOf(runtime, routeTo as string).label
            }${
              recommended.provider_facts.distance_meters === null
                ? ""
                : `, ${distanceLabel(recommended.provider_facts.distance_meters)}`
            }`,
            source_ids: recommended.source_ids,
          });
        }
      }

      const limitations: string[] = [];
      if (items.length === 0) {
        limitations.push(`No agenda item is planned for ${date}.`);
      }
      if (!weather) {
        limitations.push(
          "No place with confirmed coordinates is planned for this day, so no weather was read.",
        );
      } else if (!forecastDay) {
        limitations.push(`The provider has no daily forecast for ${date}.`);
      }
      if (!route) {
        limitations.push(
          "No ride is planned between places on this day, so no route was compared.",
        );
      } else if (route.preview) {
        limitations.push(
          "These routes were not saved: no stored journey leg covers this pair of places.",
        );
      }
      if (route) {
        limitations.push(...route.limitations.slice(0, 2));
      }
      limitations.push("Weather data from OpenWeather.");

      const retrievedAt = new Date(
        weather?.retrieved_at ??
          route?.sources[0]?.retrieved_at ??
          runtime.now().toISOString(),
      ).toISOString();
      const data = {
        date,
        timezone,
        agenda: items.map((item) => ({
          title: truncateText(item.title, 200),
          type: item.type,
          status: item.status,
          start_local: formatInZone(item.startAt, item.timezone),
          end_local: formatInZone(item.endAt, item.timezone),
          place: item.contextPointId
            ? (labelOf.get(item.contextPointId) ?? null)
            : null,
        })),
        gaps,
        weather: weather
          ? {
              place: weatherPointLabel,
              timezone: weather.timezone,
              current: weather.current
                ? {
                    temperature_c: weather.current.temperature_c,
                    condition: describeWeather(weather.current),
                    wind_speed_ms: weather.current.wind_speed_ms,
                    precipitation_mm: weather.current.precipitation_mm,
                  }
                : null,
              day: forecastDay
                ? {
                    date_local: formatInZone(forecastDay.at, weather.timezone),
                    temperature_c: forecastDay.temperature_c,
                    condition: describeWeather(forecastDay),
                    rain_chance_percent: percentOf(
                      forecastDay.precipitation_probability,
                    ),
                  }
                : null,
              alerts: weather.alerts.map((alert) => alert.event),
            }
          : null,
        route: route
          ? {
              from: contextPointOf(runtime, routeFrom as string).label,
              to: contextPointOf(runtime, routeTo as string).label,
              departure_basis: route.departureBasis,
              stored: !route.preview,
              options: route.options
                .slice(0, runtime.maxItems)
                .map((option) => ({
                  mode: option.transport_mode,
                  duration_minutes: minutesOf(
                    option.derived_metrics.total_duration_seconds,
                  ),
                  distance:
                    option.provider_facts.distance_meters === null
                      ? null
                      : distanceLabel(option.provider_facts.distance_meters),
                  recommended: option.recommended,
                  risk: option.risk,
                })),
            }
          : null,
        bookings: snapshot.bookings.slice(0, 5).map((booking) => ({
          type: booking.booking_type,
          status: booking.status,
          total: booking.total,
          currency: booking.currency,
          starts_at: booking.starts_at,
        })),
      };

      return {
        status: items.length === 0 && !weather && !route ? "empty" : "ok",
        data,
        cards: cards.slice(0, runtime.maxItems + 1),
        facts,
        sources,
        limitations,
        live: true,
        retrievedAt,
        freshness: freshnessOf([
          ...(weather ? [weather.freshness] : []),
          ...(route ? route.options.map((option) => option.freshness) : []),
        ]),
        contextPointIds: usablePointIds.slice(0, 2),
        eventResultIds: [],
        agendaItemIds: items.map((item) => item.id),
        providerCalls: (weather ? 1 : 0) + (route ? ADVICE_MODES.length : 0),
      };
    },
  };
}
