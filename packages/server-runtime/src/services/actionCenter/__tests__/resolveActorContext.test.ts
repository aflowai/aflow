import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const tables = {
    spaces: { id: 'spaces.id', ownerId: 'spaces.ownerId' },
    spaceMemberships: {
      tenantId: 'spaceMemberships.tenantId',
      userId: 'spaceMemberships.userId',
      spaceId: 'spaceMemberships.spaceId',
      role: 'spaceMemberships.role',
    },
  };
  return { tables, withTenantSchema: vi.fn() };
});

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ kind: 'and', args }),
  eq: (...args: unknown[]) => ({ kind: 'eq', args }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ kind: 'sql', strings, values }),
}));

vi.mock('@aflow/database', () => ({
  createTenantContext: (tenantId: string) => ({ tenantId }),
  spaces: mocks.tables.spaces,
  spaceMemberships: mocks.tables.spaceMemberships,
  withTenantSchema: (...args: unknown[]) => mocks.withTenantSchema(...args),
}));

import { resolveActionCenterActorContext } from '../resolveActorContext.js';
import { ActionCenterAuthzError } from '../authz.js';

type Row = Record<string, unknown>;

function makeQueryable(
  resolveRows: (table: unknown) => Row[],
  resolveAggregate?: (table: unknown) => Row[],
): {
  api: unknown;
  fromTables: unknown[];
} {
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

interface Setup {
  ownerRows?: Row[];
  memberRows?: Row[];
  /** Total membership rows for the space (defaults to memberRows length). */
  memberCount?: number;
}

function setup(rows: Setup): { db: PostgresJsDatabase; txFromTables: unknown[] } {
  const publicDb = makeQueryable(
    (table) => {
      if (table === mocks.tables.spaceMemberships) return rows.memberRows ?? [];
      throw new Error('unexpected public table in resolver');
    },
    (table) => {
      if (table === mocks.tables.spaceMemberships) {
        return [{ count: rows.memberCount ?? (rows.memberRows ?? []).length }];
      }
      throw new Error('unexpected aggregate table in resolver');
    },
  );
  const tenantTx = makeQueryable((table) => {
    if (table === mocks.tables.spaces) return rows.ownerRows ?? [];
    throw new Error('unexpected tenant table in resolver');
  });
  mocks.withTenantSchema.mockImplementation(
    async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(tenantTx.api),
  );
  return {
    db: publicDb.api as unknown as PostgresJsDatabase,
    txFromTables: tenantTx.fromTables,
  };
}

const TENANT_ID = '00000000-0000-0000-0000-000000000001' as unknown as never;
const SPACE_ID = 'space-1';
const USER_ID = 'user-1';
const PROD = process.env['NODE_ENV'];

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  if (PROD === undefined) delete process.env['NODE_ENV'];
  else process.env['NODE_ENV'] = PROD;
});

describe('resolveActionCenterActorContext', () => {
  it('denies a tenant admin without a membership even on a shared space', async () => {
    const { db } = setup({
      ownerRows: [{ ownerId: 'someone-else' }],
      memberRows: [],
      memberCount: 2,
    });
    await expect(
      resolveActionCenterActorContext(db, TENANT_ID, SPACE_ID, {
        userId: USER_ID,
        isTenantAdmin: true,
      }),
    ).rejects.toBeInstanceOf(ActionCenterAuthzError);
  });

  it('denies a tenant admin without a membership on a foreign solo space', async () => {
    const { db } = setup({
      ownerRows: [{ ownerId: 'someone-else' }],
      memberRows: [],
      memberCount: 1,
    });
    await expect(
      resolveActionCenterActorContext(db, TENANT_ID, SPACE_ID, {
        userId: USER_ID,
        isTenantAdmin: true,
      }),
    ).rejects.toBeInstanceOf(ActionCenterAuthzError);
  });

  it('returns the membership role for a tenant admin invited into a foreign solo space', async () => {
    const { db } = setup({
      ownerRows: [{ ownerId: 'someone-else' }],
      memberRows: [{ role: 'viewer' }],
      memberCount: 1,
    });
    const ctx = await resolveActionCenterActorContext(db, TENANT_ID, SPACE_ID, {
      userId: USER_ID,
      isTenantAdmin: true,
    });
    expect(ctx.actorSpaceRole).toBe('viewer');
  });

  it('returns admin when the user owns the space (solo-space case)', async () => {
    const { db } = setup({ ownerRows: [{ ownerId: USER_ID }] });
    const ctx = await resolveActionCenterActorContext(db, TENANT_ID, SPACE_ID, {
      userId: USER_ID,
      isTenantAdmin: false,
    });
    expect(ctx.actorSpaceRole).toBe('admin');
    expect(ctx.actorIsTenantAdmin).toBe(false);
  });

  it('carries whether the caller is an interactive user, and nothing when it was not told', async () => {
    const { db } = setup({ ownerRows: [{ ownerId: USER_ID }] });
    const signedIn = await resolveActionCenterActorContext(db, TENANT_ID, SPACE_ID, {
      userId: USER_ID,
      isTenantAdmin: false,
      isInteractiveUser: true,
    });
    expect(signedIn.actorIsInteractiveUser).toBe(true);
    const unsaid = await resolveActionCenterActorContext(db, TENANT_ID, SPACE_ID, {
      userId: USER_ID,
      isTenantAdmin: false,
    });
    expect(unsaid).not.toHaveProperty('actorIsInteractiveUser');
  });

  it('returns admin under dev bypass (NODE_ENV != production + authMethod = dev_bypass)', async () => {
    process.env['NODE_ENV'] = 'development';
    const { db } = setup({ ownerRows: [{ ownerId: 'someone-else' }], memberCount: 2 });
    const ctx = await resolveActionCenterActorContext(db, TENANT_ID, SPACE_ID, {
      userId: USER_ID,
      isTenantAdmin: false,
      authMethod: 'dev_bypass',
    });
    expect(ctx.actorSpaceRole).toBe('admin');
  });

  it('denies dev bypass without a membership on a foreign solo space', async () => {
    process.env['NODE_ENV'] = 'development';
    const { db } = setup({
      ownerRows: [{ ownerId: 'someone-else' }],
      memberRows: [],
      memberCount: 1,
    });
    await expect(
      resolveActionCenterActorContext(db, TENANT_ID, SPACE_ID, {
        userId: USER_ID,
        isTenantAdmin: false,
        authMethod: 'dev_bypass',
      }),
    ).rejects.toBeInstanceOf(ActionCenterAuthzError);
  });

  it('does NOT honor dev bypass when NODE_ENV=production', async () => {
    process.env['NODE_ENV'] = 'production';
    const { db } = setup({
      ownerRows: [{ ownerId: 'someone-else' }],
      memberRows: [],
    });
    await expect(
      resolveActionCenterActorContext(db, TENANT_ID, SPACE_ID, {
        userId: USER_ID,
        isTenantAdmin: false,
        authMethod: 'dev_bypass',
      }),
    ).rejects.toBeInstanceOf(ActionCenterAuthzError);
  });

  it('returns membership role from space_memberships when nothing else matches', async () => {
    const { db } = setup({
      ownerRows: [{ ownerId: 'someone-else' }],
      memberRows: [{ role: 'editor' }],
    });
    const ctx = await resolveActionCenterActorContext(db, TENANT_ID, SPACE_ID, {
      userId: USER_ID,
      isTenantAdmin: false,
    });
    expect(ctx.actorSpaceRole).toBe('editor');
  });

  it('refuses (does not default to viewer) when no path grants access', async () => {
    const { db } = setup({
      ownerRows: [{ ownerId: 'someone-else' }],
      memberRows: [],
    });
    await expect(
      resolveActionCenterActorContext(db, TENANT_ID, SPACE_ID, {
        userId: USER_ID,
        isTenantAdmin: false,
      }),
    ).rejects.toBeInstanceOf(ActionCenterAuthzError);
  });
});
