/**
 * The API half of a dry run's write hold: a broker order or any other write
 * tier a dry run's step sends is held after its body resolves, and returns
 * the structured held result. A read, and a write of a live step, pass on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@aflow/database';
import type { ExecutorContext } from '@aflow/executor-runtime';
import type { Redis } from '@aflow/redis';
import { DRY_RUN_HELD_MESSAGE, DryRunHeldOutputSchema, type ApiEndpoint } from '@aflow/schemas';
import type { ResolvedCall } from '../types.js';

const mockReadWorkflowRunDryRun = vi.fn();
vi.mock('@aflow/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aflow/database')>()),
  readWorkflowRunDryRun: (...args: unknown[]) => mockReadWorkflowRunDryRun(...args),
}));

const { holdDryRunApiWrite, resolvedCallWrites } = await import('../dryRunHold.js');

const DRY_RUN_ID = '22222222-2222-4222-9222-222222222222';
const SESSION_ID = '44444444-4444-4444-9444-444444444444';

const postOrders: ApiEndpoint = {
  endpointId: 'post_orders',
  name: 'Submit order',
  method: 'POST',
  pathTemplate: '/orders',
  params: [],
  tags: [],
} as unknown as ApiEndpoint;

const getOrders: ApiEndpoint = {
  ...postOrders,
  endpointId: 'get_orders',
  name: 'List orders',
  method: 'GET',
} as ApiEndpoint;

function call(
  endpoint: ApiEndpoint | undefined,
  method = endpoint?.method ?? 'POST',
): ResolvedCall {
  return {
    url: 'https://paper-api.alpaca.markets/v2/orders',
    method,
    headers: { 'APCA-API-SECRET-KEY': 'never-shown' },
    body: { symbol: 'AAPL', side: 'buy', type: 'market', time_in_force: 'day', notional: '500' },
    egressPolicy: {} as ResolvedCall['egressPolicy'],
    apiId: 'alpaca-paper-orders-write',
    ...(endpoint ? { endpointId: endpoint.endpointId, endpoint } : {}),
  };
}

function sessionCtx(): ExecutorContext {
  return {
    tenantId: 't1',
    runId: SESSION_ID,
    operationId: 'api.http.call',
    job: { sessionId: SESSION_ID },
  } as unknown as ExecutorContext;
}

function workflowTaskCtx(): ExecutorContext {
  return {
    tenantId: 't1',
    runId: DRY_RUN_ID,
    operationId: 'api.http.call',
    job: { workflowExecution: { runId: DRY_RUN_ID, taskId: 'submit', attempt: 1 } },
  } as unknown as ExecutorContext;
}

function redisWith(dryRunOf: string | null) {
  const hget = vi.fn().mockResolvedValue(dryRunOf);
  return { redis: { hget } as unknown as Redis, hget };
}

beforeEach(() => {
  mockReadWorkflowRunDryRun.mockReset();
});

describe('resolvedCallWrites', () => {
  it('reads every untiered, low, medium and high write as a write, as the rehearsal hold does', () => {
    expect(resolvedCallWrites(call(postOrders))).toBe(true);
    for (const tier of ['low', 'medium', 'high'] as const) {
      expect(resolvedCallWrites(call({ ...postOrders, writeRiskTier: tier }))).toBe(true);
    }
    expect(resolvedCallWrites(call(getOrders))).toBe(false);
  });

  it('reads a direct-URL call by its method', () => {
    expect(resolvedCallWrites(call(undefined, 'DELETE'))).toBe(true);
    expect(resolvedCallWrites(call(undefined, 'GET'))).toBe(false);
  });
});

describe('holdDryRunApiWrite', () => {
  it('holds a broker order a dry run’s session sends, with the structured held result', async () => {
    const { redis, hget } = redisWith(DRY_RUN_ID);
    const held = await holdDryRunApiWrite(sessionCtx(), call(postOrders), { redis });

    expect(hget).toHaveBeenCalledWith(expect.stringContaining(SESSION_ID), 'dryRunOf');
    expect(held?.held).toEqual({
      runId: DRY_RUN_ID,
      operationId: 'api.http.call',
      target: 'POST alpaca-paper-orders-write/post_orders (paper-api.alpaca.markets)',
      preview: expect.stringContaining('"symbol":"AAPL"'),
    });
    expect(DryRunHeldOutputSchema.parse(held?.output)).toMatchObject({
      dryRun: true,
      held: true,
      operationId: 'api.http.call',
      message: DRY_RUN_HELD_MESSAGE,
    });
    // The credential rides the headers, which the held record never carries.
    expect(JSON.stringify(held)).not.toContain('never-shown');
  });

  it('holds a write a dry run’s operation task sends, read from the run row', async () => {
    mockReadWorkflowRunDryRun.mockResolvedValue(true);
    const db = {} as Database;
    const held = await holdDryRunApiWrite(workflowTaskCtx(), call(postOrders), { db });
    expect(mockReadWorkflowRunDryRun).toHaveBeenCalledWith(db, 't1', DRY_RUN_ID);
    expect(held?.held.runId).toBe(DRY_RUN_ID);
  });

  it('passes a read on without asking whether the run is a dry run', async () => {
    const { redis, hget } = redisWith(DRY_RUN_ID);
    expect(await holdDryRunApiWrite(sessionCtx(), call(getOrders), { redis })).toBeNull();
    expect(hget).not.toHaveBeenCalled();
  });

  it('holds a read that saves its response, naming the memory path it would write', async () => {
    const { redis, hget } = redisWith(DRY_RUN_ID);
    const held = await holdDryRunApiWrite(
      sessionCtx(),
      call(getOrders),
      { redis },
      { path: '/research/orders.json' },
    );
    expect(hget).toHaveBeenCalledWith(expect.stringContaining(SESSION_ID), 'dryRunOf');
    expect(held?.held.target).toBe(
      'GET alpaca-paper-orders-write/get_orders (paper-api.alpaca.markets) saved to memory /research/orders.json',
    );
    expect(DryRunHeldOutputSchema.parse(held?.output)).toMatchObject({
      path: '/research/orders.json',
      held: true,
      dryRun: true,
    });
  });

  it('passes a live step’s saving read on', async () => {
    const { redis } = redisWith(null);
    expect(
      await holdDryRunApiWrite(sessionCtx(), call(getOrders), { redis }, { path: '/a.json' }),
    ).toBeNull();
  });

  it('passes a live step’s write on to the approval gate', async () => {
    const { redis } = redisWith(null);
    expect(await holdDryRunApiWrite(sessionCtx(), call(postOrders), { redis })).toBeNull();
    mockReadWorkflowRunDryRun.mockResolvedValue(false);
    expect(
      await holdDryRunApiWrite(workflowTaskCtx(), call(postOrders), { db: {} as Database }),
    ).toBeNull();
  });

  it('refuses a write whose dry-run state it cannot read, rather than send it live', async () => {
    await expect(holdDryRunApiWrite(sessionCtx(), call(postOrders), {})).rejects.toThrow(
      /was not sent/,
    );
    await expect(holdDryRunApiWrite(workflowTaskCtx(), call(postOrders), {})).rejects.toThrow(
      /was not sent/,
    );
  });
});
