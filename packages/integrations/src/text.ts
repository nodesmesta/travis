/**
 * Small text helpers. This project does not use regular expressions, so every
 * helper here scans characters explicitly.
 */

const WHITESPACE = new Set([
  "\t",
  "\n",
  "\v",
  "\f",
  "\r",
  " ",
  "\u00a0",
  "\u1680",
  "\u2028",
  "\u2029",
  "\u202f",
  "\u205f",
  "\u3000",
  "\ufeff",
]);

export function isWhitespace(char: string | undefined): boolean {
  if (char === undefined || char.length === 0) return false;
  if (WHITESPACE.has(char)) return true;
  const code = char.charCodeAt(0);
  return code >= 0x2000 && code <= 0x200a;
}

export function isDigit(char: string | undefined): boolean {
  return char !== undefined && char.length === 1 && char >= "0" && char <= "9";
}

export function isAsciiLower(char: string | undefined): boolean {
  return char !== undefined && char.length === 1 && char >= "a" && char <= "z";
}

export function isAsciiUpper(char: string | undefined): boolean {
  return char !== undefined && char.length === 1 && char >= "A" && char <= "Z";
}

export function isAsciiLetter(char: string | undefined): boolean {
  return isAsciiLower(char) || isAsciiUpper(char);
}

/** Matches the characters that make up a word: letters, digits, underscore. */
export function isWordChar(char: string | undefined): boolean {
  return isAsciiLetter(char) || isDigit(char) || char === "_";
}

export function allDigits(value: string): boolean {
  if (value.length === 0) return false;
  for (const char of value) {
    if (!isDigit(char)) return false;
  }
  return true;
}

/** Collapses every run of whitespace into one space and trims the ends. */
export function collapseWhitespace(value: string): string {
  const parts: string[] = [];
  let current = "";
  for (const char of value) {
    if (isWhitespace(char)) {
      if (current) parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current) parts.push(current);
  return parts.join(" ");
}

/** Replaces every run of characters outside `a-z0-9` (after lowercasing) with one space. */
export function alnumKey(value: string): string {
  const parts: string[] = [];
  let current = "";
  for (const char of value.toLowerCase()) {
    if (isAsciiLower(char) || isDigit(char)) {
      current += char;
    } else {
      if (current) parts.push(current);
      current = "";
    }
  }
  if (current) parts.push(current);
  return parts.join(" ");
}

export function trimTrailing(value: string, char: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === char) end -= 1;
  return value.slice(0, end);
}

export function replaceLiteral(
  value: string,
  search: string,
  replacement: string,
): string {
  if (search.length === 0) return value;
  return value.split(search).join(replacement);
}

/**
 * Removes every occurrence of the given ASCII literals, ignoring case. Repeats
 * until nothing is left, so a literal cannot be rebuilt from the text around a
 * removed one.
 */
export function removeLiteralsIgnoreCase(
  value: string,
  literals: readonly string[],
): string {
  const needles = literals.map((literal) => literal.toLowerCase());
  let current = value;
  for (;;) {
    let output = "";
    let changed = false;
    let index = 0;
    while (index < current.length) {
      const hit = needles.find(
        (needle) =>
          current.slice(index, index + needle.length).toLowerCase() === needle,
      );
      if (hit) {
        index += hit.length;
        changed = true;
      } else {
        output += current[index];
        index += 1;
      }
    }
    current = output;
    if (!changed) return current;
  }
}

/** Splits text into runs of word characters, like the tokens between word boundaries. */
export function wordRuns(
  value: string,
): Array<{ word: string; start: number; end: number }> {
  const runs: Array<{ word: string; start: number; end: number }> = [];
  let start = -1;
  for (let index = 0; index <= value.length; index += 1) {
    const inWord = index < value.length && isWordChar(value[index]);
    if (inWord && start < 0) start = index;
    if (!inWord && start >= 0) {
      runs.push({ word: value.slice(start, index), start, end: index });
      start = -1;
    }
  }
  return runs;
}

/**
 * True when an ISO-8601 date-time ends with `Z` or a numeric UTC offset.
 * `allowCompact` also accepts `+0700` in addition to `+07:00`.
 */
export function hasExplicitUtcOffset(
  value: string,
  allowCompact = false,
): boolean {
  const last = value[value.length - 1];
  if (last === "Z" || last === "z") return true;
  const signAt = (index: number): boolean =>
    value[index] === "+" || value[index] === "-";
  const length = value.length;
  if (length >= 6 && signAt(length - 6) && value[length - 3] === ":") {
    return (
      isDigit(value[length - 5]) &&
      isDigit(value[length - 4]) &&
      isDigit(value[length - 2]) &&
      isDigit(value[length - 1])
    );
  }
  if (allowCompact && length >= 5 && signAt(length - 5)) {
    return (
      isDigit(value[length - 4]) &&
      isDigit(value[length - 3]) &&
      isDigit(value[length - 2]) &&
      isDigit(value[length - 1])
    );
  }
  return false;
}

/** Lowercase, unify dashes, quotes, and whitespace so excerpts can be compared. */
export function normalizeForMatch(value: string): string {
  let mapped = "";
  for (const char of value.toLowerCase()) {
    const code = char.charCodeAt(0);
    if ((code >= 0x2010 && code <= 0x2015) || code === 0x2212) mapped += "-";
    else if (code >= 0x2018 && code <= 0x201b) mapped += "'";
    else if (code >= 0x201c && code <= 0x201f) mapped += '"';
    else mapped += char;
  }
  return collapseWhitespace(mapped);
}
