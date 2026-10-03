import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CODE_LANE_ENABLED_ENV, toAgentToolError, type AflowError } from '@aflow/schemas';

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

const { contextMock } = vi.hoisted(() => ({
  contextMock: {
    buildExecutionContext: vi.fn().mockResolvedValue({
      outputExists: () => Promise.resolve(undefined),
      stepDefinition: undefined,
    }),
  },
}));
vi.mock('../executor/buildContext.js', () => contextMock);

import { processJob } from '../executor/processJob.js';

/** A job enqueued before the lane was switched off, still sitting in the stream. */
const STALE_CODE_JOB = {
  tenantId: '00000000-0000-0000-0000-000000000001',
  sessionId: '00000000-0000-0000-0000-0000000000b1',
  stepExecutionId: '00000000-0000-0000-0000-0000000000c1',
  stepType: 'code',
  stepId: 'implement',
  attempt: 1,
  operationId: 'code.agent.run',
  inputRef: 'inline:e30=',
} as never;

function makeHost(execute: ReturnType<typeof vi.fn>, stepType = 'code') {
  return {
    config: { consumerName: 'test', defaultTimeoutMs: 1000 },
    deps: { redis: {} },
    handlers: new Map([[stepType, { stepType, execute }]]),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    abortControllers: new Map<string, AbortController>(),
    operationLimiters: new Map(),
  } as never;
}

function emittedFailure(): AflowError {
  const call = reportingMock.emitFailure.mock.calls[0];
  return call?.[2] as AflowError;
}

describe('processJob — coding-lane claim gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    // `unstubAllEnvs` clears stubs, not the ambient value — and the lane's own
    // local-dev docs tell a developer to export this. Without pinning it, a
    // machine set up to run the lane fails the disabled cases instead.
    vi.stubEnv(CODE_LANE_ENABLED_ENV, undefined as unknown as string);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses a claimed code job when the breaker was never set', async () => {
    const execute = vi.fn();

    await processJob(makeHost(execute), 'msg-1', STALE_CODE_JOB, {} as never);

    expect(execute).not.toHaveBeenCalled();
    expect(reportingMock.emitFailure).toHaveBeenCalledOnce();
    expect(reportingMock.acknowledgeJob).toHaveBeenCalledOnce();
  });

  it('refuses a claimed code job when the breaker is explicitly false', async () => {
    vi.stubEnv(CODE_LANE_ENABLED_ENV, 'false');
    const execute = vi.fn();

    await processJob(makeHost(execute), 'msg-2', STALE_CODE_JOB, {} as never);

    expect(execute).not.toHaveBeenCalled();
    expect(reportingMock.emitFailure).toHaveBeenCalledOnce();
  });

  it('fails the stale job with a non-retryable permission refusal that names the lane', async () => {
    const execute = vi.fn();

    await processJob(makeHost(execute), 'msg-3', STALE_CODE_JOB, {} as never);

    const failure = emittedFailure();
    expect(failure.code).toBe('CODE_LANE_DISABLED');
    expect(failure.classification).toBe('permission');
    expect(failure.retryable).toBe(false);
    expect(failure.message).toContain('code.agent.run');

    const agentError = toAgentToolError(failure);
    expect(agentError.error).toBe('permission');
    expect(agentError.retry).toBe(false);
  });

  it('refuses before the job touches durable state or builds a context', async () => {
    // Nothing about the step may move: no STARTED transition, no in-flight
    // claim, no context build. A refused job is one the host never worked on.
    const execute = vi.fn();

    await processJob(makeHost(execute), 'msg-4', STALE_CODE_JOB, {} as never);

    expect(redisMock.updateStepState).not.toHaveBeenCalled();
    expect(redisMock.appendSessionEvent).not.toHaveBeenCalled();
    expect(redisMock.registerStepInFlight).not.toHaveBeenCalled();
    expect(contextMock.buildExecutionContext).not.toHaveBeenCalled();
  });

  it('runs the job once an operator enabled the lane', async () => {
    vi.stubEnv(CODE_LANE_ENABLED_ENV, 'true');
    const execute = vi.fn().mockResolvedValue({ status: 'SUCCEEDED', outputRef: 'inline:e30=' });

    await processJob(makeHost(execute), 'msg-5', STALE_CODE_JOB, {} as never);

    expect(execute).toHaveBeenCalledOnce();
    expect(reportingMock.emitFailure).not.toHaveBeenCalled();
  });

  it('does not gate any other lane', async () => {
    const execute = vi.fn().mockResolvedValue({ status: 'SUCCEEDED', outputRef: 'inline:e30=' });
    const job = { ...(STALE_CODE_JOB as object), stepType: 'ai', operationId: 'ai.text.generate' };

    await processJob(makeHost(execute, 'ai'), 'msg-6', job as never, {} as never);

    expect(execute).toHaveBeenCalledOnce();
  });
});
