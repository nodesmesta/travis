/**
 * Email address check without a regular expression.
 *
 * Accepted: one local part and one domain, ASCII only.
 * - The whole address is at most 254 characters, the local part at most 64.
 * - Local part: letters, digits, and ! # $ % & ' * + / = ? ^ _ ` { | } ~ - . ;
 *   no leading, trailing, or doubled dot.
 * - Domain: at least two labels separated by dots; each label has 1 to 63 letters,
 *   digits, or hyphens and does not start or end with a hyphen; the last label has at
 *   least two characters and is not all digits.
 * Spaces, control characters (so no header injection), quotes, comments, display
 * names, IP literals, and non-ASCII characters are rejected.
 */

export const EMAIL_ADDRESS_MAX_LENGTH = 254;

export type EmailAddressProblem =
  | "EMPTY"
  | "TOO_LONG"
  | "ILLEGAL_CHARACTER"
  | "MISSING_AT"
  | "MULTIPLE_AT"
  | "LOCAL_PART_INVALID"
  | "DOMAIN_INVALID";

export type ParsedEmailAddress =
  | { ok: true; address: string; local: string; domain: string }
  | { ok: false; problem: EmailAddressProblem; message: string };

const LOCAL_SYMBOLS = "!#$%&'*+/=?^_`{|}~-.";

function isAsciiLetter(char: string): boolean {
  return (char >= "a" && char <= "z") || (char >= "A" && char <= "Z");
}

function isAsciiDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

function fail(
  problem: EmailAddressProblem,
  message: string,
): ParsedEmailAddress {
  return { ok: false, problem, message };
}

function localPartValid(local: string): boolean {
  if (local.length < 1 || local.length > 64) return false;
  if (local.startsWith(".") || local.endsWith(".")) return false;
  let previousDot = false;
  for (const char of local) {
    const dot = char === ".";
    if (dot && previousDot) return false;
    previousDot = dot;
    if (
      !isAsciiLetter(char) &&
      !isAsciiDigit(char) &&
      !LOCAL_SYMBOLS.includes(char)
    ) {
      return false;
    }
  }
  return true;
}

function domainValid(domain: string): boolean {
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (label.length < 1 || label.length > 63) return false;
    if (label.startsWith("-") || label.endsWith("-")) return false;
    for (const char of label) {
      if (!isAsciiLetter(char) && !isAsciiDigit(char) && char !== "-") {
        return false;
      }
    }
  }
  const tld = labels[labels.length - 1] as string;
  if (tld.length < 2) return false;
  let allDigits = true;
  for (const char of tld) {
    if (!isAsciiDigit(char)) allDigits = false;
  }
  return !allDigits;
}

/** Trims the ends, checks the form, and lowercases the domain. */
export function parseEmailAddress(raw: string): ParsedEmailAddress {
  const value = raw.trim();
  if (value.length === 0) return fail("EMPTY", "Enter an email address.");
  if (value.length > EMAIL_ADDRESS_MAX_LENGTH) {
    return fail(
      "TOO_LONG",
      `An email address has at most ${EMAIL_ADDRESS_MAX_LENGTH} characters.`,
    );
  }
  for (const char of value) {
    const code = char.codePointAt(0) as number;
    if (code <= 0x20 || code === 0x7f || code > 0x7e) {
      return fail(
        "ILLEGAL_CHARACTER",
        "The address contains a space, a control character, or a character outside ASCII.",
      );
    }
  }
  const at = value.indexOf("@");
  if (at < 0) return fail("MISSING_AT", "The address needs an @ sign.");
  if (value.indexOf("@", at + 1) >= 0) {
    return fail("MULTIPLE_AT", "The address has more than one @ sign.");
  }
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!localPartValid(local)) {
    return fail("LOCAL_PART_INVALID", "The part before @ is not valid.");
  }
  if (!domainValid(domain)) {
    return fail("DOMAIN_INVALID", "The part after @ is not a valid domain.");
  }
  const lowerDomain = domain.toLowerCase();
  return {
    ok: true,
    address: `${local}@${lowerDomain}`,
    local,
    domain: lowerDomain,
  };
}
