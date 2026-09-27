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
export const WorkflowRunInputSchema = z.object({
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/, 'Must be a valid identifier'),
  required: z.boolean().default(true),
  description: z.string().max(500).optional(),
  /** JSON Schema fragment describing the value. Optional for v1. */
  schema: z.record(z.unknown()).optional(),
});
export type WorkflowRunInput = z.infer<typeof WorkflowRunInputSchema>;
