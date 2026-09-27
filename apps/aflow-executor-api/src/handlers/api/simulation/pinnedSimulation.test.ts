import { describe, it, expect, beforeEach, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { canonicalEndpoints, endpointSetHash } from '@aflow/integration-simulator';
import { contentAddressForJson, createMemoryPayloadStore } from '@aflow/payload-store';
import type { PayloadStore } from '@aflow/payload-store';
import { SimulationSchema, StreamKeys } from '@aflow/schemas';
import type { ApiDefinition, ApiEndpoint, SimulationRunContext, TenantId } from '@aflow/schemas';
import { simulationRunContextField } from '@aflow/redis';
import { createTenantPolicyCache } from '@aflow/database';
import { resolvePinnedSimulation } from './loadSimulation.js';
import { ApiExecutionError, type ApiHandlerStores, type CachedSimulation } from '../types.js';

/**
 * Stands in for the durable pin table: insert-if-absent, and the stored row
 * wins every later call. `probe` reports what the hot copy held at the instant
 * the durable one was written.
 */
const durable = vi.hoisted(() => ({
  rows: new Map<string, unknown>(),
  hotAtWrite: [] as Array<string | null>,
  probe: null as null | (() => Promise<string | null>),
}));

vi.mock('@aflow/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/database')>();
  return {
    ...actual,
    readSimulationRunContext: (params: { runId: string; simulationId: string }) =>
      Promise.resolve(durable.rows.get(`${params.runId}::${params.simulationId}`) ?? null),
    // These cases are about what a run stays pinned to, not about the pins it
    // was started with. The mint path reads the run row when hot state holds
    // none — an operation task's only record of them — so it has to answer.
    readDurableSimulationRunInput: () => Promise.resolve(null),
    pinDurableSimulationRunContext: async (params: {
      runId: string;
      context: SimulationRunContext;
    }) => {
      if (durable.probe) durable.hotAtWrite.push(await durable.probe());
      const key = `${params.runId}::${params.context.simulationId}`;
      const existing = durable.rows.get(key);
      if (existing) return existing;
      durable.rows.set(key, params.context);
      return params.context;
    },
  };
});

const db = {} as unknown as PostgresJsDatabase;

const TENANT = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const SPACE = '9e842431-cb9a-477d-b090-e33e601a4c83';

let runCounter = 0;

function stores(): ApiHandlerStores {
  return {
    definitionStore: new Map(),
    invalidDefinitions: new Map(),
    bindingStore: new Map(),
    credentialStore: new Map(),
    loadedAtMs: new Map(),
    loadPromises: new Map(),
    tenantPolicyCache: createTenantPolicyCache(),
    spaceWritePolicyStore: new Map(),
    catalogGrantStore: new Map(),
    simulationStore: new Map(),
    simulationLoadPromises: new Map(),
    simulationSnapshotStore: new Map(),
  };
}

function endpoint(overrides: Partial<ApiEndpoint> = {}): ApiEndpoint {
  return {
    endpointId: 'getOrder',
    name: 'Get order',
    method: 'GET',
    pathTemplate: '/orders/{orderId}',
    params: [],
    writeRiskTier: 'read',
    ...overrides,
  } as ApiEndpoint;
}

function definition(endpoints: ApiEndpoint[]): ApiDefinition {
  return {
    apiId: 'bnpl-core',
    name: 'BNPL core',
    version: '1',
    callMode: 'endpoint',
    baseUrlTemplate: 'https://simulated.invalid/bnpl-core',
    auth: { type: 'none' },
    endpoints,
  } as unknown as ApiDefinition;
}

function loaded(): CachedSimulation {
  return {
    simulation: SimulationSchema.parse({
      simulationId: 'bnpl-sim',
      revision: 4,
      name: 'BNPL',
      targets: { sourceKind: 'api', integrationId: 'bnpl-core' },
    }),
    baselineVersion: 2,
    baselineCreatedAtMs: 1_700_000_000_000,
    loadedAtMs: Date.now(),
  };
}

describe('resolvePinnedSimulation', () => {
  let redis: Redis;
  let payloadStore: PayloadStore;
  let runId: string;

  beforeEach(() => {
    redis = new RedisMock() as unknown as Redis;
    payloadStore = createMemoryPayloadStore();
    runCounter += 1;
    runId = `265a4135-2103-48f2-92ae-${String(runCounter).padStart(12, '0')}`;
    durable.rows.clear();
    durable.hotAtWrite.length = 0;
    durable.probe = () =>
      redis.hget(StreamKeys.sessionStateKey(TENANT, runId), simulationRunContextField('bnpl-sim'));
  });

  it('answers from the artifact the run pinned, not from the edited one', async () => {
    const shared = stores();
    const first = await resolvePinnedSimulation({
      stores: shared,
      db,
      redis,
      payloadStore,
      tenantId: TENANT,
      spaceId: SPACE,
      runId,
      loaded: loaded(),
      definition: definition([endpoint()]),
    });
    expect(first.pinned.snapshot.simulation.revision).toBe(4);

    const edited = loaded();
    edited.simulation = { ...edited.simulation, revision: 5, domainBrief: 'rewritten' };

    const second = await resolvePinnedSimulation({
      stores: shared,
      db,
      redis,
      payloadStore,
      tenantId: TENANT,
      spaceId: SPACE,
      runId,
      loaded: edited,
      definition: definition([endpoint()]),
    });

    expect(second.runContext.simulationRevision).toBe(4);
    expect(second.pinned.snapshot.simulation.revision).toBe(4);
    expect(second.pinned.snapshot.simulation.domainBrief).toBe('');
  });

  it('refuses the call when the definition endpoint set moved under the pin', async () => {
    const shared = stores();
    await resolvePinnedSimulation({
      stores: shared,
      db,
      redis,
      payloadStore,
      tenantId: TENANT,
      spaceId: SPACE,
      runId,
      loaded: loaded(),
      definition: definition([endpoint()]),
    });

    const drifted = resolvePinnedSimulation({
      stores: shared,
      db,
      redis,
      payloadStore,
      tenantId: TENANT,
      spaceId: SPACE,
      runId,
      loaded: loaded(),
      definition: definition([endpoint({ pathTemplate: '/v2/orders/{orderId}' })]),
    });

    await expect(drifted).rejects.toBeInstanceOf(ApiExecutionError);
    await expect(drifted).rejects.toMatchObject({
      aflowError: { code: 'API_SIMULATION_PIN_BROKEN', retryable: false },
    });
  });

  it('pins each simulation in a run separately', async () => {
    const shared = stores();
    const payments = loaded();
    const crm = loaded();
    crm.simulation = { ...crm.simulation, simulationId: 'crm-sim' };
    crm.baselineVersion = 9;

    const a = await resolvePinnedSimulation({
      stores: shared,
      db,
      redis,
      payloadStore,
      tenantId: TENANT,
      spaceId: SPACE,
      runId,
      loaded: payments,
      definition: definition([endpoint()]),
    });
    const b = await resolvePinnedSimulation({
      stores: shared,
      db,
      redis,
      payloadStore,
      tenantId: TENANT,
      spaceId: SPACE,
      runId,
      loaded: crm,
      definition: definition([endpoint()]),
    });

    expect(a.runContext.simulationId).toBe('bnpl-sim');
    expect(a.runContext.baselineVersion).toBe(2);
    expect(b.runContext.simulationId).toBe('crm-sim');
    expect(b.runContext.baselineVersion).toBe(9);
    expect(a.runContext.seed).toBe(b.runContext.seed);
  });
  it('keeps the world it pinned after the hot hash is gone', async () => {
    const shared = stores();
    const first = await resolvePinnedSimulation({
      stores: shared,
      db,
      redis,
      payloadStore,
      tenantId: TENANT,
      spaceId: SPACE,
      runId,
      loaded: loaded(),
      definition: definition([endpoint()]),
    });

    await redis.del(StreamKeys.sessionStateKey(TENANT, runId));

    // Everything the mint would read has moved on: a newer artifact revision
    // and a baseline frozen since. A re-pin would fold the run's journal onto
    // a world it never read.
    const moved = loaded();
    moved.simulation = { ...moved.simulation, revision: 9 };
    moved.baselineVersion = 7;

    const resumed = await resolvePinnedSimulation({
      stores: shared,
      db,
      redis,
      payloadStore,
      tenantId: TENANT,
      spaceId: SPACE,
      runId,
      loaded: moved,
      definition: definition([endpoint()]),
    });

    expect(resumed.runContext.baselineVersion).toBe(first.runContext.baselineVersion);
    expect(resumed.runContext.snapshotRef).toBe(first.runContext.snapshotRef);
    expect(resumed.runContext.simulationRevision).toBe(4);
    expect(resumed.pinned.snapshot.simulation.revision).toBe(4);
    expect(durable.rows.size).toBe(1);
  });

  it('rewarms the hot copy from the durable pin rather than minting a second one', async () => {
    const shared = stores();
    await resolvePinnedSimulation({
      stores: shared,
      db,
      redis,
      payloadStore,
      tenantId: TENANT,
      spaceId: SPACE,
      runId,
      loaded: loaded(),
      definition: definition([endpoint()]),
    });
    await redis.del(StreamKeys.sessionStateKey(TENANT, runId));

    await resolvePinnedSimulation({
      stores: shared,
      db,
      redis,
      payloadStore,
      tenantId: TENANT,
      spaceId: SPACE,
      runId,
      loaded: loaded(),
      definition: definition([endpoint()]),
    });

    const rewarmed = await redis.hget(
      StreamKeys.sessionStateKey(TENANT, runId),
      simulationRunContextField('bnpl-sim'),
    );
    expect(rewarmed).not.toBeNull();
    // One durable write in the run's life: the second resolve read the row it
    // found instead of proposing another.
    expect(durable.hotAtWrite).toHaveLength(1);
  });

  it('answers a run whose pin predates today from the pinned values, not the current ones', async () => {
    const endpoints = canonicalEndpoints(definition([endpoint()]).endpoints);
    const snapshot = { simulation: loaded().simulation, endpoints };
    const snapshotRef = await payloadStore.storeContentAddressed({
      tenantId: TENANT,
      contentHash: contentAddressForJson(snapshot),
      kind: 'simulation_snapshot',
      data: snapshot,
      persist: true,
    });
    const pinnedLongAgo: SimulationRunContext = {
      simulationId: 'bnpl-sim',
      simulationRevision: 4,
      baselineVersion: 42,
      snapshotRef,
      definitionHash: endpointSetHash(endpoints),
      seed: 'seed-from-the-first-call',
      clockAnchorMs: 1_600_000_000_000,
    };
    durable.rows.set(`${runId}::bnpl-sim`, pinnedLongAgo);

    const resolved = await resolvePinnedSimulation({
      stores: stores(),
      db,
      redis,
      payloadStore,
      tenantId: TENANT,
      spaceId: SPACE,
      runId,
      loaded: loaded(),
      definition: definition([endpoint()]),
    });

    expect(resolved.runContext).toEqual(pinnedLongAgo);
    expect(resolved.runContext.baselineVersion).not.toBe(loaded().baselineVersion);
    // Nothing was proposed: a row that exists is read, never re-pinned.
    expect(durable.hotAtWrite).toHaveLength(0);
  });

  it('writes the durable pin before the hot one', async () => {
    await resolvePinnedSimulation({
      stores: stores(),
      db,
      redis,
      payloadStore,
      tenantId: TENANT,
      spaceId: SPACE,
      runId,
      loaded: loaded(),
      definition: definition([endpoint()]),
    });

    // The copy that survives a Redis loss cannot be the second one written.
    expect(durable.hotAtWrite).toEqual([null]);
  });
});
