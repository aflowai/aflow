import { describe, expect, it } from 'vitest';
import type { SpaceAccessAttributes } from '@aflow/authz';
import { degradedNoRedisDecision } from './authz.js';

const FOREIGN_SOLO: SpaceAccessAttributes = { ownerId: 'someone-else', memberCount: 1 };
const OWN_SOLO: SpaceAccessAttributes = { ownerId: 'user-admin', memberCount: 1 };
const SHARED: SpaceAccessAttributes = { ownerId: 'someone-else', memberCount: 3 };

function loader(attrs: SpaceAccessAttributes | null) {
  return async (_spaceId: string) => attrs;
}

describe('degradedNoRedisDecision', () => {
  it('denies non-admin tenant roles outright', async () => {
    for (const tenantRole of ['member', 'viewer', 'billing']) {
      await expect(
        degradedNoRedisDecision({
          tenantRole,
          userId: 'user-1',
          resource: 'session',
          action: 'read',
          spaceId: undefined,
          loadSpaceAttributes: loader(null),
        }),
      ).resolves.toBe(false);
    }
  });

  it('allows owner/admin on unscoped checks', async () => {
    await expect(
      degradedNoRedisDecision({
        tenantRole: 'admin',
        userId: 'user-admin',
        resource: 'session',
        action: 'read',
        spaceId: undefined,
        loadSpaceAttributes: loader(null),
      }),
    ).resolves.toBe(true);
  });

  it('allows an admin on their own solo space (owner grant)', async () => {
    await expect(
      degradedNoRedisDecision({
        tenantRole: 'admin',
        userId: 'user-admin',
        resource: 'session',
        action: 'read',
        spaceId: 'space-1',
        loadSpaceAttributes: loader(OWN_SOLO),
      }),
    ).resolves.toBe(true);
  });

  it('denies an admin content on a shared space without a membership row', async () => {
    await expect(
      degradedNoRedisDecision({
        tenantRole: 'admin',
        userId: 'user-admin',
        resource: 'session',
        action: 'read',
        spaceId: 'space-1',
        loadSpaceAttributes: loader(SHARED),
        loadSpaceRole: async () => null,
        tenantId: 'tenant-1',
      }),
    ).resolves.toBe(false);
  });

  it('allows an admin content on a shared space through their membership row', async () => {
    await expect(
      degradedNoRedisDecision({
        tenantRole: 'admin',
        userId: 'user-admin',
        resource: 'session',
        action: 'read',
        spaceId: 'space-1',
        loadSpaceAttributes: loader(SHARED),
        loadSpaceRole: async () => 'editor',
        tenantId: 'tenant-1',
      }),
    ).resolves.toBe(true);
  });

  it('fails closed for an admin on a foreign solo space', async () => {
    await expect(
      degradedNoRedisDecision({
        tenantRole: 'admin',
        userId: 'user-admin',
        resource: 'session',
        action: 'read',
        spaceId: 'space-1',
        loadSpaceAttributes: loader(FOREIGN_SOLO),
      }),
    ).resolves.toBe(false);
  });

  it('keeps the management set for an admin on a foreign solo space', async () => {
    await expect(
      degradedNoRedisDecision({
        tenantRole: 'owner',
        userId: 'user-admin',
        resource: 'space_lifecycle',
        action: 'admin',
        spaceId: 'space-1',
        loadSpaceAttributes: loader(FOREIGN_SOLO),
      }),
    ).resolves.toBe(true);
  });

  it('keeps the pre-existing allow when the space cannot be resolved', async () => {
    await expect(
      degradedNoRedisDecision({
        tenantRole: 'admin',
        userId: 'user-admin',
        resource: 'session',
        action: 'read',
        spaceId: 'space-1',
        loadSpaceAttributes: loader(null),
      }),
    ).resolves.toBe(true);
  });
});
