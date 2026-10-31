/**
 * Plan 335 P2 on a real database: the owner adds, edits and removes profiles,
 * and a new profile has its own `Personal` space and does not see the owner's.
 *
 * The real auth and tenant plugins run against a bootstrapped install with the
 * profile count cached for its usual lifetime. A browser with no session then
 * changes answer at once after an add or a removal only if the route dropped
 * the count.
 *
 * Plan 335 P3 on the same install: after the add, the picker lists both
 * profiles and issues the session that lets the owner's browser in again.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import sensible from '@fastify/sensible';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { and, eq } from 'drizzle-orm';
import type postgres from 'postgres';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  createDatabase,
  createTenantContext,
  dropTenantSchema,
  spaceCapabilityAssignments,
  spaceMemberships,
  spaces,
  tenantMemberships,
  tenants,
  users,
  withTenantSchema,
} from '@aflow/database';
import {
  LOCAL_BROWSER_CALLER_HEADER,
  LOCAL_PROFILE_SESSION_HEADER,
  type EditionDescriptor,
  type TenantId,
} from '@aflow/schemas';
import { bootstrapLocalEdition } from '../bootstrap/localEdition.js';
import { seedLocalProfile } from '../bootstrap/__fixtures__/localProfiles.js';
import { authPlugin } from '../plugins/auth.js';
import { tenantPlugin } from '../plugins/tenant.js';
import { issueLocalProfileSession } from '../plugins/localProfiles.js';
import { spaceCrudRoutes } from './spaceCrudRoutes.js';
import { localProfileRoutes } from './localProfiles.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

// A tenant of its own, so the run never touches the dev instance's data.
const TENANT_ID = '00000000-0000-4000-8000-0000000e2335' as TenantId;
const OWNER_ID = randomUUID();
const SECRET = 'p'.repeat(48);

const EDITION: EditionDescriptor = {
  edition: 'community-local',
  authProvider: 'local-instance',
  tenancy: { mode: 'fixed', tenantId: TENANT_ID },
  exposure: { bind: 'loopback', requireTls: false },
  computeRuntime: 'absent',
  codeLane: 'absent',
  hostLane: 'absent',
  browserLane: 'absent',
};

const MANAGED_ENV = ['PHOENIX_INSTANCE_SECRET', 'PHOENIX_LOCAL_OWNER_ID'] as const;

/** What the web process sends for a browser, with or without a profile session. */
const browser = (userId?: string): Record<string, string> => ({
  authorization: `Bearer ${SECRET}`,
  [LOCAL_BROWSER_CALLER_HEADER]: '1',
  ...(userId === undefined
    ? {}
    : { [LOCAL_PROFILE_SESSION_HEADER]: issueLocalProfileSession(userId, SECRET) }),
});

/** What `yarn mcp:setup` sends: the secret and nothing else. */
const BARE_SECRET = { authorization: `Bearer ${SECRET}` };

interface ListedSpace {
  id: string;
  name: string;
  myRole: string | null;
}

describeDb('local profile management (real DB)', () => {
  let sql: postgres.Sql;
  let db: PostgresJsDatabase;
  let app: FastifyInstance;
  let ownerSpaceIds: string[];
  const created: string[] = [];
  const savedEnv: Partial<Record<(typeof MANAGED_ENV)[number], string | undefined>> = {};

  async function clear(): Promise<void> {
    await dropTenantSchema(sql, TENANT_ID).catch(() => undefined);
    await sql`DELETE FROM public.space_memberships WHERE tenant_id = ${TENANT_ID}`;
    await sql`DELETE FROM public.tenant_memberships WHERE tenant_id = ${TENANT_ID}`;
    await sql`DELETE FROM public.tenants WHERE tenant_id = ${TENANT_ID}`;
    for (const id of [OWNER_ID, ...created]) {
      await sql`DELETE FROM public.users WHERE id = ${id}`;
    }
  }

  async function call(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    headers: Record<string, string>,
    payload?: Record<string, unknown>,
  ) {
    const res = await app.inject({
      method,
      url,
      headers,
      ...(payload === undefined ? {} : { payload }),
    });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  }

  async function profileIds(): Promise<string[]> {
    const { body } = await call('GET', '/local-profiles', BARE_SECRET);
    return (body['profiles'] as Array<{ userId: string }>).map((p) => p.userId);
  }

  beforeAll(async () => {
    for (const key of MANAGED_ENV) savedEnv[key] = process.env[key];
    process.env['PHOENIX_INSTANCE_SECRET'] = SECRET;
    process.env['PHOENIX_LOCAL_OWNER_ID'] = OWNER_ID;

    // A single connection: applying the tenant migrations issues its own
    // transactions, which a pooled client refuses.
    const connection = createDatabase({
      connectionString: DATABASE_URL as string,
      maxConnections: 1,
    });
    sql = connection.sql;
    db = connection.db;
    await clear();
    const report = await bootstrapLocalEdition({ edition: EDITION, sql, db, ownerId: OWNER_ID });
    ownerSpaceIds = report.spaceIds;

    app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('appContext', { db, sql, redis: null } as never);
    await app.register(
      fp(
        (instance, _o, done: () => void) => {
          instance.decorate('edition', EDITION);
          done();
        },
        { name: 'edition-plugin' },
      ),
    );
    await app.register(sensible);
    // The count keeps its usual lifetime, so only a dropped count changes the
    // answer between two requests a moment apart.
    await app.register(authPlugin);
    await app.register(tenantPlugin);
    await app.register(spaceCrudRoutes, { prefix: '/spaces' });
    await app.register(localProfileRoutes, { prefix: '/local-profiles' });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await clear();
    await sql.end();
    for (const key of MANAGED_ENV) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }, 60_000);

  let ada: string;
  let adaSpace: string;

  it('lists the owner alone on a fresh install', async () => {
    const { status, body } = await call('GET', '/local-profiles', browser());
    expect(status).toBe(200);
    expect(body['profiles']).toEqual([
      expect.objectContaining({ userId: OWNER_ID, role: 'owner', isOwner: true }),
    ]);
  });

  it('adds a profile with its own Personal space, and counts it at once', async () => {
    const { status, body } = await call('POST', '/local-profiles', browser(), {
      displayName: 'Ada',
      avatar: 'owl',
    });
    expect(status).toBe(201);
    const profile = body['profile'] as { userId: string };
    ada = profile.userId;
    adaSpace = body['spaceId'] as string;
    created.push(ada);
    expect(body['profile']).toEqual(
      expect.objectContaining({
        displayName: 'Ada',
        avatar: 'owl',
        role: 'member',
        isOwner: false,
      }),
    );

    // The count read a moment ago said one profile. Only a dropped count
    // refuses the sessionless browser now.
    const sessionless = await call('GET', '/local-profiles', browser());
    expect(sessionless.status).toBe(401);
    expect(sessionless.body['code']).toBe('PROFILE_SESSION_REQUIRED');

    const [user] = await db.select().from(users).where(eq(users.id, ada));
    expect(user).toEqual(expect.objectContaining({ kind: 'human', status: 'active', email: null }));

    const [space] = await withTenantSchema(db, createTenantContext(TENANT_ID), (tx) =>
      tx.select().from(spaces).where(eq(spaces.id, adaSpace)),
    );
    expect(space).toEqual(
      expect.objectContaining({ name: 'Personal', ownerId: ada, createdBy: ada }),
    );
    expect(space?.computePolicy?.enabled).toBe(false);

    const members = await db
      .select({ userId: spaceMemberships.userId, role: spaceMemberships.role })
      .from(spaceMemberships)
      .where(eq(spaceMemberships.spaceId, adaSpace));
    expect(members).toEqual([{ userId: ada, role: 'admin' }]);

    const assigned = await withTenantSchema(db, createTenantContext(TENANT_ID), (tx) =>
      tx
        .select({ spaceId: spaceCapabilityAssignments.spaceId })
        .from(spaceCapabilityAssignments)
        .where(eq(spaceCapabilityAssignments.spaceId, adaSpace)),
    );
    expect(assigned).toHaveLength(1);
  });

  // Plan 335 P3: the add no longer locks a browser out. The picker issues the
  // session that lets the owner's browser in again.
  it('lets the sessionless browser choose a profile and manage profiles again', async () => {
    const picker = await call('GET', '/local-profiles/picker', browser());
    expect(picker.status).toBe(200);
    expect(picker.body['profiles']).toEqual([
      { userId: OWNER_ID, displayName: 'Local user', avatar: null, isOwner: true },
      { userId: ada, displayName: 'Ada', avatar: 'owl', isOwner: false },
    ]);

    // The web process asks for the session itself, without the browser mark.
    expect((await call('POST', `/local-profiles/${OWNER_ID}/session`, browser())).status).toBe(403);
    expect(
      (await call('POST', `/local-profiles/${randomUUID()}/session`, BARE_SECRET)).status,
    ).toBe(404);
    const issued = await call('POST', `/local-profiles/${OWNER_ID}/session`, BARE_SECRET);
    expect(issued.status).toBe(200);
    const session = issued.body['session'] as string;

    const withSession = {
      ...browser(),
      [LOCAL_PROFILE_SESSION_HEADER]: session,
    };
    const list = await call('GET', '/local-profiles', withSession);
    expect(list.status).toBe(200);
    expect((list.body['profiles'] as unknown[]).length).toBe(2);
  });

  it("gives the new profile its own Personal space and none of the owner's", async () => {
    const { status, body } = await call('GET', '/spaces', browser(ada));
    expect(status).toBe(200);
    const listed = body['spaces'] as ListedSpace[];
    expect(listed.map((s) => [s.id, s.name, s.myRole])).toEqual([[adaSpace, 'Personal', 'admin']]);
    for (const id of ownerSpaceIds) expect(listed.map((s) => s.id)).not.toContain(id);
  });

  it("shows the owner the new profile's space as a name only", async () => {
    const { body } = await call('GET', '/spaces', browser(OWNER_ID));
    const listed = body['spaces'] as ListedSpace[];
    expect(listed.find((s) => s.id === adaSpace)?.myRole).toBeNull();
    for (const id of ownerSpaceIds) {
      expect(listed.find((s) => s.id === id)?.myRole).toBe('admin');
    }
  });

  it('renames a profile and changes its avatar', async () => {
    const renamed = await call('PATCH', `/local-profiles/${ada}`, browser(OWNER_ID), {
      displayName: 'Ada L.',
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toEqual(expect.objectContaining({ displayName: 'Ada L.', avatar: 'owl' }));

    const avatar = await call('PATCH', `/local-profiles/${ada}`, browser(OWNER_ID), {
      avatar: 'fox',
    });
    expect(avatar.body).toEqual(expect.objectContaining({ displayName: 'Ada L.', avatar: 'fox' }));

    const [user] = await db.select().from(users).where(eq(users.id, ada));
    expect(user?.avatarUrl).toBe('aflow-avatar:fox');
  });

  it('refuses a non-owner profile session on every management route', async () => {
    const admin = await seedLocalProfile(db, {
      tenantId: TENANT_ID,
      displayName: 'Tenant admin',
      role: 'admin',
    });
    created.push(admin);
    for (const caller of [ada, admin]) {
      for (const [method, url, payload] of [
        ['GET', '/local-profiles', undefined],
        ['POST', '/local-profiles', { displayName: 'Mallory', avatar: 'cat' }],
        ['PATCH', `/local-profiles/${OWNER_ID}`, { displayName: 'Mallory' }],
        ['GET', `/local-profiles/${OWNER_ID}/removal`, undefined],
        ['DELETE', `/local-profiles/${ada}`, undefined],
      ] as const) {
        const { status } = await call(method, url, browser(caller), payload);
        expect(status, `${caller} ${method} ${url}`).toBe(403);
      }
    }
    expect(await profileIds()).toEqual([OWNER_ID, ada, admin]);
    await call('DELETE', `/local-profiles/${admin}`, BARE_SECRET);
  });

  it('refuses to remove the owner', async () => {
    const { status } = await call('DELETE', `/local-profiles/${OWNER_ID}`, BARE_SECRET);
    expect(status).toBe(409);
  });

  it('removes a profile, ends its sessions and drops the count', async () => {
    const adaSession = browser(ada);
    expect((await call('GET', '/spaces', adaSession)).status).toBe(200);
    // Read the count as several, so a stale cache would keep refusing below.
    expect((await call('GET', '/local-profiles', browser())).status).toBe(401);

    const preview = await call('GET', `/local-profiles/${ada}/removal`, browser(OWNER_ID));
    expect(preview.status).toBe(200);
    expect(preview.body['spacesDeleted']).toEqual([{ spaceId: adaSpace, name: 'Personal' }]);

    const removed = await call('DELETE', `/local-profiles/${ada}`, browser(OWNER_ID));
    expect(removed.status).toBe(200);
    expect(removed.body['spacesDeleted']).toEqual([{ spaceId: adaSpace, name: 'Personal' }]);

    // The browser that held the session is sent back to the picker.
    expect(await call('GET', '/spaces', adaSession)).toEqual({
      status: 401,
      body: expect.objectContaining({ code: 'PROFILE_SESSION_INVALID' }),
    });
    expect(await call('GET', '/local-profiles', browser())).toEqual({
      status: 200,
      body: {
        profiles: [expect.objectContaining({ userId: OWNER_ID, isOwner: true })],
      },
    });

    expect(await db.select().from(users).where(eq(users.id, ada))).toEqual([]);
    const left = await withTenantSchema(db, createTenantContext(TENANT_ID), (tx) =>
      tx.select({ id: spaces.id }).from(spaces),
    );
    expect(left.map((s) => s.id)).not.toContain(adaSpace);
    for (const id of ownerSpaceIds) expect(left.map((s) => s.id)).toContain(id);
    expect(await db.select().from(tenants).where(eq(tenants.tenantId, TENANT_ID))).toHaveLength(1);
    expect(
      await db
        .select()
        .from(tenantMemberships)
        .where(
          and(eq(tenantMemberships.tenantId, TENANT_ID), eq(tenantMemberships.userId, OWNER_ID)),
        ),
    ).toHaveLength(1);
  });
});
