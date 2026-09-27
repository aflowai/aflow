import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAuthzCacheForTests,
  canReadSession,
  invalidateRealtimeSpaceAuthzCache,
} from './authz.js';

const mocks = vi.hoisted(() => {
  const tables = {
    sessions: {
      sessionId: 'sessions.sessionId',
      spaceId: 'sessions.spaceId',
    },
    spaces: {
      id: 'spaces.id',
      ownerId: 'spaces.ownerId',
    },
    tenantMemberships: {
      tenantId: 'tenantMemberships.tenantId',
      userId: 'tenantMemberships.userId',
      role: 'tenantMemberships.role',
    },
    spaceMemberships: {
      tenantId: 'spaceMemberships.tenantId',
      userId: 'spaceMemberships.userId',
      spaceId: 'spaceMemberships.spaceId',
      role: 'spaceMemberships.role',
    },
  };

  return {
    tables,
    getSessionStateSafe: vi.fn(),
    withTenantSchema: vi.fn(),
  };
});

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ kind: 'and', args }),
  eq: (...args: unknown[]) => ({ kind: 'eq', args }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ kind: 'sql', strings, values }),
}));

vi.mock('@aflow/redis', () => ({
  getSessionStateSafe: (...args: unknown[]) => mocks.getSessionStateSafe(...args),
}));

vi.mock('@aflow/database', () => ({
  createTenantContext: (tenantId: string) => ({ tenantId }),
  sessions: mocks.tables.sessions,
  spaces: mocks.tables.spaces,
  tenantMemberships: mocks.tables.tenantMemberships,
  spaceMemberships: mocks.tables.spaceMemberships,
  withTenantSchema: (...args: unknown[]) => mocks.withTenantSchema(...args),
}));

type Row = Record<string, unknown>;

interface QueryHarness {
  api: {
    select: ReturnType<typeof vi.fn>;
  };
  fromTables: unknown[];
}

function makeQueryable(
  resolveRows: (table: unknown) => Row[],
  resolveAggregate?: (table: unknown) => Row[],
): QueryHarness {
  const fromTables: unknown[] = [];
  const api = {
    select: vi.fn((_shape: unknown) => ({
      from: vi.fn((table: unknown) => {
        fromTables.push(table);
        return {
          // Awaitable directly (aggregate query, no .limit) or via .limit(n).
          where: vi.fn((_where: unknown) => ({
            limit: vi.fn(async (_limit: number) => resolveRows(table)),
            then: (resolve: (rows: Row[]) => unknown, reject?: (err: unknown) => unknown) =>
              Promise.resolve((resolveAggregate ?? resolveRows)(table)).then(resolve, reject),
          })),
        };
      }),
    })),
  };
  return { api, fromTables };
}

interface RowSetup {
  tenantRows?: Row[];
  memberRows?: Row[];
  sessionRows?: Row[];
  ownerRows?: Row[];
  /** Total membership rows for the space (defaults to memberRows length). */
  memberCount?: number;
}

function setupRows(rows: RowSetup): {
  db: PostgresJsDatabase;
  redis: Redis;
  txFromTables: unknown[];
} {
  const publicDb = makeQueryable(
    (table) => {
      if (table === mocks.tables.tenantMemberships) return rows.tenantRows ?? [];
      if (table === mocks.tables.spaceMemberships) return rows.memberRows ?? [];
      throw new Error('unexpected public table');
    },
    (table) => {
      if (table === mocks.tables.spaceMemberships) {
        return [{ count: rows.memberCount ?? (rows.memberRows ?? []).length }];
      }
      throw new Error('unexpected aggregate table');
    },
  );
  const tenantTx = makeQueryable((table) => {
    if (table === mocks.tables.sessions) return rows.sessionRows ?? [];
    if (table === mocks.tables.spaces) return rows.ownerRows ?? [];
    throw new Error('unexpected tenant table');
  });

  mocks.withTenantSchema.mockImplementation(
    async (_db: unknown, _tenantContext: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn(tenantTx.api),
  );

  return {
    db: publicDb.api as unknown as PostgresJsDatabase,
    redis: {} as Redis,
    txFromTables: tenantTx.fromTables,
  };
}

describe('canReadSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetAuthzCacheForTests();
  });

  it('authorizes a fresh Redis-hot session without requiring a Postgres session row', async () => {
    mocks.getSessionStateSafe.mockResolvedValue({
      ok: true,
      state: { spaceId: 'space-hot' },
    });
    const { db, redis, txFromTables } = setupRows({
      tenantRows: [{ role: 'member' }],
      ownerRows: [{ ownerId: 'user-1' }],
      sessionRows: [],
    });

    await expect(canReadSession(db, redis, 'tenant-1', 'user-1', 'session-1')).resolves.toBe(true);

    expect(mocks.getSessionStateSafe).toHaveBeenCalledWith(redis, 'tenant-1', 'session-1');
    expect(txFromTables).toContain(mocks.tables.spaces);
    expect(txFromTables).not.toContain(mocks.tables.sessions);
  });

  it('does not fall back to Postgres when Redis resolved the session to an unreadable space', async () => {
    mocks.getSessionStateSafe.mockResolvedValue({
      ok: true,
      state: { spaceId: 'space-hot' },
    });
    const { db, redis, txFromTables } = setupRows({
      tenantRows: [{ role: 'member' }],
      ownerRows: [{ ownerId: 'someone-else' }],
      memberRows: [],
      sessionRows: [{ spaceId: 'space-pg' }],
    });

    await expect(canReadSession(db, redis, 'tenant-1', 'user-1', 'session-1')).resolves.toBe(false);

    expect(txFromTables).toContain(mocks.tables.spaces);
    expect(txFromTables).not.toContain(mocks.tables.sessions);
  });

  it('falls back to Postgres when Redis hot state is unavailable', async () => {
    mocks.getSessionStateSafe.mockResolvedValue({ ok: false, reason: 'missing' });
    const { db, redis, txFromTables } = setupRows({
      tenantRows: [{ role: 'member' }],
      ownerRows: [{ ownerId: 'user-1' }],
      sessionRows: [{ spaceId: 'space-pg' }],
    });

    await expect(canReadSession(db, redis, 'tenant-1', 'user-1', 'session-1')).resolves.toBe(true);

    expect(txFromTables).toContain(mocks.tables.sessions);
    expect(txFromTables).toContain(mocks.tables.spaces);
  });

  it('rejects a user without an active tenant membership even if owner/membership rows exist', async () => {
    mocks.getSessionStateSafe.mockResolvedValue({
      ok: true,
      state: { spaceId: 'space-hot' },
    });
    const { db, redis } = setupRows({
      tenantRows: [], // no active membership — REST would 403
      ownerRows: [{ ownerId: 'user-1' }], // owner row exists but must not save us
      memberRows: [{ role: 'admin' }], // membership row exists but must not save us
    });

    await expect(canReadSession(db, redis, 'tenant-1', 'user-1', 'session-1')).resolves.toBe(false);
  });

  it('denies a tenant owner role on a shared space without a membership row', async () => {
    mocks.getSessionStateSafe.mockResolvedValue({
      ok: true,
      state: { spaceId: 'space-hot' },
    });
    const { db, redis } = setupRows({
      tenantRows: [{ role: 'owner' }],
      ownerRows: [{ ownerId: 'someone-else' }],
      memberRows: [],
      memberCount: 2, // shared — but content is membership-only for everyone
    });

    await expect(canReadSession(db, redis, 'tenant-1', 'user-1', 'session-1')).resolves.toBe(false);
  });

  it('revocation invalidation evicts the in-process cache before the TTL expires', async () => {
    mocks.getSessionStateSafe.mockResolvedValue({
      ok: true,
      state: { spaceId: 'space-hot' },
    });
    // 1. Member subscribes — allowed, cached.
    const first = setupRows({
      tenantRows: [{ role: 'member' }],
      ownerRows: [{ ownerId: 'someone-else' }],
      memberRows: [{ role: 'viewer' }],
      memberCount: 2,
    });
    await expect(
      canReadSession(first.db, first.redis, 'tenant-1', 'user-1', 'session-1'),
    ).resolves.toBe(true);

    // 2. Membership removed — the stale cache still answers true...
    const second = setupRows({
      tenantRows: [{ role: 'member' }],
      ownerRows: [{ ownerId: 'someone-else' }],
      memberRows: [],
      memberCount: 1,
    });
    await expect(
      canReadSession(second.db, second.redis, 'tenant-1', 'user-1', 'session-1'),
    ).resolves.toBe(true);

    // 3. ...until the invalidation signal evicts it — then denial is immediate.
    invalidateRealtimeSpaceAuthzCache('tenant-1', 'user-1', 'space-hot');
    await expect(
      canReadSession(second.db, second.redis, 'tenant-1', 'user-1', 'session-1'),
    ).resolves.toBe(false);
  });

  it('denies a tenant admin without a membership on a foreign solo space', async () => {
    mocks.getSessionStateSafe.mockResolvedValue({
      ok: true,
      state: { spaceId: 'space-hot' },
    });
    const { db, redis } = setupRows({
      tenantRows: [{ role: 'admin' }],
      ownerRows: [{ ownerId: 'someone-else' }],
      memberRows: [],
      memberCount: 1,
    });

    await expect(canReadSession(db, redis, 'tenant-1', 'user-1', 'session-1')).resolves.toBe(false);
  });

  it('authorizes the owner of a solo space', async () => {
    mocks.getSessionStateSafe.mockResolvedValue({
      ok: true,
      state: { spaceId: 'space-hot' },
    });
    const { db, redis } = setupRows({
      tenantRows: [{ role: 'member' }],
      ownerRows: [{ ownerId: 'user-1' }],
    });

    await expect(canReadSession(db, redis, 'tenant-1', 'user-1', 'session-1')).resolves.toBe(true);
  });

  it('authorizes an explicitly invited member on a shared space (tenant admin too)', async () => {
    mocks.getSessionStateSafe.mockResolvedValue({
      ok: true,
      state: { spaceId: 'space-hot' },
    });
    const { db, redis } = setupRows({
      tenantRows: [{ role: 'admin' }],
      ownerRows: [{ ownerId: 'someone-else' }],
      memberRows: [{ role: 'viewer' }],
      memberCount: 2,
    });

    await expect(canReadSession(db, redis, 'tenant-1', 'user-1', 'session-1')).resolves.toBe(true);
  });

  it('partitions the cache by dev-bypass so a dev-bypass grant does not leak to a plain-auth subscribe', async () => {
    // Codex follow-up: with `authMethod` now changing the result of
    // `canReadSpace`, the cache must NOT serve a dev-bypass `true` to a
    // subsequent plain-auth subscribe for the same (tenant, user, space)
    // tuple — that would be a privilege escalation in dev.
    process.env['NODE_ENV'] = 'development';
    mocks.getSessionStateSafe.mockResolvedValue({
      ok: true,
      state: { spaceId: 'space-hot' },
    });
    const { db, redis } = setupRows({
      tenantRows: [], // no active tenant membership
      ownerRows: [{ ownerId: 'someone-else' }], // not the user
      memberRows: [], // no space membership
      memberCount: 2, // shared — the dev-bypass implicit grant applies
    });

    // 1. Dev-bypass subscribe lands first — grants owner without
    //    membership, caches `true` under the dev-bypass partition.
    await expect(
      canReadSession(db, redis, 'tenant-1', 'user-1', 'session-1', 'dev_bypass'),
    ).resolves.toBe(true);

    // 2. Plain-auth subscribe for the same tuple MUST be denied — the
    //    cache lookup is partitioned by dev-bypass, so the prior grant
    //    is not visible here.
    await expect(canReadSession(db, redis, 'tenant-1', 'user-1', 'session-1')).resolves.toBe(false);
  });
});
