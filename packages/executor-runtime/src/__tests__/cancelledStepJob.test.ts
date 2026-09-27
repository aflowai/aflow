import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { redisMock } = vi.hoisted(() => ({
  redisMock: {
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

import { processJob } from '../executor/processJob.js';

/** An operation task: no `sessionId`, which is why the stale-attempt fence cannot help it. */
const OPERATION_TASK_JOB = {
  tenantId: 't1',
  stepExecutionId: 'step-exec-1',
  stepType: 'code',
  stepId: 'implement',
  attempt: 1,
  operationId: 'code.agent.run',
  inputRef: 'inline:e30=',
} as never;

function makeHost(execute: ReturnType<typeof vi.fn>) {
  return {
    config: { consumerName: 'test', defaultTimeoutMs: 1000 },
    deps: { redis: {} },
    handlers: new Map([['code', { stepType: 'code', execute }]]),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    abortControllers: new Map<string, AbortController>(),
  } as never;
}

describe('processJob — cancelled step jobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisMock.getStepState.mockResolvedValue(null);
    // These jobs are stepType `code`, which the lane breaker refuses ahead of
    // every other check. This suite is about what happens once it says yes.
    vi.stubEnv('CODE_LANE_ENABLED', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not run a job whose attempt was cancelled while it waited', async () => {
    // The gap the durable record exists to cover: the cancel was published while
    // nothing was subscribed for this step, so the abort never arrived.
    redisMock.wasStepCancelled.mockResolvedValue(true);
    const execute = vi.fn();

    await processJob(makeHost(execute), 'msg-1', OPERATION_TASK_JOB, {} as never);

    expect(execute).not.toHaveBeenCalled();
    // Acked, so it cannot be redelivered and start a container on the next boot.
    expect(reportingMock.acknowledgeJob).toHaveBeenCalledOnce();
    // No result emitted — the ledger already recorded the cancellation.
    expect(reportingMock.emitFailure).not.toHaveBeenCalled();
    expect(reportingMock.emitResult).not.toHaveBeenCalled();
  });

  it('runs a job that was never cancelled', async () => {
    redisMock.wasStepCancelled.mockResolvedValue(false);
    const execute = vi.fn().mockResolvedValue({ status: 'SUCCEEDED', outputRef: 'inline:e30=' });

    await processJob(makeHost(execute), 'msg-2', OPERATION_TASK_JOB, {} as never);

    expect(execute).toHaveBeenCalledOnce();
  });

  it('checks the cancellation only AFTER the abort controller is registered', async () => {
    // Registering first is what closes the race: from that point the Pub/Sub can
    // reach the job, so the record only has to cover what was published earlier.
    const seen: string[] = [];
    const host = makeHost(vi.fn().mockResolvedValue({ status: 'SUCCEEDED', outputRef: 'x' }));
    redisMock.wasStepCancelled.mockImplementation(() => {
      seen.push(
        (
          host as unknown as { abortControllers: Map<string, AbortController> }
        ).abortControllers.has('step-exec-1')
          ? 'registered'
          : 'not-registered',
      );
      return Promise.resolve(false);
    });

    await processJob(host, 'msg-3', OPERATION_TASK_JOB, {} as never);

    expect(seen).toEqual(['registered']);
  });
});
