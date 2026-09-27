/**
 * Utilities for converting Zod schemas to JSON Schema.
 * Provides deterministic, stable JSON Schema generation.
 */
import { type z } from 'zod';
import { zodToJsonSchema as _zodToJsonSchema } from 'zod-to-json-schema';

// ============================================================================
// JSON Schema Types
// ============================================================================

/**
 * JSON Schema type definition (subset for our needs).
 */
export interface JsonSchema {
  $schema?: string;
  $id?: string;
  $ref?: string;
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
  enum?: unknown[];
  const?: unknown;
  allOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  not?: JsonSchema;
  if?: JsonSchema;
  then?: JsonSchema;
  else?: JsonSchema;
  format?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  default?: unknown;
  examples?: unknown[];
  deprecated?: boolean;
  definitions?: Record<string, JsonSchema>;
  $defs?: Record<string, JsonSchema>;
}

/**
 * Options for JSON Schema generation.
 */
export interface ToJsonSchemaOptions {
  /** Schema $id URI */
  $id?: string;
  /** Schema title */
  title?: string;
  /** JSON Schema draft version */
  draft?: 'draft-07' | 'draft-2019-09' | 'draft-2020-12';
  /** Include definitions/references */
  definitions?: boolean;
}

// ============================================================================
// Zod to JSON Schema Conversion
// ============================================================================

/**
 * Convert a Zod schema to JSON Schema.
 * Uses zod-to-json-schema under the hood for accurate conversion.
 *
 * Note: This is a placeholder that will use the zod-to-json-schema library.
 * The actual implementation requires the library to be installed.
 */
export function toJsonSchema(
  schema: z.ZodType,
  options: ToJsonSchemaOptions = {},
): Promise<JsonSchema> {
  const jsonSchema = _zodToJsonSchema(schema, {
    name: options.title,
    $refStrategy: options.definitions ? 'root' : 'none',
  }) as JsonSchema;

  // Add schema metadata (mutate only if value is defined)
  if (options.$id !== undefined) {
    (jsonSchema as { $id: string }).$id = options.$id;
  }

  if (options.draft !== undefined) {
    const draftUrls = {
      'draft-07': 'http://json-schema.org/draft-07/schema#',
      'draft-2019-09': 'https://json-schema.org/draft/2019-09/schema',
      'draft-2020-12': 'https://json-schema.org/draft/2020-12/schema',
    } as const;
    (jsonSchema as { $schema: string }).$schema = draftUrls[options.draft];
  }

  return Promise.resolve(jsonSchema);
}

/**
 * Converted schemas, keyed by the Zod schema object then by the options that
 * shaped the conversion.
 *
 * Weak on the schema so a caller's throwaway Zod object stays collectable; the
 * registry's are module singletons and live for the process either way.
 */
const conversionCache = new WeakMap<z.ZodType, Map<string, JsonSchema>>();

/** The options that change the output, flattened to a key. */
function conversionKey(options: ToJsonSchemaOptions): string {
  return JSON.stringify([options.$id, options.title, options.draft, options.definitions]);
}

/**
 * Synchronous version of toJsonSchema for simple cases.
 * Requires zod-to-json-schema to be pre-loaded.
 *
 * Walking a Zod schema is the expensive half and its result never changes, so
 * it happens once per (schema, options). **Callers get a copy, never the cached
 * object**: `buildCoreToolSpec` deletes the internal fields out of what it is
 * handed, and catalog search reads the same properties, so sharing one instance
 * would let the first caller's pruning decide what the second one sees.
 */
export function toJsonSchemaSync(schema: z.ZodType, options: ToJsonSchemaOptions = {}): JsonSchema {
  const key = conversionKey(options);
  const cached = conversionCache.get(schema)?.get(key);
  if (cached !== undefined) return structuredClone(cached);

  const zodOptions: { name?: string; $refStrategy: 'root' | 'none' } = {
    $refStrategy: options.definitions ? 'root' : 'none',
  };
  if (options.title !== undefined) {
    zodOptions.name = options.title;
  }

  const jsonSchema = _zodToJsonSchema(schema, zodOptions) as JsonSchema;

  if (options.$id !== undefined) {
    (jsonSchema as { $id: string }).$id = options.$id;
  }

  if (options.draft !== undefined) {
    const draftUrls = {
      'draft-07': 'http://json-schema.org/draft-07/schema#',
      'draft-2019-09': 'https://json-schema.org/draft/2019-09/schema',
      'draft-2020-12': 'https://json-schema.org/draft/2020-12/schema',
    } as const;
    (jsonSchema as { $schema: string }).$schema = draftUrls[options.draft];
  }

  let byOptions = conversionCache.get(schema);
  if (byOptions === undefined) {
    byOptions = new Map();
    conversionCache.set(schema, byOptions);
  }
  byOptions.set(key, jsonSchema);

  return structuredClone(jsonSchema);
}

// ============================================================================
// Deterministic Serialization
// ============================================================================

/**
 * Serialize JSON Schema to a deterministic string.
 * Keys are sorted alphabetically for consistent output.
 */
export function serializeJsonSchema(schema: JsonSchema): string {
  return JSON.stringify(schema, sortedReplacer, 2);
}

/**
 * JSON replacer that sorts object keys for deterministic output.
 */
function sortedReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const k of keys) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}
