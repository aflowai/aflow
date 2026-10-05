/**
 * Contract: a drain waits for the harness runs that have started, not for the
 * ones still waiting for a slot. Those go back to the stream unworked, the next
 * executor runs them, and no coding agent starts here once the drain began.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Job = { stepExecutionId: string; operationId: string } & Record<string, unknown>;
type Entry = { id: string; job: Job };

const { stream, redisMock } = vi.hoisted(() => {
  const stream = { entries: [] as Entry[], nextId: 1 };
  return {
    stream,
    redisMock: {
      ensureConsumerGroup: vi.fn().mockResolvedValue(undefined),
      registerExecutorHeartbeat: vi.fn().mockResolvedValue(undefined),
      unregisterExecutorHeartbeat: vi.fn().mockResolvedValue(undefined),
      createWakeDetector: () => ({ observe: () => 0 }),
      readStepJobs: vi.fn(),
      listPendingStepJobs: vi.fn().mockResolvedValue([]),
      claimPendingStepJobsByIds: vi.fn().mockResolvedValue([]),
      isExecutorConsumerAlive: vi.fn().mockResolvedValue(true),
      getStepState: vi.fn().mockResolvedValue(null),
      updateStepState: vi.fn().mockResolvedValue(undefined),
      appendSessionEvent: vi.fn().mockResolvedValue(undefined),
      appendLiveDelta: vi.fn().mockResolvedValue(undefined),
      registerStepInFlight: vi.fn().mockResolvedValue(undefined),
      extendStepInFlight: vi.fn().mockResolvedValue(undefined),
      clearStepInFlight: vi.fn().mockResolvedValue(undefined),
      wasStepCancelled: vi.fn().mockResolvedValue(false),
      ackStepJob: vi.fn().mockResolvedValue(undefined),
      addStepResult: vi.fn().mockResolvedValue(undefined),
      releaseStepJob: vi.fn((_redis: unknown, job: Job) => {
        const id = `msg-${String(stream.nextId++)}`;
        stream.entries.push({ id, job });
        return Promise.resolve(id);
      }),
    },
  };
});
vi.mock('@aflow/redis', () => redisMock);

import { ExecutorRuntime, DEFAULT_EXECUTOR_CONFIG } from '@aflow/executor-runtime';
import { createShutdownController } from '@aflow/lib';

import { STEP_TYPE } from '../hostRuntimes.js';

const HARNESS_RUN = 'host.harness.run';
const HARNESS_LIMIT = 2;
const RUNS = 5;
const READ_BLOCK_MS = 5;

const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined };

function harnessJob(n: number): Job {
  return {
    tenantId: 't1',
    sessionId: 'session-1',
    stepExecutionId: `run-${String(n)}`,
    stepType: STEP_TYPE,
    stepId: `run-${String(n)}`,
    attempt: 1,
    operationId: HARNESS_RUN,
    inputRef: 'inline:e30=',
  };
}

/** XREADGROUP over one shared stream: an entry goes to whichever consumer reads it first. */
async function readFromStream(
  _redis: unknown,
  _stepType: string,
  _consumer: string,
  options: { count: number },
): Promise<Entry[]> {
  const delivered = stream.entries.splice(0, options.count);
  if (delivered.length > 0) return delivered;
  await new Promise((resolve) => setTimeout(resolve, READ_BLOCK_MS));
  return [];
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, READ_BLOCK_MS * 4));
}

interface Started {
  consumer: string;
  stepExecutionId: string;
  at: number;
}

describe('draining a host executor with harness runs waiting for a slot', () => {
  let started: Started[];
  let finish: Map<string, () => void>;
  let runtimes: ExecutorRuntime[];

  function hostRuntime(consumer: string): ExecutorRuntime {
    const runtime = new ExecutorRuntime(
      {
        ...DEFAULT_EXECUTOR_CONFIG,
        consumerName: consumer,
        consumerGroup: 'executor:host',
        streamKey: 'aflow:jobs:host',
        stepType: STEP_TYPE,
        concurrency: RUNS + 1,
        claimPendingOnStart: false,
        blockMs: READ_BLOCK_MS,
        batchSize: RUNS,
      },
      {
        redis: {},
        redisBlocking: {},
        payloadStore: { buildRef: () => 'inline:out', exists: () => Promise.resolve(false) },
      } as never,
    );
    runtime.limitOperation(HARNESS_RUN, HARNESS_LIMIT);
    runtime.registerHandler({
      stepType: STEP_TYPE,
      execute: async (ctx) => {
        const { stepExecutionId } = ctx.job;
        started.push({ consumer, stepExecutionId, at: Date.now() });
        await new Promise<void>((resolve) => finish.set(`${consumer} ${stepExecutionId}`, resolve));
        return { status: 'SUCCEEDED', outputRef: 'inline:e30=' } as never;
      },
    });
    runtimes.push(runtime);
    return runtime;
  }

  const startedBy = (consumer: string): string[] =>
    started.filter((s) => s.consumer === consumer).map((s) => s.stepExecutionId);

  beforeEach(() => {
    vi.clearAllMocks();
    redisMock.readStepJobs.mockImplementation(readFromStream);
    stream.entries = Array.from({ length: RUNS }, (_, i) => ({
      id: `msg-${String(i + 1)}`,
      job: harnessJob(i + 1),
    }));
    stream.nextId = RUNS + 1;
    started = [];
    finish = new Map();
    runtimes = [];
  });

  afterEach(async () => {
    for (const end of finish.values()) end();
    await settle();
    for (const runtime of runtimes) await runtime.stop();
  });

  it('ends once the two running runs finish, and the next executor runs the three that waited', async () => {
    const draining = hostRuntime('host-a');
    await draining.start();
    await settle();
    const running = startedBy('host-a');
    expect(running).toHaveLength(HARNESS_LIMIT);
    expect(draining.inFlightSteps.size).toBe(RUNS);

    const endInFlight = vi.fn();
    let shutDown = false;
    const controller = createShutdownController({
      name: 'Host Executor',
      logger: quiet,
      drain: {
        work: {
          stopClaiming: () => {
            draining.stopClaiming();
          },
          inFlight: () => draining.inFlight(),
          whenInFlight: () => draining.whenInFlight(),
          idle: () => draining.idle(),
        },
        endInFlight,
      },
      onShutdown: () => {
        shutDown = true;
        return Promise.resolve();
      },
    });

    const drainBegan = Date.now();
    const drained = controller.drainOnce();
    expect(
      draining
        .inFlight()
        .map((step) => step.name)
        .sort(),
    ).toEqual(running.map((id) => `${HARNESS_RUN} ${id}`).sort());
    await settle();

    const gaveBack = Array.from({ length: RUNS }, (_, i) => harnessJob(i + 1).stepExecutionId)
      .filter((id) => !running.includes(id))
      .sort();
    expect(redisMock.releaseStepJob).toHaveBeenCalledTimes(RUNS - HARNESS_LIMIT);
    expect(stream.entries.map((entry) => entry.job.stepExecutionId).sort()).toEqual(gaveBack);
    // Given back, not consumed: nothing acked or reported for them, and their
    // in-flight records stand for whichever executor reads them next.
    expect(redisMock.ackStepJob).not.toHaveBeenCalled();
    expect(redisMock.addStepResult).not.toHaveBeenCalled();
    for (const id of gaveBack) {
      expect(redisMock.clearStepInFlight).not.toHaveBeenCalledWith(expect.anything(), id);
    }
    expect(shutDown).toBe(false);

    const next = hostRuntime('host-b');
    await next.start();
    await settle();

    for (const id of running) finish.get(`host-a ${id}`)?.();
    await drained;

    expect(shutDown).toBe(true);
    expect(endInFlight).not.toHaveBeenCalled();
    expect(started.filter((s) => s.consumer === 'host-a' && s.at >= drainBegan)).toEqual([]);
    expect(startedBy('host-a').sort()).toEqual([...running].sort());

    // The next executor has the same limit, so the third starts as one of the first two ends.
    expect(startedBy('host-b')).toHaveLength(HARNESS_LIMIT);
    for (const id of startedBy('host-b')) finish.get(`host-b ${id}`)?.();
    await settle();
    expect(startedBy('host-b').sort()).toEqual(gaveBack);
  });
});
