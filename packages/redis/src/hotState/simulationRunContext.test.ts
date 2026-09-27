import { describe, it, expect, beforeEach } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import type { SimulationRunContext } from '@aflow/schemas';
import {
  getSimulationRunContext,
  pinSimulationRunContext,
  simulationRunContextField,
} from './simulationRunContext.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001';

/** A run per case: one mock store backs every client built in this file. */
let runCounter = 0;

function context(overrides: Partial<SimulationRunContext> = {}): SimulationRunContext {
  return {
    simulationId: 'bnpl-core',
    simulationRevision: 1,
    baselineVersion: 1,
    snapshotRef: 'inline:e30=',
    definitionHash: 'a'.repeat(64),
    seed: 'seed-1',
    clockAnchorMs: 1_700_000_000_000,
    ...overrides,
  };
}

describe('simulation run context pinning', () => {
  let redis: Redis;
  let RUN: string;

  beforeEach(() => {
    redis = new RedisMock() as unknown as Redis;
    runCounter += 1;
    RUN = `265a4135-2103-48f2-92ae-${String(runCounter).padStart(12, '0')}`;
  });

  it('keys the pin per simulation, so two simulations in one run hold their own world', async () => {
    const payments = await pinSimulationRunContext(
      redis,
      TENANT,
      RUN,
      context({ simulationId: 'payments', seed: 'seed-payments', baselineVersion: 3 }),
    );
    const crm = await pinSimulationRunContext(
      redis,
      TENANT,
      RUN,
      context({ simulationId: 'crm', seed: 'seed-crm', baselineVersion: 7 }),
    );

    expect(payments.seed).toBe('seed-payments');
    expect(crm.seed).toBe('seed-crm');
    expect(await getSimulationRunContext(redis, TENANT, RUN, 'payments')).toMatchObject({
      seed: 'seed-payments',
      baselineVersion: 3,
    });
    expect(await getSimulationRunContext(redis, TENANT, RUN, 'crm')).toMatchObject({
      seed: 'seed-crm',
      baselineVersion: 7,
    });
  });

  it('pins once per simulation — a later call reads what the first fixed', async () => {
    await pinSimulationRunContext(redis, TENANT, RUN, context({ seed: 'first' }));
    const second = await pinSimulationRunContext(redis, TENANT, RUN, context({ seed: 'second' }));

    expect(second.seed).toBe('first');
  });

  it('answers nothing for a simulation this run never called', async () => {
    await pinSimulationRunContext(redis, TENANT, RUN, context({ simulationId: 'payments' }));

    expect(await getSimulationRunContext(redis, TENANT, RUN, 'crm')).toBeNull();
  });

  it('names its own hash field', () => {
    expect(simulationRunContextField('crm')).toBe('simulationRunContextJson:crm');
  });
});
