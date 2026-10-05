/**
 * Contract: a runtime tells its listeners of each step it runs, once its
 * handler is about to run and again when it settles, naming the step and its
 * operation, so a listener holding something for the work (the host executor's
 * hold on sleep) can follow overlapping steps one by one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildOperationId } from '@aflow/schemas';

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
import { DEFAULT_EXECUTOR_CONFIG } from '../types.js';

const READ_BLOCK_MS = 5;
const HARNESS_RUN = buildOperationId('host', 'harness', 'run');
const PROCESS_EXEC = buildOperationId('host', 'process', 'exec');

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

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, READ_BLOCK_MS * 4));
}

describe('ExecutorRuntime — following its work', () => {
  let runtime: ExecutorRuntime;
  let finish: Map<string, () => void>;
  let heard: string[];

  beforeEach(async () => {
    vi.clearAllMocks();
    finish = new Map();
    heard = [];
    redisMock.readStepJobs
      .mockResolvedValueOnce([
        { id: 'msg-1', job: job('step-1', HARNESS_RUN) },
        { id: 'msg-2', job: job('step-2', PROCESS_EXEC) },
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
    runtime.onWork({
      started: (step) => heard.push(`started ${step.stepExecutionId} ${step.operationId}`),
      settled: (step) => heard.push(`settled ${step.stepExecutionId}`),
    });
    runtime.registerHandler({
      stepType: 'host',
      execute: async (ctx) => {
        await new Promise<void>((resolve) => finish.set(ctx.job.stepExecutionId, resolve));
        return { status: 'SUCCEEDED', outputRef: 'inline:e30=' } as never;
      },
    });
    await runtime.start();
    await settle();
  });

  afterEach(async () => {
    for (const end of finish.values()) end();
    await settle();
    await runtime.stop();
  });

  it('announces each overlapping step with its operation, and each as it settles', async () => {
    expect(finish.size).toBe(2);
    expect(heard).toEqual([`started step-1 ${HARNESS_RUN}`, `started step-2 ${PROCESS_EXEC}`]);

    finish.get('step-2')?.();
    await settle();
    expect(heard.slice(2)).toEqual(['settled step-2']);

    finish.get('step-1')?.();
    await settle();
    expect(heard.slice(2)).toEqual(['settled step-2', 'settled step-1']);
  });

  it('stops telling a listener that stopped following', async () => {
    const later: string[] = [];
    const stop = runtime.onWork({
      started: () => later.push('started'),
      settled: () => later.push('settled'),
    });
    stop();

    for (const end of finish.values()) end();
    await settle();

    expect(later).toEqual([]);
    expect(heard).toContain('settled step-1');
  });
});
