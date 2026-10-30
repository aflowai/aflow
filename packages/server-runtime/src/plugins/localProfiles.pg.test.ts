/**
 * Plan 335 §10, on a real database: who a request to a local install is, before
 * and after a second profile exists.
 *
 * The real auth and tenant plugins run against a bootstrapped install, so the
 * profile count and the membership read are the rows bootstrap and the seed
 * wrote. A double could answer either question however the test wished.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import sensible from '@fastify/sensible';
import { and, eq } from 'drizzle-orm';
import type postgres from 'postgres';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createDatabase, dropTenantSchema, tenantMemberships } from '@aflow/database';
import {
  LOCAL_BROWSER_CALLER_HEADER,
  LOCAL_PROFILE_SESSION_HEADER,
  type EditionDescriptor,
  type TenantId,
} from '@aflow/schemas';
import { bootstrapLocalEdition } from '../bootstrap/localEdition.js';
import { seedLocalProfile } from '../bootstrap/__fixtures__/localProfiles.js';
import { authPlugin } from './auth.js';
import { tenantPlugin } from './tenant.js';
import { issueLocalProfileSession } from './localProfiles.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

// A tenant of its own, so the run never touches the dev instance's data.
const TENANT_ID = '00000000-0000-4000-8000-0000000ed335' as TenantId;
const OWNER_ID = randomUUID();
const SECRET = 's'.repeat(48);

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

describeDb('local profiles (real DB)', () => {
  let sql: postgres.Sql;
  let db: PostgresJsDatabase;
  let app: FastifyInstance;
  const seeded: string[] = [];
  const savedEnv: Partial<Record<(typeof MANAGED_ENV)[number], string | undefined>> = {};

  async function clear(): Promise<void> {
    await dropTenantSchema(sql, TENANT_ID).catch(() => undefined);
    await sql`DELETE FROM public.space_memberships WHERE tenant_id = ${TENANT_ID}`;
    await sql`DELETE FROM public.tenant_memberships WHERE tenant_id = ${TENANT_ID}`;
    await sql`DELETE FROM public.tenants WHERE tenant_id = ${TENANT_ID}`;
    for (const id of [OWNER_ID, ...seeded]) {
      await sql`DELETE FROM public.users WHERE id = ${id}`;
    }
  }

  async function probe(headers: Record<string, string>) {
    const res = await app.inject({ method: 'GET', url: '/probe', headers });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
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
    await bootstrapLocalEdition({ edition: EDITION, sql, db, ownerId: OWNER_ID });

    app = Fastify({ logger: false });
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
    await app.register(authPlugin, {});
    await app.register(tenantPlugin);
    app.get(
      '/probe',
      { preHandler: (request, reply) => app.authenticate(request, reply) },
      async (request) => {
        const tenant = await request.requireTenant();
        return {
          userId: request.authUser?.userId,
          via: request.authUser?.localPrincipal,
          role: tenant.tenantRole,
        };
      },
    );
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

  describe('a fresh install with one profile', () => {
    it('serves a browser with no profile session as the owner', async () => {
      expect(await probe(browser())).toEqual({
        status: 200,
        body: { userId: OWNER_ID, via: 'sole-profile', role: 'owner' },
      });
    });

    it('serves a bare-secret caller as the owner', async () => {
      expect(await probe(BARE_SECRET)).toEqual({
        status: 200,
        body: { userId: OWNER_ID, via: 'sole-profile', role: 'owner' },
      });
    });

    it('reads a session naming the one profile through its membership', async () => {
      expect(await probe(browser(OWNER_ID))).toEqual({
        status: 200,
        body: { userId: OWNER_ID, via: 'profile-session', role: 'owner' },
      });
    });
  });

  describe('an install with a second profile', () => {
    let second: string;
    let pending: string;

    beforeAll(async () => {
      second = await seedLocalProfile(db, { tenantId: TENANT_ID, displayName: 'Second' });
      pending = await seedLocalProfile(db, {
        tenantId: TENANT_ID,
        displayName: 'Not yet joined',
        membership: 'pending',
      });
      seeded.push(second, pending);
    });

    it('refuses a browser with no profile session rather than acting as the owner', async () => {
      const { status, body } = await probe(browser());
      expect(status).toBe(401);
      expect(body['code']).toBe('PROFILE_SESSION_REQUIRED');
    });

    it('keeps a bare-secret caller as the owner, through its membership', async () => {
      expect(await probe(BARE_SECRET)).toEqual({
        status: 200,
        body: { userId: OWNER_ID, via: 'instance-secret', role: 'owner' },
      });
    });

    it('serves the second profile its own member role', async () => {
      expect(await probe(browser(second))).toEqual({
        status: 200,
        body: { userId: second, via: 'profile-session', role: 'member' },
      });
    });

    it('serves the owner from a session naming the owner', async () => {
      expect(await probe(browser(OWNER_ID))).toEqual({
        status: 200,
        body: { userId: OWNER_ID, via: 'profile-session', role: 'owner' },
      });
    });

    it('refuses a session for a user without an active membership with a 403', async () => {
      expect((await probe(browser(pending))).status).toBe(403);
      expect((await probe(browser(randomUUID()))).status).toBe(403);
    });

    it('serves a browser with no session as the owner again once the second profile leaves', async () => {
      await db
        .update(tenantMemberships)
        .set({ status: 'suspended' })
        .where(
          and(eq(tenantMemberships.tenantId, TENANT_ID), eq(tenantMemberships.userId, second)),
        );
      expect(await probe(browser())).toEqual({
        status: 200,
        body: { userId: OWNER_ID, via: 'sole-profile', role: 'owner' },
      });
    });
  });
});
