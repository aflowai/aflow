/**
 * What a soft-deleted document still is, as far as a guarded write is concerned.
 *
 * A soft-deleted row holds bytes the path can be revived to, so a write that
 * declared which bytes it expected to find must be answered by them — not by
 * the absence of a live row. The revival is also a creation: the version it
 * lands at says nothing about whether the caller made the path live.
 */
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { eq, sql as drizzleSql } from 'drizzle-orm';
import type { TenantId } from '@aflow/schemas';
import { createDatabase } from '../connection.js';
import { createTenantContext } from '../tenant/context.js';
import { withTenantSchema } from '../tenant/queries.js';
import { memoryDocs } from '../schema/tenant.js';
import { createMemoryDocRepository, type MemoryDocPutParams } from './memoryDocs.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;
/**
 * This suite's namespace, and inside it one space of this execution's own. The
 * namespace is what a later run sweeps an aborted one by; the random tail is
 * what keeps two concurrent runs — two worktrees, a re-run started before the
 * last finished — out of each other's rows.
 */
const SPACE_NAMESPACE = 'de1e7ed0-0000-4000-8000-';
const SPACE = `${SPACE_NAMESPACE}${randomBytes(6).toString('hex')}`;

const describeDb = DATABASE_URL ? describe : describe.skip;

function hashOf(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

describeDb('memory doc put — a soft-deleted row is still content (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const sql = handle.sql;
  const tenantCtx = createTenantContext(TENANT_ID as TenantId);
  const docRepo = createMemoryDocRepository(db, tenantCtx);

  let schemaReady = false;
  let tenantPresent = false;

  async function put(path: string, content: string, extra?: Partial<MemoryDocPutParams>) {
    return await docRepo.put({
      path,
      docType: 'text',
      mimeType: 'text/plain',
      inlineContent: content,
      payloadRef: null,
      sizeBytes: Buffer.byteLength(content, 'utf8'),
      contentHash: hashOf(content),
      preview: content,
      tags: [],
      summary: null,
      indexing: 'disabled',
      scope: { spaceId: SPACE },
      provenance: { actor: 'system:memory-doc-revival-test' },
      ...extra,
    });
  }

  /**
   * What earlier executions of this suite left behind. Only rows old enough
   * that no live execution could still be writing them — an execution running
   * right now in another checkout is not this one's to clean up.
   */
  async function sweepAbandonedRows(): Promise<void> {
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.execute(
        drizzleSql`DELETE FROM memory_docs WHERE space_id::text LIKE ${`${SPACE_NAMESPACE}%`}
                   AND created_at < now() - interval '1 hour'`,
      );
    });
  }

  beforeAll(async () => {
    const rows = await sql<{ tenant: boolean; table: boolean }[]>`
      SELECT
        EXISTS (
          SELECT 1 FROM information_schema.schemata WHERE schema_name = ${TENANT_SCHEMA}
        ) AS tenant,
        EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = ${TENANT_SCHEMA} AND table_name = 'memory_docs'
        ) AS "table"`;
    tenantPresent = rows[0]?.tenant === true;
    schemaReady = rows[0]?.table === true;
    if (schemaReady) await sweepAbandonedRows();
  });

  // A tenant that was never created is CI, which seeds no dev schema and where a
  // database-backed suite has nothing to say. A tenant that exists without the
  // table is a checkout that has not migrated, which is worth failing on.
  beforeEach((ctx) => {
    if (!tenantPresent) {
      ctx.skip();
      return;
    }
    if (!schemaReady) throw new Error('memory_docs is missing — run yarn db:migrate');
  });

  /** The space is this execution's alone, so it is the whole handle. */
  afterAll(async () => {
    try {
      if (schemaReady) {
        await withTenantSchema(db, tenantCtx, async (tx) => {
          await tx.delete(memoryDocs).where(eq(memoryDocs.spaceId, SPACE));
        });
      }
    } finally {
      await handle.close();
    }
  });

  it('refuses a guarded write whose expected content is the one the deleted row holds', async () => {
    const path = `/notes/revival-${randomUUID()}.txt`;
    const first = await put(path, 'the bytes that are there');
    expect(first.created).toBe(true);
    expect(await docRepo.softDelete(first.id, SPACE)).toBe(true);

    await expect(
      put(path, 'bytes from somewhere else', { expectedHash: hashOf('a body never written here') }),
    ).rejects.toThrow(/MEMORY_HASH_MISMATCH/);

    const held = await docRepo.getByPath(path, SPACE, { includeDeleted: true });
    expect(held?.contentHash).toBe(hashOf('the bytes that are there'));
    expect(held?.currentVersion).toBe(1);
    expect(held?.deletedAt).not.toBeNull();
  });

  it('does not hand reserved scratch to a caller holding its id', async () => {
    // The guard used to sit in one executor handler, so the REST memory routes
    // — which reach documents by id — still served another run's working
    // buffer to anyone in the space who had the id.
    const path = `/run/draft/${randomUUID()}.json`;
    const created = await put(path, JSON.stringify({ revision: 1 }));

    expect(await docRepo.getById(created.id, SPACE)).toBeNull();
    expect(await docRepo.softDelete(created.id, SPACE)).toBe(false);
    // Every path-based reader is refused by default, so a new one is safe the
    // day it is written: `put(content.fromPath)` and compute `inputPaths` both
    // reach documents this way and neither knew about drafts.
    expect(await docRepo.getByPath(path, SPACE)).toBeNull();
    // The store that owns the prefix asks for it explicitly.
    expect(await docRepo.getByPath(path, SPACE, { allowReserved: true })).not.toBeNull();
  });

  it('refuses a guarded write whose row has been hard-deleted, rather than recreating it', async () => {
    // The guard only constrained the update branch. A row removed between the
    // caller's read and this transaction fell through to the insert, which
    // recreated the document despite the stale token — a task draft deleted by
    // terminal cleanup came back, carried in by a patch already in flight.
    const path = `/notes/resurrect-${randomUUID()}.txt`;
    const first = await put(path, 'the bytes that were there');
    const stale = hashOf('the bytes that were there');

    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.delete(memoryDocs).where(eq(memoryDocs.id, first.id));
    });

    await expect(put(path, 'brought back from the dead', { expectedHash: stale })).rejects.toThrow(
      /MEMORY_HASH_MISMATCH/,
    );
    expect(await docRepo.getByPath(path, SPACE, { includeDeleted: true })).toBeNull();
  });

  it('lets exactly one of two writers holding the same hash through', async () => {
    // What this pins is the observable contract: two writers that both read the
    // same hash do not both land, and the row ends up holding one writer's bytes
    // whole.
    //
    // What it does NOT reach is the interleaving that distinguishes the guard in
    // the read from the guard in the UPDATE — that needs the first transaction
    // held open between its select and its update while the second commits, which
    // black-box calls cannot arrange. Removing the UPDATE predicate still passes
    // this test. The predicate is there because the read alone is not a
    // compare-and-swap under READ COMMITTED, and that remains argued rather than
    // demonstrated here.
    const path = `/notes/cas-${randomUUID()}.txt`;
    await put(path, 'base');
    const shared = hashOf('base');

    const results = await Promise.allSettled([
      put(path, 'writer A', { expectedHash: shared }),
      put(path, 'writer B', { expectedHash: shared }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/MEMORY_HASH_MISMATCH/);

    const held = await docRepo.getByPath(path, SPACE);
    expect(['writer A', 'writer B']).toContain(held!.inlineContent);
    expect(held!.currentVersion).toBe(2);
  });

  it('reports a revived document as one this call created, above the first version', async () => {
    const path = `/notes/revival-${randomUUID()}.txt`;
    const first = await put(path, 'same bytes');
    expect(first.created).toBe(true);
    expect(first.revived).toBe(false);
    expect(await docRepo.softDelete(first.id, SPACE)).toBe(true);

    const revived = await put(path, 'same bytes', { expectedHash: hashOf('same bytes') });
    expect(revived.currentVersion).toBe(2);
    expect(revived.created).toBe(true);
    expect(revived.deletedAt).toBeNull();
    // What separates the two: this path had a document under it, and undoing
    // this write means putting that document back rather than erasing it.
    expect(revived.revived).toBe(true);

    const updated = await put(path, 'a later edit');
    expect(updated.created).toBe(false);
    expect(updated.revived).toBe(false);
    expect(updated.currentVersion).toBe(3);
  });
});
