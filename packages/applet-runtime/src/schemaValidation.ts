/**
 * Ajv-backed validation of data against declared applet schemas. Every schema
 * passes the safety bounds before compilation; compiled validators are cached
 * by a caller-supplied key (definitionHash + scope — definitions are immutable
 * once pinned, so the key is stable). Failure policy: an unsafe or
 * uncompilable schema throws AppletSchemaSafetyError — the command carrying it
 * is rejected as `invalid_schema`, never applied unvalidated.
 *
 * `validateFormats: false` — `format` is annotation-only, matching the
 * well-formedness-only stance (P3): the platform never asserts domain formats.
 */
import * as Ajv from 'ajv';
import type { ErrorObject } from 'ajv';
import { AppletSchemaSafetyError } from './errors.js';
import { assertAppletSchemaSafe } from './schemaSafety.js';

interface CompiledValidator {
  (data: unknown): boolean;
  errors?: ErrorObject[] | null;
}

const AjvCtor = (
  Ajv as unknown as {
    default: new (options: Record<string, unknown>) => {
      compile: (schema: Record<string, unknown>) => CompiledValidator;
    };
  }
).default;

const ajv = new AjvCtor({
  allErrors: true,
  strict: false,
  validateSchema: false,
  allowUnionTypes: true,
  validateFormats: false,
});

/** Bounded FIFO cache — definitions are immutable, so entries never go stale. */
const VALIDATOR_CACHE_MAX_ENTRIES = 256;
const validatorCache = new Map<string, CompiledValidator>();

export interface AppletSchemaValidationResult {
  valid: boolean;
  /** Human-readable structural failures — safe for the action-result message. */
  errors: string[];
}

export function validateAgainstAppletSchema(params: {
  schema: Record<string, unknown>;
  cacheKey: string;
  data: unknown;
}): AppletSchemaValidationResult {
  const validator = getValidator(params.schema, params.cacheKey);
  if (validator(params.data)) return { valid: true, errors: [] };
  const errors = (validator.errors ?? []).map(formatAjvError);
  return { valid: false, errors: errors.length > 0 ? errors : ['invalid'] };
}

function getValidator(schema: Record<string, unknown>, cacheKey: string): CompiledValidator {
  const cached = validatorCache.get(cacheKey);
  if (cached !== undefined) return cached;
  assertAppletSchemaSafe(schema);
  let compiled: CompiledValidator;
  try {
    compiled = ajv.compile(schema);
  } catch (err) {
    throw new AppletSchemaSafetyError(
      'schema_compile_failed',
      `Schema could not be compiled: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (validatorCache.size >= VALIDATOR_CACHE_MAX_ENTRIES) {
    const oldest = validatorCache.keys().next().value;
    if (oldest !== undefined) validatorCache.delete(oldest);
  }
  validatorCache.set(cacheKey, compiled);
  return compiled;
}

function formatAjvError(error: ErrorObject): string {
  const missingProperty =
    typeof error.params === 'object' &&
    error.params !== null &&
    'missingProperty' in error.params &&
    typeof error.params['missingProperty'] === 'string'
      ? error.params['missingProperty']
      : null;
  const path = error.instancePath || (missingProperty ? `/${missingProperty}` : '');
  const message = error.message ?? 'invalid';
  return path ? `${path}: ${message}` : message;
}
