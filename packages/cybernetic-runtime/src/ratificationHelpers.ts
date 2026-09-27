export type AuthorityLevel = 'auto_apply' | 'stage_for_review' | 'require_operator';

// ============================================================================

/**
 * Proposal ops that make a `workflow_refinement` proposal STRUCTURAL or
 * OBJECTIVE-SEMANTIC — hard-floored even though the kind itself is matrix-
 * governed. Derived from the op vocabulary, not free text:
 *   - structure: add/remove/reorder tasks, dependency rewires.
 *   - objective semantics: outcome-threshold changes (the goal's bar).
 */
const HARD_FLOOR_OPS: ReadonlySet<string> = new Set([
  'add_task',
  'remove_task',
  'reorder_tasks',
  'update_task_dependencies',
  'update_outcome_threshold',
]);

/** True when any op in the proposal trips a structural/objective hard floor. */
export function opsContainHardFloor(ops: ReadonlyArray<{ op: string }> | undefined): boolean {
  if (!ops) return false;
  return ops.some((o) => HARD_FLOOR_OPS.has(o.op));
}

// ============================================================================
// Eval-Gating Eligibility
// ============================================================================

/** Ops where eval-gating can meaningfully gate the change. */
const EVAL_GATEABLE_OPS = new Set([
  'update_task_goal',
  'update_task_context_spec',
  'add_task',
  'remove_task',
  'reorder_tasks',
  'promote_context_strategy',
  'update_activation_hint',
  'add_trigger_pattern',
  'update_iteration_policy',
  'unblock_workflow',
]);

/**
 * Returns true for ops where eval-gating works (the eval can meaningfully
 * validate whether the change is safe to apply).
 *
 * Returns false for ops that modify what evals measure (outcome thresholds,
 * block/unblock of workflows) or are purely informational (flag_pattern).
 * Evals cannot gate changes to their own success criteria.
 */
export function isEvalGateableOp(op: string): boolean {
  return EVAL_GATEABLE_OPS.has(op);
}
