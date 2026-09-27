/**
 * Where the simulated marker comes from.
 *
 * A binding can be re-fulfilled while a lowered tool step sits in the jobs
 * stream, so the step's dispatch metadata is a claim about the past. The
 * handler resolves fulfillment at call time; whatever it reports there rides
 * every terminal result the attempt produces, and that is what the run's
 * marking is read from.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PayloadRef } from '@aflow/schemas';
import type { ExecutorContext, StepResult } from '../types.js';

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

const SIMULATED_TOOL_JOB = {
  tenantId: '00000000-0000-0000-0000-000000000001',
  sessionId: '00000000-0000-0000-0000-0000000000b1',
  stepExecutionId: '00000000-0000-0000-0000-0000000000c1',
  stepType: 'api',
  stepId: 'virtual_api_bnpl_createrefund_ab12cd34',
  attempt: 1,
  operationId: 'api.http.call',
  inputRef: 'inline:e30=',
} as never;

function makeHost(execute: (ctx: ExecutorContext) => Promise<StepResult>) {
  return {
    config: { consumerName: 'test', defaultTimeoutMs: 1000 },
    deps: { redis: {} },
    handlers: new Map([['api', { stepType: 'api', execute }]]),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    abortControllers: new Map<string, AbortController>(),
  } as never;
}

const SUCCESS: StepResult = {
  status: 'SUCCEEDED',
  outputRef: 'inline:e30=' as PayloadRef,
  durationMs: 0,
};

const BNPL_SIMULATION = { bindingId: 'bind_bnpl', simulationId: 'sim_bnpl' };

describe('the fulfillment a handler resolves rides its result', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('carries the report when the call was answered by a simulation', async () => {
    await processJob(
      makeHost(async (ctx) => {
        ctx.reportSimulatedFulfillment?.(BNPL_SIMULATION);
        return SUCCESS;
      }),
      'msg-1',
      SIMULATED_TOOL_JOB,
      {} as never,
    );

    expect(reportingMock.emitResult).toHaveBeenCalledOnce();
    expect(reportingMock.emitResult.mock.calls[0]?.[4]).toEqual(BNPL_SIMULATION);
  });

  it('carries nothing when the same step resolved to a live binding', async () => {
    await processJob(
      makeHost(async () => SUCCESS),
      'msg-2',
      SIMULATED_TOOL_JOB,
      {} as never,
    );

    expect(reportingMock.emitResult).toHaveBeenCalledOnce();
    expect(reportingMock.emitResult.mock.calls[0]?.[4]).toBeUndefined();
  });

  it('still carries the report when the attempt ends by throwing', async () => {
    await processJob(
      makeHost(async (ctx) => {
        ctx.reportSimulatedFulfillment?.(BNPL_SIMULATION);
        throw new Error('the simulated world rejected the request');
      }),
      'msg-3',
      SIMULATED_TOOL_JOB,
      {} as never,
    );

    expect(reportingMock.emitFailure).toHaveBeenCalledOnce();
    expect(reportingMock.emitFailure.mock.calls[0]?.[4]).toEqual(BNPL_SIMULATION);
  });
});
