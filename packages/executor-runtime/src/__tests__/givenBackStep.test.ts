/**
 * A step still waiting for its operation's slot when claiming stops is given
 * back to its stream. It was already STARTED, so its in-flight record is kept
 * alive until this runtime stops — a lapsed one is a stall to the watchdog.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { redisMock } = vi.hoisted(() => ({
  redisMock: {
    getStepState: vi.fn().mockResolvedValue(null),
    updateStepState: vi.fn().mockResolvedValue(undefined),
    appendSessionEvent: vi.fn().mockResolvedValue(undefined),
    registerStepInFlight: vi.fn().mockResolvedValue(undefined),
    clearStepInFlight: vi.fn().mockResolvedValue(undefined),
    wasStepCancelled: vi.fn().mockResolvedValue(false),
    releaseStepJob: vi.fn().mockResolvedValue('2-0'),
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

import { ConcurrencyLimiter } from '../concurrency.js';
import { STEP_HEARTBEAT_INTERVAL_MS } from '../executor/constants.js';
import { processJob } from '../executor/processJob.js';

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

describe('processJob — a step given back while it waits for a slot', () => {
  let claiming: AbortController;
  let lifetime: AbortController;
  let execute: ReturnType<typeof vi.fn>;

  function host() {
    const full = new ConcurrencyLimiter(1);
    full.tryAcquire();
    return {
      config: { consumerName: 'host-test', defaultTimeoutMs: 1000 },
      deps: { redis: {} },
      handlers: new Map([['host', { stepType: 'host', execute }]]),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      abortControllers: new Map<string, AbortController>(),
      operationLimiters: new Map([['host.harness.run', full]]),
      claimingStopped: claiming.signal,
      stopped: lifetime.signal,
      stepStarted: vi.fn(),
    } as never;
  }

  const inFlightRefreshes = (): number =>
    redisMock.registerStepInFlight.mock.calls.filter(([, id]) => id === 'run-queued').length;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    claiming = new AbortController();
    lifetime = new AbortController();
    execute = vi.fn();
  });

  afterEach(() => {
    lifetime.abort();
    vi.useRealTimers();
  });

  it('hands the job back unworked and keeps its in-flight record alive until the runtime stops', async () => {
    const processing = processJob(host(), '1-0', HARNESS_JOB, slotController);
    await vi.advanceTimersByTimeAsync(0);
    claiming.abort();
    await processing;

    expect(execute).not.toHaveBeenCalled();
    expect(redisMock.releaseStepJob).toHaveBeenCalledWith(expect.anything(), HARNESS_JOB, '1-0');
    expect(reportingMock.acknowledgeJob).not.toHaveBeenCalled();
    expect(reportingMock.emitFailure).not.toHaveBeenCalled();
    expect(redisMock.clearStepInFlight).not.toHaveBeenCalled();

    const beforeRefresh = inFlightRefreshes();
    await vi.advanceTimersByTimeAsync(STEP_HEARTBEAT_INTERVAL_MS);
    expect(inFlightRefreshes()).toBe(beforeRefresh + 1);

    lifetime.abort();
    await vi.advanceTimersByTimeAsync(STEP_HEARTBEAT_INTERVAL_MS * 2);
    expect(inFlightRefreshes()).toBe(beforeRefresh + 1);
  });

  it('drops a step cancelled while it waits, releasing its in-flight record', async () => {
    const jobHost = host();
    const processing = processJob(jobHost, '1-0', HARNESS_JOB, slotController);
    await vi.advanceTimersByTimeAsync(0);
    (jobHost as { abortControllers: Map<string, AbortController> }).abortControllers
      .get('run-queued')
      ?.abort();
    await processing;

    expect(execute).not.toHaveBeenCalled();
    expect(redisMock.releaseStepJob).not.toHaveBeenCalled();
    expect(reportingMock.acknowledgeJob).toHaveBeenCalledWith(expect.anything(), 'host', '1-0');
    expect(reportingMock.emitFailure).not.toHaveBeenCalled();
    expect(redisMock.clearStepInFlight).toHaveBeenCalledWith(expect.anything(), 'run-queued');
  });
});
