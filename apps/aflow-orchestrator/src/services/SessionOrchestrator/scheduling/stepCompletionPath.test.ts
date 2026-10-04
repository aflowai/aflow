import { describe, it, expect, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { StepHotState } from '@aflow/redis';
import { SNOOZE_OPERATION_ID, getSnoozeMaxMs, type TimerItem } from '@aflow/schemas';
import {
  classifyStepCompletionPath,
  type StepInFlightStatus,
  type StepCompletionPathDeps,
} from './stepCompletionPath.js';
import {
  STEP_DEADLINE_BACKSTOP_MS,
  STEP_STARTED_DEAD_EXECUTOR_GRACE_MS,
  STEP_SCHEDULED_STALL_GRACE_MS,
  STEP_SCHEDULED_DEAD_EXECUTOR_GRACE_MS,
  EXECUTOR_WAIT_LOOKS,
} from '@aflow/redis';

const NOW = 1_000_000_000_000;
const redis = {} as Redis;

function deps(inflight: StepInFlightStatus, executorAvailable: boolean): StepCompletionPathDeps {
  return {
    redis,
    getStepInFlight: vi.fn().mockResolvedValue(inflight),
    hasAvailableExecutor: vi.fn().mockResolvedValue(executorAvailable),
    getShardTimer: vi.fn().mockResolvedValue(null),
  };
}

function step(overrides: Partial<StepHotState>): StepHotState {
  return {
    stepExecutionId: 's',
    tenantId: 't',
    sessionId: 'r',
    stepId: 'tool',
    stepType: 'workflow',
    operationId: 'workflow.run.start',
    attempt: 1,
    status: 'STARTED',
    scheduledAt: NOW,
    inputRef: 'inline:x',
    idempotencyKey: 'k',
    ...overrides,
  };
}

describe('classifyStepCompletionPath — STARTED', () => {
  it('alive within deadline+backstop → completion path', async () => {
    const r = await classifyStepCompletionPath(
      deps({ alive: true, deadlineAtMs: NOW + 10_000 }, false),
      step({ status: 'STARTED', startedAt: NOW - 500_000 }),
      NOW,
    );
    expect(r.hasCompletionPath).toBe(true);
  });

  it('alive but past deadline+backstop → no completion path (zombie)', async () => {
    const r = await classifyStepCompletionPath(
      deps({ alive: true, deadlineAtMs: NOW - STEP_DEADLINE_BACKSTOP_MS - 1 }, false),
      step({ status: 'STARTED', startedAt: NOW - 500_000 }),
      NOW,
    );
    expect(r.hasCompletionPath).toBe(false);
  });

  it('alive with null deadline → completion path', async () => {
    const r = await classifyStepCompletionPath(
      deps({ alive: true, deadlineAtMs: null }, false),
      step({ status: 'STARTED', startedAt: NOW - 500_000 }),
      NOW,
    );
    expect(r.hasCompletionPath).toBe(true);
  });

  it('not alive but within the claim→first-beat grace → completion path', async () => {
    const r = await classifyStepCompletionPath(
      deps({ alive: false, deadlineAtMs: null }, false),
      step({ status: 'STARTED', startedAt: NOW - (STEP_STARTED_DEAD_EXECUTOR_GRACE_MS - 1) }),
      NOW,
    );
    expect(r.hasCompletionPath).toBe(true);
  });

  it('not alive past the grace → no completion path (genuine orphan)', async () => {
    const r = await classifyStepCompletionPath(
      deps({ alive: false, deadlineAtMs: null }, false),
      step({ status: 'STARTED', startedAt: NOW - (STEP_STARTED_DEAD_EXECUTOR_GRACE_MS + 1) }),
      NOW,
    );
    expect(r.hasCompletionPath).toBe(false);
  });
});

describe('classifyStepCompletionPath — SCHEDULED', () => {
  it('executor available within the stall grace → completion path', async () => {
    const r = await classifyStepCompletionPath(
      deps({ alive: false, deadlineAtMs: null }, true),
      step({ status: 'SCHEDULED', scheduledAt: NOW - (STEP_SCHEDULED_STALL_GRACE_MS - 1) }),
      NOW,
    );
    expect(r.hasCompletionPath).toBe(true);
  });

  it('no executor past the dead-executor grace → no completion path', async () => {
    const r = await classifyStepCompletionPath(
      deps({ alive: false, deadlineAtMs: null }, false),
      step({ status: 'SCHEDULED', scheduledAt: NOW - (STEP_SCHEDULED_DEAD_EXECUTOR_GRACE_MS + 1) }),
      NOW,
    );
    expect(r.hasCompletionPath).toBe(false);
  });

  it('claimed and waiting for its slot, long past every pickup grace → completion path', async () => {
    const r = await classifyStepCompletionPath(
      deps({ alive: true, deadlineAtMs: null }, false),
      step({ status: 'SCHEDULED', scheduledAt: NOW - STEP_SCHEDULED_STALL_GRACE_MS * 20 }),
      NOW,
    );
    expect(r.hasCompletionPath).toBe(true);
    expect(r.executorOwnsStep).toBe(true);
  });

  it('a lapsed claim falls back to the pickup grace', async () => {
    const r = await classifyStepCompletionPath(
      deps({ alive: false, deadlineAtMs: null }, true),
      step({ status: 'SCHEDULED', scheduledAt: NOW - (STEP_SCHEDULED_STALL_GRACE_MS + 1) }),
      NOW,
    );
    expect(r.hasCompletionPath).toBe(false);
  });

  it('SNOOZE inside its window → completion path even with no executor and past the base grace', async () => {
    const r = await classifyStepCompletionPath(
      deps({ alive: false, deadlineAtMs: null }, false),
      step({
        status: 'SCHEDULED',
        operationId: SNOOZE_OPERATION_ID,
        scheduledAt: NOW - Math.floor(getSnoozeMaxMs() / 2),
      }),
      NOW,
    );
    expect(r.hasCompletionPath).toBe(true);
  });

  it('SNOOZE past its full window → no completion path', async () => {
    const r = await classifyStepCompletionPath(
      deps({ alive: false, deadlineAtMs: null }, false),
      step({
        status: 'SCHEDULED',
        operationId: SNOOZE_OPERATION_ID,
        scheduledAt: NOW - (getSnoozeMaxMs() + STEP_SCHEDULED_DEAD_EXECUTOR_GRACE_MS + 1),
      }),
      NOW,
    );
    expect(r.hasCompletionPath).toBe(false);
  });
});

describe('classifyStepCompletionPath — waiting on its executor', () => {
  const SINCE = NOW - 8 * 60 * 60_000;
  const parked = step({ status: 'SCHEDULED', scheduledAt: SINCE, executorWaitSince: SINCE });

  function waitTimer(sinceMs: number, looks: number): TimerItem {
    return { reason: 'executor_wait', executorWait: { sinceMs, looks } } as unknown as TimerItem;
  }

  function waiting(timer: TimerItem | null): StepCompletionPathDeps {
    return {
      ...deps({ alive: false, deadlineAtMs: null }, false),
      getShardTimer: vi.fn().mockResolvedValue(timer),
    };
  }

  it('is a completion path while its timer lives, however long ago it was scheduled', async () => {
    const r = await classifyStepCompletionPath(waiting(waitTimer(SINCE, 3)), parked, NOW);
    expect(r).toMatchObject({ hasCompletionPath: true, executorWait: 'armed' });
  });

  it('is recognised by its live timer alone', async () => {
    const { executorWaitSince: _unmarked, ...unmarked } = parked;
    const r = await classifyStepCompletionPath(waiting(waitTimer(SINCE, 3)), unmarked, NOW);
    expect(r).toMatchObject({ hasCompletionPath: true, executorWait: 'armed' });
  });

  it('keeps its path when its timer is gone, for the caller to arm again', async () => {
    const r = await classifyStepCompletionPath(waiting(null), parked, NOW);
    expect(r).toMatchObject({ hasCompletionPath: true, executorWait: 'timer_lost' });
  });

  it('counts a timer from a wait the marker no longer names as gone', async () => {
    const r = await classifyStepCompletionPath(waiting(waitTimer(SINCE - 1, 3)), parked, NOW);
    expect(r.executorWait).toBe('timer_lost');
  });

  it('ages out like any pickup once its looks are spent', async () => {
    const r = await classifyStepCompletionPath(
      waiting(waitTimer(SINCE, EXECUTOR_WAIT_LOOKS)),
      parked,
      NOW,
    );
    expect(r).toMatchObject({ hasCompletionPath: false, executorWait: null });
  });

  it("reads the timer of the step's own attempt", async () => {
    const d = waiting(null);
    await classifyStepCompletionPath(d, { ...parked, attempt: 2 }, NOW);
    expect(d.getShardTimer).toHaveBeenCalledWith(redis, {
      sessionId: parked.sessionId,
      stepExecutionId: parked.stepExecutionId,
      reason: 'executor_wait',
      attempt: 2,
    });
  });

  it('is never read for a step an executor holds', async () => {
    const d = {
      ...deps({ alive: true, deadlineAtMs: null }, false),
      getShardTimer: vi.fn().mockResolvedValue(waitTimer(SINCE, 3)),
    };
    const r = await classifyStepCompletionPath(d, { ...parked, status: 'STARTED' }, NOW);
    expect(r.executorWait).toBeNull();
    expect(d.getShardTimer).not.toHaveBeenCalled();
  });
});
