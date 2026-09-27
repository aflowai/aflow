import { describe, it, expect } from 'vitest';
import { getTableName, type Table } from 'drizzle-orm';
import { ensureSpaceLoaded } from './spaceLoader.js';
import { spaceScopeKey, type ApiHandlerStores } from './types.js';

const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const SPACE_ID = 'b0000000-0000-4000-8000-000000000001';

type RelationReader = (relation: string) => Array<Record<string, unknown>>;

function stores(): ApiHandlerStores {
  return {
    definitionStore: new Map(),
    invalidDefinitions: new Map(),
    bindingStore: new Map(),
    credentialStore: new Map(),
    loadedAtMs: new Map(),
    loadPromises: new Map(),
    tenantPolicyCache: {
      load: () => Promise.resolve({ mode: 'open', allowlist: [] }),
      peek: () => undefined,
    },
    catalogGrantStore: new Map(),
    spaceWritePolicyStore: new Map(),
    simulationStore: new Map(),
    simulationLoadPromises: new Map(),
    simulationSnapshotStore: new Map(),
  } as unknown as ApiHandlerStores;
}

/** postgres.js reports the SQLSTATE on `code`; drizzle rethrows it as `cause`. */
function driverError(message: string, code?: string): Error {
  const inner =
    code !== undefined ? Object.assign(new Error(message), { code }) : new Error(message);
  return Object.assign(new Error('Failed query'), { cause: inner });
}

function fakeDb(read: RelationReader): unknown {
  const tx = {
    execute: () => Promise.resolve(undefined),
    select: () => ({
      from: (table: Table) => {
        const rows = () => Promise.resolve(read(getTableName(table)));
        const chain = {
          where: () => {
            const pending = rows();
            return Object.assign(pending, { limit: () => pending });
          },
        };
        return chain;
      },
    }),
  };
  return { transaction: (cb: (tx: unknown) => Promise<unknown>) => cb(tx) };
}

function simulatedBindingRow(): Record<string, unknown> {
  return {
    bindingId: 'bnd-sim',
    apiId: 'alpaca-account-read',
    name: 'Simulated Alpaca',
    scopeJson: { tenantId: TENANT_ID, spaceId: SPACE_ID },
    authJson: { type: 'none' },
    egressPolicyJson: { allowedHosts: ['api.example.com'] },
    fulfillmentMode: 'simulated',
    simulationId: 'sim-1',
    enabled: 1,
  };
}

describe('loadSpaceData relation reads', () => {
  it('reads the fulfillment columns in one pass, with no pre-migration retry', async () => {
    const s = stores();
    await ensureSpaceLoaded(
      s,
      { db: fakeDb((relation) => (relation === 'api_bindings' ? [simulatedBindingRow()] : [])) },
      TENANT_ID,
      SPACE_ID,
    );

    const loaded = s.bindingStore.get(spaceScopeKey(TENANT_ID, SPACE_ID));
    expect(loaded).toHaveLength(1);
    expect(loaded?.[0]?.fulfillment).toEqual({ mode: 'simulated', simulationId: 'sim-1' });
  });

  it('propagates a failure that is not an absent relation instead of emptying the space', async () => {
    const s = stores();
    const db = fakeDb((relation) => {
      if (relation === 'api_bindings') throw driverError('connection terminated unexpectedly');
      return [];
    });

    await expect(ensureSpaceLoaded(s, { db }, TENANT_ID, SPACE_ID)).rejects.toThrow('Failed query');
    expect(s.bindingStore.has(spaceScopeKey(TENANT_ID, SPACE_ID))).toBe(false);
    expect(s.loadedAtMs.has(spaceScopeKey(TENANT_ID, SPACE_ID))).toBe(false);
  });

  it('propagates a permission error on the write-policy read', async () => {
    const s = stores();
    const db = fakeDb((relation) => {
      if (relation === 'spaces') throw driverError('permission denied for table spaces', '42501');
      return [];
    });

    await expect(ensureSpaceLoaded(s, { db }, TENANT_ID, SPACE_ID)).rejects.toThrow('Failed query');
  });

  it('tolerates an absent column on the write-policy read', async () => {
    const s = stores();
    const db = fakeDb((relation) => {
      if (relation === 'spaces') {
        throw driverError('column "write_policy" does not exist', '42703');
      }
      return [];
    });

    await ensureSpaceLoaded(s, { db }, TENANT_ID, SPACE_ID);
    expect(s.loadedAtMs.has(spaceScopeKey(TENANT_ID, SPACE_ID))).toBe(true);
  });
});
