/**
 * Slice A — live step counter (`runningStepCount`).
 *
 * Pure helper so the surface's time-slot step suffix is testable without RTL
 * (the web vitest env is node-only). Pins: agent + running only, 1-based
 * `activeOpSequence` passthrough, and the non-agent / non-running / missing
 * cases that must read as "no count".
 */
import { describe, expect, it } from 'vitest';
import { runningStepCount } from './workflowRunSurfaceHelpers.js';
import type { WorkflowSurfaceTaskState } from '../../lib/types.js';

function task(overrides: Partial<WorkflowSurfaceTaskState>): WorkflowSurfaceTaskState {
  return {
    taskId: 't',
    label: 'Task',
    status: 'running',
    attempt: 1,
    lastMutatedAtMs: 0,
    ...overrides,
  };
}

describe('runningStepCount', () => {
  it('returns the relay sequence for a running agent task', () => {
    expect(runningStepCount(task({ taskType: 'agent', activeOpSequence: 12 }))).toBe(12);
    expect(runningStepCount(task({ taskType: 'agent', activeOpSequence: 1 }))).toBe(1);
  });

  it('is null for non-agent tasks (one op / no op → no meaningful count)', () => {
    expect(runningStepCount(task({ taskType: 'operation', activeOpSequence: 3 }))).toBeNull();
    expect(runningStepCount(task({ taskType: 'human', activeOpSequence: 3 }))).toBeNull();
    expect(runningStepCount(task({ activeOpSequence: 3 }))).toBeNull();
  });

  it('is null once the task leaves running (live-only indicator)', () => {
    expect(
      runningStepCount(task({ taskType: 'agent', status: 'succeeded', activeOpSequence: 9 })),
    ).toBeNull();
    expect(
      runningStepCount(task({ taskType: 'agent', status: 'paused', activeOpSequence: 9 })),
    ).toBeNull();
  });

  it('is null when no activity has been relayed yet', () => {
    expect(runningStepCount(task({ taskType: 'agent' }))).toBeNull();
    expect(runningStepCount(task({ taskType: 'agent', activeOpSequence: 0 }))).toBeNull();
  });
});
