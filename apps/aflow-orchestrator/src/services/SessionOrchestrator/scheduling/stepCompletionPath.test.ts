import { describe, it, expect, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { StepHotState } from '@aflow/redis';
import { SNOOZE_OPERATION_ID, getSnoozeMaxMs } from '@aflow/schemas';
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
} from '@aflow/redis';

const NOW = 1_000_000_000_000;
const redis = {} as Redis;

function deps(inflight: StepInFlightStatus, executorAvailable: boolean): StepCompletionPathDeps {
  return {
    redis,
    getStepInFlight: vi.fn().mockResolvedValue(inflight),
    hasAvailableExecutor: vi.fn().mockResolvedValue(executorAvailable),
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
