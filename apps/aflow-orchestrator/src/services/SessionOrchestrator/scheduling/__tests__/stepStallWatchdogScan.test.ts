/**
 * The stall watchdog's sweep over the step-deadline index.
 *
 * The index only says when to look. Everything that decides what happens next
 * still comes from a fresh read of the session, the step, and the executor's
 * in-flight key, so the three outcomes a candidate can have — pushed forward,
 * dropped, reaped — are what this pins. A sweep that reaped on the score alone
 * would kill live work; one that never dropped or never refreshed would re-read
 * the same sessions on every cycle forever.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPeekDueStepStallCandidates = vi.fn();
const mockRefreshStepStallCandidate = vi.fn();
const mockDropStepStallCandidate = vi.fn();
const mockGetSessionState = vi.fn();
const mockGetStepState = vi.fn();
const mockClassify = vi.fn();

vi.mock('@aflow/redis', () => ({
  addStepJob: vi.fn(),
  addStepResult: vi.fn(),
  addControlMessage: vi.fn(),
  scheduleShardTimer: vi.fn(),
  NoExecutorAvailableError: class NoExecutorAvailableError extends Error {},
  hasAvailableExecutor: vi.fn(),
  getStepInFlight: vi.fn(),
  clearStepInFlight: vi.fn(async () => undefined),
  peekDueStepStallCandidates: (...args: unknown[]) => mockPeekDueStepStallCandidates(...args),
  refreshStepStallCandidate: (...args: unknown[]) => mockRefreshStepStallCandidate(...args),
  dropStepStallCandidate: (...args: unknown[]) => mockDropStepStallCandidate(...args),
  stepStallNextCheckAtMs: vi.fn(() => 999),
  STEP_STALL_SCAN_INTERVAL_MS: 30_000,
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
  getStepState: (...args: unknown[]) => mockGetStepState(...args),
  isSessionCorrupt: vi.fn(async () => false),
  shardFor: vi.fn(() => 0),
  validateShardOwnership: vi.fn(),
  claimDueShardTimers: vi.fn(async () => ({
    timers: [],
    poisoned: [],
    malformedPoisoned: [],
    oldestDueAgeMs: 0,
    leaseUntilMs: 0,
    legacyClaimed: 0,
  })),
  ackShardTimer: vi.fn(),
  ackShardTimerById: vi.fn(),
  timerId: (t: { stepExecutionId: string; reason: string; attempt: number }) =>
    `${t.stepExecutionId}|${t.reason}|${String(t.attempt)}|`,
  TIMER_MAX_CLAIMS: 5,
  rescheduleClaimedTimer: vi.fn(),
  updateSessionState: vi.fn(),
  appendSessionEvent: vi.fn(),
  markSessionDirty: vi.fn(),
  updateStepState: vi.fn(),
  removeWaitingChild: vi.fn(),
}));

vi.mock('../stepCompletionPath.js', () => ({
  classifyStepCompletionPath: (...args: unknown[]) => mockClassify(...args),
}));

import { createProcessDueTimers } from '../timers.js';
import type { SessionOrchestratorBindings } from '../../lifecycle/context.js';

const TENANT = '11111111-1111-4111-9111-111111111111';
const RUN = '33333333-3333-4333-9333-333333333333';
const STEP = '44444444-4444-4444-9444-444444444444';

const mockApplyResult = vi.fn();
const mockForceComplete = vi.fn();

function makeBindings(): SessionOrchestratorBindings {
  return {
    deps: {
      redis: { publish: vi.fn(async () => 0) } as never,
      payloadStore: {} as never,
      consumerName: 'test-consumer',
    },
    // 0 → the opportunistic scan always runs on this tick.
    stallWatchdog: { lastStepStallScanMs: 0 },
    forceCompleteInFlightStep: mockForceComplete,
    applyResult: mockApplyResult,
  } as unknown as SessionOrchestratorBindings;
}

function runningSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: RUN,
    tenantId: TENANT,
    status: 'RUNNING',
    currentStepExecutionId: STEP,
    traceId: 'trace-1',
    ...overrides,
  };
}

function activeStep(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stepExecutionId: STEP,
    tenantId: TENANT,
    sessionId: RUN,
    stepId: 'step-1',
    stepType: 'ai',
    operationId: 'ai.generate.text',
    attempt: 1,
    status: 'SCHEDULED',
    scheduledAt: 1000,
    inputRef: 'inline:x',
    idempotencyKey: 'key-1',
    ...overrides,
  };
}

beforeEach(() => {
  mockPeekDueStepStallCandidates
    .mockReset()
    .mockResolvedValue([{ tenantId: TENANT, sessionId: RUN, dueAtMs: 1 }]);
  mockRefreshStepStallCandidate.mockReset().mockResolvedValue(undefined);
  mockDropStepStallCandidate.mockReset().mockResolvedValue(undefined);
  mockGetSessionState.mockReset().mockResolvedValue(runningSession());
  mockGetStepState.mockReset().mockResolvedValue(activeStep());
  mockClassify.mockReset().mockResolvedValue({
    hasCompletionPath: true,
    isStarted: false,
    executorOwnsStep: true,
    stepDeadlineAtMs: null,
  });
  mockApplyResult.mockReset().mockResolvedValue(undefined);
  mockForceComplete.mockReset().mockResolvedValue(true);
});

describe('step-stall watchdog sweep', () => {
  it('asks for a bounded, due-ordered slice rather than every session', async () => {
    await createProcessDueTimers(makeBindings())();

    expect(mockPeekDueStepStallCandidates).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.any(Number),
    );
  });

  it('pushes a candidate that still has a completion path forward', async () => {
    await createProcessDueTimers(makeBindings())();

    expect(mockRefreshStepStallCandidate).toHaveBeenCalledWith(expect.anything(), TENANT, RUN, 999);
    expect(mockApplyResult).not.toHaveBeenCalled();
  });

  it.each([
    ['the session is gone', () => mockGetSessionState.mockResolvedValue(null)],
    [
      'the session left RUNNING',
      () => mockGetSessionState.mockResolvedValue(runningSession({ status: 'FAILED' })),
    ],
    [
      'the session has no current step',
      () =>
        mockGetSessionState.mockResolvedValue(
          runningSession({ currentStepExecutionId: undefined }),
        ),
    ],
    ['the step hash is gone', () => mockGetStepState.mockResolvedValue(null)],
    ['the step parked', () => mockGetStepState.mockResolvedValue(activeStep({ status: 'PAUSED' }))],
  ])('drops a candidate when %s', async (_label, arrange) => {
    arrange();

    await createProcessDueTimers(makeBindings())();

    // The score is passed so the drop is a compare-and-remove: the decision was
    // made from reads outside any transaction, and a write can land in that gap.
    expect(mockDropStepStallCandidate).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      RUN,
      expect.any(Number),
    );
    expect(mockRefreshStepStallCandidate).not.toHaveBeenCalled();
    expect(mockApplyResult).not.toHaveBeenCalled();
  });

  it('skips a session this instance does not own without touching the index', async () => {
    const bindings = makeBindings();
    (bindings.deps as { shardManager?: unknown }).shardManager = {
      ownsRun: () => false,
      ownedShards: () => [],
    };

    await createProcessDueTimers(bindings)();

    expect(mockGetSessionState).not.toHaveBeenCalled();
    expect(mockDropStepStallCandidate).not.toHaveBeenCalled();
    expect(mockRefreshStepStallCandidate).not.toHaveBeenCalled();
  });

  it('reaps only when the completion-path authority says there is none', async () => {
    mockClassify.mockResolvedValue({
      hasCompletionPath: false,
      isStarted: false,
      executorOwnsStep: false,
      stepDeadlineAtMs: null,
    });

    await createProcessDueTimers(makeBindings())();

    expect(mockRefreshStepStallCandidate).not.toHaveBeenCalled();
    const [{ result }] = mockApplyResult.mock.calls[0] as [
      { result: { status: string; error: { code: string; retryable: boolean } } },
    ];
    expect(result.status).toBe('FAILED');
    expect(result.error.code).toBe('STEP_ABANDONED');
    expect(result.error.retryable).toBe(true);
  });

  it('pauses an in-flight agent step whose executor disappeared', async () => {
    mockGetStepState.mockResolvedValue(
      activeStep({ stepType: 'agent', status: 'STARTED', startedAt: 1000 }),
    );
    mockClassify.mockResolvedValue({
      hasCompletionPath: false,
      isStarted: true,
      executorOwnsStep: false,
      stepDeadlineAtMs: null,
    });

    await createProcessDueTimers(makeBindings())();

    expect(mockForceComplete).toHaveBeenCalledWith(TENANT, RUN, 'interrupted');
    expect(mockApplyResult).not.toHaveBeenCalled();
  });
});
