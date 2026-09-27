import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Simulation } from '@aflow/schemas';
import type { InlineHandlerArgs } from './types.js';
import type { SimulationScope } from './simulationStore.js';

type Row = Record<string, unknown>;

const tables = {
  apiDefinitions: { apiId: 'apiId', spaceId: 'spaceId', definitionJson: 'definitionJson' },
  simulationBaselines: {
    spaceId: 'spaceId',
    simulationId: 'simulationId',
    version: 'version',
    description: 'description',
    entityCounts: 'entityCounts',
    createdAt: 'createdAt',
  },
  simulationEntities: {
    spaceId: 'spaceId',
    simulationId: 'simulationId',
    version: 'version',
    collection: 'collection',
    entityId: 'entityId',
    bodyJson: 'bodyJson',
  },
  simulations: { spaceId: 'spaceId', simulationId: 'simulationId' },
};

const recorded = vi.hoisted(() => ({
  selectResults: [] as Row[][],
  insertResults: [] as Row[][],
  insertedValues: [] as unknown[],
  executed: [] as unknown[],
  pinned: null as unknown,
  baselineEntities: [] as Array<{
    collection: string;
    entityId: string;
    body: Record<string, unknown>;
  }>,
  simulation: null as unknown,
}));

function chain(rows: () => Promise<Row[]>): Record<string, unknown> {
  const node: Record<string, unknown> = {
    then: (onOk: (value: Row[]) => unknown, onErr?: (reason: unknown) => unknown) =>
      rows().then(onOk, onErr),
  };
  for (const key of [
    'from',
    'where',
    'orderBy',
    'limit',
    'groupBy',
    'onConflictDoNothing',
    'returning',
  ]) {
    node[key] = () => node;
  }
  node['values'] = (value: unknown) => {
    recorded.insertedValues.push(value);
    return node;
  };
  return node;
}

vi.mock('@aflow/redis', () => ({
  getSimulationRunContext: () => Promise.resolve(null),
}));

vi.mock('@aflow/database', () => ({
  getDatabase: vi.fn(() => ({})),
  createTenantContext: vi.fn(() => ({})),
  withTenantSchema: vi.fn(async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({
      select: () => chain(() => Promise.resolve(recorded.selectResults.shift() ?? [])),
      insert: () => chain(() => Promise.resolve(recorded.insertResults.shift() ?? [])),
      delete: () => chain(() => Promise.resolve([])),
      execute: (statement: unknown) => {
        recorded.executed.push(statement);
        return Promise.resolve([]);
      },
    }),
  ),
  readSimulationRunContext: () => Promise.resolve(recorded.pinned),
  readCallRecords: () => Promise.resolve([]),
  readBaselineEntities: () => Promise.resolve(recorded.baselineEntities),
  ...tables,
}));

function artifact(ordersRequired: string[]): Simulation {
  return {
    simulationId: 'billing-sim',
    revision: 3,
    name: 'Billing',
    targets: { sourceKind: 'api', integrationId: 'billing' },
    domainBrief: 'A billing API.',
    collections: [
      {
        collection: 'customers',
        identityField: 'customerId',
        schema: { type: 'object', required: ['customerId'] },
      },
      {
        collection: 'orders',
        identityField: 'orderId',
        schema: { type: 'object', required: ordersRequired },
      },
    ],
    ruleProfiles: [],
    effects: {},
    policy: { unmatched: 'generate', agentAwareness: 'transparent', maxGeneratedCallsPerRun: 20 },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  } as unknown as Simulation;
}

vi.mock('./simulationStore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./simulationStore.js')>();
  return {
    ...actual,
    readSimulationRow: () =>
      Promise.resolve({ simulation: recorded.simulation, targetApiId: 'billing' }),
  };
});

const { handleSimulationWorldOp } = await import('./simulationWorld.js');

const scope: SimulationScope = {
  db: {} as SimulationScope['db'],
  tenantCtx: {} as SimulationScope['tenantCtx'],
  tenantId: 'a0000000-0000-0000-0000-000000000001' as SimulationScope['tenantId'],
  spaceId: '9e842431-cb9a-477d-b090-e33e601a4c83',
};

const args = {
  redis: {} as InlineHandlerArgs['redis'],
  payloadStore: {} as InlineHandlerArgs['payloadStore'],
} as unknown as InlineHandlerArgs;

function renderedStatements(): string[] {
  const dialect = new PgDialect();
  return recorded.executed.map((statement) => dialect.sqlToQuery(statement as SQL).sql);
}

function writtenEntities(): Array<Record<string, unknown>> {
  return recorded.insertedValues
    .filter((value): value is Array<Record<string, unknown>> => Array.isArray(value))
    .flat();
}

describe('integration.simulation.seed — a baseline version is immutable', () => {
  beforeEach(() => {
    recorded.selectResults = [];
    recorded.insertResults = [];
    recorded.insertedValues = [];
    recorded.executed = [];
    recorded.pinned = null;
    recorded.baselineEntities = [];
    recorded.simulation = artifact(['orderId']);
  });

  async function seed(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { output } = await handleSimulationWorldOp(
      args,
      scope,
      'integration.simulation.seed',
      input,
    );
    return output;
  }

  it('mints the next version and carries forward the collections the payload leaves out', async () => {
    recorded.selectResults = [
      // Latest baseline version.
      [{ version: 2 }],
      // The carried collections, read out of version 2.
      [{ collection: 'orders', bodyJson: { orderId: 'ord_1' } }],
      // Entity counts of the newly minted version.
      [
        { collection: 'customers', total: 1 },
        { collection: 'orders', total: 1 },
      ],
    ];
    recorded.insertResults = [
      [],
      [
        {
          version: 3,
          description: null,
          entityCounts: { customers: 1, orders: 1 },
          createdAt: new Date('2026-08-02T00:00:00.000Z'),
        },
      ],
    ];

    const output = await seed({
      simulationId: 'billing-sim',
      entities: { customers: [{ customerId: 'cus_1' }] },
    });

    expect(output['baseline']).toMatchObject({ version: 3 });
    // Both halves land in version 3: the supplied customer and the order the
    // payload said nothing about.
    expect(writtenEntities()).toEqual([
      {
        spaceId: scope.spaceId,
        simulationId: 'billing-sim',
        version: 3,
        collection: 'orders',
        entityId: 'ord_1',
        bodyJson: { orderId: 'ord_1' },
      },
      {
        spaceId: scope.spaceId,
        simulationId: 'billing-sim',
        version: 3,
        collection: 'customers',
        entityId: 'cus_1',
        bodyJson: { customerId: 'cus_1' },
      },
    ]);
  });

  it('refuses to carry forward rows the current collection declaration rejects', async () => {
    // The artifact now requires `status` on an order; version 2 was seeded
    // before it did.
    recorded.simulation = artifact(['orderId', 'status']);
    recorded.selectResults = [
      [{ version: 2 }],
      [{ collection: 'orders', bodyJson: { orderId: 'ord_1' } }],
    ];

    const rejection = await seed({
      simulationId: 'billing-sim',
      entities: { customers: [{ customerId: 'cus_1' }] },
    }).then(
      () => null,
      (err: unknown) => err,
    );

    expect(rejection).toMatchObject({ code: 'SIMULATION_SEED_REJECTED' });
    // The violation names the collection and the entity, and says which half of
    // the world it came from.
    expect((rejection as Error).message).toMatch(/orders\[0\].*"ord_1"/);
    expect((rejection as Error).message).toContain('carried forward');

    // Nothing was written: the rejected world never became a version a run
    // could pin.
    expect(writtenEntities()).toEqual([]);
  });

  it('refuses a write to a version that already exists', async () => {
    recorded.selectResults = [
      // Latest baseline version.
      [{ version: 2 }],
      // The requested version is occupied.
      [{ version: 2 }],
    ];

    await expect(
      seed({
        simulationId: 'billing-sim',
        baselineVersion: 2,
        entities: { customers: [{ customerId: 'cus_1' }] },
      }),
    ).rejects.toMatchObject({ code: 'SIMULATION_BASELINE_IMMUTABLE' });

    expect(writtenEntities()).toEqual([]);
    expect(renderedStatements().some((text) => text.includes('pg_advisory_xact_lock'))).toBe(true);
  });
});

describe('integration.simulation.freeze — a freeze promotes a run’s world', () => {
  beforeEach(() => {
    recorded.selectResults = [];
    recorded.insertResults = [];
    recorded.insertedValues = [];
    recorded.executed = [];
    recorded.pinned = null;
    recorded.simulation = artifact(['orderId']);
  });

  it('refuses to promote a world the current collection declarations reject', async () => {
    // The run is pinned to revision 2 and has been writing orders without a
    // `status`; the artifact has since started requiring one. Freezing anyway
    // would publish rows every later run pins and none can validly extend —
    // the copy-forward gap `seed` already closes on its own write path.
    recorded.simulation = artifact(['orderId', 'status']);
    recorded.baselineEntities = [
      { collection: 'orders', entityId: 'ord_1', body: { orderId: 'ord_1' } },
    ];
    recorded.pinned = {
      simulationId: 'billing-sim',
      simulationRevision: 2,
      baselineVersion: 1,
      snapshotRef: 'gs://bucket/snapshot',
      definitionHash: 'hash',
      seed: 'seed',
      clockAnchorMs: 0,
    };

    const rejection = await handleSimulationWorldOp(args, scope, 'integration.simulation.freeze', {
      simulationId: 'billing-sim',
      runId: '265a4135-2103-48f2-92ae-000000000002',
      expectedVersion: 1,
    }).then(
      () => null,
      (err: unknown) => err,
    );

    expect(rejection).toMatchObject({ code: 'SIMULATION_FREEZE_REJECTED' });
    expect((rejection as Error).message).toMatch(/orders\[0\]/);
    // It names the pinned revision, because that is what explains the gap.
    expect((rejection as Error).message).toContain('revision 2');
    expect(recorded.insertResults).toHaveLength(0);
    expect(writtenEntities()).toEqual([]);
  });

  it('refuses a run that never pinned this simulation', async () => {
    await expect(
      handleSimulationWorldOp(args, scope, 'integration.simulation.freeze', {
        simulationId: 'billing-sim',
        runId: '265a4135-2103-48f2-92ae-000000000001',
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: 'SIMULATION_RUN_CONTEXT_MISSING' });

    expect(recorded.insertResults).toHaveLength(0);
  });
});
