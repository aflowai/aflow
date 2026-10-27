/**
 * Space provisioning: a space whose membership or bootstrap fails is deleted
 * with everything its transaction committed — a quick start's install rows
 * and bundle content included — and a prospective read never leaves a space.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { spaceCapabilityAssignments, spaceMemberships, spaces } from '@aflow/database';
import type { EntityDirectives } from '@aflow/schemas';

const SPACE_ID = '00000000-0000-4000-8000-0000000000bb';
const PROFILE_ID = '00000000-0000-4000-8000-0000000000cc';
const USER_ID = '00000000-0000-4000-8000-0000000000aa';
const TENANT = {
  tenantId: 'a0000000-0000-0000-0000-000000000001',
  tenantRole: 'member',
  isAdmin: false,
};

const db = vi.hoisted(() => ({
  inserted: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
  committed: false,
  cascades: [] as Array<{ tx: unknown; schemaName: string; spaceId: string }>,
}));

const fakeTx = {
  insert: (table: unknown) => ({
    values: (values: Record<string, unknown>) => {
      db.inserted.push({ table, values });
      const done = Promise.resolve(undefined) as Promise<unknown> & {
        returning: () => Promise<unknown[]>;
      };
      done.returning = async () => [{ id: SPACE_ID, ...values }];
      return done;
    },
  }),
};

vi.mock('@aflow/database', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withTenantSchema: async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => Promise<unknown>) => {
    const result = await fn(fakeTx);
    db.committed = true;
    return result;
  },
  findDefaultCapabilityProfileId: async () => PROFILE_ID,
  cascadeDeleteSpace: async (tx: unknown, schemaName: string, spaceId: string) => {
    db.cascades.push({ tx, schemaName, spaceId });
    return {};
  },
}));

const bootstrapCyberneticEntity = vi.hoisted(() => vi.fn());
vi.mock('./entityBootstrap.js', () => ({ bootstrapCyberneticEntity }));

const { provisionCreatedSpace, readAgainstProspectiveSpace } =
  await import('./spaceProvisioning.js');

const EDITION = {
  edition: 'enterprise',
  authProvider: 'auth0',
  tenancy: { mode: 'multi' },
  exposure: { bind: 'any', requireTls: true },
} as never;
const DIRECTIVES = { version: 1, responsibility: 'Review.' } as unknown as EntityDirectives;
const log = { info: vi.fn(), error: vi.fn() } as never;

beforeEach(() => {
  db.inserted = [];
  db.committed = false;
  db.cascades = [];
  bootstrapCyberneticEntity.mockReset();
});

describe('provisionCreatedSpace', () => {
  it('deletes the space with everything in it when bootstrap fails, then rethrows', async () => {
    bootstrapCyberneticEntity.mockRejectedValue(new Error('bootstrap failed'));
    const sqlTx = { marker: 'tx' };
    const sql = { begin: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(sqlTx)) };
    const membershipDb = fakeTx;

    await expect(
      provisionCreatedSpace({
        db: membershipDb as never,
        sql: sql as never,
        redis: null,
        tenant: TENANT as never,
        userId: USER_ID,
        spaceId: SPACE_ID,
        directives: DIRECTIVES,
        log,
      }),
    ).rejects.toThrow('bootstrap failed');

    expect(db.inserted.map((row) => row.table)).toEqual([spaceMemberships]);
    expect(sql.begin).toHaveBeenCalledTimes(1);
    expect(db.cascades).toEqual([
      { tx: sqlTx, schemaName: expect.stringMatching(/^t_/), spaceId: SPACE_ID },
    ]);
  });

  it('leaves the space alone when it provisions', async () => {
    bootstrapCyberneticEntity.mockResolvedValue({
      created: [],
      resolvedAgents: { helmsman: 'agent-1' },
      durationMs: 1,
    });
    const sql = { begin: vi.fn() };
    const result = await provisionCreatedSpace({
      db: fakeTx as never,
      sql: sql as never,
      redis: null,
      tenant: TENANT as never,
      userId: USER_ID,
      spaceId: SPACE_ID,
      directives: DIRECTIVES,
      log,
    });
    expect(result).toEqual({ helmsmanResolved: true });
    expect(sql.begin).not.toHaveBeenCalled();
  });
});

describe('readAgainstProspectiveSpace', () => {
  it('reads against the space a creation would make and never commits it', async () => {
    const value = await readAgainstProspectiveSpace(
      {
        db: {} as never,
        tenant: TENANT as never,
        edition: EDITION,
        userId: USER_ID,
        name: 'Code Review',
        directives: DIRECTIVES,
      },
      async (_tx, spaceId) => `read ${spaceId}`,
    );
    expect(value).toBe(`read ${SPACE_ID}`);
    expect(db.committed).toBe(false);
    const [space, assignment] = db.inserted;
    expect(space?.table).toBe(spaces);
    expect(space?.values).toMatchObject({
      name: 'Code Review',
      ownerId: USER_ID,
      createdBy: USER_ID,
      directives: DIRECTIVES,
    });
    expect(assignment).toEqual({
      table: spaceCapabilityAssignments,
      values: { spaceId: SPACE_ID, profileId: PROFILE_ID, assignedBy: USER_ID },
    });
  });

  it('passes a failing read through', async () => {
    await expect(
      readAgainstProspectiveSpace(
        {
          db: {} as never,
          tenant: TENANT as never,
          edition: EDITION,
          userId: USER_ID,
          name: 'Code Review',
          directives: DIRECTIVES,
        },
        async () => {
          throw new Error('read failed');
        },
      ),
    ).rejects.toThrow('read failed');
    expect(db.committed).toBe(false);
  });
});
