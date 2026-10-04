/**
 * Contract: a runtime says it is busy when its first step starts and idle when
 * its last running step settles — once each for steps that overlap, so a
 * listener holding something for the work (the host executor's hold on sleep)
 * neither drops it between them nor takes it twice.
 */
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
const OPERATION = 'host.harness.run';

function job(stepExecutionId: string) {
  return {
    tenantId: 't1',
    stepExecutionId,
    stepType: 'host',
    stepId: stepExecutionId,
    sessionId: 'session-1',
    attempt: 1,
    operationId: OPERATION,
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
        { id: 'msg-1', job: job('step-1') },
        { id: 'msg-2', job: job('step-2') },
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
      busy: (firstStep) => heard.push(`busy ${firstStep}`),
      idle: () => heard.push('idle'),
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

  it('is busy once for two overlapping steps, named by the first, and idle once when both end', async () => {
    expect(finish.size).toBe(2);
    expect(heard).toEqual([`busy ${OPERATION} step-1`]);

    finish.get('step-1')?.();
    await settle();
    expect(heard).toEqual([`busy ${OPERATION} step-1`]);

    finish.get('step-2')?.();
    await settle();
    expect(heard).toEqual([`busy ${OPERATION} step-1`, 'idle']);
  });

  it('stops telling a listener that stopped following', async () => {
    const later: string[] = [];
    const stop = runtime.onWork({
      busy: () => later.push('busy'),
      idle: () => later.push('idle'),
    });
    stop();

    for (const end of finish.values()) end();
    await settle();

    expect(later).toEqual([]);
    expect(heard).toContain('idle');
  });
});
