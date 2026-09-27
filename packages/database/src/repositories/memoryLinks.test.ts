import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestContext } from 'vitest';
import { inArray } from 'drizzle-orm';
import type { TenantId } from '@aflow/schemas';
import { createDatabase } from '../connection.js';
import { createTenantContext } from '../tenant/context.js';
import { withTenantSchema } from '../tenant/queries.js';
import { memoryDocs, memoryDirs, memoryLinks, spaces } from '../schema/tenant.js';
import { createMemoryDocRepository, type MemoryDocPutParams } from './memoryDocs.js';
import { createMemoryDirRepository } from './memoryDirs.js';
import { createMemoryLinkRepository, type LinkInput } from './memoryLinks.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;
const SPACE_A = '19020000-0000-4000-8000-000000000001';
const SPACE_B = '19020000-0000-4000-8000-000000000002';

const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('Plan 249 P1b — memory link repository (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const sql = handle.sql;
  const tenantCtx = createTenantContext(TENANT_ID as TenantId);
  const docRepo = createMemoryDocRepository(db, tenantCtx);
  const dirRepo = createMemoryDirRepository(db, tenantCtx);
  const linkRepo = createMemoryLinkRepository(db, tenantCtx);

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
      tags: ['link-test'],
      summary: null,
      indexing: 'disabled',
      scope: { spaceId },
      provenance: { actor: 'system:memory-links-test' },
      ...extra,
    });
    return doc.id;
  }

  async function link(
    targetPath: string,
    ordinal: number,
    firstContext?: string,
  ): Promise<LinkInput> {
    return firstContext === undefined
      ? { targetPath, ordinal, occurrenceCount: 1 }
      : { targetPath, ordinal, occurrenceCount: 1, firstContext };
  }

  async function cleanup(): Promise<void> {
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.delete(memoryLinks).where(inArray(memoryLinks.spaceId, [SPACE_A, SPACE_B]));
      await tx.delete(memoryDocs).where(inArray(memoryDocs.spaceId, [SPACE_A, SPACE_B]));
      await tx.delete(memoryDirs).where(inArray(memoryDirs.spaceId, [SPACE_A, SPACE_B]));
      await tx.delete(spaces).where(inArray(spaces.id, [SPACE_A, SPACE_B]));
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
      await tx.insert(spaces).values([
        { id: SPACE_A, name: 'Link Space A', slug: `link-a-${randomUUID().slice(0, 8)}` },
        { id: SPACE_B, name: 'Link Space B', slug: `link-b-${randomUUID().slice(0, 8)}` },
      ]);
    });
  });

  afterAll(async () => {
    if (schemaReady) await cleanup();
    await handle.close();
  });

  it('replaceLinksForDoc rebuilds the link set (I1)', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip(`tenant schema ${TENANT_SCHEMA} not migrated — run \`yarn db:migrate\``);
      return;
    }
    const a = await putDoc('/rebuild/a.md', SPACE_A, 'A body');
    await putDoc('/rebuild/x.md', SPACE_A, 'x');
    await putDoc('/rebuild/y.md', SPACE_A, 'y');
    await putDoc('/rebuild/z.md', SPACE_A, 'z');

    await linkRepo.replaceLinksForDoc(a, SPACE_A, [
      await link('/rebuild/x.md', 0),
      await link('/rebuild/y.md', 1),
    ]);
    let out = await linkRepo.getOutgoingLinks(a, SPACE_A);
    expect(out.map((l) => l.targetPath)).toEqual(['/rebuild/x.md', '/rebuild/y.md']);

    await linkRepo.replaceLinksForDoc(a, SPACE_A, [await link('/rebuild/z.md', 0)]);
    out = await linkRepo.getOutgoingLinks(a, SPACE_A);
    expect(out.map((l) => l.targetPath)).toEqual(['/rebuild/z.md']);
  });

  it('read-time resolution follows target liveness (I3), no writes to links', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip('schema not migrated');
      return;
    }
    const a = await putDoc('/res/a.md', SPACE_A, 'A body');
    await linkRepo.replaceLinksForDoc(a, SPACE_A, [await link('/res/b.md', 0)]);

    // Target absent → ghost.
    let out = await linkRepo.getOutgoingLinks(a, SPACE_A);
    expect(out[0]?.resolved).toBe(false);

    // Create the target → resolves, with NO link write.
    const b = await putDoc('/res/b.md', SPACE_A, 'B body');
    out = await linkRepo.getOutgoingLinks(a, SPACE_A);
    expect(out[0]?.resolved).toBe(true);

    // Soft-delete the target → ghost again.
    expect(await docRepo.softDelete(b, SPACE_A)).toBe(true);
    out = await linkRepo.getOutgoingLinks(a, SPACE_A);
    expect(out[0]?.resolved).toBe(false);
  });

  it('backlinks honor SOURCE liveness (rows stay present)', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip('schema not migrated');
      return;
    }
    const a = await putDoc('/src/a.md', SPACE_A, 'A body');
    await putDoc('/src/b.md', SPACE_A, 'B body');
    await linkRepo.replaceLinksForDoc(a, SPACE_A, [await link('/src/b.md', 0)]);

    let back = await linkRepo.getBacklinks('/src/b.md', SPACE_A);
    expect(back.items.some((r) => r.fromPath === '/src/a.md')).toBe(true);
    expect(await linkRepo.countBacklinks('/src/b.md', SPACE_A)).toBe(1);

    // Soft-delete the source → excluded from backlinks, but the row survives.
    expect(await docRepo.softDelete(a, SPACE_A)).toBe(true);
    back = await linkRepo.getBacklinks('/src/b.md', SPACE_A);
    expect(back.items.some((r) => r.fromPath === '/src/a.md')).toBe(false);
    expect(await linkRepo.countBacklinks('/src/b.md', SPACE_A)).toBe(0);

    const rows = await sql`
      SELECT count(*)::int AS c FROM ${sql(TENANT_SCHEMA)}.memory_links
      WHERE from_doc_id = ${a}::uuid`;
    expect((rows as unknown as Array<{ c: number }>)[0]?.c).toBe(1);
  });

  it('space isolation — same target path never cross-resolves', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip('schema not migrated');
      return;
    }
    const aSrc = await putDoc('/iso/src.md', SPACE_A, 'A src');
    const bSrc = await putDoc('/iso/src.md', SPACE_B, 'B src');
    // Only space B has the target doc.
    await putDoc('/iso/target.md', SPACE_B, 'B target');

    await linkRepo.replaceLinksForDoc(aSrc, SPACE_A, [await link('/iso/target.md', 0)]);
    await linkRepo.replaceLinksForDoc(bSrc, SPACE_B, [await link('/iso/target.md', 0)]);

    // A links to /iso/target.md but the only live target lives in B → ghost in A.
    const outA = await linkRepo.getOutgoingLinks(aSrc, SPACE_A);
    expect(outA[0]?.resolved).toBe(false);
    // B resolves against its own target.
    const outB = await linkRepo.getOutgoingLinks(bSrc, SPACE_B);
    expect(outB[0]?.resolved).toBe(true);

    // Backlinks / edges / targets never cross the boundary.
    const backA = await linkRepo.getBacklinks('/iso/target.md', SPACE_A);
    expect(backA.items.every((r) => r.fromPath === '/iso/src.md')).toBe(true);
    expect(backA.items.length).toBe(1);
    const edgesB = await linkRepo.getLinkEdges('/iso/target.md', SPACE_B, { limit: 10 });
    expect(edgesB.items.length).toBe(1);
    const targetsA = await linkRepo.getLinkTargets(SPACE_A, { pathPrefix: '/iso', limit: 10 });
    const isoTargetA = targetsA.items.find((t) => t.targetPath === '/iso/target.md');
    expect(isoTargetA?.referrers.every((rf) => rf.path === '/iso/src.md')).toBe(true);
    expect(isoTargetA?.referenceCount).toBe(1);
  });

  it('getLinkEdges paginates completely with a stable order (12 → 3 pages of 5)', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip('schema not migrated');
      return;
    }
    const target = '/hub/popular.md';
    await putDoc(target, SPACE_A, 'popular');
    const expected: string[] = [];
    for (let i = 0; i < 12; i++) {
      const p = `/hub/ref-${String(i).padStart(2, '0')}.md`;
      const id = await putDoc(p, SPACE_A, `ref ${i}`);
      await linkRepo.replaceLinksForDoc(id, SPACE_A, [await link(target, 0)]);
      expected.push(p);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await linkRepo.getLinkEdges(target, SPACE_A, {
        limit: 5,
        ...(cursor ? { cursor } : {}),
      });
      pages++;
      for (const e of page.items) seen.push(e.fromPath);
      cursor = page.nextCursor;
      expect(pages).toBeLessThanOrEqual(4);
    } while (cursor);

    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(12);
    expect([...seen].sort()).toEqual([...expected].sort());
  });

  it('getLinkEdges paginates completely when all referrers share updated_at (tie-break)', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip('schema not migrated');
      return;
    }
    const target = '/hubtie/popular.md';
    await putDoc(target, SPACE_A, 'popular');
    const expected: string[] = [];
    const referrerIds: string[] = [];
    for (let i = 0; i < 12; i++) {
      const p = `/hubtie/ref-${String(i).padStart(2, '0')}.md`;
      const id = await putDoc(p, SPACE_A, `ref ${i}`);
      await linkRepo.replaceLinksForDoc(id, SPACE_A, [await link(target, 0)]);
      expected.push(p);
      referrerIds.push(id);
    }
    // Force EVERY referrer to the identical updated_at so the keyset must fall
    // through to the from_doc_id tie-break on every page boundary. The prior
    // (row-value `<`) predicate dropped and duplicated rows here.
    await sql`
      UPDATE ${sql(TENANT_SCHEMA)}.memory_docs
      SET updated_at = '2026-01-01 00:00:00+00'::timestamptz
      WHERE id = ANY(${referrerIds}::uuid[])`;

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await linkRepo.getLinkEdges(target, SPACE_A, {
        limit: 5,
        ...(cursor ? { cursor } : {}),
      });
      pages++;
      for (const e of page.items) seen.push(e.fromPath);
      cursor = page.nextCursor;
      expect(pages).toBeLessThanOrEqual(4);
    } while (cursor);

    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(12);
    expect([...seen].sort()).toEqual([...expected].sort());
  });

  it('getBacklinks paginates completely across a microsecond-precision boundary', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip('schema not migrated');
      return;
    }
    const target = '/hubus/popular.md';
    await putDoc(target, SPACE_A, 'popular');
    const expected: string[] = [];
    const referrerIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const p = `/hubus/ref-${String(i).padStart(2, '0')}.md`;
      const id = await putDoc(p, SPACE_A, `ref ${i}`);
      await linkRepo.replaceLinksForDoc(id, SPACE_A, [await link(target, 0)]);
      expected.push(p);
      referrerIds.push(id);
    }
    // Distinct MICROSECONDS inside the same millisecond. A cursor truncated to
    // millisecond (new Date().toISOString()) collapses these and silently loses
    // the rows whose microsecond tail sits below the truncation boundary.
    for (let i = 0; i < referrerIds.length; i++) {
      const us = String(100 + i).padStart(6, '0');
      await sql`
        UPDATE ${sql(TENANT_SCHEMA)}.memory_docs
        SET updated_at = ${`2026-02-02 00:00:00.${us}+00`}::timestamptz
        WHERE id = ${referrerIds[i]}::uuid`;
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await linkRepo.getBacklinks(target, SPACE_A, {
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      pages++;
      for (const e of page.items) seen.push(e.fromPath);
      cursor = page.nextCursor;
      expect(pages).toBeLessThanOrEqual(5);
    } while (cursor);

    expect(new Set(seen).size).toBe(6);
    expect([...seen].sort()).toEqual([...expected].sort());
  });

  it('getLinkTargets pathPrefix filters the REFERRER side, not the target', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip('schema not migrated');
      return;
    }
    // Referrer sits under /prefix/proj/, its target sits under /prefix/elsewhere/.
    // Referrer-side prefix semantics: /prefix/proj/ must surface the target (its
    // referrer is under the prefix); /prefix/elsewhere/ must NOT (no referrer there).
    const referrer = await putDoc('/prefix/proj/note.md', SPACE_A, 'note');
    await linkRepo.replaceLinksForDoc(referrer, SPACE_A, [
      await link('/prefix/elsewhere/target.md', 0),
    ]);

    const byReferrer = await linkRepo.getLinkTargets(SPACE_A, {
      pathPrefix: '/prefix/proj/',
      limit: 10,
    });
    expect(byReferrer.items.map((t) => t.targetPath)).toEqual(['/prefix/elsewhere/target.md']);
    const hit = byReferrer.items[0];
    expect(hit?.referenceCount).toBe(1);
    expect(hit?.referrers.map((r) => r.path)).toEqual(['/prefix/proj/note.md']);

    const byTarget = await linkRepo.getLinkTargets(SPACE_A, {
      pathPrefix: '/prefix/elsewhere/',
      limit: 10,
    });
    expect(byTarget.items.map((t) => t.targetPath)).toEqual([]);
  });

  it('getLinkTargets referenceCount/referrers count only referrers under the pathPrefix', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip('schema not migrated');
      return;
    }
    // One target, two referrers in different subtrees. Filtering to /pfx/in/
    // must count only the in-prefix referrer, both in the aggregate and the list.
    const target = '/pfx/shared/target.md';
    const inRef = await putDoc('/pfx/in/ref.md', SPACE_A, 'in');
    const outRef = await putDoc('/pfx/out/ref.md', SPACE_A, 'out');
    await linkRepo.replaceLinksForDoc(inRef, SPACE_A, [await link(target, 0)]);
    await linkRepo.replaceLinksForDoc(outRef, SPACE_A, [await link(target, 0)]);

    const scoped = await linkRepo.getLinkTargets(SPACE_A, { pathPrefix: '/pfx/in/', limit: 10 });
    const entry = scoped.items.find((t) => t.targetPath === target);
    expect(entry?.referenceCount).toBe(1);
    expect(entry?.referrers.map((r) => r.path)).toEqual(['/pfx/in/ref.md']);

    // Unfiltered sees both referrers.
    const unscoped = await linkRepo.getLinkTargets(SPACE_A, { pathPrefix: '/pfx/', limit: 10 });
    const both = unscoped.items.find((t) => t.targetPath === target);
    expect(both?.referenceCount).toBe(2);
  });

  it('getLinkTargets paginates completely when targets share reference_count (tie-break)', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip('schema not migrated');
      return;
    }
    // Six ghost targets, each referenced exactly once → equal reference_count,
    // so paging must fall through to the target_path ASC tie-break. The prior
    // row-value predicate dropped/duplicated equal-count targets.
    const expected: string[] = [];
    for (let i = 0; i < 6; i++) {
      const src = await putDoc(`/ttie/src-${String(i).padStart(2, '0')}.md`, SPACE_A, `s${i}`);
      const tgt = `/ttie/ghost-${String(i).padStart(2, '0')}.md`;
      await linkRepo.replaceLinksForDoc(src, SPACE_A, [await link(tgt, 0)]);
      expected.push(tgt);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await linkRepo.getLinkTargets(SPACE_A, {
        pathPrefix: '/ttie',
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      pages++;
      for (const t of page.items) seen.push(t.targetPath);
      cursor = page.nextCursor;
      expect(pages).toBeLessThanOrEqual(5);
    } while (cursor);

    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(6);
    expect([...seen].sort()).toEqual([...expected].sort());
  });

  it('getLinkTargets unresolvedOnly returns only ghost targets; counts aggregate', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip('schema not migrated');
      return;
    }
    const s1 = await putDoc('/agenda/s1.md', SPACE_A, 's1');
    const s2 = await putDoc('/agenda/s2.md', SPACE_A, 's2');
    // resolved target exists; ghost target does not.
    await putDoc('/agenda/resolved.md', SPACE_A, 'resolved');

    await linkRepo.replaceLinksForDoc(s1, SPACE_A, [
      await link('/agenda/resolved.md', 0),
      await link('/agenda/ghost.md', 1),
    ]);
    await linkRepo.replaceLinksForDoc(s2, SPACE_A, [await link('/agenda/ghost.md', 0)]);

    const ghostOnly = await linkRepo.getLinkTargets(SPACE_A, {
      pathPrefix: '/agenda',
      unresolvedOnly: true,
      limit: 10,
    });
    expect(ghostOnly.items.map((t) => t.targetPath)).toEqual(['/agenda/ghost.md']);
    const ghost = ghostOnly.items[0];
    expect(ghost?.resolved).toBe(false);
    expect(ghost?.referenceCount).toBe(2);
    expect(new Set(ghost?.referrers.map((r) => r.path))).toEqual(
      new Set(['/agenda/s1.md', '/agenda/s2.md']),
    );

    const all = await linkRepo.getLinkTargets(SPACE_A, { pathPrefix: '/agenda', limit: 10 });
    const resolvedT = all.items.find((t) => t.targetPath === '/agenda/resolved.md');
    expect(resolvedT?.resolved).toBe(true);
    expect(resolvedT?.referenceCount).toBe(1);
    expect(resolvedT?.resolvedDoc?.docType).toBe('text');
    // Ordered by referenceCount DESC — ghost (2) before resolved (1).
    expect(all.items[0]?.targetPath).toBe('/agenda/ghost.md');
  });

  it('countOutgoing splits resolved vs ghost', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip('schema not migrated');
      return;
    }
    const a = await putDoc('/count/a.md', SPACE_A, 'A');
    await putDoc('/count/live1.md', SPACE_A, 'l1');
    await putDoc('/count/live2.md', SPACE_A, 'l2');
    await linkRepo.replaceLinksForDoc(a, SPACE_A, [
      await link('/count/live1.md', 0),
      await link('/count/live2.md', 1),
      await link('/count/ghost1.md', 2),
    ]);

    const counts = await linkRepo.countOutgoing(a, SPACE_A);
    expect(counts).toEqual({ resolved: 2, ghost: 1 });
  });

  it('getNeighborsForExpansion caps per-seed and honors both-endpoint liveness', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip('schema not migrated');
      return;
    }
    const seed = await putDoc('/exp/seed.md', SPACE_A, 'seed');
    for (let i = 0; i < 4; i++) await putDoc(`/exp/out-${i}.md`, SPACE_A, `o${i}`);
    await linkRepo.replaceLinksForDoc(seed, SPACE_A, [
      await link('/exp/out-0.md', 0),
      await link('/exp/out-1.md', 1),
      await link('/exp/out-2.md', 2),
      await link('/exp/out-3.md', 3),
    ]);
    // An inbound edge: another live doc links to the seed.
    const inbound = await putDoc('/exp/inbound.md', SPACE_A, 'in');
    await linkRepo.replaceLinksForDoc(inbound, SPACE_A, [await link('/exp/seed.md', 0)]);

    const outMap = await linkRepo.getNeighborsForExpansion([seed], SPACE_A, 'out', 2);
    const outNeighbors = outMap.get(seed) ?? [];
    expect(outNeighbors.length).toBe(2);
    expect(outNeighbors.every((n) => n.direction === 'out')).toBe(true);
    // Capped by ordinal → first two.
    expect(outNeighbors.map((n) => n.path)).toEqual(['/exp/out-0.md', '/exp/out-1.md']);

    const bothMap = await linkRepo.getNeighborsForExpansion([seed], SPACE_A, 'both', 5);
    const bothNeighbors = bothMap.get(seed) ?? [];
    expect(bothNeighbors.some((n) => n.direction === 'in' && n.path === '/exp/inbound.md')).toBe(
      true,
    );
    expect(bothNeighbors.filter((n) => n.direction === 'out').length).toBe(4);
  });
});
