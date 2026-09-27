import { randomBytes, randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestContext } from 'vitest';
import { inArray, sql as drizzleSql } from 'drizzle-orm';
import type { TenantId, SessionId, StepExecutionId, OperationId, PayloadRef } from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import type { Redis } from 'ioredis';
import {
  createDatabase,
  createTenantContext,
  withTenantSchema,
  createMemoryDocRepository,
  createMemoryDirRepository,
  createMemoryLinkRepository,
  memoryDocs,
  memoryDirs,
  memoryLinks,
  spaces,
  type MemoryDocRepository,
  type MemoryLinkRepository,
  type MemoryDirRepository,
  type MemoryDocPutParams,
} from '@aflow/database';
import { MemoryGetInputSchema, MemoryQueryInputSchema } from '@aflow/schemas';
import { computeContentHash } from '@aflow/memory-store';
import { MemoryHandler } from '../memory/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;
/**
 * This suite's namespace, and inside it one space of this execution's own. The
 * namespace is what a later run sweeps an aborted one by; the random tail is
 * what keeps two concurrent runs — two worktrees, a re-run started before the
 * last finished — out of each other's rows.
 */
const SPACE_NAMESPACE = '19020000-0000-4000-8000-';
const SPACE = `${SPACE_NAMESPACE}${randomBytes(6).toString('hex')}`;

const describeDb = DATABASE_URL ? describe : describe.skip;

function inlinePayloadStore(): PayloadStore {
  const unreachable = () => {
    throw new Error('payload store should not be reached for inline content');
  };
  return {
    store: unreachable,
    retrieve: unreachable,
    exists: unreachable,
    buildRef: () => 'payload:ref' as PayloadRef,
  } as unknown as PayloadStore;
}

describeDb('Plan 249 P3 — memory read surface (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const sql = handle.sql;
  const tenantCtx = createTenantContext(TENANT_ID as TenantId);
  const docRepo: MemoryDocRepository = createMemoryDocRepository(db, tenantCtx);
  const dirRepo: MemoryDirRepository = createMemoryDirRepository(db, tenantCtx);
  const linkRepo: MemoryLinkRepository = createMemoryLinkRepository(db, tenantCtx);
  const payloadStore = inlinePayloadStore();
  const redis = {} as Redis;

  const handler = new MemoryHandler(db as never, redis, payloadStore);

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
      docType: 'markdown',
      mimeType: 'text/markdown',
      inlineContent: content,
      payloadRef: null,
      sizeBytes: Buffer.byteLength(content, 'utf8'),
      contentHash: randomUUID(),
      preview: content.slice(0, 200),
      tags: [],
      summary: null,
      indexing: 'disabled',
      scope: { spaceId: SPACE },
      provenance: { actor: 'system:read-surface-test' },
      ...extra,
    });
    return doc.id;
  }

  function runOp(
    operationId: string,
    rawInput: unknown,
  ): Promise<{ result: StepResult; output: Record<string, unknown> }> {
    // The platform validates + preprocesses input against the operation's Zod
    // schema before the handler runs; the handler reads the already-parsed form.
    const input =
      operationId === 'memory.store.query'
        ? MemoryQueryInputSchema.parse(rawInput)
        : MemoryGetInputSchema.parse(rawInput);
    let output: Record<string, unknown> = {};
    const ctx = {
      job: {
        messageVersion: 1,
        tenantId: TENANT_ID,
        runId: '00000000-0000-0000-0000-000000000000',
        stepId: 'step',
        stepExecutionId: '00000000-0000-0000-0000-0000000000ff',
        stepType: 'memory',
        operationId,
        attempt: 1,
        idempotencyKey: 'idem',
        traceId: 'trace',
        inputRef: 'input:ref' as PayloadRef,
        spaceId: SPACE,
      },
      tenantId: TENANT_ID as TenantId,
      runId: '00000000-0000-0000-0000-000000000000' as SessionId,
      stepExecutionId: '00000000-0000-0000-0000-0000000000ff' as StepExecutionId,
      attempt: 1,
      idempotencyKey: 'idem',
      traceId: 'trace',
      operationId: operationId as OperationId,
      readPayload: async () => input,
      writePayload: async (kind: string, data: unknown) => {
        if (kind === 'output') output = data as Record<string, unknown>;
        return 'payload:out' as PayloadRef;
      },
      outputExists: async () => null,
      resolveAndValidateInput: async () => input,
      signal: new AbortController().signal,
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    } as unknown as ExecutorContext;
    return handler.execute(ctx).then((result) => ({ result, output }));
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
          { id: SPACE, name: 'Read Surface', slug: `read-surface-${randomUUID().slice(0, 8)}` },
        ]);
    });
  });

  afterAll(async () => {
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

  it('stat surfaces link counts for a link-source doc (1 resolved, 1 ghost, 1 backlink)', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    const src = await putDoc('/stat/src.md', 'src');
    await putDoc('/stat/live.md', 'live target');
    const referrer = await putDoc('/stat/ref.md', 'referrer');

    await linkRepo.replaceLinksForDoc(src, SPACE, [
      { targetPath: '/stat/live.md', ordinal: 0, occurrenceCount: 1 },
      { targetPath: '/stat/ghost.md', ordinal: 1, occurrenceCount: 1 },
    ]);
    await linkRepo.replaceLinksForDoc(referrer, SPACE, [
      { targetPath: '/stat/src.md', ordinal: 0, occurrenceCount: 1 },
    ]);

    const { result, output } = await runOp('memory.store.get', {
      path: '/stat/src.md',
      view: 'stat',
    });
    expect(result.status).toBe('SUCCEEDED');
    const stat = output['stat'] as Record<string, unknown>;
    expect(stat['linkCount']).toBe(1);
    expect(stat['ghostLinkCount']).toBe(1);
    expect(stat['backlinkCount']).toBe(1);
  });

  it('stat of a json target doc has backlinkCount only (no outgoing counts)', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    const jsonTarget = await putDoc('/stat/data.json', '{"a":1}', {
      docType: 'json',
      mimeType: 'application/json',
    });
    const referrer = await putDoc('/stat/points.md', 'points');
    await linkRepo.replaceLinksForDoc(referrer, SPACE, [
      { targetPath: '/stat/data.json', ordinal: 0, occurrenceCount: 1 },
    ]);
    void jsonTarget;

    const { output } = await runOp('memory.store.get', {
      path: '/stat/data.json',
      view: 'stat',
    });
    const stat = output['stat'] as Record<string, unknown>;
    expect(stat['backlinkCount']).toBe(1);
    expect(stat['linkCount']).toBeUndefined();
    expect(stat['ghostLinkCount']).toBeUndefined();
  });

  it('stat surfaces properties + provenance + derivation', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    const id = await putDoc('/stat/props.md', 'body');
    await docRepo.updateDerivedFields(id, SPACE, {
      properties: { status: 'active', priority: 3 },
      derivation: {
        schemaVersion: 1,
        sourceHash: 'h',
        linksClamped: true,
        propertyWarnings: 2,
      },
    });

    const { output } = await runOp('memory.store.get', { path: '/stat/props.md', view: 'stat' });
    const stat = output['stat'] as Record<string, unknown>;
    expect(stat['properties']).toEqual({ status: 'active', priority: 3 });
    expect((stat['provenance'] as Record<string, unknown>)['actor']).toBe(
      'system:read-surface-test',
    );
    expect(stat['derivation']).toEqual({ linksClamped: true, propertyWarnings: 2 });
  });

  it('view="links" returns outgoing (ordered), backlinks, totals', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    const src = await putDoc('/links/src.md', 'src');
    await putDoc('/links/a.md', 'a');
    await putDoc('/links/b.md', 'b');
    const referrer = await putDoc('/links/ref.md', 'ref');

    await linkRepo.replaceLinksForDoc(src, SPACE, [
      { targetPath: '/links/b.md', ordinal: 0, occurrenceCount: 2, firstContext: 'first b' },
      { targetPath: '/links/a.md', ordinal: 1, occurrenceCount: 1 },
      { targetPath: '/links/ghost.md', ordinal: 2, occurrenceCount: 1 },
    ]);
    await linkRepo.replaceLinksForDoc(referrer, SPACE, [
      { targetPath: '/links/src.md', ordinal: 0, occurrenceCount: 1, firstContext: 'via ref' },
    ]);

    const { output } = await runOp('memory.store.get', { path: '/links/src.md', view: 'links' });
    const links = output['links'] as {
      outgoing: Array<{ targetPath: string; resolved: boolean; context?: string }>;
      backlinks: Array<{ fromPath: string; context?: string }>;
      outgoingTotal: number;
      backlinkTotal: number;
      truncated?: boolean;
    };
    expect(links.outgoing.map((o) => o.targetPath)).toEqual([
      '/links/b.md',
      '/links/a.md',
      '/links/ghost.md',
    ]);
    expect(links.outgoing[0]?.context).toBe('first b');
    expect(links.outgoing.find((o) => o.targetPath === '/links/ghost.md')?.resolved).toBe(false);
    expect(links.outgoingTotal).toBe(3);
    expect(links.backlinks.map((b) => b.fromPath)).toEqual(['/links/ref.md']);
    expect(links.backlinkTotal).toBe(1);
    expect(links.truncated).toBeUndefined();
  });

  it('view="links" on a non-source (json) doc: backlinks populated, outgoing empty (not an error)', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    await putDoc('/links/plain.json', '{"x":1}', {
      docType: 'json',
      mimeType: 'application/json',
    });
    const referrer = await putDoc('/links/jref.md', 'jref');
    await linkRepo.replaceLinksForDoc(referrer, SPACE, [
      { targetPath: '/links/plain.json', ordinal: 0, occurrenceCount: 1 },
    ]);

    const { result, output } = await runOp('memory.store.get', {
      path: '/links/plain.json',
      view: 'links',
    });
    expect(result.status).toBe('SUCCEEDED');
    const links = output['links'] as { outgoing: unknown[]; backlinks: unknown[] };
    expect(links.outgoing).toEqual([]);
    expect(links.backlinks).toHaveLength(1);
  });

  // 202 sequential round trips against a schema the other pg suites are also
  // driving; the default 5s budget is a contention threshold, not a regression.
  it(
    'view="links" truncated when backlinks exceed 100',
    { timeout: 30_000 },
    async (ctx: TestContext) => {
      if (!guard(ctx)) return;
      const hub = await putDoc('/trunc/hub.md', 'hub');
      for (let i = 0; i < 101; i++) {
        const r = await putDoc(`/trunc/r${String(i)}.md`, `r${String(i)}`);
        await linkRepo.replaceLinksForDoc(r, SPACE, [
          { targetPath: '/trunc/hub.md', ordinal: 0, occurrenceCount: 1 },
        ]);
      }
      void hub;

      const { output } = await runOp('memory.store.get', { path: '/trunc/hub.md', view: 'links' });
      const links = output['links'] as {
        backlinks: unknown[];
        backlinkTotal: number;
        truncated?: boolean;
      };
      expect(links.backlinks).toHaveLength(100);
      expect(links.backlinkTotal).toBe(101);
      expect(links.truncated).toBe(true);
    },
  );

  it('content view includes up to 10 backlinks with the true total', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    const target = await putDoc('/content/target.md', 'target body');
    for (let i = 0; i < 12; i++) {
      const r = await putDoc(`/content/c${String(i)}.md`, `c${String(i)}`);
      await linkRepo.replaceLinksForDoc(r, SPACE, [
        { targetPath: '/content/target.md', ordinal: 0, occurrenceCount: 1 },
      ]);
    }
    void target;

    const { output } = await runOp('memory.store.get', {
      path: '/content/target.md',
      view: 'content',
    });
    expect(output['backlinks']).toHaveLength(10);
    expect(output['backlinkTotal']).toBe(12);
  });

  it('content view omits backlinks when nothing references the doc', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    await putDoc('/content/lonely.md', 'lonely');
    const { output } = await runOp('memory.store.get', {
      path: '/content/lonely.md',
      view: 'content',
    });
    expect(output['backlinks']).toBeUndefined();
    expect(output['backlinkTotal']).toBeUndefined();
  });

  it('view="links" on a missing doc → MEMORY_NOT_FOUND', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    const { result } = (await runOp('memory.store.get', {
      path: '/links/nope.md',
      view: 'links',
    })) as {
      result: StepResult & { error?: { message?: string } };
      output: Record<string, unknown>;
    };
    expect(result.status).toBe('FAILED');
    expect((result as { error?: { message?: string } }).error?.message).toMatch(
      /MEMORY_NOT_FOUND.*path=\/links\/nope\.md/,
    );
  });

  it('mode="links" with linkFilter.target lists all referrer edges across pages', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    await putDoc('/edges/hub.md', 'hub');
    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const r = await putDoc(`/edges/e${String(i)}.md`, `e${String(i)}`);
      await linkRepo.replaceLinksForDoc(r, SPACE, [
        { targetPath: '/edges/hub.md', ordinal: 0, occurrenceCount: 1 },
      ]);
    }

    let cursor: string | undefined;
    for (let guardIdx = 0; guardIdx < 10; guardIdx++) {
      const input: Record<string, unknown> = {
        mode: 'links',
        linkFilter: { target: '/edges/hub.md' },
        budget: { limit: 2 },
      };
      if (cursor !== undefined) input['cursor'] = cursor;
      const { output } = await runOp('memory.store.query', input);
      expect(output['items']).toEqual([]);
      for (const e of output['linkEdges'] as Array<{ fromPath: string }>) seen.add(e.fromPath);
      cursor = output['nextCursor'] as string | undefined;
      if (cursor === undefined) break;
    }
    expect(seen).toEqual(new Set(['/edges/e0.md', '/edges/e1.md', '/edges/e2.md']));
  });

  it('mode="links" canonicalizes an extensionless linkFilter.target to match stored .md edges', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    await putDoc('/n/foo.md', 'foo');
    const referrer = await putDoc('/n/refs-foo.md', 'refs foo');
    await linkRepo.replaceLinksForDoc(referrer, SPACE, [
      { targetPath: '/n/foo.md', ordinal: 0, occurrenceCount: 1 },
    ]);

    const { output } = await runOp('memory.store.query', {
      mode: 'links',
      linkFilter: { target: '/n/foo' },
    });
    expect(output['items']).toEqual([]);
    const froms = (output['linkEdges'] as Array<{ fromPath: string }>).map((e) => e.fromPath);
    expect(froms).toContain('/n/refs-foo.md');
  });

  it('mode="links" without a target aggregates the hub view ordered by referenceCount', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    const popular = await putDoc('/hub/popular.md', 'popular');
    const rare = await putDoc('/hub/rare.md', 'rare');
    void popular;
    void rare;
    const r1 = await putDoc('/hub/r1.md', 'r1');
    const r2 = await putDoc('/hub/r2.md', 'r2');
    await linkRepo.replaceLinksForDoc(r1, SPACE, [
      { targetPath: '/hub/popular.md', ordinal: 0, occurrenceCount: 1 },
      { targetPath: '/hub/rare.md', ordinal: 1, occurrenceCount: 1 },
    ]);
    await linkRepo.replaceLinksForDoc(r2, SPACE, [
      { targetPath: '/hub/popular.md', ordinal: 0, occurrenceCount: 1 },
    ]);

    const { output } = await runOp('memory.store.query', {
      mode: 'links',
      pathPrefix: '/hub/',
    });
    const targets = output['linkTargets'] as Array<{
      targetPath: string;
      referenceCount: number;
      resolved: boolean;
    }>;
    const popularEntry = targets.find((t) => t.targetPath === '/hub/popular.md');
    const rareEntry = targets.find((t) => t.targetPath === '/hub/rare.md');
    expect(popularEntry?.referenceCount).toBe(2);
    expect(rareEntry?.referenceCount).toBe(1);
    expect(targets.findIndex((t) => t.targetPath === '/hub/popular.md')).toBeLessThan(
      targets.findIndex((t) => t.targetPath === '/hub/rare.md'),
    );
  });

  it('mode="links" unresolvedOnly returns ghost targets only', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    await putDoc('/ghost/live.md', 'live');
    const r = await putDoc('/ghost/r.md', 'r');
    await linkRepo.replaceLinksForDoc(r, SPACE, [
      { targetPath: '/ghost/live.md', ordinal: 0, occurrenceCount: 1 },
      { targetPath: '/ghost/missing.md', ordinal: 1, occurrenceCount: 1 },
    ]);

    const { output } = await runOp('memory.store.query', {
      mode: 'links',
      pathPrefix: '/ghost/',
      linkFilter: { unresolvedOnly: true },
    });
    const targets = output['linkTargets'] as Array<{ targetPath: string; resolved: boolean }>;
    expect(targets.map((t) => t.targetPath)).toEqual(['/ghost/missing.md']);
    expect(targets[0]?.resolved).toBe(false);
  });

  it('a stat/query over an out-of-enum docType (workflow) parses and round-trips', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    await putDoc('/enum/wf.json', '{"w":1}', {
      docType: 'workflow',
      mimeType: 'application/json',
    });

    const stat = await runOp('memory.store.get', { path: '/enum/wf.json', view: 'stat' });
    expect((stat.output['stat'] as Record<string, unknown>)['docType']).toBe('workflow');

    const list = await runOp('memory.store.query', {
      mode: 'list',
      pathPrefix: '/enum/',
      recursive: true,
    });
    const items = list.output['items'] as Array<{ docType: string }>;
    expect(items.some((i) => i.docType === 'workflow')).toBe(true);
  });

  it('Plan 14b §1 — recursive list under maxTotalBytes: items fit, truncatedByBudget, paging returns all with no dup/skip', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    const body = 'z'.repeat(300);
    const expectedPaths = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const path = `/budget/list/d${String(i).padStart(2, '0')}.md`;
      await putDoc(path, body);
      expectedPaths.add(path);
    }

    const MAX = 1024;
    const seen = new Set<string>();
    let cursor: string | undefined;
    let sawTruncation = false;
    for (let guardIdx = 0; guardIdx < 50; guardIdx++) {
      const input: Record<string, unknown> = {
        mode: 'list',
        pathPrefix: '/budget/list/',
        recursive: true,
        budget: { maxTotalBytes: MAX },
      };
      if (cursor !== undefined) input['cursor'] = cursor;
      const { output } = await runOp('memory.store.query', input);
      const pageItems = output['items'] as Array<{ path: string }>;

      // A page that dropped rows for budget reports it and stays within budget.
      if (output['truncatedByBudget'] === true) {
        sawTruncation = true;
        expect(Buffer.byteLength(JSON.stringify(pageItems), 'utf8')).toBeLessThanOrEqual(MAX);
        expect(output['nextCursor']).toBeDefined();
      }

      for (const it of pageItems) {
        // No duplicate row across pages — the cursor resumes exactly after the last kept item.
        expect(seen.has(it.path)).toBe(false);
        seen.add(it.path);
      }
      cursor = output['nextCursor'] as string | undefined;
      if (cursor === undefined) break;
    }

    expect(sawTruncation).toBe(true);
    expect(seen).toEqual(expectedPaths);
  });

  it('Plan 14b §1 — non-recursive dir list of documents under maxTotalBytes: paging returns every doc exactly once', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    // A directory holding ONLY documents (no subdirs) — the default browse path
    // (recursive:false, dirRepo). Each doc alone is large relative to the budget
    // so the byte trim shortens every page and the cursor must resume past the
    // last kept document, not re-list from the start.
    const body = 'q'.repeat(400);
    const expectedNames = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const name = `f${String(i).padStart(2, '0')}.md`;
      await putDoc(`/budget/dirlist/${name}`, body);
      expectedNames.add(name);
    }

    const MAX = 700;
    const seen: string[] = [];
    let cursor: string | undefined;
    let sawTruncation = false;
    for (let guardIdx = 0; guardIdx < 50; guardIdx++) {
      const input: Record<string, unknown> = {
        mode: 'list',
        pathPrefix: '/budget/dirlist/',
        budget: { maxTotalBytes: MAX },
      };
      if (cursor !== undefined) input['cursor'] = cursor;
      const { output } = await runOp('memory.store.query', input);
      const pageItems = output['items'] as Array<{ name?: string; path: string }>;

      if (output['truncatedByBudget'] === true) {
        sawTruncation = true;
        expect(Buffer.byteLength(JSON.stringify(pageItems), 'utf8')).toBeLessThanOrEqual(MAX);
        expect(output['nextCursor']).toBeDefined();
      }

      for (const it of pageItems) {
        // Every document is a distinct row, retrieved exactly once.
        expect(seen).not.toContain(it.path);
        seen.push(it.path);
      }
      cursor = output['nextCursor'] as string | undefined;
      if (cursor === undefined) break;
    }

    expect(sawTruncation).toBe(true);
    expect(new Set(seen.map((p) => p.split('/').pop()))).toEqual(expectedNames);
  });

  it('Plan 14b §1 — mode="links" edges under maxTotalBytes: keyset cursor after byte-trim pages all edges with no dup/skip', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    await putDoc('/budget/links/hub.md', 'hub');
    const context = 'k'.repeat(200);
    const expectedReferrers = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const path = `/budget/links/r${String(i).padStart(2, '0')}.md`;
      const src = await putDoc(path, `r${String(i)}`);
      await linkRepo.replaceLinksForDoc(src, SPACE, [
        {
          targetPath: '/budget/links/hub.md',
          ordinal: 0,
          occurrenceCount: 1,
          firstContext: context,
        },
      ]);
      expectedReferrers.add(path);
    }

    const MAX = 1024;
    const seen = new Set<string>();
    let cursor: string | undefined;
    let sawTruncation = false;
    for (let guardIdx = 0; guardIdx < 50; guardIdx++) {
      const input: Record<string, unknown> = {
        mode: 'links',
        linkFilter: { target: '/budget/links/hub.md' },
        budget: { maxTotalBytes: MAX },
      };
      if (cursor !== undefined) input['cursor'] = cursor;
      const { output } = await runOp('memory.store.query', input);
      const edges = output['linkEdges'] as Array<{ fromPath: string }>;

      if (output['truncatedByBudget'] === true) {
        sawTruncation = true;
        expect(Buffer.byteLength(JSON.stringify(edges), 'utf8')).toBeLessThanOrEqual(MAX);
        expect(output['nextCursor']).toBeDefined();
      }

      for (const e of edges) {
        expect(seen.has(e.fromPath)).toBe(false);
        seen.add(e.fromPath);
      }
      cursor = output['nextCursor'] as string | undefined;
      if (cursor === undefined) break;
    }

    expect(sawTruncation).toBe(true);
    expect(seen).toEqual(expectedReferrers);
  });

  // ------------------------------------------------------------------------
  // Plan 249 P4 — link-aware search expansion (mode="search", expand.links=1).
  // No embedding index (indexing:'disabled') → search falls back to ILIKE grep;
  // expansion runs off those seeds, which is the deterministic path we assert.
  // ------------------------------------------------------------------------

  type ExpandItem = {
    path: string;
    hit?: unknown;
    via?: { kind: string; direction: 'out' | 'in'; from: string };
  };

  it('P4 — expand off: mode="search" without expand returns only text hits (no via)', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    const a = await putDoc('/p4off/a.md', 'zorptoken alpha');
    await putDoc('/p4off/b.md', 'beta neighbor');
    await linkRepo.replaceLinksForDoc(a, SPACE, [
      { targetPath: '/p4off/b.md', ordinal: 0, occurrenceCount: 1 },
    ]);

    const { output } = await runOp('memory.store.query', {
      mode: 'search',
      query: 'zorptoken',
      pathPrefix: '/p4off/',
    });
    const items = output['items'] as ExpandItem[];
    expect(items.map((i) => i.path)).toEqual(['/p4off/a.md']);
    expect(items.every((i) => i.via === undefined)).toBe(true);
  });

  it('P4 — expand out: linked neighbor B appears with via.out, no hit, ranked after seeds', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    const a = await putDoc('/p4out/a.md', 'wobbletoken alpha');
    await putDoc('/p4out/b.md', 'beta body');
    await linkRepo.replaceLinksForDoc(a, SPACE, [
      { targetPath: '/p4out/b.md', ordinal: 0, occurrenceCount: 1 },
    ]);

    const { output } = await runOp('memory.store.query', {
      mode: 'search',
      query: 'wobbletoken',
      pathPrefix: '/p4out/',
      expand: { links: 1 },
    });
    const items = output['items'] as ExpandItem[];
    expect(items.map((i) => i.path)).toEqual(['/p4out/a.md', '/p4out/b.md']);
    const seed = items[0];
    const expanded = items[1];
    expect(seed?.hit).toBeDefined();
    expect(seed?.via).toBeUndefined();
    expect(expanded?.hit).toBeUndefined();
    expect(expanded?.via).toEqual({ kind: 'link', direction: 'out', from: '/p4out/a.md' });
  });

  it('P4 — direction: incoming referrer appears only with both, and after outgoing', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    const a = await putDoc('/p4dir/a.md', 'flumtoken alpha');
    await putDoc('/p4dir/out.md', 'outgoing target');
    const c = await putDoc('/p4dir/c.md', 'referrer c');
    // A → out (outgoing); C → A (incoming referrer of the seed).
    await linkRepo.replaceLinksForDoc(a, SPACE, [
      { targetPath: '/p4dir/out.md', ordinal: 0, occurrenceCount: 1 },
    ]);
    await linkRepo.replaceLinksForDoc(c, SPACE, [
      { targetPath: '/p4dir/a.md', ordinal: 0, occurrenceCount: 1 },
    ]);

    const outOnly = await runOp('memory.store.query', {
      mode: 'search',
      query: 'flumtoken',
      pathPrefix: '/p4dir/',
      expand: { links: 1 },
    });
    const outItems = outOnly.output['items'] as ExpandItem[];
    expect(outItems.map((i) => i.path)).toEqual(['/p4dir/a.md', '/p4dir/out.md']);
    expect(outItems.some((i) => i.path === '/p4dir/c.md')).toBe(false);

    const both = await runOp('memory.store.query', {
      mode: 'search',
      query: 'flumtoken',
      pathPrefix: '/p4dir/',
      expand: { links: 1, direction: 'both' },
    });
    const bothItems = both.output['items'] as ExpandItem[];
    expect(bothItems.map((i) => i.path)).toEqual(['/p4dir/a.md', '/p4dir/out.md', '/p4dir/c.md']);
    // Incoming (c) ranks after outgoing (out).
    expect(bothItems[1]?.via?.direction).toBe('out');
    expect(bothItems[2]?.via).toEqual({ kind: 'link', direction: 'in', from: '/p4dir/a.md' });
  });

  it('P4 — cross-seed direction: a path that is in from one seed and out from another emits out', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    // sIn is created first → older updated_at → ranks first (rank 0) under the
    // grep fallback. X is an INCOMING referrer of sIn (X → sIn) and an OUTGOING
    // target of sB (sB → X). The lower-rank incoming pull must NOT claim X as
    // 'in' — 'out' is higher trust (spec step 3), so X emits via.direction='out'
    // from sB and ranks in the outgoing band.
    const sIn = await putDoc('/p4cross/sin.md', 'crosstoken one');
    const sB = await putDoc('/p4cross/sb.md', 'crosstoken two');
    const x = await putDoc('/p4cross/x.md', 'plain neighbor no token');
    await linkRepo.replaceLinksForDoc(x, SPACE, [
      { targetPath: '/p4cross/sin.md', ordinal: 0, occurrenceCount: 1 },
    ]);
    await linkRepo.replaceLinksForDoc(sB, SPACE, [
      { targetPath: '/p4cross/x.md', ordinal: 0, occurrenceCount: 1 },
    ]);

    const { output } = await runOp('memory.store.query', {
      mode: 'search',
      query: 'crosstoken',
      pathPrefix: '/p4cross/',
      expand: { links: 1, direction: 'both' },
    });
    const items = output['items'] as ExpandItem[];
    const xItems = items.filter((i) => i.path === '/p4cross/x.md');
    expect(xItems).toHaveLength(1);
    expect(xItems[0]?.via).toEqual({ kind: 'link', direction: 'out', from: '/p4cross/sb.md' });
    // X ranks before any incoming-derived item (there are none here, but assert
    // it lands in the outgoing band right after the seeds).
    const expanded = items.filter((i) => i.via !== undefined);
    expect(expanded[0]?.path).toBe('/p4cross/x.md');
    expect(expanded.every((i) => i.via?.direction === 'out')).toBe(true);
  });

  it('P4 — dedupe: a neighbor that is a seed is not duplicated; a shared neighbor appears once', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    // Two seeds both hit the query and both link to shared.md; a1 also links a2 (a seed).
    const a1 = await putDoc('/p4dedup/a1.md', 'grokentoken one');
    const a2 = await putDoc('/p4dedup/a2.md', 'grokentoken two');
    await putDoc('/p4dedup/shared.md', 'shared neighbor');
    await linkRepo.replaceLinksForDoc(a1, SPACE, [
      { targetPath: '/p4dedup/a2.md', ordinal: 0, occurrenceCount: 1 },
      { targetPath: '/p4dedup/shared.md', ordinal: 1, occurrenceCount: 1 },
    ]);
    await linkRepo.replaceLinksForDoc(a2, SPACE, [
      { targetPath: '/p4dedup/shared.md', ordinal: 0, occurrenceCount: 1 },
    ]);

    const { output } = await runOp('memory.store.query', {
      mode: 'search',
      query: 'grokentoken',
      pathPrefix: '/p4dedup/',
      expand: { links: 1 },
    });
    const items = output['items'] as ExpandItem[];
    const expandedPaths = items.filter((i) => i.via !== undefined).map((i) => i.path);
    // a2 is a seed → excluded; shared appears exactly once despite two referrers.
    expect(expandedPaths).toEqual(['/p4dedup/shared.md']);
    expect(items.filter((i) => i.path === '/p4dedup/shared.md')).toHaveLength(1);
  });

  it('P4 — round-robin fairness: 2 seeds × 5 neighbors, maxLinkedItems=4 → 2 from each', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    const s1 = await putDoc('/p4rr/s1.md', 'quibbletoken one');
    const s2 = await putDoc('/p4rr/s2.md', 'quibbletoken two');
    const s1Links: LinkRow[] = [];
    for (let i = 0; i < 5; i++) {
      await putDoc(`/p4rr/n1_${String(i)}.md`, `n1 ${String(i)}`);
      s1Links.push({ targetPath: `/p4rr/n1_${String(i)}.md`, ordinal: i, occurrenceCount: 1 });
    }
    const s2Links: LinkRow[] = [];
    for (let i = 0; i < 5; i++) {
      await putDoc(`/p4rr/n2_${String(i)}.md`, `n2 ${String(i)}`);
      s2Links.push({ targetPath: `/p4rr/n2_${String(i)}.md`, ordinal: i, occurrenceCount: 1 });
    }
    await linkRepo.replaceLinksForDoc(s1, SPACE, s1Links);
    await linkRepo.replaceLinksForDoc(s2, SPACE, s2Links);

    const { output } = await runOp('memory.store.query', {
      mode: 'search',
      query: 'quibbletoken',
      pathPrefix: '/p4rr/',
      expand: { links: 1 },
      budget: { maxLinkedItems: 4 },
    });
    const items = output['items'] as ExpandItem[];
    const fromCounts = new Map<string, number>();
    for (const i of items) {
      if (i.via) fromCounts.set(i.via.from, (fromCounts.get(i.via.from) ?? 0) + 1);
    }
    const expandedCount = items.filter((i) => i.via !== undefined).length;
    expect(expandedCount).toBe(4);
    expect(fromCounts.get('/p4rr/s1.md')).toBe(2);
    expect(fromCounts.get('/p4rr/s2.md')).toBe(2);
  });

  it('P4 — filter-parity: a neighbor failing input.filters is excluded from expansion', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    const a = await putDoc('/p4filt/a.md', 'snorktoken alpha', {
      docType: 'markdown',
      mimeType: 'text/markdown',
    });
    // Neighbor is a json doc — excluded by filters.docType=['markdown'].
    await putDoc('/p4filt/data.json', '{"k":1}', {
      docType: 'json',
      mimeType: 'application/json',
    });
    await putDoc('/p4filt/note.md', 'note body', {
      docType: 'markdown',
      mimeType: 'text/markdown',
    });
    await linkRepo.replaceLinksForDoc(a, SPACE, [
      { targetPath: '/p4filt/data.json', ordinal: 0, occurrenceCount: 1 },
      { targetPath: '/p4filt/note.md', ordinal: 1, occurrenceCount: 1 },
    ]);

    const { output } = await runOp('memory.store.query', {
      mode: 'search',
      query: 'snorktoken',
      pathPrefix: '/p4filt/',
      filters: { docType: ['markdown'] },
      expand: { links: 1 },
    });
    const items = output['items'] as ExpandItem[];
    const expandedPaths = items.filter((i) => i.via !== undefined).map((i) => i.path);
    expect(expandedPaths).toEqual(['/p4filt/note.md']);
    expect(items.some((i) => i.path === '/p4filt/data.json')).toBe(false);
  });

  it('P4 — budget: maxLinkedItems caps expanded count; maxTotalBytes trims the whole envelope', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    const big = 'y'.repeat(300);
    const a = await putDoc('/p4bud/a.md', `zizzletoken ${big}`);
    const neighborLinks: LinkRow[] = [];
    for (let i = 0; i < 6; i++) {
      await putDoc(`/p4bud/n${String(i)}.md`, `neighbor ${String(i)} ${big}`);
      neighborLinks.push({ targetPath: `/p4bud/n${String(i)}.md`, ordinal: i, occurrenceCount: 1 });
    }
    await linkRepo.replaceLinksForDoc(a, SPACE, neighborLinks);

    // maxLinkedItems caps expansion at 3 even though 6 neighbors exist.
    const capped = await runOp('memory.store.query', {
      mode: 'search',
      query: 'zizzletoken',
      pathPrefix: '/p4bud/',
      expand: { links: 1 },
      budget: { maxLinkedItems: 3, maxTotalBytes: 65536 },
    });
    const cappedItems = capped.output['items'] as ExpandItem[];
    expect(cappedItems.filter((i) => i.via !== undefined)).toHaveLength(3);
    expect(cappedItems.filter((i) => i.via === undefined)).toHaveLength(1);

    // maxTotalBytes trims the whole envelope (seeds + expanded) and flags it.
    const MAX = 900;
    const trimmed = await runOp('memory.store.query', {
      mode: 'search',
      query: 'zizzletoken',
      pathPrefix: '/p4bud/',
      expand: { links: 1 },
      budget: { maxLinkedItems: 6, maxTotalBytes: MAX },
    });
    const trimmedItems = trimmed.output['items'] as ExpandItem[];
    expect(trimmed.output['truncatedByBudget']).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(trimmedItems), 'utf8')).toBeLessThanOrEqual(MAX);
    // Seed survives (first item is never dropped), fewer than the full 6 neighbors.
    expect(trimmedItems[0]?.via).toBeUndefined();
    expect(trimmedItems.filter((i) => i.via !== undefined).length).toBeLessThan(6);
  });

  describe('pinned reads (target.version / target.expectedContentHash)', () => {
    const V1 = 'ada v1 — the sheet a film was cut against';
    const V2 = 'ada v2 — rewritten later, by someone else';
    const HASH_V1 = computeContentHash(V1);
    const HASH_V2 = computeContentHash(V2);

    async function seedOverwritten(path: string): Promise<string> {
      await putDoc(path, V1, { contentHash: HASH_V1 });
      return putDoc(path, V2, { contentHash: HASH_V2 });
    }

    it('returns the pinned bytes after the document has been overwritten', async (ctx: TestContext) => {
      if (!guard(ctx)) return;
      const path = '/pin/overwritten.md';
      await seedOverwritten(path);

      const live = await runOp('memory.store.get', { path, view: 'content' });
      expect(live.result.status).toBe('SUCCEEDED');
      expect(live.output['data']).toBe(V2);
      expect((live.output['stat'] as Record<string, unknown>)['version']).toBe(2);

      const pinned = await runOp('memory.store.get', { path, version: 1, view: 'content' });
      expect(pinned.result.status).toBe('SUCCEEDED');
      expect(pinned.output['data']).toBe(V1);

      const stat = pinned.output['stat'] as Record<string, unknown>;
      expect(stat['version']).toBe(1);
      expect(stat['contentHash']).toBe(HASH_V1);
      expect(stat['sizeBytes']).toBe(Buffer.byteLength(V1, 'utf8'));
    });

    it('accepts a matching expectedContentHash on a pin addressed by id', async (ctx: TestContext) => {
      if (!guard(ctx)) return;
      const id = await seedOverwritten('/pin/by-id.md');

      const { result, output } = await runOp('memory.store.get', {
        id,
        version: 1,
        expectedContentHash: HASH_V1,
        view: 'content',
      });
      expect(result.status).toBe('SUCCEEDED');
      expect(output['data']).toBe(V1);
    });

    it('fails naming both hashes when expectedContentHash does not match', async (ctx: TestContext) => {
      if (!guard(ctx)) return;
      const path = '/pin/mismatch.md';
      await seedOverwritten(path);

      const { result, output } = await runOp('memory.store.get', {
        path,
        expectedContentHash: HASH_V1,
        view: 'content',
      });
      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') return;
      expect(result.error.message).toContain('MEMORY_CONTENT_HASH_MISMATCH');
      expect(result.error.message).toContain(HASH_V1);
      expect(result.error.message).toContain(HASH_V2);
      expect(result.error.classification).toBe('validation');
      expect(output['data']).toBeUndefined();
    });

    it('compares the pin on a metadata read too, which never loads the body', async (ctx: TestContext) => {
      if (!guard(ctx)) return;
      const path = '/pin/metadata.md';
      await seedOverwritten(path);

      // No view: the read resolves no content at all, and the pin is still a
      // claim about the version it landed on rather than an unchecked hint.
      const { result } = await runOp('memory.store.get', { path, expectedContentHash: HASH_V1 });
      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') return;
      expect(result.error.message).toContain('MEMORY_CONTENT_HASH_MISMATCH');

      const matching = await runOp('memory.store.get', {
        path,
        version: 1,
        expectedContentHash: HASH_V1,
      });
      expect(matching.result.status).toBe('SUCCEEDED');
      expect(matching.output['data']).toBeUndefined();
    });

    it('fails when the row hash matches the pin but the stored body does not', async (ctx: TestContext) => {
      if (!guard(ctx)) return;
      const path = '/pin/row-lies.md';
      // The row claims V1's hash while the body is V2 — the row-level check
      // passes and only hashing what came back catches it.
      await putDoc(path, V2, { contentHash: HASH_V1 });

      const { result, output } = await runOp('memory.store.get', {
        path,
        expectedContentHash: HASH_V1,
        view: 'content',
      });
      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') return;
      expect(result.error.message).toContain('MEMORY_CONTENT_HASH_MISMATCH');
      expect(result.error.message).toContain(HASH_V2);
      expect(result.error.classification).toBe('validation');
      expect(output['data']).toBeUndefined();
    });

    it('fails on a version that does not exist instead of falling back to current', async (ctx: TestContext) => {
      if (!guard(ctx)) return;
      const path = '/pin/missing-version.md';
      await seedOverwritten(path);

      const { result, output } = await runOp('memory.store.get', {
        path,
        version: 99,
        view: 'content',
      });
      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') return;
      expect(result.error.code).toBe('NOT_FOUND');
      expect(result.error.message).toContain('MEMORY_VERSION_NOT_FOUND');
      expect(result.error.message).toContain('version 99');
      expect(result.error.message).toContain('current version is 2');
      expect(output['data']).toBeUndefined();
    });

    it('cuts a pinned preview from the pinned bytes, not the live preview', async (ctx: TestContext) => {
      if (!guard(ctx)) return;
      const path = '/pin/preview.md';
      await seedOverwritten(path);

      const { result, output } = await runOp('memory.store.get', {
        path,
        version: 1,
        view: 'preview',
      });
      expect(result.status).toBe('SUCCEEDED');
      expect(output['content']).toBe(V1);
    });

    it('refuses a pin on a /run/outputs virtual path', async (ctx: TestContext) => {
      if (!guard(ctx)) return;
      const { result } = await runOp('memory.store.get', {
        path: '/run/outputs/abc123_0/data',
        version: 1,
      });
      expect(result.status).toBe('FAILED');
      if (result.status !== 'FAILED') return;
      expect(result.error.message).toContain('MEMORY_PIN_UNSUPPORTED');
    });
  });
});

type LinkRow = { targetPath: string; ordinal: number; occurrenceCount: number };
