/**
 * Path matching for the API router. A template is a list of segments:
 *  - `literal`          must match exactly;
 *  - `:name`            captures one non-empty segment (URL-decoded);
 *  - `:name(a|b|c)`     captures one segment that must be one of the options.
 * No regular expressions are involved.
 */

export type RouteParams = Record<string, string>;

interface ParamSegment {
  kind: "param";
  name: string;
  options: string[] | null;
}

type TemplateSegment = { kind: "literal"; value: string } | ParamSegment;

const compiled = new Map<string, TemplateSegment[]>();

function compileSegment(segment: string): TemplateSegment {
  if (!segment.startsWith(":")) return { kind: "literal", value: segment };
  const open = segment.indexOf("(");
  if (open < 0) {
    return { kind: "param", name: segment.slice(1), options: null };
  }
  if (!segment.endsWith(")")) {
    throw new Error(`Invalid route template segment: ${segment}`);
  }
  return {
    kind: "param",
    name: segment.slice(1, open),
    options: segment.slice(open + 1, -1).split("|"),
  };
}

function compile(template: string): TemplateSegment[] {
  const cached = compiled.get(template);
  if (cached) return cached;
  const segments = template.split("/").slice(1).map(compileSegment);
  compiled.set(template, segments);
  return segments;
}

/** Returns the captured parameters, or null when the path does not match. */
export function matchPath(
  pathname: string,
  template: string,
): RouteParams | null {
  if (!pathname.startsWith("/")) return null;
  const parts = pathname.split("/").slice(1);
  const segments = compile(template);
  if (parts.length !== segments.length) return null;
  const params: RouteParams = {};
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] as TemplateSegment;
    const part = parts[index] as string;
    if (segment.kind === "literal") {
      if (part !== segment.value) return null;
      continue;
    }
    if (part.length === 0) return null;
    let decoded: string;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (segment.options && !segment.options.includes(part)) return null;
    params[segment.name] = decoded;
  }
  return params;
}
