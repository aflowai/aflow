/**
 * Two humans acting on one execution must never kill it.
 *
 * Before this: a losing resume threw "Run … is not paused", the consumer's
 * catch-all routed every throw to `markRunFailed`, and the winner's now-RUNNING
 * state was overwritten with FAILED. Two people clicking resume destroyed
 * healthy work.
 */
import { describe, expect, it } from 'vitest';
import { ControlConflictError, isControlConflictError } from '../../lib/controlConflict.js';
import { ControlRejectedMetadataSchema } from '@aflow/schemas';

describe('ControlConflictError', () => {
  it('is distinguishable from ordinary failures', () => {
    expect(isControlConflictError(new ControlConflictError('run_not_paused', 'nope'))).toBe(true);
    expect(isControlConflictError(new Error('database exploded'))).toBe(false);
    expect(isControlConflictError(undefined)).toBe(false);
  });

  it('carries the observed state so the loser can be told what happened', () => {
    const conflict = new ControlConflictError('resume_step_mismatch', 'targets a closed pause', {
      observedStatus: 'PAUSED',
      currentStepExecutionId: 'step-b',
      requestedStepExecutionId: 'step-a',
    });

    const metadata = ControlRejectedMetadataSchema.parse({
      conflictCode: conflict.conflictCode,
      controlMessageType: 'resume_run',
      message: conflict.message,
      observedStatus: conflict.observedStatus,
      currentStepExecutionId: conflict.currentStepExecutionId,
      requestedStepExecutionId: conflict.requestedStepExecutionId,
    });

    expect(metadata.conflictCode).toBe('resume_step_mismatch');
    expect(metadata.currentStepExecutionId).toBe('step-b');
    expect(metadata.requestedStepExecutionId).toBe('step-a');
  });

  it('carries no detail when none was observed', () => {
    const conflict = new ControlConflictError('run_not_found', 'gone');
    expect(conflict.observedStatus).toBeUndefined();
    expect(conflict.currentStepExecutionId).toBeUndefined();
    expect(conflict.requestedStepExecutionId).toBeUndefined();
  });
});
