import {
  formatInZone,
  truncateText,
  type AssistantCard,
  type ToolDefinition,
  type ToolResult,
  type WeatherPoint,
} from "@travelflow/domain";
import type { ToolRuntime } from "../types.js";
import {
  contextPointOf,
  freshnessOf,
  percentOf,
  uniqueSources,
} from "./shared.js";

/** Forecast window summarized for the next hours. Forecast points are not hourly. */
const WINDOW_HOURS = 24;
const DAYS = 3;

function describe(point: WeatherPoint): string {
  return point.description ?? point.condition ?? "no description";
}

/**
 * Current weather and short forecast for one context point, from the stored
 * OpenWeather snapshot or a new provider call when none is fresh.
 */
export function createWeatherTool(
  timeoutMs: number,
): ToolDefinition<ToolRuntime> {
  return {
    name: "get_weather",
    description:
      "Get the current weather, the next 12 hours, and the next days for one place of the trip, from the weather provider. Use it for weather questions about a place the user named or selected.",
    category: "read",
    intents: ["check_weather"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["context_point_id"],
      properties: {
        context_point_id: {
          type: "string",
          minLength: 1,
          maxLength: 80,
          description: "Id of a context point in the trip snapshot.",
        },
      },
    },
    contextArguments: ["context_point_id"],
    timeoutMs,
    providerCalls: 1,
    live: true,
    parallelSafe: false,
    async execute(input, runtime): Promise<ToolResult> {
      const contextPointId = input.context_point_id as string;
      const point = contextPointOf(runtime, contextPointId);
      const { weather, sources: sourceViews } =
        await runtime.services.getWeather({
          requestId: runtime.requestId,
          userId: runtime.userId,
          tripId: runtime.tripId,
          contextPointId,
        });
      const sources = uniqueSources(sourceViews);
      const timezone = weather.timezone;
      const retrievedAt = new Date(weather.retrieved_at).toISOString();
      const intervalMinutes = weather.forecast_interval_minutes ?? 60;
      const windowStart =
        Date.parse(weather.retrieved_at) - intervalMinutes * 60_000;
      const windowEnd =
        Date.parse(weather.retrieved_at) + WINDOW_HOURS * 3_600_000;
      const next = weather.hourly.filter((entry) => {
        const at = Date.parse(entry.at);
        return at >= windowStart && at <= windowEnd;
      });
      const temperatures = next
        .map((entry) => entry.temperature_c)
        .filter((value): value is number => value !== null);
      const chances = next
        .map((entry) => percentOf(entry.precipitation_probability))
        .filter((value): value is number => value !== null);
      const days = weather.daily.slice(0, DAYS);

      const current = weather.current
        ? {
            at_local: formatInZone(weather.current.at, timezone),
            temperature_c: weather.current.temperature_c,
            condition: describe(weather.current),
            wind_speed_ms: weather.current.wind_speed_ms,
            visibility_m: weather.current.visibility_m,
            precipitation_mm: weather.current.precipitation_mm,
          }
        : null;
      const nextHours =
        temperatures.length > 0 || chances.length > 0
          ? {
              window_hours: WINDOW_HOURS,
              forecast_points: next.length,
              interval_minutes: intervalMinutes,
              min_temperature_c:
                temperatures.length > 0 ? Math.min(...temperatures) : null,
              max_temperature_c:
                temperatures.length > 0 ? Math.max(...temperatures) : null,
              max_rain_chance_percent:
                chances.length > 0 ? Math.max(...chances) : null,
            }
          : null;
      const daily = days.map((entry) => ({
        date_local: formatInZone(entry.at, timezone).split(",")[0] ?? entry.at,
        temperature_c: entry.temperature_c,
        rain_chance_percent: percentOf(entry.precipitation_probability),
        condition: describe(entry),
      }));
      const alerts = weather.alerts.map((alert) => ({
        event: truncateText(alert.event, 200),
        sender: alert.sender,
        starts_local: alert.start ? formatInZone(alert.start, timezone) : null,
        ends_local: alert.end ? formatInZone(alert.end, timezone) : null,
      }));

      const fields: Array<{ label: string; value: string }> = [];
      if (current) {
        fields.push({
          label: "Now",
          value: `${current.temperature_c ?? "n/a"} °C, ${current.condition}`,
        });
        if (current.wind_speed_ms !== null) {
          fields.push({ label: "Wind", value: `${current.wind_speed_ms} m/s` });
        }
      }
      if (nextHours) {
        fields.push({
          label: `Next ${nextHours.window_hours} h`,
          value: `${nextHours.min_temperature_c ?? "n/a"} to ${nextHours.max_temperature_c ?? "n/a"} °C, rain chance up to ${nextHours.max_rain_chance_percent ?? "n/a"}%`,
        });
      }
      for (const day of daily) {
        fields.push({
          label: day.date_local,
          value: `${day.temperature_c ?? "n/a"} °C, ${day.condition}, rain chance ${day.rain_chance_percent ?? "n/a"}%`,
        });
      }
      fields.push({
        label: "Alerts",
        value:
          alerts.length === 0
            ? "None reported by the provider"
            : alerts.map((alert) => alert.event).join("; "),
      });

      const card: AssistantCard = {
        type: "weather",
        id: weather.id,
        title: truncateText(`Weather at ${point.label}`, 300),
        subtitle: timezone,
        status: weather.freshness,
        fields,
        source_ids: sources.map((source) => source.id),
        retrieved_at: retrievedAt,
      };
      const limitations = [
        "Rain chance is the probability reported by the weather provider.",
      ];
      if (weather.hourly.length === 0) {
        limitations.push("The provider returned no forecast.");
      } else {
        limitations.push(
          `Forecast points are ${intervalMinutes / 60} hours apart, not hourly.`,
        );
        if (weather.forecast_ends_at) {
          limitations.push(
            `The forecast ends ${formatInZone(weather.forecast_ends_at, timezone)}. Later times have no forecast.`,
          );
        }
      }
      limitations.push("Weather data from OpenWeather.");
      return {
        status: "ok",
        data: {
          place: point.label,
          timezone,
          current,
          next_hours: nextHours,
          forecast_ends_local: weather.forecast_ends_at
            ? formatInZone(weather.forecast_ends_at, timezone)
            : null,
          daily,
          alerts,
        },
        cards: [card],
        facts: [],
        sources,
        limitations,
        live: true,
        retrievedAt,
        freshness: freshnessOf([weather.freshness]),
        contextPointIds: [contextPointId],
        eventResultIds: [],
        agendaItemIds: [],
        providerCalls: weather.cache_status === "hit" ? 0 : 1,
      };
    },
  };
}
