/**
 * Role matrix for space privacy: actor × space membership state × action
 * class. Space content admits only ownership or explicit membership — for
 * everyone. Tenant owners/admins keep management authority (lifecycle,
 * metadata, tenant governance, and — on shared spaces only — member
 * administration) but never implicit content access.
 */
import { describe, it, expect } from 'vitest';
import type { Redis } from 'ioredis';
import { checkPermission, type PermissionCheckContext } from './permission-check.js';
import { checkManagementRbac, isForeignSoloSpace, isSoloSpace } from './rbac.js';
import type {
  AuthzAction,
  AuthzResourceType,
  SpaceAccessAttributes,
  SpaceRole,
  TenantRole,
} from './types.js';

const TENANT = 'tenant-1';
const SPACE_ID = 'space-under-test';
const OTHER = 'user-other';

function fakeRedis(): Redis {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    },
  } as unknown as Redis;
}

interface ActorWorld {
  userId: string;
  tenantRole: TenantRole;
  membership?: SpaceRole;
  space: SpaceAccessAttributes;
}

function makeCtx(world: ActorWorld): PermissionCheckContext {
  return {
    userId: world.userId,
    tenantId: TENANT,
    tenantRole: world.tenantRole,
    redis: fakeRedis(),
    config: { rbacCacheTtlSeconds: 60 },
    loadSpaceRole: async (userId, _tenantId, spaceId) =>
      world.membership && userId === world.userId && spaceId === SPACE_ID ? world.membership : null,
    loadSpaceAttributes: async (spaceId) => (spaceId === SPACE_ID ? world.space : null),
  };
}

const ACTION_CLASSES = {
  'content read': { resource: 'memory', action: 'read' },
  'content write': { resource: 'memory', action: 'write' },
  'space read': { resource: 'space', action: 'read' },
  'config admin': { resource: 'space', action: 'admin' },
  'metadata read': { resource: 'space_metadata', action: 'read' },
  'lifecycle admin': { resource: 'space_lifecycle', action: 'admin' },
  'membership admin': { resource: 'space_membership', action: 'admin' },
  'tenant governance': { resource: 'tenant', action: 'admin' },
} satisfies Record<string, { resource: AuthzResourceType; action: AuthzAction }>;
type ActionClass = keyof typeof ACTION_CLASSES;

type Expectation = Record<ActionClass, boolean>;

const ALL: Expectation = {
  'content read': true,
  'content write': true,
  'space read': true,
  'config admin': true,
  'metadata read': true,
  'lifecycle admin': true,
  'membership admin': true,
  'tenant governance': true,
};
const NONE: Expectation = {
  'content read': false,
  'content write': false,
  'space read': false,
  'config admin': false,
  'metadata read': false,
  'lifecycle admin': false,
  'membership admin': false,
  'tenant governance': false,
};
/** Tenant admin on a foreign solo space: management only — and no member administration. */
const MANAGEMENT_SOLO: Expectation = {
  ...NONE,
  'metadata read': true,
  'lifecycle admin': true,
  'tenant governance': true,
};
/** Tenant admin on a shared space they have not joined: management incl. member admin, no content. */
const MANAGEMENT_SHARED: Expectation = {
  ...MANAGEMENT_SOLO,
  'membership admin': true,
};
const EDITOR: Expectation = {
  ...NONE,
  'content read': true,
  'content write': true,
  'space read': true,
  'metadata read': true,
};

const SOLO_FOREIGN: SpaceAccessAttributes = { ownerId: OTHER, memberCount: 1 };
const SHARED_FOREIGN: SpaceAccessAttributes = { ownerId: OTHER, memberCount: 3 };

interface MatrixCase extends ActorWorld {
  actor: string;
  spaceKind: string;
  expected: Expectation;
}

const CASES: MatrixCase[] = [
  {
    actor: 'owner-member',
    spaceKind: 'own solo',
    userId: 'user-owner',
    tenantRole: 'member',
    membership: 'admin',
    space: { ownerId: 'user-owner', memberCount: 1 },
    expected: ALL,
  },
  {
    actor: 'owner-member',
    spaceKind: 'own shared',
    userId: 'user-owner',
    tenantRole: 'member',
    membership: 'admin',
    space: { ownerId: 'user-owner', memberCount: 3 },
    expected: ALL,
  },
  {
    actor: 'tenant admin (non-member)',
    spaceKind: 'shared',
    userId: 'user-admin',
    tenantRole: 'admin',
    space: SHARED_FOREIGN,
    expected: MANAGEMENT_SHARED,
  },
  {
    actor: 'tenant admin (non-member)',
    spaceKind: 'own solo',
    userId: 'user-admin',
    tenantRole: 'admin',
    space: { ownerId: 'user-admin', memberCount: 1 },
    expected: ALL,
  },
  {
    actor: 'tenant admin (non-member)',
    spaceKind: 'foreign solo',
    userId: 'user-admin',
    tenantRole: 'admin',
    space: SOLO_FOREIGN,
    expected: MANAGEMENT_SOLO,
  },
  {
    actor: 'tenant owner (non-member)',
    spaceKind: 'foreign solo',
    userId: 'user-tenant-owner',
    tenantRole: 'owner',
    space: SOLO_FOREIGN,
    expected: MANAGEMENT_SOLO,
  },
  {
    actor: 'tenant member (non-member)',
    spaceKind: 'shared',
    userId: 'user-member',
    tenantRole: 'member',
    space: SHARED_FOREIGN,
    expected: NONE,
  },
  {
    actor: 'tenant member (non-member)',
    spaceKind: 'foreign solo',
    userId: 'user-member',
    tenantRole: 'member',
    space: SOLO_FOREIGN,
    expected: NONE,
  },
  {
    actor: 'tenant viewer (non-member)',
    spaceKind: 'shared',
    userId: 'user-viewer',
    tenantRole: 'viewer',
    space: SHARED_FOREIGN,
    expected: NONE,
  },
  {
    actor: 'tenant viewer (non-member)',
    spaceKind: 'foreign solo',
    userId: 'user-viewer',
    tenantRole: 'viewer',
    space: SOLO_FOREIGN,
    expected: NONE,
  },
  {
    actor: 'tenant billing (non-member)',
    spaceKind: 'shared',
    userId: 'user-billing',
    tenantRole: 'billing',
    space: SHARED_FOREIGN,
    expected: NONE,
  },
  {
    actor: 'tenant billing (non-member)',
    spaceKind: 'foreign solo',
    userId: 'user-billing',
    tenantRole: 'billing',
    space: SOLO_FOREIGN,
    expected: NONE,
  },
  {
    actor: 'space editor',
    spaceKind: 'shared',
    userId: 'user-editor',
    tenantRole: 'member',
    membership: 'editor',
    space: SHARED_FOREIGN,
    expected: EDITOR,
  },
];

describe('solo-space role matrix', () => {
  describe.each(CASES)('$actor × $spaceKind space', (matrixCase) => {
    const classes = Object.keys(ACTION_CLASSES) as ActionClass[];
    it.each(classes)('%s', async (actionClass) => {
      const decision = await checkPermission(makeCtx(matrixCase), {
        ...ACTION_CLASSES[actionClass],
        spaceId: SPACE_ID,
      });
      expect(decision.allowed).toBe(matrixCase.expected[actionClass]);
    });
  });

  describe('member unscoped space surface', () => {
    it('allows a tenant member to reach the tenant-wide space surface (no spaceId)', async () => {
      const ctx = makeCtx({
        userId: 'user-member',
        tenantRole: 'member',
        space: SHARED_FOREIGN,
      });
      const decision = await checkPermission(ctx, { resource: 'space', action: 'read' });
      expect(decision.allowed).toBe(true);
    });

    it('still denies a member reading a specific space they are not a member of', async () => {
      const ctx = makeCtx({
        userId: 'user-member',
        tenantRole: 'member',
        space: SHARED_FOREIGN,
      });
      const decision = await checkPermission(ctx, {
        resource: 'space',
        action: 'read',
        spaceId: SPACE_ID,
      });
      expect(decision.allowed).toBe(false);
    });
  });

  it('denies execute/approve content actions to a tenant admin on a foreign solo space', async () => {
    const ctx = makeCtx({
      userId: 'user-admin',
      tenantRole: 'admin',
      space: SOLO_FOREIGN,
    });
    for (const check of [
      { resource: 'session', action: 'execute' },
      { resource: 'agent', action: 'execute' },
      { resource: 'session', action: 'approve' },
    ] satisfies Array<{ resource: AuthzResourceType; action: AuthzAction }>) {
      const decision = await checkPermission(ctx, { ...check, spaceId: SPACE_ID });
      expect(decision.allowed).toBe(false);
    }
  });

  it('grants the owner content access even without a membership row (owner shortcut)', async () => {
    const decision = await checkPermission(
      makeCtx({
        userId: 'user-owner',
        tenantRole: 'member',
        space: { ownerId: 'user-owner', memberCount: 0 },
      }),
      { resource: 'memory', action: 'read', spaceId: SPACE_ID },
    );
    expect(decision.allowed).toBe(true);
    expect(decision.spaceRole).toBe('admin');
  });

  it('never grants space-scoped content without membership', async () => {
    // Membership is a hard precondition for space content, whatever else a
    // decision could draw on. This case named a relationship store while one
    // was half-built here; the store is gone and the precondition is not, so
    // it asks the same question of the role logic alone.
    const world: ActorWorld = {
      userId: 'user-member',
      tenantRole: 'member',
      space: SOLO_FOREIGN,
    };
    const decision = await checkPermission(makeCtx(world), {
      resource: 'memory',
      action: 'read',
      resourceId: 'doc-1',
      spaceId: SPACE_ID,
    });
    expect(decision.allowed).toBe(false);
  });
});

describe('solo predicates', () => {
  it('isSoloSpace is true at ≤1 member', () => {
    expect(isSoloSpace({ memberCount: 0 })).toBe(true);
    expect(isSoloSpace({ memberCount: 1 })).toBe(true);
    expect(isSoloSpace({ memberCount: 2 })).toBe(false);
  });

  it('isForeignSoloSpace requires solo AND foreign ownership', () => {
    expect(isForeignSoloSpace({ ownerId: OTHER, memberCount: 1 }, 'u1')).toBe(true);
    expect(isForeignSoloSpace({ ownerId: null, memberCount: 1 }, 'u1')).toBe(true);
    expect(isForeignSoloSpace({ ownerId: 'u1', memberCount: 1 }, 'u1')).toBe(false);
    expect(isForeignSoloSpace({ ownerId: OTHER, memberCount: 3 }, 'u1')).toBe(false);
  });
});

describe('checkManagementRbac', () => {
  it('allows tenant governance, metadata reads, and lifecycle administration', () => {
    expect(checkManagementRbac('tenant', 'admin')).toBe(true);
    expect(checkManagementRbac('tenant', 'read')).toBe(true);
    expect(checkManagementRbac('space_metadata', 'read')).toBe(true);
    expect(checkManagementRbac('space_lifecycle', 'admin')).toBe(true);
  });

  it('allows member administration on shared spaces only', () => {
    expect(checkManagementRbac('space_membership', 'admin', { memberCount: 3 })).toBe(true);
    expect(checkManagementRbac('space_membership', 'admin', { memberCount: 1 })).toBe(false);
    expect(checkManagementRbac('space_membership', 'admin', null)).toBe(false);
    expect(checkManagementRbac('space_membership', 'admin')).toBe(false);
  });

  it('excludes space reads, config admin, and every content resource', () => {
    expect(checkManagementRbac('space', 'read')).toBe(false);
    expect(checkManagementRbac('space', 'admin')).toBe(false);
    expect(checkManagementRbac('space', 'write')).toBe(false);
    expect(checkManagementRbac('space', 'delete')).toBe(false);
    expect(checkManagementRbac('space_metadata', 'write')).toBe(false);
    for (const resource of [
      'memory',
      'session',
      'agent',
      'api_config',
      'secret',
      'credential',
    ] satisfies AuthzResourceType[]) {
      expect(checkManagementRbac(resource, 'read')).toBe(false);
      expect(checkManagementRbac(resource, 'write')).toBe(false);
    }
  });
});
