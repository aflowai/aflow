import { createHash, randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestContext } from 'vitest';
import { inArray, eq, and, sql as drizzleSql } from 'drizzle-orm';
import {
  createDatabase,
  createTenantContext,
  withTenantSchema,
  createMemoryDocRepository,
  memoryDocs,
  memoryDirs,
  memoryLinks,
  spaces,
  type MemoryDocRepository,
  type MemoryDerivation,
} from '@aflow/database';
import type { TenantId } from '@aflow/schemas';
import { buildSpaceContext } from './spaceContext.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;
const SPACE = '6ec00000-0000-4000-8000-0000000000e1';

const describeDb = DATABASE_URL ? describe : describe.skip;

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

describeDb('Plan 249 P5 — index-note resolve excludes expired docs (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const sql = handle.sql;
  const tenantCtx = createTenantContext(TENANT_ID as TenantId);
  const docRepo: MemoryDocRepository = createMemoryDocRepository(db, tenantCtx);

  let schemaReady = false;

  async function putPlain(path: string, content: string): Promise<string> {
    const doc = await docRepo.put({
      path,
      docType: 'markdown',
      mimeType: 'text/markdown',
      inlineContent: content,
      payloadRef: null,
      sizeBytes: Buffer.byteLength(content, 'utf8'),
      contentHash: sha256(content),
      preview: content.slice(0, 240),
      tags: [],
      summary: null,
      indexing: 'disabled',
      scope: { spaceId: SPACE },
    });
    return doc.id;
  }

  async function cleanup(): Promise<void> {
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.delete(memoryLinks).where(inArray(memoryLinks.spaceId, [SPACE]));
      await tx.delete(memoryDocs).where(inArray(memoryDocs.spaceId, [SPACE]));
      await tx.delete(memoryDirs).where(inArray(memoryDirs.spaceId, [SPACE]));
      await tx.delete(spaces).where(inArray(spaces.id, [SPACE]));
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
        .values([{ id: SPACE, name: 'Expiry Space', slug: `exp-${randomUUID().slice(0, 8)}` }]);
    });
  });

  afterAll(async () => {
    if (schemaReady) await cleanup();
    await handle.close();
  });

  it('an expired doc at a linked path resolves as NOT resolved (ghost)', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip(`tenant schema ${TENANT_SCHEMA} not migrated`);
      return;
    }
    // A live target and an expired target, both listed in /index.md's projection.
    await putPlain('/e/live.md', 'I am live.');
    const expiredId = await putPlain('/e/expired.md', 'I am expiring.');

    // Push /e/expired.md into the past — same predicate the link graph uses.
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx
        .update(memoryDocs)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(and(eq(memoryDocs.spaceId, SPACE), eq(memoryDocs.id, expiredId)));
    });

    // Persist /index.md carrying a projection that references both.
    const indexId = await putPlain(
      '/index.md',
      '- [[/e/live.md]] live\n- [[/e/expired.md]] expired',
    );
    const derivation: MemoryDerivation = {
      schemaVersion: 1,
      sourceHash: sha256('index'),
      indexEntries: [
        { path: '/e/live.md', hook: '- live' },
        { path: '/e/expired.md', hook: '- expired' },
      ],
    };
    await docRepo.updateDerivedFields(indexId, SPACE, { properties: {}, derivation });

    const context = await buildSpaceContext(db, TENANT_ID, SPACE);
    const entries = context?.memories?.indexNote?.entries ?? [];
    const byPath = new Map(entries.map((e) => [e.path, e.resolved]));

    // The live target resolves; the expired one is a ghost — matching graph reads.
    expect(byPath.get('/e/live.md')).toBe(true);
    expect(byPath.get('/e/expired.md')).toBe(false);
  });

  it('a soft-deleted doc at a linked path also resolves as a ghost (regression guard)', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip('schema not migrated');
      return;
    }
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.execute(drizzleSql`
        DELETE FROM memory_docs WHERE space_id = ${SPACE} AND path IN ('/index.md', '/d/gone.md')
      `);
    });
    const goneId = await putPlain('/d/gone.md', 'about to be deleted');
    expect(await docRepo.softDelete(goneId, SPACE)).toBe(true);

    const indexId = await putPlain('/index.md', '- [[/d/gone.md]] gone');
    await docRepo.updateDerivedFields(indexId, SPACE, {
      properties: {},
      derivation: {
        schemaVersion: 1,
        sourceHash: sha256('index2'),
        indexEntries: [{ path: '/d/gone.md', hook: '- gone' }],
      },
    });

    const context = await buildSpaceContext(db, TENANT_ID, SPACE);
    const entries = context?.memories?.indexNote?.entries ?? [];
    expect(entries.find((e) => e.path === '/d/gone.md')?.resolved).toBe(false);
  });
});
