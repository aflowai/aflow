/**
 * Plan 335 P2: removing a profile ends its sessions before it erases the user,
 * and evicts the cached role a deleted membership would otherwise keep.
 *
 * Plan 335 P4: setting or resetting a PIN stores a hash, never the PIN, and
 * bumps the session generation in the same transaction.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const order = vi.hoisted(() => [] as string[]);

vi.mock('@aflow/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/database')>();
  return {
    ...actual,
    planAccountDeletion: vi.fn(async (_sql: unknown, userId: string) => ({
      userId,
      email: null,
      displayName: 'Bob',
      identities: [],
      tenants: [
        {
          tenantId: 't',
          schemaName: 't_x',
          role: 'member',
          spacesToPurge: [
            { spaceId: 's1', name: 'Personal', slug: 'personal-b0b', otherMemberCount: 0 },
          ],
          spacesToTransfer: [],
          successorUserId: 'owner',
          purgeCounts: { spaces: 1 },
        },
      ],
      payloadPrefixes: [],
      blockers: [],
    })),
    executeAccountDeletion: vi.fn(async () => {
      order.push('erase');
      return {};
    }),
  };
});

const bumped = vi.hoisted(() => [] as unknown[]);

vi.mock('../plugins/localProfiles.js', () => ({
  bumpLocalProfileSessionGeneration: vi.fn(async (db: unknown) => {
    order.push('bump');
    bumped.push(db);
    return 1;
  }),
}));

const { removeLocalProfile, resetLocalProfilePin, setLocalProfilePin, LocalProfileError } =
  await import('./localProfiles.js');
const { verifyLocalProfilePin } = await import('./localProfilePin.js');

/** A Drizzle double answering the one profile read the removal makes. */
function dbWithProfile(role: string) {
  const row = {
    userId: 'b0b',
    displayName: 'Bob',
    avatarUrl: 'aflow-avatar:owl',
    role,
    pinHash: null,
    createdAt: new Date(0),
  };
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: async () => [row],
  };
  return { select: () => chain } as never;
}

beforeEach(() => {
  order.length = 0;
  bumped.length = 0;
});

/**
 * A Drizzle double for a PIN change: the profile reads, and a transaction
 * whose update records what it writes.
 */
function dbForPin() {
  const writes: Record<string, unknown>[] = [];
  const row = {
    userId: 'b0b',
    displayName: 'Bob',
    avatarUrl: null,
    role: 'member',
    pinHash: null as string | null,
    createdAt: new Date(0),
  };
  const read = {
    from: () => read,
    innerJoin: () => read,
    where: () => read,
    limit: async () => [{ ...row }],
  };
  const tx = {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          order.push('write');
          writes.push(values);
          row.pinHash = (values['profilePinHash'] as string | null | undefined) ?? null;
        },
      }),
    }),
  };
  const db = {
    select: () => read,
    transaction: async (work: (t: unknown) => Promise<void>) => {
      order.push('begin');
      await work(tx);
      order.push('commit');
    },
  };
  return { db: db as never, tx, writes };
}

describe('a profile PIN', () => {
  it('is stored as a hash and ends the sessions in the same transaction', async () => {
    const { db, tx, writes } = dbForPin();
    const profile = await setLocalProfilePin(db, { tenantId: 't', userId: 'b0b', pin: '2468' });
    expect(order).toEqual(['begin', 'write', 'bump', 'commit']);
    expect(bumped).toEqual([tx]);
    const stored = writes[0]?.['profilePinHash'];
    expect(typeof stored).toBe('string');
    expect(stored).not.toContain('2468');
    expect(await verifyLocalProfilePin('2468', stored as string)).toBe(true);
    expect(await verifyLocalProfilePin('1357', stored as string)).toBe(false);
    expect(profile.hasPin).toBe(true);
  });

  it('is reset to none and ends the sessions in the same transaction', async () => {
    const { db, tx, writes } = dbForPin();
    const profile = await resetLocalProfilePin(db, { tenantId: 't', userId: 'b0b' });
    expect(order).toEqual(['begin', 'write', 'bump', 'commit']);
    expect(bumped).toEqual([tx]);
    expect(writes[0]).toEqual(expect.objectContaining({ profilePinHash: null }));
    expect(profile.hasPin).toBe(false);
  });
});

describe('removeLocalProfile', () => {
  it('ends the sessions, then erases the user, then evicts the cached role', async () => {
    const redis = {
      del: vi.fn(async () => {
        order.push('evict');
        return 1;
      }),
      publish: vi.fn(async () => 1),
    };
    const removed = await removeLocalProfile(dbWithProfile('member'), {
      sql: {} as never,
      redis: redis as never,
      tenantId: 't',
      userId: 'b0b',
    });
    expect(order).toEqual(['bump', 'erase', 'evict']);
    expect(redis.del).toHaveBeenCalledWith('aflow:rbac:tenant:b0b:t');
    expect(redis.publish).toHaveBeenCalledTimes(1);
    expect(removed).toEqual({
      userId: 'b0b',
      spacesDeleted: [{ spaceId: 's1', name: 'Personal' }],
      spacesTransferred: [],
    });
  });

  it('refuses the owner and touches nothing', async () => {
    await expect(
      removeLocalProfile(dbWithProfile('owner'), {
        sql: {} as never,
        redis: null,
        tenantId: 't',
        userId: 'b0b',
      }),
    ).rejects.toBeInstanceOf(LocalProfileError);
    expect(order).toEqual([]);
  });

  it('still answers when the role cache cannot be evicted', async () => {
    const onCacheError = vi.fn();
    const redis = {
      del: vi.fn(async () => {
        throw new Error('redis down');
      }),
      publish: vi.fn(),
    };
    await removeLocalProfile(dbWithProfile('member'), {
      sql: {} as never,
      redis: redis as never,
      tenantId: 't',
      userId: 'b0b',
      onCacheError,
    });
    expect(order).toEqual(['bump', 'erase']);
    expect(onCacheError).toHaveBeenCalledTimes(1);
  });
});
