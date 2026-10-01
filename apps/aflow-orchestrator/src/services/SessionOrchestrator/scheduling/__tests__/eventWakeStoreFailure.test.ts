/**
 * An event-wake timer whose store keeps failing, driven through the real
 * timer handler and the real session wake. The shard-timer store is modelled
 * in memory with the three properties that matter here: every claim charges a
 * redelivery, every arming starts a fresh budget, and an acknowledgement
 * leaves an arming made while the timer was being handled in place.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimerItem } from '@aflow/schemas';

const PROMPT_STEP = '44444444-4444-4444-9444-444444444444';

const { shardTimers, mockScheduleShardTimer, mockLogOrchestratorError } = vi.hoisted(() => ({
  /** The shard timer store: one entry per timer id, with its claim count and lease. */
  shardTimers: new Map<string, { timer: TimerItem; claims: number; leased: boolean }>(),
  mockScheduleShardTimer: vi.fn(),
  mockLogOrchestratorError: vi.fn(),
}));

vi.mock('@aflow/redis', async () => {
  const actualRedis = await vi.importActual<typeof import('@aflow/redis')>('@aflow/redis');
  mockScheduleShardTimer.mockImplementation((_redis: unknown, timer: TimerItem) => {
    shardTimers.set(actualRedis.timerId(timer), { timer, claims: 0, leased: false });
    return Promise.resolve();
  });
  return {
    addStepJob: vi.fn(),
    addStepResult: vi.fn(),
    addControlMessage: vi.fn(),
    NoExecutorAvailableError: class NoExecutorAvailableError extends Error {},
    hasAvailableExecutor: vi.fn(),
    getStepInFlight: vi.fn(),
    clearStepInFlight: vi.fn(),
    peekDueStepStallCandidates: vi.fn(async () => []),
    refreshStepStallCandidate: vi.fn(),
    dropStepStallCandidate: vi.fn(),
    stepStallNextCheckAtMs: vi.fn(() => 0),
    STEP_STALL_SCAN_INTERVAL_MS: 30_000,
    TIMER_MAX_CLAIMS: actualRedis.TIMER_MAX_CLAIMS,
    timerId: actualRedis.timerId,
    mayWake: actualRedis.mayWake,
    getSessionState: vi.fn(),
    getSessionStateSafe: vi.fn(async () => ({
      ok: true,
      state: { status: 'PAUSED', currentStepExecutionId: PROMPT_STEP, traceId: 'trace-1' },
    })),
    getStepState: vi.fn(async () => ({
      stepExecutionId: PROMPT_STEP,
      stepId: 'chat',
      stepType: 'ai',
      operationId: 'ai.agent.turn',
      status: 'PAUSED',
      attempt: 1,
      inputRef: 'gs://bucket/turn-input',
    })),
    isSessionCorrupt: vi.fn(async () => false),
    shardFor: vi.fn(() => 0),
    validateShardOwnership: vi.fn(),
    scheduleShardTimer: (redis: unknown, timer: TimerItem) => mockScheduleShardTimer(redis, timer),
    claimDueShardTimers: () => {
      const timers: TimerItem[] = [];
      const poisoned: Array<{ timer: TimerItem; claims: number }> = [];
      for (const entry of shardTimers.values()) {
        entry.claims += 1;
        entry.leased = true;
        if (entry.claims > actualRedis.TIMER_MAX_CLAIMS) {
          poisoned.push({ timer: entry.timer, claims: entry.claims });
        } else {
          timers.push(entry.timer);
        }
      }
      return Promise.resolve({
        timers,
        poisoned,
        malformedPoisoned: [],
        legacyClaimed: 0,
        oldestDueAgeMs: 0,
        leaseUntilMs: Date.now() + 30_000,
      });
    },
    // Compare-and-ack: a timer re-armed after its claim is a newer arming.
    ackShardTimer: (_redis: unknown, timer: TimerItem) => {
      const id = actualRedis.timerId(timer);
      if (shardTimers.get(id)?.leased !== true) return Promise.resolve(false);
      return Promise.resolve(shardTimers.delete(id));
    },
    ackShardTimerById: vi.fn(async () => true),
    rescheduleClaimedTimer: vi.fn(async () => undefined),
    claimEventDrivenTurn: vi.fn(async () => ({ taken: true })),
    returnEventDrivenTurn: vi.fn(),
    updateSessionState: vi.fn(),
    appendSessionEvent: vi.fn(),
    markSessionDirty: vi.fn(),
    updateStepState: vi.fn(),
    removeWaitingChild: vi.fn(),
  };
});

vi.mock('@aflow/database', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  insertTimerDeadLetter: vi.fn(async () => undefined),
}));

const mockDispatchResume = vi.fn();
vi.mock('@aflow/cybernetic-runtime', () => ({
  claimSessionWaiterDelivery: vi.fn(),
  dispatchResume: (...args: unknown[]) => mockDispatchResume(...args),
  rehydratePausedRun: vi.fn(),
  resumeClaimsForStep: vi.fn(async () => []),
  sessionWaiterDeliveryKey: vi.fn(),
}));

const mockHasUnreadRunWakeups = vi.fn();
vi.mock('../../helpers/runWakeups.js', () => ({
  hasUnreadRunWakeups: (...args: unknown[]) => mockHasUnreadRunWakeups(...args),
}));

vi.mock('../../../../lib/orchestratorLogger.js', () => ({
  getOrchestratorLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  logOrchestratorError: mockLogOrchestratorError,
}));

vi.mock('../../handlers/dispatchInlineOp.js', () => ({ dispatchInlineOp: vi.fn() }));
vi.mock('../workflowTimerDispatch.js', () => ({ processWorkflowCorrelatedTimer: vi.fn() }));

import { TIMER_MAX_CLAIMS } from '@aflow/redis';
import { createProcessDueTimers } from '../timers.js';
import { wakeSessionForRunWakeups } from '../../../cybernetic/harness/sessionWakeup.js';
import type { SessionOrchestratorBindings } from '../../lifecycle/context.js';

const TENANT = '11111111-1111-4111-9111-111111111111' as never;
const SESSION_ID = '33333333-3333-4333-9333-333333333333';

function makeBindings() {
  const deps = {
    redis: {} as never,
    db: {} as never,
    payloadStore: {} as never,
    consumerName: 'test-consumer',
  };
  return {
    deps,
    stallWatchdog: { lastStepStallScanMs: Date.now() },
    forceCompleteInFlightStep: vi.fn(),
    applyResult: vi.fn(),
  } as unknown as SessionOrchestratorBindings;
}

beforeEach(() => {
  shardTimers.clear();
  mockScheduleShardTimer.mockClear();
  mockLogOrchestratorError.mockClear();
  mockDispatchResume.mockReset();
  mockHasUnreadRunWakeups.mockReset().mockRejectedValue(new Error('ECONNRESET'));
});

describe('an event-wake timer whose store keeps failing', () => {
  it('is redelivered within its budget, then dropped, without re-arming itself', async () => {
    const bindings = makeBindings();
    const deps = { db: {} as never, redis: {} as never, payloadStore: {} as never };

    // Delivery finds the session resting with the store down: one arming.
    await expect(
      wakeSessionForRunWakeups(deps, TENANT, SESSION_ID, { armWakeOnStoreError: true }),
    ).resolves.toBe('retrying');
    expect(mockScheduleShardTimer).toHaveBeenCalledOnce();
    expect(shardTimers.size).toBe(1);

    const processDueTimers = createProcessDueTimers(bindings);
    let fires = 0;
    // Far past the budget: an unbounded timer would still be armed at the end.
    for (let tick = 0; tick < TIMER_MAX_CLAIMS * 4 && shardTimers.size > 0; tick++) {
      await processDueTimers();
      fires += 1;
    }

    expect(shardTimers.size).toBe(0);
    // TIMER_MAX_CLAIMS handled deliveries, then the poison claim that drops it.
    expect(fires).toBe(TIMER_MAX_CLAIMS + 1);
    expect(mockHasUnreadRunWakeups).toHaveBeenCalledTimes(1 + TIMER_MAX_CLAIMS);
    expect(mockScheduleShardTimer).toHaveBeenCalledOnce();
    expect(mockDispatchResume).not.toHaveBeenCalled();
    expect(mockLogOrchestratorError).toHaveBeenCalledWith(
      '[SessionOrchestrator] Dropping poisoned event wake',
      expect.any(Error),
      expect.objectContaining({ reason: 'event_wake', stepExecutionId: PROMPT_STEP }),
    );
  });
});
