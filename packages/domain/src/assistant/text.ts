/** Small text helpers for the assistant. No regular expressions. */

export function isDigitChar(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

export function isLetterOrDigit(char: string | undefined): boolean {
  if (char === undefined) return false;
  if (isDigitChar(char)) return true;
  const lower = char.toLowerCase();
  return (lower >= "a" && lower <= "z") || lower.charCodeAt(0) > 127;
}

/** Lower-case word tokens made of letters and digits. */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  for (const char of text.toLowerCase()) {
    if (isLetterOrDigit(char)) {
      current += char;
    } else if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/** Runs of ASCII digits, in order of appearance. */
export function digitRuns(text: string): string[] {
  const runs: string[] = [];
  let current = "";
  for (const char of text) {
    if (isDigitChar(char)) {
      current += char;
    } else if (current.length > 0) {
      runs.push(current);
      current = "";
    }
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/** Strips leading zeros so "05" and "5" compare equal. */
export function normalizeDigitRun(run: string): string {
  let start = 0;
  while (start < run.length - 1 && run[start] === "0") start += 1;
  return run.slice(start);
}

/**
 * Makes text safe to place inside an untrusted-data fence: angle brackets are
 * escaped so the content cannot close the fence or open a fake system tag, and
 * control characters other than newline and tab are dropped.
 */
export function escapeUntrusted(text: string): string {
  let result = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (char === "<") result += "&lt;";
    else if (char === ">") result += "&gt;";
    else if (code < 32 && char !== "\n" && char !== "\t") result += " ";
    else result += char;
  }
  return result;
}

/** Truncates by characters and marks the cut. */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** URLs starting with http:// or https://, up to the next whitespace or quote. */
export function findUrls(text: string): string[] {
  const urls: string[] = [];
  let index = 0;
  while (index < text.length) {
    const http = text.indexOf("http://", index);
    const https = text.indexOf("https://", index);
    let start = -1;
    if (http >= 0 && https >= 0) start = Math.min(http, https);
    else start = Math.max(http, https);
    if (start < 0) break;
    let end = start;
    while (end < text.length) {
      const char = text[end] as string;
      if (
        char === " " ||
        char === "\n" ||
        char === "\t" ||
        char === '"' ||
        char === "'" ||
        char === ")" ||
        char === ">" ||
        char === "]"
      ) {
        break;
      }
      end += 1;
    }
    let url = text.slice(start, end);
    while (
      url.length > 0 &&
      (url.endsWith(".") || url.endsWith(",") || url.endsWith(";"))
    ) {
      url = url.slice(0, -1);
    }
    urls.push(url);
    index = Math.max(end, start + 1);
  }
  return urls;
}

function isHexChar(char: string | undefined): boolean {
  if (char === undefined) return false;
  return (
    isDigitChar(char) ||
    (char >= "a" && char <= "f") ||
    (char >= "A" && char <= "F")
  );
}

/** True when `text` holds a canonical UUID (8-4-4-4-12 hex digits) starting at `start`. */
function uuidAt(text: string, start: number): boolean {
  if (start + 36 > text.length) return false;
  for (let offset = 0; offset < 36; offset += 1) {
    const char = text[start + offset];
    if (offset === 8 || offset === 13 || offset === 18 || offset === 23) {
      if (char !== "-") return false;
    } else if (!isHexChar(char)) {
      return false;
    }
  }
  return true;
}

/**
 * Replaces every UUID with a space. Identifiers are not values, so the digits
 * inside them must not make a number in an answer look grounded.
 */
export function stripUuids(text: string): string {
  let result = "";
  let index = 0;
  while (index < text.length) {
    if (uuidAt(text, index)) {
      result += " ";
      index += 36;
    } else {
      result += text[index];
      index += 1;
    }
  }
  return result;
}
