/**
 * Which step a task row reads its live feed under.
 *
 * The feed is keyed by the step that wrote it. An operation task has no worker
 * session of its own, so the run records its step execution in that column —
 * which is the key the harness card needs. An agent task's worker session is a
 * session: its steps stream under their own ids and none of them is this row.
 */
import { describe, expect, it } from 'vitest';
import type { WorkflowSurfaceTaskState } from '../../lib/types.js';
import { harnessFeedStepId } from './workflowRunSurfaceHelpers.js';

const WORKER = '55555555-5555-5555-5555-555555555555';

function task(over: Partial<WorkflowSurfaceTaskState>): WorkflowSurfaceTaskState {
  return {
    taskId: 'review',
    label: 'Review the changes',
    status: 'running',
    attempt: 1,
    lastMutatedAtMs: 0,
    ...over,
  };
}

describe('harnessFeedStepId', () => {
  it('reads an operation task under its worker session, which is its step', () => {
    expect(harnessFeedStepId(task({ taskType: 'operation', workerSessionId: WORKER }))).toBe(
      WORKER,
    );
  });

  it('reads a task whose dispatch family is not yet known under the same column', () => {
    expect(harnessFeedStepId(task({ workerSessionId: WORKER }))).toBe(WORKER);
  });

  it('reads nothing for an agent task', () => {
    expect(harnessFeedStepId(task({ taskType: 'agent', workerSessionId: WORKER }))).toBeUndefined();
  });

  it('reads nothing before the run records a worker session', () => {
    expect(harnessFeedStepId(task({ taskType: 'operation', status: 'scheduled' }))).toBeUndefined();
  });
});
