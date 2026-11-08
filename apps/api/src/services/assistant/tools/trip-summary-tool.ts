import {
  formatInZone,
  truncateText,
  type AssistantCard,
  type AssistantSource,
  type ToolDefinition,
  type ToolResult,
} from "@travelflow/domain";
import type { ToolRuntime } from "../types.js";

export const TRIP_SUMMARY_SECTIONS = [
  "all",
  "context_points",
  "agenda",
  "journey_legs",
  "bookings",
] as const;

/** Internal source: the trip data held by TravelFlow itself. */
function internalSource(runtime: ToolRuntime): AssistantSource {
  return {
    id: `internal:trip:${runtime.tripId}`,
    kind: "internal",
    provider: "travelflow",
    title: "TravelFlow trip data",
    retrieved_at: runtime.now().toISOString(),
    freshness: "fresh",
  };
}

export function createTripSummaryTool(
  timeoutMs: number,
): ToolDefinition<ToolRuntime> {
  return {
    name: "get_trip_summary",
    description:
      "Read the trip itself: context points, agenda items, journey legs, and bookings stored in TravelFlow. Use it for questions about the user's own plans. It makes no external request.",
    category: "read",
    intents: ["summarize_trip"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        section: { type: "string", enum: [...TRIP_SUMMARY_SECTIONS] },
      },
    },
    contextArguments: [],
    timeoutMs,
    providerCalls: 0,
    live: false,
    parallelSafe: true,
    async execute(input, runtime): Promise<ToolResult> {
      const section = typeof input.section === "string" ? input.section : "all";
      const wants = (name: string): boolean =>
        section === "all" || section === name;
      const source = internalSource(runtime);
      const { snapshot } = runtime;
      const labelOf = new Map(
        snapshot.contextPoints.map((point) => [point.id, point.label]),
      );
      const timezone = snapshot.trip.timezone;
      const bookings = wants("bookings")
        ? await runtime.services.listBookings(runtime.tripId)
        : [];

      const agenda = wants("agenda") ? snapshot.agenda : [];
      const cards: AssistantCard[] = agenda
        .slice(0, runtime.maxItems)
        .map((item) => ({
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
            { label: "Type", value: item.type },
            ...(item.contextPointId && labelOf.has(item.contextPointId)
              ? [
                  {
                    label: "Place",
                    value: truncateText(
                      labelOf.get(item.contextPointId) as string,
                      200,
                    ),
                  },
                ]
              : []),
          ],
          source_ids: [source.id],
        }));

      const data: Record<string, unknown> = {
        trip: {
          name: truncateText(snapshot.trip.name, 160),
          timezone,
          status: snapshot.trip.status,
          destination: snapshot.destinationSummary,
        },
      };
      if (wants("context_points")) {
        data.context_points = snapshot.contextPoints.map((point) => ({
          id: point.id,
          label: truncateText(point.label, 160),
          type: point.type,
          address: point.address,
          resolved: point.resolutionStatus === "resolved",
        }));
      }
      if (wants("agenda")) {
        data.agenda = agenda.slice(0, runtime.maxItems * 2).map((item) => ({
          id: item.id,
          title: truncateText(item.title, 200),
          type: item.type,
          status: item.status,
          start_at: new Date(item.startAt).toISOString(),
          end_at: new Date(item.endAt).toISOString(),
          place: item.contextPointId
            ? (labelOf.get(item.contextPointId) ?? null)
            : null,
        }));
      }
      if (wants("journey_legs")) {
        data.journey_legs = snapshot.journeyLegs.map((leg) => ({
          id: leg.id,
          from: labelOf.get(leg.originContextPointId) ?? null,
          to: labelOf.get(leg.destinationContextPointId) ?? null,
          departure_at: new Date(leg.departureAt).toISOString(),
          arrival_deadline: leg.arrivalDeadline
            ? new Date(leg.arrivalDeadline).toISOString()
            : null,
          status: leg.status,
        }));
      }
      if (wants("bookings")) {
        data.bookings = bookings.slice(0, runtime.maxItems).map((booking) => ({
          id: booking.id,
          type: booking.booking_type,
          status: booking.status,
          total: booking.total,
          currency: booking.currency,
          starts_at: booking.starts_at,
        }));
      }

      const facts = [
        ...(wants("context_points")
          ? [
              {
                label: "Context points",
                value: String(snapshot.contextPoints.length),
                source_ids: [source.id],
              },
            ]
          : []),
        ...(wants("agenda")
          ? [
              {
                label: "Agenda items",
                value: String(snapshot.agenda.length),
                source_ids: [source.id],
              },
            ]
          : []),
        ...(wants("journey_legs")
          ? [
              {
                label: "Journey legs",
                value: String(snapshot.journeyLegs.length),
                source_ids: [source.id],
              },
            ]
          : []),
        ...(wants("bookings")
          ? [
              {
                label: "Bookings",
                value: String(bookings.length),
                source_ids: [source.id],
              },
            ]
          : []),
      ];
      const nothing =
        facts.length > 0 && facts.every((fact) => fact.value === "0");
      return {
        status: nothing ? "empty" : "ok",
        data,
        cards: nothing ? [] : cards,
        facts,
        sources: [source],
        limitations: [],
        live: false,
        retrievedAt: null,
        freshness: "fresh",
        contextPointIds: [],
        eventResultIds: [],
        agendaItemIds: agenda.map((item) => item.id),
        providerCalls: 0,
      };
    },
  };
}
