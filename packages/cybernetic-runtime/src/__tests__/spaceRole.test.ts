/**
 * A user's space role (Plan 345): the Store's install and update ask for
 * space write, which an admin and an editor hold and a viewer does not. The
 * space's owner holds admin whatever their membership row says.
 */
import { describe, expect, it, vi } from 'vitest';

const OWNER = '00000000-0000-4000-8000-0000000000aa';

vi.mock('@aflow/database', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@aflow/database')>();
  return {
    ...orig,
    withTenantSchema: async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn(chain([{ ownerId: OWNER }])),
  };
});

function chain(rows: unknown[]) {
  const query = {
    select: () => query,
    from: () => query,
    where: () => query,
    limit: async () => rows,
  };
  return query;
}

const { canWriteSpace, isSpaceAdmin, readSpaceRole } = await import('../spaceAutonomyWrite.js');

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SPACE = '41be431d-6011-495b-a4f2-6de539a6a0df';
const MEMBER = '00000000-0000-4000-8000-0000000000bb';

function dbWithMembership(role: string | undefined) {
  return chain(role === undefined ? [] : [{ role }]) as never;
}

describe('the space role', () => {
  it('refuses space write to a viewer and to a user with no membership', async () => {
    expect(await canWriteSpace(dbWithMembership('viewer'), TENANT, SPACE, MEMBER)).toBe(false);
    expect(await canWriteSpace(dbWithMembership(undefined), TENANT, SPACE, MEMBER)).toBe(false);
    expect(await readSpaceRole(dbWithMembership(undefined), TENANT, SPACE, MEMBER)).toBeNull();
  });

  it('grants space write to an editor and an admin, and admin only to an admin', async () => {
    expect(await canWriteSpace(dbWithMembership('editor'), TENANT, SPACE, MEMBER)).toBe(true);
    expect(await isSpaceAdmin(dbWithMembership('editor'), TENANT, SPACE, MEMBER)).toBe(false);
    expect(await canWriteSpace(dbWithMembership('admin'), TENANT, SPACE, MEMBER)).toBe(true);
    expect(await isSpaceAdmin(dbWithMembership('admin'), TENANT, SPACE, MEMBER)).toBe(true);
  });

  it('reads the space owner as admin, whatever the membership row holds', async () => {
    expect(await readSpaceRole(dbWithMembership('viewer'), TENANT, SPACE, OWNER)).toBe('admin');
    expect(await canWriteSpace(dbWithMembership(undefined), TENANT, SPACE, OWNER)).toBe(true);
  });
});
