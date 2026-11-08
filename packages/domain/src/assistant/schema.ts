import { isDigitChar } from "./text.js";

/**
 * A small JSON Schema validator for the keywords this project's contracts use:
 * type, enum, const, required, properties, additionalProperties, items,
 * minItems, maxItems, minLength, maxLength, minimum, maximum, oneOf, $ref,
 * and format (date, time, date-time, uri). It exists so the backend validates
 * planner output, tool arguments, and responses with no extra dependency and no
 * regular expressions. Unknown keywords are ignored.
 */

export type JsonSchema = Record<string, unknown>;

export interface SchemaValidationOptions {
  /** Resolves a `$ref` such as `./source.schema.json` to its schema. */
  resolveRef?: (ref: string) => JsonSchema | undefined;
  maxErrors?: number;
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return (
        value !== null && typeof value === "object" && !Array.isArray(value)
      );
    default:
      return false;
  }
}

function digitsAt(text: string, start: number, count: number): boolean {
  if (start + count > text.length) return false;
  for (let index = start; index < start + count; index += 1) {
    if (!isDigitChar(text[index])) return false;
  }
  return true;
}

export function isIsoDate(value: string): boolean {
  if (value.length !== 10) return false;
  if (
    !digitsAt(value, 0, 4) ||
    value[4] !== "-" ||
    !digitsAt(value, 5, 2) ||
    value[7] !== "-" ||
    !digitsAt(value, 8, 2)
  ) {
    return false;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function isClockTime(value: string): boolean {
  if (value.length !== 5) return false;
  if (!digitsAt(value, 0, 2) || value[2] !== ":" || !digitsAt(value, 3, 2)) {
    return false;
  }
  return Number(value.slice(0, 2)) <= 23 && Number(value.slice(3, 5)) <= 59;
}

function hasOffset(value: string): boolean {
  if (value.endsWith("Z") || value.endsWith("z")) return true;
  const tail = value.slice(-6);
  return (
    tail.length === 6 &&
    (tail[0] === "+" || tail[0] === "-") &&
    digitsAt(tail, 1, 2) &&
    tail[3] === ":" &&
    digitsAt(tail, 4, 2)
  );
}

export function isIsoDateTime(value: string): boolean {
  if (value.length < 20 || value[10] !== "T") return false;
  if (!isIsoDate(value.slice(0, 10))) return false;
  if (!hasOffset(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

function matchesFormat(format: string, value: string): boolean {
  switch (format) {
    case "date":
      return isIsoDate(value);
    case "time":
      return isClockTime(value);
    case "date-time":
      return isIsoDateTime(value);
    case "uri":
      try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
      } catch {
        return false;
      }
    default:
      return true;
  }
}

function validateNode(
  schema: JsonSchema,
  value: unknown,
  path: string,
  errors: string[],
  options: SchemaValidationOptions,
  depth: number,
): void {
  if (errors.length >= (options.maxErrors ?? 20) || depth > 32) return;
  const add = (message: string): void => {
    if (errors.length < (options.maxErrors ?? 20)) {
      errors.push(`${path || "$"}: ${message}`);
    }
  };

  const ref = schema.$ref;
  if (typeof ref === "string") {
    const target = options.resolveRef?.(ref);
    if (!target) {
      add(`unresolved schema reference ${ref}`);
      return;
    }
    validateNode(target, value, path, errors, options, depth + 1);
    return;
  }

  const oneOf = schema.oneOf;
  if (Array.isArray(oneOf)) {
    let matched = 0;
    for (const option of oneOf) {
      const branch: string[] = [];
      validateNode(
        option as JsonSchema,
        value,
        path,
        branch,
        { ...options, maxErrors: 5 },
        depth + 1,
      );
      if (branch.length === 0) matched += 1;
    }
    if (matched !== 1) add(`must match exactly one allowed shape`);
    return;
  }

  if ("const" in schema && schema.const !== value) {
    add(`must equal ${JSON.stringify(schema.const)}`);
    return;
  }
  const allowed = schema.enum;
  if (Array.isArray(allowed) && !allowed.includes(value)) {
    add(
      `must be one of ${allowed.map((item) => JSON.stringify(item)).join(", ")}`,
    );
    return;
  }

  const declared = schema.type;
  if (declared !== undefined) {
    const types = Array.isArray(declared) ? declared : [declared];
    if (!types.some((type) => matchesType(String(type), value))) {
      add(`must be ${types.join(" or ")}, got ${typeName(value)}`);
      return;
    }
  }

  if (typeof value === "string") {
    if (
      typeof schema.minLength === "number" &&
      value.length < schema.minLength
    ) {
      add(`must contain at least ${schema.minLength} characters`);
    }
    if (
      typeof schema.maxLength === "number" &&
      value.length > schema.maxLength
    ) {
      add(`must contain at most ${schema.maxLength} characters`);
    }
    if (
      typeof schema.format === "string" &&
      !matchesFormat(schema.format, value)
    ) {
      add(`must be a valid ${schema.format}`);
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      add(`must be at least ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      add(`must be at most ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      add(`must contain at least ${schema.minItems} items`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      add(`must contain at most ${schema.maxItems} items`);
    }
    const items = schema.items;
    if (items && typeof items === "object") {
      value.forEach((item, index) =>
        validateNode(
          items as JsonSchema,
          item,
          `${path}[${index}]`,
          errors,
          options,
          depth + 1,
        ),
      );
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const name of required) {
      if (!(String(name) in record) || record[String(name)] === undefined) {
        add(`is missing required property ${String(name)}`);
      }
    }
    for (const [name, entry] of Object.entries(record)) {
      const propertySchema = properties[name];
      if (propertySchema) {
        validateNode(
          propertySchema,
          entry,
          path ? `${path}.${name}` : name,
          errors,
          options,
          depth + 1,
        );
      } else if (schema.additionalProperties === false) {
        add(`has unknown property ${name}`);
      }
    }
  }
}

/** Returns a list of readable violations; an empty list means the value is valid. */
export function validateSchema(
  schema: JsonSchema,
  value: unknown,
  options: SchemaValidationOptions = {},
): string[] {
  const errors: string[] = [];
  validateNode(schema, value, "", errors, options, 0);
  return errors;
}
