/**
 * The /mcp/servers and /mcp/bindings routes against a real database.
 *
 * Both route files are thin over the shared admin functions in
 * `@aflow/cybernetic-runtime`, so what matters is that a request in one space
 * reads and writes that space alone, that a binding update which states no
 * scope keeps its flow narrowing, and that deleting a server takes its
 * bindings with it. Gated on DATABASE_URL like every pg test.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { TestContext } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { sql as drizzleSql, type SQL } from 'drizzle-orm';
import { createDatabase, createTenantContext, withTenantSchema } from '@aflow/database';
import type { TenantId } from '@aflow/schemas';
import { registerMcpServerRoutes } from './mcp-servers.js';
import { registerMcpBindingRoutes } from './mcp-bindings.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;
const SPACE = '3c910000-0000-4000-8000-0000000000b1';
const OTHER_SPACE = '3c910000-0000-4000-8000-0000000000b2';

const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('MCP server and binding routes (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const tenantCtx = createTenantContext(TENANT_ID as TenantId);

  let schemaReady = false;
  let app: FastifyInstance;
  let currentSpace = SPACE;

  async function query<T>(statement: SQL): Promise<T[]> {
    return (await withTenantSchema(db, tenantCtx, async (tx) =>
      tx.execute(statement),
    )) as unknown as T[];
  }

  async function cleanup(): Promise<void> {
    for (const space of [SPACE, OTHER_SPACE]) {
      await query(drizzleSql`DELETE FROM mcp_server_bindings WHERE space_id = ${space}::uuid`);
      await query(drizzleSql`DELETE FROM mcp_server_definitions WHERE space_id = ${space}::uuid`);
    }
  }

  async function buildApp(): Promise<FastifyInstance> {
    const instance = Fastify({ logger: false });
    instance.setValidatorCompiler(validatorCompiler);
    instance.setSerializerCompiler(serializerCompiler);
    (instance as unknown as { appContext: unknown }).appContext = { db, redis: null };
    instance.addHook('onRequest', async (request: FastifyRequest) => {
      (
        request as unknown as { requireTenant: () => Promise<{ tenantId: TenantId }> }
      ).requireTenant = async () => ({ tenantId: TENANT_ID as TenantId });
      (request as unknown as { requireSpace: () => Promise<{ spaceId: string }> }).requireSpace =
        async () => ({ spaceId: currentSpace });
    });
    await instance.register(async (scoped) => {
      registerMcpServerRoutes(scoped);
      registerMcpBindingRoutes(scoped);
    });
    await instance.ready();
    return instance;
  }

  async function inSpace<T>(spaceId: string, fn: () => Promise<T>): Promise<T> {
    currentSpace = spaceId;
    try {
      return await fn();
    } finally {
      currentSpace = SPACE;
    }
  }

  function postServer(serverId: string, name = `${serverId} server`) {
    return app.inject({
      method: 'POST',
      url: '/mcp/servers',
      payload: { serverId, name, serverUrl: `https://${serverId}.example.com/mcp` },
    });
  }

  function postBinding(payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/mcp/bindings',
      payload: {
        bindingId: 'docs-default',
        serverId: 'docs',
        name: 'Docs default',
        auth: { type: 'none' },
        enabled: false,
        ...payload,
      },
    });
  }

  async function storedScope(bindingId: string): Promise<unknown> {
    const res = await app.inject({ method: 'GET', url: `/mcp/bindings/${bindingId}` });
    expect(res.statusCode).toBe(200);
    return (JSON.parse(res.body) as { binding: { scope: unknown } }).binding.scope;
  }

  beforeAll(async () => {
    const rows = await handle.sql<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = ${TENANT_SCHEMA} AND table_name = 'mcp_server_bindings'
      ) AS ok`;
    schemaReady = rows[0]?.ok === true;
    if (schemaReady) app = await buildApp();
  });

  beforeEach(async () => {
    currentSpace = SPACE;
    if (schemaReady) await cleanup();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (schemaReady) await cleanup();
    await handle.close();
  });

  function requireSchema(ctx: TestContext): boolean {
    if (!schemaReady) ctx.skip(`tenant schema ${TENANT_SCHEMA} not migrated`);
    return schemaReady;
  }

  it('lists and gets the servers of the request space only', async (ctx) => {
    if (!requireSchema(ctx)) return;

    expect((await postServer('docs')).statusCode).toBe(200);
    expect((await postServer('docs', 'Docs renamed')).statusCode).toBe(200);
    await inSpace(OTHER_SPACE, async () => {
      expect((await postServer('theirs')).statusCode).toBe(200);
    });

    const list = await app.inject({ method: 'GET', url: '/mcp/servers' });
    expect(list.statusCode).toBe(200);
    const { definitions } = JSON.parse(list.body) as {
      definitions: Array<{ serverId: string; name: string; spaceId: string }>;
    };
    expect(definitions.map((d) => [d.serverId, d.name, d.spaceId])).toEqual([
      ['docs', 'Docs renamed', SPACE],
    ]);

    expect((await app.inject({ method: 'GET', url: '/mcp/servers/docs' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/mcp/servers/theirs' })).statusCode).toBe(404);
  });

  it('keeps the flow narrowing on an update with no scope and widens it on scope: {}', async (ctx) => {
    if (!requireSchema(ctx)) return;

    expect((await postBinding({ scope: { flowId: 'flow-7' } })).statusCode).toBe(200);
    expect(await storedScope('docs-default')).toEqual({
      flowId: 'flow-7',
      tenantId: TENANT_ID,
      spaceId: SPACE,
    });

    expect((await postBinding({ name: 'Renamed' })).statusCode).toBe(200);
    expect(await storedScope('docs-default')).toEqual({
      flowId: 'flow-7',
      tenantId: TENANT_ID,
      spaceId: SPACE,
    });

    expect((await postBinding({ scope: {} })).statusCode).toBe(200);
    expect(await storedScope('docs-default')).toEqual({ tenantId: TENANT_ID, spaceId: SPACE });
  });

  it('refuses to enable a credentialed binding with no pinned origin', async (ctx) => {
    if (!requireSchema(ctx)) return;

    const res = await postBinding({
      auth: { type: 'bearer', credentialKey: 'DOCS_TOKEN' },
      enabled: true,
    });
    expect(res.statusCode).toBe(400);
    expect((JSON.parse(res.body) as { error: string }).error).toContain('mcp.binding.test');
    expect(
      (await app.inject({ method: 'GET', url: '/mcp/bindings/docs-default' })).statusCode,
    ).toBe(404);
  });

  it('deletes a binding only from the request space', async (ctx) => {
    if (!requireSchema(ctx)) return;

    expect((await postBinding({})).statusCode).toBe(200);
    await inSpace(OTHER_SPACE, async () => {
      const res = await app.inject({ method: 'DELETE', url: '/mcp/bindings/docs-default' });
      expect(res.statusCode).toBe(404);
    });
    expect((await app.inject({ method: 'GET', url: '/mcp/bindings' })).body).toContain(
      'docs-default',
    );

    const deleted = await app.inject({ method: 'DELETE', url: '/mcp/bindings/docs-default' });
    expect(deleted.statusCode).toBe(200);
    expect(
      (await app.inject({ method: 'DELETE', url: '/mcp/bindings/docs-default' })).statusCode,
    ).toBe(404);
  });

  it("deletes a server with its bindings in the request space and leaves another space's alone", async (ctx) => {
    if (!requireSchema(ctx)) return;

    for (const space of [SPACE, OTHER_SPACE]) {
      await inSpace(space, async () => {
        expect((await postServer('docs')).statusCode).toBe(200);
        expect((await postBinding({})).statusCode).toBe(200);
      });
    }

    const res = await app.inject({ method: 'DELETE', url: '/mcp/servers/docs' });
    expect(res.statusCode).toBe(200);

    const bindings = await app.inject({ method: 'GET', url: '/mcp/bindings?serverId=docs' });
    expect((JSON.parse(bindings.body) as { bindings: unknown[] }).bindings).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/mcp/servers/docs' })).statusCode).toBe(404);

    await inSpace(OTHER_SPACE, async () => {
      expect((await app.inject({ method: 'GET', url: '/mcp/servers/docs' })).statusCode).toBe(200);
      const theirs = await app.inject({ method: 'GET', url: '/mcp/bindings?serverId=docs' });
      expect(
        (JSON.parse(theirs.body) as { bindings: Array<{ bindingId: string }> }).bindings.map(
          (b) => b.bindingId,
        ),
      ).toEqual(['docs-default']);
    });
  });
});
