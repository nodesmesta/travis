/**
 * Invoice numbers are `INV-YYYY-NNNNNN`.
 *
 * - `YYYY` is the UTC year of the issue date.
 * - `NNNNNN` is a counter per year, starting at 1, zero padded to six digits.
 *   The database hands the counter out without gaps (migration 0010), so the number
 *   of an invoice tells how many invoices were issued before it in that year.
 */

export const INVOICE_NUMBER_PREFIX = "INV-";
export const INVOICE_NUMBER_LENGTH = 15;
export const INVOICE_MAX_SEQUENCE = 999_999;

export interface ParsedInvoiceNumber {
  year: number;
  sequence: number;
}

function digitsOnly(value: string): boolean {
  if (value.length === 0) return false;
  for (const char of value) {
    if (char < "0" || char > "9") return false;
  }
  return true;
}

export function formatInvoiceNumber(year: number, sequence: number): string {
  if (!Number.isInteger(year) || year < 2000 || year > 9999) {
    throw new RangeError("Invoice year must be an integer from 2000 to 9999.");
  }
  if (
    !Number.isInteger(sequence) ||
    sequence < 1 ||
    sequence > INVOICE_MAX_SEQUENCE
  ) {
    throw new RangeError(
      `Invoice sequence must be an integer from 1 to ${INVOICE_MAX_SEQUENCE}.`,
    );
  }
  return `${INVOICE_NUMBER_PREFIX}${year}-${String(sequence).padStart(6, "0")}`;
}

/** Returns the year and counter, or null when the text is not a valid invoice number. */
export function parseInvoiceNumber(value: string): ParsedInvoiceNumber | null {
  if (value.length !== INVOICE_NUMBER_LENGTH) return null;
  if (!value.startsWith(INVOICE_NUMBER_PREFIX)) return null;
  const year = value.slice(4, 8);
  const sequence = value.slice(9, 15);
  if (value[8] !== "-" || !digitsOnly(year) || !digitsOnly(sequence)) {
    return null;
  }
  const parsedYear = Number(year);
  const parsedSequence = Number(sequence);
  if (parsedYear < 2000 || parsedSequence < 1) return null;
  return { year: parsedYear, sequence: parsedSequence };
}
