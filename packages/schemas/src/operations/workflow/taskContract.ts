import { z } from 'zod';
import type { WorkflowTaskInputBinding } from './taskBindings.js';

// ============================================================================

export interface AuthoredTaskLike {
  inputBindings?: Record<string, WorkflowTaskInputBinding> | undefined;
  inputContract?: unknown;
}

export function assertAuthoredTask(
  task: AuthoredTaskLike,
  ctx: z.RefinementCtx,
  taskPath: ReadonlyArray<string | number> = [],
): void {
  // Refuse author-declared `system_feedback` bindings.
  if (task.inputBindings) {
    for (const [bindAs, binding] of Object.entries(task.inputBindings)) {
      if (binding.kind === 'system_feedback') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...taskPath, 'inputBindings', bindAs, 'kind'],
          message:
            'system_feedback is a platform-injected binding kind. ' +
            'It is emitted by assembleWorkflow on rerunnable producers and must not be authored directly.',
        });
      }
    }
  }

  // Refuse author-declared `inputContract` — assembler-derived only.
  if (task.inputContract !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...taskPath, 'inputContract'],
      message:
        'inputContract is derived at assemble time from inputBindings + producer produces[]. ' +
        'Authors must not declare it; it is recomputed and persisted by assembleWorkflow.',
    });
  }
}

// ============================================================================

/**
 * One declared output port on a task — the unit of typed data the task
 * commits to producing. Persisted on the assembled `WorkflowTask` (D12) so
 * downstream tasks can resolve `inputBindings[bindAs].outputKey` to a
 * concrete JSON Schema at compile time, and so authoring/inspection tools
 * can render the task's typed output surface.
 *
 * Shape mirrors compose-skill's IR `TaskOutputProductionSchema`. The
 * compose-skill assembler lifts IR `produces[]` onto the runtime
 * `WorkflowTask.produces[]` during lowering.
 */
export const WorkflowTaskOutputPortSchema = z.object({
  /** Local name for the produced output (referenced by downstream consumes[].outputKey / inputBindings[bindAs].outputKey). */
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'Must be a valid identifier'),
  shape: z.record(z.unknown()).refine(
    // `z.record(z.unknown())` already enforces non-null object; refine
    // adds the structural-keyword check.
    (v) => ['type', '$ref', 'oneOf', 'anyOf', 'allOf', 'enum', 'const'].some((k) => k in v),
    {
      message:
        'shape must be a usable JSON Schema fragment — include at least one of: type, $ref, oneOf, anyOf, allOf, enum, const',
    },
  ),
  semantics: z.enum(['data', 'artifact', 'metric', 'status']).default('data'),
  providesPurposeId: z.string().min(1).max(120).optional(),
});
export type WorkflowTaskOutputPort = z.infer<typeof WorkflowTaskOutputPortSchema>;

// ============================================================================

/**
 * One routing rule — what happens when a contract fails for a specific
 * binding (or the consumer's default). The compiler lowers `perBinding`
 * entries to explicit failure edges in the lifecycle subgraph (D13) so
 * the scheduler routes via real graph edges; this schema is the authoring
 * surface only.
 */
const OnContractFailureRouteSchema = z.object({
  /**
   * - `'rerun'`     — re-execute the producer with a typed `system_feedback`
   *                   payload. Gated by D9 idempotency on the producer.
   *                   Honored end-to-end starting in Phase B-prime; in Phase A
   *                   parsed-but-warns and falls through to `'fail'`.
   * - `'fail'`      — fail the consumer (and the run) with the typed error.
   * - `'signal_blocked'` — emit a structured signal_blocked envelope for
   *                   coach / human resolution, leaving the run pausable.
   * - `{ stepId }`  — route to a named step (an authored recovery / handoff).
   */
  producer: z
    .union([
      z.enum(['rerun', 'fail', 'signal_blocked']),
      z.object({ stepId: z.string().min(1).max(120) }).strict(),
    ])
    .optional(),
  /** Maximum producer reruns before falling through to `signal_blocked` (D9). */
  maxProducerReruns: z.number().int().min(0).max(10).optional(),
});
export type OnContractFailureRoute = z.infer<typeof OnContractFailureRouteSchema>;

export const OnContractFailureSchema = z
  .object({
    /** Route per local binding name (`bindAs`). Falls back to `default` if absent. */
    perBinding: z.record(z.string().max(64), OnContractFailureRouteSchema).optional(),
    /** Default route for any binding not listed in perBinding. */
    default: OnContractFailureRouteSchema.optional(),
  })
  .strict();
export type OnContractFailure = z.infer<typeof OnContractFailureSchema>;

// ============================================================================

/**
 * One resolved binding's contract — the JSON Schema the resolved value must
 * satisfy plus the source attribution needed to blame the right producer
 * when validation fails. Derived from the consumer's `inputBindings` and the
 * referenced producer's `produces[*].shape` at assemble time, then persisted
 * on the assembled task. Read at runtime by the lifecycle subgraph's
 * `validate_input` phase.
 *
 * Discriminated by `kind` so the runtime never sees an under-specified
 * contract — e.g. a `task_output` entry without `taskId`/`outputKey`, or
 * a `system_feedback` entry carrying producer fields. C4's validate_input
 * and C3's lifecycle compiler can read variant fields without runtime guards.
 */
const TaskInputContractBindingSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('task_output'),
      bindAs: z.string().min(1).max(64),
      /** Producer task ID. */
      taskId: z.string().min(1).max(64),
      /** Producer output port key — must match a `produces[*].key` on `taskId`. */
      outputKey: z.string().min(1).max(64),
      /** Optional sub-path into the resolved value. */
      path: z.string().max(200).optional(),
      /** JSON Schema derived from `producer.produces[<outputKey>].shape`. */
      schema: z.record(z.unknown()),
    })
    .strict(),
  z
    .object({
      kind: z.literal('task_summary'),
      bindAs: z.string().min(1).max(64),
      /** Producer task ID — the resolver returns the upstream task's prose summary. */
      taskId: z.string().min(1).max(64),
      /** JSON Schema (typically `{ type: 'string' }`). */
      schema: z.record(z.unknown()),
    })
    .strict(),
  z
    .object({
      kind: z.literal('run_input'),
      bindAs: z.string().min(1).max(64),
      /** Dot path into the run input snapshot. Required (matches WorkflowTaskInputBindingSchema's run_input variant). */
      path: z.string().min(1).max(200),
      /** JSON Schema derived from the workflow's run-input contract slice. */
      schema: z.record(z.unknown()),
    })
    .strict(),
  z
    .object({
      kind: z.literal('campaign_input'),
      bindAs: z.string().min(1).max(64),
      /** Dot path into the campaign config (head segment = contract field key). */
      path: z.string().min(1).max(200),
      /** JSON Schema of the referenced campaign-contract field. */
      schema: z.record(z.unknown()),
    })
    .strict(),
  z
    .object({
      kind: z.literal('system_feedback'),
      bindAs: z.string().min(1).max(64),
      /**
       * JSON Schema for the platform-injected `ContractError` payload (Plan
       * 123 §5.1). The assembler emits this slot only on rerunnable producer
       * tasks and lists it OUTSIDE the consumer's `required[]` so first-run
       * validation passes when the property is absent (resolver-side rule —
       * see `resolveTaskInputs.ABSENT`).
       */
      schema: z.record(z.unknown()),
    })
    .strict(),
  z
    .object({
      kind: z.literal('artifact_binding'),
      bindAs: z.string().min(1).max(64),
      bundleId: z.string().min(1).max(128),
      bindingId: z.string().min(1).max(128),
      /** JSON Schema for the artifactId UUID string. */
      schema: z.record(z.unknown()),
    })
    .strict(),
]);
export type TaskInputContractBinding = z.infer<typeof TaskInputContractBindingSchema>;

export const TaskInputContractSchema = z
  .object({
    bindings: z.record(z.string().max(64), TaskInputContractBindingSchema).default({}),
  })
  .strict()
  .superRefine((data, ctx) => {
    for (const [key, binding] of Object.entries(data.bindings)) {
      if (binding.bindAs !== key) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['bindings', key, 'bindAs'],
          message: `bindings["${key}"].bindAs must equal the record key "${key}", got "${binding.bindAs}".`,
        });
      }
    }
  });
export type TaskInputContract = z.infer<typeof TaskInputContractSchema>;
