/**
 * POST /v1/spaces creation gate + quota: every space starts solo (no type in
 * the contract), creation carries ownerId + creator membership + bootstrap,
 * and maxSpacesPerUser caps a non-admin's active owned spaces regardless of
 * sharing state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import {
  tenants,
  spaces,
  spaceSlugHistory,
  capabilityProfiles,
  spaceMemberships,
} from '@aflow/database';

const mocks = vi.hoisted(() => ({
  bootstrapCyberneticEntity: vi.fn(async (_args: unknown) => ({
    created: [],
    resolvedAgents: { helmsman: 'agent-1' },
    durationMs: 1,
  })),
}));
vi.mock('../services/entityBootstrap.js', () => ({
  bootstrapCyberneticEntity: mocks.bootstrapCyberneticEntity,
}));

const { spaceCrudRoutes } = await import('./spaceCrudRoutes.js');
const { spacePolicyRoutes } = await import('./spacePolicyRoutes.js');
const { spaceLifecycleRoutes } = await import('./spaceLifecycleRoutes.js');

const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const USER_ID = '00000000-0000-4000-8000-0000000000aa';
const SPACE_ID = '00000000-0000-4000-8000-0000000000bb';

interface FakeDbOpts {
  tenantRow?: { signupPolicy: string; quotas: unknown };
  ownedSpaceCount?: number;
  spaceRows?: Array<Record<string, unknown>>;
  membershipRows?: Array<Record<string, unknown>>;
  membershipCountRows?: Array<Record<string, unknown>>;
}

interface FakeDb {
  db: unknown;
  inserted: Array<{ table: unknown; values: Record<string, unknown> }>;
  quotaConditions: unknown[];
  executed: unknown[];
}

/** String values reachable anywhere inside a (cyclic) drizzle condition tree. */
function collectStringValues(node: unknown, seen = new Set<unknown>()): string[] {
  if (typeof node === 'string') return [node];
  if (node === null || typeof node !== 'object' || seen.has(node)) return [];
  seen.add(node);
  const out: string[] = [];
  for (const value of Object.values(node as Record<string, unknown>)) {
    out.push(...collectStringValues(value, seen));
  }
  return out;
}

/** Column names referenced anywhere inside a drizzle condition tree. */
function collectColumnNames(node: unknown, seen = new Set<unknown>()): string[] {
  if (node === null || typeof node !== 'object' || seen.has(node)) return [];
  seen.add(node);
  const record = node as Record<string, unknown>;
  const names: string[] = [];
  if (typeof record['name'] === 'string' && typeof record['table'] === 'object') {
    names.push(record['name']);
  }
  const chunks = record['queryChunks'];
  if (Array.isArray(chunks)) {
    for (const chunk of chunks) names.push(...collectColumnNames(chunk, seen));
  }
  return names;
}

function makeFakeDb(opts: FakeDbOpts): FakeDb {
  const inserted: FakeDb['inserted'] = [];
  const quotaConditions: unknown[] = [];
  const executed: unknown[] = [];

  const rowsFor = (table: unknown): unknown[] => {
    if (table === tenants) return opts.tenantRow ? [opts.tenantRow] : [];
    if (table === spaceSlugHistory) return [];
    if (table === spaces) {
      if (opts.spaceRows) return opts.spaceRows;
      return Array.from({ length: opts.ownedSpaceCount ?? 0 }, (_, i) => ({
        id: `owned-${String(i)}`,
      }));
    }
    if (table === spaceMemberships) return opts.membershipRows ?? [];
    if (table === capabilityProfiles) return [{ id: '00000000-0000-4000-8000-0000000000cc' }];
    return [];
  };

  const select = () => {
    let table: unknown;
    const chain = {
      from(t: unknown) {
        table = t;
        return chain;
      },
      // Awaitable without .where() — the admin listing has no filter.
      then(resolve: (rows: unknown[]) => unknown, reject: (err: unknown) => unknown) {
        return Promise.resolve(rowsFor(table)).then(resolve, reject);
      },
      where(condition: unknown) {
        if (table === spaces) quotaConditions.push(condition);
        return {
          limit: () => Promise.resolve(rowsFor(table)),
          groupBy: () => Promise.resolve(opts.membershipCountRows ?? []),
          then: (resolve: (rows: unknown[]) => unknown, reject: (err: unknown) => unknown) =>
            Promise.resolve(rowsFor(table)).then(resolve, reject),
        };
      },
    };
    return chain;
  };

  const insert = (table: unknown) => ({
    values: (values: Record<string, unknown>) => {
      inserted.push({ table, values });
      const promise = Promise.resolve(undefined) as Promise<unknown> & {
        returning?: () => Promise<unknown[]>;
      };
      promise.returning = () =>
        Promise.resolve([
          {
            id: SPACE_ID,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            updatedAt: new Date('2026-01-01T00:00:00.000Z'),
            archivedAt: null,
            description: null,
            ...values,
          },
        ]);
      return promise;
    },
  });

  const tx = {
    execute: async (query: unknown) => {
      executed.push(query);
      return undefined;
    },
    select,
    insert,
  };
  const db = {
    select,
    insert,
    transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
  };
  return { db, inserted, quotaConditions, executed };
}

async function buildTestApp(opts: {
  tenantRole?: 'owner' | 'admin' | 'member' | 'viewer';
  db: unknown;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  (app as unknown as { appContext: unknown }).appContext = { db: opts.db };
  app.decorate('edition', {
    edition: 'enterprise',
    authProvider: 'auth0',
    tenancy: { mode: 'multi' },
    exposure: { bind: 'any', requireTls: true },
  } as never);

  const stubAuthenticate = async (request: FastifyRequest): Promise<void> => {
    (request as unknown as { authUser: unknown }).authUser = {
      userId: USER_ID,
      authMethod: 'test',
      isServicePrincipal: false,
    };
  };
  app.decorate('authenticate', stubAuthenticate);

  const role = opts.tenantRole ?? 'member';
  app.addHook('onRequest', async (request) => {
    (request as unknown as { requireTenant: () => Promise<unknown> }).requireTenant = async () => ({
      tenantId: TENANT_ID,
      tenantRole: role,
      isAdmin: role === 'owner' || role === 'admin',
    });
  });

  await app.register(spaceCrudRoutes, { prefix: '/v1/spaces' });
  await app.register(spacePolicyRoutes, { prefix: '/v1/spaces' });
  await app.register(spaceLifecycleRoutes, { prefix: '/v1/spaces' });
  await app.ready();
  return app;
}

beforeEach(() => {
  mocks.bootstrapCyberneticEntity.mockClear();
});

describe('creation gate — tenant role', () => {
  it('denies a tenant viewer', async () => {
    const { db } = makeFakeDb({ tenantRow: { signupPolicy: 'open', quotas: null } });
    const app = await buildTestApp({ tenantRole: 'viewer', db });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/spaces',
      payload: { name: 'Team', slug: 'team-space' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('allows a member (open signup included) — spaces start solo', async () => {
    const { db } = makeFakeDb({ tenantRow: { signupPolicy: 'open', quotas: null } });
    const app = await buildTestApp({ tenantRole: 'member', db });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/spaces',
      payload: { name: 'Team', slug: 'team-space' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ memberCount: 1, ownerId: USER_ID });
    await app.close();
  });

  it('rejects a legacy type field in the body', async () => {
    const { db } = makeFakeDb({ tenantRow: { signupPolicy: 'open', quotas: null } });
    const app = await buildTestApp({ tenantRole: 'member', db });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/spaces',
      payload: { name: 'Team', slug: 'team-space', type: 'shared' },
    });
    // Unknown keys are stripped by the schema — creation still succeeds and
    // the response carries no type.
    expect(res.statusCode).toBe(201);
    expect(res.json()).not.toHaveProperty('type');
    await app.close();
  });
});

describe('space creation provisioning', () => {
  it('carries ownerId, creator admin membership, and bootstrap', async () => {
    const fake = makeFakeDb({ tenantRow: { signupPolicy: 'open', quotas: null } });
    const app = await buildTestApp({ tenantRole: 'member', db: fake.db });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/spaces',
      payload: { name: 'Mine', slug: 'my-space' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ ownerId: USER_ID, memberCount: 1 });

    const spaceInsert = fake.inserted.find((i) => i.table === spaces);
    expect(spaceInsert?.values).toMatchObject({
      ownerId: USER_ID,
      createdBy: USER_ID,
    });
    expect(spaceInsert?.values).not.toHaveProperty('type');
    // Clients no longer send compute policy — the server applies its default.
    expect(spaceInsert?.values['computePolicy']).toMatchObject({
      enabled: true,
      networkEgress: { mode: 'blocked' },
      maxConcurrentContainers: 5,
    });
    const membership = fake.inserted.find((i) => i.table === spaceMemberships);
    expect(membership?.values).toMatchObject({ userId: USER_ID, role: 'admin' });
    expect(mocks.bootstrapCyberneticEntity).toHaveBeenCalledTimes(1);
    expect(mocks.bootstrapCyberneticEntity.mock.calls[0]?.[0]).toMatchObject({
      spaceId: SPACE_ID,
      operatorUserId: USER_ID,
    });
    await app.close();
  });
});

describe('maxSpacesPerUser quota', () => {
  it('denies creation at the limit with a plain-language 403 naming it', async () => {
    const fake = makeFakeDb({
      tenantRow: { signupPolicy: 'open', quotas: { maxSpacesPerUser: 2 } },
      ownedSpaceCount: 2,
    });
    const app = await buildTestApp({ tenantRole: 'member', db: fake.db });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/spaces',
      payload: { name: 'Mine', slug: 'my-space' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'QuotaExceeded' });
    expect(JSON.stringify(res.json())).toMatch(/limit of 2 spaces/);

    // The count is scoped to the creator's non-archived owned spaces —
    // sharing state is irrelevant, so no type column participates.
    const columns = collectColumnNames(fake.quotaConditions[0]);
    expect(columns).toEqual(expect.arrayContaining(['owner_id', 'archived_at']));
    expect(columns).not.toContain('type');

    // Count-then-insert is serialized per owner via a transaction-scoped
    // advisory lock.
    const executedSql = JSON.stringify(fake.executed);
    expect(executedSql).toContain('pg_advisory_xact_lock');
    expect(executedSql).toContain(`space-quota:${USER_ID}`);
    await app.close();
  });

  it('allows creation below the limit', async () => {
    const { db } = makeFakeDb({
      tenantRow: { signupPolicy: 'open', quotas: { maxSpacesPerUser: 2 } },
      ownedSpaceCount: 1,
    });
    const app = await buildTestApp({ tenantRole: 'member', db });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/spaces',
      payload: { name: 'Mine', slug: 'my-space' },
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('exempts tenant admins from the quota', async () => {
    const { db } = makeFakeDb({
      tenantRow: { signupPolicy: 'open', quotas: { maxSpacesPerUser: 2 } },
      ownedSpaceCount: 50,
    });
    const app = await buildTestApp({ tenantRole: 'admin', db });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/spaces',
      payload: { name: 'Mine', slug: 'my-space' },
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('unset quota means unlimited', async () => {
    const { db } = makeFakeDb({
      tenantRow: { signupPolicy: 'open', quotas: null },
      ownedSpaceCount: 50,
    });
    const app = await buildTestApp({ tenantRole: 'member', db });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/spaces',
      payload: { name: 'Mine', slug: 'my-space' },
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('a missing tenant row falls back to invite-only with no quota', async () => {
    const { db } = makeFakeDb({});
    const app = await buildTestApp({ tenantRole: 'member', db });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/spaces',
      payload: { name: 'Mine', slug: 'my-space' },
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });
});

describe('member space listing', () => {
  it('lists only membership spaces for a member, with memberCount', async () => {
    const fake = makeFakeDb({
      membershipRows: [{ spaceId: 'm1', role: 'editor' }],
      membershipCountRows: [{ spaceId: 'm1', count: 3 }],
      spaceRows: [
        {
          id: 'm1',
          name: 'Mine',
          slug: 'mine',
          ownerId: null,
          createdBy: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          archivedAt: null,
        },
      ],
    });
    const app = await buildTestApp({ tenantRole: 'member', db: fake.db });
    const res = await app.inject({ method: 'GET', url: '/v1/spaces' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      spaces: Array<{ id: string; myRole: string | null; memberCount: number }>;
    };
    expect(body.spaces).toHaveLength(1);
    expect(body.spaces[0]).toMatchObject({ id: 'm1', myRole: 'editor', memberCount: 3 });

    // The spaces query itself is membership-scoped for non-admins.
    const listCondition = fake.quotaConditions[0];
    expect(collectColumnNames(listCondition)).toContain('id');
    expect(collectStringValues(listCondition)).toContain('m1');
    await app.close();
  });

  it('redacts non-member rows to the metadata projection for tenant admins', async () => {
    const fake = makeFakeDb({
      membershipRows: [],
      membershipCountRows: [{ spaceId: 'other-1', count: 2 }],
      spaceRows: [
        {
          id: 'other-1',
          name: 'Foreign',
          slug: 'foreign',
          ownerId: '00000000-0000-4000-8000-0000000000dd',
          createdBy: '00000000-0000-4000-8000-0000000000dd',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          archivedAt: null,
          rules: [{ text: 'secret rule' }],
          directives: { version: 1, responsibility: 'secret' },
          computePolicy: { enabled: true },
          writePolicy: { low: 'default' },
          defaultTargetKind: 'platform-role',
          defaultTargetSystemRole: 'cybernetic-helmsman',
        },
      ],
    });
    const app = await buildTestApp({ tenantRole: 'admin', db: fake.db });
    const res = await app.inject({ method: 'GET', url: '/v1/spaces' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { spaces: Array<Record<string, unknown>> };
    expect(body.spaces).toHaveLength(1);
    const row = body.spaces[0]!;
    expect(row).toMatchObject({ id: 'other-1', myRole: null, memberCount: 2 });
    for (const field of [
      'rules',
      'directives',
      'computePolicy',
      'writePolicy',
      'defaultTarget',
      'defaultAgentId',
    ]) {
      expect(row).not.toHaveProperty(field);
    }
  });

  it('a member without memberships lists zero spaces', async () => {
    const fake = makeFakeDb({});
    const app = await buildTestApp({ tenantRole: 'member', db: fake.db });
    const res = await app.inject({ method: 'GET', url: '/v1/spaces' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ spaces: [] });
    await app.close();
  });
});
