import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockLoadPendingWaiters = vi.fn();
const mockMarkWaiterNotified = vi.fn();
const mockRehydratePausedRun = vi.fn();
vi.mock('@aflow/cybernetic-runtime', () => ({
  loadPendingWaiters: (...args: unknown[]) => mockLoadPendingWaiters(...args),
  markWaiterNotified: (...args: unknown[]) => mockMarkWaiterNotified(...args),
  rehydratePausedRun: (...args: unknown[]) => mockRehydratePausedRun(...args),
  rehydrateParkedStep: vi.fn(),
  buildWorkflowRunDetail: vi.fn().mockResolvedValue(null),
  surfaceWorkflowResumeContract: vi.fn().mockResolvedValue(null),
}));

const mockInsertedEvents: unknown[] = [];
vi.mock('@aflow/database', () => ({
  createTenantContext: vi.fn(() => ({})),
  eventLog: {},
  withTenantSchema: vi.fn(async (_db: unknown, _ctx: unknown, cb: (tx: unknown) => unknown) =>
    cb({
      insert: () => ({
        values: (row: unknown) => {
          mockInsertedEvents.push(row);
          return { onConflictDoNothing: () => Promise.resolve() };
        },
      }),
    }),
  ),
}));

const mockAppendSessionEvent = vi.fn();
const mockGetSessionStateSafe = vi.fn();
const mockGetStepState = vi.fn();
const mockAddControlMessage = vi.fn();
const mockAddStepResult = vi.fn();
const mockClaimEventDrivenTurn = vi.fn();
const mockClaimDispatch = vi.fn();
vi.mock('@aflow/redis', async () => {
  const { mayWake } = await vi.importActual<typeof import('@aflow/redis')>('@aflow/redis');
  return {
    mayWake,
    appendSessionEvent: (...args: unknown[]) => mockAppendSessionEvent(...args),
    getSessionStateSafe: (...args: unknown[]) => mockGetSessionStateSafe(...args),
    getStepState: (...args: unknown[]) => mockGetStepState(...args),
    addControlMessage: (...args: unknown[]) => mockAddControlMessage(...args),
    addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
    claimEventDrivenTurn: (...args: unknown[]) => mockClaimEventDrivenTurn(...args),
    claimControlDispatchIdempotency: (...args: unknown[]) => mockClaimDispatch(...args),
    releaseControlDispatchIdempotency: vi.fn(),
    updateStepState: vi.fn(),
    updateSessionState: vi.fn(),
    markSessionDirty: vi.fn(),
  };
});

vi.mock('../helpers.js', () => ({
  emitTerminalRunUpdate: vi.fn().mockResolvedValue(undefined),
  loadRunByRunIdAcrossSpaces: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../../lib/orchestratorLogger.js', () => ({
  getOrchestratorLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
  logOrchestratorError: vi.fn(),
}));

import { notifyWaiters } from '../waiters.js';
import { EVENT_DRIVEN_TURNS_PER_MINUTE } from '../sessionWakeup.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001' as never;
const SESSION = '99999999-2222-3333-4444-555555555555';
const RUN = '11111111-2222-3333-4444-555555555555';
const PROMPT_STEP = '00000000-0000-4000-8000-0000000000a1';

const payloadStore = { store: vi.fn(), retrieve: vi.fn() };
const deps = { db: {} as never, redis: {} as never, payloadStore: payloadStore as never };

function sessionWaiter() {
  return { id: 'waiter-1', runId: RUN, waiterSessionId: SESSION, waiterStepExecutionId: null };
}

function restingAtPrompt() {
  mockGetSessionStateSafe.mockResolvedValue({
    ok: true,
    state: { status: 'PAUSED', currentStepExecutionId: PROMPT_STEP, traceId: 'trace-1' },
  });
  mockGetStepState.mockResolvedValue({ operationId: 'ai.agent.turn' });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInsertedEvents.length = 0;
  payloadStore.store.mockResolvedValue('gs://bucket/wakeup-envelope');
  mockLoadPendingWaiters.mockResolvedValue([sessionWaiter()]);
  mockClaimEventDrivenTurn.mockResolvedValue(true);
  mockClaimDispatch.mockResolvedValue({ claimed: true, existingRunId: null });
});

describe('a waiter with no parked step', () => {
  it('appends a WorkflowRunWakeup event carrying the envelope instead of dropping it', async () => {
    mockGetSessionStateSafe.mockResolvedValue({
      ok: true,
      state: { status: 'RUNNING', currentStepExecutionId: PROMPT_STEP },
    });

    await notifyWaiters(deps, { tenantId: TENANT, runId: RUN, outcome: 'completed' });

    expect(mockAddStepResult).not.toHaveBeenCalled();
    const [, , sessionId, event] = mockAppendSessionEvent.mock.calls[0]!;
    expect(sessionId).toBe(SESSION);
    expect(event).toMatchObject({
      eventType: 'WorkflowRunWakeup',
      outputRef: 'gs://bucket/wakeup-envelope',
      metadata: { runId: RUN, outcome: 'completed', waiterId: 'waiter-1' },
    });
    const stored = payloadStore.store.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(stored.data).toMatchObject({ runId: RUN, outcome: 'completed', waiterId: 'waiter-1' });

    // Durable at once: the turn builder reads the log, not the hot stream.
    expect(mockInsertedEvents).toEqual([
      expect.objectContaining({ eventType: 'WorkflowRunWakeup', sessionId: SESSION }),
    ]);
    expect(mockMarkWaiterNotified).toHaveBeenCalledWith(expect.anything(), TENANT, {
      waiterId: 'waiter-1',
      outcome: 'completed',
    });
    // A turn in flight reads it at its next boundary; nothing resumes it.
    expect(mockAddControlMessage).not.toHaveBeenCalled();
  });

  it('stays registered through a pause, so the run’s end still reaches the session', async () => {
    mockGetSessionStateSafe.mockResolvedValue({ ok: true, state: { status: 'RUNNING' } });

    await notifyWaiters(deps, { tenantId: TENANT, runId: RUN, outcome: 'paused' });

    expect(mockAppendSessionEvent).toHaveBeenCalledOnce();
    expect(mockMarkWaiterNotified).not.toHaveBeenCalled();
  });

  it('wakes a session resting at its prompt as a room message with wake does', async () => {
    restingAtPrompt();

    await notifyWaiters(deps, { tenantId: TENANT, runId: RUN, outcome: 'completed' });

    expect(mockAddControlMessage).toHaveBeenCalledOnce();
    const message = mockAddControlMessage.mock.calls[0]![1] as Record<string, unknown>;
    expect(message).toMatchObject({
      type: 'resume_run',
      runId: SESSION,
      stepExecutionId: PROMPT_STEP,
      idempotencyKey: `event-wake:${PROMPT_STEP}`,
    });
    expect(
      JSON.parse(Buffer.from(String(message['inputRef']).slice(7), 'base64').toString()),
    ).toEqual({});
    expect(mockClaimEventDrivenTurn).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      SESSION,
      EVENT_DRIVEN_TURNS_PER_MINUTE,
    );
  });

  it('above the rate, leaves the wakeup for the next turn rather than starting one', async () => {
    restingAtPrompt();
    mockClaimEventDrivenTurn.mockResolvedValue(false);

    await notifyWaiters(deps, { tenantId: TENANT, runId: RUN, outcome: 'completed' });

    expect(mockAppendSessionEvent).toHaveBeenCalledOnce();
    expect(mockAddControlMessage).not.toHaveBeenCalled();
  });

  it('starts one turn for wakeups that land on the same pause', async () => {
    restingAtPrompt();
    mockClaimDispatch
      .mockResolvedValueOnce({ claimed: true, existingRunId: null })
      .mockResolvedValueOnce({ claimed: false, existingRunId: SESSION });
    const otherRun = '22222222-2222-3333-4444-555555555555';
    mockLoadPendingWaiters
      .mockResolvedValueOnce([sessionWaiter()])
      .mockResolvedValueOnce([{ ...sessionWaiter(), id: 'waiter-2', runId: otherRun }]);

    await notifyWaiters(deps, { tenantId: TENANT, runId: RUN, outcome: 'completed' });
    await notifyWaiters(deps, { tenantId: TENANT, runId: otherRun, outcome: 'failed' });

    expect(mockAppendSessionEvent).toHaveBeenCalledTimes(2);
    expect(mockAddControlMessage).toHaveBeenCalledOnce();
  });

  it('leaves a session parked on a blocking start alone', async () => {
    mockGetSessionStateSafe.mockResolvedValue({
      ok: true,
      state: {
        status: 'PAUSED',
        currentStepExecutionId: PROMPT_STEP,
        pauseType: 'external_dependency',
        waitingOnWorkflowRunId: 'another-run',
      },
    });
    mockGetStepState.mockResolvedValue({ operationId: 'workflow.run.start' });

    await notifyWaiters(deps, { tenantId: TENANT, runId: RUN, outcome: 'completed' });

    expect(mockAppendSessionEvent).toHaveBeenCalledOnce();
    expect(mockAddControlMessage).not.toHaveBeenCalled();
    expect(mockClaimEventDrivenTurn).not.toHaveBeenCalled();
  });
});
