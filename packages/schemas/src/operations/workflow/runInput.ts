import { z } from 'zod';

// ============================================================================
// Workflow Run-Input Contract Schema
// ============================================================================

/**
 * Declared run-input contract entry.
 *
 * A workflow may declare the run inputs it expects so that `run_input.*`
 * bindings resolve against a named, documented surface instead of an
 * undeclared free-for-all. This is the DECLARATION surface only — enforcement
 * (graph/start-time validation that a required input is provided) lands in a
 * later slice and is intentionally not wired here.
 */
const RunInputIdSchema = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/, 'Must be a valid identifier');

/**
 * When an optional run input is required after all: where any of `anyGiven`
 * was passed and none of `noneGiven` was. A start missing it is refused with
 * `reason`, before the run exists — the same refusal a missing required input
 * gets, rather than a task failing on it once the run is under way.
 */
export const WorkflowRunInputRequiredWhenSchema = z
  .object({
    anyGiven: z.array(RunInputIdSchema).min(1).max(20),
    noneGiven: z.array(RunInputIdSchema).max(20).default([]),
    reason: z.string().min(1).max(500),
  })
  .strict();
export type WorkflowRunInputRequiredWhen = z.infer<typeof WorkflowRunInputRequiredWhenSchema>;

export const WorkflowRunInputSchema = z.object({
  id: RunInputIdSchema,
  required: z.boolean().default(true),
  description: z.string().max(500).optional(),
  /** JSON Schema fragment describing the value. Optional for v1. */
  schema: z.record(z.unknown()).optional(),
  /** Only on an input that is not `required`: the inputs that make it required after all. */
  requiredWhen: WorkflowRunInputRequiredWhenSchema.optional(),
});
export type WorkflowRunInput = z.infer<typeof WorkflowRunInputSchema>;
