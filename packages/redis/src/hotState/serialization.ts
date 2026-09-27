import { z } from 'zod';
import { SessionHotStateSchema, StepHotStateSchema } from './schemas.js';
// ============================================================================
// Serialization Helpers
// ============================================================================

/**
 * Serialize an object for Redis hash storage.
 * Converts all values to strings, handling nested objects as JSON.
 */
export function serializeForHash(obj: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;

    if (value === null) {
      result[key] = 'null';
    } else if (typeof value === 'object') {
      result[key] = JSON.stringify(value);
    } else if (typeof value === 'boolean') {
      result[key] = value ? 'true' : 'false';
    } else {
      result[key] = String(value as string | number | bigint | symbol | null | undefined);
    }
  }

  return result;
}

/**
 * Like `serializeForHash`, but treats `undefined` values as an explicit
 * intent to clear the hash field (Redis has no "set to nothing" — you
 * have to HDEL). Returns two buckets:
 *
 *   - `toSet`: fields to write via `HSET`
 *   - `toDelete`: field names to remove via `HDEL`
 *
 * Use this for partial-update flows (`updateSessionState`, `updateStepState`)
 * where callers expect `{ field: undefined }` to remove stale state. Without
 * this, an update like `{ delegationPauseSource: undefined }` silently
 * preserves the old value in Redis, which caused subtle bugs where a parent
 * session's pause metadata leaked across delegation cycles and blocked
 * legitimate child-pause bubbling (guards reading stale `child_running`).
 *
 * `null` still means "write the string 'null'" (preserves existing semantics
 * for callers that distinguish null from undefined). If you want to delete,
 * pass `undefined`.
 */
export function serializeForHashWithDeletes(obj: Record<string, unknown>): {
  toSet: Record<string, string>;
  toDelete: string[];
} {
  const toSet: Record<string, string> = {};
  const toDelete: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) {
      toDelete.push(key);
      continue;
    }

    if (value === null) {
      toSet[key] = 'null';
    } else if (typeof value === 'object') {
      toSet[key] = JSON.stringify(value);
    } else if (typeof value === 'boolean') {
      toSet[key] = value ? 'true' : 'false';
    } else {
      toSet[key] = String(value as string | number | bigint | symbol | null | undefined);
    }
  }

  return { toSet, toDelete };
}

/**
 * Serialize an object for Redis stream fields.
 * Returns flat array of [key, value, key, value, ...]
 */
export function serializeForStream(obj: Record<string, unknown>): string[] {
  const result: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;

    if (value === null) {
      result.push(key, 'null');
    } else if (typeof value === 'object') {
      result.push(key, JSON.stringify(value));
    } else if (typeof value === 'boolean') {
      result.push(key, value ? 'true' : 'false');
    } else {
      result.push(key, String(value as string | number | bigint | symbol | null | undefined));
    }
  }

  return result;
}

/**
 * Derive the set of field names whose Zod type is `z.string()` (or
 * `z.string().optional()`, `z.string().uuid()`, `z.enum(...)`, etc.)
 * from a `z.object()` schema.
 *
 * These fields MUST be kept as raw strings during Redis hash deserialization.
 * Without this, `deserializeFromHash` would JSON.parse values that happen to
 * start with `{` or `[`, turning a JSON-serialized string field into an object
 * and failing the subsequent Zod validation.
 *
 * **Rule**: Never maintain a manual STRING_FIELDS list alongside a Zod schema.
 * Derive it. Adding a `z.string()` field to the schema automatically includes
 * it here — no second step to forget.
 */
function deriveStringFields(schema: z.ZodObject<z.ZodRawShape>): Set<string> {
  const fields = new Set<string>();
  for (const [key, zodType] of Object.entries(schema.shape)) {
    let inner: z.ZodTypeAny = zodType;
    // Unwrap optional / default / nullable wrappers
    while (
      inner instanceof z.ZodOptional ||
      inner instanceof z.ZodDefault ||
      inner instanceof z.ZodNullable
    ) {
      inner =
        inner instanceof z.ZodOptional || inner instanceof z.ZodNullable
          ? (inner.unwrap() as z.ZodTypeAny)
          : (inner as z.ZodDefault<z.ZodTypeAny>).removeDefault();
    }
    if (
      inner instanceof z.ZodString ||
      inner instanceof z.ZodEnum ||
      inner instanceof z.ZodLiteral
    ) {
      fields.add(key);
    }
  }
  return fields;
}

/** String-typed fields from SessionHotState — auto-derived from the Zod schema. */
const RUN_STRING_FIELDS = deriveStringFields(SessionHotStateSchema);
/** String-typed fields from StepHotState — auto-derived from the Zod schema. */
const STEP_STRING_FIELDS = deriveStringFields(StepHotStateSchema);
/** Combined set for any hot-state hash deserialization. */
const STRING_FIELDS = new Set([...RUN_STRING_FIELDS, ...STEP_STRING_FIELDS]);

/**
 * Deserialize Redis hash data back to an object.
 * Attempts to parse JSON and convert types.
 */
export function deserializeFromHash(data: Record<string, string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    // Order matters here. Schema-typed string fields MUST be checked before
    // the `'true'`/`'false'` boolean-coercion branch — otherwise a
    // string-enum field whose values include the literal `'true'` (e.g.
    // `delegationWaitMode: z.enum(['true', 'until_pause', 'false'])`) gets
    // silently coerced to a boolean and breaks Zod parse on read,
    // quarantining the entire session as corrupt. This was the wedge in
    // the live bind-capability test on 2026-05-06.
    if (STRING_FIELDS.has(key)) {
      // Keep schema-typed string fields as raw strings, even when their
      // values look like booleans, numbers, or JSON. The schema's enum or
      // string check is authoritative.
      result[key] = value;
    } else if (value === 'null') {
      result[key] = null;
    } else if (value === 'true') {
      result[key] = true;
    } else if (value === 'false') {
      result[key] = false;
    } else if (/^-?\d+$/.test(value)) {
      result[key] = parseInt(value, 10);
    } else if (/^-?\d*\.\d+$/.test(value)) {
      result[key] = parseFloat(value);
    } else if (value.startsWith('{') || value.startsWith('[')) {
      try {
        result[key] = JSON.parse(value);
      } catch {
        result[key] = value;
      }
    } else {
      result[key] = value;
    }
  }

  return result;
}
