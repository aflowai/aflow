import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantId, WorkflowTask, WorkflowTaskPoll } from '@aflow/schemas';
import type { WorkflowRunDetail, WorkflowTaskRow } from '@aflow/cybernetic-runtime';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockAdvanceTaskPollCycle = vi.fn(() => Promise.resolve(true));
vi.mock('@aflow/cybernetic-runtime', async () => {
  const actual = await vi.importActual<typeof import('@aflow/cybernetic-runtime')>(
    '@aflow/cybernetic-runtime',
  );
  return {
    ...actual,
    advanceTaskPollCycle: (...args: unknown[]) => mockAdvanceTaskPollCycle(...(args as [])),
  };
});

const mockScheduleShardTimer = vi.fn(() => Promise.resolve());
const mockGetSessionState = vi.fn(() => Promise.resolve(null));
vi.mock('@aflow/redis', async () => {
  const actual = await vi.importActual<typeof import('@aflow/redis')>('@aflow/redis');
  return {
    ...actual,
    scheduleShardTimer: (...args: unknown[]) => mockScheduleShardTimer(...(args as [])),
    getSessionState: (...args: unknown[]) => mockGetSessionState(...(args as [])),
  };
});

const { applyPollGate, decidePollCycle, parsePollCycleFromToken, stampPollIntoOutput } =
  await import('../pollPolicy.js');
const { DISPATCH_PENDING_INTERVAL_MS } = await import('../operationTaskDispatch.js');

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TENANT = '00000000-0000-0000-0000-000000000001' as TenantId;
const RUN_ID = 'run-1';
const TASK_ID = 'poll-lb';
const ATTEMPT = 1;
const BASE_TOKEN = `dispatch:${RUN_ID}:${TASK_ID}:${String(ATTEMPT)}`;

const POLL: WorkflowTaskPoll = {
  intervalMs: 60_000,
  maxCycles: 3,
  until: { anyOf: ["output.status == 'COMPLETE'", "output.status == 'ERROR'"] },
  onExhausted: 'complete',
};

function taskDef(over?: Partial<WorkflowTask>): WorkflowTask {
  return {
    taskId: TASK_ID,
    name: 'Poll LB',
    goal: 'poll',
    type: 'operation',
    operation: 'mcp.tool.call',
    poll: POLL,
    ...over,
  } as WorkflowTask;
}

function taskRow(over?: Partial<WorkflowTaskRow>): WorkflowTaskRow {
  return {
    id: 'row-1',
    runId: RUN_ID,
    taskId: TASK_ID,
    status: 'running',
    attempt: ATTEMPT,
    sessionId: null,
    workerSessionId: 'worker-1',
    startedAt: new Date(),
    completedAt: null,
    durationMs: null,
    costCents: null,
    metricsJson: null,
    summary: null,
    failureReason: null,
    outputRef: null,
    inputRef: 'inline:e30=', // {}
    reflectionJson: null,
    operationId: 'mcp.tool.call',
    errorCode: null,
    errorClassification: null,
    errorRetryable: null,
    failedAt: null,
    priorFailures: null,
    pollCycle: 1,
    ...over,
  };
}

const run = {
  spaceId: '00000000-0000-0000-0000-00000000000a',
  sessionId: null,
} as unknown as WorkflowRunDetail;

function makePayloadStore(raw: unknown) {
  const stored: Array<{ kind: string; data: unknown; stepExecutionId: string }> = [];
  return {
    stored,
    payloadStore: {
      retrieve: vi.fn(() => Promise.resolve(raw)),
      store: vi.fn((params: { kind: string; data: unknown; stepExecutionId: string }) => {
        stored.push(params);
        return Promise.resolve(`ref:stamped:${String(stored.length)}`);
      }),
    },
  };
}

function deps(payloadStore: unknown) {
  return {
    db: {} as never,
    redis: {} as never,
    payloadStore: payloadStore as never,
  };
}

function gateArgs(over?: {
  token?: string;
  row?: WorkflowTaskRow;
  def?: WorkflowTask | null;
  outputRef?: string;
}) {
  return {
    tenantId: TENANT,
    run,
    taskRow: over?.row ?? taskRow(),
    taskDef: over?.def === undefined ? taskDef() : over.def,
    workflowExecution: {
      runId: RUN_ID,
      taskId: TASK_ID,
      attempt: ATTEMPT,
      dispatchAttemptToken: over?.token ?? BASE_TOKEN,
    },
    outcome: { kind: 'succeeded' as const, outputRef: over?.outputRef ?? 'ref:raw' },
  };
}

beforeEach(() => {
  mockAdvanceTaskPollCycle.mockClear();
  mockAdvanceTaskPollCycle.mockResolvedValue(true);
  mockScheduleShardTimer.mockClear();
  mockGetSessionState.mockClear();
});

// ── Pure decision machine ────────────────────────────────────────────────────

describe('parsePollCycleFromToken', () => {
  it('base token (first dispatch) is cycle 1 — regardless of attempt', () => {
    expect(parsePollCycleFromToken('dispatch:r:t:1', 99)).toBe(1);
    expect(parsePollCycleFromToken('dispatch:r:t:3', 99)).toBe(1);
  });

  it('poll-suffixed tokens carry their cycle', () => {
    expect(parsePollCycleFromToken('dispatch:r:t:1:poll:2', 1)).toBe(2);
    expect(parsePollCycleFromToken('dispatch:r:t:4:poll:17', 1)).toBe(17);
  });

  it('falls back to the row cycle when the token is absent', () => {
    expect(parsePollCycleFromToken(undefined, 3)).toBe(3);
  });
});

describe('decidePollCycle', () => {
  it('condition met → terminal completion with conditionMet stamp', () => {
    expect(decidePollCycle(POLL, 2, { status: 'COMPLETE' })).toEqual({
      kind: 'complete',
      stamp: { cycles: 2, exhausted: false, conditionMet: true },
    });
  });

  it('condition unmet with cycles left → next cycle', () => {
    expect(decidePollCycle(POLL, 1, { status: 'PENDING' })).toEqual({
      kind: 'next_cycle',
      nextCycle: 2,
    });
  });

  it('exhaustion with onExhausted complete → completes with exhausted stamp', () => {
    expect(decidePollCycle(POLL, 3, { status: 'PENDING' })).toEqual({
      kind: 'complete',
      stamp: { cycles: 3, exhausted: true, conditionMet: false },
    });
  });

  it("exhaustion with onExhausted 'fail' → structured failure", () => {
    const decision = decidePollCycle({ ...POLL, onExhausted: 'fail' }, 3, { status: 'PENDING' });
    expect(decision.kind).toBe('fail');
    if (decision.kind === 'fail') {
      expect(decision.errorCode).toBe('POLL_BUDGET_EXHAUSTED');
    }
  });

  it('missing until path counts as unmet, never failure', () => {
    expect(decidePollCycle(POLL, 1, {}).kind).toBe('next_cycle');
    expect(decidePollCycle(POLL, 1, null).kind).toBe('next_cycle');
  });

  it('maxCycles 1 evaluates once and exhausts immediately', () => {
    const decision = decidePollCycle({ ...POLL, maxCycles: 1 }, 1, { status: 'PENDING' });
    expect(decision).toEqual({
      kind: 'complete',
      stamp: { cycles: 1, exhausted: true, conditionMet: false },
    });
  });
});

describe('stampPollIntoOutput', () => {
  it('stamps _poll alongside the raw output fields', () => {
    expect(
      stampPollIntoOutput(
        { status: 'PENDING', publicScore: null },
        { cycles: 5, exhausted: true, conditionMet: false },
      ),
    ).toEqual({
      status: 'PENDING',
      publicScore: null,
      _poll: { cycles: 5, exhausted: true, conditionMet: false },
    });
  });

  it('degrades non-object raw output to a bare _poll stamp', () => {
    expect(
      stampPollIntoOutput('raw-text', { cycles: 1, exhausted: false, conditionMet: true }),
    ).toEqual({ _poll: { cycles: 1, exhausted: false, conditionMet: true } });
  });
});

// ── Harness gate ─────────────────────────────────────────────────────────────

describe('applyPollGate', () => {
  it('passes non-polled tasks straight through', async () => {
    const { payloadStore } = makePayloadStore({ status: 'PENDING' });
    const result = await applyPollGate(
      deps(payloadStore),
      gateArgs({ def: taskDef({ poll: undefined } as Partial<WorkflowTask>) }),
    );
    expect(result).toEqual({
      kind: 'proceed',
      outcome: { kind: 'succeeded', outputRef: 'ref:raw' },
    });
    expect(mockAdvanceTaskPollCycle).not.toHaveBeenCalled();
  });

  it('drops a stale cycle result without touching the row or timers', async () => {
    const { payloadStore } = makePayloadStore({ status: 'COMPLETE' });
    const result = await applyPollGate(
      deps(payloadStore),
      gateArgs({ token: `${BASE_TOKEN}:poll:2`, row: taskRow({ pollCycle: 3 }) }),
    );
    expect(result).toEqual({ kind: 'handled' });
    expect(mockAdvanceTaskPollCycle).not.toHaveBeenCalled();
    expect(mockScheduleShardTimer).not.toHaveBeenCalled();
  });

  it('condition met → proceeds with a NEW _poll-stamped output payload', async () => {
    const { payloadStore, stored } = makePayloadStore({ status: 'COMPLETE', publicScore: '0.75' });
    const result = await applyPollGate(deps(payloadStore), gateArgs());
    expect(result).toEqual({
      kind: 'proceed',
      outcome: { kind: 'succeeded', outputRef: 'ref:stamped:1' },
    });
    expect(stored[0]!.kind).toBe('output');
    expect(stored[0]!.data).toEqual({
      status: 'COMPLETE',
      publicScore: '0.75',
      _poll: { cycles: 1, exhausted: false, conditionMet: true },
    });
    // Distinct ref namespace — never the executor's step-output ref.
    expect(stored[0]!.stepExecutionId).toBe(`${TASK_ID}:poll`);
    expect(mockAdvanceTaskPollCycle).not.toHaveBeenCalled();
  });

  it('condition unmet → CAS-advances the cycle and arms the workflow-correlated timer', async () => {
    const { payloadStore } = makePayloadStore({ status: 'PENDING' });
    const before = Date.now();
    const result = await applyPollGate(deps(payloadStore), gateArgs());
    expect(result).toEqual({ kind: 'handled' });

    expect(mockAdvanceTaskPollCycle).toHaveBeenCalledTimes(1);
    const casArgs = mockAdvanceTaskPollCycle.mock.calls[0]![2] as {
      fromCycle: number;
      toCycle: number;
      stepExecutionId: string;
      dueAt: Date;
    };
    expect(casArgs.fromCycle).toBe(1);
    expect(casArgs.toCycle).toBe(2);
    // completion_pending re-arm covers the wait + the supervision window.
    expect(casArgs.dueAt.getTime()).toBeGreaterThanOrEqual(
      before + POLL.intervalMs + DISPATCH_PENDING_INTERVAL_MS,
    );

    expect(mockScheduleShardTimer).toHaveBeenCalledTimes(1);
    const timer = mockScheduleShardTimer.mock.calls[0]![1] as {
      workflowExecution: { dispatchAttemptToken: string; attempt: number };
      stepExecutionId: string;
      reason: string;
      dueAtMs: number;
      inputRef: string;
      operationId: string;
    };
    expect(timer.reason).toBe('delayed_start');
    expect(timer.workflowExecution.dispatchAttemptToken).toBe(`${BASE_TOKEN}:poll:2`);
    // attempt unchanged — cycles are NOT attempts (budget separation).
    expect(timer.workflowExecution.attempt).toBe(ATTEMPT);
    expect(timer.dueAtMs).toBeGreaterThanOrEqual(before + POLL.intervalMs);
    expect(timer.stepExecutionId).toBe(casArgs.stepExecutionId);
    expect(timer.stepExecutionId).not.toBe('worker-1');
    expect(timer.inputRef).toBe('inline:e30=');
    expect(timer.operationId).toBe('mcp.tool.call');
  });

  it('poll-cycle CAS miss → handled (duplicate), timer NOT armed', async () => {
    mockAdvanceTaskPollCycle.mockResolvedValueOnce(false);
    const { payloadStore } = makePayloadStore({ status: 'PENDING' });
    const result = await applyPollGate(deps(payloadStore), gateArgs());
    expect(result).toEqual({ kind: 'handled' });
    expect(mockScheduleShardTimer).not.toHaveBeenCalled();
  });

  it('exhaustion (complete) → proceeds succeeded with exhausted stamp + last raw output', async () => {
    const { payloadStore, stored } = makePayloadStore({ status: 'PENDING' });
    const result = await applyPollGate(
      deps(payloadStore),
      gateArgs({ token: `${BASE_TOKEN}:poll:3`, row: taskRow({ pollCycle: 3 }) }),
    );
    expect(result).toEqual({
      kind: 'proceed',
      outcome: { kind: 'succeeded', outputRef: 'ref:stamped:1' },
    });
    expect(stored[0]!.data).toEqual({
      status: 'PENDING',
      _poll: { cycles: 3, exhausted: true, conditionMet: false },
    });
    expect(mockScheduleShardTimer).not.toHaveBeenCalled();
  });

  it('exhaustion (fail) → proceeds with a non-retryable POLL_BUDGET_EXHAUSTED failure', async () => {
    const { payloadStore } = makePayloadStore({ status: 'PENDING' });
    const result = await applyPollGate(
      deps(payloadStore),
      gateArgs({
        token: `${BASE_TOKEN}:poll:3`,
        row: taskRow({ pollCycle: 3 }),
        def: taskDef({ poll: { ...POLL, onExhausted: 'fail' } }),
      }),
    );
    expect(result.kind).toBe('proceed');
    if (result.kind === 'proceed') {
      expect(result.outcome.kind).toBe('failed');
      if (result.outcome.kind === 'failed') {
        expect(result.outcome.errorCode).toBe('POLL_BUDGET_EXHAUSTED');
        expect(result.outcome.errorRetryable).toBe(false);
      }
    }
  });

  it('unreadable raw output → completes un-stamped with the original ref (conservative)', async () => {
    const payloadStore = {
      retrieve: vi.fn(() => Promise.reject(new Error('gone'))),
      store: vi.fn(),
    };
    const result = await applyPollGate(deps(payloadStore), gateArgs());
    expect(result).toEqual({
      kind: 'proceed',
      outcome: { kind: 'succeeded', outputRef: 'ref:raw' },
    });
    expect(mockAdvanceTaskPollCycle).not.toHaveBeenCalled();
  });

  it('stamp-store failure degrades to the raw ref instead of failing the task', async () => {
    const payloadStore = {
      retrieve: vi.fn(() => Promise.resolve({ status: 'COMPLETE' })),
      store: vi.fn(() => Promise.reject(new Error('store down'))),
    };
    const result = await applyPollGate(deps(payloadStore), gateArgs());
    expect(result).toEqual({
      kind: 'proceed',
      outcome: { kind: 'succeeded', outputRef: 'ref:raw' },
    });
  });
});
