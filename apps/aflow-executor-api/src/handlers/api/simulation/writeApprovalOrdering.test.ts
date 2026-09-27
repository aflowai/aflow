/**
 * A simulated call still meets the write-approval gate.
 *
 * The gate is deliberately upstream of the simulated branch: `writeRiskTier`
 * belongs to the endpoint, the endpoint is unchanged by fulfillment, and the
 * approval card is part of the behaviour being rehearsed. Both halves of that
 * fail silently if they drift — a gate moved below the branch would let every
 * simulated write skip the card, and the run would look correct until the same
 * agent met the real API.
 */
import { describe, expect, it } from 'vitest';
import type { ExecutorContext } from '@aflow/executor-runtime';
import type { Redis } from '@aflow/redis';
import type { ApiEndpoint } from '@aflow/schemas';
import { ApiWriteApprovalRequired, enforceWriteApprovalGate } from '../writeApprovalGate.js';
import type { ResolvedCall } from '../types.js';

const ctx = {
  tenantId: 't1',
  runId: 'run-1',
  stepExecutionId: 'step-1',
  job: { spaceId: 'space-1' },
} as unknown as ExecutorContext;

const noGrant = { get: async () => null } as unknown as Redis;

function simulatedCall(tier: ApiEndpoint['writeRiskTier']): ResolvedCall {
  return {
    url: 'https://bnpl.invalid/v1/refunds',
    method: 'POST',
    headers: {},
    body: { orderId: 'ord_1', amount: 400 },
    egressPolicy: {} as ResolvedCall['egressPolicy'],
    apiId: 'bnpl',
    bindingId: 'bind_sim',
    endpointId: 'createRefund',
    endpoint: {
      endpointId: 'createRefund',
      name: 'Create refund',
      method: 'POST',
      pathTemplate: '/v1/refunds',
      params: [],
      tags: [],
      ...(tier === undefined ? {} : { writeRiskTier: tier }),
    } as ApiEndpoint,
    simulation: { simulationId: 'sim_bnpl', bindingId: 'bind_sim', apiId: 'bnpl' },
  };
}

async function handlerSource(): Promise<string> {
  const fs = await import('node:fs/promises');
  return fs.readFile(new URL('../ApiCallHandler.ts', import.meta.url), 'utf8');
}

describe('a simulated write and the approval gate', () => {
  it('raises the approval pause on a gated endpoint the simulation would answer', async () => {
    await expect(
      enforceWriteApprovalGate(ctx, simulatedCall('high'), noGrant),
    ).rejects.toBeInstanceOf(ApiWriteApprovalRequired);
  });

  it('carries the endpoint tier into the pause rather than a fulfillment-derived one', async () => {
    try {
      await enforceWriteApprovalGate(ctx, simulatedCall('medium'), noGrant);
      throw new Error('the gate let a medium-tier simulated write through');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiWriteApprovalRequired);
      expect((error as ApiWriteApprovalRequired).request.writeRiskTier).toBe('medium');
    }
  });

  it('leaves a low-tier simulated write ungated, exactly as the live path would', async () => {
    await expect(
      enforceWriteApprovalGate(ctx, simulatedCall('low'), noGrant),
    ).resolves.toBeUndefined();
  });

  it('runs the gate before the simulation answers the call', async () => {
    const src = await handlerSource();

    // Anchored on the call that produces the answer, not on a test for
    // simulated fulfillment: the handler reads that fulfillment earlier to
    // report what answered the step, and only this is the point of no return.
    const gateAt = src.indexOf('await enforceWriteApprovalGate(');
    const answersAt = src.indexOf('await executeSimulatedCall(');

    expect(gateAt).toBeGreaterThan(-1);
    expect(answersAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(answersAt);
  });
});
