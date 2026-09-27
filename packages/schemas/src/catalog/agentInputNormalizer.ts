interface JsonSchemaProperty {
  type?: string | string[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  enum?: unknown[];
  anyOf?: JsonSchemaProperty[];
  oneOf?: JsonSchemaProperty[];
}

interface JsonSchemaObject {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

/**
 * Normalize agent-provided input against a JSON Schema.
 * Only normalizes top-level fields. Returns a shallow clone — does not mutate.
 *
 * Coercions applied:
 * - Boolean fields: "true" → true, "false" → false (exact string match only)
 * - Number/integer fields: parseable numeric string → number
 * - Array fields: non-array value → [value] (single-element wrap)
 */
export function normalizeAgentInput(
  input: Record<string, unknown>,
  schema: JsonSchemaObject,
): Record<string, unknown> {
  const props = schema.properties;
  if (!props) return input;

  const result = { ...input };

  for (const [key, value] of Object.entries(result)) {
    const prop = props[key];
    if (!prop || value === undefined || value === null) continue;

    const propType = resolveType(prop);

    if (propType === 'boolean' && typeof value === 'string') {
      if (value === 'true') result[key] = true;
      else if (value === 'false') result[key] = false;
      // Any other string stays as-is — Zod will reject it with a clear error
    } else if ((propType === 'number' || propType === 'integer') && typeof value === 'string') {
      const parsed = Number(value);
      if (!Number.isNaN(parsed) && value.trim() !== '') {
        result[key] = parsed;
      }
    } else if (propType === 'array' && !Array.isArray(value)) {
      result[key] = [value];
    }
  }

  return result;
}

/** Resolve the effective type from a JSON Schema property, handling anyOf/oneOf. */
function resolveType(prop: JsonSchemaProperty): string | undefined {
  if (typeof prop.type === 'string') return prop.type;
  if (Array.isArray(prop.type)) {
    // e.g., ["string", "null"] — return the non-null type
    const nonNull = prop.type.filter((t) => t !== 'null');
    return nonNull.length === 1 ? nonNull[0] : undefined;
  }
  // Check anyOf/oneOf for simple type unions
  const union = prop.anyOf ?? prop.oneOf;
  if (union) {
    const types = union
      .map((s) => (typeof s.type === 'string' ? s.type : undefined))
      .filter((t): t is string => t !== undefined && t !== 'null');
    return types.length === 1 ? types[0] : undefined;
  }
  return undefined;
}
