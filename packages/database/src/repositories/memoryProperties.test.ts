import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestContext } from 'vitest';
import { inArray } from 'drizzle-orm';
import type { TenantId } from '@aflow/schemas';
import { createDatabase } from '../connection.js';
import { createTenantContext } from '../tenant/context.js';
import { withTenantSchema } from '../tenant/queries.js';
import { memoryDocs, memoryDirs, spaces } from '../schema/tenant.js';
import { createMemoryDocRepository, type MemoryDocQueryOptions } from './memoryDocs.js';
import { createMemoryDirRepository } from './memoryDirs.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;
const SPACE = '19020000-0000-4000-8000-0000000000f1';
const SPACE_B = '19020000-0000-4000-8000-0000000000f2';

const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('Plan 249 P3 — filters.properties containment (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const sql = handle.sql;
  const tenantCtx = createTenantContext(TENANT_ID as TenantId);
  const docRepo = createMemoryDocRepository(db, tenantCtx);
  const dirRepo = createMemoryDirRepository(db, tenantCtx);

  let schemaReady = false;

  async function putWithProps(
    path: string,
    properties: Record<string, unknown>,
    spaceId: string = SPACE,
  ): Promise<void> {
    await dirRepo.ensureParentDirs(path, { spaceId });
    const doc = await docRepo.put({
      path,
      writeMode: 'upsert',
      docType: 'markdown',
      mimeType: 'text/markdown',
      inlineContent: 'body',
      payloadRef: null,
      sizeBytes: 4,
      contentHash: randomUUID(),
      preview: 'body',
      tags: [],
      summary: null,
      indexing: 'disabled',
      scope: { spaceId },
    });
    await docRepo.updateDerivedFields(doc.id, spaceId, {
      properties,
      derivation: { schemaVersion: 1, sourceHash: 'h' },
    });
  }

  async function listPaths(
    properties: NonNullable<MemoryDocQueryOptions['filters']>['properties'],
  ): Promise<string[]> {
    const rows = await docRepo.list({
      scope: { spaceId: SPACE },
      pathPrefix: '/props/',
      limit: 100,
      filters: { properties },
    });
    return rows.map((r) => r.path).sort();
  }

  async function cleanup(): Promise<void> {
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.delete(memoryDocs).where(inArray(memoryDocs.spaceId, [SPACE, SPACE_B]));
      await tx.delete(memoryDirs).where(inArray(memoryDirs.spaceId, [SPACE, SPACE_B]));
      await tx.delete(spaces).where(inArray(spaces.id, [SPACE, SPACE_B]));
    });
  }

  beforeAll(async () => {
    const rows = await sql<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = ${TENANT_SCHEMA}
          AND table_name = 'memory_docs' AND column_name = 'properties'
      ) AS ok`;
    schemaReady = rows[0]?.ok === true;
    if (!schemaReady) return;
    await cleanup();
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.insert(spaces).values([
        { id: SPACE, name: 'Props', slug: `props-${randomUUID().slice(0, 8)}` },
        { id: SPACE_B, name: 'Props B', slug: `props-b-${randomUUID().slice(0, 8)}` },
      ]);
    });

    await putWithProps('/props/scalar-a.md', { status: 'active', priority: 3 });
    await putWithProps('/props/scalar-b.md', { status: 'archived', priority: 1 });
    await putWithProps('/props/array.md', { status: ['active', 'pinned'], priority: 5 });
    await putWithProps('/props/bool.md', { status: 'active', done: true });
    // Same property value under a different space — must never cross-resolve.
    await putWithProps('/props/leak.md', { status: 'active' }, SPACE_B);
  });

  afterAll(async () => {
    if (schemaReady) await cleanup();
    await handle.close();
  });

  function guard(ctx: TestContext): boolean {
    if (!schemaReady) {
      ctx.skip(`tenant schema ${TENANT_SCHEMA} not migrated`);
      return false;
    }
    return true;
  }

  it('scalar equality matches a scalar property (scalar_eq)', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    // status='active' matches scalar-a (scalar) AND array.md (array contains 'active')
    // AND bool.md (scalar). scalar-b is 'archived'.
    expect(await listPaths({ status: 'active' })).toEqual([
      '/props/array.md',
      '/props/bool.md',
      '/props/scalar-a.md',
    ]);
  });

  it('scalar candidate matches an array-valued property (array_contains)', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    // status='pinned' exists only inside array.md's array.
    expect(await listPaths({ status: 'pinned' })).toEqual(['/props/array.md']);
  });

  it('an array of candidates is any-of (OR)', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    expect(await listPaths({ status: ['archived', 'pinned'] })).toEqual([
      '/props/array.md',
      '/props/scalar-b.md',
    ]);
  });

  it('multiple keys are ANDed', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    // status='active' AND priority=3 → only scalar-a.
    expect(await listPaths({ status: 'active', priority: 3 })).toEqual(['/props/scalar-a.md']);
  });

  it('a boolean scalar matches', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    expect(await listPaths({ done: true })).toEqual(['/props/bool.md']);
  });

  it('a non-matching value returns nothing', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    expect(await listPaths({ status: 'nonexistent' })).toEqual([]);
  });

  it('property filters never cross-resolve between spaces', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    // /props/leak.md {status:'active'} lives in SPACE_B. A status='active' list
    // scoped to SPACE must exclude it and never surface its path.
    const inSpaceA = await listPaths({ status: 'active' });
    expect(inSpaceA).toEqual(['/props/array.md', '/props/bool.md', '/props/scalar-a.md']);
    expect(inSpaceA).not.toContain('/props/leak.md');

    // The same filter scoped to SPACE_B sees only the SPACE_B doc.
    const inSpaceB = (
      await docRepo.list({
        scope: { spaceId: SPACE_B },
        pathPrefix: '/props/',
        limit: 100,
        filters: { properties: { status: 'active' } },
      })
    )
      .map((r) => r.path)
      .sort();
    expect(inSpaceB).toEqual(['/props/leak.md']);
  });
});
