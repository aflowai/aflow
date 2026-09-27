import { randomBytes, randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestContext } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { inArray, sql as drizzleSql } from 'drizzle-orm';
import {
  createDatabase,
  createTenantContext,
  withTenantSchema,
  createMemoryDocRepository,
  createMemoryDirRepository,
  memoryDocs,
  memoryDirs,
  memoryLinks,
  spaces,
} from '@aflow/database';
import { createMemoryPayloadStore } from '@aflow/payload-store';
import { writeMemoryDoc } from '@aflow/memory-store';
import type { SessionId, StepExecutionId, TenantId } from '@aflow/schemas';
import { memoryRoutes } from './memory.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;
/**
 * This suite's namespace, and inside it one space of this execution's own. The
 * namespace is what a later run sweeps an aborted one by; the random tail is
 * what keeps two concurrent runs — two worktrees, a re-run started before the
 * last finished — out of each other's rows.
 */
const SPACE_NAMESPACE = '2840000c-0000-4000-8000-';
const SPACE = `${SPACE_NAMESPACE}${randomBytes(6).toString('hex')}`;
const RUN_ID = randomUUID();

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

/** A tiny but real PNG — the point is that these bytes are not valid UTF-8 or JSON. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

interface DocBody {
  stat: { docType: string; mimeType: string; sizeBytes: number };
  data?: string;
  dataJson?: unknown;
  truncated?: boolean;
}

const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('GET /memory/docs/:docId for a binary document (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const sql = handle.sql;
  const tenantCtx = createTenantContext(TENANT_ID as TenantId);
  const docRepo = createMemoryDocRepository(db, tenantCtx);
  const dirRepo = createMemoryDirRepository(db, tenantCtx);
  const payloadStore = createMemoryPayloadStore();

  let schemaReady = false;
  let app: FastifyInstance;

  async function writeDoc(
    path: string,
    content: { kind: 'text'; text: string } | { kind: 'binary'; bytes: Buffer },
    docType: string,
    mimeType: string,
  ): Promise<string> {
    const { doc } = await writeMemoryDoc({
      repo: docRepo,
      dirRepo,
      payloadStore,
      log: silentLog,
      tenantId: TENANT_ID as TenantId,
      origin: {
        kind: 'run',
        runId: RUN_ID as SessionId,
        stepExecutionId: randomUUID() as StepExecutionId,
      },
      spaceId: SPACE,
      path,
      content,
      docType,
      mimeType,
    });
    return doc.id;
  }

  async function buildApp(): Promise<FastifyInstance> {
    const instance = Fastify({ logger: false });
    instance.setValidatorCompiler(validatorCompiler);
    instance.setSerializerCompiler(serializerCompiler);
    (instance as unknown as { appContext: unknown }).appContext = { db, payloadStore };
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

  /** The space is this execution's alone, so it is the whole handle. */
  async function cleanup(): Promise<void> {
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.delete(memoryLinks).where(inArray(memoryLinks.spaceId, [SPACE]));
      await tx.delete(memoryDocs).where(inArray(memoryDocs.spaceId, [SPACE]));
      await tx.delete(memoryDirs).where(inArray(memoryDirs.spaceId, [SPACE]));
      await tx.delete(spaces).where(inArray(spaces.id, [SPACE]));
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

  beforeAll(async () => {
    const rows = await sql<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = ${TENANT_SCHEMA} AND table_name = 'memory_links'
      ) AS ok`;
    schemaReady = rows[0]?.ok === true;
    if (!schemaReady) return;
    await sweepAbandonedRows();
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx
        .insert(spaces)
        .values([
          { id: SPACE, name: 'Binary Route', slug: `binary-route-${randomUUID().slice(0, 8)}` },
        ]);
    });
    app = await buildApp();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (schemaReady) await cleanup();
    await handle.close();
  });

  function guard(ctx: TestContext): boolean {
    if (!schemaReady) {
      ctx.skip(`tenant schema ${TENANT_SCHEMA} not migrated — run \`yarn db:migrate\``);
      return false;
    }
    return true;
  }

  it('returns binary content as base64 the viewer can put in a data: URI', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    const docId = await writeDoc(
      '/assets/pixel.png',
      { kind: 'binary', bytes: PNG_BYTES },
      'image',
      'image/png',
    );

    const res = await app.inject({
      method: 'GET',
      url: `/memory/docs/${docId}?view=content&maxBytes=10485760`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as DocBody;

    expect(body.stat.mimeType).toBe('image/png');
    expect(body.truncated).toBeUndefined();
    expect(body.dataJson).toBeUndefined();
    expect(typeof body.data).toBe('string');
    expect(Buffer.from(body.data ?? '', 'base64').equals(PNG_BYTES)).toBe(true);
  });

  it('refuses to hand back a fragment of a media file that exceeds the budget', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    const docId = await writeDoc(
      '/assets/clip.mp4',
      { kind: 'binary', bytes: PNG_BYTES },
      'video',
      'video/mp4',
    );

    const res = await app.inject({
      method: 'GET',
      url: `/memory/docs/${docId}?view=content&maxBytes=${String(PNG_BYTES.length - 1)}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as DocBody;
    expect(body.truncated).toBe(true);
    expect(body.data).toBeUndefined();
  });

  it('keeps text documents on the JSON lane, inline and offloaded alike', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    const small = 'a short note';
    const smallId = await writeDoc(
      '/text/small.md',
      { kind: 'text', text: small },
      'markdown',
      'text/markdown',
    );
    const inline = await app.inject({ method: 'GET', url: `/memory/docs/${smallId}?view=content` });
    expect(inline.statusCode).toBe(200);
    expect((JSON.parse(inline.body) as DocBody).data).toBe(small);

    const large = 'x'.repeat(70_000);
    const largeId = await writeDoc(
      '/text/large.md',
      { kind: 'text', text: large },
      'markdown',
      'text/markdown',
    );
    const offloaded = await app.inject({
      method: 'GET',
      url: `/memory/docs/${largeId}?view=content`,
    });
    expect(offloaded.statusCode).toBe(200);
    expect((JSON.parse(offloaded.body) as DocBody).data).toBe(large);
  });
});
