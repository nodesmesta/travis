import { createHash } from "node:crypto";
import { ExternalDataError } from "./errors.js";
import {
  asRecord,
  finiteNumber,
  invalidResponse,
  nonBlankString,
} from "./provider-http.js";
import { HERE_PROVIDER } from "./here.js";
import { alnumKey, isDigit, normalizeForMatch, wordRuns } from "./text.js";

/**
 * Nearby places (Task 08, part B).
 *
 * Restaurants come from HERE Browse and are checked against the context point
 * with a distance computed here. Activities come from Bright Data pages
 * (see activity-pipeline.ts). A place without a source, or outside the
 * requested place, is rejected before it reaches storage.
 */

export const HERE_RESTAURANT_CATEGORY = "100-1000-0000";
export const PLACE_PIPELINE_VERSION = "place-v1";

export type PlaceCategory = "activity" | "restaurant";

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

export function placeFingerprint(parts: Record<string, unknown>): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        stableValue({ ...parts, pipeline: PLACE_PIPELINE_VERSION }),
      ),
    )
    .digest("hex");
}

const EARTH_RADIUS_METERS = 6_371_008.8;

export function distanceMeters(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  const radians = (degrees: number): number => (degrees * Math.PI) / 180;
  const dLat = radians(to.latitude - from.latitude);
  const dLng = radians(to.longitude - from.longitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(from.latitude)) *
      Math.cos(radians(to.latitude)) *
      Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function httpUrlOrNull(value: unknown): string | null {
  const text = nonBlankString(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Restaurants (HERE Browse)

export interface RestaurantQuery {
  contextPointId: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  limit: number;
  language?: string;
}

export interface NormalizedRestaurant {
  dedupeKey: string;
  provider_place_id: string;
  name: string;
  address: string | null;
  latitude: number;
  longitude: number;
  distance_meters: number;
  official_url: string | null;
  cuisines: string[];
  /** Opening-hours text exactly as HERE returned it. Null when HERE returned none. */
  opening_hours_text: string[] | null;
}

export interface NormalizedRestaurants {
  items: NormalizedRestaurant[];
  rejected: Array<{ reason: string; count: number }>;
}

export function restaurantFingerprint(query: RestaurantQuery): string {
  return placeFingerprint({
    provider: "here_places_v7",
    category: "restaurant",
    contextPointId: query.contextPointId,
    radiusMeters: query.radiusMeters,
    limit: query.limit,
    language: query.language ?? null,
    hereCategory: HERE_RESTAURANT_CATEGORY,
  });
}

/**
 * Reads `items[]` of a HERE Browse answer. Opening hours are kept only as the
 * provider's own text; `isOpen` is ignored because it describes the request
 * moment, not the meal time. Distance is recomputed from the coordinates and
 * must fall inside the requested radius.
 */
export function normalizeHereRestaurants(
  json: unknown,
  query: RestaurantQuery,
): NormalizedRestaurants {
  const root = asRecord(json);
  if (!root || !Array.isArray(root.items)) {
    throw invalidResponse(
      HERE_PROVIDER,
      "HERE browse answer had no items array.",
    );
  }
  const rejected = new Map<string, number>();
  const reject = (reason: string): void => {
    rejected.set(reason, (rejected.get(reason) ?? 0) + 1);
  };
  const items = new Map<string, NormalizedRestaurant>();
  for (const rawItem of root.items) {
    const item = asRecord(rawItem);
    if (!item) {
      reject("item was not an object");
      continue;
    }
    const id = nonBlankString(item.id);
    const name = nonBlankString(item.title);
    const position = asRecord(item.position);
    const latitude = finiteNumber(position?.lat);
    const longitude = finiteNumber(position?.lng);
    if (!id) {
      reject("item has no provider id, so it has no source");
      continue;
    }
    if (!name) {
      reject("item has no name");
      continue;
    }
    if (nonBlankString(item.resultType) !== "place") {
      reject("item is not a place");
      continue;
    }
    if (
      latitude === null ||
      longitude === null ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180
    ) {
      reject("item has no valid position");
      continue;
    }
    const distance = Math.round(
      distanceMeters(
        { latitude: query.latitude, longitude: query.longitude },
        { latitude, longitude },
      ),
    );
    if (distance > query.radiusMeters) {
      reject("item is outside the requested radius");
      continue;
    }
    const categories = Array.isArray(item.categories) ? item.categories : [];
    const isRestaurant = categories.some((entry) => {
      const categoryId = nonBlankString(asRecord(entry)?.id);
      return categoryId !== null && categoryId.startsWith("100-1000-");
    });
    if (!isRestaurant) {
      reject("item is not in a restaurant category");
      continue;
    }
    const cuisines: string[] = [];
    if (Array.isArray(item.foodTypes)) {
      for (const entry of item.foodTypes) {
        const cuisine = nonBlankString(asRecord(entry)?.name);
        if (cuisine && !cuisines.includes(cuisine)) cuisines.push(cuisine);
      }
    }
    let website: string | null = null;
    if (Array.isArray(item.contacts)) {
      for (const contact of item.contacts) {
        const www = asRecord(contact)?.www;
        if (Array.isArray(www)) {
          for (const entry of www) {
            website = website ?? httpUrlOrNull(asRecord(entry)?.value);
          }
        }
      }
    }
    const hoursText: string[] = [];
    if (Array.isArray(item.openingHours)) {
      for (const block of item.openingHours) {
        const lines = asRecord(block)?.text;
        if (Array.isArray(lines)) {
          for (const line of lines) {
            const text = nonBlankString(line);
            if (text) hoursText.push(text.slice(0, 200));
          }
        }
      }
    }
    if (items.has(id)) {
      reject("duplicate provider id");
      continue;
    }
    items.set(id, {
      dedupeKey: id,
      provider_place_id: id,
      name: name.slice(0, 300),
      address: nonBlankString(asRecord(item.address)?.label),
      latitude,
      longitude,
      distance_meters: distance,
      official_url: website,
      cuisines,
      opening_hours_text: hoursText.length > 0 ? hoursText : null,
    });
  }
  return {
    items: [...items.values()].sort(
      (a, b) =>
        a.distance_meters - b.distance_meters ||
        (a.dedupeKey < b.dedupeKey ? -1 : 1),
    ),
    rejected: [...rejected.entries()].map(([reason, count]) => ({
      reason,
      count,
    })),
  };
}

// ---------------------------------------------------------------------------
// Evidence helpers shared by the activity validator

/** True when the excerpt contains at least one of the lower-case literals. */
export function evidenceHasAny(
  evidence: string,
  literals: readonly string[],
): boolean {
  const text = normalizeForMatch(evidence);
  return literals.some((literal) => text.includes(literal));
}

const HOUR_UNITS = new Set(["hour", "hours", "hr", "hrs", "jam"]);
const MINUTE_UNITS = new Set(["minute", "minutes", "min", "mins", "menit"]);

interface DurationMention {
  minutes: number;
  startRun: number;
  endRun: number;
  isHours: boolean;
}

/**
 * True when the excerpt states a duration that equals `minutes`: "2 hours",
 * "90 minutes", "1.5 hours", or "1 hour 30 minutes". Anything else is not
 * evidence, so the caller leaves the duration empty.
 */
export function evidenceStatesDuration(
  evidence: string,
  minutes: number,
): boolean {
  if (!Number.isInteger(minutes) || minutes <= 0) return false;
  const text = normalizeForMatch(evidence);
  const runs = wordRuns(text);
  const mentions: DurationMention[] = [];
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    if (!run || !isNumberWord(run.word)) continue;
    let value = Number(run.word);
    let unitIndex = index + 1;
    const next = runs[index + 1];
    if (
      next &&
      isNumberWord(next.word) &&
      text[run.end] === "." &&
      next.start === run.end + 1
    ) {
      value += Number(next.word) / 10 ** next.word.length;
      unitIndex = index + 2;
    }
    const unit = runs[unitIndex]?.word;
    if (!unit) continue;
    if (HOUR_UNITS.has(unit)) {
      mentions.push({
        minutes: Math.round(value * 60),
        startRun: index,
        endRun: unitIndex,
        isHours: true,
      });
    } else if (MINUTE_UNITS.has(unit)) {
      mentions.push({
        minutes: Math.round(value),
        startRun: index,
        endRun: unitIndex,
        isHours: false,
      });
    }
  }
  for (let index = 0; index < mentions.length; index += 1) {
    const mention = mentions[index] as DurationMention;
    if (mention.minutes === minutes) return true;
    const following = mentions[index + 1];
    if (
      mention.isHours &&
      following &&
      !following.isHours &&
      following.startRun === mention.endRun + 1 &&
      mention.minutes + following.minutes === minutes
    ) {
      return true;
    }
  }
  return false;
}

function isNumberWord(word: string): boolean {
  if (word.length === 0) return false;
  for (const char of word) if (!isDigit(char)) return false;
  return true;
}

const LOCALITY_STOP_WORDS = new Set([
  "hotel",
  "airport",
  "international",
  "convention",
  "center",
  "centre",
  "bandara",
  "road",
  "street",
  "jalan",
]);

/**
 * Terms that tie a page to the requested place: the words of its address and
 * of the trip destination. The label's own words are used only when neither
 * is known, and generic words are never used.
 */
export function localityTerms(input: {
  label: string;
  address: string | null;
  destination: string | null;
}): string[] {
  const collect = (value: string | null): string[] =>
    value
      ? alnumKey(value)
          .split(" ")
          .filter((term) => term.length >= 4 && !LOCALITY_STOP_WORDS.has(term))
      : [];
  const primary = [...collect(input.address), ...collect(input.destination)];
  const terms = primary.length > 0 ? primary : collect(input.label);
  return [...new Set(terms)];
}

export function mentionsLocality(
  text: string,
  terms: readonly string[],
): boolean {
  if (terms.length === 0) return false;
  const haystack = ` ${alnumKey(text)} `;
  return terms.some((term) => haystack.includes(` ${term} `));
}

export function weatherSensitivityFor(
  indoorOutdoor: "indoor" | "outdoor" | "both" | "unknown",
): "low" | "medium" | "high" | "unknown" {
  switch (indoorOutdoor) {
    case "indoor":
      return "low";
    case "outdoor":
      return "high";
    case "both":
      return "medium";
    default:
      return "unknown";
  }
}

export function assertPlaceInput(
  provider: string,
  input: { tripId: string; contextPointId: string; contextLabel: string },
): void {
  if (!input.tripId || !input.contextPointId || !input.contextLabel.trim()) {
    throw new ExternalDataError(
      "EXTERNAL_QUERY_INVALID",
      provider,
      "Place discovery requires a trip, a context point, and a place name.",
      400,
    );
  }
}
