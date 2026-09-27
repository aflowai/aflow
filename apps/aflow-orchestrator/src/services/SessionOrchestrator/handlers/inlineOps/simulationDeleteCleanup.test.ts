import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InlineHandlerArgs } from './types.js';

type Row = Record<string, unknown>;

const tables = {
  apiBindings: { bindingId: 'bindingId', spaceId: 'spaceId', simulationId: 'simulationId' },
  simulationEntities: { spaceId: 'spaceId', simulationId: 'simulationId' },
  simulationBaselines: { spaceId: 'spaceId', simulationId: 'simulationId' },
  simulationCallRecords: {
    spaceId: 'spaceId',
    simulationId: 'simulationId',
    responseRef: 'responseRef',
    deltaRef: 'deltaRef',
  },
  simulationRunContexts: {
    spaceId: 'spaceId',
    simulationId: 'simulationId',
    snapshotRef: 'snapshotRef',
  },
  simulations: { spaceId: 'spaceId', simulationId: 'simulationId' },
};

const recorded = vi.hoisted(() => ({
  selectResults: [] as Row[][],
  deleteResults: [] as Row[][],
  deletedTables: [] as unknown[],
}));

const mockAddStepResult = vi.hoisted(() => vi.fn());

function chain(rows: () => Promise<Row[]>): Record<string, unknown> {
  const node: Record<string, unknown> = {
    then: (onOk: (value: Row[]) => unknown, onErr?: (reason: unknown) => unknown) =>
      rows().then(onOk, onErr),
  };
  for (const key of ['from', 'where', 'orderBy', 'limit', 'groupBy', 'returning', 'values']) {
    node[key] = () => node;
  }
  return node;
}

function nextSelect(): Promise<Row[]> {
  return Promise.resolve(recorded.selectResults.shift() ?? []);
}

function nextDelete(): Promise<Row[]> {
  return Promise.resolve(recorded.deleteResults.shift() ?? []);
}

vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  publishApiCatalogInvalidation: vi.fn(),
}));

vi.mock('@aflow/database', () => ({
  getDatabase: vi.fn(() => ({})),
  createTenantContext: vi.fn(() => ({})),
  withTenantSchema: vi.fn(async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({
      select: () => chain(nextSelect),
      selectDistinct: () => chain(nextSelect),
      delete: (table: unknown) => {
        recorded.deletedTables.push(table);
        return chain(nextDelete);
      },
      execute: () => Promise.resolve([]),
    }),
  ),
  ...tables,
}));

const { handleSimulationOpInline } = await import('./simulationAdmin.js');

const deletedPayloads: string[] = [];

function buildArgs(): InlineHandlerArgs {
  return {
    redis: {} as InlineHandlerArgs['redis'],
    payloadStore: {
      retrieve: vi.fn(() => Promise.resolve({ simulationId: 'billing-sim' })),
      shouldStore: vi.fn(() => false),
      store: vi.fn(() => Promise.resolve('inline:e30=')),
      delete: vi.fn((ref: string) => {
        deletedPayloads.push(ref);
        return Promise.resolve();
      }),
    } as unknown as InlineHandlerArgs['payloadStore'],
    context: {
      tenantId: 'a0000000-0000-0000-0000-000000000001',
      runId: 'run-1',
      spaceId: 'space-1',
      traceId: 'trace-1',
    } as unknown as InlineHandlerArgs['context'],
    stepDef: {
      stepId: 'step-1',
      stepType: 'integration',
      operation: 'integration.simulation.delete',
    } as unknown as InlineHandlerArgs['stepDef'],
    stepExecutionId: 'se-1' as InlineHandlerArgs['stepExecutionId'],
    idempotencyKey: 'idem-1' as InlineHandlerArgs['idempotencyKey'],
    resolvedInputRef: 'inline:e30=',
    attempt: 1,
    scheduledAtMs: Date.now(),
  };
}

function lastOutput(): Record<string, unknown> {
  const call = mockAddStepResult.mock.calls.at(-1);
  expect(call).toBeDefined();
  const result = call?.[1] as Record<string, unknown>;
  expect(result['status']).toBe('SUCCEEDED');
  const ref = result['outputRef'] as string;
  return JSON.parse(Buffer.from(ref.slice('inline:'.length), 'base64').toString('utf-8')) as Record<
    string,
    unknown
  >;
}

describe('integration.simulation.delete — deletion takes the rows, not the bytes', () => {
  beforeEach(() => {
    recorded.selectResults = [];
    recorded.deleteResults = [];
    recorded.deletedTables = [];
    deletedPayloads.length = 0;
    mockAddStepResult.mockClear();
  });

  it('removes the run pins and every table describing the deleted contract', async () => {
    recorded.selectResults = [[{ bindingId: 'billing-binding' }]];
    recorded.deleteResults = [[], [], [], [], [{ simulationId: 'billing-sim' }]];

    await handleSimulationOpInline(buildArgs());

    expect(recorded.deletedTables).toContain(tables.simulationRunContexts);
    expect(recorded.deletedTables).toContain(tables.simulationBaselines);
    expect(recorded.deletedTables).toContain(tables.simulationCallRecords);
    expect(lastOutput()).toMatchObject({
      simulationId: 'billing-sim',
      deleted: true,
      orphanedBindingIds: ['billing-binding'],
    });
  });

  it('deletes no payload object, because the bytes may be another simulation’s too', async () => {
    // Responses, deltas and snapshots are content-addressed PER TENANT, so two
    // simulations that ever produced the same bytes — a shared 404 body, an
    // empty delta — resolve to one object. A survivor query cannot make this
    // safe: it sees committed rows, and a concurrent writer can have stored the
    // same address with its row still uncommitted. Deleting then breaks a
    // journal at exactly the moment content addressing is working.
    //
    // Orphaned objects are the cheaper wrong answer than a dangling reference.
    // Reclaiming them belongs to a candidate-driven GC job, not to this handler.
    recorded.selectResults = [[]];
    recorded.deleteResults = [[], [], [], [], [{ simulationId: 'billing-sim' }]];

    await handleSimulationOpInline(buildArgs());

    expect(deletedPayloads).toEqual([]);
  });
});
