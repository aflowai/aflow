/**
 * Plan 335 P2: removing a profile ends its sessions before it erases the user,
 * and evicts the cached role a deleted membership would otherwise keep.
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

vi.mock('../plugins/localProfiles.js', () => ({
  bumpLocalProfileSessionGeneration: vi.fn(async () => {
    order.push('bump');
    return 1;
  }),
}));

const { removeLocalProfile, LocalProfileError } = await import('./localProfiles.js');

/** A Drizzle double answering the one profile read the removal makes. */
function dbWithProfile(role: string) {
  const row = {
    userId: 'b0b',
    displayName: 'Bob',
    avatarUrl: 'aflow-avatar:owl',
    role,
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
