import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDispatchInlineOp = vi.fn();
const mockClaimDueShardTimers = vi.fn();
const mockGetSessionState = vi.fn();
const mockAddStepJob = vi.fn();
const mockIsSessionCorrupt = vi.fn();
const mockProcessWorkflowCorrelatedTimer = vi.fn();
const mockAckShardTimer = vi.fn(async () => undefined);
const mockAckShardTimerById = vi.fn(async () => true);

vi.mock('@aflow/redis', () => ({
  addStepJob: (...args: unknown[]) => mockAddStepJob(...args),
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
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
  getStepState: vi.fn(),
  isSessionCorrupt: (...args: unknown[]) => mockIsSessionCorrupt(...args),
  shardFor: vi.fn(() => 0),
  validateShardOwnership: vi.fn(),
  // Destructured from the dynamic `await import('@aflow/redis')` at the
  // top of processDueTimers.
  claimDueShardTimers: (...args: unknown[]) => mockClaimDueShardTimers(...args),
  ackShardTimer: (...args: unknown[]) => mockAckShardTimer(...args),
  ackShardTimerById: (...args: unknown[]) => mockAckShardTimerById(...args),
  timerId: (t: { stepExecutionId: string; reason: string; attempt: number }) =>
    `${t.stepExecutionId}|${t.reason}|${String(t.attempt)}|`,
  rescheduleClaimedTimer: vi.fn(async () => undefined),
  updateSessionState: vi.fn(),
  appendSessionEvent: vi.fn(),
  markSessionDirty: vi.fn(),
  updateStepState: vi.fn(),
  removeWaitingChild: vi.fn(),
}));

const mockInsertTimerDeadLetter = vi.fn(async () => undefined);
vi.mock('@aflow/database', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  insertTimerDeadLetter: (...args: unknown[]) => mockInsertTimerDeadLetter(...args),
}));

vi.mock('../../handlers/dispatchInlineOp.js', () => ({
  dispatchInlineOp: (...args: unknown[]) => mockDispatchInlineOp(...args),
}));

vi.mock('../workflowTimerDispatch.js', () => ({
  processWorkflowCorrelatedTimer: (...args: unknown[]) =>
    mockProcessWorkflowCorrelatedTimer(...args),
}));

import { SNOOZE_OPERATION_ID, TimerItemSchema, type TimerItem } from '@aflow/schemas';
import { addStepResult, getStepState, removeWaitingChild, updateStepState } from '@aflow/redis';
import { createProcessDueTimers } from '../timers.js';
import type { SessionOrchestratorBindings } from '../../lifecycle/context.js';

const TENANT = '11111111-1111-4111-9111-111111111111';
const SESSION_ID = '33333333-3333-4333-9333-333333333333';
const STEP_EXEC_ID = '44444444-4444-4444-9444-444444444444';
const SPACE_ID = '55555555-5555-4555-9555-555555555555';

function sessionSnoozeTimer(): TimerItem {
  return TimerItemSchema.parse({
    tenantId: TENANT,
    sessionId: SESSION_ID,
    stepExecutionId: STEP_EXEC_ID,
    stepId: 'wait',
    operationId: SNOOZE_OPERATION_ID,
    stepType: 'agent',
    reason: 'delayed_start',
    attempt: 1,
    inputRef: `inline:${Buffer.from(JSON.stringify({ durationMs: 5000 })).toString('base64')}`,
    traceId: 'trace-session-snooze',
    dueAtMs: Date.now(),
  });
}

function makeBindings(): SessionOrchestratorBindings {
  return {
    deps: {
      redis: {} as never,
      payloadStore: {} as never,
      consumerName: 'test-consumer',
      // No shardManager → no owned shards, so fencing never applies.
    },
    // lastStepStallScanMs = now → the opportunistic watchdog scan is skipped.
    stallWatchdog: { lastStepStallScanMs: Date.now() },
    forceCompleteInFlightStep: vi.fn(),
    applyResult: vi.fn(),
  } as unknown as SessionOrchestratorBindings;
}

beforeEach(() => {
  vi.mocked(getStepState).mockReset();
  vi.mocked(updateStepState).mockReset();
  vi.mocked(addStepResult).mockReset();
  vi.mocked(removeWaitingChild).mockReset();
  mockInsertTimerDeadLetter.mockReset().mockResolvedValue(undefined);
  mockDispatchInlineOp.mockReset().mockResolvedValue(undefined);
  mockAckShardTimer.mockReset().mockResolvedValue(undefined);
  mockAckShardTimerById.mockReset().mockResolvedValue(true);
  mockClaimDueShardTimers.mockReset();
  mockClaimDueShardTimers.mockResolvedValue({
    timers: [],
    poisoned: [],
    malformedPoisoned: [],
    oldestDueAgeMs: 0,
  });
  mockGetSessionState.mockReset().mockResolvedValue({ spaceId: SPACE_ID });
  mockAddStepJob.mockReset().mockResolvedValue(undefined);
  mockIsSessionCorrupt.mockReset().mockResolvedValue(false);
  mockProcessWorkflowCorrelatedTimer.mockReset().mockResolvedValue(undefined);
});

describe('processDueTimers — session-leg snooze (Plan 194 §4.1)', () => {
  it('pops a session snooze timer into dispatchInlineOp — never addStepJob', async () => {
    const timer = sessionSnoozeTimer();
    mockClaimDueShardTimers.mockResolvedValueOnce({
      timers: [timer],
      poisoned: [],
      malformedPoisoned: [],
      oldestDueAgeMs: 0,
    });

    const processed = await createProcessDueTimers(makeBindings())();

    expect(processed).toBe(1);
    // Session-correlated timer must NOT take the workflow branch.
    expect(mockProcessWorkflowCorrelatedTimer).not.toHaveBeenCalled();
    // stepType 'agent' has no executor — addStepJob would strand the step.
    expect(mockAddStepJob).not.toHaveBeenCalled();

    expect(mockDispatchInlineOp).toHaveBeenCalledTimes(1);
    const call = mockDispatchInlineOp.mock.calls[0]!;
    // Positional contract of dispatchInlineOp(redis, payloadStore, context,
    // stepDef, stepExecutionId, idempotencyKey, resolvedInputRef, attempt,
    // now, parentStepExecutionId, workflowExecution).
    const context = call[2] as Record<string, unknown>;
    expect(context['tenantId']).toBe(TENANT);
    expect(context['runId']).toBe(SESSION_ID);
    // Space resolved from session hot state (cold path read).
    expect(context['spaceId']).toBe(SPACE_ID);
    const stepDef = call[3] as Record<string, unknown>;
    expect(stepDef['operation']).toBe(SNOOZE_OPERATION_ID);
    expect(stepDef['stepId']).toBe('wait');
    expect(call[4]).toBe(STEP_EXEC_ID);
    // Session-leg idempotency: the standard per-attempt session key.
    expect(call[5]).toBe(`${SESSION_ID}:${STEP_EXEC_ID}:1`);
    expect(call[6]).toBe(timer.inputRef);
    expect(call[7]).toBe(1);
    // Session leg — no workflowExecution envelope.
    expect(call[10]).toBeUndefined();
  });

  it('routes workflow-correlated timers to processWorkflowCorrelatedTimer, untouched by session handling', async () => {
    const timer = TimerItemSchema.parse({
      tenantId: TENANT,
      workflowExecution: {
        runId: '22222222-2222-4222-9222-222222222222',
        taskId: 'wait',
        attempt: 1,
        dispatchAttemptToken: 'dispatch:22222222-2222-4222-9222-222222222222:wait:1',
      },
      stepExecutionId: STEP_EXEC_ID,
      stepId: 'wait',
      operationId: SNOOZE_OPERATION_ID,
      stepType: 'agent',
      reason: 'delayed_start',
      attempt: 1,
      inputRef: `inline:${Buffer.from('{}').toString('base64')}`,
      traceId: 'trace-wf-snooze',
      dueAtMs: Date.now(),
    });
    mockClaimDueShardTimers.mockResolvedValueOnce({
      timers: [timer],
      poisoned: [],
      malformedPoisoned: [],
      oldestDueAgeMs: 0,
    });

    await createProcessDueTimers(makeBindings())();

    expect(mockProcessWorkflowCorrelatedTimer).toHaveBeenCalledTimes(1);
    expect(mockProcessWorkflowCorrelatedTimer.mock.calls[0]![2]).toEqual(timer);
    expect(mockProcessWorkflowCorrelatedTimer.mock.calls[0]![3]).toEqual(timer.workflowExecution);
    // The session-leg machinery must not run for workflow timers.
    expect(mockIsSessionCorrupt).not.toHaveBeenCalled();
    expect(mockDispatchInlineOp).not.toHaveBeenCalled();
  });

  it('swallows a snooze dispatch failure (logged; step recovered by the stall watchdog)', async () => {
    mockDispatchInlineOp.mockRejectedValueOnce(new Error('redis down'));
    mockClaimDueShardTimers.mockResolvedValueOnce({
      timers: [sessionSnoozeTimer()],
      poisoned: [],
      malformedPoisoned: [],
      oldestDueAgeMs: 0,
    });

    await expect(createProcessDueTimers(makeBindings())()).resolves.toBe(1);
    expect(mockAddStepJob).not.toHaveBeenCalled();
  });

  it('leaves a failed snooze dispatch leased rather than acknowledging it', async () => {
    // Acknowledging is compare-and-ack, which deletes the timer. A handler that
    // threw has not done the thing the timer exists for, so settling it turns a
    // transient Redis or executor error into a permanently lost wake — the
    // timer's own claim protocol already handles this by letting the lease
    // expire and redelivering.
    mockClaimDueShardTimers.mockResolvedValueOnce({
      timers: [sessionSnoozeTimer()],
      poisoned: [],
      malformedPoisoned: [],
      oldestDueAgeMs: 0,
    });
    mockDispatchInlineOp.mockRejectedValue(new Error('redis unavailable'));

    await createProcessDueTimers(makeBindings())();

    expect(mockDispatchInlineOp).toHaveBeenCalledTimes(1);
    expect(mockAckShardTimer).not.toHaveBeenCalled();
  });

  it('leaves a failed delegation timeout leased rather than acknowledging it', async () => {
    // Same contract as the snooze branch: a handler that threw has not
    // delivered the timeout, so settling would turn a transient failure into
    // a delegate step waiting forever on children it should have failed.
    const CHILD_ID = '66666666-6666-4666-9666-666666666666';
    const timer = TimerItemSchema.parse({
      tenantId: TENANT,
      sessionId: SESSION_ID,
      stepExecutionId: STEP_EXEC_ID,
      stepId: 'delegate',
      operationId: 'agent.control.delegate',
      stepType: 'agent',
      reason: 'timeout',
      attempt: 1,
      inputRef: `inline:${Buffer.from('{}').toString('base64')}`,
      traceId: 'trace-delegation-timeout',
      dueAtMs: Date.now(),
    });
    mockClaimDueShardTimers.mockResolvedValueOnce({
      timers: [timer],
      poisoned: [],
      malformedPoisoned: [],
      oldestDueAgeMs: 0,
    });
    mockGetSessionState.mockImplementation(async (...args: unknown[]) =>
      args[2] === SESSION_ID
        ? {
            status: 'WAITING_ON_CHILD',
            delegationPauseSource: 'child_running',
            waitingForChildSessionIds: [CHILD_ID],
            spaceId: SPACE_ID,
          }
        : { parentStepExecutionId: STEP_EXEC_ID },
    );
    vi.mocked(getStepState).mockResolvedValueOnce({
      status: 'PAUSED',
      operationId: 'agent.control.delegate',
    } as never);
    // A sibling delegate remains, so the session-level transition is skipped.
    vi.mocked(removeWaitingChild).mockResolvedValueOnce(1 as never);
    vi.mocked(addStepResult).mockRejectedValueOnce(new Error('redis unavailable'));

    await createProcessDueTimers(makeBindings())();

    expect(addStepResult).toHaveBeenCalledTimes(1);
    expect(mockAckShardTimer).not.toHaveBeenCalled();
  });
});

describe('processDueTimers — poisoned-timer disposition', () => {
  function poisonedClaim(timer: TimerItem, claims = 6) {
    mockClaimDueShardTimers.mockResolvedValueOnce({
      timers: [],
      poisoned: [{ timer, claims }],
      malformedPoisoned: [],
      oldestDueAgeMs: 0,
    });
  }

  function bindingsWithApplyResult(): {
    bindings: SessionOrchestratorBindings;
    applyResult: ReturnType<typeof vi.fn>;
  } {
    const bindings = makeBindings();
    return {
      bindings,
      applyResult: (bindings as unknown as { applyResult: ReturnType<typeof vi.fn> }).applyResult,
    };
  }

  it('fails the waiting step visibly, then acknowledges the timer', async () => {
    poisonedClaim(sessionSnoozeTimer());
    vi.mocked(getStepState).mockResolvedValueOnce({
      status: 'PAUSED',
      operationId: SNOOZE_OPERATION_ID,
      stepId: 'wait',
      stepType: 'agent',
      attempt: 1,
      idempotencyKey: `${SESSION_ID}:${STEP_EXEC_ID}:1`,
      parentStepExecutionId: null,
    } as never);
    const { bindings, applyResult } = bindingsWithApplyResult();

    await createProcessDueTimers(bindings)();

    // PAUSED steps reject results; the disposition resets first.
    expect(updateStepState).toHaveBeenCalledWith(expect.anything(), TENANT, STEP_EXEC_ID, {
      sessionId: SESSION_ID,
      status: 'STARTED',
    });
    expect(applyResult).toHaveBeenCalledTimes(1);
    const { result } = applyResult.mock.calls[0]![0] as {
      result: { status: string; error: { code: string; retryable: boolean } };
    };
    expect(result.status).toBe('FAILED');
    expect(result.error.code).toBe('TIMER_POISONED');
    expect(result.error.retryable).toBe(true);
    expect(mockAckShardTimer).toHaveBeenCalledTimes(1);
  });

  it('fails a step still waiting on its retry wake, not just live ones', async () => {
    // A retry timer's step sits in FAILED until the wake re-dispatches it —
    // treating FAILED as "moved on" would leave the most common timer kind
    // hanging silently.
    const timer = TimerItemSchema.parse({
      tenantId: TENANT,
      sessionId: SESSION_ID,
      stepExecutionId: STEP_EXEC_ID,
      stepId: 'fetch',
      operationId: 'api.http.call',
      stepType: 'api',
      reason: 'retry',
      attempt: 2,
      inputRef: `inline:${Buffer.from('{}').toString('base64')}`,
      traceId: 'trace-retry-poison',
      dueAtMs: Date.now(),
    });
    poisonedClaim(timer);
    vi.mocked(getStepState).mockResolvedValueOnce({
      status: 'FAILED',
      operationId: 'api.http.call',
      stepId: 'fetch',
      stepType: 'api',
      attempt: 1,
      idempotencyKey: `${SESSION_ID}:${STEP_EXEC_ID}:1`,
      parentStepExecutionId: null,
    } as never);
    const { bindings, applyResult } = bindingsWithApplyResult();

    await createProcessDueTimers(bindings)();

    // The disposition consumes the timer's attempt, exactly as the dispatch
    // would have, so applyResult's retry math advances to a fresh timer id and
    // the retry budget converges.
    expect(updateStepState).toHaveBeenCalledWith(expect.anything(), TENANT, STEP_EXEC_ID, {
      sessionId: SESSION_ID,
      status: 'STARTED',
      attempt: 2,
    });
    expect(applyResult).toHaveBeenCalledTimes(1);
    const { result } = applyResult.mock.calls[0]![0] as {
      result: { attempt: number; idempotencyKey: string };
    };
    expect(result.attempt).toBe(2);
    expect(result.idempotencyKey).toBe(`${SESSION_ID}:${STEP_EXEC_ID}:2`);
    expect(mockAckShardTimer).toHaveBeenCalledTimes(1);
  });

  it('acks a half-reset retry disposition as moved on, leaving recovery to the watchdog', async () => {
    // The previous disposition reset the step (STARTED at the wake's attempt)
    // and then failed to land its result. Re-dispositioning would race a
    // genuinely running attempt; the armed stall candidate owns this state.
    const timer = TimerItemSchema.parse({
      tenantId: TENANT,
      sessionId: SESSION_ID,
      stepExecutionId: STEP_EXEC_ID,
      stepId: 'fetch',
      operationId: 'api.http.call',
      stepType: 'api',
      reason: 'retry',
      attempt: 2,
      inputRef: `inline:${Buffer.from('{}').toString('base64')}`,
      traceId: 'trace-half-reset',
      dueAtMs: Date.now(),
    });
    poisonedClaim(timer);
    vi.mocked(getStepState).mockResolvedValueOnce({
      status: 'STARTED',
      operationId: 'api.http.call',
      stepId: 'fetch',
      stepType: 'api',
      attempt: 2,
      idempotencyKey: `${SESSION_ID}:${STEP_EXEC_ID}:2`,
      parentStepExecutionId: null,
    } as never);
    const { bindings, applyResult } = bindingsWithApplyResult();

    await createProcessDueTimers(bindings)();

    expect(applyResult).not.toHaveBeenCalled();
    expect(updateStepState).not.toHaveBeenCalled();
    expect(mockAckShardTimer).toHaveBeenCalledTimes(1);
  });

  it('dispositions a poisoned timeout as non-retryable', async () => {
    // Retrying re-runs the delegation while its never-cancelled children are
    // still live — the real timeout branch's non-retryable error forbids
    // exactly that, and the disposition must not override it.
    const timer = TimerItemSchema.parse({
      tenantId: TENANT,
      sessionId: SESSION_ID,
      stepExecutionId: STEP_EXEC_ID,
      stepId: 'delegate',
      operationId: 'agent.control.delegate',
      stepType: 'agent',
      reason: 'timeout',
      attempt: 1,
      inputRef: `inline:${Buffer.from('{}').toString('base64')}`,
      traceId: 'trace-timeout-poison',
      dueAtMs: Date.now(),
    });
    poisonedClaim(timer);
    vi.mocked(getStepState).mockResolvedValueOnce({
      status: 'PAUSED',
      operationId: 'agent.control.delegate',
      stepId: 'delegate',
      stepType: 'agent',
      attempt: 1,
      idempotencyKey: `${SESSION_ID}:${STEP_EXEC_ID}:1`,
      parentStepExecutionId: null,
    } as never);
    const { bindings, applyResult } = bindingsWithApplyResult();

    await createProcessDueTimers(bindings)();

    expect(applyResult).toHaveBeenCalledTimes(1);
    const { result } = applyResult.mock.calls[0]![0] as {
      result: { error: { retryable: boolean; classification: string } };
    };
    expect(result.error.retryable).toBe(false);
    expect(result.error.classification).toBe('timeout');
    expect(mockAckShardTimer).toHaveBeenCalledTimes(1);
  });

  it('archives to the durable dead letter past twice the budget, then acknowledges', async () => {
    // Past 2x the claim budget the disposition itself is what kept failing —
    // the payload is persisted losslessly for inspection and replay instead
    // of being dispositioned again.
    const timer = sessionSnoozeTimer();
    poisonedClaim(timer, 11);
    const { bindings, applyResult } = bindingsWithApplyResult();

    await createProcessDueTimers(bindings)();

    expect(mockInsertTimerDeadLetter).toHaveBeenCalledTimes(1);
    const entry = mockInsertTimerDeadLetter.mock.calls[0]![1] as {
      tenantId: string;
      claims: number;
      payload: unknown;
    };
    expect(entry.tenantId).toBe(TENANT);
    expect(entry.claims).toBe(11);
    expect(entry.payload).toEqual(timer);
    expect(applyResult).not.toHaveBeenCalled();
    expect(mockAckShardTimer).toHaveBeenCalledTimes(1);
  });

  it('archives a malformed poisoned payload raw and acknowledges by storage identity', async () => {
    // Decodes as JSON but no longer matches the schema — no TimerItem can be
    // rebuilt, so the archive keeps the raw payload with whatever identity it
    // still names, and the ack goes by shard and id.
    mockClaimDueShardTimers.mockResolvedValueOnce({
      timers: [],
      poisoned: [],
      malformedPoisoned: [
        {
          raw: JSON.stringify({
            tenantId: TENANT,
            stepExecutionId: 'legacy-step-1',
            futureField: 1,
          }),
          claims: 7,
          shardId: 42,
          timerId: 'stale|retry|2|',
        },
      ],
      oldestDueAgeMs: 0,
    });
    const { bindings, applyResult } = bindingsWithApplyResult();

    await createProcessDueTimers(bindings)();

    expect(mockInsertTimerDeadLetter).toHaveBeenCalledTimes(1);
    const entry = mockInsertTimerDeadLetter.mock.calls[0]![1] as {
      timerId: string;
      tenantId: string | null;
      sessionId: string | null;
      claims: number;
    };
    expect(entry.timerId).toBe('stale|retry|2|');
    expect(entry.tenantId).toBe(TENANT);
    expect(entry.sessionId).toBeNull();
    // Non-UUID identities become null — the insert casts to uuid, and a value
    // that cannot cast would fail archival on every redelivery forever. The
    // raw payload still carries the original.
    expect(entry.stepExecutionId).toBeNull();
    expect(entry.claims).toBe(7);
    expect(applyResult).not.toHaveBeenCalled();
    expect(mockAckShardTimerById).toHaveBeenCalledWith(
      expect.anything(),
      42,
      'stale|retry|2|',
      undefined,
    );
  });

  it('leaves the timer leased when the archive itself fails', async () => {
    poisonedClaim(sessionSnoozeTimer(), 11);
    mockInsertTimerDeadLetter.mockRejectedValueOnce(new Error('postgres unreachable'));
    const { bindings } = bindingsWithApplyResult();

    await createProcessDueTimers(bindings)();

    expect(mockAckShardTimer).not.toHaveBeenCalled();
  });

  it('acks a stale retry wake whose attempt the step has already moved past', async () => {
    // A poisoned timer can be redelivered after its disposition landed — the
    // ack is swallowed on failure — and by then the step has advanced.
    // Dispositioning it again would rewind the step's attempt and re-execute
    // work the earlier disposition already consumed.
    const timer = TimerItemSchema.parse({
      tenantId: TENANT,
      sessionId: SESSION_ID,
      stepExecutionId: STEP_EXEC_ID,
      stepId: 'fetch',
      operationId: 'api.http.call',
      stepType: 'api',
      reason: 'retry',
      attempt: 2,
      inputRef: `inline:${Buffer.from('{}').toString('base64')}`,
      traceId: 'trace-stale-retry',
      dueAtMs: Date.now(),
    });
    poisonedClaim(timer);
    vi.mocked(getStepState).mockResolvedValueOnce({
      status: 'FAILED',
      operationId: 'api.http.call',
      stepId: 'fetch',
      stepType: 'api',
      attempt: 2,
      idempotencyKey: `${SESSION_ID}:${STEP_EXEC_ID}:2`,
      parentStepExecutionId: null,
    } as never);
    const { bindings, applyResult } = bindingsWithApplyResult();

    await createProcessDueTimers(bindings)();

    expect(updateStepState).not.toHaveBeenCalled();
    expect(applyResult).not.toHaveBeenCalled();
    expect(mockAckShardTimer).toHaveBeenCalledTimes(1);
  });

  it('archives an unparseable malformed payload raw-only instead of cycling forever', async () => {
    // cjson accepts shapes JSON.parse rejects (inf/nan) and a bare null; the
    // terminal backstop must archive them as raw text, not throw on each
    // redelivery.
    mockClaimDueShardTimers.mockResolvedValueOnce({
      timers: [],
      poisoned: [],
      malformedPoisoned: [{ raw: '{"a":inf}', claims: 7, shardId: 3, timerId: 'legacy|retry|1|' }],
      oldestDueAgeMs: 0,
    });
    const { bindings } = bindingsWithApplyResult();

    await createProcessDueTimers(bindings)();

    expect(mockInsertTimerDeadLetter).toHaveBeenCalledTimes(1);
    const entry = mockInsertTimerDeadLetter.mock.calls[0]![1] as {
      tenantId: string | null;
      reason: string;
      payload: unknown;
    };
    expect(entry.tenantId).toBeNull();
    expect(entry.reason).toBe('unparseable');
    expect(entry.payload).toEqual({ raw: '{"a":inf}' });
    expect(mockAckShardTimerById).toHaveBeenCalledTimes(1);
  });

  it('leaves the timer leased when the disposition itself fails', async () => {
    poisonedClaim(sessionSnoozeTimer());
    vi.mocked(getStepState).mockResolvedValueOnce({
      status: 'SCHEDULED',
      operationId: SNOOZE_OPERATION_ID,
      stepId: 'wait',
      stepType: 'agent',
      attempt: 1,
      idempotencyKey: `${SESSION_ID}:${STEP_EXEC_ID}:1`,
      parentStepExecutionId: null,
    } as never);
    const { bindings, applyResult } = bindingsWithApplyResult();
    applyResult.mockRejectedValueOnce(new Error('redis unavailable'));

    await createProcessDueTimers(bindings)();

    expect(applyResult).toHaveBeenCalledTimes(1);
    expect(mockAckShardTimer).not.toHaveBeenCalled();
  });

  it('acknowledges without a synthetic failure when the step has moved on', async () => {
    poisonedClaim(sessionSnoozeTimer());
    vi.mocked(getStepState).mockResolvedValueOnce(undefined as never);
    const { bindings, applyResult } = bindingsWithApplyResult();

    await createProcessDueTimers(bindings)();

    expect(applyResult).not.toHaveBeenCalled();
    expect(updateStepState).not.toHaveBeenCalled();
    expect(mockAckShardTimer).toHaveBeenCalledTimes(1);
  });

  it('leaves a workflow-correlated poisoned timer for the dead-letter backstop', async () => {
    poisonedClaim(
      TimerItemSchema.parse({
        tenantId: TENANT,
        workflowExecution: {
          runId: '22222222-2222-4222-9222-222222222222',
          taskId: 'wait',
          attempt: 1,
          dispatchAttemptToken: 'dispatch:22222222-2222-4222-9222-222222222222:wait:1',
        },
        stepExecutionId: STEP_EXEC_ID,
        stepId: 'wait',
        operationId: SNOOZE_OPERATION_ID,
        stepType: 'agent',
        reason: 'delayed_start',
        attempt: 1,
        inputRef: `inline:${Buffer.from('{}').toString('base64')}`,
        traceId: 'trace-wf-poison',
        dueAtMs: Date.now(),
      }),
    );
    const { bindings, applyResult } = bindingsWithApplyResult();

    await createProcessDueTimers(bindings)();

    expect(vi.mocked(getStepState)).not.toHaveBeenCalled();
    expect(applyResult).not.toHaveBeenCalled();
    // Not acknowledged: an ack deletes the only copy, while staying leased
    // lets the claim's dead-letter backstop archive the payload.
    expect(mockAckShardTimer).not.toHaveBeenCalled();
  });
});
