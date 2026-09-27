import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestContext } from 'vitest';
import { inArray, sql as drizzleSql } from 'drizzle-orm';
import {
  createDatabase,
  createTenantContext,
  withTenantSchema,
  createMemoryDocRepository,
  createMemoryLinkRepository,
  memoryDocs,
  memoryDirs,
  memoryLinks,
  memoryChunks,
  spaces,
  type MemoryDocRepository,
  type MemoryLinkRepository,
} from '@aflow/database';
import type { MemorySeed, TenantId } from '@aflow/schemas';
import { applyMemorySeeds } from '../stagedChange/bundleInstallContent.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;
const SPACE = '55ed0000-0000-4000-8000-0000000000d1';

const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb(
  'Plan 249 P1a — bundle memory seeds route through the derivation authority (real DB)',
  () => {
    const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
    const db = handle.db;
    const sql = handle.sql;
    const tenantCtx = createTenantContext(TENANT_ID as TenantId);
    const docRepo: MemoryDocRepository = createMemoryDocRepository(db, tenantCtx);
    const linkRepo: MemoryLinkRepository = createMemoryLinkRepository(db, tenantCtx);

    let schemaReady = false;

    async function cleanup(): Promise<void> {
      await withTenantSchema(db, tenantCtx, async (tx) => {
        await tx.delete(memoryLinks).where(inArray(memoryLinks.spaceId, [SPACE]));
        await tx.execute(drizzleSql`
        DELETE FROM memory_chunks
        WHERE doc_id IN (SELECT id FROM memory_docs WHERE space_id = ${SPACE})
      `);
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
          .values([{ id: SPACE, name: 'Seed Space', slug: `seed-${randomUUID().slice(0, 8)}` }]);
      });
    });

    afterAll(async () => {
      if (schemaReady) await cleanup();
      await handle.close();
    });

    it('a LINKABLE markdown seed derives links + chunks and owes an embed job', async (ctx: TestContext) => {
      if (!schemaReady) {
        ctx.skip(`tenant schema ${TENANT_SCHEMA} not migrated`);
        return;
      }
      const seed: MemorySeed = {
        path: '/theses/SCHEMA.md',
        content: 'Thesis schema referencing [[/x]] and enough prose to chunk into the index.',
        docType: 'markdown',
        seedPolicy: 'skip',
      };

      const result = await applyMemorySeeds({
        memorySeed: [seed],
        spaceId: SPACE,
        tenantId: TENANT_ID as TenantId,
        repo: docRepo,
      });

      expect(result.installedMemoryDocPaths).toEqual(['/theses/SCHEMA.md']);
      expect(result.skippedMemoryDocPaths).toEqual([]);

      const doc = await docRepo.getByPath('/theses/SCHEMA.md', SPACE);
      expect(doc).not.toBeNull();
      const docId = doc?.id ?? '';

      // (a) the wikilink materialized as a memory_links edge (ghost → /x.md).
      const outgoing = await linkRepo.getOutgoingLinks(docId, SPACE);
      expect(outgoing.map((l) => l.targetPath)).toEqual(['/x.md']);

      // (b) chunks derived (indexing:'auto' for linkable seeds).
      const chunks = await withTenantSchema(db, tenantCtx, async (tx) =>
        tx
          .select({ id: memoryChunks.id })
          .from(memoryChunks)
          .where(inArray(memoryChunks.docId, [docId])),
      );
      expect(chunks.length).toBeGreaterThan(0);

      // (c) an embed job is owed for the un-embedded chunks and must be published
      // post-commit by the caller.
      expect(result.pendingEmbedJobs.length).toBeGreaterThan(0);
      expect(result.pendingEmbedJobs.some((j) => j.docId === docId)).toBe(true);
    });

    it('a STRUCTURAL json seed stays derivation-free — no links, no chunks, no embed job', async (ctx: TestContext) => {
      if (!schemaReady) {
        ctx.skip('schema not migrated');
        return;
      }
      const seed: MemorySeed = {
        path: '/config/settings.json',
        content: JSON.stringify({ links: '[[/should-not-parse]]' }),
        docType: 'json',
        seedPolicy: 'skip',
      };

      const result = await applyMemorySeeds({
        memorySeed: [seed],
        spaceId: SPACE,
        tenantId: TENANT_ID as TenantId,
        repo: docRepo,
      });

      const doc = await docRepo.getByPath('/config/settings.json', SPACE);
      expect(doc).not.toBeNull();
      const docId = doc?.id ?? '';

      expect(await linkRepo.getOutgoingLinks(docId, SPACE)).toHaveLength(0);
      const chunks = await withTenantSchema(db, tenantCtx, async (tx) =>
        tx
          .select({ id: memoryChunks.id })
          .from(memoryChunks)
          .where(inArray(memoryChunks.docId, [docId])),
      );
      expect(chunks).toHaveLength(0);
      expect(result.pendingEmbedJobs).toHaveLength(0);
    });
  },
);
