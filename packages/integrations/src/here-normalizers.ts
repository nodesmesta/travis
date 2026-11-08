import { HERE_PROVIDER } from "./here.js";
import {
  asRecord,
  finiteNumber,
  invalidResponse,
  nonBlankString,
} from "./provider-http.js";
import { hasExplicitUtcOffset } from "./text.js";

/**
 * Turns documented HERE response shapes into plain facts. Each normalizer
 * reads only fields HERE documents, throws on a malformed answer, and never
 * fills a missing value with a default. The result types are structurally the
 * same as the mobility engine's input, so the API can pass them straight in.
 */

export type NormalizedMode = "car" | "taxi" | "pedestrian" | "transit";

export interface NormalizedPlace {
  name: string | null;
  latitude: number;
  longitude: number;
  provider_place_id: string | null;
}

export interface NormalizedSection {
  type: string;
  mode: string | null;
  service_name: string | null;
  operator: string | null;
  operator_id: string | null;
  headsign: string | null;
  departure_at: string;
  arrival_at: string;
  duration_seconds: number;
  distance_meters: number | null;
  from: NormalizedPlace;
  to: NormalizedPlace;
}

export interface NormalizedRouteCandidate {
  provider: "here_routing_v8" | "here_intermodal_v8";
  provider_route_id: string;
  transport_mode: NormalizedMode;
  distance_meters: number | null;
  duration_seconds: number;
  base_duration_seconds: number | null;
  typical_duration_seconds: number | null;
  departure_at: string;
  arrival_at: string;
  sections: NormalizedSection[];
  notices: string[];
  provider_fare: null;
  source_key: string;
}

export interface NormalizedRoutes {
  candidates: NormalizedRouteCandidate[];
  /** Routes the provider returned but that are not usable for the requested mode. */
  dropped: Array<{ provider_route_id: string; reason: string }>;
}

function zoned(value: unknown, field: string): string {
  const text = nonBlankString(value);
  if (!text || !hasExplicitUtcOffset(text) || Number.isNaN(Date.parse(text))) {
    throw invalidResponse(
      HERE_PROVIDER,
      `HERE returned ${field} without a valid time and timezone.`,
    );
  }
  return new Date(text).toISOString();
}

function readPlace(value: unknown, field: string): NormalizedPlace {
  const place = asRecord(value);
  const location = place ? asRecord(place.location) : null;
  const latitude = location ? finiteNumber(location.lat) : null;
  const longitude = location ? finiteNumber(location.lng) : null;
  if (
    !place ||
    latitude === null ||
    longitude === null ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    throw invalidResponse(
      HERE_PROVIDER,
      `HERE returned ${field} without a valid location.`,
    );
  }
  return {
    name: nonBlankString(place.name),
    latitude,
    longitude,
    provider_place_id: nonBlankString(place.id),
  };
}

function noticeCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const codes: string[] = [];
  for (const notice of value) {
    const code = nonBlankString(asRecord(notice)?.code);
    if (code) codes.push(code);
  }
  return codes;
}

function seconds(from: string, to: string): number {
  return Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
}

/**
 * HERE Routing API v8 `routes[].sections[]` with `summary` (duration, length,
 * baseDuration, typicalDuration). A route total is the sum over its sections.
 * baseDuration and typicalDuration are reported only when every section has
 * one, because a partial sum would be a made-up number.
 */
export function normalizeHereRoadRoutes(
  json: unknown,
  mode: "car" | "taxi" | "pedestrian",
): NormalizedRoutes {
  const root = asRecord(json);
  if (!root || !Array.isArray(root.routes)) {
    throw invalidResponse(
      HERE_PROVIDER,
      "HERE routing answer had no routes array.",
    );
  }
  const candidates: NormalizedRouteCandidate[] = [];
  for (const rawRoute of root.routes) {
    const route = asRecord(rawRoute);
    const routeId = nonBlankString(route?.id);
    if (
      !route ||
      !routeId ||
      !Array.isArray(route.sections) ||
      route.sections.length === 0
    ) {
      throw invalidResponse(
        HERE_PROVIDER,
        "HERE returned a route without id or sections.",
      );
    }
    const sections: NormalizedSection[] = [];
    const notices: string[] = [...noticeCodes(route.notices)];
    let duration = 0;
    let length = 0;
    let lengthKnown = true;
    let base = 0;
    let baseKnown = true;
    let typical = 0;
    let typicalKnown = true;
    for (const rawSection of route.sections) {
      const section = asRecord(rawSection);
      const summary = asRecord(section?.summary);
      const sectionDuration = summary ? finiteNumber(summary.duration) : null;
      if (!section || sectionDuration === null || sectionDuration < 0) {
        throw invalidResponse(
          HERE_PROVIDER,
          "HERE returned a route section without a valid duration.",
        );
      }
      const departure = asRecord(section.departure);
      const arrival = asRecord(section.arrival);
      const departureAt = zoned(departure?.time, "section departure time");
      const arrivalAt = zoned(arrival?.time, "section arrival time");
      const sectionLength = finiteNumber(summary?.length);
      const sectionBase = finiteNumber(summary?.baseDuration);
      const sectionTypical = finiteNumber(summary?.typicalDuration);
      const transport = asRecord(section.transport);
      const transportMode = nonBlankString(transport?.mode);
      duration += sectionDuration;
      if (sectionLength === null) lengthKnown = false;
      else length += sectionLength;
      if (sectionBase !== null) base += sectionBase;
      else if (transportMode === "ferry") base += sectionDuration;
      else baseKnown = false;
      if (sectionTypical !== null) typical += sectionTypical;
      else if (transportMode === "ferry") typical += sectionDuration;
      else typicalKnown = false;
      notices.push(...noticeCodes(section.notices));
      sections.push({
        type: nonBlankString(section.type) ?? "vehicle",
        mode: transportMode,
        service_name: nonBlankString(transport?.name),
        operator: null,
        operator_id: null,
        headsign: null,
        departure_at: departureAt,
        arrival_at: arrivalAt,
        duration_seconds: sectionDuration,
        distance_meters: sectionLength,
        from: readPlace(departure?.place, "section departure place"),
        to: readPlace(arrival?.place, "section arrival place"),
      });
    }
    const first = sections[0] as NormalizedSection;
    const last = sections[sections.length - 1] as NormalizedSection;
    candidates.push({
      provider: "here_routing_v8",
      provider_route_id: routeId,
      transport_mode: mode,
      distance_meters: lengthKnown ? length : null,
      duration_seconds: duration,
      base_duration_seconds: baseKnown ? base : null,
      typical_duration_seconds: typicalKnown ? typical : null,
      departure_at: first.departure_at,
      arrival_at: last.arrival_at,
      sections,
      notices: [...new Set(notices)],
      provider_fare: null,
      source_key: `here_routing_v8:${mode}`,
    });
  }
  return { candidates, dropped: [] };
}

/**
 * HERE Intermodal Routing API v8. Sections are pedestrian, transit, vehicle,
 * taxi, or rented. A route counts as public transit only if it has a transit
 * section; a pedestrian-only answer is dropped, not relabelled. Operator names
 * come only from `agency`.
 */
export function normalizeHereIntermodalRoutes(json: unknown): NormalizedRoutes {
  const root = asRecord(json);
  if (!root || !Array.isArray(root.routes)) {
    throw invalidResponse(
      HERE_PROVIDER,
      "HERE intermodal answer had no routes array.",
    );
  }
  const candidates: NormalizedRouteCandidate[] = [];
  const dropped: NormalizedRoutes["dropped"] = [];
  for (const rawRoute of root.routes) {
    const route = asRecord(rawRoute);
    const routeId = nonBlankString(route?.id);
    if (
      !route ||
      !routeId ||
      !Array.isArray(route.sections) ||
      route.sections.length === 0
    ) {
      throw invalidResponse(
        HERE_PROVIDER,
        "HERE returned a route without id or sections.",
      );
    }
    const sections: NormalizedSection[] = [];
    const notices: string[] = [...noticeCodes(route.notices)];
    for (const rawSection of route.sections) {
      const section = asRecord(rawSection);
      const type = nonBlankString(section?.type);
      if (!section || !type) {
        throw invalidResponse(
          HERE_PROVIDER,
          "HERE returned a section without a type.",
        );
      }
      const departure = asRecord(section.departure);
      const arrival = asRecord(section.arrival);
      const departureAt = zoned(departure?.time, "section departure time");
      const arrivalAt = zoned(arrival?.time, "section arrival time");
      const transport = asRecord(section.transport);
      const agency = asRecord(section.agency);
      const summary =
        asRecord(section.travelSummary) ?? asRecord(section.summary);
      notices.push(...noticeCodes(section.notices));
      sections.push({
        type,
        mode: nonBlankString(transport?.mode),
        service_name: nonBlankString(transport?.name),
        operator: nonBlankString(agency?.name),
        operator_id: nonBlankString(agency?.id),
        headsign: nonBlankString(transport?.headsign),
        departure_at: departureAt,
        arrival_at: arrivalAt,
        duration_seconds: seconds(departureAt, arrivalAt),
        distance_meters: finiteNumber(summary?.length),
        from: readPlace(departure?.place, "section departure place"),
        to: readPlace(arrival?.place, "section arrival place"),
      });
    }
    if (!sections.some((section) => section.type === "transit")) {
      dropped.push({
        provider_route_id: routeId,
        reason: "no_transit_section",
      });
      continue;
    }
    const first = sections[0] as NormalizedSection;
    const last = sections[sections.length - 1] as NormalizedSection;
    const distances = sections.map((section) => section.distance_meters);
    candidates.push({
      provider: "here_intermodal_v8",
      provider_route_id: routeId,
      transport_mode: "transit",
      distance_meters: distances.every((value) => value !== null)
        ? distances.reduce<number>((sum, value) => sum + (value as number), 0)
        : null,
      duration_seconds: seconds(first.departure_at, last.arrival_at),
      base_duration_seconds: null,
      typical_duration_seconds: null,
      departure_at: first.departure_at,
      arrival_at: last.arrival_at,
      sections,
      notices: [...new Set(notices)],
      provider_fare: null,
      source_key: "here_intermodal_v8:transit",
    });
  }
  return { candidates, dropped };
}

// ---------------------------------------------------------------------------
// Traffic API v7

export interface NormalizedTrafficIncident {
  id: string;
  type: string | null;
  criticality: "critical" | "major" | "minor" | "low" | null;
  road_closed: boolean;
  summary: string | null;
  start_time: string | null;
  end_time: string | null;
}

export interface NormalizedTraffic {
  observed_at: string | null;
  segment_count: number;
  average_jam_factor: number | null;
  max_jam_factor: number | null;
  closed_segment_count: number;
  incident_count: number;
  incidents: NormalizedTrafficIncident[];
}

const MAX_STORED_INCIDENTS = 10;
const CRITICALITY = new Set(["critical", "major", "minor", "low"]);

function utcTime(value: unknown): string | null {
  const text = nonBlankString(value);
  if (!text || !hasExplicitUtcOffset(text) || Number.isNaN(Date.parse(text))) {
    return null;
  }
  return new Date(text).toISOString();
}

/**
 * Flow items give `currentFlow.jamFactor` (0 to 10) and `traversability`.
 * Incident items give `incidentDetails`. Either list may be empty; both empty
 * is an empty traffic area and the caller decides what that means.
 */
export function normalizeHereTraffic(
  flowJson: unknown,
  incidentsJson: unknown,
): NormalizedTraffic {
  const flow = asRecord(flowJson);
  const incidents = asRecord(incidentsJson);
  if (!flow || !Array.isArray(flow.results)) {
    throw invalidResponse(
      HERE_PROVIDER,
      "HERE traffic flow answer had no results array.",
    );
  }
  if (!incidents || !Array.isArray(incidents.results)) {
    throw invalidResponse(
      HERE_PROVIDER,
      "HERE traffic incidents answer had no results array.",
    );
  }
  let weight = 0;
  let weighted = 0;
  let max: number | null = null;
  let closed = 0;
  for (const rawItem of flow.results) {
    const item = asRecord(rawItem);
    const current = asRecord(item?.currentFlow);
    const jam = finiteNumber(current?.jamFactor);
    if (!item || !current || jam === null || jam < 0 || jam > 10) {
      throw invalidResponse(
        HERE_PROVIDER,
        "HERE returned a flow item without a valid jamFactor.",
      );
    }
    const length = finiteNumber(asRecord(item.location)?.length);
    const itemWeight = length !== null && length > 0 ? length : 1;
    weight += itemWeight;
    weighted += jam * itemWeight;
    max = max === null ? jam : Math.max(max, jam);
    if (nonBlankString(current.traversability) === "closed") closed += 1;
  }
  const list: NormalizedTrafficIncident[] = [];
  for (const rawItem of incidents.results) {
    const details = asRecord(asRecord(rawItem)?.incidentDetails);
    const id = nonBlankString(details?.id);
    if (!details || !id) {
      throw invalidResponse(
        HERE_PROVIDER,
        "HERE returned an incident without an id.",
      );
    }
    const criticality = nonBlankString(details.criticality);
    list.push({
      id,
      type: nonBlankString(details.type),
      criticality:
        criticality && CRITICALITY.has(criticality)
          ? (criticality as NormalizedTrafficIncident["criticality"])
          : null,
      road_closed: details.roadClosed === true,
      summary: nonBlankString(asRecord(details.summary)?.value),
      start_time: utcTime(details.startTime),
      end_time: utcTime(details.endTime),
    });
  }
  return {
    observed_at: utcTime(flow.sourceUpdated),
    segment_count: flow.results.length,
    average_jam_factor:
      weight > 0 ? Math.round((weighted / weight) * 100) / 100 : null,
    max_jam_factor: max,
    closed_segment_count: closed,
    incident_count: list.length,
    incidents: list.slice(0, MAX_STORED_INCIDENTS),
  };
}

// ---------------------------------------------------------------------------
// Geocoding API v7

export interface NormalizedGeocodeCandidate {
  provider_place_id: string;
  title: string;
  address_label: string | null;
  latitude: number;
  longitude: number;
  result_type: string;
  score: number | null;
}

export type GeocodeResolution =
  | { status: "resolved"; place: NormalizedGeocodeCandidate }
  | { status: "empty" }
  | { status: "ambiguous"; candidates: NormalizedGeocodeCandidate[] };

/**
 * Reads `items[]` of a geocode answer. When two or more candidates score within
 * `ambiguityMargin` of the best one, the place is ambiguous and nothing is
 * chosen (Segment 05: PLACE_AMBIGUOUS).
 */
export function normalizeHereGeocode(
  json: unknown,
  ambiguityMargin = 0.05,
): GeocodeResolution {
  const root = asRecord(json);
  if (!root || !Array.isArray(root.items)) {
    throw invalidResponse(
      HERE_PROVIDER,
      "HERE geocoding answer had no items array.",
    );
  }
  const candidates: NormalizedGeocodeCandidate[] = [];
  for (const rawItem of root.items) {
    const item = asRecord(rawItem);
    const position = asRecord(item?.position);
    const latitude = finiteNumber(position?.lat);
    const longitude = finiteNumber(position?.lng);
    const id = nonBlankString(item?.id);
    const title = nonBlankString(item?.title);
    if (
      !item ||
      !id ||
      !title ||
      latitude === null ||
      longitude === null ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180
    ) {
      throw invalidResponse(
        HERE_PROVIDER,
        "HERE returned a geocoding item without id, title, or position.",
      );
    }
    candidates.push({
      provider_place_id: id,
      title,
      address_label: nonBlankString(asRecord(item.address)?.label),
      latitude,
      longitude,
      result_type: nonBlankString(item.resultType) ?? "unknown",
      score: finiteNumber(asRecord(item.scoring)?.queryScore),
    });
  }
  if (candidates.length === 0) return { status: "empty" };
  const best = Math.max(...candidates.map((candidate) => candidate.score ?? 0));
  const close = candidates.filter(
    (candidate) => (candidate.score ?? 0) >= best - ambiguityMargin,
  );
  if (close.length > 1) return { status: "ambiguous", candidates: close };
  return { status: "resolved", place: close[0] as NormalizedGeocodeCandidate };
}
