/**
 * JSON Schema helpers for native function calling (Gemini FC parameters).
 */

// ============================================================================
// Schema Helpers
// ============================================================================

/**
 * Ensure a JSON Schema has `type: "object"` (required by Anthropic and others).
 * Strips `$schema` meta-keyword but preserves all standard JSON Schema keywords
 * like `additionalProperties`.
 */
export function ensureObjectType(schema: Record<string, unknown>): Record<string, unknown> {
  const result = { ...schema };
  if (!result['type']) {
    result['type'] = 'object';
  }
  delete result['$schema'];
  return result;
}

// ============================================================================
// Schema Sanitization for Gemini Function Calling
// ============================================================================

/**
 * Unsupported JSON Schema keywords for Gemini function calling.
 * Includes the standard set from the shared sanitizer (google.ts)
 * PLUS `additionalProperties` which is unsupported in FC parameters.
 */
const UNSUPPORTED_FC_KEYWORDS = new Set([
  '$ref',
  '$defs',
  '$schema',
  '$id',
  'definitions',
  '$comment',
  'additionalProperties',
]);

/**
 * Sanitize a JSON Schema for Gemini function calling.
 *
 * Strips keywords unsupported by Gemini (same set as the shared sanitizer
 * in google.ts) PLUS `additionalProperties` (which the shared sanitizer
 * does not strip, to avoid affecting generateJson structured output).
 * Normalizes `oneOf` → `anyOf` (Gemini FC supports `anyOf`, not `oneOf`).
 *
 * Self-contained — does NOT import from google.ts to keep blast radius narrow.
 */
export function sanitizeSchemaForGeminiFunctionCalling(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  function sanitize(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (UNSUPPORTED_FC_KEYWORDS.has(key)) continue;

      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        result[key] = sanitize(value as Record<string, unknown>);
      } else if (Array.isArray(value)) {
        result[key] = (value as unknown[]).map((item) =>
          item !== null && typeof item === 'object' && !Array.isArray(item)
            ? sanitize(item as Record<string, unknown>)
            : item,
        );
      } else {
        result[key] = value;
      }
    }

    // Gemini function calling supports `anyOf` but not `oneOf` — normalize so a
    // disjoint/discriminated union still constrains the model. Branches are
    // already sanitized above; merge into any existing `anyOf` defensively.
    if (Array.isArray(result['oneOf'])) {
      const existing = Array.isArray(result['anyOf']) ? (result['anyOf'] as unknown[]) : [];
      result['anyOf'] = [...existing, ...(result['oneOf'] as unknown[])];
      delete result['oneOf'];
    }

    // Convert array-valued `type` (e.g. ["string", "null"]) → anyOf or single type
    if (Array.isArray(result['type'])) {
      const types = result['type'] as string[];
      if (types.length === 1) {
        result['type'] = types[0];
      } else {
        const { type: _removed, ...rest } = result;
        const anyOf = types.map((t) => ({ type: t }));
        return { anyOf, ...rest };
      }
    }

    return result;
  }

  return sanitize(schema);
}
