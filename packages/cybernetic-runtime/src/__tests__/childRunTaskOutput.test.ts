/**
 * A task that starts a run names that run through its own projection, so a
 * reader of the task's output finds the run whatever the field is called.
 */
import type { WorkflowTask } from '@aflow/schemas';
import { describe, expect, it } from 'vitest';

import { failedChildRunOf, startedRunOf } from '../childRunTaskOutput.js';

const start = (over: Partial<WorkflowTask> = {}): WorkflowTask =>
  ({
    taskId: 'review-1',
    name: 'Review round 1',
    type: 'operation',
    operation: 'workflow.run.start',
    ...over,
  }) as WorkflowTask;

const projected = start({
  outputProjection: {
    outcome: { path: 'outcome', onMissing: 'error' },
    reviewRunId: { path: 'runId', onMissing: 'error' },
  },
} as Partial<WorkflowTask>);

describe('startedRunOf', () => {
  it('reads the run a start task started from the field its projection names', () => {
    expect(startedRunOf(projected, { reviewRunId: 'run-review', outcome: 'completed' })).toBe(
      'run-review',
    );
    expect(startedRunOf(start(), { runId: 'run-child', outcome: 'failed' })).toBe('run-child');
  });

  it('names a run whatever its ending, where failedChildRunOf names only a failed one', () => {
    const output = { reviewRunId: 'run-review', outcome: 'completed' };
    expect(startedRunOf(projected, output)).toBe('run-review');
    expect(failedChildRunOf(projected, output)).toBeUndefined();
    expect(failedChildRunOf(projected, { ...output, outcome: 'failed' })).toBe('run-review');
  });

  it('names no run for a task of another operation, or an output with no run id', () => {
    expect(startedRunOf(start({ operation: 'host.harness.run' }), { runId: 'hr_1' })).toBe(
      undefined,
    );
    expect(startedRunOf(projected, { outcome: 'completed' })).toBeUndefined();
    expect(startedRunOf(projected, null)).toBeUndefined();
    expect(startedRunOf(projected, ['run-review'])).toBeUndefined();
  });
});
