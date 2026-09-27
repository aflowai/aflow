import { createHash } from 'node:crypto';
import { compileRestrictedPath, type RestrictedPathSegment } from '@aflow/lib';

// ============================================================================
// Types
// ============================================================================

/** A single derived-schema patch produced by evaluating one binding. */
export interface DerivedPatch {
  /** Stable identifier for the binding that produced this patch. */
  bindingId: string;
  /** Restricted JSONPath into the schema where the patch lands. */
  target: string;
  /** Kind discriminates the merge rule. */
  kind: 'enum' | 'const' | 'count';
  /**
   * Computed value:
   *   - kind=enum: array of distinct scalars (the new permitted values)
   *   - kind=const: single scalar (the required value)
   *   - kind=count: number (consumed by leaf-specific merge — `maximum`,
   *     `minimum`, `maxItems`, `minItems`)
   */
  value: number | string | boolean | Array<string | number | boolean> | null;
}

/** Errors raised by the merger. Each has a stable code suitable for log triage. */
export class DerivedSchemaMergeError extends Error {
  constructor(
    public readonly code:
      | 'DERIVED_SCHEMA_EMPTY_ENUM'
      | 'DERIVED_SCHEMA_CONFLICTING_CONST'
      | 'DERIVED_SCHEMA_MERGE_CONFLICT'
      | 'DERIVED_SCHEMA_UNSUPPORTED_TARGET'
      | 'DERIVED_SCHEMA_DUPLICATE_BINDING_ID',
    message: string,
    public readonly bindingId?: string,
  ) {
    super(message);
    this.name = 'DerivedSchemaMergeError';
  }
}

export interface MergeResult {
  /** The merged schema. Patches applied; static base preserved everywhere else. */
  effectiveSchema: Record<string, unknown>;
  /** SHA-256 hex of the deterministically serialized effective schema. */
  hash: string;
  /** Map from JSON Pointer-style schema path → bindingId that injected the leaf. */
  pathToBindingId: Record<string, string>;
}

// ============================================================================
// Schema keyword set (used for "logical mixed" target translation)
// ============================================================================

/**
 * JSON Schema keywords we expect at any non-leaf position in a target path.
 * If a path segment matches one of these, it's used as a schema keyword
 * directly. Otherwise the segment is treated as a property name (and the
 * walker auto-inserts a `properties` step before it).
 */
const SCHEMA_KEYWORDS = new Set<string>([
  'properties',
  'items',
  'propertyNames',
  'additionalProperties',
  'enum',
  'const',
  'required',
  'type',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'pattern',
  'default',
]);

/**
 * Leaf keywords where a patch is allowed to land. The merger maps each kind
 * to a default leaf and validates explicit overrides. A `value:` binding
 * (kind `const`) may also land on a numeric-bound leaf — the upstream scalar
 * becomes the bound instead of a required literal; the bound appliers reject
 * non-numeric values.
 */
const ALLOWED_LEAVES_FOR_KIND: Record<DerivedPatch['kind'], readonly string[]> = {
  enum: ['enum'],
  const: ['const', 'minimum', 'maximum', 'minItems', 'maxItems'],
  count: ['minimum', 'maximum', 'minItems', 'maxItems'],
};

// ============================================================================
// Merger
// ============================================================================

export function mergeDerivedPatches(
  baseSchema: Record<string, unknown>,
  patches: readonly DerivedPatch[],
): MergeResult {
  // Stable input ordering (§6.A.spec.6)
  const sorted = [...patches].sort((a, b) =>
    a.bindingId < b.bindingId ? -1 : a.bindingId > b.bindingId ? 1 : 0,
  );

  // Catch duplicate bindingIds early — they would otherwise produce
  // ambiguous sidecar entries.
  const seenIds = new Set<string>();
  for (const p of sorted) {
    if (seenIds.has(p.bindingId)) {
      throw new DerivedSchemaMergeError(
        'DERIVED_SCHEMA_DUPLICATE_BINDING_ID',
        `Duplicate bindingId "${p.bindingId}" — bindingIds must be unique within a task.`,
        p.bindingId,
      );
    }
    seenIds.add(p.bindingId);
  }

  // Deep clone the base — patches mutate as they merge.
  const effective = deepClone(baseSchema);
  const pathToBindingId: Record<string, string> = {};

  for (const patch of sorted) {
    const compiled = compileRestrictedPath(patch.target);
    const literalSegments = translateMixedSegmentsToLiteral(compiled.segments);
    const literalPath = literalSegments.map((s) => `/${s}`).join('');
    const leafKeyword = literalSegments[literalSegments.length - 1] ?? '';

    // Validate the leaf is allowed for this kind.
    if (!ALLOWED_LEAVES_FOR_KIND[patch.kind].includes(leafKeyword)) {
      throw new DerivedSchemaMergeError(
        'DERIVED_SCHEMA_UNSUPPORTED_TARGET',
        `Binding "${patch.bindingId}" of kind "${patch.kind}" cannot land at "${leafKeyword}". ` +
          `Allowed leaves: [${ALLOWED_LEAVES_FOR_KIND[patch.kind].join(', ')}].`,
        patch.bindingId,
      );
    }

    // Walk to the parent of the leaf, creating intermediate containers
    // (`properties` objects, `propertyNames`) as needed. The merger does NOT
    // change the type of an existing intermediate node — if the base schema
    // already has a non-object at a step, we fail with a merge conflict.
    const parent = walkOrCreateParent(effective, literalSegments.slice(0, -1), patch.bindingId);
    applyLeaf(parent, leafKeyword, patch);
    pathToBindingId[literalPath] = patch.bindingId;
  }

  const hash = hashSchema(effective);
  return { effectiveSchema: effective, hash, pathToBindingId };
}

// ============================================================================
// Path translation: "logical mixed" → literal schema segments
// ============================================================================

/**
 * Translate the author-friendly target dialect to literal JSON Schema path
 * segments. Plain field segments (anything not in SCHEMA_KEYWORDS) are
 * prefixed with `properties` and pushed in two steps:
 *
 *   $.evalSuite.taskCriteria.propertyNames.enum
 *     → ['properties', 'evalSuite', 'properties', 'taskCriteria', 'propertyNames', 'enum']
 *
 * Wildcard segments are not allowed in target paths. (Read-side wildcard
 * segments live on the upstream traversal only.)
 */
function translateMixedSegmentsToLiteral(segments: readonly RestrictedPathSegment[]): string[] {
  const out: string[] = [];
  for (const seg of segments) {
    if (seg.kind === 'wildcardArray') {
      throw new DerivedSchemaMergeError(
        'DERIVED_SCHEMA_UNSUPPORTED_TARGET',
        'Target paths cannot use "[*]" — wildcards are read-side only.',
      );
    }
    const name = seg.name;
    if (SCHEMA_KEYWORDS.has(name)) {
      out.push(name);
    } else {
      out.push('properties');
      out.push(name);
    }
  }
  return out;
}

// ============================================================================
// Walker
// ============================================================================

function walkOrCreateParent(
  root: Record<string, unknown>,
  segments: readonly string[],
  bindingId: string,
): Record<string, unknown> {
  let cursor: Record<string, unknown> = root;
  for (const seg of segments) {
    const existing = cursor[seg];
    if (existing === undefined) {
      const fresh: Record<string, unknown> = {};
      cursor[seg] = fresh;
      cursor = fresh;
      continue;
    }
    if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) {
      throw new DerivedSchemaMergeError(
        'DERIVED_SCHEMA_MERGE_CONFLICT',
        `Cannot walk into "${seg}" — base schema has a non-object at that path. ` +
          'Patches cannot reshape existing schema structure.',
        bindingId,
      );
    }
    cursor = existing as Record<string, unknown>;
  }
  return cursor;
}

// ============================================================================
// Leaf application
// ============================================================================

function applyLeaf(parent: Record<string, unknown>, keyword: string, patch: DerivedPatch): void {
  switch (keyword) {
    case 'enum':
      applyEnum(parent, patch);
      return;
    case 'const':
      applyConst(parent, patch);
      return;
    case 'minimum':
    case 'minLength':
    case 'minItems':
      applyLowerBound(parent, keyword, patch);
      return;
    case 'maximum':
    case 'maxLength':
    case 'maxItems':
      applyUpperBound(parent, keyword, patch);
      return;
    default:
      // SHOULD have been caught by ALLOWED_LEAVES_FOR_KIND, but keep this branch
      // explicit so a future kind addition fails fast in the right place.
      throw new DerivedSchemaMergeError(
        'DERIVED_SCHEMA_UNSUPPORTED_TARGET',
        `Unsupported leaf keyword "${keyword}".`,
        patch.bindingId,
      );
  }
}

function applyEnum(parent: Record<string, unknown>, patch: DerivedPatch): void {
  if (!Array.isArray(patch.value)) {
    throw new DerivedSchemaMergeError(
      'DERIVED_SCHEMA_MERGE_CONFLICT',
      `Binding "${patch.bindingId}" expected an array value for kind=enum.`,
      patch.bindingId,
    );
  }
  const newSet = new Set<string | number | boolean>(patch.value);
  const existing = parent['enum'];
  if (existing === undefined) {
    if (newSet.size === 0) {
      throw new DerivedSchemaMergeError(
        'DERIVED_SCHEMA_EMPTY_ENUM',
        `Binding "${patch.bindingId}" produced an empty enum and base schema has no enum to intersect with.`,
        patch.bindingId,
      );
    }
    parent['enum'] = sortScalarArray([...newSet]);
    return;
  }
  if (!Array.isArray(existing)) {
    throw new DerivedSchemaMergeError(
      'DERIVED_SCHEMA_MERGE_CONFLICT',
      `Binding "${patch.bindingId}" cannot intersect with non-array existing "enum" value.`,
      patch.bindingId,
    );
  }
  const intersection = (existing as unknown[]).filter(
    (x): x is string | number | boolean =>
      (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean') && newSet.has(x),
  );
  if (intersection.length === 0) {
    throw new DerivedSchemaMergeError(
      'DERIVED_SCHEMA_EMPTY_ENUM',
      `Binding "${patch.bindingId}" intersection with existing enum is empty — no values would be acceptable.`,
      patch.bindingId,
    );
  }
  parent['enum'] = sortScalarArray(intersection);
}

function applyConst(parent: Record<string, unknown>, patch: DerivedPatch): void {
  if (
    patch.value !== null &&
    typeof patch.value !== 'string' &&
    typeof patch.value !== 'number' &&
    typeof patch.value !== 'boolean'
  ) {
    throw new DerivedSchemaMergeError(
      'DERIVED_SCHEMA_MERGE_CONFLICT',
      `Binding "${patch.bindingId}" expected scalar value for kind=const, got ${typeof patch.value}.`,
      patch.bindingId,
    );
  }
  const existing = parent['const'];
  if (existing !== undefined && existing !== patch.value) {
    throw new DerivedSchemaMergeError(
      'DERIVED_SCHEMA_CONFLICTING_CONST',
      `Binding "${patch.bindingId}" const ${JSON.stringify(patch.value)} conflicts with existing const ${JSON.stringify(existing)}.`,
      patch.bindingId,
    );
  }
  parent['const'] = patch.value;
}

function applyLowerBound(
  parent: Record<string, unknown>,
  keyword: string,
  patch: DerivedPatch,
): void {
  if (typeof patch.value !== 'number' || !Number.isFinite(patch.value)) {
    throw new DerivedSchemaMergeError(
      'DERIVED_SCHEMA_MERGE_CONFLICT',
      `Binding "${patch.bindingId}" expected numeric value for kind=count → ${keyword}.`,
      patch.bindingId,
    );
  }
  const existing = parent[keyword];
  if (existing === undefined) {
    parent[keyword] = patch.value;
    return;
  }
  if (typeof existing !== 'number') {
    throw new DerivedSchemaMergeError(
      'DERIVED_SCHEMA_MERGE_CONFLICT',
      `Binding "${patch.bindingId}" cannot tighten non-numeric "${keyword}".`,
      patch.bindingId,
    );
  }
  // Lower bound tightens by taking the max
  parent[keyword] = Math.max(existing, patch.value);
}

function applyUpperBound(
  parent: Record<string, unknown>,
  keyword: string,
  patch: DerivedPatch,
): void {
  if (typeof patch.value !== 'number' || !Number.isFinite(patch.value)) {
    throw new DerivedSchemaMergeError(
      'DERIVED_SCHEMA_MERGE_CONFLICT',
      `Binding "${patch.bindingId}" expected numeric value for kind=count → ${keyword}.`,
      patch.bindingId,
    );
  }
  const existing = parent[keyword];
  if (existing === undefined) {
    parent[keyword] = patch.value;
    return;
  }
  if (typeof existing !== 'number') {
    throw new DerivedSchemaMergeError(
      'DERIVED_SCHEMA_MERGE_CONFLICT',
      `Binding "${patch.bindingId}" cannot tighten non-numeric "${keyword}".`,
      patch.bindingId,
    );
  }
  parent[keyword] = Math.min(existing, patch.value);
}

// ============================================================================
// Helpers
// ============================================================================

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sortScalarArray<T extends string | number | boolean>(arr: T[]): T[] {
  return [...arr].sort((a, b) => {
    const sa = String(a);
    const sb = String(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
}

function hashSchema(schema: Record<string, unknown>): string {
  // Deterministic serialization — sort keys recursively
  const json = JSON.stringify(schema, sortedReplacer, 0);
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const k of keys) sorted[k] = (value as Record<string, unknown>)[k];
    return sorted;
  }
  return value;
}
