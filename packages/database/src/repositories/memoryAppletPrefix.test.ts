import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestContext } from 'vitest';
import { inArray } from 'drizzle-orm';
import type { TenantId } from '@aflow/schemas';
import { APPLET_MEMORY_PREFIX, appletStatePath } from '@aflow/schemas';
import { createDatabase } from '../connection.js';
import { createTenantContext } from '../tenant/context.js';
import { withTenantSchema } from '../tenant/queries.js';
import { memoryDocs, memoryDirs, spaces } from '../schema/tenant.js';
import {
  createMemoryDocRepository,
  isAppletReservedPath,
  targetsAppletReservedSubtree,
  type MemoryDocPutParams,
} from './memoryDocs.js';
import { createMemoryDirRepository } from './memoryDirs.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;
const SPACE = '19640000-0000-4000-8000-000000000001';

const describeDb = DATABASE_URL ? describe : describe.skip;

describe('applet reserved path predicates', () => {
  it('classifies doc paths under the prefix', () => {
    expect(isAppletReservedPath(appletStatePath('abc'))).toBe(true);
    expect(isAppletReservedPath('/applets/nested/deep.json')).toBe(true);
    expect(isAppletReservedPath('/appletsibling/x.json')).toBe(false);
    expect(isAppletReservedPath('/notes/applets/x.json')).toBe(false);
  });

  it('recognizes explicit subtree targeting, with and without trailing slash', () => {
    expect(targetsAppletReservedSubtree(APPLET_MEMORY_PREFIX)).toBe(true);
    expect(targetsAppletReservedSubtree('/applets')).toBe(true);
    expect(targetsAppletReservedSubtree('/applets/i-1.json')).toBe(true);
    expect(targetsAppletReservedSubtree('/')).toBe(false);
    expect(targetsAppletReservedSubtree('/appletsibling')).toBe(false);
  });
});

describeDb('reserved applet memory prefix (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const sql = handle.sql;
  const tenantCtx = createTenantContext(TENANT_ID as TenantId);
  const docRepo = createMemoryDocRepository(db, tenantCtx);
  const dirRepo = createMemoryDirRepository(db, tenantCtx);

  const instanceId = randomUUID();
  const appletPath = appletStatePath(instanceId);
  const controlPath = '/notes/applet-prefix-control.md';
  const token = 'zx9applettoken';

  let schemaReady = false;

  async function putDoc(
    path: string,
    content: string,
    extra?: Partial<MemoryDocPutParams>,
  ): Promise<string> {
    await dirRepo.ensureParentDirs(path, { spaceId: SPACE });
    const doc = await docRepo.put({
      path,
      writeMode: 'upsert',
      docType: 'text',
      mimeType: 'text/plain',
      inlineContent: content,
      payloadRef: null,
      sizeBytes: Buffer.byteLength(content, 'utf8'),
      contentHash: randomUUID(),
      preview: content.substring(0, 200),
      tags: [],
      summary: null,
      indexing: 'force',
      scope: { spaceId: SPACE },
      provenance: { actor: 'system:applet-prefix-test' },
      ...extra,
    });
    return doc.id;
  }

  async function cleanup(): Promise<void> {
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.delete(memoryDocs).where(inArray(memoryDocs.spaceId, [SPACE]));
      await tx.delete(memoryDirs).where(inArray(memoryDirs.spaceId, [SPACE]));
      await tx.delete(spaces).where(inArray(spaces.id, [SPACE]));
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
        {
          id: SPACE,
          name: 'Applet Prefix Space',
          slug: `applet-prefix-${randomUUID().slice(0, 8)}`,
        },
      ]);
    });
  });

  afterAll(async () => {
    if (schemaReady) await cleanup();
    await handle.close();
  });

  function requireSchema(ctx: TestContext): boolean {
    if (!schemaReady) {
      ctx.skip(`tenant schema ${TENANT_SCHEMA} not migrated — run \`yarn db:migrate\``);
      return false;
    }
    return true;
  }

  it('put under the prefix forces embedding off even with indexing "force"', async (ctx: TestContext) => {
    if (!requireSchema(ctx)) return;
    await putDoc(appletPath, `state body ${token}`, { indexing: 'force' });
    const doc = await docRepo.getByPath(appletPath, SPACE);
    expect(doc).not.toBeNull();
    expect(doc!.embeddingStatus).toBe('disabled');
    expect(doc!.indexingMode).toBe('disabled');

    await putDoc(controlPath, `control body ${token}`, { indexing: 'force' });
    const control = await docRepo.getByPath(controlPath, SPACE);
    expect(control!.embeddingStatus).toBe('pending');
    expect(control!.indexingMode).toBe('force');
  });

  it('revived soft-deleted applet doc stays unindexed despite "force"', async (ctx: TestContext) => {
    if (!requireSchema(ctx)) return;
    const id = await putDoc(appletPath, `state body ${token}`);
    await docRepo.softDelete(id, SPACE);
    await putDoc(appletPath, `revived body ${token}`, { indexing: 'force' });
    const revived = await docRepo.getByPath(appletPath, SPACE);
    expect(revived).not.toBeNull();
    expect(revived!.deletedAt).toBeNull();
    expect(revived!.currentVersion).toBeGreaterThan(1);
    expect(revived!.embeddingStatus).toBe('disabled');
    expect(revived!.indexingMode).toBe('disabled');
  });

  it('list excludes the prefix by default and includes it on explicit targeting', async (ctx: TestContext) => {
    if (!requireSchema(ctx)) return;
    await putDoc(appletPath, `state body ${token}`);
    await putDoc(controlPath, `control body ${token}`);

    const all = await docRepo.list({ scope: { spaceId: SPACE } });
    expect(all.map((r) => r.path)).not.toContain(appletPath);
    expect(all.map((r) => r.path)).toContain(controlPath);

    const rooted = await docRepo.list({ scope: { spaceId: SPACE }, pathPrefix: '/' });
    expect(rooted.map((r) => r.path)).not.toContain(appletPath);

    const explicit = await docRepo.list({
      scope: { spaceId: SPACE },
      pathPrefix: APPLET_MEMORY_PREFIX,
    });
    expect(explicit.map((r) => r.path)).toContain(appletPath);

    const explicitNoSlash = await docRepo.list({
      scope: { spaceId: SPACE },
      pathPrefix: '/applets',
    });
    expect(explicitNoSlash.map((r) => r.path)).toContain(appletPath);
  });

  it('trash (listDeleted) never shows prefix docs, deleted control docs still appear', async (ctx: TestContext) => {
    if (!requireSchema(ctx)) return;
    const appletId = await putDoc(appletPath, `state body ${token}`);
    const controlId = await putDoc(controlPath, `control body ${token}`);
    await docRepo.softDelete(appletId, SPACE);
    await docRepo.softDelete(controlId, SPACE);

    const trash = await docRepo.listDeleted({ spaceId: SPACE });
    expect(trash.map((r) => r.path)).not.toContain(appletPath);
    expect(trash.map((r) => r.path)).toContain(controlPath);
  });

  it('listByPaths and grep exclude prefix docs', async (ctx: TestContext) => {
    if (!requireSchema(ctx)) return;
    await putDoc(appletPath, `state body ${token}`);
    await putDoc(controlPath, `control body ${token}`);

    const byPaths = await docRepo.listByPaths([appletPath, controlPath], {
      scope: { spaceId: SPACE },
    });
    expect(byPaths.map((r) => r.path)).toEqual([controlPath]);

    const grepped = await docRepo.grep({ scope: { spaceId: SPACE }, query: token });
    expect(grepped.map((r) => r.path)).not.toContain(appletPath);
    expect(grepped.map((r) => r.path)).toContain(controlPath);
  });

  it('searchFts excludes prefix docs even when chunks exist', async (ctx: TestContext) => {
    if (!requireSchema(ctx)) return;
    const appletId = await putDoc(appletPath, `state body ${token}`);
    const controlId = await putDoc(controlPath, `control body ${token}`);

    for (const docId of [appletId, controlId]) {
      const version = await docRepo.getLatestVersion(docId);
      await docRepo.insertChunks([
        {
          docId,
          docVersionId: version!.id,
          chunkIndex: 0,
          text: `chunk body ${token}`,
          startOffset: 0,
          endOffset: 20,
        },
      ]);
    }

    const hits = await docRepo.searchFts({ scope: { spaceId: SPACE }, query: token });
    expect(hits.map((h) => h.path)).not.toContain(appletPath);
    expect(hits.map((h) => h.path)).toContain(controlPath);
  });

  it('exact-path and id gets still resolve prefix docs', async (ctx: TestContext) => {
    if (!requireSchema(ctx)) return;
    const id = await putDoc(appletPath, `state body ${token}`);
    const byPath = await docRepo.getByPath(appletPath, SPACE);
    expect(byPath?.id).toBe(id);
    const byId = await docRepo.getById(id, SPACE);
    expect(byId?.path).toBe(appletPath);
  });

  it('listDir hides the reserved directory at root but lists it when targeted', async (ctx: TestContext) => {
    if (!requireSchema(ctx)) return;
    await putDoc(appletPath, `state body ${token}`);
    await putDoc(controlPath, `control body ${token}`);

    const root = await dirRepo.listDir('/', { scope: { spaceId: SPACE } });
    const rootPaths = root.map((e) => e.path);
    expect(rootPaths).not.toContain('/applets');
    expect(rootPaths).toContain('/notes');

    const targeted = await dirRepo.listDir('/applets', { scope: { spaceId: SPACE } });
    expect(targeted.map((e) => e.path)).toContain(appletPath);
  });
});
