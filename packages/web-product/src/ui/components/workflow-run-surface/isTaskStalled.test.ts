/**
 * Phase 2 — honest `Stalled` label (Plan 229 §5.6).
 *
 * The distinction is "long-running, actively streaming" vs "silent past the
 * watchdog deadline". A coding-lane op that is advancing refreshes
 * `lastMutatedAtMs` every ~20s (the proof-of-progress heartbeat) ≪ the 5-min
 * threshold, so it must NEVER read Stalled; only genuine silence past the
 * deadline does. Settled tasks are never stalled.
 */
import { describe, expect, it } from 'vitest';
import {
  harnessFeedLastActivityMs,
  isTaskStalled,
  STALLED_THRESHOLD_MS,
} from './workflowRunSurfaceHelpers.js';
import type { WorkflowSurfaceTaskState } from '../../lib/types.js';

const NOW = 10 * 60_000;

function task(overrides: Partial<WorkflowSurfaceTaskState>): WorkflowSurfaceTaskState {
  return {
    taskId: 't',
    label: 'Task',
    status: 'running',
    attempt: 1,
    lastMutatedAtMs: NOW,
    ...overrides,
  };
}

describe('isTaskStalled', () => {
  it('is false for a long-running op whose heartbeat is recent (actively streaming)', () => {
    // A 9-minute review that heartbeats every 20s: last activity 10s ago → not stalled.
    expect(isTaskStalled(task({ lastMutatedAtMs: NOW - 10_000 }), NOW)).toBe(false);
    // Even right at the edge of the window it is not yet stalled.
    expect(isTaskStalled(task({ lastMutatedAtMs: NOW - STALLED_THRESHOLD_MS }), NOW)).toBe(false);
  });

  it('is true only after genuine silence past the deadline', () => {
    expect(isTaskStalled(task({ lastMutatedAtMs: NOW - STALLED_THRESHOLD_MS - 1 }), NOW)).toBe(
      true,
    );
    expect(isTaskStalled(task({ lastMutatedAtMs: NOW - 6 * 60_000 }), NOW)).toBe(true);
  });

  it('is never stalled for a settled (non-running) task', () => {
    const silent = NOW - 30 * 60_000;
    expect(isTaskStalled(task({ status: 'succeeded', lastMutatedAtMs: silent }), NOW)).toBe(false);
    expect(isTaskStalled(task({ status: 'failed', lastMutatedAtMs: silent }), NOW)).toBe(false);
    expect(isTaskStalled(task({ status: 'paused', lastMutatedAtMs: silent }), NOW)).toBe(false);
  });
});

/**
 * A harness step's progress events and its feed are two different clocks, and
 * the feed is the one the operator can see. A step with fifty-seven tool calls
 * on screen read `Stalled` because the badge counted only the first.
 */
describe('a harness step answers with its feed', () => {
  const SILENT = { lastMutatedAtMs: NOW - 20 * 60_000 };

  it('is not stalled while the feed is still writing', () => {
    expect(isTaskStalled(task(SILENT), NOW, NOW - 4_000)).toBe(false);
  });

  it('is stalled when the feed has gone quiet too', () => {
    expect(isTaskStalled(task(SILENT), NOW, NOW - STALLED_THRESHOLD_MS - 1)).toBe(true);
  });

  it('keeps the progress-only rule for a task with no feed', () => {
    expect(isTaskStalled(task(SILENT), NOW, undefined)).toBe(true);
    expect(isTaskStalled(task({ lastMutatedAtMs: NOW - 10_000 }), NOW, undefined)).toBe(false);
  });

  it('a fresh feed does not resurrect a settled task', () => {
    expect(isTaskStalled(task({ ...SILENT, status: 'failed' }), NOW, NOW)).toBe(false);
  });
});

/**
 * Which feed belongs to the row. The run records an operation task's step in
 * the worker-session column, and an agent task's is a real session — so only
 * the first has a feed here at all.
 */
describe('harnessFeedLastActivityMs', () => {
  const STEP = '77777777-7777-7777-7777-777777777777';
  const feeds = { [STEP]: { lastActivityAtMs: 1_234 } };

  it('reads the feed recorded under the task step', () => {
    expect(
      harnessFeedLastActivityMs(feeds, task({ taskType: 'operation', workerSessionId: STEP })),
    ).toBe(1_234);
  });

  it('reads nothing for an agent task, whose steps stream under their own ids', () => {
    expect(
      harnessFeedLastActivityMs(feeds, task({ taskType: 'agent', workerSessionId: STEP })),
    ).toBeUndefined();
  });

  it('reads nothing on a surface that folds no feeds', () => {
    expect(
      harnessFeedLastActivityMs({}, task({ taskType: 'operation', workerSessionId: STEP })),
    ).toBeUndefined();
  });
});
