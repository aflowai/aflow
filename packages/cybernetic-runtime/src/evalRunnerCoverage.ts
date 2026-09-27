import type { CriterionResult } from '@aflow/schemas';

export interface RunTerminalCoverage {
  /** The run's terminal status (`workflow_runs.status`). */
  runStatus: string;
  /** Failed tasks that are REQUIRED (not `optional: true` in the workflow). */
  failedRequiredTaskIds: readonly string[];
}

export interface RunTerminalCoverageResult {
  verdict: 'pass' | 'fail' | 'partial';
  overall: number;
  /** Present when the rule fired — push into `goalResults` as evidence. */
  syntheticResult?: CriterionResult;
}

/**
 * Compute the failed REQUIRED task ids for the coverage rule: workflow tasks
 * not marked `optional: true`, intersected with the run's failed task rows.
 * Shared by every `runEvaluation` caller (postRunHooks finalize +
 * `workflow.manage.evaluate`) so no scoring path can drift on the rule.
 * A null/absent workflow yields an empty set — run-level status still covers.
 */
export function computeFailedRequiredTaskIds(
  workflowTasks:
    ReadonlyArray<{ taskId: string; optional?: boolean | undefined }> | null | undefined,
  runTasks: ReadonlyArray<{ taskId: string; status: string }>,
): string[] {
  const requiredTaskIds = new Set(
    (workflowTasks ?? []).filter((t) => t.optional !== true).map((t) => t.taskId),
  );
  return runTasks
    .filter((t) => t.status === 'failed' && requiredTaskIds.has(t.taskId))
    .map((t) => t.taskId);
}

/**
 * Apply the coverage rule to a computed verdict + overall score. Identity
 * when the run terminated cleanly with no failed required task.
 */
export function applyRunTerminalCoverage(input: {
  verdict: 'pass' | 'fail' | 'partial';
  overall: number;
  coverage: RunTerminalCoverage;
}): RunTerminalCoverageResult {
  const { verdict, overall, coverage } = input;

  const failedRequired = coverage.failedRequiredTaskIds.length > 0;
  const runFailed = coverage.runStatus === 'failed';
  if (!failedRequired && !runFailed) return { verdict, overall };

  const why = failedRequired
    ? `required task(s) failed: ${coverage.failedRequiredTaskIds.join(', ')}`
    : `run terminal status is '${coverage.runStatus}'`;

  return {
    verdict: 'fail',
    overall: 0,
    syntheticResult: {
      criterionName: 'run-terminal',
      criterionType: 'run_terminal',
      passed: false,
      score: 0,
      evidence:
        `Run-terminal coverage (Plan 183c): ${why}. A run with a failed required task cannot score ` +
        `partial-success — verdict forced to 'fail', overall zeroed (tier scores kept for diagnostics).`,
    },
  };
}
