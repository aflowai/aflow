import AjvModule from 'ajv';
import { parseOutputPath } from '@aflow/cybernetic-runtime';
import type { Workflow } from '@aflow/schemas';

// Handle CJS/ESM interop (same pattern as runnerOutput.ts).
interface AjvErrorObject {
  instancePath?: string;
  schemaPath?: string;
  message?: string;
  keyword?: string;
  params?: Record<string, unknown>;
}
export type { AjvErrorObject };

interface AjvValidateFunction {
  (data: unknown): boolean;
  errors?: AjvErrorObject[] | null;
  schema?: unknown;
}
interface AjvInstance {
  compile(schema: Record<string, unknown>): AjvValidateFunction;
}
type AjvConstructor = new (opts: { allErrors?: boolean; strict?: boolean }) => AjvInstance;
const mod = AjvModule as unknown as { default?: AjvConstructor };
const Ajv: AjvConstructor = mod.default ?? (AjvModule as unknown as AjvConstructor);
const ajv: AjvInstance = new Ajv({ allErrors: true, strict: false });

/**
 * Try to compile a JSON Schema. Returns `null` on success, or the Ajv error
 * message when the schema itself is malformed (not the data — the schema).
 * Used to reject an un-compilable schema at author time instead of letting
 * it throw at the agent-turn tool-arg validator (AiHandler `validateToolArgs`).
 */
export function compileSchemaError(schema: Record<string, unknown>): string | null {
  try {
    ajv.compile(schema);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// ============================================================================
// JSON Pointer + schema-path resolution
// ============================================================================

function resolveJsonPointer(data: unknown, pointer: string): unknown {
  if (!pointer || pointer === '/') return data;
  let cursor: unknown = data;
  const segments = pointer
    .split('/')
    .slice(1)
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  for (const seg of segments) {
    if (cursor === null || cursor === undefined) return undefined;
    if (Array.isArray(cursor)) {
      const i = Number(seg);
      if (!Number.isInteger(i) || i < 0 || i >= cursor.length) return undefined;
      cursor = cursor[i];
    } else if (typeof cursor === 'object') {
      cursor = (cursor as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cursor;
}

function resolveSchemaPath(schema: unknown, schemaPath: string): unknown {
  if (!schemaPath || schemaPath === '#' || schemaPath === '#/') return schema;
  const ref = schemaPath.startsWith('#/') ? schemaPath.slice(2) : schemaPath;
  let cursor: unknown = schema;
  for (const raw of ref.split('/')) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') return undefined;
    const seg = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}

function readBranchDiscriminator(branch: unknown): { field: string; value: unknown } | null {
  if (!branch || typeof branch !== 'object') return null;
  const props = (branch as Record<string, unknown>)['properties'];
  if (!props || typeof props !== 'object') return null;
  for (const [field, sub] of Object.entries(props as Record<string, unknown>)) {
    if (!sub || typeof sub !== 'object') continue;
    const subRec = sub as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(subRec, 'const')) {
      return { field, value: subRec['const'] };
    }
    const en = subRec['enum'];
    if (Array.isArray(en) && en.length === 1) {
      return { field, value: en[0] };
    }
  }
  return null;
}

function instanceDepthBelowAnyOf(suffix: string): number {
  if (!suffix) return 0;
  const segs = suffix.split('/');
  let depth = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s === 'properties' && i + 1 < segs.length) {
      depth++;
      i++;
    } else if (s === 'items') {
      depth++;
    }
  }
  return depth;
}

function dropTrailingPathSegments(instancePath: string, n: number): string {
  if (n <= 0 || !instancePath) return instancePath;
  const segs = instancePath.split('/');
  if (segs.length - 1 <= n) return '';
  return segs.slice(0, segs.length - n).join('/');
}

/**
 * Filter Ajv errors so anyOf branches that obviously don't apply are
 * dropped. With `allErrors: true`, Zod discriminated unions produce noisy
 * errors from every branch even when only one branch's discriminator
 * matches the data — runners can't tell which complaint applies and drift
 * into hallucinating an entirely different schema.
 *
 * For each error whose `schemaPath` traverses an `anyOf/N` segment, we
 * pull the branch sub-schema, read its discriminator field+value, and
 * look up the corresponding value in the user's data at the parent
 * `instancePath`. If a sibling branch's discriminator matches the data
 * exactly, errors from non-matching branches are dropped.
 */
export function filterAnyOfBranchErrors(
  errors: AjvErrorObject[],
  rootSchema: unknown,
  data: unknown,
): AjvErrorObject[] {
  interface Group {
    decisionInstancePath: string;
    parentSchemaPath: string;
    branchErrors: Map<number, AjvErrorObject[]>;
    rootErrors: AjvErrorObject[];
  }
  const groups = new Map<string, Group>();
  const ungrouped: AjvErrorObject[] = [];

  for (const err of errors) {
    const sp = err.schemaPath ?? '';
    const ip = err.instancePath ?? '';
    const m = /^(.*?)\/anyOf\/(\d+)(?:\/(.*))?$/.exec(sp);
    if (!m) {
      ungrouped.push(err);
      continue;
    }
    const parentSchemaPath = m[1] ?? '';
    const branchIdx = Number(m[2]);
    const branchSuffix = m[3] ?? '';
    const decisionInstancePath = dropTrailingPathSegments(
      ip,
      instanceDepthBelowAnyOf(branchSuffix),
    );
    const key = `${decisionInstancePath}::${parentSchemaPath}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        decisionInstancePath,
        parentSchemaPath,
        branchErrors: new Map(),
        rootErrors: [],
      };
      groups.set(key, group);
    }
    const list = group.branchErrors.get(branchIdx) ?? [];
    list.push(err);
    group.branchErrors.set(branchIdx, list);
  }

  const trulyUngrouped: AjvErrorObject[] = [];
  for (const err of ungrouped) {
    if (err.keyword !== 'anyOf') {
      trulyUngrouped.push(err);
      continue;
    }
    const parentSchemaPath = err.schemaPath?.replace(/\/anyOf$/, '') ?? '';
    const ip = err.instancePath ?? '';
    const key = `${ip}::${parentSchemaPath}`;
    const group = groups.get(key);
    if (group) {
      group.rootErrors.push(err);
    } else {
      trulyUngrouped.push(err);
    }
  }

  const out: AjvErrorObject[] = [...trulyUngrouped];

  for (const group of groups.values()) {
    const parentSchema = resolveSchemaPath(rootSchema, group.parentSchemaPath);
    const dataAtPath = resolveJsonPointer(data, group.decisionInstancePath);
    const branches: unknown[] = Array.isArray(
      (parentSchema as Record<string, unknown> | undefined)?.['anyOf'],
    )
      ? ((parentSchema as Record<string, unknown>)['anyOf'] as unknown[])
      : [];

    let chosen: number | null = null;
    if (
      branches.length > 0 &&
      dataAtPath !== undefined &&
      typeof dataAtPath === 'object' &&
      dataAtPath !== null &&
      !Array.isArray(dataAtPath)
    ) {
      const dataObj = dataAtPath as Record<string, unknown>;
      for (let i = 0; i < branches.length; i++) {
        const disc = readBranchDiscriminator(branches[i]);
        if (!disc) continue;
        if (dataObj[disc.field] === disc.value) {
          if (chosen !== null) {
            chosen = null;
            break;
          }
          chosen = i;
        }
      }
    }

    if (chosen !== null) {
      const kept = group.branchErrors.get(chosen) ?? [];
      out.push(...kept);
    } else {
      for (const list of group.branchErrors.values()) out.push(...list);
      out.push(...group.rootErrors);
    }
  }

  return out;
}

// ============================================================================
// Error formatting
// ============================================================================

function ajvParamsFieldToString(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value);
}

/**
 * Format a single Ajv error for the runner. Surfaces `additionalProperty`
 * and `missingProperty` from `params` because Ajv's default message for
 * `additionalProperties` is "must NOT have additional properties" — with
 * no field name, the runner has no idea which extra field to remove.
 */
export function formatAjvError(err: AjvErrorObject): string {
  const path = err.instancePath || '/';
  if (err.keyword === 'required') {
    const field = ajvParamsFieldToString(err.params?.['missingProperty'], '<unknown>');
    return `${path}: missing required field "${field}"`;
  }
  if (err.keyword === 'additionalProperties') {
    const field = ajvParamsFieldToString(err.params?.['additionalProperty'], '<unknown>');
    return `${path}: extra field "${field}" is not allowed by the schema`;
  }
  if (err.keyword === 'const') {
    const allowed = err.params?.['allowedValue'];
    return `${path}: must equal ${JSON.stringify(allowed)}`;
  }
  if (err.keyword === 'enum') {
    const allowed = err.params?.['allowedValues'];
    return `${path}: must be one of ${JSON.stringify(allowed)}`;
  }
  return `${path}: ${err.message ?? 'validation failed'}`;
}

// ============================================================================
// Top-level validate
// ============================================================================

export type AgentOutputValidationResult =
  | { ok: true }
  | {
      ok: false;
      /** Filtered Ajv errors (post-discriminator filter), capped at `maxErrors`. */
      errors: AjvErrorObject[];
      /** Pre-formatted lines suitable for direct inclusion in a tool-result error. */
      formatted: string[];
      /** Human-readable summary of the actual payload shape (keys list / type). */
      actualDesc: string;
      /** Raw filtered errors before slicing — used by tests / consumer annotation. */
      rawErrors: AjvErrorObject[];
    };

/**
 * Compile-and-validate. Returns either `ok: true` (payload conforms) or
 * `ok: false` with filtered, formatted errors. Schema compilation failures
 * are surfaced as a distinct error so callers can route them to a
 * configuration-error code rather than a validation-failure code.
 *
 * Throws on Ajv compile failure (bad schema). The caller should catch and
 * surface as a configuration error, not a validation error.
 */
export function validateAgentOutput(
  output: unknown,
  schema: Record<string, unknown>,
  opts: { maxErrors?: number } = {},
): AgentOutputValidationResult {
  const maxErrors = opts.maxErrors ?? 10;
  const validate = ajv.compile(schema);
  const valid = validate(output);
  if (valid) return { ok: true };

  const rawErrors = validate.errors ?? [];
  const filtered = filterAnyOfBranchErrors(rawErrors, schema, output);
  const formatted = filtered.map(formatAjvError);
  const actualDesc =
    typeof output === 'object' && output !== null
      ? `Actual fields: [${Object.keys(output as Record<string, unknown>).join(', ')}]`
      : `Actual type: ${typeof output}`;
  return {
    ok: false,
    errors: filtered.slice(0, maxErrors),
    formatted: formatted.slice(0, maxErrors),
    actualDesc,
    rawErrors: filtered,
  };
}

// ============================================================================
// Consumer-aware diagnostic annotation
// ============================================================================

/**
 * For each Ajv error, find tasks in `workflow.tasks` whose `inputBindings`
 * include `{ kind: 'task_output', taskId: <producerTaskId>, path: <prefix-of-error-path> }`
 * and append "(consumed by: <task>.<bindAs>)" to the formatted line.
 *
 * A binding's `path` matches an error's `instancePath` when:
 *  - the binding has no `path` (whole-output) — always matches; OR
 *  - the binding's dot-path is a prefix of the error's slash-path, with
 *    segment boundaries respected (so binding `foo` matches `/foo` and
 *    `/foo/bar` but NOT `/foobar`).
 *
 * Returns the formatted error lines, suffixed where consumers were found.
 * When zero consumers match a given error, the line is unchanged — no
 * fabrication.
 */
export function annotateWithConsumers(
  errors: AjvErrorObject[],
  workflow: Workflow,
  producerTaskId: string,
): string[] {
  return errors.map((err) => {
    const base = formatAjvError(err);
    const instancePath = err.instancePath ?? '';
    const consumers = findConsumersForPath(workflow, producerTaskId, instancePath, err);
    if (consumers.length === 0) return base;
    return `${base} (consumed by: ${consumers.join(', ')})`;
  });
}

function findConsumersForPath(
  workflow: Workflow,
  producerTaskId: string,
  errorInstancePath: string,
  err: AjvErrorObject,
): string[] {
  // For "required" errors the missing field name is in params, not the
  // instancePath — synthesize the effective path so a binding declared on
  // the missing field is still matched.
  const effectivePath = computeEffectiveErrorPath(errorInstancePath, err);

  const out: string[] = [];
  for (const consumer of workflow.tasks) {
    const bindings = consumer.inputBindings;
    if (!bindings) continue;
    for (const [bindAs, binding] of Object.entries(bindings)) {
      if (binding.kind !== 'task_output') continue;
      if (binding.taskId !== producerTaskId) continue;
      const bindingPath = typeof binding.path === 'string' ? binding.path.trim() : '';
      if (!bindingPathMatchesErrorPath(bindingPath, effectivePath)) continue;
      out.push(`${consumer.taskId}.${bindAs}`);
    }
  }
  return out;
}

function computeEffectiveErrorPath(instancePath: string, err: AjvErrorObject): string {
  if (err.keyword === 'required') {
    const missing = err.params?.['missingProperty'];
    if (typeof missing === 'string' && missing.length > 0) {
      return instancePath ? `${instancePath}/${missing}` : `/${missing}`;
    }
  }
  return instancePath;
}

function bindingPathMatchesErrorPath(bindingPath: string, errorPath: string): boolean {
  if (!bindingPath) return true; // whole-output binding — always reads the failing field
  const segments = parseOutputPath(bindingPath);
  if (!segments) return false; // a malformed path reads nothing
  const norm = `/${segments.map((s) => (s.kind === 'key' ? s.key : String(s.index))).join('/')}`;
  if (!errorPath) return false;
  if (errorPath === norm) return true;
  return errorPath.startsWith(`${norm}/`);
}
