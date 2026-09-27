import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestContext } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type { TenantId } from '@aflow/schemas';
import { createDatabase } from '../connection.js';
import { createTenantContext } from '../tenant/context.js';
import { withTenantSchema } from '../tenant/queries.js';
import { memoryDocs, memoryDirs, spaces } from '../schema/tenant.js';
import { createMemoryDocRepository, type MemoryDocPutParams } from './memoryDocs.js';
import { createMemoryDirRepository } from './memoryDirs.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;
const SPACE_A = '19010000-0000-4000-8000-000000000001';
const SPACE_B = '19010000-0000-4000-8000-000000000002';

const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('Plan 249 P1a — memory space isolation (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const sql = handle.sql;
  const tenantCtx = createTenantContext(TENANT_ID as TenantId);
  const docRepo = createMemoryDocRepository(db, tenantCtx);
  const dirRepo = createMemoryDirRepository(db, tenantCtx);

  let schemaReady = false;

  async function putDoc(
    path: string,
    spaceId: string,
    content: string,
    extra?: Partial<MemoryDocPutParams>,
  ): Promise<string> {
    await dirRepo.ensureParentDirs(path, { spaceId });
    const doc = await docRepo.put({
      path,
      writeMode: 'upsert',
      docType: 'text',
      mimeType: 'text/plain',
      inlineContent: content,
      payloadRef: null,
      sizeBytes: Buffer.byteLength(content, 'utf8'),
      contentHash: '',
      preview: content.substring(0, 200),
      tags: ['isolation-test'],
      summary: null,
      indexing: 'disabled',
      scope: { spaceId },
      provenance: { actor: 'system:memory-space-isolation-test' },
      ...extra,
    });
    return doc.id;
  }

  async function cleanup(): Promise<void> {
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.delete(memoryDocs).where(inArray(memoryDocs.spaceId, [SPACE_A, SPACE_B]));
      await tx.delete(memoryDirs).where(inArray(memoryDirs.spaceId, [SPACE_A, SPACE_B]));
      await tx.delete(spaces).where(inArray(spaces.id, [SPACE_A, SPACE_B]));
    });
  }

  beforeAll(async () => {
    const rows = await sql<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = ${TENANT_SCHEMA} AND table_name = 'memory_docs'
      ) AS ok`;
    schemaReady = rows[0]?.ok === true;
    if (!schemaReady) return;
    await cleanup();
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.insert(spaces).values([
        { id: SPACE_A, name: 'Isolation Space A', slug: `iso-a-${randomUUID().slice(0, 8)}` },
        { id: SPACE_B, name: 'Isolation Space B', slug: `iso-b-${randomUUID().slice(0, 8)}` },
      ]);
    });
  });

  afterAll(async () => {
    if (schemaReady) await cleanup();
    await handle.close();
  });

  it('getById does not cross the space boundary', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip(`tenant schema ${TENANT_SCHEMA} not migrated — run \`yarn db:migrate\``);
      return;
    }
    const idA = await putDoc('/shared/note.txt', SPACE_A, 'A content');
    const idB = await putDoc('/shared/note.txt', SPACE_B, 'B content');
    expect(idA).not.toBe(idB);

    // Same-space reads resolve; cross-space id reads return null AT THE QUERY.
    expect((await docRepo.getById(idA, SPACE_A))?.inlineContent).toBe('A content');
    expect(await docRepo.getById(idA, SPACE_B)).toBeNull();
    expect(await docRepo.getById(idB, SPACE_A)).toBeNull();
  });

  it('getByPath is scoped to its space', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip('schema not migrated');
      return;
    }
    expect((await docRepo.getByPath('/shared/note.txt', SPACE_A))?.inlineContent).toBe('A content');
    expect((await docRepo.getByPath('/shared/note.txt', SPACE_B))?.inlineContent).toBe('B content');
  });

  it('recursive deleteDir only affects the caller space (THE bug)', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip('schema not migrated');
      return;
    }
    // Populate /shared/** in both spaces.
    await putDoc('/shared/a/deep.txt', SPACE_A, 'A deep');
    await putDoc('/shared/b/deep.txt', SPACE_A, 'A deep 2');
    await putDoc('/shared/a/deep.txt', SPACE_B, 'B deep');
    await putDoc('/shared/b/deep.txt', SPACE_B, 'B deep 2');

    const deleted = await dirRepo.deleteDir('/shared', SPACE_A, true);
    expect(deleted).toBe(true);

    // Space A: everything under /shared is gone.
    expect(await docRepo.getByPath('/shared/note.txt', SPACE_A)).toBeNull();
    expect(await docRepo.getByPath('/shared/a/deep.txt', SPACE_A)).toBeNull();
    expect(await dirRepo.getDir('/shared', SPACE_A)).toBeNull();
    expect(await dirRepo.getDir('/shared/a', SPACE_A)).toBeNull();

    // Space B: everything under /shared survives — the path-prefix-only delete
    // must NOT reach across the space boundary.
    expect((await docRepo.getByPath('/shared/note.txt', SPACE_B))?.inlineContent).toBe('B content');
    expect((await docRepo.getByPath('/shared/a/deep.txt', SPACE_B))?.inlineContent).toBe('B deep');
    expect(await dirRepo.getDir('/shared', SPACE_B)).not.toBeNull();
    expect(await dirRepo.getDir('/shared/a', SPACE_B)).not.toBeNull();
  });

  it('softDelete / hardDelete are no-ops across spaces', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip('schema not migrated');
      return;
    }
    const idB = await putDoc('/isolated/only-b.txt', SPACE_B, 'B only');

    // Space A cannot soft-delete or hard-delete a Space B doc.
    expect(await docRepo.softDelete(idB, SPACE_A)).toBe(false);
    expect(await docRepo.hardDelete(idB, SPACE_A)).toBe(false);
    // The doc is untouched.
    expect((await docRepo.getById(idB, SPACE_B))?.inlineContent).toBe('B only');

    // The rightful owner can.
    expect(await docRepo.softDelete(idB, SPACE_B)).toBe(true);
    expect(await docRepo.getById(idB, SPACE_B)).toBeNull();
    expect(await docRepo.hardDelete(idB, SPACE_B)).toBe(true);
  });

  it('restore is a no-op across spaces', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip('schema not migrated');
      return;
    }
    const idB = await putDoc('/restorable/only-b.txt', SPACE_B, 'B restorable');
    expect(await docRepo.softDelete(idB, SPACE_B)).toBe(true);

    // Space A cannot restore a Space B soft-deleted doc.
    expect(await docRepo.restore(idB, SPACE_A)).toBe(false);
    expect(await docRepo.getById(idB, SPACE_B, { includeDeleted: true })).not.toBeNull();
    expect(
      (await docRepo.getById(idB, SPACE_B, { includeDeleted: true }))?.deletedAt,
    ).not.toBeNull();

    // The rightful owner can.
    expect(await docRepo.restore(idB, SPACE_B)).toBe(true);
    expect((await docRepo.getById(idB, SPACE_B))?.inlineContent).toBe('B restorable');
  });

  it('list / grep / listDeleted never return another space rows', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip('schema not migrated');
      return;
    }
    const uniq = `needle-${randomUUID().slice(0, 8)}`;
    await putDoc('/find/hit.txt', SPACE_A, `A ${uniq} body`);
    await putDoc('/find/hit.txt', SPACE_B, `B ${uniq} body`);

    const listA = await docRepo.list({ pathPrefix: '/find', scope: { spaceId: SPACE_A } });
    expect(listA.every((r) => r.spaceId === SPACE_A)).toBe(true);
    expect(listA.some((r) => r.path === '/find/hit.txt')).toBe(true);

    const grepA = await docRepo.grep({
      pathPrefix: '/find',
      scope: { spaceId: SPACE_A },
      query: uniq,
    });
    expect(grepA.every((r) => r.spaceId === SPACE_A)).toBe(true);
    expect(grepA.length).toBeGreaterThan(0);

    // Soft-delete the A doc, confirm listDeleted is space-scoped.
    const aDoc = await docRepo.getByPath('/find/hit.txt', SPACE_A);
    expect(aDoc).not.toBeNull();
    await docRepo.softDelete(aDoc!.id, SPACE_A);
    const deletedB = await docRepo.listDeleted({ spaceId: SPACE_B });
    expect(deletedB.some((r) => r.id === aDoc!.id)).toBe(false);
    const deletedA = await docRepo.listDeleted({ spaceId: SPACE_A });
    expect(deletedA.some((r) => r.id === aDoc!.id)).toBe(true);
  });
});
