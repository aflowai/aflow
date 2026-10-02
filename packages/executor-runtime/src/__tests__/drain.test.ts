import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { redisMock } = vi.hoisted(() => ({
  redisMock: {
    ensureConsumerGroup: vi.fn().mockResolvedValue(undefined),
    registerExecutorHeartbeat: vi.fn().mockResolvedValue(undefined),
    unregisterExecutorHeartbeat: vi.fn().mockResolvedValue(undefined),
    readStepJobs: vi.fn(),
    listPendingStepJobs: vi.fn().mockResolvedValue([]),
    claimPendingStepJobsByIds: vi.fn().mockResolvedValue([]),
    isExecutorConsumerAlive: vi.fn().mockResolvedValue(false),
    getStepState: vi.fn().mockResolvedValue(null),
    updateStepState: vi.fn().mockResolvedValue(undefined),
    appendSessionEvent: vi.fn().mockResolvedValue(undefined),
    registerStepInFlight: vi.fn().mockResolvedValue(undefined),
    clearStepInFlight: vi.fn().mockResolvedValue(undefined),
    wasStepCancelled: vi.fn().mockResolvedValue(false),
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
  buildExecutionContext: vi.fn().mockResolvedValue({
    outputExists: () => Promise.resolve(undefined),
    stepDefinition: undefined,
  }),
}));

import { ExecutorRuntime } from '../executor/ExecutorRuntime.js';
import { DEFAULT_EXECUTOR_CONFIG } from '../types.js';

const HARNESS_TIMEOUT_MS = 30 * 60_000;
const READ_BLOCK_MS = 5;

const HARNESS_JOB = {
  tenantId: 't1',
  stepExecutionId: 'step-1',
  stepType: 'host',
  stepId: 'implement',
  attempt: 1,
  operationId: 'host.harness.run',
  inputRef: 'inline:e30=',
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function blockingRead(): Promise<never[]> {
  return new Promise((resolve) => setTimeout(() => resolve([]), READ_BLOCK_MS));
}

describe('ExecutorRuntime drain', () => {
  let runtime: ExecutorRuntime;
  let harnessEnds: ReturnType<typeof deferred>;
  let started: ReturnType<typeof deferred>;

  beforeEach(async () => {
    vi.clearAllMocks();
    harnessEnds = deferred();
    started = deferred();
    redisMock.readStepJobs
      .mockResolvedValueOnce([{ id: 'msg-1', job: HARNESS_JOB }])
      .mockImplementation(blockingRead);

    runtime = new ExecutorRuntime(
      {
        ...DEFAULT_EXECUTOR_CONFIG,
        consumerName: 'host-test',
        consumerGroup: 'executor:host',
        streamKey: 'aflow:jobs:host',
        stepType: 'host',
        claimPendingOnStart: false,
        blockMs: READ_BLOCK_MS,
      },
      { redis: {}, redisBlocking: {}, payloadStore: {} } as never,
    );
    runtime.registerHandler({
      stepType: 'host',
      resolveTimeoutMs: () => Promise.resolve(HARNESS_TIMEOUT_MS),
      execute: async () => {
        started.resolve();
        await harnessEnds.promise;
        return { status: 'SUCCEEDED', outputRef: 'inline:e30=' } as never;
      },
    });
    await runtime.start();
    await started.promise;
  });

  afterEach(async () => {
    harnessEnds.resolve();
    await runtime.stop();
  });

  it('names the step in flight with the deadline its own timeout sets', () => {
    const before = Date.now();
    const [step, ...rest] = runtime.inFlight();

    expect(rest).toEqual([]);
    expect(step?.name).toBe('host.harness.run step-1');
    expect(step?.deadlineAt).toBeGreaterThan(before);
    expect(step?.deadlineAt).toBeLessThanOrEqual(before + HARNESS_TIMEOUT_MS);
    expect(step?.deadlineAt).toBeGreaterThan(before + HARNESS_TIMEOUT_MS - 1_000);
  });

  it('stops reading its stream once claiming stops, and the step runs on', async () => {
    runtime.stopClaiming();
    await new Promise((r) => setTimeout(r, READ_BLOCK_MS * 2));
    const reads = redisMock.readStepJobs.mock.calls.length;

    await new Promise((r) => setTimeout(r, READ_BLOCK_MS * 10));

    expect(redisMock.readStepJobs.mock.calls.length).toBe(reads);
    expect(runtime.inFlight().map((s) => s.name)).toEqual(['host.harness.run step-1']);
    // Proof of life goes on: nothing has unregistered this executor.
    expect(redisMock.unregisterExecutorHeartbeat).not.toHaveBeenCalled();
    expect(reportingMock.acknowledgeJob).not.toHaveBeenCalled();
  });

  it('leaves jobs that a read already in progress returns pending', async () => {
    const lateRead = deferred();
    redisMock.readStepJobs.mockImplementationOnce(async () => {
      await lateRead.promise;
      return [{ id: 'msg-2', job: { ...HARNESS_JOB, stepExecutionId: 'step-2' } }];
    });
    await new Promise((r) => setTimeout(r, READ_BLOCK_MS * 2));

    runtime.stopClaiming();
    lateRead.resolve();
    await new Promise((r) => setTimeout(r, READ_BLOCK_MS * 2));

    expect(runtime.inFlight().map((s) => s.name)).toEqual(['host.harness.run step-1']);
  });

  it('is idle once the step in flight ends', async () => {
    runtime.stopClaiming();
    let idle = false;
    void runtime.idle().then(() => {
      idle = true;
    });
    await new Promise((r) => setTimeout(r, READ_BLOCK_MS * 2));
    expect(idle).toBe(false);

    harnessEnds.resolve();
    await runtime.idle();

    expect(runtime.inFlight()).toEqual([]);
    expect(reportingMock.emitResult).toHaveBeenCalledOnce();
    expect(reportingMock.acknowledgeJob).toHaveBeenCalledOnce();
  });
});
