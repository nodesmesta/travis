/**
 * A rate is sold with a room name the provider wrote itself ("STANDARD",
 * "Room STANDARD", "Deluxe King, Guest room, 1 King"), while the hotel content
 * describes the same room with its own wording ("Standard Single Room"). Matching
 * the two is what lets a sold rate borrow the room's photos, size and amenities.
 */

/** Words that carry no room identity, only grammar or the word "room" itself. */
const NOISE = new Set([
  "room",
  "rooms",
  "guest",
  "guests",
  "bed",
  "beds",
  "the",
  "with",
  "and",
  "or",
  "of",
  "in",
  "on",
  "at",
  "for",
  "by",
  "from",
  "a",
  "an",
  "per",
  "guestroom",
]);

/** "1 king size bed" and "king" are the same bed. */
const SYNONYMS = new Map([
  ["dbl", "double"],
  ["doublebed", "double"],
  ["full", "double"],
  ["fullsize", "double"],
  ["queen", "queen"],
  ["king", "king"],
  ["kingsize", "king"],
  ["twin", "twin"],
  ["single", "single"],
  ["sofa", "sofa"],
  ["studio", "studio"],
  ["apartment", "apartment"],
  ["suite", "suite"],
]);

/** Lowercase, punctuation to spaces, digits dropped, synonyms applied. */
export function roomWords(name: string): string[] {
  const words: string[] = [];
  let current = "";
  for (const character of name.toLowerCase()) {
    const code = character.charCodeAt(0);
    const isLetter = code >= 97 && code <= 122;
    if (isLetter) {
      current += character;
      continue;
    }
    if (current.length > 0) words.push(current);
    current = "";
  }
  if (current.length > 0) words.push(current);
  const kept: string[] = [];
  for (const word of words) {
    if (NOISE.has(word)) continue;
    const mapped = SYNONYMS.get(word) ?? word;
    if (kept.includes(mapped)) continue;
    kept.push(mapped);
  }
  return kept;
}

interface Scored {
  index: number;
  score: number;
  shared: number;
  distinctive: number;
}

/**
 * Content room for a sold rate, or null when nothing really fits — an unmatched
 * rate keeps its own card instead of wearing another room's photos.
 */
export function matchRoom<T extends { name: string }>(
  offerName: string,
  rooms: T[],
  adults: number | null,
): T | null {
  const needleWords = roomWords(offerName);
  const needle = offerName.trim().toLowerCase();
  for (const room of rooms) {
    if (room.name.trim().toLowerCase() === needle) return room;
  }
  if (needleWords.length === 0) return null;

  const candidates: Scored[] = [];
  rooms.forEach((room, index) => {
    const roomWordsList = roomWords(room.name);
    if (roomWordsList.length === 0) return;
    const set = new Set(roomWordsList);
    let shared = 0;
    for (const word of needleWords) if (set.has(word)) shared += 1;
    if (shared === 0) return;
    const union = new Set([...needleWords, ...roomWordsList]).size;
    // Names like "STANDARD" are one word; asking for two shared words would rule
    // them out while "Standard Single Room" is exactly what they mean.
    const shortest = Math.min(needleWords.length, roomWordsList.length);
    const distinctive = shared;
    if (shared < 2 && shortest > 1) return;
    candidates.push({ index, score: shared / union, shared, distinctive });
  });
  if (candidates.length === 0) return null;

  const occupancyOf = (room: T): number | null => {
    const value = (room as { max_occupancy?: number | null }).max_occupancy;
    return typeof value === "number" ? value : null;
  };
  candidates.sort((left, right) => {
    if (right.distinctive !== left.distinctive) {
      return right.distinctive - left.distinctive;
    }
    if (right.score !== left.score) return right.score - left.score;
    if (adults !== null) {
      const leftRoom = rooms[left.index];
      const rightRoom = rooms[right.index];
      if (!leftRoom || !rightRoom) return 0;
      const leftFits = occupancyOf(leftRoom) ?? adults;
      const rightFits = occupancyOf(rightRoom) ?? adults;
      const leftGap = Math.abs(leftFits - adults);
      const rightGap = Math.abs(rightFits - adults);
      if (leftGap !== rightGap) return leftGap - rightGap;
    }
    return 0;
  });
  const best = candidates[0] as Scored;
  return rooms[best.index] ?? null;
}
