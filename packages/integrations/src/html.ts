import { parse } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";
import { collapseWhitespace } from "./text.js";

/**
 * HTML is read with parse5, a parser that follows the HTML standard. No
 * regular expressions are used, so malformed or unusual markup is handled the
 * way a browser handles it.
 */

type ParsedNode = DefaultTreeAdapterMap["node"];
type ParsedElement = DefaultTreeAdapterMap["element"];

function isElement(node: ParsedNode): node is ParsedElement {
  return "tagName" in node && "childNodes" in node;
}

function isText(node: ParsedNode): node is DefaultTreeAdapterMap["textNode"] {
  return node.nodeName === "#text";
}

const SKIPPED_ELEMENTS = new Set([
  "script",
  "style",
  "noscript",
  "svg",
  "template",
  "head",
]);

const BLOCK_ELEMENTS = new Set([
  "br",
  "p",
  "div",
  "li",
  "tr",
  "td",
  "th",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "section",
  "article",
  "table",
  "ul",
  "ol",
  "header",
  "footer",
  "nav",
]);

type WalkItem = ParsedNode | { literal: string };

function isLiteral(item: WalkItem): item is { literal: string } {
  return "literal" in item;
}

/**
 * Visible text of a page. Block elements start new lines, inline elements are
 * separated by a space, and script, style, and similar elements are dropped.
 */
export function htmlToText(
  html: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  const document = parse(html);
  let raw = "";
  // An explicit stack keeps very deep markup from overflowing the call stack.
  const stack: WalkItem[] = [document];
  while (stack.length > 0) {
    const item = stack.pop() as WalkItem;
    if (isLiteral(item)) {
      raw += item.literal;
      continue;
    }
    if (isText(item)) {
      raw += item.value;
      continue;
    }
    if (!("childNodes" in item)) continue;
    if (isElement(item)) {
      if (SKIPPED_ELEMENTS.has(item.tagName)) {
        raw += " ";
        continue;
      }
      const edge = BLOCK_ELEMENTS.has(item.tagName) ? "\n" : " ";
      stack.push({ literal: edge });
      for (let index = item.childNodes.length - 1; index >= 0; index -= 1) {
        stack.push(item.childNodes[index] as ParsedNode);
      }
      stack.push({ literal: edge });
      continue;
    }
    for (let index = item.childNodes.length - 1; index >= 0; index -= 1) {
      stack.push(item.childNodes[index] as ParsedNode);
    }
  }
  const lines = raw
    .split("\n")
    .map((line) => collapseWhitespace(line))
    .filter((line) => line.length > 0);
  const text = lines.join("\n");
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

/** Raw text of every `<script type="application/ld+json">` block, in document order. */
export function extractJsonLdScripts(html: string): string[] {
  const document = parse(html);
  const scripts: string[] = [];
  const stack: ParsedNode[] = [document];
  while (stack.length > 0) {
    const node = stack.pop() as ParsedNode;
    if (isElement(node)) {
      if (node.tagName === "script") {
        const type = node.attrs.find((attr) => attr.name === "type")?.value;
        if (type?.trim().toLowerCase() === "application/ld+json") {
          scripts.push(
            node.childNodes
              .filter(isText)
              .map((child) => child.value)
              .join(""),
          );
        }
        continue;
      }
    }
    if ("childNodes" in node) {
      for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
        stack.push(node.childNodes[index] as ParsedNode);
      }
    }
  }
  return scripts;
}
