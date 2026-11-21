import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogEntry, StoreInstall } from '@aflow/schemas';

const state = vi.hoisted(() => ({
  storeUpdates: 'follow-catalog' as 'follow-catalog' | 'manual',
  autonomy: 'full' as 'full' | 'ratify',
  installs: [] as StoreInstall[],
  owner: 'u0000000-0000-4000-8000-000000000001' as string | null,
}));
const executeStoreUpdate = vi.hoisted(() => vi.fn());
const bumpSpaceContextGen = vi.hoisted(() => vi.fn(async () => true));

vi.mock('@aflow/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aflow/database')>()),
  withTenantSchema: async (_db: unknown, _ctx: unknown, fn: (tx: never) => Promise<unknown>) =>
    fn({} as never),
}));
vi.mock('@aflow/redis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aflow/redis')>()),
  bumpSpaceContextGen,
}));
vi.mock('../spaceAutonomy.js', () => ({
  readSpaceAutonomyPolicy: async () => ({
    autonomy: state.autonomy,
    storeUpdates: state.storeUpdates,
  }),
  readSpaceOwnerUserId: async () => state.owner,
}));
vi.mock('../logger.js', () => ({
  getCyberneticLogger: () => ({ info: () => undefined, warn: () => undefined }),
}));
vi.mock('./storeInstallProvenance.js', () => ({ listStoreInstalls: async () => state.installs }));
vi.mock('./storeUpdateExecution.js', () => ({ executeStoreUpdate }));

const {
  followStoreCatalog,
  listStoreFollowedUpdates,
  storeCatalogFingerprint,
  storeFollowRetryDelayMs,
  STORE_FOLLOW_RETRY_BASE_MS,
  STORE_FOLLOW_RETRY_MAX_MS,
} = await import('./storeFollowCatalog.js');

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SPACE = 'b0000000-0000-4000-8000-000000000002';
const NOW = '2026-11-21T20:00:00.000Z';

function entry(catalogId: string, version: number): CatalogEntry {
  return { catalogId, version, name: catalogId, kind: 'bundle' } as unknown as CatalogEntry;
}

function install(catalogId: string, installedVersion: number): StoreInstall {
  return { catalogId, installedVersion, state: 'installed' } as unknown as StoreInstall;
}

function fakeRedis() {
  const values = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const redis = {
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => {
      values.set(key, value);
      return 'OK';
    },
    del: async (key: string) => {
      values.delete(key);
      return 1;
    },
    lrange: async (key: string, start: number, stop: number) =>
      (lists.get(key) ?? []).slice(start, stop + 1),
    multi: () => {
      const ops: Array<() => void> = [];
      const chain = {
        lpush: (key: string, ...items: string[]) => {
          ops.push(() => lists.set(key, [...items.reverse(), ...(lists.get(key) ?? [])]));
          return chain;
        },
        ltrim: () => chain,
        expire: () => chain,
        exec: async () => {
          for (const op of ops) op();
          return [];
        },
      };
      return chain;
    },
  };
  return redis as never;
}

const CATALOG = [entry('trading-joe', 7), entry('github', 2)];
const resolve = (catalogId: string) => CATALOG.find((e) => e.catalogId === catalogId) ?? null;

function params(redis: never, at: string = NOW) {
  return {
    db: {} as never,
    redis,
    tenantId: TENANT,
    spaceId: SPACE,
    entryResolver: resolve,
    fingerprint: storeCatalogFingerprint(CATALOG),
    now: () => new Date(at),
  };
}

function updated(catalogId: string, fromVersion: number, toVersion: number) {
  return {
    ok: true,
    response: {
      catalogId,
      mode: 'update',
      fromVersion,
      toVersion,
      updatedArtifacts: [
        { artifactType: 'skill', artifactKey: 'daily-trading-cycle', action: 'replaced' },
      ],
      keptUserDataArtifacts: [],
      orphanedArtifacts: [],
      credentialsReset: false,
      missingVariables: [],
      setupChecklist: [],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.storeUpdates = 'follow-catalog';
  state.autonomy = 'full';
  state.installs = [install('trading-joe', 6), install('github', 2)];
  state.owner = 'u0000000-0000-4000-8000-000000000001';
});

describe('a space that follows the Store catalog (Plan 345 B3)', () => {
  it('applies each update the catalog offers on the update path, records it, and tells the Helmsman', async () => {
    executeStoreUpdate.mockResolvedValueOnce(updated('trading-joe', 6, 7));
    const redis = fakeRedis();

    const followed = await followStoreCatalog(params(redis));

    expect(executeStoreUpdate).toHaveBeenCalledTimes(1);
    expect(executeStoreUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        catalogId: 'trading-joe',
        expectedVersion: 7,
        mode: 'update',
        actorUserId: state.owner,
      }),
    );
    expect(followed).toEqual([
      {
        catalogId: 'trading-joe',
        name: 'trading-joe',
        fromVersion: 6,
        toVersion: 7,
        at: NOW,
        outcome: 'applied',
        reconcile: ['daily-trading-cycle'],
      },
    ]);
    expect(await listStoreFollowedUpdates(redis, TENANT, SPACE)).toEqual(followed);
    expect(bumpSpaceContextGen).toHaveBeenCalledWith(redis, TENANT, SPACE);
  });

  it('reads nothing more once the space has followed this catalog', async () => {
    executeStoreUpdate.mockResolvedValueOnce(updated('trading-joe', 6, 7));
    const redis = fakeRedis();
    await followStoreCatalog(params(redis));
    executeStoreUpdate.mockClear();

    expect(await followStoreCatalog(params(redis))).toEqual([]);
    expect(executeStoreUpdate).not.toHaveBeenCalled();
  });

  it('leaves a customized install to the Helmsman and does not offer it again until the catalog moves', async () => {
    executeStoreUpdate.mockResolvedValueOnce({
      ok: false,
      statusCode: 409,
      body: { error: 'Customized', code: 'STORE_CUSTOMIZED' },
    });
    const redis = fakeRedis();

    const [only] = await followStoreCatalog(params(redis));
    expect(only).toMatchObject({ outcome: 'customized', detail: 'Customized', reconcile: [] });
    executeStoreUpdate.mockClear();
    expect(await followStoreCatalog(params(redis))).toEqual([]);
    expect(executeStoreUpdate).not.toHaveBeenCalled();
  });

  const busy = {
    ok: false,
    statusCode: 409,
    body: { error: 'Busy', code: 'STORE_MUTATION_IN_PROGRESS' },
  };
  const later = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();

  it('tries a failed update again only once its wait has passed', async () => {
    executeStoreUpdate.mockResolvedValueOnce(busy);
    const redis = fakeRedis();
    const [first] = await followStoreCatalog(params(redis));
    expect(first?.outcome).toBe('failed');

    // Within the wait: nothing is tried, listed or invalidated.
    executeStoreUpdate.mockClear();
    bumpSpaceContextGen.mockClear();
    expect(await followStoreCatalog(params(redis, later(1_000)))).toEqual([]);
    expect(executeStoreUpdate).not.toHaveBeenCalled();
    expect(bumpSpaceContextGen).not.toHaveBeenCalled();

    executeStoreUpdate.mockResolvedValueOnce(updated('trading-joe', 6, 7));
    const [second] = await followStoreCatalog(params(redis, later(STORE_FOLLOW_RETRY_BASE_MS)));
    expect(second?.outcome).toBe('applied');
  });

  it('lists a failure that repeats once, and doubles the wait each time', async () => {
    executeStoreUpdate.mockResolvedValue(busy);
    const redis = fakeRedis();
    await followStoreCatalog(params(redis));
    bumpSpaceContextGen.mockClear();

    expect(await followStoreCatalog(params(redis, later(STORE_FOLLOW_RETRY_BASE_MS)))).toEqual([]);
    expect(executeStoreUpdate).toHaveBeenCalledTimes(2);
    expect(bumpSpaceContextGen).not.toHaveBeenCalled();
    expect(await listStoreFollowedUpdates(redis, TENANT, SPACE)).toHaveLength(1);

    // The second failure waits twice the first wait: one base later is too soon.
    await followStoreCatalog(params(redis, later(2 * STORE_FOLLOW_RETRY_BASE_MS)));
    expect(executeStoreUpdate).toHaveBeenCalledTimes(2);
    expect(storeFollowRetryDelayMs(2)).toBe(2 * STORE_FOLLOW_RETRY_BASE_MS);
    expect(storeFollowRetryDelayMs(50)).toBe(STORE_FOLLOW_RETRY_MAX_MS);
    executeStoreUpdate.mockReset();
  });

  it.each([
    ['keeps its updates manual', () => (state.storeUpdates = 'manual')],
    ['has the autonomy ratify', () => (state.autonomy = 'ratify')],
  ])(
    'applies nothing where the space %s, and takes the pending update once it follows',
    async (_why, hold) => {
      hold();
      const redis = fakeRedis();
      expect(await followStoreCatalog(params(redis))).toEqual([]);
      expect(executeStoreUpdate).not.toHaveBeenCalled();

      state.storeUpdates = 'follow-catalog';
      state.autonomy = 'full';
      executeStoreUpdate.mockResolvedValueOnce(updated('trading-joe', 6, 7));
      const [taken] = await followStoreCatalog(params(redis));
      expect(taken?.outcome).toBe('applied');
    },
  );
});
