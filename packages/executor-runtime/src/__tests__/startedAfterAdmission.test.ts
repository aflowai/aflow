/**
 * A step under an operation limit is marked started once it is admitted, not
 * when it is claimed: while it waits for its slot it is SCHEDULED, with no
 * `startedAt` and no `StepStarted` event, so a run never shows a queued
 * commission as running and its duration starts when the work does. The wait
 * is counted in `queueWaitMs`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { redisMock } = vi.hoisted(() => ({
  redisMock: {
    getStepState: vi.fn(),
    updateStepState: vi.fn().mockResolvedValue(undefined),
    appendSessionEvent: vi.fn().mockResolvedValue(undefined),
    registerStepInFlight: vi.fn().mockResolvedValue(undefined),
    extendStepInFlight: vi.fn().mockResolvedValue(undefined),
    clearStepInFlight: vi.fn().mockResolvedValue(undefined),
    wasStepCancelled: vi.fn().mockResolvedValue(false),
    releaseStepJob: vi.fn().mockResolvedValue('2-0'),
    StepJobNotPendingError: class StepJobNotPendingError extends Error {},
  },
}));
vi.mock('@aflow/redis', () => redisMock);

const { reportingMock } = vi.hoisted(() => ({
  reportingMock: {
    acknowledgeJob: vi.fn().mockResolvedValue(undefined),
    emitFailure: vi.fn().mockResolvedValue(undefined),
    emitResult: vi.fn().mockResolvedValue(undefined),
    emitSuccess: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../executor/resultReporting.js', () => reportingMock);

vi.mock('../executor/buildContext.js', () => ({
  buildExecutionContext: vi.fn((_deps: unknown, job: unknown) =>
    Promise.resolve({
      job,
      outputExists: () => Promise.resolve(undefined),
      stepDefinition: undefined,
    }),
  ),
}));

import type { ConcurrencyLimiter } from '../concurrency.js';
import { processJob } from '../executor/processJob.js';

const SCHEDULED_AT = 1_800_000_000_000;
/** How long the step waits for its slot: longer than any pickup grace. */
const SLOT_WAIT_MS = 10 * 60_000;

const HARNESS_JOB = {
  tenantId: 't1',
  sessionId: 'session-1',
  stepExecutionId: 'run-queued',
  stepType: 'host',
  stepId: 'implement',
  attempt: 1,
  operationId: 'host.harness.run',
  inputRef: 'inline:e30=',
} as never;

const slotController = {
  held: true,
  release: () => undefined,
  acquire: () => Promise.resolve(),
};

/** A limiter that is full until the test admits the one step waiting on it. */
function fakeLimiter(): { limiter: ConcurrencyLimiter; admit: () => void } {
  let admit: () => void = () => undefined;
  const limiter = {
    limit: 1,
    tryAcquire: () => false,
    acquire: () =>
      new Promise<void>((resolve) => {
        admit = resolve;
      }),
    release: vi.fn(),
  };
  return { limiter: limiter as unknown as ConcurrencyLimiter, admit: () => admit() };
}

const startedWrites = (): unknown[] =>
  redisMock.updateStepState.mock.calls.filter(
    ([, , , patch]: [unknown, unknown, unknown, { status?: string }]) => patch.status === 'STARTED',
  );

describe('processJob — a step marked started once admitted to its slot', () => {
  let execute: ReturnType<typeof vi.fn>;
  let stepStarted: ReturnType<typeof vi.fn>;

  function host(limiter: ConcurrencyLimiter) {
    return {
      config: { consumerName: 'host-test', defaultTimeoutMs: 60_000 },
      deps: { redis: {} },
      handlers: new Map([['host', { stepType: 'host', execute }]]),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      abortControllers: new Map<string, AbortController>(),
      operationLimiters: new Map([['host.harness.run', limiter]]),
      claimingStopped: new AbortController().signal,
      stopped: new AbortController().signal,
      stepStarted,
    } as never;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ now: SCHEDULED_AT });
    redisMock.getStepState.mockResolvedValue({
      status: 'SCHEDULED',
      attempt: 1,
      scheduledAt: SCHEDULED_AT,
    });
    execute = vi.fn().mockResolvedValue({ status: 'SUCCEEDED', outputRef: 'inline:e30=' });
    stepStarted = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('records nothing started while the step waits, though it keeps its claim alive', async () => {
    const { limiter, admit } = fakeLimiter();
    const processing = processJob(host(limiter), '1-0', HARNESS_JOB, slotController);
    await vi.advanceTimersByTimeAsync(SLOT_WAIT_MS);

    expect(startedWrites()).toHaveLength(0);
    expect(redisMock.appendSessionEvent).not.toHaveBeenCalled();
    expect(stepStarted).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(redisMock.registerStepInFlight.mock.calls.length).toBeGreaterThan(1);

    admit();
    await processing;
  });

  it('marks it started on admission, before it runs, with the slot wait in `queueWaitMs`', async () => {
    const { limiter, admit } = fakeLimiter();
    const processing = processJob(host(limiter), '1-0', HARNESS_JOB, slotController);
    await vi.advanceTimersByTimeAsync(SLOT_WAIT_MS);
    admit();
    await processing;

    expect(startedWrites()).toEqual([
      [
        {},
        't1',
        'run-queued',
        { sessionId: 'session-1', status: 'STARTED', startedAt: SCHEDULED_AT + SLOT_WAIT_MS },
      ],
    ]);
    const [event] = redisMock.appendSessionEvent.mock.calls.map(([, , , e]: unknown[]) => e);
    expect(event).toMatchObject({
      eventType: 'StepStarted',
      timestamp: SCHEDULED_AT + SLOT_WAIT_MS,
      metadata: { operationId: 'host.harness.run', queueWaitMs: SLOT_WAIT_MS },
    });
    const startedOrder = redisMock.updateStepState.mock.invocationCallOrder[0] ?? Infinity;
    expect(startedOrder).toBeLessThan(execute.mock.invocationCallOrder[0] ?? 0);
    expect(stepStarted).toHaveBeenCalledTimes(1);
    expect(reportingMock.emitResult).toHaveBeenCalledTimes(1);
  });

  it('marks nothing started for a step cancelled while it waited', async () => {
    const { limiter, admit } = fakeLimiter();
    const processing = processJob(host(limiter), '1-0', HARNESS_JOB, slotController);
    await vi.advanceTimersByTimeAsync(SLOT_WAIT_MS);
    redisMock.wasStepCancelled.mockResolvedValueOnce(true);
    admit();
    await processing;

    expect(startedWrites()).toHaveLength(0);
    expect(redisMock.appendSessionEvent).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
