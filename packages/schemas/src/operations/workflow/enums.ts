import { z } from 'zod';

// ============================================================================
// Enums
// ============================================================================

export const WorkflowModeSchema = z.enum(['optimization', 'process', 'project']);
export type WorkflowMode = z.infer<typeof WorkflowModeSchema>;

export const WorkflowStatusSchema = z.enum(['draft', 'approved', 'completed', 'abandoned']);
export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;

export const WorkflowRunStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'cancelled',
  'paused',
  'in_flight',
  'skipped',
]);
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;

export const WorkflowLearningCategorySchema = z.enum([
  'worked',
  'failed',
  'discovered',
  'platform',
  'hypothesis',
  'workflow_adjustment',
]);
export type WorkflowLearningCategory = z.infer<typeof WorkflowLearningCategorySchema>;

export const WorkflowLearningSourceSchema = z.enum([
  'agent',
  'helmsman',
  'evaluator',
  'harness',
  'human',
]);
export type WorkflowLearningSource = z.infer<typeof WorkflowLearningSourceSchema>;

export const WorkflowLearningKindSchema = z.enum([
  // fast-inject
  'search_heuristic',
  'constraint',
  'observation',
  'next_direction',
  // block-until-vetted
  'objective_semantics',
  'eval_semantics',
  'workflow_structure',
  'capability_scope',
  'doctrine',
]);
export type WorkflowLearningKind = z.infer<typeof WorkflowLearningKindSchema>;

export const FAST_INJECT_LEARNING_KINDS: readonly WorkflowLearningKind[] = [
  'search_heuristic',
  'constraint',
  'observation',
  'next_direction',
];

/** True when a learning kind is co-injected with the trajectory (vs blocked). */
export function isFastInjectLearningKind(kind: WorkflowLearningKind): boolean {
  return FAST_INJECT_LEARNING_KINDS.includes(kind);
}
