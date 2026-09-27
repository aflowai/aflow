import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestContext } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { inArray } from 'drizzle-orm';
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
const SPACE = '7a110000-0000-4000-8000-0000000000f7';

const describeDb = DATABASE_URL ? describe : describe.skip;

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

interface LinkedDoc {
  id: string;
  path: string;
  docType: string;
}

interface LinksBody {
  outgoing: Array<{
    targetPath: string;
    resolved: boolean;
    occurrenceCount: number;
    context?: string;
    target?: LinkedDoc;
  }>;
  backlinks: Array<{ fromPath: string; context?: string; updatedAt: string; source?: LinkedDoc }>;
  outgoingTotal: number;
  backlinkTotal: number;
  truncated?: boolean;
}

describeDb('GET /memory/docs/:docId/links (real DB)', () => {
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

  async function putDoc(path: string, content: string): Promise<string> {
    const res = await app.inject({
      method: 'PUT',
      url: '/memory/docs',
      payload: { path, content, docType: 'markdown', mimeType: 'text/markdown', tags: [] },
    });
    expect(res.statusCode).toBe(200);
    return (JSON.parse(res.body) as { id: string }).id;
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
        .values([
          { id: SPACE, name: 'Links Route Space', slug: `links-${randomUUID().slice(0, 8)}` },
        ]);
    });
    app = await buildApp();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (schemaReady) await cleanup();
    await handle.close();
  });

  it('returns outgoing links with openable targets, ghosts, and backlinks with totals', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip(`tenant schema ${TENANT_SCHEMA} not migrated`);
      return;
    }

    const hubId = await putDoc(
      '/notes/hub.md',
      'The hub mentions [[/notes/leaf]] twice — see [[/notes/leaf]] — and [[/notes/missing]].',
    );
    await putDoc('/notes/leaf.md', 'A leaf that points back at [[/notes/hub]].');

    const res = await app.inject({ method: 'GET', url: `/memory/docs/${hubId}/links` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as LinksBody;

    expect(body.outgoingTotal).toBe(2);
    expect(body.backlinkTotal).toBe(1);
    expect(body.truncated).toBeUndefined();

    const resolvedOut = body.outgoing.find((l) => l.targetPath === '/notes/leaf.md');
    expect(resolvedOut?.resolved).toBe(true);
    expect(resolvedOut?.occurrenceCount).toBe(2);
    expect(resolvedOut?.target?.path).toBe('/notes/leaf.md');
    expect(resolvedOut?.target?.docType).toBe('markdown');
    expect(typeof resolvedOut?.context).toBe('string');

    const ghost = body.outgoing.find((l) => l.targetPath === '/notes/missing.md');
    expect(ghost?.resolved).toBe(false);
    expect(ghost?.target).toBeUndefined();

    expect(body.backlinks).toHaveLength(1);
    expect(body.backlinks[0]?.fromPath).toBe('/notes/leaf.md');
    expect(body.backlinks[0]?.source?.path).toBe('/notes/leaf.md');

    const missing = await app.inject({
      method: 'GET',
      url: `/memory/docs/00000000-0000-0000-0000-000000000000/links`,
    });
    expect(missing.statusCode).toBe(404);
  });
});
