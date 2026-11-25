/**
 * The dry-run hold on the timer paths. A write held at its first dispatch is
 * held again when a timer dispatches it: a session step's retry or delayed
 * start, and each poll cycle of an operation task after the first. Each
 * resolves the dry run from Postgres when the session hash is corrupt,
 * deleted or silent: a session step through its durable link to the run's
 * row, and an operation task from the run's row. A write whose link or row
 * cannot be read is never sent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockClaimDueShardTimers = vi.fn();
const mockGetSessionState = vi.fn();
const mockGetSessionDryRunLink = vi.fn();
const mockAddStepResult = vi.fn(async () => '1-0');
const mockAckShardTimer = vi.fn(async () => undefined);
const mockDispatchOrWaitOnExecutor = vi.fn(async () => ({ kind: 'enqueued' }));
const mockReadWorkflowRunDryRun = vi.fn();
const mockReadDryRunSession = vi.fn();

vi.mock('@aflow/redis', () => ({
  addStepJob: vi.fn(),
  addStepResult: (...args: unknown[]) => mockAddStepResult(...(args as [])),
  addControlMessage: vi.fn(),
  scheduleShardTimer: vi.fn(),
  hasAvailableExecutor: vi.fn(),
  getStepInFlight: vi.fn(),
  getShardTimer: vi.fn(),
  clearStepInFlight: vi.fn(),
  peekDueStepStallCandidates: vi.fn(async () => []),
  refreshStepStallCandidate: vi.fn(),
  dropStepStallCandidate: vi.fn(),
  stepStallNextCheckAtMs: vi.fn(() => 0),
  STEP_STALL_SCAN_INTERVAL_MS: 30_000,
  TIMER_MAX_CLAIMS: 5,
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
  getSessionDryRunLink: (...args: unknown[]) => mockGetSessionDryRunLink(...args),
  getStepState: vi.fn(),
  isSessionCorrupt: vi.fn(async () => false),
  shardFor: vi.fn(() => 0),
  validateShardOwnership: vi.fn(),
  claimDueShardTimers: (...args: unknown[]) => mockClaimDueShardTimers(...args),
  ackShardTimer: (...args: unknown[]) => mockAckShardTimer(...(args as [])),
  ackShardTimerById: vi.fn(async () => true),
  timerId: (t: { stepExecutionId: string; reason: string; attempt: number }) =>
    `${t.stepExecutionId}|${t.reason}|${String(t.attempt)}|`,
  rescheduleClaimedTimer: vi.fn(async () => undefined),
  updateSessionState: vi.fn(),
  appendSessionEvent: vi.fn(),
  markSessionDirty: vi.fn(),
  updateStepState: vi.fn(async () => undefined),
  removeWaitingChild: vi.fn(),
}));

vi.mock('../executorWait.js', () => ({
  dispatchOrWaitOnExecutor: (...args: unknown[]) => mockDispatchOrWaitOnExecutor(...(args as [])),
  failedDispatchResult: vi.fn(),
  lookAgainForExecutor: vi.fn(),
  rearmExecutorWait: vi.fn(),
}));

vi.mock('@aflow/database', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readWorkflowRunDryRun: (...args: unknown[]) => mockReadWorkflowRunDryRun(...args),
  readDryRunSession: (...args: unknown[]) => mockReadDryRunSession(...args),
}));

import type { PayloadStore } from '@aflow/payload-store';
import {
  TimerItemSchema,
  type StepResultMessage,
  type TimerItem,
  type WorkflowExecutionRef,
} from '@aflow/schemas';
import { createProcessDueTimers } from '../timers.js';
import { processWorkflowCorrelatedTimer } from '../workflowTimerDispatch.js';
import type { SessionOrchestratorBindings } from '../../lifecycle/context.js';

const TENANT = '11111111-1111-4111-9111-111111111111';
const RUN_ID = '22222222-2222-4222-9222-222222222222';
const SESSION_ID = '33333333-3333-4333-9333-333333333333';
const STEP_EXEC_ID = '44444444-4444-4444-9444-444444444444';
const SPACE_ID = '55555555-5555-4555-9555-555555555555';
const DRY_RUN = '66666666-6666-4666-9666-666666666666';

function inline(value: unknown): string {
  return `inline:${Buffer.from(JSON.stringify(value)).toString('base64')}`;
}

const WRITE_INPUT = inline({ path: '/portfolio/ledger.json', content: { inlineJson: {} } });

const payloadStore = {
  retrieve: (ref: string) =>
    Promise.resolve(JSON.parse(Buffer.from(ref.slice('inline:'.length), 'base64').toString())),
  shouldStore: () => false,
} as unknown as PayloadStore;

function sessionTimer(reason: 'retry' | 'delayed_start', operationId: string): TimerItem {
  return TimerItemSchema.parse({
    tenantId: TENANT,
    sessionId: SESSION_ID,
    stepExecutionId: STEP_EXEC_ID,
    stepId: 'memory_put_1',
    operationId,
    stepType: operationId.split('.')[0],
    reason,
    attempt: 2,
    inputRef: WRITE_INPUT,
    traceId: 'trace-dry-run-timer',
    dueAtMs: Date.now(),
  });
}

function makeBindings() {
  const applyResult = vi.fn(async (_args: { result: StepResultMessage }) => undefined);
  const bindings = {
    deps: { db: {} as never, redis: {} as never, payloadStore, consumerName: 'test-consumer' },
    stallWatchdog: { lastStepStallScanMs: Date.now() },
    forceCompleteInFlightStep: vi.fn(),
    applyResult,
  } as unknown as SessionOrchestratorBindings;
  return { bindings, applyResult };
}

async function fire(timer: TimerItem) {
  mockClaimDueShardTimers.mockResolvedValueOnce({
    timers: [timer],
    poisoned: [],
    malformedPoisoned: [],
    oldestDueAgeMs: 0,
  });
  const { bindings, applyResult } = makeBindings();
  await createProcessDueTimers(bindings)();
  return applyResult;
}

function heldResult(): StepResultMessage {
  expect(mockAddStepResult).toHaveBeenCalledTimes(1);
  return (mockAddStepResult.mock.calls[0] as unknown[])[1] as StepResultMessage;
}

beforeEach(() => {
  mockClaimDueShardTimers.mockReset().mockResolvedValue({
    timers: [],
    poisoned: [],
    malformedPoisoned: [],
    oldestDueAgeMs: 0,
  });
  mockGetSessionState.mockReset();
  mockGetSessionDryRunLink.mockReset().mockResolvedValue(null);
  mockReadDryRunSession.mockReset().mockResolvedValue(null);
  mockAddStepResult.mockClear();
  mockAckShardTimer.mockClear();
  mockDispatchOrWaitOnExecutor.mockClear();
  mockReadWorkflowRunDryRun.mockReset();
});

describe('a session timer dispatching a dry run write', () => {
  it.each(['retry', 'delayed_start'] as const)(
    'holds the write when a %s timer fires, and sends no job',
    async (reason) => {
      mockGetSessionState.mockResolvedValue({ spaceId: SPACE_ID, dryRunOf: DRY_RUN });

      const applyResult = await fire(sessionTimer(reason, 'memory.store.put'));

      expect(mockDispatchOrWaitOnExecutor).not.toHaveBeenCalled();
      expect(applyResult).not.toHaveBeenCalled();
      const result = heldResult();
      expect(result.status).toBe('SUCCEEDED');
      expect(result.attempt).toBe(2);
      expect(result.heldWrite).toMatchObject({ runId: DRY_RUN, operationId: 'memory.store.put' });
      expect(mockAckShardTimer).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['retry', 'delayed_start'] as const)(
    'holds the write from the run row when a %s timer finds the hash corrupt or deleted',
    async (reason) => {
      // A corrupt hash is quarantined and deleted by the read, which answers null.
      mockGetSessionState.mockResolvedValue(null);
      mockReadDryRunSession.mockResolvedValue({ runId: DRY_RUN, taskId: 'record-ledger' });
      mockReadWorkflowRunDryRun.mockResolvedValue(true);

      const applyResult = await fire(sessionTimer(reason, 'memory.store.put'));

      expect(mockReadDryRunSession).toHaveBeenCalledWith(expect.anything(), TENANT, SESSION_ID);
      expect(mockReadWorkflowRunDryRun).toHaveBeenCalledWith(expect.anything(), TENANT, DRY_RUN);
      expect(mockDispatchOrWaitOnExecutor).not.toHaveBeenCalled();
      expect(applyResult).not.toHaveBeenCalled();
      expect(heldResult().heldWrite).toMatchObject({ runId: DRY_RUN });
      expect(mockAckShardTimer).toHaveBeenCalledTimes(1);
    },
  );

  it('holds the write from the run row when the state read throws', async () => {
    mockGetSessionState.mockRejectedValue(new Error('redis timeout'));
    mockGetSessionDryRunLink.mockRejectedValue(new Error('redis timeout'));
    mockReadDryRunSession.mockResolvedValue({ runId: DRY_RUN });
    mockReadWorkflowRunDryRun.mockResolvedValue(true);

    const applyResult = await fire(sessionTimer('retry', 'memory.store.put'));

    expect(mockDispatchOrWaitOnExecutor).not.toHaveBeenCalled();
    expect(applyResult).not.toHaveBeenCalled();
    expect(heldResult().heldWrite).toMatchObject({ runId: DRY_RUN });
  });

  it('fails the write without retry when the hash is gone and the run row is unread', async () => {
    mockGetSessionState.mockResolvedValue(null);
    mockReadDryRunSession.mockResolvedValue({ runId: DRY_RUN });
    mockReadWorkflowRunDryRun.mockRejectedValue(new Error('postgres unreachable'));

    const applyResult = await fire(sessionTimer('delayed_start', 'memory.store.put'));

    expect(mockDispatchOrWaitOnExecutor).not.toHaveBeenCalled();
    expect(mockAddStepResult).not.toHaveBeenCalled();
    expect(applyResult).toHaveBeenCalledTimes(1);
    expect(applyResult.mock.calls[0]![0].result.error).toMatchObject({
      code: 'DRY_RUN_STATE_UNAVAILABLE',
      retryable: false,
    });
  });

  it('fails the write without retry when no dry-run status can be read', async () => {
    mockGetSessionState.mockRejectedValue(new Error('redis timeout'));
    mockGetSessionDryRunLink.mockRejectedValue(new Error('redis timeout'));
    mockReadDryRunSession.mockRejectedValue(new Error('postgres unreachable'));

    const applyResult = await fire(sessionTimer('retry', 'memory.store.put'));

    expect(mockDispatchOrWaitOnExecutor).not.toHaveBeenCalled();
    expect(mockAddStepResult).not.toHaveBeenCalled();
    expect(applyResult).toHaveBeenCalledTimes(1);
    const { result } = applyResult.mock.calls[0]![0];
    expect(result.status).toBe('FAILED');
    expect(result.error).toMatchObject({ code: 'DRY_RUN_STATE_UNAVAILABLE', retryable: false });
    expect(mockAckShardTimer).toHaveBeenCalledTimes(1);
  });

  it('dispatches the write of a live session', async () => {
    mockGetSessionState.mockResolvedValue({ spaceId: SPACE_ID });

    await fire(sessionTimer('retry', 'memory.store.put'));

    expect(mockAddStepResult).not.toHaveBeenCalled();
    expect(mockDispatchOrWaitOnExecutor).toHaveBeenCalledTimes(1);
  });

  it('leaves the timer for redelivery when a step no dry run holds cannot read its state', async () => {
    mockGetSessionState.mockRejectedValue(new Error('redis timeout'));

    const applyResult = await fire(sessionTimer('retry', 'memory.store.get'));

    expect(mockGetSessionDryRunLink).not.toHaveBeenCalled();
    expect(mockReadDryRunSession).not.toHaveBeenCalled();
    expect(mockDispatchOrWaitOnExecutor).not.toHaveBeenCalled();
    expect(applyResult).not.toHaveBeenCalled();
    expect(mockAckShardTimer).not.toHaveBeenCalled();
  });
});

describe('a poll cycle timer of a dry run operation task', () => {
  const workflowExecution: WorkflowExecutionRef = {
    runId: RUN_ID,
    taskId: 'record-ledger',
    attempt: 1,
    dispatchAttemptToken: `dispatch:${RUN_ID}:record-ledger:1:poll:2`,
  };

  function pollTimer(operationId: string): TimerItem {
    return TimerItemSchema.parse({
      tenantId: TENANT,
      workflowExecution,
      stepExecutionId: STEP_EXEC_ID,
      stepId: 'record-ledger',
      operationId,
      stepType: operationId.split('.')[0],
      reason: 'delayed_start',
      attempt: 1,
      inputRef: WRITE_INPUT,
      traceId: 'trace-poll-cycle',
      dueAtMs: Date.now(),
      spaceId: SPACE_ID,
    });
  }

  const deps = { db: {} as never, redis: {} as never, payloadStore };

  it('holds the write on the cycle the timer dispatches, from the run row alone', async () => {
    mockReadWorkflowRunDryRun.mockResolvedValue(true);

    await processWorkflowCorrelatedTimer(deps, pollTimer('memory.store.put'), workflowExecution);

    expect(mockDispatchOrWaitOnExecutor).not.toHaveBeenCalled();
    const result = heldResult();
    expect(result.status).toBe('SUCCEEDED');
    expect(result.workflowExecution).toEqual(workflowExecution);
    expect(result.idempotencyKey).toBe(workflowExecution.dispatchAttemptToken);
    expect(result.heldWrite).toMatchObject({ runId: RUN_ID, operationId: 'memory.store.put' });
    expect(mockReadWorkflowRunDryRun).toHaveBeenCalledWith(expect.anything(), TENANT, RUN_ID);
    // An operation task has no session hash to lose: none is read.
    expect(mockGetSessionState).not.toHaveBeenCalled();
    expect(mockGetSessionDryRunLink).not.toHaveBeenCalled();
  });

  it('sends nothing when the run cannot be read', async () => {
    mockReadWorkflowRunDryRun.mockRejectedValue(new Error('postgres unreachable'));

    await processWorkflowCorrelatedTimer(deps, pollTimer('memory.store.put'), workflowExecution);

    expect(mockDispatchOrWaitOnExecutor).not.toHaveBeenCalled();
    expect(mockAddStepResult).not.toHaveBeenCalled();
  });

  it('dispatches the write of a live run', async () => {
    mockReadWorkflowRunDryRun.mockResolvedValue(false);

    await processWorkflowCorrelatedTimer(deps, pollTimer('memory.store.put'), workflowExecution);

    expect(mockAddStepResult).not.toHaveBeenCalled();
    expect(mockDispatchOrWaitOnExecutor).toHaveBeenCalledTimes(1);
  });

  it('reads no run for an operation no dry run holds', async () => {
    await processWorkflowCorrelatedTimer(deps, pollTimer('memory.store.get'), workflowExecution);

    expect(mockReadWorkflowRunDryRun).not.toHaveBeenCalled();
    expect(mockDispatchOrWaitOnExecutor).toHaveBeenCalledTimes(1);
  });
});
