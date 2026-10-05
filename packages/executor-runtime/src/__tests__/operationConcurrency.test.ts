import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { redisMock } = vi.hoisted(() => ({
  redisMock: {
    ensureConsumerGroup: vi.fn().mockResolvedValue(undefined),
    registerExecutorHeartbeat: vi.fn().mockResolvedValue(undefined),
    unregisterExecutorHeartbeat: vi.fn().mockResolvedValue(undefined),
    createWakeDetector: () => ({ observe: () => 0 }),
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
  buildExecutionContext: vi.fn((_deps: unknown, job: { stepExecutionId: string }) =>
    Promise.resolve({
      job,
      outputExists: () => Promise.resolve(undefined),
      stepDefinition: undefined,
    }),
  ),
}));

import { ExecutorRuntime } from '../executor/ExecutorRuntime.js';
import { DEFAULT_EXECUTOR_CONFIG } from '../types.js';

const LIMITED = 'host.harness.run';
const HARNESS_LIMIT = 2;
const READ_BLOCK_MS = 5;

function job(stepExecutionId: string, operationId: string) {
  return {
    tenantId: 't1',
    stepExecutionId,
    stepType: 'host',
    stepId: stepExecutionId,
    sessionId: 'session-1',
    attempt: 1,
    operationId,
    inputRef: 'inline:e30=',
  };
}

function blockingRead(): Promise<never[]> {
  return new Promise((resolve) => setTimeout(() => resolve([]), READ_BLOCK_MS));
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, READ_BLOCK_MS * 4));
}

describe('ExecutorRuntime — an operation with a limit of its own', () => {
  let runtime: ExecutorRuntime;
  let running: Set<string>;
  let peak: number;
  let finish: Map<string, () => void>;
  let everStarted: Set<string>;

  const waitingRuns = (): string[] =>
    [1, 2, 3, 4].map((n) => `harness-${String(n)}`).filter((id) => !running.has(id));
  const messageOf = (stepExecutionId: string | undefined): string =>
    `msg-${stepExecutionId?.split('-')[1] ?? ''}`;
  const resultsFor = (stepExecutionId: string | undefined): unknown[] =>
    [reportingMock.emitResult, reportingMock.emitFailure, reportingMock.emitSuccess].flatMap(
      (emit) =>
        emit.mock.calls.filter(
          ([, job]: [unknown, { stepExecutionId: string }]) =>
            job.stepExecutionId === stepExecutionId,
        ),
    );
  const endOneRunning = (): void => {
    const [first] = [...running];
    finish.get(first ?? '')?.();
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    redisMock.getStepState.mockResolvedValue(null);
    redisMock.wasStepCancelled.mockResolvedValue(false);
    everStarted = new Set();
    running = new Set();
    peak = 0;
    finish = new Map();
    redisMock.readStepJobs
      .mockResolvedValueOnce([
        { id: 'msg-1', job: job('harness-1', LIMITED) },
        { id: 'msg-2', job: job('harness-2', LIMITED) },
        { id: 'msg-3', job: job('harness-3', LIMITED) },
        { id: 'msg-4', job: job('harness-4', LIMITED) },
        { id: 'msg-5', job: job('file-1', 'host.file.get') },
      ])
      .mockImplementation(blockingRead);

    runtime = new ExecutorRuntime(
      {
        ...DEFAULT_EXECUTOR_CONFIG,
        consumerName: 'host-test',
        consumerGroup: 'executor:host',
        streamKey: 'aflow:jobs:host',
        stepType: 'host',
        concurrency: 4,
        claimPendingOnStart: false,
        blockMs: READ_BLOCK_MS,
      },
      { redis: {}, redisBlocking: {}, payloadStore: {} } as never,
    );
    runtime.limitOperation(LIMITED, HARNESS_LIMIT);
    runtime.registerHandler({
      stepType: 'host',
      execute: async (ctx) => {
        const { stepExecutionId, operationId } = ctx.job;
        if (operationId !== LIMITED)
          return { status: 'SUCCEEDED', outputRef: 'inline:e30=' } as never;
        running.add(stepExecutionId);
        everStarted.add(stepExecutionId);
        peak = Math.max(peak, running.size);
        await new Promise<void>((resolve) => finish.set(stepExecutionId, resolve));
        running.delete(stepExecutionId);
        return { status: 'SUCCEEDED', outputRef: 'inline:e30=' } as never;
      },
    });
    await runtime.start();
    await settle();
  });

  // Ending what runs admits what waits, so each round ends the newly admitted.
  afterEach(async () => {
    while (runtime.inFlightSteps.size > 0) {
      for (const end of finish.values()) end();
      await settle();
    }
    await runtime.stop();
  });

  it('runs no more than its limit at once, and holds the rest claimed rather than refusing them', () => {
    expect(running.size).toBe(HARNESS_LIMIT);
    expect(
      [...runtime.inFlightSteps.values()].filter((s) => s.operationId === LIMITED),
    ).toHaveLength(4);
    expect(reportingMock.emitFailure).not.toHaveBeenCalled();
    expect(reportingMock.acknowledgeJob).toHaveBeenCalledTimes(1);
  });

  it('lets an operation without a limit of its own run past the waiting ones', () => {
    expect(reportingMock.emitResult).toHaveBeenCalledTimes(1);
    expect(reportingMock.acknowledgeJob).toHaveBeenCalledWith(expect.anything(), 'host', 'msg-5');
  });

  it('admits the next waiting run as one ends, and never more than the limit', async () => {
    const [first] = [...running];
    finish.get(first ?? '')?.();
    await settle();

    expect(running.size).toBe(HARNESS_LIMIT);
    expect(running.has(first ?? '')).toBe(false);

    for (const id of [...running]) finish.get(id)?.();
    await settle();
    for (const id of [...running]) finish.get(id)?.();
    await settle();

    expect(running.size).toBe(0);
    expect(peak).toBe(HARNESS_LIMIT);
    expect(reportingMock.emitResult).toHaveBeenCalledTimes(5);
    expect(reportingMock.emitFailure).not.toHaveBeenCalled();
  });

  it('admits waiting runs at once when the limit is raised', async () => {
    runtime.limitOperation(LIMITED, HARNESS_LIMIT + 1);
    await settle();
    expect(running.size).toBe(HARNESS_LIMIT + 1);
  });

  it('ends nothing when the limit is cut, and admits no one until the runs are under it', async () => {
    runtime.limitOperation(LIMITED, 1);
    await settle();
    expect(running.size).toBe(HARNESS_LIMIT);

    const [first, second] = [...running];
    finish.get(first ?? '')?.();
    await settle();
    expect([...running]).toEqual([second]);

    finish.get(second ?? '')?.();
    await settle();
    expect(running.size).toBe(1);
    expect(running.has(second ?? '')).toBe(false);
  });

  it('names only the started runs as in flight, never one waiting for a slot', () => {
    expect(
      runtime
        .inFlight()
        .filter((s) => s.name.startsWith(LIMITED))
        .map((s) => s.name.split(' ')[1])
        .sort(),
    ).toEqual([...running].sort());
  });

  it('ends the wait of a step cancelled while it waits: it never starts, and gives up its place', async () => {
    const [cancelled, next] = waitingRuns();
    runtime.abortControllers.get(cancelled ?? '')?.abort();
    await settle();

    expect(reportingMock.acknowledgeJob).toHaveBeenCalledWith(
      expect.anything(),
      'host',
      messageOf(cancelled),
    );
    expect(resultsFor(cancelled)).toHaveLength(0);
    expect(reportingMock.emitFailure).not.toHaveBeenCalled();

    endOneRunning();
    await settle();
    expect(running.has(next ?? '')).toBe(true);
    expect(everStarted.has(cancelled ?? '')).toBe(false);
  });

  it('does not start a step whose cancel was recorded while it waited', async () => {
    const [cancelled, next] = waitingRuns();
    redisMock.wasStepCancelled.mockImplementation((_redis: unknown, stepExecutionId: string) =>
      Promise.resolve(stepExecutionId === cancelled),
    );

    endOneRunning();
    await settle();

    expect(everStarted.has(cancelled ?? '')).toBe(false);
    expect(resultsFor(cancelled)).toHaveLength(0);
    expect(running.has(next ?? '')).toBe(true);
    expect(reportingMock.acknowledgeJob).toHaveBeenCalledWith(
      expect.anything(),
      'host',
      messageOf(cancelled),
    );
  });

  it.each([
    ['failed', { attempt: 1, status: 'FAILED' }],
    ['superseded by a newer attempt', { attempt: 2, status: 'SCHEDULED' }],
  ])('does not start a session step %s while it waited, once admitted', async (_, laterState) => {
    const [dropped, next] = waitingRuns();
    redisMock.getStepState.mockImplementation(
      (_redis: unknown, _tenantId: string, stepExecutionId: string) =>
        Promise.resolve(stepExecutionId === dropped ? laterState : null),
    );

    endOneRunning();
    await settle();

    expect(everStarted.has(dropped ?? '')).toBe(false);
    expect(resultsFor(dropped)).toHaveLength(0);
    expect(redisMock.clearStepInFlight).toHaveBeenCalledWith(expect.anything(), dropped);
    expect(running.has(next ?? '')).toBe(true);
    expect(reportingMock.emitFailure).not.toHaveBeenCalled();
  });

  it('keeps a waiting step claimed by refreshing its in-flight record before its timeout is known', () => {
    const waiting = [1, 2, 3, 4]
      .map((n) => `harness-${String(n)}`)
      .filter((id) => !running.has(id));
    for (const id of waiting) {
      expect(redisMock.registerStepInFlight).toHaveBeenCalledWith(expect.anything(), id, null);
      expect(redisMock.registerStepInFlight).not.toHaveBeenCalledWith(
        expect.anything(),
        id,
        expect.any(Number),
      );
    }
  });
});
