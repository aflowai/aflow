/** Result of a coverage check. */
export interface JsonSchemaCoverResult {
  /** True iff supplied ⊆ target (every supplied-valid value is target-valid). */
  covered: boolean;
  /**
   * Human-readable reason the relation does not hold (present only when
   * `covered` is false and the gap is decidable). Path-qualified, e.g.
   * `items missing required field "kind"`.
   */
  gap?: string;
  /**
   * True when the *target* uses a construct we cannot model soundly
   * (`oneOf`, `not`, `if`/`then`, `dependentSchemas`). The field is not
   * rejected as incompatible — it is flagged for platform follow-up.
   * `covered` is false whenever this is set.
   */
  uncheckable?: boolean;
}

// A JSON Schema fragment, accessed structurally. We keep the input loose
// (`Record<string, unknown>`) because callers pass schemas derived from many
// sources (zod-to-json-schema output, hand-authored producer shapes, op
// outputZod slices) and we narrow per-keyword internally.
type Schema = Record<string, unknown>;

const COVERED: JsonSchemaCoverResult = { covered: true };

// ============================================================================
// Public entry point
// ============================================================================

/**
 * Decide whether `supplied ⊆ target`.
 *
 * @param supplied - the shape a producer/binding/literal actually yields.
 * @param target  - the consumer op's input-field schema the value must satisfy.
 */
export function jsonSchemaCovers(supplied: unknown, target: unknown): JsonSchemaCoverResult {
  if (!isSchemaObject(supplied) || !isSchemaObject(target)) {
    // A non-object schema fragment can't be reasoned about structurally.
    // Treat an absent/garbage supplied as not covering a present target,
    // and an absent target as accept-all (handled below for objects).
    if (!isSchemaObject(target)) return COVERED; // target accepts anything
    return { covered: false, gap: 'producer shape is not a usable JSON Schema' };
  }
  return covers(supplied, target, '');
}

// ============================================================================
// Core recursion
// ============================================================================

function covers(supplied: Schema, target: Schema, path: string): JsonSchemaCoverResult {
  // (0) Reflexivity fast-path — identical schemas trivially satisfy coverage.
  // This is the common case for op→op / whole-output bindings whose producer
  // shape is generated from the *same* Zod schema as the op input field, and
  // it short-circuits deep recursion (and any nested `oneOf`/`anyOf`) for them.
  if (deepEqual(supplied, target)) return COVERED;

  // (1) `target` accepts anything → covered (not a false negative).
  if (isAcceptAll(target)) return COVERED;

  // (1b) `$ref` on either side — we never resolve references (op schemas are
  // inlined via `$refStrategy: 'none'`, so this shouldn't arise), but an
  // unresolved `$ref` is opaque: it must NOT fall through to `COVERED`
  // (review). Flag it as uncheckable rather than silently accepting anything.
  if ('$ref' in target || '$ref' in supplied) {
    return uncheckable(path, '$ref (unresolved)');
  }

  // (2) `supplied` combinators — checked BEFORE target combinators so that
  // anyOf-vs-anyOf resolves correctly (every supplied branch must land inside
  // the union target).
  if (Array.isArray(supplied['anyOf'])) {
    // supplied = anyOf[S]: covered iff EVERY branch covers target (the
    // producer may emit any branch).
    const branches = supplied['anyOf'].filter(isSchemaObject);
    for (const branch of branches) {
      const r = covers(branch, target, path);
      if (!r.covered) return r;
    }
    return COVERED;
  }
  if (Array.isArray(supplied['allOf'])) {
    // supplied = allOf[S] (often base ∧ invariants): the value is narrower
    // than its base, so checking the base (allOf stripped) is sound — if the
    // base covers the target, the narrower allOf does too. Strip and recurse.
    const stripped: Schema = { ...supplied };
    delete stripped['allOf'];
    const r = covers(stripped, target, path);
    if (r.covered) return r;
    // Fall back: any single branch covering the target also suffices.
    for (const branch of supplied['allOf'].filter(isSchemaObject)) {
      if (covers(branch, target, path).covered) return COVERED;
    }
    return r;
  }

  // (3) `target` combinators.
  if (Array.isArray(target['allOf'])) {
    // covered iff supplied covers EVERY branch (and the target base, if any).
    const base: Schema = { ...target };
    delete base['allOf'];
    if (!isAcceptAll(base)) {
      const r = covers(supplied, base, path);
      if (!r.covered) return r;
    }
    for (const branch of target['allOf'].filter(isSchemaObject)) {
      const r = covers(supplied, branch, path);
      if (!r.covered) return r;
    }
    return COVERED;
  }
  if (Array.isArray(target['anyOf'])) {
    // covered iff supplied covers ≥1 branch (satisfying one branch satisfies
    // the union — sound).
    const branches = target['anyOf'].filter(isSchemaObject);
    for (const branch of branches) {
      if (covers(supplied, branch, path).covered) return COVERED;
    }
    return {
      covered: false,
      gap: `${prefix(path)}value does not satisfy any allowed variant`,
    };
  }
  if (Array.isArray(target['oneOf'])) {
    // exactly-one semantics — ≥1-branch coverage is unsound (a value matching
    // two branches fails oneOf). Cannot decide → uncheckable (§5.4).
    return uncheckable(path, 'oneOf (exactly-one)');
  }
  if (
    isSchemaObject(target['not']) ||
    isSchemaObject(target['if']) ||
    isSchemaObject(target['then'])
  ) {
    return uncheckable(path, 'not/if/then');
  }
  if (isSchemaObject(target['dependentSchemas'])) {
    return uncheckable(path, 'dependentSchemas');
  }

  // (4) `target` enum — supplied must pin to a subset.
  if (Array.isArray(target['enum'])) {
    const targetEnum = target['enum'];
    if ('const' in supplied) {
      if (targetEnum.some((v) => deepEqual(v, supplied['const']))) return COVERED;
      return { covered: false, gap: `${prefix(path)}const value not in required enum` };
    }
    if (Array.isArray(supplied['enum'])) {
      const ok = supplied['enum'].every((sv) => targetEnum.some((tv) => deepEqual(sv, tv)));
      if (ok) return COVERED;
      return { covered: false, gap: `${prefix(path)}enum is not a subset of the required enum` };
    }
    // A bare `{type:'string'}` (no const/enum) does NOT pin to the enum.
    return {
      covered: false,
      gap: `${prefix(path)}value not constrained to required enum [${formatEnum(targetEnum)}]`,
    };
  }

  // (5) `target` const — supplied must be the same const.
  if ('const' in target) {
    if ('const' in supplied && deepEqual(supplied['const'], target['const'])) return COVERED;
    if (
      Array.isArray(supplied['enum']) &&
      supplied['enum'].length === 1 &&
      deepEqual(supplied['enum'][0], target['const'])
    ) {
      return COVERED;
    }
    return { covered: false, gap: `${prefix(path)}value not pinned to required const` };
  }

  // (6) Structural coverage by target shape.
  const targetType = typeOf(target);

  if (isObjectShape(target)) {
    return coversObject(supplied, target, path);
  }
  if (isArrayShape(target)) {
    return coversArray(supplied, target, path);
  }

  // (7) Primitive target.
  if (targetType.length > 0) {
    if (!isSchemaTyped(supplied)) {
      return {
        covered: false,
        gap: `${prefix(path)}producer shape is untyped but ${describeType(targetType)} is required`,
      };
    }
    const suppliedType = typeOf(supplied);
    if (!typesCompatible(suppliedType, targetType)) {
      return {
        covered: false,
        gap: `${prefix(path)}expected ${describeType(targetType)}, got ${describeType(suppliedType)}`,
      };
    }
    // Format constraint (e.g. uuid) — supplied must declare the same format.
    const targetFormat = target['format'];
    if (typeof targetFormat === 'string') {
      if (supplied['format'] !== targetFormat) {
        return {
          covered: false,
          gap: `${prefix(path)}expected ${describeType(targetType)} with format "${targetFormat}"`,
        };
      }
    }
    // Scalar bounds (string length / number range / pattern) — a looser
    // supplied admits values the target rejects (review Finding 3).
    const boundsGap = scalarBoundsGap(supplied, target);
    if (boundsGap) return { covered: false, gap: `${prefix(path)}${boundsGap}` };
    return COVERED;
  }

  // (8) Target has no decidable constraints we recognize → accept (treated as
  // accept-all — already mostly handled by isAcceptAll, this is the residual).
  return COVERED;
}

// ============================================================================
// Object / array coverage
// ============================================================================

function coversObject(supplied: Schema, target: Schema, path: string): JsonSchemaCoverResult {
  // supplied must itself be an object shape (or untyped-but-with-properties).
  if (!isObjectShape(supplied) && isSchemaTyped(supplied) && !typeIncludes(supplied, 'object')) {
    return {
      covered: false,
      gap: `${prefix(path)}expected object, got ${describeType(typeOf(supplied))}`,
    };
  }
  if (!isObjectShape(supplied) && !isSchemaTyped(supplied)) {
    // Untyped supplied against a constrained object target → not covered.
    return {
      covered: false,
      gap: `${prefix(path)}producer shape is untyped but an object is required`,
    };
  }

  const targetRequired = stringArray(target['required']);
  const suppliedRequired = new Set(stringArray(supplied['required']));
  const suppliedProps = propsOf(supplied);
  const targetProps = propsOf(target);

  // Every required target field must be present-and-required in supplied.
  for (const r of targetRequired) {
    if (!suppliedRequired.has(r)) {
      return { covered: false, gap: `${prefix(path)}missing required field "${r}"` };
    }
    // When the target ALSO constrains the field's shape (declares `properties[r]`),
    // supplied must declare it too so the shape is checkable below — else supplied
    // could emit an any-shaped `r` the target rejects. A presence-only required
    // field (in `required` but not `properties`) needs no supplied property
    // schema; demanding one is a false negative (review).
    if (r in targetProps && !(r in suppliedProps)) {
      return { covered: false, gap: `${prefix(path)}required field "${r}" shape is undeclared` };
    }
  }

  // A property the target constrains but the supplied schema does NOT declare:
  // if supplied is OPEN (`additionalProperties` not false) it can emit an
  // any-shaped value for that key, which the target's `properties` constraint
  // rejects — so coverage fails (review). When supplied is closed
  // (`additionalProperties: false`, the zod-strip / assembler default) it can't
  // emit the key, so this does not fire. (Unknown-key strictness on the target
  // is deliberately NOT enforced — zod emits `additionalProperties:false` for
  // strip objects too, which strip rather than reject extras at runtime.)
  const suppliedClosed = supplied['additionalProperties'] === false;

  // Recurse into shared properties: where both declare a property, supplied's
  // must cover target's.
  for (const [key, targetChild] of Object.entries(targetProps)) {
    const suppliedChild = suppliedProps[key];
    if (suppliedChild === undefined) {
      if (!suppliedClosed && isSchemaObject(targetChild) && !isAcceptAll(targetChild)) {
        return {
          covered: false,
          gap: `${prefix(path)}field "${key}" is constrained by the operation but the open producer shape does not declare it`,
        };
      }
      continue; // closed supplied (or unconstrained target field) — safe
    }
    if (!isSchemaObject(targetChild) || !isSchemaObject(suppliedChild)) continue;
    const childPath = path ? `${path}.${key}` : key;
    const r = covers(suppliedChild, targetChild, childPath);
    if (!r.covered) return r;
  }

  return COVERED;
}

function coversArray(supplied: Schema, target: Schema, path: string): JsonSchemaCoverResult {
  if (!isArrayShape(supplied)) {
    if (!isSchemaTyped(supplied)) {
      return {
        covered: false,
        gap: `${prefix(path)}producer shape is untyped but an array is required`,
      };
    }
    if (!typeIncludes(supplied, 'array')) {
      return {
        covered: false,
        gap: `${prefix(path)}expected array, got ${describeType(typeOf(supplied))}`,
      };
    }
  }

  // Array cardinality / uniqueness bounds (review Finding 3) — checked before
  // items so a loose-items array with a `minItems` target is still rejected.
  const arrayBoundsGap = arrayBoundsGapOf(supplied, target);
  if (arrayBoundsGap) return { covered: false, gap: `${prefix(path)}${arrayBoundsGap}` };

  const targetItems = target['items'];
  if (!isSchemaObject(targetItems) || isAcceptAll(targetItems)) return COVERED;
  const suppliedItems = supplied['items'];
  if (!isSchemaObject(suppliedItems)) {
    return { covered: false, gap: `${prefix(path)}items shape is undeclared` };
  }
  const r = covers(suppliedItems, targetItems, '');
  if (!r.covered) {
    return {
      covered: false,
      gap: `${prefix(path)}items ${r.gap ?? 'are incompatible'}`,
      ...(r.uncheckable ? { uncheckable: true } : {}),
    };
  }
  return COVERED;
}

// ============================================================================
// Schema-shape helpers
// ============================================================================

function isSchemaObject(value: unknown): value is Schema {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function numOf(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/**
 * Scalar bound subset check (review Finding 3). Returns a gap string when the
 * supplied scalar shape can admit a value the target's bounds reject — i.e.
 * supplied is LOOSER on length / range / pattern. A missing supplied bound is
 * treated as the widest possible (0 / ±∞), so an unbounded supplied does not
 * cover a bounded target.
 */
function scalarBoundsGap(supplied: Schema, target: Schema): string | null {
  const tMinLen = numOf(target['minLength']);
  if (tMinLen !== undefined && (numOf(supplied['minLength']) ?? 0) < tMinLen) {
    return `value may be shorter than required minLength ${tMinLen}`;
  }
  const tMaxLen = numOf(target['maxLength']);
  if (tMaxLen !== undefined) {
    const sMaxLen = numOf(supplied['maxLength']);
    if (sMaxLen === undefined || sMaxLen > tMaxLen) {
      return `value may exceed required maxLength ${tMaxLen}`;
    }
  }
  // Numeric range — compare effective lower/upper bounds, honoring inclusive
  // vs exclusive (review): target `{exclusiveMinimum:0}` is NOT covered by
  // supplied `{minimum:0}` because supplied admits 0, which the target rejects.
  const lowerGap = lowerBoundGap(supplied, target);
  if (lowerGap) return lowerGap;
  const upperGap = upperBoundGap(supplied, target);
  if (upperGap) return upperGap;
  const tMul = numOf(target['multipleOf']);
  if (tMul !== undefined && tMul > 0) {
    const sMul = numOf(supplied['multipleOf']);
    if (sMul === undefined || !Number.isInteger(sMul / tMul)) {
      return `value not constrained to multipleOf ${tMul}`;
    }
  }
  // Regex subset is undecidable — require the same declared pattern (a missing
  // or different supplied pattern cannot be proven to cover the target's).
  const tPattern = target['pattern'];
  if (typeof tPattern === 'string' && supplied['pattern'] !== tPattern) {
    return `value not constrained to required pattern /${tPattern}/`;
  }
  return null;
}

interface NumericBound {
  v: number;
  /** True for an exclusive bound (`> v` / `< v`), false for inclusive (`>= v` / `<= v`). */
  excl: boolean;
}

function lowerBoundOf(s: Schema): NumericBound | null {
  const e = numOf(s['exclusiveMinimum']);
  if (e !== undefined) return { v: e, excl: true };
  const m = numOf(s['minimum']);
  if (m !== undefined) return { v: m, excl: false };
  return null;
}

function upperBoundOf(s: Schema): NumericBound | null {
  const e = numOf(s['exclusiveMaximum']);
  if (e !== undefined) return { v: e, excl: true };
  const m = numOf(s['maximum']);
  if (m !== undefined) return { v: m, excl: false };
  return null;
}

/**
 * Lower-bound coverage: supplied's lower bound must be at least as strict as
 * target's. At an equal value, an exclusive target (`> v`) is NOT covered by an
 * inclusive supplied (`>= v`) — supplied admits `v`, which the target rejects.
 */
function lowerBoundGap(supplied: Schema, target: Schema): string | null {
  const t = lowerBoundOf(target);
  if (!t) return null;
  const s = lowerBoundOf(supplied);
  if (!s || s.v < t.v || (s.v === t.v && t.excl && !s.excl)) {
    return `value may be below required ${t.excl ? 'exclusiveMinimum' : 'minimum'} ${t.v}`;
  }
  return null;
}

function upperBoundGap(supplied: Schema, target: Schema): string | null {
  const t = upperBoundOf(target);
  if (!t) return null;
  const s = upperBoundOf(supplied);
  if (!s || s.v > t.v || (s.v === t.v && t.excl && !s.excl)) {
    return `value may exceed required ${t.excl ? 'exclusiveMaximum' : 'maximum'} ${t.v}`;
  }
  return null;
}

/** Array cardinality / uniqueness subset check (review Finding 3). */
function arrayBoundsGapOf(supplied: Schema, target: Schema): string | null {
  const tMin = numOf(target['minItems']);
  if (tMin !== undefined && (numOf(supplied['minItems']) ?? 0) < tMin) {
    return `array may have fewer than required minItems ${tMin}`;
  }
  const tMax = numOf(target['maxItems']);
  if (tMax !== undefined) {
    const sMax = numOf(supplied['maxItems']);
    if (sMax === undefined || sMax > tMax) return `array may exceed required maxItems ${tMax}`;
  }
  if (target['uniqueItems'] === true && supplied['uniqueItems'] !== true) {
    return 'array items must be unique (uniqueItems)';
  }
  return null;
}

/** A schema that constrains nothing (accepts every value). */
function isAcceptAll(schema: Schema): boolean {
  const constraining = [
    'type',
    'enum',
    'const',
    'properties',
    'required',
    'items',
    'anyOf',
    'allOf',
    'oneOf',
    'not',
    'if',
    'then',
    '$ref',
    'format',
    'dependentSchemas',
  ];
  return !constraining.some((k) => k in schema);
}

function isSchemaTyped(schema: Schema): boolean {
  return 'type' in schema && schema['type'] !== undefined;
}

function typeOf(schema: Schema): string[] {
  const t = schema['type'];
  if (typeof t === 'string') return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string');
  return [];
}

function typeIncludes(schema: Schema, t: string): boolean {
  return typeOf(schema).includes(t);
}

function isObjectShape(schema: Schema): boolean {
  if (typeIncludes(schema, 'object')) return true;
  // No explicit type but declares object-only keywords.
  return !isSchemaTyped(schema) && ('properties' in schema || 'required' in schema);
}

function isArrayShape(schema: Schema): boolean {
  if (typeIncludes(schema, 'array')) return true;
  return !isSchemaTyped(schema) && 'items' in schema;
}

/**
 * Type compatibility for primitives. Every supplied type must be admissible
 * under the target type set. `integer` ⊆ `number`.
 */
function typesCompatible(supplied: string[], target: string[]): boolean {
  if (supplied.length === 0) return false;
  const targetSet = new Set(target);
  return supplied.every((s) => {
    if (targetSet.has(s)) return true;
    if (s === 'integer' && targetSet.has('number')) return true;
    return false;
  });
}

function propsOf(schema: Schema): Record<string, unknown> {
  const p = schema['properties'];
  return isSchemaObject(p) ? p : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function describeType(types: string[]): string {
  if (types.length === 0) return 'untyped';
  return types.join(' | ');
}

function formatEnum(values: unknown[]): string {
  return values.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(', ');
}

function prefix(path: string): string {
  return path ? `${path}: ` : '';
}

function uncheckable(path: string, construct: string): JsonSchemaCoverResult {
  return {
    covered: false,
    uncheckable: true,
    gap: `${prefix(path)}op field uses ${construct}, which cannot be statically checked`,
  };
}

// ============================================================================
// Deep equality (structural, order-sensitive for arrays)
// ============================================================================

/** Structural deep-equality used by the reflexivity fast-path and enum/const checks. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
      if (!deepEqual(ao[k], bo[k])) return false;
    }
    return true;
  }
  return false;
}
