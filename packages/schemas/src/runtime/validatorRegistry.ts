import type { z } from 'zod';

// ============================================================================
// Runtime context for runtime validators
// ============================================================================

/**
 * Context handed to a runtime validator when submit_output runs it.
 *
 * The `db` field is intentionally typed as `unknown` here so the registry
 * doesn't pull in Drizzle. Runtime validators that need the DB cast through
 * to the appropriate type (`PostgresJsDatabase` from `@aflow/database`).
 */
export interface RuntimeValidatorContext {
  tenantId: string;
  spaceId: string;
  /** Optional — current run/session ID; some validators scope to the active run. */
  runId?: string;
  /** Database handle. Cast to `PostgresJsDatabase` in validators that use it. */
  db: unknown;
  // `listSessionApiEvidenceRefs` removed 2026-05-06 along with the
  // provenance gate that was its sole consumer.
}

/**
 * A runtime validator: validates `data` with access to space-scoped runtime
 * context (the DB, the space ID). Returns the issues found, or an empty
 * array on success.
 *
 * Issues are plain Zod-shaped objects so the rest of the pipeline (Coach
 * evidence, error messages) can treat pure-Zod and runtime issues uniformly.
 */
export interface RuntimeValidatorIssue {
  code: 'custom';
  path: Array<string | number>;
  message: string;
  params?: Record<string, unknown>;
}

export type RuntimeValidatorFn = (
  data: unknown,
  ctx: RuntimeValidatorContext,
) => Promise<RuntimeValidatorIssue[]>;

// ============================================================================
// Registry
// ============================================================================

const _validators = new Map<string, z.ZodTypeAny>();
const _runtimeValidators = new Map<string, RuntimeValidatorFn>();
const _advisoryValidators = new Map<string, AdvisoryValidatorFn>();

/**
 * What an artifact would still be weak at, having passed every rule that can
 * refuse it.
 *
 * Submission validation is pass/fail by design — a gate cannot be advisory.
 * But most of what makes an artifact poor is not a rule violation: a suite of
 * cases can satisfy every schema and still leave half its requirements
 * undetected. That belongs to whoever authored the contract, not to the draft
 * store, so it is registered against the same ref and refuses nothing. No
 * surface reads it today — `draft_check` was its only reader and was removed
 * once submit_output's own rejection proved to cover the same ground.
 */
export interface AdvisoryFinding {
  code: string;
  detail: string;
  /** Where in the artifact, when it localises. */
  path?: Array<string | number> | undefined;
}

export type AdvisoryValidatorFn = (data: unknown) => AdvisoryFinding[];

/**
 * Register advisories for a ref that already has a blocking validator. The two
 * are deliberately separate functions: an advisory that could refuse a
 * submission would be a rule, and a rule that only warns is one nobody obeys.
 */
export function registerAdvisoryValidator(name: string, fn: AdvisoryValidatorFn): void {
  const existing = _advisoryValidators.get(name);
  if (existing && existing !== fn) {
    throw new Error(
      `validatorRegistry: advisory validator "${name}" is already registered with a different function.`,
    );
  }
  _advisoryValidators.set(name, fn);
}

export function getAdvisoryValidator(name: string): AdvisoryValidatorFn | undefined {
  return _advisoryValidators.get(name);
}

/**
 * Register a Zod (pure) validator under a stable name.
 *
 * Idempotent if the same schema is registered twice (compares identity).
 * Throws if a different schema is registered under an existing name —
 * silent overrides would let a registration order change subtly alter
 * runtime validation behaviour.
 */
export function registerValidator(name: string, schema: z.ZodTypeAny): void {
  if (_runtimeValidators.has(name)) {
    throw new Error(
      `validatorRegistry: name "${name}" is already registered as a runtime validator. ` +
        'A name can be either pure or runtime, not both.',
    );
  }
  const existing = _validators.get(name);
  if (existing && existing !== schema) {
    throw new Error(
      `validatorRegistry: name "${name}" is already registered with a different schema. ` +
        'Names must be globally unique across the platform.',
    );
  }
  _validators.set(name, schema);
}

/**
 * Register a runtime validator: a function that gets a `RuntimeValidatorContext`
 * (tenantId, spaceId, db) so it can read space state. Use for invariants that
 * can't be expressed as pure Zod schemas — e.g., "capability references must
 * exist in this space's bindings."
 */
export function registerRuntimeValidator(name: string, fn: RuntimeValidatorFn): void {
  if (_validators.has(name)) {
    throw new Error(
      `validatorRegistry: name "${name}" is already registered as a pure validator. ` +
        'A name can be either pure or runtime, not both.',
    );
  }
  const existing = _runtimeValidators.get(name);
  if (existing && existing !== fn) {
    throw new Error(
      `validatorRegistry: name "${name}" is already registered with a different runtime function. ` +
        'Names must be globally unique across the platform.',
    );
  }
  _runtimeValidators.set(name, fn);
}

/**
 * Look up a registered pure-Zod validator. Returns null when no pure
 * validator is registered under the given name (it may be a runtime
 * validator instead — callers checking both should call both lookups).
 */
export function getValidator(name: string): z.ZodTypeAny | null {
  return _validators.get(name) ?? null;
}

/**
 * Look up a registered runtime validator. Returns null when none is
 * registered under the given name.
 */
export function getRuntimeValidator(name: string): RuntimeValidatorFn | null {
  return _runtimeValidators.get(name) ?? null;
}

/**
 * Discriminated lookup helper — returns the registered validator under
 * `name`, regardless of kind, or null when nothing is registered.
 */
export type RegisteredValidator =
  { kind: 'pure'; schema: z.ZodTypeAny } | { kind: 'runtime'; fn: RuntimeValidatorFn };

export function lookupValidator(name: string): RegisteredValidator | null {
  const pure = _validators.get(name);
  if (pure) return { kind: 'pure', schema: pure };
  const runtime = _runtimeValidators.get(name);
  if (runtime) return { kind: 'runtime', fn: runtime };
  return null;
}

/**
 * List every registered validator name (pure + runtime), sorted. Used by
 * static analysis (workflow authoring time) to validate that an
 * `outputContract.validatorRefs` entry points at something that exists,
 * so authors get fail-fast feedback instead of a runtime miss.
 */
export function listRegisteredValidatorNames(): string[] {
  return [...new Set([..._validators.keys(), ..._runtimeValidators.keys()])].sort();
}

/** Test-only: clear all registrations. Do not call from production code. */
export function _resetValidatorRegistryForTest(): void {
  _validators.clear();
  _runtimeValidators.clear();
}
