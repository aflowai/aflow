import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestContext } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { inArray, eq, and } from 'drizzle-orm';
import {
  createDatabase,
  createTenantContext,
  withTenantSchema,
  memoryDocs,
  memoryDirs,
  memoryLinks,
  spaces,
} from '@aflow/database';
import type { PayloadStore } from '@aflow/payload-store';
import type { TenantId } from '@aflow/schemas';
import { memoryRoutes } from './memory.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;
const SPACE = '7a110000-0000-4000-8000-0000000000f1';

const describeDb = DATABASE_URL ? describe : describe.skip;

/** Inline-only payload store — small content never offloads. */
function inlinePayloadStore(): PayloadStore {
  const unreachable = () => {
    throw new Error('payload store should not be reached for inline content');
  };
  return {
    store: unreachable,
    storeBytes: unreachable,
    retrieve: unreachable,
    retrieveBytes: unreachable,
    exists: unreachable,
    shouldStoreBytes: () => false,
  } as unknown as PayloadStore;
}

describeDb('Plan 249 P1c — REST /index.md update requires expectedHash (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const sql = handle.sql;
  const tenantCtx = createTenantContext(TENANT_ID as TenantId);

  let schemaReady = false;
  let app: FastifyInstance;

  async function cleanup(): Promise<void> {
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.delete(memoryLinks).where(inArray(memoryLinks.spaceId, [SPACE]));
      await tx.delete(memoryDocs).where(inArray(memoryDocs.spaceId, [SPACE]));
      await tx.delete(memoryDirs).where(inArray(memoryDirs.spaceId, [SPACE]));
      await tx.delete(spaces).where(inArray(spaces.id, [SPACE]));
    });
  }

  async function buildApp(): Promise<FastifyInstance> {
    const instance = Fastify({ logger: false });
    instance.setValidatorCompiler(validatorCompiler);
    instance.setSerializerCompiler(serializerCompiler);
    (instance as unknown as { appContext: unknown }).appContext = {
      db,
      payloadStore: inlinePayloadStore(),
    };
    const stubAuthenticate = async (request: FastifyRequest): Promise<void> => {
      (request as unknown as { authUser: { userId: string } }).authUser = { userId: 'user-1' };
    };
    instance.decorate('authenticate', stubAuthenticate);
    instance.addHook('preHandler', stubAuthenticate);
    instance.addHook('onRequest', async (request) => {
      (
        request as unknown as { requireTenant: () => Promise<{ tenantId: TenantId }> }
      ).requireTenant = async () => ({ tenantId: TENANT_ID as TenantId });
      (request as unknown as { requireSpace: () => Promise<{ spaceId: string }> }).requireSpace =
        async () => ({ spaceId: SPACE });
    });
    await instance.register(memoryRoutes, { prefix: '/memory' });
    await instance.ready();
    return instance;
  }

  function putDoc(body: Record<string, unknown>) {
    return app.inject({
      method: 'PUT',
      url: '/memory/docs',
      payload: { docType: 'markdown', mimeType: 'text/markdown', tags: [], ...body },
    });
  }

  beforeAll(async () => {
    const rows = await sql<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = ${TENANT_SCHEMA} AND table_name = 'memory_links'
      ) AS ok`;
    schemaReady = rows[0]?.ok === true;
    if (!schemaReady) return;
    await cleanup();
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx
        .insert(spaces)
        .values([{ id: SPACE, name: 'REST Hash Space', slug: `rest-${randomUUID().slice(0, 8)}` }]);
    });
    app = await buildApp();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (schemaReady) await cleanup();
    await handle.close();
  });

  it('first /index.md create needs no hash (200); update without expectedHash → 400 MEMORY_HASH_REQUIRED; wrong hash → 409; correct hash → 200', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip(`tenant schema ${TENANT_SCHEMA} not migrated`);
      return;
    }
    // Create — no hash needed.
    const created = await putDoc({ path: '/index.md', content: '- [[/first.md]] first note' });
    expect(created.statusCode).toBe(200);

    // Update WITHOUT expectedHash → teaching 400 (previously a generic 500).
    const missing = await putDoc({ path: '/index.md', content: '- [[/second.md]] second note' });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: 'MEMORY_HASH_REQUIRED' });
    expect((missing.json() as { message: string }).message).toContain('MEMORY_HASH_REQUIRED');

    // Update with a WRONG expectedHash → 409 MEMORY_HASH_MISMATCH.
    const wrong = await putDoc({
      path: '/index.md',
      content: '- [[/second.md]] second note',
      expectedHash: 'deadbeef',
    });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json()).toMatchObject({ error: 'MEMORY_HASH_MISMATCH' });

    // Read the current hash from the row, then update WITH the correct hash → 200.
    const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
      tx
        .select({ contentHash: memoryDocs.contentHash })
        .from(memoryDocs)
        .where(and(eq(memoryDocs.spaceId, SPACE), eq(memoryDocs.path, '/index.md'))),
    );
    const currentHash = rows[0]?.contentHash;
    expect(typeof currentHash).toBe('string');

    const ok = await putDoc({
      path: '/index.md',
      content: '- [[/second.md]] second note',
      expectedHash: currentHash ?? '',
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { version: number }).version).toBe(2);
  });
});
