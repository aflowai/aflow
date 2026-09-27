import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { ApiBinding, ApiDefinition, Simulation } from '@aflow/schemas';
import { createTenantPolicyCache } from '@aflow/database';
import { loadSimulation } from './loadSimulation.js';
import type { ApiHandlerStores } from '../types.js';

type Row = Record<string, unknown>;

/**
 * Stands in for `simulation_baselines`: the versions this simulation actually
 * holds. `ensure` is insert-if-absent, so a version it hands back is a version
 * the table is occupied by from that moment on.
 */
const baselines = vi.hoisted(() => ({
  versions: new Map<number, Date>(),
  ensureCalls: [] as Array<Record<string, unknown>>,
  selectResults: [] as Row[][],
}));

function chain(rows: () => Row[]): Record<string, unknown> {
  const node: Record<string, unknown> = {
    then: (onOk: (value: Row[]) => unknown, onErr?: (reason: unknown) => unknown) =>
      Promise.resolve(rows()).then(onOk, onErr),
  };
  for (const key of ['from', 'where', 'orderBy', 'limit']) node[key] = () => node;
  return node;
}

vi.mock('@aflow/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/database')>();
  return {
    ...actual,
    withTenantSchema: (_db: unknown, _ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn({ select: () => chain(() => baselines.selectResults.shift() ?? []) }),
    ensureSimulationBaseline: (key: Record<string, unknown>) => {
      baselines.ensureCalls.push(key);
      const existing = [...baselines.versions.keys()].sort((a, b) => b - a)[0];
      if (existing !== undefined) {
        return Promise.resolve({ version: existing, createdAt: baselines.versions.get(existing) });
      }
      const createdAt = new Date('2026-08-01T00:00:00.000Z');
      baselines.versions.set(1, createdAt);
      return Promise.resolve({ version: 1, createdAt });
    },
  };
});

const db = {} as PostgresJsDatabase;

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SPACE = '9e842431-cb9a-477d-b090-e33e601a4c83';

const simulation = {
  simulationId: 'billing-sim',
  revision: 1,
  name: 'Billing',
  targets: { sourceKind: 'api', integrationId: 'billing' },
  domainBrief: '',
  collections: [],
  ruleProfiles: [],
  effects: {},
  policy: { unmatched: 'generate', agentAwareness: 'transparent', maxGeneratedCallsPerRun: 20 },
} as unknown as Simulation;

const binding = {
  bindingId: 'billing-demo',
  apiId: 'billing',
  fulfillment: { mode: 'simulated', simulationId: 'billing-sim' },
} as unknown as Pick<ApiBinding, 'bindingId' | 'apiId' | 'fulfillment'>;

const definition = {
  apiId: 'billing',
  callMode: 'endpoint',
  endpoints: [
    {
      endpointId: 'getInvoice',
      name: 'Get invoice',
      method: 'GET',
      pathTemplate: '/invoices/{invoiceId}',
      params: [],
      writeRiskTier: 'read',
    },
  ],
} as unknown as Pick<ApiDefinition, 'apiId' | 'callMode' | 'endpoints'>;

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

function load(): ReturnType<typeof loadSimulation> {
  return loadSimulation(
    stores(),
    { db },
    { tenantId: TENANT, spaceId: SPACE, simulationId: 'billing-sim', binding, definition },
  );
}

describe('loadSimulation — the version a run pins is a version that exists', () => {
  beforeEach(() => {
    baselines.versions.clear();
    baselines.ensureCalls.length = 0;
    baselines.selectResults = [];
  });

  it('persists an empty baseline for a simulation that has none', async () => {
    baselines.selectResults = [[{ definitionJson: simulation, enabled: 1 }], []];

    const loaded = await load();

    expect(baselines.ensureCalls).toEqual([
      { db, tenantId: TENANT, spaceId: SPACE, simulationId: 'billing-sim' },
    ]);
    expect(loaded.baselineVersion).toBe(1);
    expect(loaded.baselineCreatedAtMs).toBe(new Date('2026-08-01T00:00:00.000Z').getTime());
    // The pinned version is occupied, so the first seed mints the version after
    // it rather than filling the one this run is reading.
    expect([...baselines.versions.keys()]).toEqual([1]);
  });

  it('reads the latest baseline when the simulation already has one', async () => {
    baselines.selectResults = [
      [{ definitionJson: simulation, enabled: 1 }],
      [{ version: 3, createdAt: new Date('2026-08-05T00:00:00.000Z') }],
    ];

    const loaded = await load();

    expect(baselines.ensureCalls).toHaveLength(0);
    expect(loaded.baselineVersion).toBe(3);
    expect(loaded.baselineCreatedAtMs).toBe(new Date('2026-08-05T00:00:00.000Z').getTime());
  });
});
