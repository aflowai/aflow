import type { ZodTypeAny } from 'zod';
import { z } from 'zod';
import { StagedChangeOpSchema } from './stagedChange.js';

// ============================================================================
// Public API
// ============================================================================

export interface StagedChangeOpFieldHint {
  /** Field key as written on the op object (e.g. `taskId`). */
  field: string;
  /** Whether the field is required. */
  required: boolean;
  /** Best-effort type hint (`string`, `number`, `boolean`, `array`, `object`). */
  type: string;
  /** When present on the schema (`z.string().describe(...)`). */
  description: string | undefined;
}

export interface StagedChangeOpContract {
  /** The `op` discriminator value (e.g. `'update_task_goal'`). */
  op: string;
  /** Sorted list of fields the schema accepts on this op. */
  fields: StagedChangeOpFieldHint[];
}

function getDiscriminatedUnionOptions(): ZodTypeAny[] {
  let node: unknown = StagedChangeOpSchema;
  // Unwrap ZodEffects → inner schema.
  for (let i = 0; i < 4; i++) {
    const def = (node as { _def?: { typeName?: string; schema?: unknown; options?: ZodTypeAny[] } })
      ._def;
    if (!def) return [];
    if (def.typeName === 'ZodEffects' && def.schema) {
      node = def.schema;
      continue;
    }
    if (Array.isArray(def.options)) return def.options;
    return [];
  }
  return [];
}

/**
 * Return the closed set of valid `op` discriminator values. Used by
 * drift tests that walk the Coach prompt for prohibited references.
 */
export function listStagedChangeOpKinds(): string[] {
  const out: string[] = [];
  for (const opt of getDiscriminatedUnionOptions()) {
    // Each option is `z.object({ op: z.literal(...), … }).strict()`.
    const shape = (opt as unknown as { shape: Record<string, ZodTypeAny> }).shape;
    const opField = shape['op'] as unknown as { value?: string } | undefined;
    if (opField?.value && typeof opField.value === 'string') {
      out.push(opField.value);
    }
  }
  return out.sort();
}

/**
 * Return the field contract for every op kind in the discriminated union.
 * Each entry lists the fields the schema accepts plus required-ness.
 */
export function describeStagedChangeOpKinds(): StagedChangeOpContract[] {
  const contracts: StagedChangeOpContract[] = [];
  for (const opt of getDiscriminatedUnionOptions()) {
    const shape = (opt as unknown as { shape: Record<string, ZodTypeAny> }).shape;
    const opField = shape['op'] as unknown as { value?: string } | undefined;
    if (!opField?.value || typeof opField.value !== 'string') continue;

    const fields: StagedChangeOpFieldHint[] = [];
    for (const [field, zodType] of Object.entries(shape)) {
      if (field === 'op') continue;
      fields.push({
        field,
        required: !zodType.isOptional(),
        type: describeZodType(zodType),
        description: extractDescription(zodType),
      });
    }
    fields.sort((a, b) => a.field.localeCompare(b.field));
    contracts.push({ op: opField.value, fields });
  }
  return contracts.sort((a, b) => a.op.localeCompare(b.op));
}

/**
 * Produce a human-readable prompt section for the supplied op kinds.
 * Output shape:
 *
 *   ### update_task_goal
 *   - taskId (string, required)
 *   - newGoal (string, required)
 *
 * Pass `opKinds` to limit the section (e.g. only emit hints for the kinds
 * the Coach is allowed to author). Empty `opKinds` returns hints for
 * every op in the union.
 */
export function renderStagedChangeOpHints(opKinds?: readonly string[]): string {
  const allowed = opKinds ? new Set(opKinds) : null;
  const contracts = describeStagedChangeOpKinds().filter(
    (c) => allowed === null || allowed.has(c.op),
  );
  return contracts
    .map((c) => {
      const lines = [`### ${c.op}`];
      for (const f of c.fields) {
        const required = f.required ? 'required' : 'optional';
        lines.push(`- ${f.field} (${f.type}, ${required})`);
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

// ============================================================================
// Internal helpers
// ============================================================================

function describeZodType(t: ZodTypeAny): string {
  // Unwrap ZodOptional / ZodDefault / ZodNullable.
  let current: ZodTypeAny = t;
  // Guard against missing internals on imported zod variants.
  const def = (current as unknown as { _def?: { typeName?: string } })._def;
  const typeName = def?.typeName;
  if (typeName === 'ZodOptional' || typeName === 'ZodDefault' || typeName === 'ZodNullable') {
    const inner = (current as unknown as { unwrap?: () => ZodTypeAny }).unwrap?.();
    if (inner) current = inner;
  }
  if (current instanceof z.ZodString) return 'string';
  if (current instanceof z.ZodNumber) return 'number';
  if (current instanceof z.ZodBoolean) return 'boolean';
  if (current instanceof z.ZodArray) return 'array';
  if (current instanceof z.ZodObject) return 'object';
  if (current instanceof z.ZodEnum) {
    const opts = (current as unknown as { options?: readonly string[] }).options;
    return opts ? `enum(${opts.join('|')})` : 'enum';
  }
  if (current instanceof z.ZodLiteral) {
    const v = (current as unknown as { value?: unknown }).value;
    return `literal(${String(v)})`;
  }
  if (current instanceof z.ZodUnion || current instanceof z.ZodDiscriminatedUnion) return 'union';
  if (current instanceof z.ZodRecord) return 'record';
  return 'unknown';
}

function extractDescription(t: ZodTypeAny): string | undefined {
  const def = (t as unknown as { _def?: { description?: string } })._def;
  return def?.description;
}
