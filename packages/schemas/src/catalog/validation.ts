import { type ZodError, type ZodIssue } from 'zod';
import { getOperation } from './registry.js';

// ============================================================================
// Types
// ============================================================================

export interface StepInputValidationError {
  path: Array<string | number>;
  message: string;
  code: string;
  /** Expected type/value (for type errors). */
  expected?: string;
  /** Received type/value (for type errors). */
  received?: string;
}

export interface UnresolvedRefError {
  path: Array<string | number>;
  expression: string;
  message: string;
}

export interface StepInputValidationResult {
  valid: boolean;
  /** Structured field-level errors if invalid. */
  errors?: StepInputValidationError[];
  /** Unresolved reference errors (checked before Zod). */
  unresolvedRefs?: UnresolvedRefError[];
  /** The parsed (possibly transformed) input if valid — uses Zod parseResult.data. */
  parsed?: unknown;
  /** Error type classification. */
  errorType?: 'INPUT_VALIDATION_ERROR' | 'UNRESOLVED_INPUT_REFERENCE';
}

// ============================================================================
// Unresolved reference detection
// ============================================================================

/**
 * The roots a `${…}` reference can start with. A resolver reads only these, so
 * a string that survives resolution with `${state.x}` inside is a reference
 * that failed, while `${count}` in a diff or a template literal never was one.
 */
export const REFERENCE_ROOTS = ['state', 'steps'] as const;
export type ReferenceRoot = (typeof REFERENCE_ROOTS)[number];

/** Source of the pattern every reference reader shares: `${<root>.…}`. */
export const REFERENCE_PATTERN_SOURCE = String.raw`\$\{((?:${REFERENCE_ROOTS.join('|')})\.[^}]+)\}`;

/** Matches a reference left in resolved input. */
const UNRESOLVED_REF_PATTERN = new RegExp(REFERENCE_PATTERN_SOURCE);

/**
 * Max depth for unresolved ref scanning.
 *
 * Only scan top-level input fields and one level of nesting for leftover
 * ${...} patterns. Deeper values are treated as opaque data — they may
 * contain ${...} patterns that are part of a data payload (e.g., an agent
 * definition passed to agent.manage.validate with config values like
 * "${state.prompt}").
 *
 * This matches the depth limit in resolveRefsRecursive (stateRefResolver.ts).
 */
const MAX_UNRESOLVED_REF_DEPTH = 3;

/**
 * Fields that contain opaque data (source code, file content, a diff, large
 * text) where a reference-shaped substring is the data itself. Keyed by field
 * name at any depth.
 */
const OPAQUE_FIELD_NAMES = new Set(['code', 'inlineText', 'inlineJson', 'patch']);

/**
 * Parents whose children are the caller's data by definition: file contents,
 * an environment, and the run inputs handed to a workflow, which were resolved
 * before they were handed over.
 */
const OPAQUE_PARENT_NAMES = new Set(['files', 'env', 'inputs']);

/**
 * Recursively scan resolved input for leftover `${...}` patterns.
 * These indicate references that failed to resolve — a distinct error class
 * from type mismatches.
 *
 * Only scans at shallow depths (top-level + one nesting level). Deep values
 * are treated as opaque data that may legitimately contain ${...} patterns.
 *
 * Skips opaque fields (code, file content) where ${...} is legitimate syntax.
 */
export function detectUnresolvedRefs(
  input: unknown,
  path: Array<string | number> = [],
  depth = 0,
): UnresolvedRefError[] {
  if (depth >= MAX_UNRESOLVED_REF_DEPTH) {
    return []; // Treat deeper values as opaque data
  }

  // Skip fields known to contain opaque data (source code, file content).
  // Also skip children of 'files' (Record<string, string> of file contents).
  const lastSegment = path[path.length - 1];
  if (typeof lastSegment === 'string' && OPAQUE_FIELD_NAMES.has(lastSegment)) {
    return [];
  }
  const parentSegment = path[path.length - 2];
  if (typeof parentSegment === 'string' && OPAQUE_PARENT_NAMES.has(parentSegment)) {
    return [];
  }

  const errors: UnresolvedRefError[] = [];

  if (typeof input === 'string' && UNRESOLVED_REF_PATTERN.test(input)) {
    errors.push({
      path,
      expression: input,
      message: `Unresolved reference: ${input}`,
    });
  } else if (Array.isArray(input)) {
    for (let i = 0; i < input.length; i++) {
      errors.push(...detectUnresolvedRefs(input[i], [...path, i], depth + 1));
    }
  } else if (typeof input === 'object' && input !== null) {
    for (const [key, value] of Object.entries(input)) {
      errors.push(...detectUnresolvedRefs(value, [...path, key], depth + 1));
    }
  }

  return errors;
}

// ============================================================================
// Zod error mapping
// ============================================================================

/**
 * A custom `.strict()` message replaces Zod's default — the only text that
 * names the offending keys. Re-attach them from the issue so the caller
 * always sees WHICH keys were rejected, not just the allowed list.
 */
export function zodIssueMessage(issue: ZodIssue): string {
  if (issue.code === 'unrecognized_keys') {
    const zodDefault = `Unrecognized key(s) in object: ${issue.keys.map((k) => `'${k}'`).join(', ')}`;
    const detail = issue.message === zodDefault ? '' : ` ${issue.message}`;
    const keys = issue.keys.map((k) => JSON.stringify(k)).join(', ');
    return `Unknown input key(s): ${keys}.${detail}`;
  }
  return issue.message;
}

/**
 * Map Zod issues to structured validation errors with path, code, and
 * expected/received information.
 */
export function mapZodErrors(error: ZodError): StepInputValidationError[] {
  return error.issues.map((issue: ZodIssue) => {
    const base: StepInputValidationError = {
      path: issue.path,
      message: zodIssueMessage(issue),
      code: issue.code,
    };
    if ('expected' in issue) {
      base.expected = String(issue.expected);
    }
    if ('received' in issue) {
      base.received = String(issue.received);
    }
    return base;
  });
}

// ============================================================================
// Schema-aware null normalization
// ============================================================================

type JsonSchemaObject = Record<string, unknown>;

function asSchemaRecord(schema: unknown): JsonSchemaObject | null {
  return typeof schema === 'object' && schema !== null && !Array.isArray(schema)
    ? (schema as JsonSchemaObject)
    : null;
}

function typedProperties(schema: JsonSchemaObject): JsonSchemaObject | null {
  const props = schema['properties'];
  return typeof props === 'object' && props !== null && !Array.isArray(props)
    ? (props as JsonSchemaObject)
    : null;
}

const COMBINATOR_KEYS = ['anyOf', 'oneOf', 'allOf'] as const;

/**
 * Collect every property-typed object schema an object value could be
 * validated against: the schema itself when it declares `properties`, plus
 * every branch reachable through anyOf/oneOf/allOf. Returns null when any
 * reachable branch accepts objects without constraining their properties
 * (`z.unknown()`, `z.record(...)`) — such a subtree is opaque data that must
 * not be modified.
 */
function collectObjectBranches(
  schema: unknown,
  out: JsonSchemaObject[],
): JsonSchemaObject[] | null {
  if (schema === false) return out;
  const s = asSchemaRecord(schema);
  if (!s) return null;
  let constrained = false;
  if (typedProperties(s)) {
    out.push(s);
    constrained = true;
  }
  for (const key of COMBINATOR_KEYS) {
    const branches = s[key];
    if (!Array.isArray(branches)) continue;
    constrained = true;
    for (const branch of branches) {
      if (collectObjectBranches(branch, out) === null) return null;
    }
  }
  if (constrained) return out;
  const type = s['type'];
  const excludesObjects =
    typeof type === 'string' ? type !== 'object' : Array.isArray(type) && !type.includes('object');
  return excludesObjects ? out : null;
}

function schemaAcceptsNull(schema: unknown): boolean {
  if (schema === false) return false;
  if (typeof schema !== 'object' || schema === null) return true;
  const s = schema as Record<string, unknown>;
  if (s['nullable'] === true) return true;
  const type = s['type'];
  if (typeof type === 'string') return type === 'null';
  if (Array.isArray(type)) return type.includes('null');
  if (Array.isArray(s['enum'])) return (s['enum'] as unknown[]).includes(null);
  if ('const' in s) return s['const'] === null;
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = s[key];
    if (Array.isArray(branches)) return branches.some(schemaAcceptsNull);
  }
  const allOf = s['allOf'];
  if (Array.isArray(allOf)) return allOf.every(schemaAcceptsNull);
  return true;
}

/**
 * Recursively remove `null` values the given input JSON Schema would reject,
 * mutating `obj` in place. LLMs frequently emit `null` for omitted optional
 * parameters, and Zod's `.optional()` accepts only `undefined` — those nulls
 * are dropped at the boundary. Nulls the schema accepts survive, and so does
 * every null inside a subtree the schema treats as opaque (`z.unknown()`,
 * `z.record(z.unknown())` — e.g. a submitted task result or an HTTP request
 * body): such data is governed by a downstream contract that may declare
 * required nullable fields, and stripping there corrupts data the operation
 * itself never constrains.
 *
 * Union/intersection-typed fields recurse across all object branches: a
 * nested null is dropped only when EVERY branch declaring the key rejects
 * null — a null one branch accepts is kept and left to Zod, erring toward
 * preserving data over silently rewriting it.
 */
export function stripNullsRejectedBySchema(obj: Record<string, unknown>, schema: unknown): void {
  const branches = collectObjectBranches(schema, []);
  if (branches === null || branches.length === 0) return;
  stripNullsAcrossBranches(obj, branches);
}

function stripNullsAcrossBranches(
  obj: Record<string, unknown>,
  branches: JsonSchemaObject[],
): void {
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    const propSchemas: unknown[] = [];
    for (const branch of branches) {
      const prop = typedProperties(branch)?.[key];
      if (prop !== undefined) propSchemas.push(prop);
    }
    if (value === null) {
      if (!propSchemas.some(schemaAcceptsNull)) delete obj[key];
    } else if (typeof value === 'object' && !Array.isArray(value) && propSchemas.length > 0) {
      const childBranches: JsonSchemaObject[] = [];
      let opaque = false;
      for (const prop of propSchemas) {
        if (collectObjectBranches(prop, childBranches) === null) {
          opaque = true;
          break;
        }
      }
      if (!opaque && childBranches.length > 0) {
        stripNullsAcrossBranches(value as Record<string, unknown>, childBranches);
      }
    }
  }
}

// ============================================================================
// Main validation function
// ============================================================================

/**
 * Validate resolved step input against the operation's inputZod schema.
 *
 * Two-phase:
 *   1. Scan for unresolved `${...}` references → UNRESOLVED_INPUT_REFERENCE
 *   2. Zod safeParse → INPUT_VALIDATION_ERROR
 *
 * On success, returns `parsed` with Zod's transformed output (parseResult.data).
 */
export function validateStepInput(
  operationId: string,
  resolvedInput: unknown,
): StepInputValidationResult {
  const op = getOperation(operationId);
  if (!op) {
    // Unknown operation — skip validation (will fail at dispatch anyway)
    return { valid: true, parsed: resolvedInput };
  }

  // Check skipInputValidation flag
  if (op.skipInputValidation) {
    return { valid: true, parsed: resolvedInput };
  }

  const schema = op.inputZod;

  // Phase 1: Detect unresolved references
  const unresolvedRefs = detectUnresolvedRefs(resolvedInput);
  if (unresolvedRefs.length > 0) {
    return {
      valid: false,
      unresolvedRefs,
      errorType: 'UNRESOLVED_INPUT_REFERENCE',
      errors: unresolvedRefs.map((ref) => ({
        path: ref.path,
        message: ref.message,
        code: 'unresolved_reference',
        expected: 'resolved value',
        received: ref.expression,
      })),
    };
  }

  // Phase 2: Zod safeParse — uses parseResult.data for transformed output
  const parseResult = schema.safeParse(resolvedInput);
  if (parseResult.success) {
    return { valid: true, parsed: parseResult.data };
  }

  return {
    valid: false,
    errors: mapZodErrors(parseResult.error),
    errorType: 'INPUT_VALIDATION_ERROR',
  };
}

// ============================================================================

/** JSON Schema type → compact display type */
function jsTypeLabel(prop: Record<string, unknown>): string {
  const t = prop['type'];
  if (t === 'array') {
    const items = prop['items'] as Record<string, unknown> | undefined;
    const inner = items ? jsTypeLabel(items) : 'unknown';
    return `${inner}[]`;
  }
  if (t === 'object') {
    const addl = prop['additionalProperties'] as Record<string, unknown> | undefined;
    if (addl) return `Record<string, ${jsTypeLabel(addl)}>`;
    return 'object';
  }
  if (Array.isArray(t)) return (t as string[]).join(' | ');
  if (t === 'string' && typeof prop['maxLength'] === 'number') {
    return `string ≤${String(prop['maxLength'])}`;
  }
  if (typeof t === 'string') return t;
  // Enum
  const en = prop['enum'] as unknown[] | undefined;
  if (en) return en.map((v) => JSON.stringify(v)).join(' | ');
  // anyOf / oneOf
  const anyOf = (prop['anyOf'] ?? prop['oneOf']) as Array<Record<string, unknown>> | undefined;
  if (anyOf) {
    // A discriminated union of objects renders its discriminator values —
    // "object | object | …" ×23 teaches an agent nothing (e.g.
    // learner.propose's ops union).
    const discriminated = discriminatorSummary(anyOf);
    if (discriminated) return discriminated;
    const labels = [...new Set(anyOf.map(jsTypeLabel))];
    return labels.join(' | ');
  }
  return 'unknown';
}

/**
 * If every union branch is an object sharing one property fixed to a distinct
 * literal (the zod discriminated-union shape), render that property's values:
 * `object<op: 'update_task_goal' | 'add_task' | …>`.
 */
function discriminatorSummary(branches: Array<Record<string, unknown>>): string | null {
  if (branches.length < 2) return null;
  const firstProps = branches[0]?.['properties'] as Record<string, unknown> | undefined;
  if (!firstProps) return null;
  for (const key of Object.keys(firstProps)) {
    const values: string[] = [];
    for (const b of branches) {
      const p = (b['properties'] as Record<string, Record<string, unknown>> | undefined)?.[key];
      const enumVal =
        Array.isArray(p?.['enum']) && (p['enum'] as unknown[]).length === 1
          ? (p['enum'] as unknown[])[0]
          : undefined;
      const c = p?.['const'] ?? enumVal;
      if (typeof c !== 'string') {
        values.length = 0;
        break;
      }
      values.push(c);
    }
    if (values.length === branches.length) {
      return `object<${key}: ${values.map((v) => `'${v}'`).join(' | ')}>`;
    }
  }
  return null;
}

export function compactShapeFromJsonSchema(schema: Record<string, unknown>): string {
  const props = schema['properties'] as Record<string, Record<string, unknown>> | undefined;
  if (!props) return '{}';

  const required = new Set(
    Array.isArray(schema['required']) ? (schema['required'] as string[]) : [],
  );

  const fields: string[] = [];
  for (const [key, prop] of Object.entries(props)) {
    const opt = required.has(key) ? '' : '?';
    const label = jsTypeLabel(prop);
    fields.push(`${key}${opt}: ${label}`);
  }

  const full = `{ ${fields.join(', ')} }`;
  if (full.length <= 300) return full;
  // Truncate — show first N fields that fit
  let result = '{ ';
  for (let i = 0; i < fields.length; i++) {
    const next = result + fields[i]! + (i < fields.length - 1 ? ', ' : '');
    if (next.length > 280) {
      result += '...';
      break;
    }
    result = next;
  }
  return result + ' }';
}

/**
 * Map Zod issues to a flat Record<fieldPath, errorMessage> for form display.
 * Useful for UI form validation in the flow editor.
 */
export function mapZodIssuesToFormErrors(issues: ZodIssue[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_root';
    // First error wins for each path
    if (!(key in errors)) {
      errors[key] = issue.message;
    }
  }
  return errors;
}
