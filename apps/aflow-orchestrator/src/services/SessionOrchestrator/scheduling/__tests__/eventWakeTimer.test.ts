import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockClaimDueShardTimers = vi.fn();
const mockAckShardTimer = vi.fn(async () => undefined);

vi.mock('@aflow/redis', () => ({
  addStepJob: vi.fn(),
  addStepResult: vi.fn(),
  addControlMessage: vi.fn(),
  scheduleShardTimer: vi.fn(),
  NoExecutorAvailableError: class NoExecutorAvailableError extends Error {},
  hasAvailableExecutor: vi.fn(),
  getStepInFlight: vi.fn(),
  clearStepInFlight: vi.fn(),
  peekDueStepStallCandidates: vi.fn(async () => []),
  refreshStepStallCandidate: vi.fn(),
  dropStepStallCandidate: vi.fn(),
  stepStallNextCheckAtMs: vi.fn(() => 0),
  STEP_STALL_SCAN_INTERVAL_MS: 30_000,
  TIMER_MAX_CLAIMS: 5,
  getSessionState: vi.fn(),
  getStepState: vi.fn(),
  isSessionCorrupt: vi.fn(async () => false),
  shardFor: vi.fn(() => 0),
  validateShardOwnership: vi.fn(),
  claimDueShardTimers: (...args: unknown[]) => mockClaimDueShardTimers(...args),
  ackShardTimer: (...args: unknown[]) => mockAckShardTimer(...args),
  ackShardTimerById: vi.fn(async () => true),
  timerId: (t: { stepExecutionId: string; reason: string; attempt: number }) =>
    `${t.stepExecutionId}|${t.reason}|${String(t.attempt)}|`,
  rescheduleClaimedTimer: vi.fn(async () => undefined),
  updateSessionState: vi.fn(),
  appendSessionEvent: vi.fn(),
  markSessionDirty: vi.fn(),
  updateStepState: vi.fn(),
  removeWaitingChild: vi.fn(),
}));

vi.mock('@aflow/database', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  insertTimerDeadLetter: vi.fn(async () => undefined),
}));

vi.mock('../../handlers/dispatchInlineOp.js', () => ({ dispatchInlineOp: vi.fn() }));
vi.mock('../workflowTimerDispatch.js', () => ({ processWorkflowCorrelatedTimer: vi.fn() }));

const mockWakeSessionForRunWakeups = vi.fn();
vi.mock('../../../cybernetic/harness/sessionWakeup.js', () => ({
  wakeSessionForRunWakeups: (...args: unknown[]) => mockWakeSessionForRunWakeups(...args),
}));

import { TimerItemSchema, type TimerItem } from '@aflow/schemas';
import { addStepJob, getStepState, updateStepState } from '@aflow/redis';
import { createProcessDueTimers } from '../timers.js';
import type { SessionOrchestratorBindings } from '../../lifecycle/context.js';

const TENANT = '11111111-1111-4111-9111-111111111111';
const SESSION_ID = '33333333-3333-4333-9333-333333333333';
const PROMPT_STEP = '44444444-4444-4444-9444-444444444444';

function eventWakeTimer(): TimerItem {
  return TimerItemSchema.parse({
    tenantId: TENANT,
    sessionId: SESSION_ID,
    stepExecutionId: PROMPT_STEP,
    stepId: 'chat',
    operationId: 'ai.agent.turn',
    stepType: 'ai',
    reason: 'event_wake',
    attempt: 1,
    inputRef: `inline:${Buffer.from('{}').toString('base64')}`,
    traceId: 'trace-event-wake',
    dueAtMs: Date.now(),
  });
}

function makeBindings() {
  const applyResult = vi.fn();
  const deps = {
    redis: {} as never,
    db: {} as never,
    payloadStore: {} as never,
    consumerName: 'test-consumer',
  };
  const bindings = {
    deps,
    stallWatchdog: { lastStepStallScanMs: Date.now() },
    forceCompleteInFlightStep: vi.fn(),
    applyResult,
  } as unknown as SessionOrchestratorBindings;
  return { bindings, deps, applyResult };
}

function claim(timers: TimerItem[], poisoned: Array<{ timer: TimerItem; claims: number }> = []) {
  mockClaimDueShardTimers.mockResolvedValueOnce({
    timers,
    poisoned,
    malformedPoisoned: [],
    oldestDueAgeMs: 0,
    leaseUntilMs: Date.now() + 30_000,
  });
}

beforeEach(() => {
  vi.mocked(getStepState).mockReset();
  vi.mocked(updateStepState).mockReset();
  vi.mocked(addStepJob).mockReset();
  mockAckShardTimer.mockReset().mockResolvedValue(undefined);
  mockClaimDueShardTimers.mockReset();
  mockWakeSessionForRunWakeups.mockReset().mockResolvedValue('woke');
});

describe('an event-wake timer', () => {
  it('asks the session to wake for unread wakeups when its slot comes round, then settles', async () => {
    claim([eventWakeTimer()]);
    const { bindings, deps } = makeBindings();

    await createProcessDueTimers(bindings)();

    expect(mockWakeSessionForRunWakeups).toHaveBeenCalledWith(
      { db: deps.db, redis: deps.redis, payloadStore: deps.payloadStore },
      TENANT,
      SESSION_ID,
    );
    expect(mockAckShardTimer).toHaveBeenCalledOnce();
    // Not a dispatch: the wake is a resume through the session's own claim.
    expect(addStepJob).not.toHaveBeenCalled();
    expect(updateStepState).not.toHaveBeenCalled();
  });

  it('stays leased for redelivery when the wake fails', async () => {
    claim([eventWakeTimer()]);
    mockWakeSessionForRunWakeups.mockRejectedValueOnce(new Error('postgres unreachable'));
    const { bindings } = makeBindings();

    await createProcessDueTimers(bindings)();

    expect(mockAckShardTimer).not.toHaveBeenCalled();
  });

  it('when poisoned, is dropped without failing the agent turn it names', async () => {
    claim([], [{ timer: eventWakeTimer(), claims: 6 }]);
    vi.mocked(getStepState).mockResolvedValue({
      status: 'PAUSED',
      operationId: 'ai.agent.turn',
      stepId: 'chat',
      stepType: 'ai',
      attempt: 1,
    } as never);
    const { bindings, applyResult } = makeBindings();

    await createProcessDueTimers(bindings)();

    expect(applyResult).not.toHaveBeenCalled();
    expect(updateStepState).not.toHaveBeenCalled();
    expect(mockAckShardTimer).toHaveBeenCalledOnce();
  });
});
