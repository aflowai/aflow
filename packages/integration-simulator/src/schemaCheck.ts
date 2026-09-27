/**
 * The one compiler the simulator holds every value to.
 *
 * A seeded row, a rule transition's write, a generated entity and a generated
 * response body are all checked against the schema they claim, and a single
 * entry point is what keeps "valid" from meaning four different things. Lenient
 * by construction (`strict: false`), because the schemas come from imported
 * API definitions and collection declarations rather than from this repo.
 *
 * Each schema gets its OWN Ajv, cached by content. A shared instance registers
 * every schema by `$id`, and importers routinely stamp one per component name —
 * so two tenants importing an API that both call a schema `Customer` collide,
 * and Ajv refuses the second for the life of the process. That fails in the
 * silent direction: a legitimate value is rejected because of a definition
 * imported into a space this one cannot see.
 */
import AjvModule from 'ajv';

export interface CompiledSchema {
  (data: unknown): boolean;
  errors?: Array<{ instancePath?: string; message?: string }> | null;
}

interface AjvInstance {
  compile(schema: Record<string, unknown>): CompiledSchema;
}
type AjvConstructor = new (opts: { allErrors?: boolean; strict?: boolean }) => AjvInstance;
const mod = AjvModule as unknown as { default?: AjvConstructor };
const Ajv: AjvConstructor = mod.default ?? (AjvModule as unknown as AjvConstructor);

/**
 * Compilation is the expensive part and schemas repeat across calls, so results
 * are cached by content. Bounded because the key space is every schema every
 * tenant has imported; the oldest entry goes rather than letting a long-lived
 * worker hold all of them.
 */
const COMPILED_SCHEMA_CACHE_LIMIT = 512;
const compiled = new Map<string, SchemaCompilation>();

export type SchemaCompilation =
  { ok: true; validate: CompiledSchema } | { ok: false; detail: string };

export function compileSchema(schema: unknown): SchemaCompilation {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return { ok: false, detail: 'not a JSON Schema object' };
  }

  let key: string;
  try {
    key = JSON.stringify(schema);
  } catch {
    key = '';
  }
  if (key !== '') {
    const hit = compiled.get(key);
    if (hit !== undefined) return hit;
  }

  let result: SchemaCompilation;
  try {
    const ajv: AjvInstance = new Ajv({ allErrors: true, strict: false });
    result = { ok: true, validate: ajv.compile(schema as Record<string, unknown>) };
  } catch (err) {
    result = { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }

  if (key !== '') {
    if (compiled.size >= COMPILED_SCHEMA_CACHE_LIMIT) {
      const oldest = compiled.keys().next();
      if (!oldest.done) compiled.delete(oldest.value);
    }
    compiled.set(key, result);
  }
  return result;
}

/** The first few failures, joined — enough to fix the value, short enough to log. */
export function describeSchemaErrors(validator: CompiledSchema): string {
  return (validator.errors ?? [])
    .slice(0, 5)
    .map((error) => `${error.instancePath ?? ''} ${error.message ?? 'is invalid'}`.trim())
    .join('; ');
}

/** Empty when the value satisfies the schema. An uncompilable schema is itself a violation. */
export function schemaViolations(schema: unknown, value: unknown): string[] {
  const compiled = compileSchema(schema);
  if (!compiled.ok) return [`schema does not compile: ${compiled.detail}`];
  if (compiled.validate(value)) return [];
  const described = describeSchemaErrors(compiled.validate);
  return [described.length > 0 ? described : 'is invalid'];
}
