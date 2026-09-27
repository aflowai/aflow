import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { TenantId } from '@aflow/schemas';

type Row = Record<string, unknown>;

const recorded = vi.hoisted(() => ({
  insertedValues: [] as Row[],
  insertResult: [] as Row[],
  selectResult: [] as Row[],
}));

function chain(rows: () => Row[], onValues?: (value: Row) => void): Record<string, unknown> {
  const node: Record<string, unknown> = {
    then: (onOk: (value: Row[]) => unknown, onErr?: (reason: unknown) => unknown) =>
      Promise.resolve(rows()).then(onOk, onErr),
  };
  for (const key of ['from', 'where', 'orderBy', 'limit', 'onConflictDoNothing', 'returning']) {
    node[key] = () => node;
  }
  node['values'] = (value: Row) => {
    onValues?.(value);
    return node;
  };
  return node;
}

vi.mock('../tenant/queries.js', () => ({
  withTenantSchema: (_db: unknown, _ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({
      insert: () =>
        chain(
          () => recorded.insertResult,
          (value) => recorded.insertedValues.push(value),
        ),
      select: () => chain(() => recorded.selectResult),
    }),
}));

const { ensureSimulationBaseline } = await import('./simulationBaseline.js');

const key = {
  db: {} as PostgresJsDatabase,
  tenantId: 'a0000000-0000-0000-0000-000000000001' as TenantId,
  spaceId: '9e842431-cb9a-477d-b090-e33e601a4c83',
  simulationId: 'billing-sim',
};

describe('ensureSimulationBaseline — an empty world is a real version', () => {
  beforeEach(() => {
    recorded.insertedValues = [];
    recorded.insertResult = [];
    recorded.selectResult = [];
  });

  it('mints an empty first version rather than a version number nothing occupies', async () => {
    const createdAt = new Date('2026-08-01T00:00:00.000Z');
    recorded.insertResult = [{ version: 1, createdAt }];

    const head = await ensureSimulationBaseline(key);

    expect(head).toEqual({ version: 1, createdAt });
    // The version a run pins is now a row: the next seed reads it as the prior
    // version and mints 2, so the pinned world can never acquire that seed.
    expect(recorded.insertedValues).toEqual([
      {
        spaceId: key.spaceId,
        simulationId: key.simulationId,
        version: 1,
        entityCounts: {},
      },
    ]);
  });

  it('yields to a seed that took the first version while this insert was building it', async () => {
    const seeded = new Date('2026-08-02T00:00:00.000Z');
    recorded.insertResult = [];
    recorded.selectResult = [{ version: 1, createdAt: seeded }];

    await expect(ensureSimulationBaseline(key)).resolves.toEqual({ version: 1, createdAt: seeded });
  });

  it('refuses to answer with a version when neither the insert nor the read produced one', async () => {
    recorded.insertResult = [];
    recorded.selectResult = [];

    await expect(ensureSimulationBaseline(key)).rejects.toThrow(/has no baseline version/);
  });
});
