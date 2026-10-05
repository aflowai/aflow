/**
 * Contract (Plan 315 D21): an executor that wakes refreshes its heartbeat and
 * the in-flight record of every step it holds at its first tick awake, and a
 * started step's record carries a deadline moved later by the sleep, so the
 * orchestrator's readers, held while it does, find a live executor whose steps
 * are still within their time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildOperationId } from '@aflow/schemas';

const { redisMock, wake } = vi.hoisted(() => {
  const wake = { sleptMs: 0 };
  return {
    wake,
    redisMock: {
      ensureConsumerGroup: vi.fn().mockResolvedValue(undefined),
      registerExecutorHeartbeat: vi.fn().mockResolvedValue(undefined),
      unregisterExecutorHeartbeat: vi.fn().mockResolvedValue(undefined),
      createWakeDetector: () => ({
        observe: () => {
          const slept = wake.sleptMs;
          wake.sleptMs = 0;
          return slept;
        },
      }),
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
  };
});
vi.mock('@aflow/redis', () => redisMock);

vi.mock('../executor/resultReporting.js', () => ({
  acknowledgeJob: vi.fn().mockResolvedValue(undefined),
  emitFailure: vi.fn().mockResolvedValue(undefined),
  emitResult: vi.fn().mockResolvedValue(undefined),
  emitSuccess: vi.fn().mockResolvedValue(undefined),
}));

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
import { HEARTBEAT_INTERVAL_MS } from '../executor/constants.js';
import { DEFAULT_EXECUTOR_CONFIG } from '../types.js';

const READ_BLOCK_MS = 5;
const HARNESS_RUN = buildOperationId('host', 'harness', 'run');
const NIGHT_MS = 8 * 60 * 60 * 1000;

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, READ_BLOCK_MS * 4));
}

/** The deadline the step's in-flight record was last written with. */
function lastRecordedDeadline(stepExecutionId: string): number | null | undefined {
  const calls = redisMock.registerStepInFlight.mock.calls.filter(
    (call) => call[1] === stepExecutionId,
  );
  return calls.at(-1)?.[2] as number | null | undefined;
}

describe('ExecutorRuntime — waking from sleep', () => {
  let runtime: ExecutorRuntime;
  let finish: (() => void) | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    wake.sleptMs = 0;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    redisMock.readStepJobs
      .mockResolvedValueOnce([
        {
          id: 'msg-1',
          job: {
            tenantId: 't1',
            stepExecutionId: 'step-1',
            stepType: 'host',
            stepId: 'step-1',
            sessionId: 'session-1',
            attempt: 1,
            operationId: HARNESS_RUN,
            inputRef: 'inline:e30=',
          },
        },
      ])
      .mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve([]), READ_BLOCK_MS)),
      );
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
    runtime.registerHandler({
      stepType: 'host',
      execute: async () => {
        await new Promise<void>((resolve) => (finish = resolve));
        return { status: 'SUCCEEDED', outputRef: 'inline:e30=' } as never;
      },
    });
    await runtime.start();
    await settle();
  });

  afterEach(async () => {
    finish?.();
    await settle();
    await runtime.stop();
    vi.useRealTimers();
  });

  it('refreshes its heartbeat and the running step at the first tick, its deadline moved by the sleep', () => {
    const deadline = runtime.inFlight()[0]?.deadlineAt;
    expect(typeof deadline).toBe('number');
    redisMock.registerExecutorHeartbeat.mockClear();
    redisMock.registerStepInFlight.mockClear();

    wake.sleptMs = NIGHT_MS;
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);

    expect(redisMock.registerExecutorHeartbeat).toHaveBeenCalledTimes(1);
    expect(redisMock.registerStepInFlight).toHaveBeenCalledTimes(1);
    expect(lastRecordedDeadline('step-1')).toBe((deadline as number) + NIGHT_MS);
    expect(runtime.inFlight()).toEqual([
      { name: `${HARNESS_RUN} step-1`, deadlineAt: (deadline as number) + NIGHT_MS },
    ]);
  });

  it('writes no step record on a tick that follows no sleep', () => {
    redisMock.registerStepInFlight.mockClear();

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);

    expect(redisMock.registerExecutorHeartbeat).toHaveBeenCalled();
    expect(redisMock.registerStepInFlight).not.toHaveBeenCalled();
  });
});
