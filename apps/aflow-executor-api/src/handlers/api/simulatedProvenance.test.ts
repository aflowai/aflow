/**
 * A simulated answer must report itself as simulated on every return.
 *
 * The provenance field is what a run's journal, its evaluation and an operator
 * reading a step all use to tell a rehearsed call from a real one. A simulated
 * response labelled `http` is worse than a missing label: it reads as evidence
 * the integration was actually exercised.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ExecutorContext } from '@aflow/executor-runtime';
import { ApiCallInputSchema } from '@aflow/schemas';
import { processResponse } from './response.js';
import type { ResolvedCall } from './types.js';

function makeCtx(): ExecutorContext {
  return {
    job: { spaceId: 'space-1' },
    tenantId: 'tenant-1',
    runId: 'run-1',
    stepExecutionId: 'step-1',
    attempt: 0,
    writePayload: vi.fn(async (kind: string) => `payload:${kind}:1`),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as ExecutorContext;
}

function makeResolved(simulated: boolean): ResolvedCall {
  return {
    url: 'https://payments.example/customers/cus_1',
    method: 'GET',
    headers: {},
    body: undefined,
    egressPolicy: {} as never,
    apiId: 'payments',
    endpointId: 'getCustomer',
    ...(simulated
      ? { simulation: { simulationId: 'sim_payments', bindingId: 'bnd_1', apiId: 'payments' } }
      : {}),
  } as ResolvedCall;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const INPUT = ApiCallInputSchema.parse({ apiId: 'payments', endpointId: 'getCustomer' });

describe('processResponse — provenance', () => {
  it("reports backend 'simulated' when the call resolved to a simulation", async () => {
    const result = await processResponse(
      makeCtx(),
      INPUT,
      jsonResponse({ customerId: 'cus_1' }),
      10,
      'https://payments.example/customers/cus_1',
      makeResolved(true),
    );

    expect(result.backend).toBe('simulated');
    expect(result.statusCode).toBe(200);
    expect(result.data).toEqual({ customerId: 'cus_1' });
  });

  it("reports backend 'http' for the same response when nothing simulated it", async () => {
    const result = await processResponse(
      makeCtx(),
      INPUT,
      jsonResponse({ customerId: 'cus_1' }),
      10,
      'https://payments.example/customers/cus_1',
      makeResolved(false),
    );

    expect(result.backend).toBe('http');
  });

  it('keeps the label on a body large enough to be returned by reference', async () => {
    // The reference path is a separate return, and provenance is decided per
    // return rather than once — so a large simulated body is where a mislabel
    // would survive a test of the inline one.
    const big = { rows: Array.from({ length: 4000 }, (_, i) => ({ id: i, pad: 'x'.repeat(32) })) };
    const result = await processResponse(
      makeCtx(),
      INPUT,
      jsonResponse(big),
      10,
      'https://payments.example/customers/cus_1',
      makeResolved(true),
    );

    expect(result.dataRef).toBeDefined();
    expect(result.backend).toBe('simulated');
  });
});
