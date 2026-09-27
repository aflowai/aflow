import { describe, it, expect, beforeEach, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { contentAddressForJson, createMemoryPayloadStore } from '@aflow/payload-store';
import type { PayloadStore } from '@aflow/payload-store';
import { StreamKeys } from '@aflow/schemas';
import type { SimulationCallRecord, SimulationRunContext, TenantId } from '@aflow/schemas';
import { createTenantContext } from '@aflow/database';
import { handleSimulationWorldOp } from './simulationWorld.js';
import type { SimulationScope } from './simulationStore.js';
import type { InlineHandlerArgs } from './types.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const SPACE = '9e842431-cb9a-477d-b090-e33e601a4c83';
const RUN = '265a4135-2103-48f2-92ae-000000000001';

const world = vi.hoisted(() => ({
  pinned: null as unknown,
  records: [] as unknown[],
  baseline: [] as unknown[],
}));

vi.mock('@aflow/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/database')>();
  return {
    ...actual,
    readSimulationRunContext: () => Promise.resolve(world.pinned),
    readCallRecords: () => Promise.resolve(world.records),
    readBaselineEntities: () => Promise.resolve(world.baseline),
  };
});

const pinnedContext: SimulationRunContext = {
  simulationId: 'bnpl-sim',
  simulationRevision: 4,
  baselineVersion: 2,
  snapshotRef: 'inline:eyJwaW5uZWQiOnRydWV9',
  definitionHash: 'hash-1',
  seed: 'seed-1',
  clockAnchorMs: 1_700_000_000_000,
};

describe('integration.simulation.inspect — a finished run outlives its hot state', () => {
  let redis: Redis;
  let payloadStore: PayloadStore;
  let scope: SimulationScope;
  let args: InlineHandlerArgs;

  beforeEach(() => {
    redis = new RedisMock() as unknown as Redis;
    payloadStore = createMemoryPayloadStore();
    world.pinned = null;
    world.records = [];
    world.baseline = [];
    scope = {
      db: {} as unknown as PostgresJsDatabase,
      tenantCtx: createTenantContext(TENANT),
      tenantId: TENANT,
      spaceId: SPACE,
    };
    args = { redis, payloadStore } as unknown as InlineHandlerArgs;
  });

  async function inspect(): Promise<Record<string, unknown>> {
    const { output } = await handleSimulationWorldOp(
      args,
      scope,
      'integration.simulation.inspect',
      {
        simulationId: 'bnpl-sim',
        runId: RUN,
      },
    );
    return output;
  }

  it('folds the journal onto the pinned baseline with no hot state at all', async () => {
    const mutations = [
      { collection: 'refunds', op: 'create', entityId: 'ref-1', body: { id: 'ref-1' } },
    ];
    const deltaRef = await payloadStore.storeContentAddressed({
      tenantId: TENANT,
      contentHash: contentAddressForJson(mutations),
      kind: 'simulation_delta',
      data: mutations,
      persist: true,
    });
    world.pinned = pinnedContext;
    world.baseline = [{ collection: 'orders', entityId: 'ord-1', body: { id: 'ord-1' } }];
    world.records = [
      {
        logicalExecutionId: 'logical-1',
        simulationId: 'bnpl-sim',
        bindingId: 'bnpl-binding',
        apiId: 'bnpl-core',
        endpointId: 'createRefund',
        request: { method: 'POST', url: 'https://simulated.invalid/bnpl-core/refunds' },
        matched: { rung: 'rule' },
        responseStatus: 201,
        responseRef: 'inline:e30=',
        deltaRef,
        ordinal: 0,
        worldVersionBefore: 0,
        worldVersionAfter: 1,
        clockMs: 1_700_000_000_000,
      } satisfies SimulationCallRecord,
    ];

    expect(await redis.exists(StreamKeys.sessionStateKey(TENANT, RUN))).toBe(0);

    const output = await inspect();

    expect(output['runContext']).toEqual(pinnedContext);
    expect(output['worldVersion']).toBe(1);
    expect(output['collections']).toEqual([
      { collection: 'orders', entities: [{ id: 'ord-1' }], total: 1, truncated: false },
      { collection: 'refunds', entities: [{ id: 'ref-1' }], total: 1, truncated: false },
    ]);
  });

  it('still refuses a run that never pinned this simulation', async () => {
    await expect(inspect()).rejects.toMatchObject({ code: 'SIMULATION_RUN_CONTEXT_MISSING' });
  });
});
