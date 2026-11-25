/**
 * A dry run's broker order through the API handler: the call resolves, the
 * hold answers it, and nothing reaches the network or the approval gate.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutorContext } from '@aflow/executor-runtime';
import type { ApiEndpoint } from '@aflow/schemas';
import { DryRunHeldOutputSchema } from '@aflow/schemas';
import type { ResolvedCall } from '../types.js';

const mockResolveCall = vi.fn();
const mockExecuteWithRetry = vi.fn();
const mockFetchWithRetry = vi.fn();
const mockEnforceWriteApprovalGate = vi.fn();

vi.mock('../resolution.js', () => ({
  resolveCall: (...args: unknown[]) => mockResolveCall(...args),
}));
vi.mock('../execution.js', () => ({
  executeWithRetry: (...args: unknown[]) => mockExecuteWithRetry(...args),
  fetchWithRetry: (...args: unknown[]) => mockFetchWithRetry(...args),
}));
vi.mock('../writeApprovalGate.js', () => ({
  ApiWriteApprovalRequired: class extends Error {},
  enforceWriteApprovalGate: (...args: unknown[]) => mockEnforceWriteApprovalGate(...args),
}));

const { ApiCallHandler } = await import('../ApiCallHandler.js');

const DRY_RUN_ID = '22222222-2222-4222-9222-222222222222';
const SESSION_ID = '44444444-4444-4444-9444-444444444444';

const postOrders = {
  endpointId: 'post_orders',
  name: 'Submit order',
  method: 'POST',
  pathTemplate: '/orders',
  params: [],
  tags: [],
} as unknown as ApiEndpoint;

const resolved: ResolvedCall = {
  url: 'https://paper-api.alpaca.markets/v2/orders',
  method: 'POST',
  headers: {},
  body: { symbol: 'AAPL', side: 'buy', type: 'market', time_in_force: 'day', notional: '500' },
  egressPolicy: {} as ResolvedCall['egressPolicy'],
  apiId: 'alpaca-paper-orders-write',
  endpointId: 'post_orders',
  endpoint: postOrders,
};

function ctx(): { ctx: ExecutorContext; written: unknown[] } {
  const written: unknown[] = [];
  const value = {
    tenantId: 't1',
    runId: SESSION_ID,
    stepExecutionId: 'step-1',
    operationId: 'api.http.call',
    job: { sessionId: SESSION_ID, operationId: 'api.http.call', inputRef: 'inline:input' },
    readPayload: () =>
      Promise.resolve({
        apiId: 'alpaca-paper-orders-write',
        endpointId: 'post_orders',
        params: { symbol: 'AAPL' },
      }),
    writePayload: (_kind: string, data: unknown) => {
      written.push(data);
      return Promise.resolve('inline:held');
    },
  } as unknown as ExecutorContext;
  return { ctx: value, written };
}

beforeEach(() => {
  mockResolveCall.mockReset().mockResolvedValue(resolved);
  mockExecuteWithRetry.mockReset().mockRejectedValue(new Error('The network was reached.'));
  mockFetchWithRetry.mockReset().mockRejectedValue(new Error('The network was reached.'));
  mockEnforceWriteApprovalGate.mockReset().mockResolvedValue(undefined);
});

describe('ApiCallHandler in a dry run', () => {
  it('answers a broker order with the held result and sends nothing', async () => {
    const redis = { hget: vi.fn().mockResolvedValue(DRY_RUN_ID) };
    const { ctx: context, written } = ctx();
    const result = await new ApiCallHandler({ redis }).execute(context);

    expect(result.status).toBe('SUCCEEDED');
    expect(result.status === 'SUCCEEDED' ? result.heldWrite?.runId : undefined).toBe(DRY_RUN_ID);
    expect(DryRunHeldOutputSchema.parse(written[0])).toMatchObject({ held: true, dryRun: true });
    expect(mockExecuteWithRetry).not.toHaveBeenCalled();
    expect(mockFetchWithRetry).not.toHaveBeenCalled();
    expect(mockEnforceWriteApprovalGate).not.toHaveBeenCalled();
  });

  describe('a read that saves its response', () => {
    const getBars: ResolvedCall = {
      ...resolved,
      url: 'https://data.alpaca.markets/v2/stocks/bars',
      method: 'GET',
      body: undefined,
      endpointId: 'get_bars',
      endpoint: { ...postOrders, endpointId: 'get_bars', method: 'GET' } as ApiEndpoint,
    };

    function savingCtx(operationId: string, input: unknown) {
      const written: unknown[] = [];
      const value = {
        tenantId: 't1',
        runId: SESSION_ID,
        stepExecutionId: 'step-1',
        operationId,
        job: { sessionId: SESSION_ID, spaceId: 'space-1', operationId, inputRef: 'inline:in' },
        readPayload: () => Promise.resolve(input),
        writePayload: (_kind: string, data: unknown) => {
          written.push(data);
          return Promise.resolve('inline:held');
        },
      } as unknown as ExecutorContext;
      return { ctx: value, written };
    }

    const deps = (dryRunOf: string | null) => ({
      redis: { hget: vi.fn().mockResolvedValue(dryRunOf) },
      db: {} as never,
      payloadStore: {} as never,
    });

    beforeEach(() => {
      mockResolveCall.mockReset().mockResolvedValue(getBars);
    });

    it('holds an api.http.call with response.saveTo and writes no memory document', async () => {
      const { ctx: context, written } = savingCtx('api.http.call', {
        apiId: 'alpaca-paper-orders-write',
        endpointId: 'get_bars',
        response: { saveTo: { path: '/research/bars.json' } },
      });
      const result = await new ApiCallHandler(deps(DRY_RUN_ID)).execute(context);

      expect(result.status).toBe('SUCCEEDED');
      expect(result.status === 'SUCCEEDED' ? result.heldWrite?.target : undefined).toContain(
        'saved to memory /research/bars.json',
      );
      expect(DryRunHeldOutputSchema.parse(written[0])).toMatchObject({
        path: '/research/bars.json',
        held: true,
      });
      expect(mockExecuteWithRetry).not.toHaveBeenCalled();
      expect(mockFetchWithRetry).not.toHaveBeenCalled();
    });

    it('holds an api.http.download that reaches the executor', async () => {
      const { ctx: context, written } = savingCtx('api.http.download', {
        apiId: 'alpaca-paper-orders-write',
        endpointId: 'get_bars',
        toMemoryPath: '/research/bars.csv',
      });
      const result = await new ApiCallHandler(deps(DRY_RUN_ID)).execute(context);

      expect(result.status).toBe('SUCCEEDED');
      expect(DryRunHeldOutputSchema.parse(written[0])).toMatchObject({
        path: '/research/bars.csv',
        operationId: 'api.http.download',
        held: true,
      });
      expect(mockExecuteWithRetry).not.toHaveBeenCalled();
      expect(mockFetchWithRetry).not.toHaveBeenCalled();
    });

    it('sends the saving read for a live session', async () => {
      mockExecuteWithRetry.mockResolvedValue({ status: 'SUCCEEDED', outputRef: 'inline:x' });
      const { ctx: context } = savingCtx('api.http.call', {
        apiId: 'alpaca-paper-orders-write',
        endpointId: 'get_bars',
        response: { saveTo: { path: '/research/bars.json' } },
      });
      await new ApiCallHandler(deps(null)).execute(context);
      expect(mockExecuteWithRetry).toHaveBeenCalledTimes(1);
    });
  });

  it('sends the same order for a live session, through the approval gate', async () => {
    const redis = { hget: vi.fn().mockResolvedValue(null) };
    mockExecuteWithRetry.mockResolvedValue({ status: 'SUCCEEDED', outputRef: 'inline:x' });
    const { ctx: context } = ctx();
    await new ApiCallHandler({ redis }).execute(context);
    expect(mockEnforceWriteApprovalGate).toHaveBeenCalledTimes(1);
    expect(mockExecuteWithRetry).toHaveBeenCalledTimes(1);
  });
});
