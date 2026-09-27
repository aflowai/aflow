import { beforeEach, describe, expect, it, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import {
  StepResultMessageSchema,
  type IdempotencyKey,
  type SessionId,
  type StepDefinition,
  type StepExecutionId,
  type StepResultMessage,
  type TenantId,
  type TraceId,
} from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';
import type { InlineHandlerArgs } from '../types.js';
import type { FlowExecutionContext } from '../../../types.js';

const TENANT = 'a0000000-0000-4000-8000-000000000001' as TenantId;
const PARENT_SPACE = 'b0000000-0000-4000-8000-000000000002';
const STEP_EXEC = 'c0000000-0000-4000-8000-000000000003' as StepExecutionId;
const NEW_SPACE = 'e0000000-0000-4000-8000-000000000006';
const OWNER = '1eab6e64-861a-4b99-b396-74f35b111dbb';
const PARENT_PROFILE = 'f0000000-0000-4000-8000-000000000007';
const SAFE_PROFILE = 'f0000000-0000-4000-8000-000000000008';
const ADMIN_PROFILE = 'f0000000-0000-4000-8000-000000000009';

const dbMock = vi.hoisted(() => ({
  spaceInserts: [] as Record<string, unknown>[],
  capabilityInserts: [] as Record<string, unknown>[],
  membershipInserts: [] as Record<string, unknown>[],
  parentOwnerId: null as string | null,
  parentProfileId: null as string | null,
  ownerTenantRole: null as string | null,
  retiredSlug: false,
  ownedSpaceCount: 0,
  maxSpacesPerUser: undefined as number | undefined,
  reset(
    parentOwnerId: string | null,
    parentProfileId: string | null,
    opts: {
      retiredSlug?: boolean;
      ownedSpaceCount?: number;
      maxSpacesPerUser?: number;
      ownerTenantRole?: string;
    } = {},
  ) {
    this.spaceInserts = [];
    this.capabilityInserts = [];
    this.membershipInserts = [];
    this.parentOwnerId = parentOwnerId;
    this.parentProfileId = parentProfileId;
    this.ownerTenantRole = opts.ownerTenantRole ?? null;
    this.retiredSlug = opts.retiredSlug ?? false;
    this.ownedSpaceCount = opts.ownedSpaceCount ?? 0;
    this.maxSpacesPerUser = opts.maxSpacesPerUser;
  },
}));

const editionMock = vi.hoisted(() => ({ tenancyMode: 'multi' as 'multi' | 'fixed' }));

vi.mock('@aflow/schemas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/schemas')>();
  return {
    ...actual,
    resolveEditionDescriptor: () =>
      editionMock.tenancyMode === 'multi'
        ? {
            edition: 'enterprise',
            authProvider: 'auth0',
            tenancy: { mode: 'multi' },
            exposure: { bind: 'any', requireTls: true },
            computeRuntime: 'present',
          }
        : {
            edition: 'community-local',
            authProvider: 'local-instance',
            tenancy: { mode: 'fixed', tenantId: 'a0000000-0000-4000-8000-000000000001' },
            exposure: { bind: 'loopback', requireTls: false },
            computeRuntime: 'absent',
          },
  };
});

vi.mock('@aflow/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/database')>();

  // Drizzle where-clauses carry their literals as Param nodes; walking the
  // chunk arrays for scalar `value`s is what tells the Personal Safe lookup
  // apart from the admin role-default lookup.
  const whereScalars = (
    node: unknown,
    out: unknown[] = [],
    seen = new Set<unknown>(),
  ): unknown[] => {
    if (node === null || typeof node !== 'object' || seen.has(node)) return out;
    seen.add(node);
    const rec = node as Record<string, unknown>;
    if ('value' in rec && (typeof rec['value'] === 'string' || typeof rec['value'] === 'boolean')) {
      out.push(rec['value']);
    }
    for (const v of Object.values(rec)) {
      if (Array.isArray(v)) for (const child of v) whereScalars(child, out, seen);
    }
    return out;
  };

  // The owner lookup and the quota count both select from `spaces`; they are
  // told apart by whether the chain terminated with .limit().
  const rowsFor = (
    table: unknown,
    limited: boolean,
    whereArg: unknown,
  ): Record<string, unknown>[] => {
    if (table === actual.spaces) {
      if (limited) return [{ ownerId: dbMock.parentOwnerId }];
      return Array.from({ length: dbMock.ownedSpaceCount }, (_, i) => ({
        id: `owned-${String(i)}`,
      }));
    }
    if (table === actual.spaceSlugHistory) return dbMock.retiredSlug ? [{ id: 'retired' }] : [];
    if (table === actual.spaceCapabilityAssignments)
      return dbMock.parentProfileId ? [{ profileId: dbMock.parentProfileId }] : [];
    if (table === actual.tenantMemberships)
      return dbMock.ownerTenantRole ? [{ role: dbMock.ownerTenantRole }] : [];
    if (table === actual.capabilityProfiles) {
      const scalars = whereScalars(whereArg);
      if (scalars.includes('Personal Safe')) return [{ id: SAFE_PROFILE }];
      if (scalars.includes('admin')) return [{ id: ADMIN_PROFILE }];
      return [];
    }
    return [];
  };

  const tx = {
    execute: () => Promise.resolve([]),
    select: () => ({
      from: (table: unknown) => {
        let whereArg: unknown;
        const chain = {
          where: (arg: unknown) => {
            whereArg = arg;
            return chain;
          },
          limit: () => Promise.resolve(rowsFor(table, true, whereArg)),
          then: (resolve: (v: unknown) => unknown) => resolve(rowsFor(table, false, whereArg)),
        };
        return chain;
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        if (table === actual.spaces) {
          dbMock.spaceInserts.push(values);
          return { returning: () => Promise.resolve([{ id: NEW_SPACE }]) };
        }
        if (table === actual.spaceCapabilityAssignments) dbMock.capabilityInserts.push(values);
        if (table === actual.spaceMemberships) dbMock.membershipInserts.push(values);
        return Promise.resolve();
      },
    }),
  };

  return {
    ...actual,
    getDatabase: () => ({}),
    getTenantProvisioningPolicy: () =>
      Promise.resolve({
        signupPolicy: 'invite_only',
        quotas:
          dbMock.maxSpacesPerUser === undefined
            ? {}
            : { maxSpacesPerUser: dbMock.maxSpacesPerUser },
      }),
    withTenantSchema: (_db: unknown, _ctx: unknown, fn: (t: unknown) => Promise<unknown>) => fn(tx),
  };
});

import { handleSpaceCrudInline } from '../spaceCrud.js';

function buildArgs(redis: Redis, runId: SessionId, slug: string): InlineHandlerArgs {
  const context: FlowExecutionContext = {
    tenantId: TENANT,
    runId,
    agentDefinition: { metadata: { custom: {} } } as never,
    traceId: 'trace-space' as TraceId,
    spaceId: PARENT_SPACE,
  };
  const payloadStore = {
    retrieve: () => Promise.resolve({ slug, name: 'Vault' }),
    shouldStore: () => false,
  } as unknown as PayloadStore;
  return {
    redis,
    payloadStore,
    context,
    stepDef: {
      stepId: 'create-space',
      stepType: 'space',
      operation: 'space.manage.create',
      config: {},
    } as unknown as StepDefinition,
    stepExecutionId: STEP_EXEC,
    idempotencyKey: 'idem-space-1' as IdempotencyKey,
    resolvedInputRef: 'inline:e30=',
    attempt: 1,
    scheduledAtMs: Date.now(),
  };
}

async function readStepResult(redis: Redis): Promise<StepResultMessage> {
  const keys = (await redis.keys('aflow:shard:*:results')) as string[];
  const results: StepResultMessage[] = [];
  for (const key of keys) {
    const entries = (await redis.xrange(key, '-', '+')) as Array<[string, string[]]>;
    for (const [, fields] of entries) {
      const fieldObj: Record<string, unknown> = {};
      for (let i = 0; i < fields.length; i += 2) {
        const k = fields[i];
        const v = fields[i + 1];
        if (k === undefined || v === undefined) continue;
        try {
          fieldObj[k] = JSON.parse(v);
        } catch {
          fieldObj[k] = v;
        }
      }
      results.push(StepResultMessageSchema.parse(fieldObj));
    }
  }
  expect(results).toHaveLength(1);
  return results[0]!;
}

async function freshRedis(): Promise<Redis> {
  const redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
  return redis;
}

describe('space.manage.create — slug validity and provisioning', () => {
  beforeEach(() => {
    editionMock.tenancyMode = 'multi';
  });

  it('refuses a UUID-shaped slug, which no /s/<slug> route can resolve', async () => {
    dbMock.reset(OWNER, PARENT_PROFILE);
    const redis = await freshRedis();

    await handleSpaceCrudInline(
      buildArgs(redis, 'd0000000-0000-4000-8000-000000000004' as SessionId, PARENT_SPACE),
    );

    const result = await readStepResult(redis);
    expect(result.status).toBe('FAILED');
    expect(result.error?.message).toContain('Must not be a UUID');
    expect(dbMock.spaceInserts).toHaveLength(0);
  });

  it('refuses a reserved slug the schema alone would accept', async () => {
    dbMock.reset(OWNER, PARENT_PROFILE);
    const redis = await freshRedis();

    await handleSpaceCrudInline(
      buildArgs(redis, 'd0000000-0000-4000-8000-000000000009' as SessionId, 'new'),
    );

    const result = await readStepResult(redis);
    expect(result.status).toBe('FAILED');
    expect(result.error?.message).toContain('SLUG_RESERVED');
    expect(dbMock.spaceInserts).toHaveLength(0);
  });

  it('inherits owner, membership and capability profile from the run’s space', async () => {
    dbMock.reset(OWNER, PARENT_PROFILE);
    const redis = await freshRedis();

    await handleSpaceCrudInline(
      buildArgs(redis, 'd0000000-0000-4000-8000-000000000005' as SessionId, 'vault-i'),
    );

    const result = await readStepResult(redis);
    expect(result.status).toBe('SUCCEEDED');

    expect(dbMock.spaceInserts[0]).toMatchObject({ slug: 'vault-i', ownerId: OWNER });
    expect(dbMock.membershipInserts[0]).toMatchObject({
      spaceId: NEW_SPACE,
      userId: OWNER,
      role: 'admin',
    });
    expect(dbMock.capabilityInserts[0]).toMatchObject({
      spaceId: NEW_SPACE,
      profileId: PARENT_PROFILE,
    });
  });

  it('resolves to Personal Safe when the parent has no assignment and the owner is a tenant member', async () => {
    dbMock.reset(OWNER, null, { ownerTenantRole: 'member' });
    const redis = await freshRedis();

    await handleSpaceCrudInline(
      buildArgs(redis, 'd0000000-0000-4000-8000-000000000007' as SessionId, 'vault-ii'),
    );

    expect((await readStepResult(redis)).status).toBe('SUCCEEDED');
    expect(dbMock.capabilityInserts[0]).toMatchObject({ profileId: SAFE_PROFILE });
  });

  it('resolves to Personal Safe when the owner has no active membership row at all', async () => {
    dbMock.reset(OWNER, null);
    const redis = await freshRedis();

    await handleSpaceCrudInline(
      buildArgs(redis, 'd0000000-0000-4000-8000-000000000107' as SessionId, 'vault-ii-b'),
    );

    expect((await readStepResult(redis)).status).toBe('SUCCEEDED');
    expect(dbMock.capabilityInserts[0]).toMatchObject({ profileId: SAFE_PROFILE });
  });

  it('resolves to the admin role default when the parent has no assignment and the owner is a tenant admin', async () => {
    dbMock.reset(OWNER, null, { ownerTenantRole: 'admin' });
    const redis = await freshRedis();

    await handleSpaceCrudInline(
      buildArgs(redis, 'd0000000-0000-4000-8000-000000000207' as SessionId, 'vault-ii-c'),
    );

    expect((await readStepResult(redis)).status).toBe('SUCCEEDED');
    expect(dbMock.capabilityInserts[0]).toMatchObject({ profileId: ADMIN_PROFILE });
  });

  it('treats a tenant owner like a tenant admin for the role default', async () => {
    dbMock.reset(OWNER, null, { ownerTenantRole: 'owner' });
    const redis = await freshRedis();

    await handleSpaceCrudInline(
      buildArgs(redis, 'd0000000-0000-4000-8000-000000000307' as SessionId, 'vault-ii-d'),
    );

    expect((await readStepResult(redis)).status).toBe('SUCCEEDED');
    expect(dbMock.capabilityInserts[0]).toMatchObject({ profileId: ADMIN_PROFILE });
  });

  it('starts a fixed-tenancy instance unrestricted regardless of the owner’s role', async () => {
    editionMock.tenancyMode = 'fixed';
    dbMock.reset(OWNER, null, { ownerTenantRole: 'member' });
    const redis = await freshRedis();

    await handleSpaceCrudInline(
      buildArgs(redis, 'd0000000-0000-4000-8000-000000000407' as SessionId, 'vault-ii-e'),
    );

    expect((await readStepResult(redis)).status).toBe('SUCCEEDED');
    expect(dbMock.capabilityInserts[0]).toMatchObject({ profileId: ADMIN_PROFILE });
  });

  it('an explicit parent assignment still wins over the owner’s role', async () => {
    dbMock.reset(OWNER, PARENT_PROFILE, { ownerTenantRole: 'admin' });
    const redis = await freshRedis();

    await handleSpaceCrudInline(
      buildArgs(redis, 'd0000000-0000-4000-8000-000000000507' as SessionId, 'vault-ii-f'),
    );

    expect((await readStepResult(redis)).status).toBe('SUCCEEDED');
    expect(dbMock.capabilityInserts[0]).toMatchObject({ profileId: PARENT_PROFILE });
  });

  it('refuses when no owner can be inherited, writing nothing', async () => {
    dbMock.reset(null, PARENT_PROFILE);
    const redis = await freshRedis();

    await handleSpaceCrudInline(
      buildArgs(redis, 'd0000000-0000-4000-8000-000000000008' as SessionId, 'vault-iii'),
    );

    const result = await readStepResult(redis);
    expect(result.status).toBe('FAILED');
    expect(result.error?.message).toContain('SPACE_NO_OWNER');
    expect(dbMock.spaceInserts).toHaveLength(0);
    expect(dbMock.capabilityInserts).toHaveLength(0);
    expect(dbMock.membershipInserts).toHaveLength(0);
  });

  it('refuses a slug retired by an earlier rename', async () => {
    dbMock.reset(OWNER, PARENT_PROFILE, { retiredSlug: true });
    const redis = await freshRedis();

    await handleSpaceCrudInline(
      buildArgs(redis, 'd0000000-0000-4000-8000-00000000000a' as SessionId, 'vault-iv'),
    );

    const result = await readStepResult(redis);
    expect(result.status).toBe('FAILED');
    expect(result.error?.message).toContain('SLUG_RETIRED');
    expect(dbMock.spaceInserts).toHaveLength(0);
  });

  it('refuses once the owner is at the tenant space quota', async () => {
    dbMock.reset(OWNER, PARENT_PROFILE, { maxSpacesPerUser: 3, ownedSpaceCount: 3 });
    const redis = await freshRedis();

    await handleSpaceCrudInline(
      buildArgs(redis, 'd0000000-0000-4000-8000-00000000000b' as SessionId, 'vault-v'),
    );

    const result = await readStepResult(redis);
    expect(result.status).toBe('FAILED');
    expect(result.error?.message).toContain('SPACE_QUOTA_REACHED');
    expect(dbMock.spaceInserts).toHaveLength(0);
  });

  it('creates when the owner is below the quota', async () => {
    dbMock.reset(OWNER, PARENT_PROFILE, { maxSpacesPerUser: 3, ownedSpaceCount: 2 });
    const redis = await freshRedis();

    await handleSpaceCrudInline(
      buildArgs(redis, 'd0000000-0000-4000-8000-00000000000c' as SessionId, 'vault-vi'),
    );

    expect((await readStepResult(redis)).status).toBe('SUCCEEDED');
    expect(dbMock.spaceInserts).toHaveLength(1);
    expect(dbMock.membershipInserts).toHaveLength(1);
  });
});
