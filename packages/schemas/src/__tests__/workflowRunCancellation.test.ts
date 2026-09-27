import { describe, expect, it } from 'vitest';
import {
  WorkflowRunCancellationSchema,
  WorkflowRunCancelActorSchema,
  buildWakeupCancellation,
} from '../runtime/workflowRun.js';

describe('WorkflowRunCancellationSchema', () => {
  it('defaults cancelledBy to system (unattributed cancels unaffected)', () => {
    expect(WorkflowRunCancellationSchema.parse({})).toEqual({ cancelledBy: 'system' });
  });

  it('round-trips an explicit operator cancellation with reason', () => {
    expect(
      WorkflowRunCancellationSchema.parse({ cancelledBy: 'operator', reason: 'stop it' }),
    ).toEqual({ cancelledBy: 'operator', reason: 'stop it' });
  });

  it('rejects unknown actors', () => {
    expect(WorkflowRunCancelActorSchema.safeParse('user').success).toBe(false);
    expect(WorkflowRunCancellationSchema.safeParse({ cancelledBy: 'bogus' }).success).toBe(false);
  });
});

describe('buildWakeupCancellation', () => {
  it('operator cancels carry the deliberate-stop retry policy', () => {
    expect(buildWakeupCancellation({ cancelledBy: 'operator', reason: 'done' })).toEqual({
      cancelledBy: 'operator',
      reason: 'done',
      retryPolicy: 'do_not_restart_without_explicit_user_instruction',
    });
  });

  it.each(['system', 'agent'] as const)('%s cancels stay may_restart', (actor) => {
    expect(buildWakeupCancellation({ cancelledBy: actor })).toEqual({
      cancelledBy: actor,
      retryPolicy: 'may_restart',
    });
  });
});
