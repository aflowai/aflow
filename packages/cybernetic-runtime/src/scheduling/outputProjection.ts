import type { WorkflowTaskOutputProjection } from '@aflow/schemas';
import { readOutputPath } from './outputPath.js';

/** One unresolvable projection field (onMissing: 'error'). */
export interface ProjectionFieldFailure {
  /** The projected output field name. */
  field: string;
  /** The source that failed: the `path` (with `select` appended) or `fromInput:<name>`. */
  source: string;
  /** Operator-readable description of the failing pipeline step. */
  reason: string;
}

export type ProjectTaskOutputResult =
  { ok: true; value: Record<string, unknown> } | { ok: false; failures: ProjectionFieldFailure[] };

/** Sentinel for "this pipeline step could not resolve". */
const MISSING = Symbol('outputProjection.missing');
type PipelineValue = { value: unknown } | { missing: string };

function resolvePathField(
  rawOutput: unknown,
  spec: {
    path: string;
    parse?: Array<'json' | 'number'> | undefined;
    select?: string | undefined;
  },
): PipelineValue {
  const parse = spec.parse ?? [];
  let cursor: unknown = readOutputPath(rawOutput, spec.path);
  if (cursor === undefined) {
    return { missing: `path "${spec.path}" did not resolve on the raw op output` };
  }

  if (parse.includes('json')) {
    if (typeof cursor !== 'string') {
      return {
        missing: `parse 'json' expects a string at "${spec.path}", got ${describeType(cursor)}`,
      };
    }
    try {
      cursor = JSON.parse(cursor) as unknown;
    } catch {
      return { missing: `value at "${spec.path}" is not valid JSON` };
    }
  }

  if (spec.select !== undefined) {
    cursor = readOutputPath(cursor, spec.select);
    if (cursor === undefined) {
      return {
        missing: `select "${spec.select}" did not resolve on the parsed value of "${spec.path}"`,
      };
    }
  }

  if (parse.includes('number')) {
    if (typeof cursor === 'number') {
      if (!Number.isFinite(cursor)) {
        return { missing: `value at "${describeSource(spec)}" is not a finite number` };
      }
      return { value: cursor };
    }
    if (typeof cursor !== 'string') {
      return {
        missing: `parse 'number' expects a numeric string at "${describeSource(spec)}", got ${describeType(cursor)}`,
      };
    }
    const trimmed = cursor.trim();
    const num = trimmed.length > 0 ? Number(trimmed) : Number.NaN;
    if (!Number.isFinite(num)) {
      return {
        missing: `value "${trimmed.slice(0, 64)}" at "${describeSource(spec)}" is not numeric`,
      };
    }
    return { value: num };
  }

  return { value: cursor };
}

function describeSource(spec: { path: string; select?: string | undefined }): string {
  return spec.select !== undefined ? `${spec.path} → ${spec.select}` : spec.path;
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Apply a task's `outputProjection` to the RAW op output. `resolvedInput`
 * is the task's resolved operation input (the payload at the task row's
 * `inputRef` — `{ ...task.inputs, ...resolvedBindings }`), consulted by
 * `fromInput` echo fields; pass `null` when unavailable (echo fields then
 * fail loud — there is no silent fallback for a declared echo).
 */
export function projectTaskOutput(
  projection: WorkflowTaskOutputProjection,
  rawOutput: unknown,
  resolvedInput: Record<string, unknown> | null,
): ProjectTaskOutputResult {
  const value: Record<string, unknown> = {};
  const failures: ProjectionFieldFailure[] = [];

  for (const [field, spec] of Object.entries(projection)) {
    if ('fromInput' in spec) {
      const echoed =
        resolvedInput !== null &&
        Object.prototype.hasOwnProperty.call(resolvedInput, spec.fromInput)
          ? resolvedInput[spec.fromInput]
          : MISSING;
      if (echoed === MISSING || echoed === undefined) {
        failures.push({
          field,
          source: `fromInput:${spec.fromInput}`,
          reason:
            resolvedInput === null
              ? `fromInput "${spec.fromInput}" cannot be echoed — the task's resolved input is unavailable`
              : `fromInput "${spec.fromInput}" did not resolve on the task's input (binding absent at dispatch)`,
        });
      } else {
        value[field] = echoed;
      }
      continue;
    }

    const resolved = resolvePathField(rawOutput, spec);
    if ('missing' in resolved) {
      if (spec.onMissing === 'null') {
        value[field] = null;
      } else {
        failures.push({ field, source: describeSource(spec), reason: resolved.missing });
      }
      continue;
    }
    value[field] = resolved.value;
  }

  if (failures.length > 0) return { ok: false, failures };
  return { ok: true, value };
}
