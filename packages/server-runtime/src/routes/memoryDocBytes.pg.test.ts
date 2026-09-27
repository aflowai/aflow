import { randomBytes, randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestContext } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { inArray, sql as drizzleSql } from 'drizzle-orm';
import {
  createDatabase,
  createTenantContext,
  createMemoryDocRepository,
  createMemoryDirRepository,
  withTenantSchema,
  memoryDocs,
  memoryDirs,
  memoryLinks,
  spaces,
} from '@aflow/database';
import { createMemoryPayloadStore } from '@aflow/payload-store';
import { writeMemoryDoc } from '@aflow/memory-store';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { SessionId, StepExecutionId, TenantId } from '@aflow/schemas';
import { memoryRoutes } from './memory.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;
/**
 * This suite's namespace, and inside it two spaces of this execution's own. The
 * namespace is what a later run sweeps an aborted one by; the random tail is
 * what keeps two concurrent runs — two worktrees, a re-run started before the
 * last finished — out of each other's rows.
 */
const SPACE_NAMESPACE = '7a110000-0000-4000-8000-';
const SPACE = `${SPACE_NAMESPACE}${randomBytes(6).toString('hex')}`;
const OTHER_SPACE = `${SPACE_NAMESPACE}${randomBytes(6).toString('hex')}`;

const CLIP_BYTES = Buffer.from(Array.from({ length: 1024 }, (_, i) => (i * 7) % 251));

const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('GET /v1/memory/docs/:docId/bytes — byte serving (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const sql = handle.sql;
  const tenantCtx = createTenantContext(TENANT_ID as TenantId);
  const payloadStore = createMemoryPayloadStore();

  let schemaReady = false;
  let app: FastifyInstance;
  let otherSpaceApp: FastifyInstance;
  let anonymousApp: FastifyInstance;
  let clipId = '';
  let noteId = '';

  /** Both spaces are this execution's alone, so they are the whole handle. */
  async function cleanup(): Promise<void> {
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.delete(memoryLinks).where(inArray(memoryLinks.spaceId, [SPACE, OTHER_SPACE]));
      await tx.delete(memoryDocs).where(inArray(memoryDocs.spaceId, [SPACE, OTHER_SPACE]));
      await tx.delete(memoryDirs).where(inArray(memoryDirs.spaceId, [SPACE, OTHER_SPACE]));
      await tx.delete(spaces).where(inArray(spaces.id, [SPACE, OTHER_SPACE]));
    });
  }

  /**
   * What earlier executions of this suite left behind. Only rows old enough
   * that no live execution could still be writing them — an execution running
   * right now in another checkout is not this one's to clean up.
   */
  async function sweepAbandonedRows(): Promise<void> {
    const stale = `${SPACE_NAMESPACE}%`;
    const aged = drizzleSql`created_at < now() - interval '1 hour'`;
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.execute(
        drizzleSql`DELETE FROM memory_links WHERE space_id::text LIKE ${stale} AND ${aged}`,
      );
      await tx.execute(
        drizzleSql`DELETE FROM memory_docs WHERE space_id::text LIKE ${stale} AND ${aged}`,
      );
      await tx.execute(
        drizzleSql`DELETE FROM memory_dirs WHERE space_id::text LIKE ${stale} AND ${aged}`,
      );
      await tx.execute(drizzleSql`DELETE FROM spaces WHERE id::text LIKE ${stale} AND ${aged}`);
    });
  }

  async function buildApp(options: {
    spaceId: string;
    authenticated: boolean;
  }): Promise<FastifyInstance> {
    const instance = Fastify({ logger: false });
    instance.setValidatorCompiler(validatorCompiler);
    instance.setSerializerCompiler(serializerCompiler);
    (instance as unknown as { appContext: unknown }).appContext = { db, payloadStore };

    const stubAuthenticate = async (
      request: FastifyRequest,
      reply: FastifyReply,
    ): Promise<void> => {
      if (!options.authenticated) {
        await reply.status(401).send({ error: 'UNAUTHORIZED', message: 'Authentication required' });
        return;
      }
      (request as unknown as { authUser: { userId: string } }).authUser = { userId: 'user-1' };
    };
    instance.decorate('authenticate', stubAuthenticate);
    instance.addHook('onRequest', async (request) => {
      (
        request as unknown as { requireTenant: () => Promise<{ tenantId: TenantId }> }
      ).requireTenant = async () => ({ tenantId: TENANT_ID as TenantId });
      (request as unknown as { requireSpace: () => Promise<{ spaceId: string }> }).requireSpace =
        async () => ({ spaceId: options.spaceId });
    });
    await instance.register(memoryRoutes, { prefix: '/memory' });
    await instance.ready();
    return instance;
  }

  async function seedDoc(params: {
    path: string;
    docType: string;
    mimeType: string;
    content: { kind: 'text'; text: string } | { kind: 'binary'; bytes: Buffer };
  }): Promise<string> {
    const repo = createMemoryDocRepository(db as PostgresJsDatabase, tenantCtx);
    const dirRepo = createMemoryDirRepository(db as PostgresJsDatabase, tenantCtx);
    const result = await writeMemoryDoc({
      repo,
      dirRepo,
      payloadStore,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      tenantId: TENANT_ID as TenantId,
      origin: {
        kind: 'run',
        runId: randomUUID() as SessionId,
        stepExecutionId: randomUUID() as StepExecutionId,
      },
      spaceId: SPACE,
      path: params.path,
      content: params.content,
      docType: params.docType,
      mimeType: params.mimeType,
    });
    return result.doc.id;
  }

  beforeAll(async () => {
    const rows = await sql<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = ${TENANT_SCHEMA} AND table_name = 'memory_docs'
      ) AS ok`;
    schemaReady = rows[0]?.ok === true;
    if (!schemaReady) return;
    await sweepAbandonedRows();
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.insert(spaces).values([
        { id: SPACE, name: 'Bytes Space', slug: `bytes-${randomUUID().slice(0, 8)}` },
        { id: OTHER_SPACE, name: 'Other Space', slug: `other-${randomUUID().slice(0, 8)}` },
      ]);
    });
    clipId = await seedDoc({
      path: '/assets/clip.mp4',
      docType: 'video',
      mimeType: 'video/mp4',
      content: { kind: 'binary', bytes: CLIP_BYTES },
    });
    noteId = await seedDoc({
      path: '/assets/notes.md',
      docType: 'markdown',
      mimeType: 'text/markdown',
      content: { kind: 'text', text: 'shot list' },
    });
    app = await buildApp({ spaceId: SPACE, authenticated: true });
    otherSpaceApp = await buildApp({ spaceId: OTHER_SPACE, authenticated: true });
    anonymousApp = await buildApp({ spaceId: SPACE, authenticated: false });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (otherSpaceApp) await otherSpaceApp.close();
    if (anonymousApp) await anonymousApp.close();
    if (schemaReady) await cleanup();
    await handle.close();
  });

  it('serves the whole document with Accept-Ranges and Content-Length', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip(`tenant schema ${TENANT_SCHEMA} not migrated`);
      return;
    }
    const res = await app.inject({ method: 'GET', url: `/memory/docs/${clipId}/bytes` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(res.headers['content-length']).toBe(String(CLIP_BYTES.length));
    expect(res.headers['content-range']).toBeUndefined();
    expect(res.rawPayload.equals(CLIP_BYTES)).toBe(true);
  });

  it('answers a Range request with 206 and the exact slice', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip(`tenant schema ${TENANT_SCHEMA} not migrated`);
      return;
    }
    const res = await app.inject({
      method: 'GET',
      url: `/memory/docs/${clipId}/bytes`,
      headers: { range: 'bytes=100-199' },
    });

    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 100-199/1024');
    expect(res.headers['content-length']).toBe('100');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.rawPayload.equals(CLIP_BYTES.subarray(100, 200))).toBe(true);
  });

  it('clamps an open-ended range to the last byte', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip(`tenant schema ${TENANT_SCHEMA} not migrated`);
      return;
    }
    const res = await app.inject({
      method: 'GET',
      url: `/memory/docs/${clipId}/bytes`,
      headers: { range: 'bytes=1000-' },
    });

    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 1000-1023/1024');
    expect(res.rawPayload.equals(CLIP_BYTES.subarray(1000))).toBe(true);
  });

  it('ignores a range whose If-Range names a version the document no longer has', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip(`tenant schema ${TENANT_SCHEMA} not migrated`);
      return;
    }
    const res = await app.inject({
      method: 'GET',
      url: `/memory/docs/${clipId}/bytes`,
      headers: { range: 'bytes=100-199', 'if-range': '"a-hash-from-an-older-version"' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-range']).toBeUndefined();
    expect(res.rawPayload.equals(CLIP_BYTES)).toBe(true);
  });

  it('refuses a range past the end with 416 and the document size', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip(`tenant schema ${TENANT_SCHEMA} not migrated`);
      return;
    }
    const res = await app.inject({
      method: 'GET',
      url: `/memory/docs/${clipId}/bytes`,
      headers: { range: 'bytes=4096-8192' },
    });

    expect(res.statusCode).toBe(416);
    expect(res.headers['content-range']).toBe('bytes */1024');
    expect(res.json()).toMatchObject({ error: 'RANGE_NOT_SATISFIABLE' });
  });

  it('refuses a text document and points at the read route', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip(`tenant schema ${TENANT_SCHEMA} not migrated`);
      return;
    }
    const res = await app.inject({ method: 'GET', url: `/memory/docs/${noteId}/bytes` });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'NOT_BINARY' });
    expect((res.json() as { message: string }).message).toContain('view=content');
  });

  // The docType and the write lane disagree in both directions, so servability
  // has to be decided by the lane. `api.http.download` and the sandbox flush
  // both label media `binary`, which no docType allowlist contains.
  it('serves a downloaded document whose docType is "binary"', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip(`tenant schema ${TENANT_SCHEMA} not migrated`);
      return;
    }
    const downloadId = await seedDoc({
      path: '/assets/downloaded.png',
      docType: 'binary',
      mimeType: 'image/png',
      content: { kind: 'binary', bytes: CLIP_BYTES },
    });

    const res = await app.inject({ method: 'GET', url: `/memory/docs/${downloadId}/bytes` });

    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(CLIP_BYTES)).toBe(true);
  });

  it('refuses an image-typed document whose body is text on the JSON lane', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip(`tenant schema ${TENANT_SCHEMA} not migrated`);
      return;
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">${'<rect/>'.repeat(12_000)}</svg>`;
    const svgId = await seedDoc({
      path: '/assets/diagram.svg',
      docType: 'image',
      mimeType: 'image/svg+xml',
      content: { kind: 'text', text: svg },
    });

    // Refused before the content type is on the reply — the alternative is a
    // stream that throws after the headers have already gone out.
    const res = await app.inject({ method: 'GET', url: `/memory/docs/${svgId}/bytes` });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'NOT_BINARY' });

    const readable = await app.inject({
      method: 'GET',
      url: `/memory/docs/${svgId}?view=content&maxBytes=200000`,
    });
    expect(readable.statusCode).toBe(200);
    expect((readable.json() as { data: string }).data).toBe(svg);
  });

  it('serves nothing to an unauthenticated caller', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip(`tenant schema ${TENANT_SCHEMA} not migrated`);
      return;
    }
    const res = await anonymousApp.inject({
      method: 'GET',
      url: `/memory/docs/${clipId}/bytes`,
      headers: { range: 'bytes=0-9' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.rawPayload.includes(CLIP_BYTES.subarray(0, 10))).toBe(false);
  });

  it('hides the document from a caller scoped to another space', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip(`tenant schema ${TENANT_SCHEMA} not migrated`);
      return;
    }
    const res = await otherSpaceApp.inject({
      method: 'GET',
      url: `/memory/docs/${clipId}/bytes`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'NOT_FOUND' });
  });
});
