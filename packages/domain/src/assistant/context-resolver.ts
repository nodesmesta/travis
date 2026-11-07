import { tokenize } from "./text.js";

/**
 * Deterministic context resolution (Segment 04, ContextResolver).
 *
 * It turns references such as "my hotel", "the meeting", "that event",
 * "the airport", or a place name into ids that exist in the trip. The order is:
 * 1) a place named in the message, 2) the context point selected in the UI,
 * 3) an event discussed earlier in the conversation. A model may later help
 * extract references, but only this resolver decides which ids are valid.
 */

export interface ResolverContextPoint {
  id: string;
  label: string;
  type: string;
  /** Active, resolved, and with coordinates. Only usable points can be searched. */
  usable: boolean;
}

export interface ResolverEventResult {
  id: string;
  title: string;
}

export interface ContextResolverInput {
  message: string;
  contextPoints: readonly ResolverContextPoint[];
  activeContextPointId: string | null;
  /** Tokens that appear in the trip name or destination and so identify nothing. */
  ignoreTokens?: readonly string[];
  /** Event results shown in the previous assistant answer, in display order. */
  previousEventResults?: readonly ResolverEventResult[];
}

export interface ContextOption {
  id: string;
  label: string;
}

export interface ContextAmbiguity {
  reference: string;
  question: string;
  options: ContextOption[];
}

export interface ContextMissing {
  reference: string;
  message: string;
}

export interface ResolvedAssistantContext {
  /**
   * resolved: at least one reference was resolved and none failed.
   * ambiguous / missing: a reference needs a user answer; no provider is called.
   * unspecified: the message names no place and the UI selected none.
   */
  status: "resolved" | "ambiguous" | "missing" | "unspecified";
  contextPointIds: string[];
  originContextPointId: string | null;
  destinationContextPointId: string | null;
  eventResultIds: string[];
  agendaItemIds: string[];
  source: "explicit_mention" | "ui_selection" | "conversation" | "none";
  ambiguities: ContextAmbiguity[];
  missing: ContextMissing[];
}

const GENERIC_LABEL_TOKENS = new Set([
  "the",
  "and",
  "hotel",
  "center",
  "centre",
  "international",
  "airport",
  "office",
  "building",
  "city",
  "kantor",
  "bandara",
  "gedung",
  "meeting",
  "venue",
  "station",
  "stasiun",
  "restaurant",
  "restoran",
]);

interface KeywordGroup {
  reference: string;
  types: readonly string[];
  words: readonly string[];
  noun: string;
}

const KEYWORD_GROUPS: readonly KeywordGroup[] = [
  {
    reference: "hotel",
    types: ["hotel"],
    words: ["hotel", "hotelnya", "penginapan"],
    noun: "hotel",
  },
  {
    reference: "airport",
    types: ["airport"],
    words: ["airport", "bandara"],
    noun: "airport",
  },
  {
    reference: "station",
    types: ["station"],
    words: ["station", "stasiun"],
    noun: "station",
  },
  {
    reference: "meeting",
    types: ["meeting", "conference"],
    words: ["meeting", "rapat", "pertemuan"],
    noun: "meeting location",
  },
  {
    reference: "venue",
    types: ["conference", "meeting"],
    words: ["venue", "konferensi", "conference", "kongres"],
    noun: "venue",
  },
  {
    reference: "office",
    types: ["meeting", "custom_location"],
    words: ["office", "kantor"],
    noun: "office",
  },
];

const DEMONSTRATIVES = new Set(["that", "this", "itu", "tersebut", "ini"]);
const EVENT_WORDS = new Set(["event", "events", "acara", "acaranya"]);
const ORDINALS: Record<string, number> = {
  first: 0,
  pertama: 0,
  second: 1,
  kedua: 1,
  third: 2,
  ketiga: 2,
};

function distinctLabelTokens(
  label: string,
  ignore: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of tokenize(label)) {
    if (token.length < 3 || seen.has(token)) continue;
    if (GENERIC_LABEL_TOKENS.has(token) || ignore.has(token)) continue;
    seen.add(token);
    result.push(token);
  }
  return result;
}

/** First letters of the words of a label, such as "jcc" for Jakarta Convention Center. */
function acronymOf(label: string): string {
  let result = "";
  for (const token of tokenize(label)) result += token[0] ?? "";
  return result;
}

function emptyContext(): ResolvedAssistantContext {
  return {
    status: "unspecified",
    contextPointIds: [],
    originContextPointId: null,
    destinationContextPointId: null,
    eventResultIds: [],
    agendaItemIds: [],
    source: "none",
    ambiguities: [],
    missing: [],
  };
}

export function resolveAssistantContext(
  input: ContextResolverInput,
): ResolvedAssistantContext {
  const result = emptyContext();
  const tokens = tokenize(input.message);
  const tokenIndex = new Map<string, number>();
  tokens.forEach((token, index) => {
    if (!tokenIndex.has(token)) tokenIndex.set(token, index);
  });
  const ignore = new Set(input.ignoreTokens ?? []);
  const points = input.contextPoints;
  const labelTokens = new Map<string, string[]>();
  const tokenOwners = new Map<string, number>();
  for (const point of points) {
    const distinct = distinctLabelTokens(point.label, ignore);
    labelTokens.set(point.id, distinct);
    for (const token of distinct) {
      tokenOwners.set(token, (tokenOwners.get(token) ?? 0) + 1);
    }
  }

  const acronyms = new Map<string, string>();
  const acronymOwners = new Map<string, number>();
  for (const point of points) {
    const acronym = acronymOf(point.label);
    if (acronym.length < 3) continue;
    acronyms.set(point.id, acronym);
    acronymOwners.set(acronym, (acronymOwners.get(acronym) ?? 0) + 1);
  }

  const positions = new Map<string, number>();
  const resolvedIds: string[] = [];
  const addResolved = (id: string, position: number): void => {
    if (!resolvedIds.includes(id)) resolvedIds.push(id);
    const known = positions.get(id);
    if (known === undefined || position < known) positions.set(id, position);
  };

  // 1) Places named in the message.
  const explicitTypes = new Set<string>();
  for (const point of points) {
    const distinct = labelTokens.get(point.id) ?? [];
    const acronym = acronyms.get(point.id);
    // An initialism such as "JCC" names a place only when no other place shares it.
    const acronymPosition =
      acronym !== undefined && acronymOwners.get(acronym) === 1
        ? tokenIndex.get(acronym)
        : undefined;
    if (distinct.length === 0 && acronymPosition === undefined) continue;
    const matched = distinct.filter((token) => tokenIndex.has(token));
    const named =
      acronymPosition !== undefined ||
      (distinct.length > 0 &&
        (matched.length === distinct.length ||
          matched.length >= 2 ||
          (matched.length === 1 &&
            (matched[0] as string).length >= 5 &&
            tokenOwners.get(matched[0] as string) === 1)));
    if (!named) continue;
    explicitTypes.add(point.type);
    const position = Math.min(
      ...matched.map((token) => tokenIndex.get(token) as number),
      ...(acronymPosition !== undefined ? [acronymPosition] : []),
    );
    if (point.usable) {
      addResolved(point.id, position);
    } else {
      result.missing.push({
        reference: point.label,
        message: `${point.label} is in your trip but its location is not confirmed yet. Confirm it first, or choose another place.`,
      });
    }
  }

  // 2) Type words such as "hotel" or "airport" (only when no place of that type was named).
  for (const group of KEYWORD_GROUPS) {
    const mention = group.words.find((word) => tokenIndex.has(word));
    if (mention === undefined) continue;
    if (group.types.some((type) => explicitTypes.has(type))) continue;
    const candidates = points.filter(
      (point) => point.usable && group.types.includes(point.type),
    );
    const position = tokenIndex.get(mention) as number;
    if (candidates.length === 0) {
      result.missing.push({
        reference: group.reference,
        message: `I don't have a ${group.noun} in this trip yet. Add the location first, or choose another trip location.`,
      });
    } else if (candidates.length === 1) {
      addResolved((candidates[0] as ResolverContextPoint).id, position);
    } else {
      result.ambiguities.push({
        reference: group.reference,
        question: `Which ${group.noun} do you mean?`,
        options: candidates.map((point) => ({
          id: point.id,
          label: point.label,
        })),
      });
    }
  }

  // 3) "that event": an event shown earlier in this conversation.
  const eventWordIndex = tokens.findIndex((token) => EVENT_WORDS.has(token));
  if (eventWordIndex >= 0) {
    const before = tokens[eventWordIndex - 1];
    const after = tokens[eventWordIndex + 1];
    const demonstrative =
      (before !== undefined && DEMONSTRATIVES.has(before)) ||
      (after !== undefined && DEMONSTRATIVES.has(after));
    const ordinalToken = tokens.find((token) => token in ORDINALS);
    const previous = input.previousEventResults ?? [];
    if (demonstrative || (ordinalToken !== undefined && previous.length > 0)) {
      if (previous.length === 0) {
        result.missing.push({
          reference: "event",
          message:
            "I don't have an event from this conversation yet. Ask me to search for events first.",
        });
      } else if (ordinalToken !== undefined) {
        const picked = previous[ORDINALS[ordinalToken] as number];
        if (picked) {
          result.eventResultIds.push(picked.id);
        } else {
          result.missing.push({
            reference: "event",
            message: "There is no event at that position in the last answer.",
          });
        }
      } else if (previous.length === 1) {
        result.eventResultIds.push((previous[0] as ResolverEventResult).id);
      } else {
        result.ambiguities.push({
          reference: "event",
          question: "Which event do you mean?",
          options: previous.map((event) => ({
            id: event.id,
            label: event.title,
          })),
        });
      }
    }
  }

  const ordered = [...resolvedIds].sort(
    (left, right) =>
      (positions.get(left) as number) - (positions.get(right) as number),
  );
  result.contextPointIds = ordered;
  if (ordered.length === 2) {
    const fromIndex = Math.min(
      ...["from", "dari"].map((word) => tokenIndex.get(word) ?? Infinity),
    );
    const toIndex = Math.min(
      ...["to", "ke"].map((word) => tokenIndex.get(word) ?? Infinity),
    );
    const firstPosition = positions.get(ordered[0] as string) as number;
    const secondPosition = positions.get(ordered[1] as string) as number;
    if (
      fromIndex < firstPosition &&
      toIndex > firstPosition &&
      toIndex < secondPosition
    ) {
      result.originContextPointId = ordered[0] as string;
      result.destinationContextPointId = ordered[1] as string;
    } else if (
      toIndex < firstPosition &&
      fromIndex > firstPosition &&
      fromIndex < secondPosition
    ) {
      result.originContextPointId = ordered[1] as string;
      result.destinationContextPointId = ordered[0] as string;
    } else if (
      fromIndex === Infinity &&
      toIndex > firstPosition &&
      toIndex < secondPosition
    ) {
      // "A to B" with no "from": the first place named is where the trip starts.
      result.originContextPointId = ordered[0] as string;
      result.destinationContextPointId = ordered[1] as string;
    }
  }

  const referenced =
    ordered.length > 0 ||
    result.eventResultIds.length > 0 ||
    result.ambiguities.length > 0 ||
    result.missing.length > 0;

  if (!referenced) {
    // 4) The place the user selected in the UI.
    const active = points.find(
      (point) => point.id === input.activeContextPointId && point.usable,
    );
    if (active) {
      result.contextPointIds = [active.id];
      result.status = "resolved";
      result.source = "ui_selection";
    }
    return result;
  }

  result.source =
    ordered.length > 0 && result.eventResultIds.length === 0
      ? "explicit_mention"
      : result.eventResultIds.length > 0
        ? "conversation"
        : "explicit_mention";
  if (result.missing.length > 0) result.status = "missing";
  else if (result.ambiguities.length > 0) result.status = "ambiguous";
  else result.status = "resolved";
  return result;
}
