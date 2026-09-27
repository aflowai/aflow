/**
 * The validator comparison, driven through every shape a real client sends.
 * The first cut was `header === etag`, which missed a weakened tag, a list,
 * and `*` — all three degrade silently to a full 200, so nothing but a test
 * ever notices.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { TestContext } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import {
  createDatabase,
  createTenantContext,
  spaceMemberships,
  spaces,
  tenantMemberships,
  uiArtifacts,
  uiArtifactVersions,
  users,
  withTenantSchema,
} from '@aflow/database';
import { checkPermission, resolveSpaceRole } from '@aflow/authz';
import type { AuthzAction, AuthzResourceType, SpaceRole } from '@aflow/authz';
import type { TenantId } from '@aflow/schemas';
import { contentAddressForJson, createMemoryPayloadStore } from '@aflow/payload-store';
import { etagMatches, uiArtifactViewRoutes } from './uiArtifactViews.js';

const ETAG = '"abc123def456"';

describe('what If-None-Match matches', () => {
  it('matches the exact strong tag', () => {
    expect(etagMatches(ETAG, ETAG)).toBe(true);
  });

  it('matches the weakened form a compressing proxy returns', () => {
    // The production edge rewrites strong ETags to weak on compression, so
    // this is the shape most real revalidations arrive in.
    expect(etagMatches(`W/${ETAG}`, ETAG)).toBe(true);
  });

  it('matches inside a list, wherever it sits', () => {
    expect(etagMatches(`"other", ${ETAG}`, ETAG)).toBe(true);
    expect(etagMatches(`${ETAG}, "other"`, ETAG)).toBe(true);
    expect(etagMatches(['"other"', ETAG], ETAG)).toBe(true);
  });

  it('honours *, which matches any current representation', () => {
    expect(etagMatches('*', ETAG)).toBe(true);
  });

  it('misses a different tag, and an absent header', () => {
    expect(etagMatches('"something-else"', ETAG)).toBe(false);
    expect(etagMatches(undefined, ETAG)).toBe(false);
  });
});

// ============================================================================
// The route itself, against a real database
// ============================================================================

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;
const describeDb = DATABASE_URL ? describe : describe.skip;

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

describeDb('artifact version view route (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const rawSql = handle.sql;
  const tenantCtx = createTenantContext(TENANT_ID as TenantId);
  const payloadStore = createMemoryPayloadStore();

  const spaceA = randomUUID();
  const spaceB = randomUUID();
  const memberA = randomUUID();
  const ownerB = randomUUID();

  // A view stored the legacy way: base64 of the RAW html, the shape every
  // pre-migration row holds.
  const artifactLegacy = randomUUID();
  const versionLegacy = randomUUID();
  const legacyHtml = '<!DOCTYPE html>\n<html><body>legacy view</body></html>';

  // A version nothing compiled yet — a plain-DOM applet source, so the lazy
  // path wraps it without esbuild.
  const artifactLazy = randomUUID();
  const versionLazy = randomUUID();
  const lazySource = "document.body.textContent = 'lazy view';";

  // A version whose artifact is not an applet — the refusal branch.
  const artifactOther = randomUUID();
  const versionOther = randomUUID();

  // A version in a space the caller is not a member of.
  const artifactForeign = randomUUID();
  const versionForeign = randomUUID();

  let schemaReady = false;
  let app: FastifyInstance;

  async function loadSpaceAttributes(
    spaceId: string,
  ): Promise<{ ownerId: string | null; memberCount: number } | null> {
    const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
      tx.select({ ownerId: spaces.ownerId }).from(spaces).where(eq(spaces.id, spaceId)).limit(1),
    );
    const row = rows[0];
    if (row === undefined) return null;
    const countRows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(spaceMemberships)
      .where(and(eq(spaceMemberships.tenantId, TENANT_ID), eq(spaceMemberships.spaceId, spaceId)));
    return { ownerId: row.ownerId, memberCount: countRows[0]?.count ?? 0 };
  }

  async function buildApp(): Promise<FastifyInstance> {
    const instance = Fastify({ logger: false });
    instance.setValidatorCompiler(validatorCompiler);
    instance.setSerializerCompiler(serializerCompiler);
    (instance as unknown as { appContext: unknown }).appContext = {
      db,
      redis: null,
      payloadStore,
    };

    instance.decorate(
      'requirePermission',
      (opts: {
        resource: AuthzResourceType;
        action: AuthzAction;
        getSpaceId?: (request: FastifyRequest) => string | undefined;
      }) =>
        async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
          const { userId } = (request as unknown as { authUser: { userId: string } }).authUser;
          const spaceId = opts.getSpaceId?.(request);
          const decision = await checkPermission(
            {
              userId,
              tenantId: TENANT_ID,
              tenantRole: 'member',
              redis: fakeRedis(),
              config: { rbacCacheTtlSeconds: 60 },
              loadSpaceRole: async (uid, tid, sid) =>
                (await resolveSpaceRole(db, null, {
                  userId: uid,
                  tenantId: tid,
                  spaceId: sid,
                })) as SpaceRole | null,
              loadSpaceAttributes,
            },
            {
              resource: opts.resource,
              action: opts.action,
              ...(spaceId !== undefined ? { spaceId } : {}),
            },
          );
          if (!decision.allowed) {
            reply.status(403).send({
              error: 'Forbidden',
              message: `Permission denied: ${opts.resource}.${opts.action}`,
            });
          }
        },
    );

    instance.addHook('onRequest', async (request) => {
      const userId = request.headers['x-test-user'];
      if (typeof userId === 'string' && userId.length > 0) {
        (request as unknown as { authUser: unknown }).authUser = {
          userId,
          roles: [],
          authMethod: 'test',
          isServicePrincipal: false,
        };
      }
      (request as unknown as { requireTenant: () => Promise<unknown> }).requireTenant =
        async () => ({ tenantId: TENANT_ID, tenantRole: 'member', isAdmin: false });
    });

    await instance.register(uiArtifactViewRoutes, { prefix: '/ui-artifacts' });
    await instance.ready();
    return instance;
  }

  const get = (versionId: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'GET',
      url: `/ui-artifacts/versions/${versionId}/view`,
      headers: { 'x-test-user': memberA, ...headers },
    });

  beforeAll(async () => {
    const rows = await rawSql<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = ${TENANT_SCHEMA} AND table_name = 'ui_artifact_versions'
      ) AS ok`;
    schemaReady = rows[0]?.ok === true;
    if (!schemaReady) return;

    await db.insert(users).values([
      { id: memberA, displayName: 'View Reader' },
      { id: ownerB, displayName: 'Foreign Space Owner' },
    ]);
    await db.insert(tenantMemberships).values([
      { tenantId: TENANT_ID, userId: memberA, role: 'member', status: 'active' },
      { tenantId: TENANT_ID, userId: ownerB, role: 'member', status: 'active' },
    ]);
    await db.insert(spaceMemberships).values([
      { tenantId: TENANT_ID, spaceId: spaceA, userId: memberA, role: 'viewer' },
      { tenantId: TENANT_ID, spaceId: spaceB, userId: ownerB, role: 'admin' },
    ]);
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.insert(spaces).values([
        {
          id: spaceA,
          name: 'View Route A',
          slug: `view-route-a-${randomUUID().slice(0, 8)}`,
          ownerId: memberA,
        },
        {
          id: spaceB,
          name: 'View Route B',
          slug: `view-route-b-${randomUUID().slice(0, 8)}`,
          ownerId: ownerB,
        },
      ]);
      await tx.insert(uiArtifacts).values(
        [
          { id: artifactLegacy, spaceId: spaceA, kind: 'applet' },
          { id: artifactLazy, spaceId: spaceA, kind: 'applet' },
          { id: artifactOther, spaceId: spaceA, kind: 'react_tsx' },
          { id: artifactForeign, spaceId: spaceB, kind: 'applet' },
        ].map(({ id, spaceId, kind }) => ({
          id,
          name: 'View Fixture',
          kind,
          spaceId,
          currentVersion: 1,
          catalogId: 'test',
          catalogVersion: '1',
          catalogHash: 'test',
        })),
      );
      const inlineOf = (value: string) => `inline:${Buffer.from(value, 'utf8').toString('base64')}`;
      await tx.insert(uiArtifactVersions).values([
        {
          id: versionLegacy,
          artifactId: artifactLegacy,
          version: 1,
          sourceRef: inlineOf(JSON.stringify(lazySource)),
          htmlRef: inlineOf(legacyHtml),
          contentHash: 'test',
          prompt: 'test fixture',
        },
        {
          id: versionLazy,
          artifactId: artifactLazy,
          version: 1,
          sourceRef: inlineOf(JSON.stringify(lazySource)),
          contentHash: 'test',
          prompt: 'test fixture',
        },
        {
          id: versionOther,
          artifactId: artifactOther,
          version: 1,
          sourceRef: inlineOf(JSON.stringify(lazySource)),
          contentHash: 'test',
          prompt: 'test fixture',
        },
        {
          id: versionForeign,
          artifactId: artifactForeign,
          version: 1,
          sourceRef: inlineOf(JSON.stringify(lazySource)),
          htmlRef: inlineOf(legacyHtml),
          contentHash: 'test',
          prompt: 'test fixture',
        },
      ]);
    });
    app = await buildApp();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (schemaReady) {
      await withTenantSchema(db, tenantCtx, async (tx) => {
        await tx
          .delete(uiArtifactVersions)
          .where(
            inArray(uiArtifactVersions.id, [
              versionLegacy,
              versionLazy,
              versionOther,
              versionForeign,
            ]),
          );
        await tx
          .delete(uiArtifacts)
          .where(
            inArray(uiArtifacts.id, [artifactLegacy, artifactLazy, artifactOther, artifactForeign]),
          );
        await tx.delete(spaces).where(inArray(spaces.id, [spaceA, spaceB]));
      });
      await db.delete(spaceMemberships).where(inArray(spaceMemberships.spaceId, [spaceA, spaceB]));
      await db
        .delete(tenantMemberships)
        .where(
          and(
            eq(tenantMemberships.tenantId, TENANT_ID),
            inArray(tenantMemberships.userId, [memberA, ownerB]),
          ),
        );
      await db.delete(users).where(inArray(users.id, [memberA, ownerB]));
    }
    await handle.close();
  });

  function requireSchema(ctx: TestContext): boolean {
    if (!schemaReady) {
      ctx.skip(`tenant schema ${TENANT_SCHEMA} not migrated — run \`yarn db:migrate\``);
      return false;
    }
    return true;
  }

  it('serves the legacy raw-base64 row, with the digest as the validator', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const res = await get(versionLegacy);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { versionId: string; html: string };
    expect(body.versionId).toBe(versionLegacy);
    expect(body.html).toBe(legacyHtml);
    expect(res.headers['etag']).toBe(`"${contentAddressForJson(legacyHtml)}"`);
    expect(res.headers['cache-control']).toBe('private, no-cache');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('answers 304 to the validator it issued, and to its weakened form', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const etag = `"${contentAddressForJson(legacyHtml)}"`;
    const exact = await get(versionLegacy, { 'if-none-match': etag });
    expect(exact.statusCode).toBe(304);
    expect(exact.headers['etag']).toBe(etag);
    expect(exact.headers['cache-control']).toBe('private, no-cache');
    const weakened = await get(versionLegacy, { 'if-none-match': `W/${etag}` });
    expect(weakened.statusCode).toBe(304);
  });

  it('compiles a never-compiled version on read, and persists the ref it stored', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const res = await get(versionLazy);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { html: string };
    expect(body.html).toContain('lazy view');

    const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
      tx
        .select({ htmlRef: uiArtifactVersions.htmlRef })
        .from(uiArtifactVersions)
        .where(eq(uiArtifactVersions.id, versionLazy))
        .limit(1),
    );
    const ref = rows[0]?.htmlRef ?? '';
    // Content-addressed: the persisted ref carries the same digest the
    // response used as its validator.
    expect(ref).toContain('/content/');
    expect(res.headers['etag']).toBe(`"${contentAddressForJson(body.html)}"`);
    expect(ref).toContain(contentAddressForJson(body.html));

    // The second read serves off the stored ref rather than recompiling.
    const again = await get(versionLazy);
    expect(again.statusCode).toBe(200);
    expect((again.json() as { html: string }).html).toBe(body.html);
  });

  it('masks a version in a space the caller cannot read as not found', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const foreign = await get(versionForeign);
    const missing = await get(randomUUID());
    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    // Indistinguishable: whether a version exists is a fact about its space.
    expect(foreign.json()).toEqual(missing.json());
  });

  it('names the refusal when the artifact has no applet view', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const res = await get(versionOther);
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: string; reason?: string };
    expect(body.error).toBe('ViewUnavailable');
    expect(body.reason).toBe('not_an_applet');
  });
});
