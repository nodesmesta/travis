/**
 * Invoice PDF writer and checker. No dependency and no regular expression.
 *
 * Decision: the invoice is one A4 page of text and lines, so a small writer of
 * PDF 1.4 (catalog, page tree, one page, the standard Helvetica fonts, one
 * uncompressed content stream, classic xref table) is easier to audit and test than a
 * library, and the same input always gives the same bytes (no random ids, no clock).
 * Same bytes means the same SHA-256, which keeps "generate twice" and a resumed
 * generation idempotent.
 *
 * Text uses WinAnsiEncoding. A character that WinAnsi cannot show is written as "?".
 */

export type InvoiceBookingType =
  "event" | "activity" | "itinerary_item" | "hotel" | "flight";

export interface InvoicePdfInput {
  invoiceNumber: string;
  /** ISO date-time of the issue date. */
  issuedAt: string;
  bookingReference: string;
  bookingType: InvoiceBookingType;
  /** Title of the booked item when the source row still exists. */
  itemTitle: string | null;
  currency: string;
  subtotal: number;
  tax: number;
  total: number;
  paymentReference: string;
  paymentStatus: string;
  /** ISO date-time, or null when the payment has no paid time. */
  paidAt: string | null;
  pricingPolicy: string;
}

export const DUMMY_PAYMENT_NOTE = "Dummy payment — no real money moved.";

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 50;
const RIGHT = PAGE_WIDTH - MARGIN;
const MAX_TITLE_CHARS = 300;
const WRAP_CHARS = 72;

const BOOKING_LABEL: Record<InvoiceBookingType, string> = {
  event: "Event booking",
  activity: "Activity booking",
  itinerary_item: "Itinerary item booking",
  hotel: "Hotel booking",
  flight: "Flight booking",
};

/** Code points above U+00FF that WinAnsiEncoding places in 0x80-0x9F. */
const WIN_ANSI_EXTRA = new Map<number, number>([
  [0x20ac, 0x80],
  [0x201a, 0x82],
  [0x0192, 0x83],
  [0x201e, 0x84],
  [0x2026, 0x85],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02c6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8a],
  [0x2039, 0x8b],
  [0x0152, 0x8c],
  [0x017d, 0x8e],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201c, 0x93],
  [0x201d, 0x94],
  [0x2022, 0x95],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x02dc, 0x98],
  [0x2122, 0x99],
  [0x0161, 0x9a],
  [0x203a, 0x9b],
  [0x0153, 0x9c],
  [0x017e, 0x9e],
  [0x0178, 0x9f],
]);

function winAnsiByte(codePoint: number): number {
  if (codePoint >= 0x20 && codePoint <= 0x7e) return codePoint;
  if (codePoint >= 0xa0 && codePoint <= 0xff) return codePoint;
  const extra = WIN_ANSI_EXTRA.get(codePoint);
  if (extra !== undefined) return extra;
  if (codePoint < 0x20 || codePoint === 0x7f) return 0x20;
  return 0x3f;
}

function octal(byte: number): string {
  return `\\${byte.toString(8).padStart(3, "0")}`;
}

/** A PDF literal string: WinAnsi bytes, with ( ) \ and non-ASCII bytes escaped. */
function pdfString(text: string): string {
  let out = "(";
  for (const char of text) {
    const byte = winAnsiByte(char.codePointAt(0) as number);
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) {
      out += `\\${String.fromCharCode(byte)}`;
    } else if (byte < 0x20 || byte > 0x7e) {
      out += octal(byte);
    } else {
      out += String.fromCharCode(byte);
    }
  }
  return `${out})`;
}

function num(value: number): string {
  return value.toFixed(2);
}

/** Digits, comma, and period are 556, 278, and 278 units wide in Helvetica and Helvetica-Bold. */
function amountWidth(text: string, size: number): number {
  let units = 0;
  for (const char of text) {
    units += char === "," || char === "." || char === " " ? 278 : 556;
  }
  return (units * size) / 1000;
}

function groupThousands(digits: string): string {
  let out = "";
  for (let index = 0; index < digits.length; index += 1) {
    const fromEnd = digits.length - index;
    out += digits[index];
    if (fromEnd > 1 && fromEnd % 3 === 1) out += ",";
  }
  return out;
}

/** 250000 gives "250,000"; 1234.5 gives "1,234.50". */
export function formatAmount(value: number): string {
  const cents = Math.round(Math.abs(value) * 100);
  const whole = Math.floor(cents / 100);
  const fraction = cents % 100;
  const sign = value < 0 ? "-" : "";
  const grouped = groupThousands(String(whole));
  return fraction === 0
    ? `${sign}${grouped}`
    : `${sign}${grouped}.${String(fraction).padStart(2, "0")}`;
}

function utcText(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    throw new RangeError("The PDF needs valid ISO date-times.");
  }
  const text = parsed.toISOString();
  return `${text.slice(0, 10)} ${text.slice(11, 16)} UTC`;
}

function pdfDate(iso: string): string {
  const text = new Date(iso).toISOString();
  return `D:${text.slice(0, 4)}${text.slice(5, 7)}${text.slice(8, 10)}${text.slice(11, 13)}${text.slice(14, 16)}${text.slice(17, 19)}Z`;
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    if (word.length === 0) continue;
    let rest = word;
    while (rest.length > width) {
      if (current.length > 0) {
        lines.push(current);
        current = "";
      }
      lines.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    if (current.length === 0) current = rest;
    else if (current.length + 1 + rest.length <= width) current += ` ${rest}`;
    else {
      lines.push(current);
      current = rest;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

function singleLine(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    out += code < 0x20 || code === 0x7f ? " " : char;
  }
  return out.trim();
}

class ContentStream {
  private readonly ops: string[] = [];

  public text(
    x: number,
    y: number,
    bold: boolean,
    size: number,
    value: string,
  ): void {
    this.ops.push(
      `BT /${bold ? "F2" : "F1"} ${size} Tf ${num(x)} ${num(y)} Td ${pdfString(value)} Tj ET`,
    );
  }

  public rightText(
    right: number,
    y: number,
    bold: boolean,
    size: number,
    value: string,
  ): void {
    this.text(right - amountWidth(value, size), y, bold, size, value);
  }

  public rule(y: number, width = 0.6): void {
    this.ops.push(
      `${width} w ${num(MARGIN)} ${num(y)} m ${num(RIGHT)} ${num(y)} l S`,
    );
  }

  public toString(): string {
    return `${this.ops.join("\n")}\n`;
  }
}

function drawInvoice(input: InvoicePdfInput): string {
  const page = new ContentStream();
  let y = 790;
  page.text(MARGIN, y, true, 22, "Travis");
  y -= 18;
  page.text(MARGIN, y, false, 10, "Booking confirmation and invoice");
  y -= 34;
  page.text(MARGIN, y, true, 14, "INVOICE");
  y -= 26;

  const details: Array<[string, string]> = [
    ["Invoice number", input.invoiceNumber],
    ["Issue date", utcText(input.issuedAt)],
    ["Booking reference", input.bookingReference],
    ["Payment reference", input.paymentReference],
    ["Payment status", input.paymentStatus],
    ["Paid at", input.paidAt === null ? "Not recorded" : utcText(input.paidAt)],
  ];
  for (const [label, value] of details) {
    page.text(MARGIN, y, true, 10, label);
    page.text(MARGIN + 130, y, false, 10, singleLine(value));
    y -= 16;
  }

  y -= 14;
  page.rule(y + 10);
  page.text(MARGIN, y - 6, true, 10, "Description");
  page.rightText(RIGHT, y - 6, true, 10, `Amount (${input.currency})`);
  y -= 14;
  page.rule(y);
  y -= 18;

  const title =
    input.itemTitle === null
      ? ""
      : singleLine(input.itemTitle).slice(0, MAX_TITLE_CHARS);
  const descriptionLines = [BOOKING_LABEL[input.bookingType]];
  if (title.length > 0) descriptionLines.push(...wrap(title, WRAP_CHARS));
  descriptionLines.forEach((line, index) => {
    page.text(MARGIN, y, index === 0, 10, line);
    if (index === 0) {
      page.rightText(RIGHT, y, false, 10, formatAmount(input.subtotal));
    }
    y -= 15;
  });
  y -= 2;
  page.rule(y + 8);
  y -= 14;

  const totals: Array<[string, string, boolean]> = [
    ["Subtotal", formatAmount(input.subtotal), false],
    ["Tax", formatAmount(input.tax), false],
    [`Total (${input.currency})`, formatAmount(input.total), true],
  ];
  for (const [label, value, bold] of totals) {
    page.text(350, y, bold, bold ? 12 : 10, label);
    page.rightText(RIGHT, y, bold, bold ? 12 : 10, value);
    y -= bold ? 20 : 16;
  }

  y -= 24;
  page.text(
    MARGIN,
    y,
    false,
    9,
    `Pricing policy: ${singleLine(input.pricingPolicy)}`,
  );
  y -= 14;
  page.text(MARGIN, y, true, 9, DUMMY_PAYMENT_NOTE);
  return page.toString();
}

function toBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = text.charCodeAt(index) & 0xff;
  }
  return bytes;
}

function toLatin1(bytes: Uint8Array): string {
  let out = "";
  const chunk = 8192;
  for (let index = 0; index < bytes.length; index += chunk) {
    out += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return out;
}

/** Builds the invoice PDF. The same input always returns the same bytes. */
export function buildInvoicePdf(input: InvoicePdfInput): Uint8Array {
  const content = drawInvoice(input);
  const infoTitle = pdfString(`Invoice ${input.invoiceNumber}`);
  const bodies = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    `<< /Title ${infoTitle} /Producer (Travis Assistant) /CreationDate (${pdfDate(input.issuedAt)}) >>`,
  ];

  let out = "%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n";
  const offsets: number[] = [];
  bodies.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = out.length;
  out += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R /Info 7 0 R >>\n`;
  out += `startxref\n${xrefOffset}\n%%EOF\n`;
  return toBytes(out);
}

// ---------------------------------------------------------------------------
// Checker

export type PdfInspection =
  | { valid: true; pageCount: number; objectCount: number; size: number }
  | { valid: false; reason: string };

function readDigits(
  text: string,
  position: number,
): { value: number; end: number } | null {
  let end = position;
  while (
    end < text.length &&
    text[end] !== undefined &&
    text[end]! >= "0" &&
    text[end]! <= "9"
  ) {
    end += 1;
  }
  if (end === position) return null;
  return { value: Number(text.slice(position, end)), end };
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let from = text.indexOf(needle);
  while (from >= 0) {
    count += 1;
    from = text.indexOf(needle, from + needle.length);
  }
  return count;
}

/**
 * Checks the structure of a PDF: header, end marker, startxref pointing at a classic
 * xref table, every in-use entry pointing at the matching "N 0 obj", and a trailer
 * whose Root is a Catalog. This is the "valid PDF" gate before a file is stored or
 * attached to an email. It does not render the page.
 */
export function inspectPdf(bytes: Uint8Array): PdfInspection {
  const bad = (reason: string): PdfInspection => ({ valid: false, reason });
  if (bytes.length < 64) return bad("The file is too small to be a PDF.");
  const text = toLatin1(bytes);
  if (!text.startsWith("%PDF-1.")) return bad("The %PDF- header is missing.");
  const tail = text.trimEnd();
  if (!tail.endsWith("%%EOF")) return bad("The %%EOF marker is missing.");

  const startxref = tail.lastIndexOf("startxref");
  if (startxref < 0) return bad("startxref is missing.");
  let position = startxref + "startxref".length;
  while (
    text[position] === "\n" ||
    text[position] === "\r" ||
    text[position] === " "
  )
    position += 1;
  const pointer = readDigits(text, position);
  if (!pointer) return bad("startxref has no offset.");
  if (!text.startsWith("xref", pointer.value)) {
    return bad("startxref does not point at the xref table.");
  }

  position = pointer.value + 4;
  while (
    text[position] === "\n" ||
    text[position] === "\r" ||
    text[position] === " "
  )
    position += 1;
  const first = readDigits(text, position);
  if (!first || first.value !== 0)
    return bad("The xref table must start at object 0.");
  position = first.end;
  while (text[position] === " ") position += 1;
  const count = readDigits(text, position);
  if (!count || count.value < 2) return bad("The xref table has no objects.");
  position = count.end;
  while (
    text[position] === "\n" ||
    text[position] === "\r" ||
    text[position] === " "
  )
    position += 1;

  for (let index = 0; index < count.value; index += 1) {
    const entry = text.slice(position, position + 20);
    if (
      entry.length !== 20 ||
      entry[10] !== " " ||
      entry[16] !== " " ||
      entry[19] !== "\n"
    ) {
      return bad(`xref entry ${index} is not 20 bytes long.`);
    }
    const offset = Number(entry.slice(0, 10));
    const kind = entry[17];
    if (index === 0) {
      if (kind !== "f") return bad("xref entry 0 must be free.");
    } else {
      if (kind !== "n" || Number.isNaN(offset))
        return bad(`xref entry ${index} is not in use.`);
      if (!text.startsWith(`${index} 0 obj`, offset)) {
        return bad(`xref entry ${index} does not point at "${index} 0 obj".`);
      }
    }
    position += 20;
  }

  const trailer = text.indexOf("trailer", position);
  if (trailer < 0) return bad("The trailer is missing.");
  const trailerText = text.slice(trailer, startxref);
  if (!trailerText.includes(`/Size ${count.value}`))
    return bad("The trailer /Size is wrong.");
  const rootMark = trailerText.indexOf("/Root ");
  const root = rootMark < 0 ? null : readDigits(trailerText, rootMark + 6);
  if (!root) return bad("The trailer has no /Root.");
  const rootOffset = text.indexOf(`${root.value} 0 obj`);
  if (
    rootOffset < 0 ||
    !text.slice(rootOffset, rootOffset + 80).includes("/Type /Catalog")
  ) {
    return bad("/Root is not a Catalog.");
  }

  const pages =
    countOccurrences(text, "/Type /Page ") +
    countOccurrences(text, "/Type /Page\n");
  if (pages < 1) return bad("The document has no page.");
  return {
    valid: true,
    pageCount: pages,
    objectCount: count.value - 1,
    size: bytes.length,
  };
}

const WIN_ANSI_REVERSE = new Map<number, number>(
  [...WIN_ANSI_EXTRA.entries()].map(([unicode, byte]) => [byte, unicode]),
);

function fromWinAnsi(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    out += String.fromCodePoint(WIN_ANSI_REVERSE.get(code) ?? code);
  }
  return out;
}

/** Text of the `(...) Tj` operators in file order, decoded from WinAnsi. Reads the files this writer produces. */
export function extractPdfText(bytes: Uint8Array): string[] {
  const text = toLatin1(bytes);
  const found: string[] = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "(") {
      index += 1;
      continue;
    }
    let value = "";
    let cursor = index + 1;
    let closed = false;
    while (cursor < text.length) {
      const char = text[cursor] as string;
      if (char === "\\") {
        const next = text[cursor + 1] as string;
        if (next >= "0" && next <= "7") {
          const code = Number.parseInt(text.slice(cursor + 1, cursor + 4), 8);
          value += String.fromCharCode(code);
          cursor += 4;
        } else {
          value += next;
          cursor += 2;
        }
      } else if (char === ")") {
        closed = true;
        break;
      } else {
        value += char;
        cursor += 1;
      }
    }
    if (!closed) break;
    const after = text.slice(cursor + 1, cursor + 5).trimStart();
    if (after.startsWith("Tj")) found.push(fromWinAnsi(value));
    index = cursor + 1;
  }
  return found;
}
