import { z } from 'zod';

// ============================================================================

/**
 * The dimension a diagnostic came from. Promotes the validator's typed `kind`
 * out of the interpolated `detail` string so UI / Helmsman / Coach can parse
 * instead of scrape.
 *
 * - `parse` — the config did not even pass `WorkflowSchema` (most basic).
 * - `graph` — structural graph invariant (cycle, missing dep, binding ref, …).
 * - `op_input` — operation-task input-contract failure (the "kind" bug class).
 * - `eval_linkage` — eval criterion references a task that does not exist.
 * - `capability` — artifact-internal capability-grant well-formedness.
 * - `ref` — artifact-internal ref coherence (uiOutput shape, op-task-only tool).
 * - `semantic` — heuristic prose/binding mismatch (advisory; e.g. a task `goal`
 *   references `inputs.<key>` with no matching `inputBindings` entry).
 */
export const SkillDiagnosticDimensionSchema = z.enum([
  'parse',
  'graph',
  'op_input',
  'eval_linkage',
  'capability',
  'ref',
  'semantic',
]);

export type SkillDiagnosticDimension = z.infer<typeof SkillDiagnosticDimensionSchema>;

export const SkillDiagnosticSeveritySchema = z.enum(['error', 'advisory']);

export type SkillDiagnosticSeverity = z.infer<typeof SkillDiagnosticSeveritySchema>;

export const SkillDiagnosticSchema = z.object({
  /** `GraphValidationError.kind`, or a parse/eval/ref/capability code. */
  code: z.string().min(1).max(128),
  dimension: SkillDiagnosticDimensionSchema,
  severity: SkillDiagnosticSeveritySchema,
  /** Offending task, when the diagnostic localises to one. */
  taskId: z.string().max(128).optional(),
  /** Offending input/output field, when known. */
  field: z.string().max(256).optional(),
  /** The upstream producer task implicated (e.g. for a dataflow binding). */
  producerTaskId: z.string().max(128).optional(),
  /** The operation the offending task calls, when it is an operation task. */
  operationId: z.string().max(256).optional(),
  /** Human-readable description (today's `GraphValidationError.detail`). */
  detail: z.string().min(1).max(2000),
  /** The "declare the shape / add a literal fallback" remediation half. */
  fixHint: z.string().max(2000).optional(),
});

export type SkillDiagnostic = z.infer<typeof SkillDiagnosticSchema>;

// ============================================================================

export const SkillValidityStatusSchema = z.enum(['valid', 'invalid']);

export type SkillValidityStatus = z.infer<typeof SkillValidityStatusSchema>;

/**
 * The contract verdict. `status` is `invalid` iff any `severity: 'error'`
 * diagnostic exists. At an execution gate `canRun = status === 'valid'` — the
 * gate recomputed, so the verdict is current by construction (no freshness
 * flag / hashes in Slice 1; that is the deferrable §9 layer).
 */
export const SkillValiditySchema = z.object({
  status: SkillValidityStatusSchema,
  /** `severity: 'error'` set — the blocking diagnostics that drive a Coach patch. */
  diagnostics: z.array(SkillDiagnosticSchema).max(200),
  /** `severity: 'advisory'` set — non-blocking quality / migration hints. */
  advisories: z.array(SkillDiagnosticSchema).max(200),
  validatedAt: z.string().datetime(),
});

export type SkillValidity = z.infer<typeof SkillValiditySchema>;
